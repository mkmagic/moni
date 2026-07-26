// Internal helpers: encrypt/decrypt a Tier-1 UTF-8 string, binding the AAD
// to the row's id/column/version exactly as it was encrypted
// (docs/design/encryption.md §3). Domain reads/writes use these; nothing
// outside the domain layer touches ciphertext directly.
import { encryptField, decryptField } from "@/lib/crypto";

export function decText(
  dataKey: Uint8Array,
  ct: Buffer | Uint8Array | null | undefined,
  rowId: string,
  column: string,
  version: number,
): string | null {
  if (ct == null) return null;
  return decryptField(dataKey, Buffer.from(ct), { rowId, column, version }).toString("utf8");
}

export function encText(
  dataKey: Uint8Array,
  plaintext: string,
  rowId: string,
  column: string,
  version: number,
): Buffer {
  return encryptField(dataKey, Buffer.from(plaintext, "utf8"), { rowId, column, version });
}
