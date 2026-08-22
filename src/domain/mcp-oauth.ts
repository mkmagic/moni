// OAuth 2.1 issuance for the read-only MCP surface. OAuth changes the
// ceremony, not Moni's key-custody model: every presented secret is the only
// material capable of unwrapping the user's DK, and no server-held signing or
// encryption key exists.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, withUser } from "@/db/client";
import { mcpOauthAuthCodes, mcpOauthGrants, users } from "@/db/schema";
import { AgentAccessDisabledError } from "@/domain/agent-token";
import { wrapWithKek, unwrapWithKek } from "@/lib/auth/password";
import { deriveKekFromUnlockSecret, UNLOCK_SECRET_LENGTH } from "@/lib/auth/unlock-secret";
import { wipe, type AadContext } from "@/lib/crypto";

export const OAUTH_ACCESS_TOKEN_PREFIX = "moni_oauth_at_";
const REFRESH_TOKEN_PREFIX = "moni_oauth_rt_";
const AUTH_CODE_PREFIX = "moni_oauth_ac_";
const ACCESS_TOKEN_FORMAT = 1;
const UUID_BYTES = 16;
const EXPIRY_BYTES = 8;
const ACCESS_TOKEN_HEADER_BYTES = 1 + UUID_BYTES + EXPIRY_BYTES + UNLOCK_SECRET_LENGTH;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 60 * 1000;

export interface AuthCodeOptions {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
}

export interface MintedAuthCode {
  code: string;
  expiresAt: Date;
}

export interface VerifiedAccessToken {
  userId: string;
  grantId: string;
  /** Tier-0, caller-owned. The caller must wipe it in a finally block. */
  dataKey: Buffer;
}

export interface GrantSummary {
  id: string;
  clientId: string;
  scope: string;
  label: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type TokenResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      scope: string;
      tokenType: "Bearer";
    }
  | {
      ok: false;
      error: "invalid_grant" | "invalid_request" | "invalid_client" | "server_error";
      errorDescription?: string;
    };

function hashSecret(secret: Buffer): Buffer {
  return createHash("sha256").update(secret).digest();
}

function refreshAad(grantId: string): AadContext {
  return { rowId: grantId, column: "refresh_wrapped_dk", version: 1 };
}

function authCodeAad(codeId: string): AadContext {
  return { rowId: codeId, column: "wrapped_dk", version: 1 };
}

function accessAad(grantId: string, expiresAtSec: number): AadContext {
  // The expiry is authenticated as AAD. Editing the self-contained expiry
  // therefore makes unwrap fail even though Moni has no signing key.
  return { rowId: grantId, column: "mcp_oauth_access", version: expiresAtSec };
}

function uuidToBytes(uuid: string): Buffer {
  if (!UUID_RE.test(uuid)) throw new Error("invalid UUID");
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function bytesToUuid(bytes: Buffer): string | null {
  if (bytes.length !== UUID_BYTES) return null;
  const hex = bytes.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_RE.test(uuid) ? uuid : null;
}

function decodeSecretToken(token: string, prefix: string): Buffer | null {
  if (!token.startsWith(prefix)) return null;
  const encoded = token.slice(prefix.length);
  if (!BASE64URL_RE.test(encoded)) return null;
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== UNLOCK_SECRET_LENGTH || secret.toString("base64url") !== encoded) {
    wipe(secret);
    return null;
  }
  return secret;
}

function wrapAndAssert(secret: Buffer, aad: AadContext, dataKey: Buffer): Buffer {
  const kek = deriveKekFromUnlockSecret(secret);
  let wrapped: Buffer;
  try {
    wrapped = wrapWithKek(kek, aad, dataKey);
  } finally {
    wipe(kek);
  }

  const checkKek = deriveKekFromUnlockSecret(secret);
  try {
    const recovered = unwrapWithKek(checkKek, aad, wrapped);
    try {
      if (recovered.length !== dataKey.length || !timingSafeEqual(recovered, dataKey)) {
        throw new Error("mcp-oauth: DK wrap did not round-trip");
      }
    } finally {
      wipe(recovered);
    }
  } finally {
    wipe(checkKek);
  }
  return wrapped;
}

