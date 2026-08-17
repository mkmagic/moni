// AEAD field encryption for Tier-1/Tier-0 columns.
//
// Primitive: XChaCha20-Poly1305 (@noble/ciphers/chacha.js), per
// docs/design/encryption.md §1. Deliberately the "X" (extended-nonce)
// variant, not plain ChaCha20-Poly1305 — its 24-byte nonce is large enough
// to generate randomly per encryption with negligible collision risk, so we
// never need a stateful nonce counter (which a multi-process app/worker
// can't safely share).
//
// Wire format of the returned/consumed Buffer:
//   nonce (24 bytes) || ciphertext+tag (Poly1305 tag appended by the cipher)
// The nonce is generated fresh per call and prefixed to the output so a
// single opaque `bytea` column holds everything needed to decrypt.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { serializeAad, type AadContext } from "./aad";

const NONCE_LENGTH = 24; // XChaCha20's extended nonce.

/**
 * Encrypts `plaintext` under `dataKey`, binding it to `aad` (row id, column,
 * version) so the ciphertext cannot be swapped to a different row/column or
 * silently rolled back to a stale version. `dataKey` is never wiped here —
 * callers own the key's lifetime (see docs/security/threat-model.md §5.5).
 */
export function encryptField(dataKey: Uint8Array, plaintext: Buffer, aad: AadContext): Buffer {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = xchacha20poly1305(dataKey, nonce, serializeAad(aad));
  const ciphertext = cipher.encrypt(plaintext);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);
}

/**
 * Decrypts a Buffer produced by {@link encryptField}. Throws if the AAD
 * (row id/column/version) doesn't match what was used to encrypt, or if the
 * ciphertext was tampered with — both surface as a Poly1305 authentication
 * failure, which is exactly the rollback/tamper detection the AAD scheme is
 * for (docs/security/threat-model.md §7.4, T11).
 */
export function decryptField(dataKey: Uint8Array, ciphertext: Buffer, aad: AadContext): Buffer {
  const nonce = ciphertext.subarray(0, NONCE_LENGTH);
  const encrypted = ciphertext.subarray(NONCE_LENGTH);
  const cipher = xchacha20poly1305(dataKey, nonce, serializeAad(aad));
  const plaintext = cipher.decrypt(encrypted);
  // `cipher.decrypt` returns a fresh allocation; `Buffer.from` copies it into
  // the buffer the caller owns and will wipe. Zero the intermediate now so the
  // plaintext isn't left lingering on the heap for the GC (threat-model.md §5.5).
  try {
    return Buffer.from(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Zeroes a buffer in place. Use immediately after a secret (a derived key,
 * an HKDF intermediate, ...) is no longer needed — per
 * docs/security/threat-model.md §5.5, Tier-0 material must never be left to
 * linger for the GC. Does not touch the caller's own long-lived keys unless
 * they explicitly pass them in.
 */
export function wipe(buf: Uint8Array): void {
  buf.fill(0);
}
