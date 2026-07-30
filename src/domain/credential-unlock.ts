// Custody of the credential key (CK) — the key that decrypts Tier-0 bank
// credentials — and the only way to open it (issue #7, requirement inherited
// from #18).
//
// The rule this module exists to enforce: **the login password cannot reach
// CK at all.** CK is minted the first time a second factor is enrolled, and
// every wrap of it lives on a `webauthn-prf` row whose KEK comes from a
// passkey's PRF output. src/domain/registration.ts deliberately does not
// mint CK, and src/domain/auth.ts deliberately cannot open it. Any change
// that lets a password-derived KEK unwrap CK reopens the attack #18 closed:
// a local helper that prompts for the Moni password is indistinguishable
// from a fake one that harvests it.
//
// The seam is a plain 32-byte secret. Nothing below knows what WebAuthn is —
// the ceremony (challenge, assertion verification, user-verification
// enforcement, RP ID binding) lives at the route edge in
// src/app/api/passkeys/**. That keeps the ceremony out of the domain layer
// AND means tests exercise this exact production code with random bytes,
// rather than a test-only bypass that could survive into a deployment.
//
// There is NO recovery path for CK, by design. Lose every enrolled passkey
// and the remedy is to delete the connection and re-enter the bank login.
// Recovery codes, when they exist, wrap DK only.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { userUnlockMethods } from "@/db/schema";
import { wrapWithKek, unwrapWithKek } from "@/lib/auth/password";
import { deriveKekFromUnlockSecret, UNLOCK_SECRET_LENGTH } from "@/lib/auth/unlock-secret";
import { wipe, type AadContext } from "@/lib/crypto";

export { UNLOCK_SECRET_LENGTH };

/**
 * The public, non-secret half of an enrolled passkey, stored in
 * `user_unlock_methods.unlock_ref`. None of this is sensitive — a credential
 * id and a public key are exactly that — but note what is absent: the PRF
 * output never appears here, or anywhere else at rest.
 */
export interface PasskeyUnlockRef {
  /** WebAuthn credential id, base64url. */
  credentialIdB64Url: string;
  /** COSE public key for assertion verification, base64url. */
  publicKeyB64Url: string;
  /** Signature counter; synced passkeys leave this at 0 forever. */
  counter: number;
  transports?: string[];
  /**
   * The RP ID this passkey was enrolled under. Recorded per row so a moved
   * deployment can say "your passkey was registered for <old domain>"
   * instead of failing as a generic auth error — there is no re-scope API
   * for a WebAuthn binding, so the user has to be told plainly.
   */
  rpId: string;
  /** User-facing name, e.g. "MacBook (iCloud Keychain)". */
  label: string;
}

export interface CredentialUnlockMethod {
  id: string;
  createdAt: Date;
  ref: PasskeyUnlockRef;
}

/**
 * Thrown when enrolling an additional passkey without supplying the existing
 * CK. Enrolling more factors requires an armed credential window: the new
 * passkey must wrap the *same* CK, and minting a second one instead would
 * silently strand every bank credential already encrypted under the first.
 */
export class CredentialKeyRequiredError extends Error {
  constructor() {
    super("A credential window must be armed before enrolling another passkey");
    this.name = "CredentialKeyRequiredError";
  }
}

/** Thrown when the credential id is already enrolled for this user. */
export class PasskeyAlreadyEnrolledError extends Error {
  constructor() {
    super("This passkey is already enrolled");
    this.name = "PasskeyAlreadyEnrolledError";
  }
}

function credentialKeyAad(methodId: string, version: number): AadContext {
  return { rowId: methodId, column: "wrapped_credential_key", version };
}

/** Every enrolled second factor that can open CK, oldest first. */
export async function listCredentialUnlockMethods(
  userId: string,
): Promise<CredentialUnlockMethod[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select()
      .from(userUnlockMethods)
      .where(eq(userUnlockMethods.type, "webauthn-prf"));
    return rows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        ref: row.unlockRef as PasskeyUnlockRef,
      }));
  });
}

/**
 * Enrolls a second factor against CK and returns the method id plus a copy
 * of CK for the caller to arm its window with (the caller owns wiping it).
 *
 * `existingCredentialKey` is null only for the very first enrollment, which
 * mints CK. Every later enrollment must pass the live CK — see
 * {@link CredentialKeyRequiredError}.
 *
 * **Verify before commit.** Two things must hold before a row exists:
 *   1. `unlockSecret` came from an *assertion* (a `get` ceremony), not from
 *      the `create` that registered the passkey. This is structural — the
 *      route only reaches this function after verifying an assertion — and
 *      it is what guards the reported platform-vs-hybrid PRF divergence
 *      (Apple forums 764730). A row whose wrap only the create ceremony can
 *      open is a row nobody can ever open.
 *   2. The wrap actually round-trips under a freshly re-derived KEK, checked
 *      below before the INSERT. Writing an unopenable wrap of CK is not a
 *      recoverable error — there is no second copy.
 */
