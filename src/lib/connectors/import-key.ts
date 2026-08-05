// The scrape dedup key (data-model.md §5/§6.4, docs plan §D). Built from
// STABLE fields only — banks mutate `description` and `processedDate` when a
// charge moves from pending to posted, so neither is an input here. `date`
// is always the transaction's purchase date, never `processedDate`.
//
// `originalAmount` is taken as an already-canonicalized decimal STRING (see
// src/lib/money/from-scraper-number.ts) — this module never touches a
// money-bearing JS number itself, keeping the float-boundary confined to
// exactly one function as the plan requires.
import { createHash } from "node:crypto";

export interface ImportKeyInput {
  connectorId: string;
  /** The resolved internal Moni account id (plaintext, already resolved by
   * decrypt-and-match) — not the scraper's raw account number. */
  accountId: string;
  identifier: string | number | null | undefined;
  /** Canonical decimal string (data-model.md conventions), not a JS number. */
  originalAmount: string;
  originalCurrency: string;
  /** The transaction's purchase date — never `processedDate`. */
  date: string;
  /**
   * Which slice of an installment deal this is, or null/absent for an
   * ordinary charge. Required because Isracard/Amex emit every slice with
   * the same identifier, the same purchase date and the same deal sum, so
   * the five fields above cannot tell payment 3 from payment 4 and all
   * twelve would collapse onto one entry.
   */
  installmentNumber?: number | null;
}

const MISSING_IDENTIFIER_SENTINEL = "no-id";
const SEPARATOR = "";

/**
 * Documented limitation, not engineered around (docs plan §D): on
 * connectors that omit `identifier`, two genuinely different same-day
 * same-amount charges on one account collapse to one key. This is a
 * data-source constraint, not a bug.
 */
export function computeImportKey(input: ImportKeyInput): string {
  const identifier =
    input.identifier == null || input.identifier === ""
      ? MISSING_IDENTIFIER_SENTINEL
      : String(input.identifier);

  const parts = [
    input.connectorId,
    input.accountId,
    identifier,
    input.originalAmount,
    input.originalCurrency,
    input.date,
    // Absent contributes nothing, so an ordinary charge keeps exactly the
    // key it already has in the database.
    ...(input.installmentNumber == null ? [] : [String(input.installmentNumber)]),
  ];

  return createHash("sha256").update(parts.join(SEPARATOR), "utf8").digest("hex");
}