function unwrap(secret: Buffer, aad: AadContext, wrapped: Buffer): Buffer | null {
  const kek = deriveKekFromUnlockSecret(secret);
  try {
    return unwrapWithKek(kek, aad, Buffer.from(wrapped));
  } catch {
    return null;
  } finally {
    wipe(kek);
  }
}

async function ownerHasAgentAccess(ownerId: string): Promise<boolean> {
  const [owner] = await db
    .select({ enabled: users.agentAccessEnabled })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return owner?.enabled === true;
}

/** Pure-crypto, self-contained access token; no access-token row is written. */
export function mintAccessToken(
  grantId: string,
  dataKey: Buffer,
  ttlMs = ACCESS_TOKEN_TTL_MS,
): { token: string; expiresAt: Date } {
  const secret = randomBytes(UNLOCK_SECRET_LENGTH);
  try {
    const expiresAtSec = Math.floor((Date.now() + ttlMs) / 1000);
    if (!Number.isSafeInteger(expiresAtSec) || expiresAtSec < 0) {
      throw new Error("mcp-oauth: access-token expiry is out of range");
    }
    const expiresAt = new Date(expiresAtSec * 1000);
    const wrappedDk = wrapAndAssert(secret, accessAad(grantId, expiresAtSec), dataKey);
    const packed = Buffer.allocUnsafe(ACCESS_TOKEN_HEADER_BYTES);
    packed.writeUInt8(ACCESS_TOKEN_FORMAT, 0);
    uuidToBytes(grantId).copy(packed, 1);
    packed.writeBigUInt64BE(BigInt(expiresAtSec), 1 + UUID_BYTES);
    secret.copy(packed, 1 + UUID_BYTES + EXPIRY_BYTES);
    return {
      token: OAUTH_ACCESS_TOKEN_PREFIX + Buffer.concat([packed, wrappedDk]).toString("base64url"),
      expiresAt,
    };
  } finally {
    wipe(secret);
  }
}

export async function validateAccessToken(token: string): Promise<VerifiedAccessToken | null> {
  if (!token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return null;
  const encoded = token.slice(OAUTH_ACCESS_TOKEN_PREFIX.length);
  if (!BASE64URL_RE.test(encoded)) return null;

  let packed: Buffer;
  try {
    packed = Buffer.from(encoded, "base64url");
  } catch {
    return null;
  }
  if (packed.toString("base64url") !== encoded || packed.length <= ACCESS_TOKEN_HEADER_BYTES) {
    wipe(packed);
    return null;
  }

  const secret = Buffer.from(
    packed.subarray(1 + UUID_BYTES + EXPIRY_BYTES, ACCESS_TOKEN_HEADER_BYTES),
  );
  try {
    if (packed.readUInt8(0) !== ACCESS_TOKEN_FORMAT) return null;
    const grantId = bytesToUuid(Buffer.from(packed.subarray(1, 1 + UUID_BYTES)));
    if (!grantId) return null;
    const expiresBig = packed.readBigUInt64BE(1 + UUID_BYTES);
    if (expiresBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const expiresAtSec = Number(expiresBig);
    if (expiresAtSec <= Math.floor(Date.now() / 1000)) return null;

    const [grant] = await db
      .select({
        id: mcpOauthGrants.id,
        ownerId: mcpOauthGrants.ownerId,
        expiresAt: mcpOauthGrants.expiresAt,
        revokedAt: mcpOauthGrants.revokedAt,
      })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.id, grantId))
      .limit(1);
    if (!grant || grant.revokedAt !== null) return null;
    if (grant.expiresAt !== null && grant.expiresAt.getTime() <= Date.now()) return null;
    if (!(await ownerHasAgentAccess(grant.ownerId))) return null;

    const dataKey = unwrap(
      secret,
      accessAad(grantId, expiresAtSec),
      Buffer.from(packed.subarray(ACCESS_TOKEN_HEADER_BYTES)),
    );
    if (!dataKey) return null;

    try {
      await withUser(grant.ownerId, async (tx) => {
        await tx
          .update(mcpOauthGrants)
          .set({ lastUsedAt: new Date() })
          .where(eq(mcpOauthGrants.id, grant.id));
      });
    } catch {
      // Best-effort telemetry must not invalidate an already-verified token.
    }
    return { userId: grant.ownerId, grantId, dataKey };
  } catch {
    return null;
  } finally {
    wipe(secret);
    wipe(packed);
  }
}

