// Unit tests for password-derived KEK wrapping (src/lib/auth/password.ts).
// No DB — pure crypto. This is the security-critical login primitive: a KEK
// derived from Argon2id(password) wraps a Tier-0 key (the data key or the
// credential key), bound to the *storing row's* AAD — and a wrong password
// must fail the AEAD unwrap (that failure *is* the password check).
import { describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { deriveKekFromPassword, wrapWithKek, unwrapWithKek } from "@/lib/auth/password";
import type { AadContext } from "@/lib/crypto";

function aad(methodId: string): AadContext {
  return { rowId: methodId, column: "wrapped_data_key", version: 1 };
}

describe("password-derived KEK: wrap/unwrap of a Tier-0 key", () => {
  it("round-trips: the correct password recovers the exact key", async () => {
    const methodId = randomUUID();
    const key = randomBytes(32);
    const salt = randomBytes(16);
    const password = Buffer.from("correct horse battery staple", "utf8");

    const kek = await deriveKekFromPassword(password, salt);
    const wrapped = wrapWithKek(kek, aad(methodId), key);
    const recovered = unwrapWithKek(kek, aad(methodId), wrapped);

    expect(Buffer.from(recovered).equals(key)).toBe(true);
  });

  it("rejects a wrong password (AEAD authentication failure)", async () => {
    const methodId = randomUUID();
    const key = randomBytes(32);
    const salt = randomBytes(16);

    const rightKek = await deriveKekFromPassword(Buffer.from("right-pass"), salt);
    const wrapped = wrapWithKek(rightKek, aad(methodId), key);

    const wrongKek = await deriveKekFromPassword(Buffer.from("wrong-pass"), salt);
    expect(() => unwrapWithKek(wrongKek, aad(methodId), wrapped)).toThrow();
  });

  it("rejects a tampered wrapped key", async () => {
    const methodId = randomUUID();
    const key = randomBytes(32);
    const salt = randomBytes(16);
    const password = Buffer.from("pw", "utf8");

    const kek = await deriveKekFromPassword(password, salt);
    const wrapped = wrapWithKek(kek, aad(methodId), key);

    const tampered = Buffer.from(wrapped);
    tampered[tampered.length - 1] ^= 0xff; // flip a ciphertext/tag byte

    expect(() => unwrapWithKek(kek, aad(methodId), tampered)).toThrow();
  });

  it("is bound to the storing row id: unwrapping under a different row id fails", async () => {
    const methodId = randomUUID();
    const key = randomBytes(32);
    const salt = randomBytes(16);
    const password = Buffer.from("pw", "utf8");

    const kek = await deriveKekFromPassword(password, salt);
    const wrapped = wrapWithKek(kek, aad(methodId), key);

    const otherMethodId = randomUUID();
    expect(() => unwrapWithKek(kek, aad(otherMethodId), wrapped)).toThrow();
  });

  it("a different salt (same password) does not recover the key", async () => {
    const methodId = randomUUID();
    const key = randomBytes(32);
    const password = Buffer.from("pw", "utf8");

    const kek1 = await deriveKekFromPassword(password, randomBytes(16));
    const wrapped = wrapWithKek(kek1, aad(methodId), key);

    const kek2 = await deriveKekFromPassword(password, randomBytes(16));
    expect(() => unwrapWithKek(kek2, aad(methodId), wrapped)).toThrow();
  });
});
