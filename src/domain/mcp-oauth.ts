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
  /** RFC 8707 audience the client requested; NULL when it sent none. */
  resource?: string;
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
      /** Omitted unless the grant carries `offline_access`. */
      refreshToken?: string;
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

function accessAad(grantId: string): AadContext {
  return { rowId: grantId, column: "access_wrapped_dk", version: 1 };
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

interface AccessTokenMaterial {
  /** The opaque bearer token handed to the client — prefix + secret only. */
  token: string;
  /** SHA-256 of the secret; the pre-auth lookup key stored on the grant. */
  tokenHash: Buffer;
  /** DK wrapped under the secret's KEK; stored on the grant, never in `token`. */
  wrappedDk: Buffer;
  expiresAt: Date;
}

/**
 * Builds an opaque access token and the server-side envelope that opens it. The
 * token string carries ONLY a random secret (like `agent_tokens` and refresh
 * tokens); the caller persists `tokenHash` + `wrappedDk` + `expiresAt` on the
 * grant row. A holder therefore cannot recover DK from the token alone — the
 * wrap lives server-side, so `revoked_at` / `access_expires_at` are what let a
 * request open DK, and revocation/expiry actually bind (threat-model §5.6).
 */
function buildAccessToken(
  grantId: string,
  dataKey: Buffer,
  ttlMs = ACCESS_TOKEN_TTL_MS,
): AccessTokenMaterial {
  const secret = randomBytes(UNLOCK_SECRET_LENGTH);
  try {
    const wrappedDk = wrapAndAssert(secret, accessAad(grantId), dataKey);
    return {
      token: OAUTH_ACCESS_TOKEN_PREFIX + secret.toString("base64url"),
      tokenHash: hashSecret(secret),
      wrappedDk,
      expiresAt: new Date(Date.now() + ttlMs),
    };
  } finally {
    wipe(secret);
  }
}

/**
 * Resolves a presented access token to a one-request DK window. Looks the grant
 * up by the token secret's hash (pre-auth, unscoped), then enforces revocation,
 * grant + access expiry, RFC 8707 audience binding, and the owner's opt-in
 * before unwrapping DK from the server-held `access_wrapped_dk`.
 *
 * `expectedResource` is this server's own resource id (`${issuer}/api/mcp`); a
 * token whose grant is bound to a different resource is refused. A grant with a
 * NULL resource predates audience binding and is accepted (lenient migration).
 */
export async function validateAccessToken(
  token: string,
  expectedResource?: string,
): Promise<VerifiedAccessToken | null> {
  const secret = decodeSecretToken(token, OAUTH_ACCESS_TOKEN_PREFIX);
  if (!secret) return null;
  try {
    const [grant] = await db
      .select({
        id: mcpOauthGrants.id,
        ownerId: mcpOauthGrants.ownerId,
        expiresAt: mcpOauthGrants.expiresAt,
        revokedAt: mcpOauthGrants.revokedAt,
        accessExpiresAt: mcpOauthGrants.accessExpiresAt,
        accessWrappedDk: mcpOauthGrants.accessWrappedDk,
        resource: mcpOauthGrants.resource,
      })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.accessTokenHash, hashSecret(secret)))
      .limit(1);
    if (!grant || grant.revokedAt !== null || !grant.accessWrappedDk || !grant.accessExpiresAt) {
      return null;
    }
    if (grant.accessExpiresAt.getTime() <= Date.now()) return null;
    if (grant.expiresAt !== null && grant.expiresAt.getTime() <= Date.now()) return null;
    if (
      grant.resource !== null &&
      expectedResource !== undefined &&
      grant.resource !== expectedResource
    ) {
      return null;
    }
    if (!(await ownerHasAgentAccess(grant.ownerId))) return null;

    const dataKey = unwrap(secret, accessAad(grant.id), Buffer.from(grant.accessWrappedDk));
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
    return { userId: grant.ownerId, grantId: grant.id, dataKey };
  } catch {
    return null;
  } finally {
    wipe(secret);
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
        resource: options.resource ?? null,
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
    const access = buildAccessToken(grantId, dataKey);
    // A refresh token is only issued when the client asked for `offline_access`
    // (RFC 6749 §1.5 / OAuth 2.1). Without it the grant lives only as long as
    // its access token and its refresh envelope stays NULL.
    const withRefresh = row.scope.split(" ").includes("offline_access");
    let refreshWrappedDk: Buffer | null = null;
    if (withRefresh) {
      refreshSecret = randomBytes(UNLOCK_SECRET_LENGTH);
      refreshWrappedDk = wrapAndAssert(refreshSecret, refreshAad(grantId), dataKey);
    }
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

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
        refreshTokenHash: withRefresh ? hashSecret(refreshSecret!) : null,
        refreshWrappedDk,
        accessTokenHash: access.tokenHash,
        accessWrappedDk: access.wrappedDk,
        accessExpiresAt: access.expiresAt,
        resource: row.resource,
        scope: row.scope,
        expiresAt,
      });
      return true;
    });
    if (!created) return { ok: false, error: "invalid_grant" };

    return {
      ok: true,
      accessToken: access.token,
      refreshToken: withRefresh
        ? REFRESH_TOKEN_PREFIX + refreshSecret!.toString("base64url")
        : undefined,
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

export async function refreshGrant(
  refreshToken: string,
  client?: { clientId?: string },
): Promise<TokenResult> {
  const oldSecret = decodeSecretToken(refreshToken, REFRESH_TOKEN_PREFIX);
  if (!oldSecret) return { ok: false, error: "invalid_grant" };
  let dataKey: Buffer | null = null;
  let newSecret: Buffer | null = null;
  try {
    const oldHash = hashSecret(oldSecret);

    // Reuse detection (RFC 9700 §4.14): a token matching a grant's *previous*,
    // rotated-away refresh hash is a replay — the legitimate holder and an
    // attacker cannot both hold the current token, so someone is presenting a
    // superseded one. Revoke the whole grant family and refuse, invalidating
    // the current (possibly attacker-held) token too.
    const [reused] = await db
      .select({ id: mcpOauthGrants.id, ownerId: mcpOauthGrants.ownerId })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.previousRefreshTokenHash, oldHash))
      .limit(1);
    if (reused) {
      await revokeGrant(reused.ownerId, reused.id);
      return { ok: false, error: "invalid_grant" };
    }

    const [row] = await db
      .select()
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.refreshTokenHash, oldHash))
      .limit(1);
    if (!row || row.revokedAt !== null || !row.refreshWrappedDk) {
      return { ok: false, error: "invalid_grant" };
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      return { ok: false, error: "invalid_grant" };
    }
    // Public clients: if the caller sends client_id it must match the grant's
    // (RFC 6749 §6). Absent is tolerated — the refresh secret is the authority.
    if (client?.clientId !== undefined && client.clientId !== row.clientId) {
      return { ok: false, error: "invalid_client" };
    }
    if (!(await ownerHasAgentAccess(row.ownerId))) return { ok: false, error: "invalid_grant" };

    dataKey = unwrap(oldSecret, refreshAad(row.id), Buffer.from(row.refreshWrappedDk));
    if (!dataKey) return { ok: false, error: "invalid_grant" };
    newSecret = randomBytes(UNLOCK_SECRET_LENGTH);
    const newHash = hashSecret(newSecret);
    const newWrappedDk = wrapAndAssert(newSecret, refreshAad(row.id), dataKey);
    const access = buildAccessToken(row.id, dataKey);

    const rotated = await withUser(row.ownerId, async (tx) =>
      tx
        .update(mcpOauthGrants)
        .set({
          refreshTokenHash: newHash,
          refreshWrappedDk: newWrappedDk,
          previousRefreshTokenHash: oldHash,
          accessTokenHash: access.tokenHash,
          accessWrappedDk: access.wrappedDk,
          accessExpiresAt: access.expiresAt,
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