export async function createAuthCode(
  userId: string,
  dataKey: Buffer,
  options: AuthCodeOptions,
): Promise<MintedAuthCode> {
  const codeId = randomUUID();
  const secret = randomBytes(UNLOCK_SECRET_LENGTH);
  try {
    const wrappedDk = wrapAndAssert(secret, authCodeAad(codeId), dataKey);
    const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS);
    await withUser(userId, async (tx) => {
      const [owner] = await tx
        .select({ enabled: users.agentAccessEnabled })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!owner?.enabled) throw new AgentAccessDisabledError();
      await tx.insert(mcpOauthAuthCodes).values({
        id: codeId,
        ownerId: userId,
        clientId: options.clientId,
        codeHash: hashSecret(secret),
        wrappedDk,
        codeChallenge: options.codeChallenge,
        redirectUri: options.redirectUri,
        scope: options.scope,
        expiresAt,
      });
    });
    return { code: AUTH_CODE_PREFIX + secret.toString("base64url"), expiresAt };
  } finally {
    wipe(secret);
  }
}

export async function exchangeAuthCode(
  code: string,
  codeVerifier: string,
  client: { clientId: string; redirectUri: string },
): Promise<TokenResult> {
  const secret = decodeSecretToken(code, AUTH_CODE_PREFIX);
  if (!secret) return { ok: false, error: "invalid_grant" };
  let dataKey: Buffer | null = null;
  let refreshSecret: Buffer | null = null;
  try {
    const [row] = await db
      .select()
      .from(mcpOauthAuthCodes)
      .where(eq(mcpOauthAuthCodes.codeHash, hashSecret(secret)))
      .limit(1);
    if (!row || row.consumedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      return { ok: false, error: "invalid_grant" };
    }
    if (row.clientId !== client.clientId) return { ok: false, error: "invalid_client" };
    if (row.redirectUri !== client.redirectUri) return { ok: false, error: "invalid_grant" };
    if (!PKCE_VERIFIER_RE.test(codeVerifier)) return { ok: false, error: "invalid_grant" };
    const actualChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
    const expected = Buffer.from(row.codeChallenge, "ascii");
    const actual = Buffer.from(actualChallenge, "ascii");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, error: "invalid_grant" };
    }
    if (!(await ownerHasAgentAccess(row.ownerId))) return { ok: false, error: "invalid_grant" };

    dataKey = unwrap(secret, authCodeAad(row.id), Buffer.from(row.wrappedDk));
    if (!dataKey) return { ok: false, error: "invalid_grant" };

    const grantId = randomUUID();
    refreshSecret = randomBytes(UNLOCK_SECRET_LENGTH);
    const refreshWrappedDk = wrapAndAssert(refreshSecret, refreshAad(grantId), dataKey);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    const access = mintAccessToken(grantId, dataKey);

    const created = await withUser(row.ownerId, async (tx) => {
      const consumed = await tx
        .update(mcpOauthAuthCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(mcpOauthAuthCodes.id, row.id), isNull(mcpOauthAuthCodes.consumedAt)))
        .returning({ id: mcpOauthAuthCodes.id });
      if (consumed.length === 0) return false;
      await tx.insert(mcpOauthGrants).values({
        id: grantId,
        ownerId: row.ownerId,
        clientId: row.clientId,
        refreshTokenHash: hashSecret(refreshSecret!),
        refreshWrappedDk,
        scope: row.scope,
        expiresAt,
      });
      return true;
    });
    if (!created) return { ok: false, error: "invalid_grant" };

    return {
      ok: true,
      accessToken: access.token,
      refreshToken: REFRESH_TOKEN_PREFIX + refreshSecret.toString("base64url"),
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: row.scope,
      tokenType: "Bearer",
    };
  } catch {
    return { ok: false, error: "server_error" };
  } finally {
    wipe(secret);
    if (dataKey) wipe(dataKey);
    if (refreshSecret) wipe(refreshSecret);
  }
}

