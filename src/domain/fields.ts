// Internal helper: decrypt a Tier-1 `*_ct` column to a UTF-8 string, binding
// the AAD to the row's id/column/version exactly as it was encrypted
// (docs/design/encryption.md §3). Domain reads use this; nothing outside the
// domain layer decrypts.
import { decryptField } from "@/lib/crypto";

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
