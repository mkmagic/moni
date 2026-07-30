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
// credentials — is unwrapped separately by src/domain/credential-unlock.ts
// and lives in the shorter-TTL `cred-window` store.
//
// Nothing in THIS file can open CK, and that is a load-bearing property, not
// an omission (issue #7, requirement from #18): the login password does not
// wrap CK on any row, so no code path — and no attacker who has phished the
// password — can reach a bank credential with it. Adding a password-derived
// CK unwrap here would reopen exactly the hole that design closed.
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
import { db, withUser, type UserTransaction } from "@/db/client";
import { users, userUnlockMethods } from "@/db/schema";
import { deriveKekFromPassword, unwrapWithKek, type Argon2Params } from "@/lib/auth/password";
import { wipe, type AadContext } from "@/lib/crypto";
import {
  createSession,
  destroySession,
  getSession,
  sessionIdsForUser,
  SESSION_TTL_MS,
  type Session,
} from "@/lib/auth/session-store";
import { destroyCredentialWindow } from "@/lib/auth/cred-window";
import { clearPendingCeremony } from "@/lib/auth/webauthn-challenge";

export const SESSION_COOKIE = "moni_session";

/**
 * The attributes EVERY write of the session cookie must use.
 *
 * This is a correctness requirement, not tidiness. Clearing a cookie only
 * works when the attributes match the ones it was set with — otherwise the
 * browser treats the clear as a different cookie and the original survives,
 * silently, with no error and nothing for a test to catch. Four routes write
 * this cookie (signup and login set it; logout and account deletion clear
 * it), so the attributes were copied four times and any one of them could
 * drift and break logout at the other three.
 *
 * `maxAge` is deliberately NOT here: it is the one attribute that legitimately
 * differs between setting (`SESSION_TTL_SECONDS`) and clearing (`0`), and the
 * browser does not compare it when matching a cookie to overwrite.
 *
 * Exported as a plain object rather than a `setSessionCookie(res)` helper on
 * purpose — a helper would need `NextResponse`, and an HTTP response type has
 * no business in the domain layer.
 */
export const SESSION_COOKIE_ATTRS = {
  httpOnly: true,
  sameSite: "lax",
  secure: true, // Moni is HTTPS-only (src/proxy.ts); never conditional on the build mode.
  path: "/",
} as const;

/**
 * How stale the previous login must be before an `autoSyncOnLogin` user is
 * offered a sync. Defined AS one session lifetime — the offer should appear
 * when you come back to a session that had fully expired, so it derives from
 * the store's TTL instead of restating it. This used to be its own
 * `8 * 60 * 60 * 1000` with a comment claiming it matched; a comment is not
 * an enforcement, and shortening the session TTL would have started showing
 * the prompt to people whose session was still alive.
 */
const SYNC_PROMPT_GAP_MS = SESSION_TTL_MS;

/** Shape of `user_unlock_methods.unlock_ref` for the password-argon2id method. */
interface PasswordUnlockRef {
  /** base64-encoded Argon2id salt. */
  saltB64: string;
  params: Argon2Params;
}

/**
 * Derives the KEK from `password` and unwraps the caller's data key, or
 * returns null if there is no usable password method on file or the password
 * is wrong. Must be called inside a `withUser`-scoped transaction — RLS is
 * what limits the method lookup to that user's row.
 *
 * Shared by `authenticate()` (which hands the key to a session) and
 * `verifyPassword()` (which throws it away): one Argon2id derivation, one
 * AEAD unwrap, one place where "is this the right password" is decided. The
 * returned key is Tier-0 and the caller owns wiping it.
 */
async function unwrapDataKey(tx: UserTransaction, password: Buffer): Promise<Buffer | null> {
  const methodRows = await tx
    .select()
    .from(userUnlockMethods)
    .where(eq(userUnlockMethods.type, "password-argon2id"))
    .limit(1);

  // The wrap columns are nullable now that a method row states which keys
  // it opens (issue #7) — a password row with no DK wrap can't log anyone
  // in, so it fails closed like any other bad candidate.
  const method = methodRows[0];
  if (!method?.wrappedDataKey) return null;

  const ref = method.unlockRef as PasswordUnlockRef;
  const salt = Buffer.from(ref.saltB64, "base64");
  const aad: AadContext = {
    rowId: method.id,
    column: "wrapped_data_key",
    version: method.version,
  };

  const kek = await deriveKekFromPassword(password, salt, ref.params);
  try {
    return unwrapWithKek(kek, aad, Buffer.from(method.wrappedDataKey));
  } catch {
    // AEAD auth failure = wrong password (or tampered wrap). Same answer either way.
    return null;
  } finally {
    wipe(kek);
  }
}

/**
 * Re-checks a *already-authenticated* user's password without minting a
 * session or touching `last_login_at` — the step-up gate in front of an
 * irreversible action (account deletion, issue #31), where a live session
 * cookie alone is not enough authority.
 *
 * The data key it unwraps is wiped immediately: the answer here is a boolean,
 * not a key. `password` is a Tier-0 `Buffer` owned by the caller.
 */
export async function verifyPassword(userId: string, password: Buffer): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const dataKey = await unwrapDataKey(tx, password);
    if (!dataKey) return false;
    wipe(dataKey);
    return true;
  });
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
    const dataKey = await unwrapDataKey(tx, password);
    if (!dataKey) return null;

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

/** Destroys the session identified by the cookie value (wiping its data
 * key), and cascades to wipe any armed credential window for that same
 * session id — logout must clear both RAM windows, not just one (docs plan
 * §B flags this as easy to forget) — plus any half-finished passkey
 * ceremony, which is keyed by session id too. */
export function endSession(sessionId: string): void {
  destroySession(sessionId);
  destroyCredentialWindow(sessionId);
  clearPendingCeremony(sessionId);
}

/**
 * Ends every session `userId` holds, not just the one that made the request —
 * the account-deletion counterpart to `endSession()`. A user logged in on a
 * second device would otherwise keep a data key in RAM for rows that no
 * longer exist, which is exactly the kind of key lifetime the RAM-only
 * custody model exists to bound (threat-model.md §5.3).
 */
export function endAllSessionsForUser(userId: string): void {
  for (const id of sessionIdsForUser(userId)) endSession(id);
}
