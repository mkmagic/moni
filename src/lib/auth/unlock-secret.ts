// The passkey side of key custody: turning an opaque 32-byte unlock secret
// into the key-encryption-key that wraps the credential key (CK).
//
// This is the sibling of password.ts's `deriveKekFromPassword`, and the
// difference between them is the whole point of issue #7. A password is
// low-entropy and guessable, so it needs a deliberately slow Argon2id.
// This input is 32 bytes of authenticator-generated entropy (a WebAuthn PRF
// output), so stretching buys nothing — there is nothing to guess. HKDF is
// used purely for domain separation and to avoid handing the raw PRF output
// to the AEAD as a key.
//
// The function takes bytes, not a ceremony. Nothing here knows what WebAuthn
// is: the assertion lives at the route edge (src/app/api/passkeys/**), which
// means tests can drive the real production path with a random 32-byte
// secret and no test-only branch exists to leak into a deployment.
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Length of a WebAuthn PRF output, and so of every unlock secret. */
export const UNLOCK_SECRET_LENGTH = 32;

const KEK_LENGTH = 32;

// Domain separation from every other HKDF use of any secret in this system.
// The PRF salt evaluated in the browser separates *purposes* on the same
// passkey (docs: issue #7's key path); this separates this derivation from
// unrelated ones on the server side.
const HKDF_INFO = new TextEncoder().encode("moni:credential-key-kek:v1");

/**
 * Derives the 32-byte KEK that wraps CK on a `webauthn-prf` unlock method.
 * `secret` is Tier-0 and owned by the caller (which wipes it); the returned
 * KEK is Tier-0 too and must be wiped after use.
 *
 * Throws on any length other than {@link UNLOCK_SECRET_LENGTH} — HKDF would
 * happily accept a short or empty input, and silently deriving a KEK from a
 * truncated (or absent) PRF output is precisely the failure that must never
 * be survivable.
 */
export function deriveKekFromUnlockSecret(secret: Buffer): Buffer {
  if (secret.length !== UNLOCK_SECRET_LENGTH) {
    throw new Error(
      `unlock secret must be exactly ${UNLOCK_SECRET_LENGTH} bytes (got ${secret.length})`,
    );
  }
  // No HKDF salt: the input is already uniformly random, so extract has
  // nothing to condition, and a stored per-row salt would add a failure mode
  // (a lost salt is a lost CK) for no security gain.
  return Buffer.from(hkdf(sha256, secret, undefined, HKDF_INFO, KEK_LENGTH));
}
