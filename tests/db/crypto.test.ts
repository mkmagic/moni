// Exercises src/lib/crypto directly (no DB needed) — round-trip, tamper
// detection (AAD + ciphertext), and per-user key derivation. See
// docs/design/encryption.md §1/§3 and docs/security/threat-model.md §7.4.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { decryptField, encryptField, getDevUserDataKey } from "@/lib/crypto";

describe("encryptField / decryptField round-trip", () => {
  it("decrypts back to the original plaintext", () => {
    const userId = randomUUID();
    const key = getDevUserDataKey(userId);
    const rowId = randomUUID();
    const plaintext = Buffer.from("₪1,234.56 — Super-Pharm Ramat Gan", "utf8");

    const ciphertext = encryptField(key, plaintext, {
      rowId,
      column: "description_ct",
      version: 1,
    });
    const decrypted = decryptField(key, ciphertext, {
      rowId,
      column: "description_ct",
      version: 1,
    });

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("throws when the AAD version doesn't match what was used to encrypt", () => {
    const userId = randomUUID();
    const key = getDevUserDataKey(userId);
    const rowId = randomUUID();
    const plaintext = Buffer.from("some sensitive value", "utf8");

    const ciphertext = encryptField(key, plaintext, { rowId, column: "notes_ct", version: 1 });

    expect(() =>
      decryptField(key, ciphertext, { rowId, column: "notes_ct", version: 2 }),
    ).toThrow();
  });

  it("throws when the AAD row id doesn't match (ciphertext cannot be swapped between rows)", () => {
    const userId = randomUUID();
    const key = getDevUserDataKey(userId);
    const plaintext = Buffer.from("some sensitive value", "utf8");

    const ciphertext = encryptField(key, plaintext, {
      rowId: randomUUID(),
      column: "notes_ct",
      version: 1,
    });

    expect(() =>
      decryptField(key, ciphertext, { rowId: randomUUID(), column: "notes_ct", version: 1 }),
    ).toThrow();
  });

  it("throws when a single ciphertext byte is flipped (tamper detection)", () => {
    const userId = randomUUID();
    const key = getDevUserDataKey(userId);
    const rowId = randomUUID();
    const plaintext = Buffer.from("do not tamper with me", "utf8");
    const aad = { rowId, column: "description_ct", version: 1 };

    const ciphertext = encryptField(key, plaintext, aad);
    const tampered = Buffer.from(ciphertext);
    // Flip a byte past the 24-byte nonce prefix, inside the actual
    // ciphertext+tag region, so this is genuinely a ciphertext tamper and
    // not just a different (still-valid-looking) nonce.
    tampered[24] ^= 0xff;

    expect(() => decryptField(key, tampered, aad)).toThrow();
  });
});

describe("getDevUserDataKey", () => {
  it("derives two different keys for two different users from the same master secret", () => {
    const keyA = getDevUserDataKey(randomUUID());
    const keyB = getDevUserDataKey(randomUUID());
    expect(Buffer.from(keyA).equals(Buffer.from(keyB))).toBe(false);
  });

  it("is deterministic for the same user id", () => {
    const userId = randomUUID();
    const keyA = getDevUserDataKey(userId);
    const keyB = getDevUserDataKey(userId);
    expect(Buffer.from(keyA).equals(Buffer.from(keyB))).toBe(true);
  });

  it("user A's key cannot decrypt user B's ciphertext", () => {
    const userAId = randomUUID();
    const userBId = randomUUID();
    const keyA = getDevUserDataKey(userAId);
    const keyB = getDevUserDataKey(userBId);
    const rowId = randomUUID();
    const aad = { rowId, column: "description_ct", version: 1 };

    const ciphertext = encryptField(keyB, Buffer.from("B's secret data", "utf8"), aad);

    expect(() => decryptField(keyA, ciphertext, aad)).toThrow();
  });
});
