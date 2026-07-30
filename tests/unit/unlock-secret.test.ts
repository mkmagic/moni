// Unit tests for src/lib/auth/unlock-secret.ts — the KEK derivation on the
// passkey side of key custody (issue #7). No DB, no WebAuthn: the domain
// takes an OPAQUE 32-byte unlock secret and knows nothing about how the
// browser produced it, which is exactly what makes this testable without a
// test-only branch in production code.
import { describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { deriveKekFromUnlockSecret, UNLOCK_SECRET_LENGTH } from "@/lib/auth/unlock-secret";
import { wrapWithKek, unwrapWithKek } from "@/lib/auth/password";
import type { AadContext } from "@/lib/crypto";

function aad(methodId: string): AadContext {
  return { rowId: methodId, column: "wrapped_credential_key", version: 1 };
}

describe("deriveKekFromUnlockSecret", () => {
  it("is deterministic for a given secret", () => {
    const secret = randomBytes(UNLOCK_SECRET_LENGTH);
    expect(deriveKekFromUnlockSecret(secret).equals(deriveKekFromUnlockSecret(secret))).toBe(true);
  });

  it("returns a 32-byte KEK", () => {
    expect(deriveKekFromUnlockSecret(randomBytes(UNLOCK_SECRET_LENGTH))).toHaveLength(32);
  });

  it("is not the identity function — the KEK never equals the raw secret", () => {
    const secret = randomBytes(UNLOCK_SECRET_LENGTH);
    expect(deriveKekFromUnlockSecret(secret).equals(secret)).toBe(false);
  });

  it("different secrets derive different KEKs", () => {
    const a = deriveKekFromUnlockSecret(randomBytes(UNLOCK_SECRET_LENGTH));
    const b = deriveKekFromUnlockSecret(randomBytes(UNLOCK_SECRET_LENGTH));
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a secret that is not exactly 32 bytes — fail closed, never pad", () => {
    expect(() => deriveKekFromUnlockSecret(randomBytes(16))).toThrow();
    expect(() => deriveKekFromUnlockSecret(randomBytes(64))).toThrow();
    expect(() => deriveKekFromUnlockSecret(Buffer.alloc(0))).toThrow();
  });

  it("wraps and unwraps a credential key, and a wrong secret fails the AEAD", () => {
    const methodId = randomUUID();
    const credentialKey = randomBytes(32);

    const kek = deriveKekFromUnlockSecret(randomBytes(UNLOCK_SECRET_LENGTH));
    const wrapped = wrapWithKek(kek, aad(methodId), credentialKey);
    expect(unwrapWithKek(kek, aad(methodId), wrapped).equals(credentialKey)).toBe(true);

    const wrongKek = deriveKekFromUnlockSecret(randomBytes(UNLOCK_SECRET_LENGTH));
    expect(() => unwrapWithKek(wrongKek, aad(methodId), wrapped)).toThrow();
  });
});
