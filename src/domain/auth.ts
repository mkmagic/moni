// Authentication — the login half of the single access path.
//
// Establishes the tenancy + decryption context every other domain read
// depends on. Login is the one operation that must read the identity table
// *before* `app.user_id` exists, so it does a narrow email lookup through the
// `users_app_select` policy (drizzle/0002) rather than `withUser`. Everything
// after login is scoped by the session it creates.
//
// Security properties (docs/security/security-design-principles.md §1-8):
//   * No Tier-0 bank credential is involved — this gate only unlocks Tier-1
//     field decryption for the session.
//   * The unwrapped data key lives only in the RAM session store; it is never
//     sent to the browser (server-only module).
//   * A wrong password fails the AEAD unwrap → indistinguishable "invalid
//     credentials"; no password hash is stored to leak.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { unwrapDataKey, type Argon2Params } from "@/lib/auth/password";
import { createSession, destroySession, getSession, type Session } from "@/lib/auth/session-store";

export const SESSION_COOKIE = "moni_session";

/** Shape of `users.unlock_method_ref` for the v1.0 password-envelope method. */
interface PasswordUnlockRef {
  type: "password-argon2id";
  /** base64-encoded Argon2id salt. */
  saltB64: string;
  params: Argon2Params;
}

/**
 * Verifies a password and, on success, unwraps the user's data key into a new
 * RAM session. Returns the opaque session id, or null for any failure
 * (unknown email, no key custody set up, or wrong password). `password` is a
 * Tier-0 `Buffer` owned by the caller (the route wipes it).
 */
export async function authenticate(email: string, password: Buffer): Promise<string | null> {
  const rows = await db
    .select({
      id: users.id,
      wrappedDataKey: users.wrappedDataKey,
      unlockMethodRef: users.unlockMethodRef,
      baseCurrency: users.baseCurrency,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const row = rows[0];
  if (!row?.wrappedDataKey || !row.unlockMethodRef) return null;

  const ref = row.unlockMethodRef as PasswordUnlockRef;
  if (ref.type !== "password-argon2id") return null;

  const salt = Buffer.from(ref.saltB64, "base64");
  let dataKey: Buffer;
  try {
    dataKey = await unwrapDataKey(
      row.id,
      Buffer.from(row.wrappedDataKey),
      password,
      salt,
      ref.params,
    );
  } catch {
    // AEAD auth failure = wrong password (or tampered wrap). Same answer either way.
    return null;
  }

  return createSession(row.id, dataKey, row.baseCurrency);
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

/** Destroys the session identified by the cookie value (wiping its data key). */
export function endSession(sessionId: string): void {
  destroySession(sessionId);
}
