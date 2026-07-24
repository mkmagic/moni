// ============================================================================
// DEV ONLY. This is NOT the production key-custody path — see
// docs/security/threat-model.md §5 (envelope encryption, WebAuthn-PRF/
// Argon2id unlock, bounded in-memory window). This module exists only so the
// seed script and dev tooling can write/read honest ciphertext without that
// flow being built yet. Never wire this into a real request path.
// ============================================================================
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { wipe } from "./aead";

const MASTER_KEY_LENGTH = 32;
const DERIVED_KEY_LENGTH = 32;
// Fixed HKDF salt for domain separation from any other dev use of the same
// master key; the per-user identity comes from `info`, below.
const HKDF_SALT = new TextEncoder().encode("moni:dev-data-key:v1");

/**
 * Derives a per-user data key (for dev/seed use only) from
 * `MONI_DEV_DATA_KEY` via HKDF-SHA256, using the user id as the HKDF `info`
 * context so each user gets an independent key from the same master secret.
 *
 * Throws if `MONI_DEV_DATA_KEY` is unset or is not valid base64 encoding a
 * 32-byte key — never silently falls back to an insecure default.
 */
export function getDevUserDataKey(userId: string): Uint8Array {
  const encoded = process.env.MONI_DEV_DATA_KEY;
  if (!encoded) {
    throw new Error(
      "MONI_DEV_DATA_KEY is not set. This dev-only key provider requires a " +
        "base64-encoded 32-byte master key — see .env.example. Do not " +
        "fall back to a default; set the env var.",
    );
  }

  let masterKey: Buffer;
  try {
    masterKey = Buffer.from(encoded, "base64");
  } catch {
    throw new Error("MONI_DEV_DATA_KEY is not valid base64.");
  }
  // Buffer.from(..., "base64") does not throw on malformed input; it silently
  // drops invalid characters. Guard the decoded length explicitly instead.
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new Error(
      `MONI_DEV_DATA_KEY must decode to exactly ${MASTER_KEY_LENGTH} bytes ` +
        `(got ${masterKey.length}). See .env.example.`,
    );
  }

  const info = new TextEncoder().encode(userId);
  const derived = hkdf(sha256, masterKey, HKDF_SALT, info, DERIVED_KEY_LENGTH);

  wipe(masterKey);
  return derived;
}