export async function enrollCredentialUnlockMethod(
  userId: string,
  unlockSecret: Buffer,
  ref: PasskeyUnlockRef,
  existingCredentialKey: Buffer | null,
): Promise<{ methodId: string; credentialKey: Buffer }> {
  const methodId = randomUUID();
  const aad = credentialKeyAad(methodId, 1);

  // Caller-owned; this function works on its own copy throughout so the
  // returned key's lifetime is unambiguous.
  const credentialKey = existingCredentialKey
    ? Buffer.from(existingCredentialKey)
    : randomBytes(32);

  const kek = deriveKekFromUnlockSecret(unlockSecret);
  let wrappedCredentialKey: Buffer;
  try {
    wrappedCredentialKey = wrapWithKek(kek, aad, credentialKey);
  } finally {
    wipe(kek);
  }

  const checkKek = deriveKekFromUnlockSecret(unlockSecret);
  try {
    const recovered = unwrapWithKek(checkKek, aad, wrappedCredentialKey);
    try {
      if (!timingSafeEqual(recovered, credentialKey)) {
        throw new Error("credential-unlock: wrap did not round-trip; refusing to enroll");
      }
    } finally {
      wipe(recovered);
    }
  } catch (err) {
    wipe(credentialKey);
    throw err;
  } finally {
    wipe(checkKek);
  }

  try {
    return await withUser(userId, async (tx) => {
      const existing = await tx
        .select({ id: userUnlockMethods.id, unlockRef: userUnlockMethods.unlockRef })
        .from(userUnlockMethods)
        .where(eq(userUnlockMethods.type, "webauthn-prf"));

      if (existing.length > 0 && !existingCredentialKey) {
        throw new CredentialKeyRequiredError();
      }
      if (
        existing.some(
          (row) =>
            (row.unlockRef as PasskeyUnlockRef).credentialIdB64Url === ref.credentialIdB64Url,
        )
      ) {
        throw new PasskeyAlreadyEnrolledError();
      }

      await tx.insert(userUnlockMethods).values({
        id: methodId,
        ownerId: userId,
        type: "webauthn-prf",
        wrappedDataKey: null,
        wrappedCredentialKey,
        unlockRef: ref,
      });

      return { methodId, credentialKey };
    });
  } catch (err) {
    wipe(credentialKey);
    throw err;
  }
}

/**
 * Unwraps CK from one enrolled method. Returns null for every failure —
 * unknown method, wrong secret, tampered wrap — indistinguishably, matching
 * `authenticate()`'s posture. The returned key is Tier-0 and owned by the
 * caller (normally handed straight to `armCredentialWindow`).
 */
export async function unlockCredentialKey(
  userId: string,
  methodId: string,
  unlockSecret: Buffer,
): Promise<Buffer | null> {
  if (unlockSecret.length !== UNLOCK_SECRET_LENGTH) return null;

  return withUser(userId, async (tx) => {
    const rows = await tx
      .select()
      .from(userUnlockMethods)
      .where(and(eq(userUnlockMethods.id, methodId), eq(userUnlockMethods.type, "webauthn-prf")))
      .limit(1);

    const method = rows[0];
    if (!method?.wrappedCredentialKey) return null;

    const kek = deriveKekFromUnlockSecret(unlockSecret);
    try {
      return unwrapWithKek(
        kek,
        credentialKeyAad(method.id, method.version),
        Buffer.from(method.wrappedCredentialKey),
      );
    } catch {
      // AEAD auth failure = wrong secret (or tampered wrap). Same answer either way.
      return null;
    } finally {
      wipe(kek);
    }
  });
}

/**
 * Persists an advanced WebAuthn signature counter. A regression is the clone
 * signal, and SimpleWebAuthn rejects the assertion before we get here — so
 * this only ever moves forward, and ignores anything that doesn't.
 */
export async function recordAssertionCounter(
  userId: string,
  methodId: string,
  counter: number,
): Promise<void> {
  await withUser(userId, async (tx) => {
    const rows = await tx
      .select({ unlockRef: userUnlockMethods.unlockRef })
      .from(userUnlockMethods)
      .where(eq(userUnlockMethods.id, methodId))
      .limit(1);

    const ref = rows[0]?.unlockRef as PasskeyUnlockRef | undefined;
    if (!ref || counter <= ref.counter) return;

    await tx
      .update(userUnlockMethods)
      .set({ unlockRef: { ...ref, counter } })
      .where(eq(userUnlockMethods.id, methodId));
  });
}
