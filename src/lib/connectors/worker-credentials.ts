// Worker-side credential decryption (issue #92, C1). A disposable fetcher
// worker decrypts its OWN connection's `credentials_ct` here, with no database
// access: the parent hands it only [CK, ciphertext] plus the AAD version, so a
// compromised fetcher can neither reach the DB to read another connection's
// ciphertext nor obtain the DK. The reconstructed AAD (rowId = connection id,
// column = "credentials_ct") must match what the domain layer used to encrypt
// (src/domain/connections.ts) or the Poly1305 check fails — the same
// tamper/rollback protection as every other decrypt (threat-model.md §7.4).
//
// The returned strings are the scraper library's unavoidable string residual
// (AC#2): they exist only in this short-lived process, never in the long-lived
// parent. This module imports crypto only — never the DB/domain layer — so the
// `@/lib/connectors` barrel it is exported from stays safe for the fetcher.
import { decryptField } from "@/lib/crypto";

export function decryptWorkerCredentials(
  credentialKey: Buffer,
  ciphertext: Buffer,
  aad: { rowId: string; version: number },
): Record<string, string> {
  const plaintext = decryptField(credentialKey, ciphertext, {
    rowId: aad.rowId,
    column: "credentials_ct",
    version: aad.version,
  });
  try {
    return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
  } finally {
    plaintext.fill(0);
  }
}