export async function refreshGrant(refreshToken: string): Promise<TokenResult> {
  const oldSecret = decodeSecretToken(refreshToken, REFRESH_TOKEN_PREFIX);
  if (!oldSecret) return { ok: false, error: "invalid_grant" };
  let dataKey: Buffer | null = null;
  let newSecret: Buffer | null = null;
  try {
    const oldHash = hashSecret(oldSecret);
    const [row] = await db
      .select()
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.refreshTokenHash, oldHash))
      .limit(1);
    if (!row || row.revokedAt !== null) return { ok: false, error: "invalid_grant" };
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      return { ok: false, error: "invalid_grant" };
    }
    if (!(await ownerHasAgentAccess(row.ownerId))) return { ok: false, error: "invalid_grant" };

    dataKey = unwrap(oldSecret, refreshAad(row.id), Buffer.from(row.refreshWrappedDk));
    if (!dataKey) return { ok: false, error: "invalid_grant" };
    newSecret = randomBytes(UNLOCK_SECRET_LENGTH);
    const newHash = hashSecret(newSecret);
    const newWrappedDk = wrapAndAssert(newSecret, refreshAad(row.id), dataKey);
    const access = mintAccessToken(row.id, dataKey);

    const rotated = await withUser(row.ownerId, async (tx) =>
      tx
        .update(mcpOauthGrants)
        .set({
          refreshTokenHash: newHash,
          refreshWrappedDk: newWrappedDk,
          lastUsedAt: new Date(),
        })
        .where(
          and(
            eq(mcpOauthGrants.id, row.id),
            eq(mcpOauthGrants.refreshTokenHash, oldHash),
            isNull(mcpOauthGrants.revokedAt),
          ),
        )
        .returning({ id: mcpOauthGrants.id }),
    );
    if (rotated.length === 0) return { ok: false, error: "invalid_grant" };
    return {
      ok: true,
      accessToken: access.token,
      refreshToken: REFRESH_TOKEN_PREFIX + newSecret.toString("base64url"),
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: row.scope,
      tokenType: "Bearer",
    };
  } catch {
    return { ok: false, error: "server_error" };
  } finally {
    wipe(oldSecret);
    if (dataKey) wipe(dataKey);
    if (newSecret) wipe(newSecret);
  }
}

export async function revokeGrant(userId: string, grantId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const revoked = await tx
      .update(mcpOauthGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpOauthGrants.id, grantId), isNull(mcpOauthGrants.revokedAt)))
      .returning({ id: mcpOauthGrants.id });
    return revoked.length > 0;
  });
}

export async function revokeByRefreshToken(refreshToken: string): Promise<void> {
  const secret = decodeSecretToken(refreshToken, REFRESH_TOKEN_PREFIX);
  if (!secret) return;
  try {
    const [row] = await db
      .select({ id: mcpOauthGrants.id, ownerId: mcpOauthGrants.ownerId })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.refreshTokenHash, hashSecret(secret)))
      .limit(1);
    if (row) await revokeGrant(row.ownerId, row.id);
  } catch {
    // RFC 7009 revocation is deliberately idempotent and non-disclosing.
  } finally {
    wipe(secret);
  }
}

export async function listGrants(userId: string): Promise<GrantSummary[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        id: mcpOauthGrants.id,
        clientId: mcpOauthGrants.clientId,
        scope: mcpOauthGrants.scope,
        label: mcpOauthGrants.label,
        createdAt: mcpOauthGrants.createdAt,
        expiresAt: mcpOauthGrants.expiresAt,
        lastUsedAt: mcpOauthGrants.lastUsedAt,
        revokedAt: mcpOauthGrants.revokedAt,
      })
      .from(mcpOauthGrants);
    return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  });
}
