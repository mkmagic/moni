// Per-user agent tokens — the bearer secret a remote MCP client carries to
// read that user's own financial data headless (issue #113, docs/design/
// mcp-and-api.md §4).
//
// This module mirrors src/domain/credential-unlock.ts: a plain-secret domain
// seam (the token secret is 32 opaque bytes; nothing here knows about MCP,
// bearer headers, or transports — those live at the route edge), so tests
// drive the exact production path with random bytes and no test-only branch
// can leak into a deployment.
//
// The security boundary this module is built to hold (docs/design/
// mcp-and-api.md §3): an agent token reaches **DK only**. It re-wraps the
// user's data key under a KEK derived from the token secret — the same
// 32-byte-secret→KEK seam webauthn-prf uses for CK — and can never reach the
// credential key (CK) that decrypts bank logins. That boundary is structural:
// there is no CK column on agent_tokens and no code path here that touches
// the credential window.
//
// DK lifetime is Tier-0 (threat-model §5.5): every DK this module produces is
// a `Buffer` the caller owns and must `fill(0)`-wipe after the request. Mint
// works on a copy so it never wipes the live session's DK; verify hands the
// caller a fresh DK to wipe in its `finally`.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, withUser } from "@/db/client";
import { agentTokens } from "@/db/schema";
import { wrapWithKek, unwrapWithKek } from "@/lib/auth/password";
import { deriveKekFromUnlockSecret, UNLOCK_SECRET_LENGTH } from "@/lib/auth/unlock-secret";
import { wipe, type AadContext } from "@/lib/crypto";

/** Length of the random token secret, in bytes — the KEK-seam input width. */
const TOKEN_SECRET_LENGTH = UNLOCK_SECRET_LENGTH;

/**
 * Prefix on the one-time token string. Purely cosmetic/greppable (leak
 * scanners key on it); the entropy is the 32 bytes after it. Stripped before
 * decoding on the verify path.
 */
const TOKEN_PREFIX = "moni_agent_";

/** Default TTL backstop — revocation is the primary control (mcp-and-api.md §4). */
export const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** A minted token as shown to the user — the secret appears here exactly once. */
export interface MintedToken {
  /** The agent_tokens row id (safe to display/store; not a secret). */
  tokenId: string;
  /** The one-time bearer secret. Show once, never persisted server-side. */
  secret: string;
  expiresAt: Date;
}

/** Non-secret metadata for the token-management list (never hash or wrap). */
export interface AgentTokenSummary {
  id: string;
  label: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** The result of verifying a presented token: one user + a fresh DK to wipe. */
export interface VerifiedToken {
  userId: string;
  /** Tier-0, caller-owned — `fill(0)` after the request. */
  dataKey: Buffer;
}

function wrappedDkAad(tokenId: string): AadContext {
  // Fixed version 1: the wrap is written once at mint and never re-wrapped
  // (rotation mints a new row), so there is no stale version to roll back to.
  return { rowId: tokenId, column: "wrapped_dk", version: 1 };
}

/** SHA-256 of the raw secret bytes — what we store and look up by. */
function hashSecret(secret: Buffer): Buffer {
  return createHash("sha256").update(secret).digest();
}

/**
 * Mints a token for `userId`, re-wrapping `dataKey` (the live session's DK)
 * under a fresh token-derived KEK and returning the one-time secret.
 *
 * `dataKey` is the caller's live session DK — this function reads it but never
 * wipes it (wrap copies internally), so the session stays intact. Minting can
 * only happen behind a live password session, because that is the only place
 * DK is in RAM; this function is the single step that needs the human.
 */
export async function mintToken(
  userId: string,
  dataKey: Buffer,
  opts: { label?: string; ttlMs?: number } = {},
): Promise<MintedToken> {
  const tokenId = randomUUID();
  const secret = randomBytes(TOKEN_SECRET_LENGTH);
  const aad = wrappedDkAad(tokenId);

  const kek = deriveKekFromUnlockSecret(secret);
  let wrappedDk: Buffer;
  try {
    wrappedDk = wrapWithKek(kek, aad, dataKey);
  } finally {
    wipe(kek);
  }

  // Verify the wrap round-trips before it hits the table — an unopenable wrap
  // would silently produce a token that can never unlock DK.
  const checkKek = deriveKekFromUnlockSecret(secret);
  try {
    const recovered = unwrapWithKek(checkKek, aad, wrappedDk);
    try {
      if (!timingSafeEqual(recovered, dataKey)) {
        throw new Error("agent-token: wrap did not round-trip; refusing to mint");
      }
    } finally {
      wipe(recovered);
    }
  } finally {
    wipe(checkKek);
  }

  const tokenHash = hashSecret(secret);
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TOKEN_TTL_MS));

  await withUser(userId, async (tx) => {
    await tx.insert(agentTokens).values({
      id: tokenId,
      ownerId: userId,
      tokenHash,
      wrappedDk,
      label: opts.label ?? null,
      expiresAt,
    });
  });

  const secretString = TOKEN_PREFIX + secret.toString("base64url");
  wipe(secret);
  return { tokenId, secret: secretString, expiresAt };
}

