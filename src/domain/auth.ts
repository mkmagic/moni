// Authentication — the login half of the single access path.
//
// Establishes the tenancy + decryption context every other domain read
// depends on. Login is the one operation that must read the identity table
// *before* `app.user_id` exists, so it does a narrow email lookup through the
// `users_app_select` policy (drizzle/0002) rather than `withUser`. Everything
// after login is scoped by the session it creates.
//
// Two RAM windows (docs plan §B): login unwraps ONLY the data key (DK) into
// the 8h session below. The credential key (CK) — which decrypts Tier-0 bank
// credentials — is unwrapped separately by `unlockCredentialKey()` and lives
// in the shorter-TTL `cred-window` store. Keeping the two decoupled is the
// point: a stolen session cookie alone must never yield a bank credential.
//
// Security properties (docs/security/security-design-principles.md §1-8):
//   * No Tier-0 bank credential is involved in login itself — this gate only
//     unlocks Tier-1 field decryption for the session.
//   * The unwrapped data key lives only in the RAM session store; it is never
//     sent to the browser (server-only module).
//   * A wrong password fails the AEAD unwrap → indistinguishable "invalid
//     credentials"; no password hash is stored to leak.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, withUser } from "@/db/client";
import { users, userUnlockMethods } from "@/db/schema";
import { deriveKekFromPassword, unwrapWithKek, type Argon2Params } from "@/lib/auth/password";
import { wipe, type AadContext } from "@/lib/crypto";
import { createSession, destroySession, getSession, type Session } from "@/lib/auth/session-store";
import { destroyCredentialWindow } from "@/lib/auth/cred-window";

export const SESSION_COOKIE = "moni_session";

/**
 * How stale the previous login must be before an `autoSyncOnLogin` user is
 * offered a sync. Matches the 8h session TTL, so in practice the offer
 * appears when you come back to a session that had fully expired.
 */
const SYNC_PROMPT_GAP_MS = 8 * 60 * 60 * 1000;

/** Shape of `user_unlock_methods.unlock_ref` for the password-argon2id method. */
interface PasswordUnlockRef {
  /** base64-encoded Argon2id salt. */
  saltB64: string;
  params: Argon2Params;
}

/**
 * Verifies a password and, on success, unwraps the user's data key into a
 * new RAM session. Returns the opaque session id, or null for any failure
 * (unknown email, no password method on file, or wrong password — all
 * indistinguishable). `password` is a Tier-0 `Buffer` owned by the caller
 * (the route wipes it). Unwraps the data key ONLY — the credential key stays
 * locked until `unlockCredentialKey()` is called.
 */
export async function authenticate(email: string, password: Buffer): Promise<string | null> {
  const rows = await db
    .select({
      id: users.id,
      baseCurrency: users.baseCurrency,
      autoSyncOnLogin: users.autoSyncOnLogin,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const candidate = rows[0];
  if (!candidate) return null;

  return withUser(candidate.id, async (tx) => {
    const methodRows = await tx
      .select()
      .from(userUnlockMethods)
      .where(eq(userUnlockMethods.type, "password-argon2id"))
      .limit(1);

    const method = methodRows[0];
    if (!method) return null;

    const ref = method.unlockRef as PasswordUnlockRef;
    const salt = Buffer.from(ref.saltB64, "base64");
    const aad: AadContext = {
      rowId: method.id,
      column: "wrapped_data_key",
      version: method.version,
    };

    const kek = await deriveKekFromPassword(password, salt, ref.params);
    let dataKey: Buffer;
    try {
      dataKey = unwrapWithKek(kek, aad, Buffer.from(method.wrappedDataKey));
    } catch {
      // AEAD auth failure = wrong password (or tampered wrap). Same answer either way.
      return null;
    } finally {
      wipe(kek);
    }

    // Decided once, here, from the PREVIOUS login's timestamp — before it is
    // overwritten below. A UI hint only; see Session.promptSyncOnLogin.
    const promptSync =
      candidate.autoSyncOnLogin &&
      candidate.lastLoginAt !== null &&
      Date.now() - candidate.lastLoginAt.getTime() >= SYNC_PROMPT_GAP_MS;

    await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, candidate.id));

    return createSession(candidate.id, dataKey, candidate.baseCurrency, promptSync);
  });
}

/** Reads the session cookie and returns the live session, or null. Safe in server components. */
export async function getCurrentSession(): Promise<Session | null> {
  const jar = await cookies();
  return getSession(jar.get(SESSION_COOKIE)?.value);
}

/**
 * Returns the live session or redirects to /login. Use at the top of every
 * protected server component / layout so no page renders without an unlock
 * window (and thus without a data key to decrypt Tier-1 fields).
 */
export async function requireSession(): Promise<Session> {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Reads the session cookie directly off a `NextRequest`'s own cookie jar —
 * the Route Handler (src/app/api/**) equivalent of `getCurrentSession()`.
 * `NextRequest.cookies` parses the `Cookie` header itself and needs no
 * request-scoped context, unlike `next/headers`'s `cookies()` (which is why
 * `getCurrentSession()` can't be exercised directly outside a live Next
 * request) — this is the version route tests can call directly.
 */
export function getSessionFromRequest(req: NextRequest): Session | null {
  return getSession(req.cookies.get(SESSION_COOKIE)?.value);
}

/**
 * Unwraps the user's credential key (CK) — the key that decrypts Tier-0 bank
 * credentials — independently of the data-key session. Does its own fresh
 * KEK derivation (never reuses a session's KEK, which is wiped immediately
 * after login) and returns null for any failure, indistinguishably (unknown
 * method, wrong password, tampered wrap). Callers arm `cred-window.ts` with
 * the result; this function does not touch that store itself.
 */
export async function unlockCredentialKey(
  userId: string,
  password: Buffer,
): Promise<Buffer | null> {
  return withUser(userId, async (tx) => {
    const methodRows = await tx
      .select()
      .from(userUnlockMethods)
      .where(eq(userUnlockMethods.type, "password-argon2id"))
      .limit(1);

    const method = methodRows[0];
    if (!method) return null;

    const ref = method.unlockRef as PasswordUnlockRef;
    const salt = Buffer.from(ref.saltB64, "base64");
    const aad: AadContext = {
      rowId: method.id,
      column: "wrapped_credential_key",
      version: method.version,
    };

    const kek = await deriveKekFromPassword(password, salt, ref.params);
    try {
      return unwrapWithKek(kek, aad, Buffer.from(method.wrappedCredentialKey));
    } catch {
      return null;
    } finally {
      wipe(kek);
    }
  });
}

/** Destroys the session identified by the cookie value (wiping its data
 * key), and cascades to wipe any armed credential window for that same
 * session id — logout must clear both RAM windows, not just one (docs plan
 * §B flags this as easy to forget). */
export function endSession(sessionId: string): void {
  destroySession(sessionId);
  destroyCredentialWindow(sessionId);
}
