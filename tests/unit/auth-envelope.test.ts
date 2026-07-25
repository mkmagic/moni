// Unit tests for the password-envelope key wrapping (src/lib/auth/password.ts).
// No DB — pure crypto. This is the security-critical login primitive: the
// per-user data key is wrapped under an Argon2id(password) KEK, and a wrong
// password must fail the AEAD unwrap (that failure *is* the password check).
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { wrapDataKey, unwrapDataKey } from "@/lib/auth/password";

const userId = "11111111-1111-1111-1111-111111111111";

describe("password envelope (wrap/unwrap of the per-user data key)", () => {
  it("round-trips: the correct password recovers the exact data key", async () => {
    const dataKey = randomBytes(32);
    const salt = randomBytes(16);
    const password = Buffer.from("correct horse battery staple", "utf8");

    const wrapped = await wrapDataKey(userId, dataKey, password, salt);
    const recovered = await unwrapDataKey(userId, wrapped, password, salt);

    expect(Buffer.from(recovered).equals(dataKey)).toBe(true);
  });

  it("rejects a wrong password (AEAD authentication failure)", async () => {
    const dataKey = randomBytes(32);
    const salt = randomBytes(16);
    const wrapped = await wrapDataKey(userId, dataKey, Buffer.from("right-pass"), salt);

    await expect(unwrapDataKey(userId, wrapped, Buffer.from("wrong-pass"), salt)).rejects.toThrow();
  });

  it("rejects a tampered wrapped key", async () => {
    const dataKey = randomBytes(32);
    const salt = randomBytes(16);
    const password = Buffer.from("pw", "utf8");
    const wrapped = await wrapDataKey(userId, dataKey, password, salt);

    const tampered = Buffer.from(wrapped);
    tampered[tampered.length - 1] ^= 0xff; // flip a ciphertext/tag byte

    await expect(unwrapDataKey(userId, tampered, password, salt)).rejects.toThrow();
  });

  it("is bound to the user id: unwrapping under a different user id fails", async () => {
    const dataKey = randomBytes(32);
    const salt = randomBytes(16);
    const password = Buffer.from("pw", "utf8");
    const wrapped = await wrapDataKey(userId, dataKey, password, salt);

    const otherUserId = "22222222-2222-2222-2222-222222222222";
    await expect(unwrapDataKey(otherUserId, wrapped, password, salt)).rejects.toThrow();
  });

  it("a different salt (same password) does not recover the key", async () => {
    const dataKey = randomBytes(32);
    const password = Buffer.from("pw", "utf8");
    const wrapped = await wrapDataKey(userId, dataKey, password, randomBytes(16));

    await expect(unwrapDataKey(userId, wrapped, password, randomBytes(16))).rejects.toThrow();
  });
});