/**
 * Verifies a presented token string and, on success, unwraps that user's DK
 * for the current request. Returns null for every failure — malformed,
 * unknown, expired, revoked, or a tampered wrap — indistinguishably, matching
 * the auth layer's fail-closed posture.
 *
 * The returned `dataKey` is Tier-0 and owned by the caller, which must
 * `fill(0)` it in a `finally` once the request's reads are done.
 */
export async function verifyAndUnwrapDk(tokenString: string): Promise<VerifiedToken | null> {
  if (!tokenString.startsWith(TOKEN_PREFIX)) return null;
  let secret: Buffer;
  try {
    secret = Buffer.from(tokenString.slice(TOKEN_PREFIX.length), "base64url");
  } catch {
    return null;
  }
  if (secret.length !== TOKEN_SECRET_LENGTH) {
    wipe(secret);
    return null;
  }

  try {
    const tokenHash = hashSecret(secret);

    // Pre-auth lookup: find the row by hash before app.user_id is known, via
    // the agent_tokens_app_select policy (drizzle/0029) — the same shape as
    // authenticate()'s email lookup. The row is useless without `secret`.
    const rows = await db
      .select({
        id: agentTokens.id,
        ownerId: agentTokens.ownerId,
        wrappedDk: agentTokens.wrappedDk,
        expiresAt: agentTokens.expiresAt,
        revokedAt: agentTokens.revokedAt,
      })
      .from(agentTokens)
      .where(eq(agentTokens.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    const kek = deriveKekFromUnlockSecret(secret);
    let dataKey: Buffer;
    try {
      dataKey = unwrapWithKek(kek, wrappedDkAad(row.id), Buffer.from(row.wrappedDk));
    } catch {
      // AEAD auth failure = wrong secret (or tampered wrap). Same answer either way.
      return null;
    } finally {
      wipe(kek);
    }

    // Best-effort last-used bump; scoped to the resolved owner under RLS. A
    // failure here must neither fail the request nor strand the unwrapped DK
    // unwiped, so it is swallowed — the token is already verified.
    try {
      await withUser(row.ownerId, async (tx) => {
        await tx
          .update(agentTokens)
          .set({ lastUsedAt: new Date() })
          .where(eq(agentTokens.id, row.id));
      });
    } catch {
      // Non-fatal telemetry; ignore.
    }

    return { userId: row.ownerId, dataKey };
  } finally {
    wipe(secret);
  }
}

/**
 * Revokes one of the user's own tokens — the primary kill switch. Returns true
 * if a live (not already-revoked) token was revoked, false if it was unknown
 * or already dead. Idempotent.
 */
export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const revoked = await tx
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentTokens.id, tokenId), isNull(agentTokens.revokedAt)))
      .returning({ id: agentTokens.id });
    return revoked.length > 0;
  });
}

/** Every token the user owns, newest first — non-secret metadata only. */
export async function listTokens(userId: string): Promise<AgentTokenSummary[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        id: agentTokens.id,
        label: agentTokens.label,
        createdAt: agentTokens.createdAt,
        expiresAt: agentTokens.expiresAt,
        lastUsedAt: agentTokens.lastUsedAt,
        revokedAt: agentTokens.revokedAt,
      })
      .from(agentTokens);
    return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  });
}
