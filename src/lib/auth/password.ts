// Password-based key-encryption-key (KEK) derivation, and generic AEAD
// wrapping of Tier-0 keys under it.
//
// This is the login-side of Moni's key custody (docs/security/threat-model.md
// §5, docs/design/encryption.md §2). A user's password never touches disk;
// it derives a KEK via Argon2id, and that KEK wraps whichever Tier-0 keys a
// caller needs — the per-user data key (DK, Tier-1 field decryption) and the
// credential key (CK, Tier-0 bank-credential decryption) both live on the
// same `user_unlock_methods` row and are wrapped under the SAME derivation,
// which is why KEK derivation is split from wrapping here: one (deliberately
// slow) Argon2id call must serve both keys, not two. `src/domain/
// registration.ts` (mints both wraps at signup) and `src/domain/auth.ts`
// (unwraps DK at login, CK on-demand via `unlockCredentialKey`) are the
// callers.
import { hashRaw, type Algorithm } from "@node-rs/argon2";
import { encryptField, decryptField, type AadContext } from "@/lib/crypto";

// `Algorithm` is an ambient `const enum`; its members can't be value-accessed
// under Next's `isolatedModules`. Argon2id is value 2 (and the library's
// default), pinned here explicitly via a typed constant.
const ARGON2ID = 2 as Algorithm;

/** Argon2id cost parameters (stored per user so login re-derives identically). */
export interface Argon2Params {
  /** memoryCost in KiB. */
  m: number;
  /** timeCost (iterations). */
  t: number;
  /** parallelism (lanes). */
  p: number;
}

/** OWASP-baseline Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = { m: 19456, t: 2, p: 1 };

const KEK_LENGTH = 32;

/**
 * Derives a 32-byte KEK from a password + salt via Argon2id. `password` and
 * the returned KEK are Tier-0 `Buffer`s — the caller owns wiping the KEK
 * (immediately after using it to wrap/unwrap whichever key(s) it needs).
 * Deterministic for a given (password, salt, params), so one derivation
 * safely wraps or unwraps more than one key on the same row.
 */
export async function deriveKekFromPassword(
  password: Buffer,
  salt: Buffer,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<Buffer> {
  return hashRaw(password, {
    algorithm: ARGON2ID,
    memoryCost: params.m,
    timeCost: params.t,
    parallelism: params.p,
    salt,
    outputLen: KEK_LENGTH,
  });
}

/**
 * Wraps `key` under `kek`, binding the AAD to the storing row/column/version
 * (docs/design/encryption.md §3 — the AAD's `rowId` is the *storing row's*
 * id, e.g. a `user_unlock_methods` row, never `users.id`). Does not wipe
 * `kek` — the caller derived it and owns its lifetime.
 */
export function wrapWithKek(kek: Buffer, aad: AadContext, key: Uint8Array): Buffer {
  return encryptField(kek, Buffer.from(key), aad);
}

/**
 * Unwraps a value produced by {@link wrapWithKek}. Throws if `kek` is wrong
 * (the AEAD authentication fails) or the ciphertext was tampered with —
 * that failure *is* the password check for the DK/CK wraps. Does not wipe
 * `kek`.
 */
export function unwrapWithKek(kek: Buffer, aad: AadContext, wrapped: Buffer): Buffer {
  return decryptField(kek, wrapped, aad);
}
