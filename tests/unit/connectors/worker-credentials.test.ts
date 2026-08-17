import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptField } from "@/lib/crypto";
import { decryptWorkerCredentials } from "@/lib/connectors/worker-credentials";

const ROW_ID = "11111111-1111-1111-1111-111111111111";
const CREDS = { username: "dana", password: "hunter2 שלום" };

function ciphertextFor(ck: Buffer, version: number): Buffer {
  return encryptField(ck, Buffer.from(JSON.stringify(CREDS), "utf8"), {
    rowId: ROW_ID,
    column: "credentials_ct",
    version,
  });
}

describe("decryptWorkerCredentials", () => {
  it("round-trips the credential map the domain layer encrypted", () => {
    const ck = Buffer.from(randomBytes(32));
    const ct = ciphertextFor(ck, 3);
    expect(decryptWorkerCredentials(ck, ct, { rowId: ROW_ID, version: 3 })).toEqual(CREDS);
  });

  it("fails (Poly1305) when the version does not match the ciphertext", () => {
    const ck = Buffer.from(randomBytes(32));
    const ct = ciphertextFor(ck, 3);
    expect(() => decryptWorkerCredentials(ck, ct, { rowId: ROW_ID, version: 4 })).toThrow();
  });

  it("fails when the row id (AAD) does not match", () => {
    const ck = Buffer.from(randomBytes(32));
    const ct = ciphertextFor(ck, 1);
    expect(() =>
      decryptWorkerCredentials(ck, ct, {
        rowId: "22222222-2222-2222-2222-222222222222",
        version: 1,
      }),
    ).toThrow();
  });

  it("fails when the credential key is wrong", () => {
    const ct = ciphertextFor(Buffer.from(randomBytes(32)), 1);
    expect(() =>
      decryptWorkerCredentials(Buffer.from(randomBytes(32)), ct, { rowId: ROW_ID, version: 1 }),
    ).toThrow();
  });
});
