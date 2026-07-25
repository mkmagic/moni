// Password-based envelope wrapping of the per-user data key.
//
// This is the login-side of Moni's key custody (docs/security/threat-model.md
// §5, docs/design/encryption.md §2). The per-user *data key* — which decrypts
// all Tier-1 fields — is never stored in the clear. It is wrapped under a
// key-encryption-key (KEK) derived from the user's password via Argon2id, and
// only the wrapped form (`users.wrapped_data_key`) lives at rest. A correct
// password re-derives the KEK and unwraps the data key into RAM; a wrong
// password makes the AEAD unwrap fail — which *is* the password check (no
// separate password hash is stored).
//
// FIRST-DRAFT NOTE: the data-key *bytes* currently come from the dev key
// provider (HKDF of MONI_DEV_DATA_KEY) so seeded ciphertext stays valid; in
// production the data key would be random per user. Either way the wrapping
// scheme here is the real envelope shape.
import { hashRaw, type Algorithm } from "@node-rs/argon2";
import { encryptField, decryptField, wipe, type AadContext } from "@/lib/crypto";

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
// The users table has no `version` column; the wrap AAD uses a fixed version
// of 1. Seed (wrap) and login (unwrap) MUST agree on this triple.
const WRAP_COLUMN = "wrapped_data_key";
const WRAP_VERSION = 1;

function wrapAad(userId: string): AadContext {
  return { rowId: userId, column: WRAP_COLUMN, version: WRAP_VERSION };
}

/**
 * Derives a 32-byte KEK from a password + salt via Argon2id. `password` and
 * the returned KEK are Tier-0 `Buffer`s — the caller owns wiping the KEK
 * (helpers below do). Deterministic for a given (password, salt, params).
 */
async function deriveKek(password: Buffer, salt: Buffer, params: Argon2Params): Promise<Buffer> {
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
 * Wraps `dataKey` under the password. Returns the ciphertext to store in
 * `users.wrapped_data_key`. The AAD binds the wrap to the user's id so a
 * wrapped key cannot be swapped between users. Wipes the derived KEK; does
 * not wipe the caller's `password`/`dataKey`.
 */
export async function wrapDataKey(
  userId: string,
  dataKey: Uint8Array,
  password: Buffer,
  salt: Buffer,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<Buffer> {
  const kek = await deriveKek(password, salt, params);
  try {
    return encryptField(kek, Buffer.from(dataKey), wrapAad(userId));
  } finally {
    wipe(kek);
  }
}

/**
 * Unwraps the per-user data key. Throws if the password is wrong (the AEAD
 * authentication fails) or the ciphertext was tampered with. Returns the
 * plaintext data key as a Tier-0 `Buffer` the caller must eventually wipe
 * (the session store owns that lifetime). Wipes the derived KEK.
 */
export async function unwrapDataKey(
  userId: string,
  wrapped: Buffer,
  password: Buffer,
  salt: Buffer,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<Buffer> {
  const kek = await deriveKek(password, salt, params);
  try {
    return decryptField(kek, wrapped, wrapAad(userId));
  } finally {
    wipe(kek);
  }
}
