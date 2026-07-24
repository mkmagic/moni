// AAD (Additional Authenticated Data) construction for Tier-1/Tier-0 field
// encryption. See docs/design/encryption.md §3 and docs/design/data-model.md
// §2 ("Encryption columns"): every ciphertext is bound to its row id, column
// name, and a monotonic row version via AAD, so a ciphertext can never be
// swapped between rows/columns/users, and a stale version is rejected
// (rollback resistance — threat-model.md §7.4 / T11).

/** The AAD context a ciphertext is bound to. */
export interface AadContext {
  /** The owning row's id (uuid). */
  rowId: string;
  /** The column name the ciphertext is stored in. */
  column: string;
  /** Monotonic row version (bumped on every update to that row). */
  version: number;
}

/**
 * Wire format: `${rowId} ${column} ${version}`, UTF-8 encoded.
 *
 * Spaces are an unambiguous separator here because `rowId` is always a uuid
 * (no spaces) and `column` is always a SQL identifier (no spaces) — so there
 * is no risk of two different (rowId, column, version) triples serializing
 * to the same bytes. T5 (seed) and T6 (tests) must reproduce this exact
 * format to construct matching AAD on encrypt/decrypt.
 */
export function serializeAad(aad: AadContext): Uint8Array {
  const s = `${aad.rowId} ${aad.column} ${String(aad.version)}`;
  return new TextEncoder().encode(s);
}
