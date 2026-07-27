// The single definition of "the same merchant text".
//
// Built-in rules, the learner, and rule creation from the categorize dialog
// all key off this function, so a change here changes what counts as a match
// everywhere at once — that is the point. Pure: no DB, no crypto, no I/O.
//
// Bank descriptions in Israel arrive as Hebrew with inconsistent spacing,
// punctuation, and a trailing card/reference number that differs per
// transaction for the same merchant. Normalizing all of that away is what
// lets "שופרסל דיל 1234" and "שופרסל  דיל-5678" collapse to one key.

/** Hebrew niqqud and cantillation (U+0591–U+05C7), which banks emit
 * inconsistently and which never carry meaning in a merchant name. */
const HEBREW_MARKS = /[֑-ׇ]/g;

/** Hebrew/Arabic geresh and gershayim, plus the ASCII quotes banks
 * substitute for them (ג׳ופניקה vs ג'ופניקה vs גופניקה). */
const QUOTE_MARKS = /['"׳״`´]/g;

/** Any run of 4+ digits — card suffixes, reference numbers, invoice ids.
 * Shorter runs are kept because they can be part of the name ("כביש 6",
 * "AM:PM 24"). */
const LONG_DIGIT_RUNS = /\d{4,}/g;

/** Everything that isn't a letter (any script), a digit, or whitespace. */
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

/**
 * Prefixes Israeli banks and card issuers staple onto the front of a
 * description. Stripping them keeps the merchant itself at the start of the
 * normalized string, which is what makes `starts_with` rules usable.
 */
const BANK_PREFIXES = [
  "עסקה בחו ל",
  "עסקה בחול",
  "חיוב עסקה",
  "תשלום",
  "העברה ל",
  "העברה מ",
  "משיכה",
  "כרטיס אשראי",
  "אשראי",
  "פעולה",
  "זיכוי",
];

/**
 * Collapses a raw bank description to its stable, comparable form.
 *
 * NFKC first so compatibility forms (full-width, ligatures) fold before
 * anything else looks at the string; lowercase for Latin merchant names
 * (a no-op for Hebrew, which is caseless).
 */
export function normalizeDescription(raw: string): string {
  let s = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(HEBREW_MARKS, "")
    .replace(QUOTE_MARKS, "")
    .replace(LONG_DIGIT_RUNS, " ")
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip at most one prefix — descriptions stack at most one of these, and
  // looping risks eating a merchant that legitimately starts with one.
  for (const prefix of BANK_PREFIXES) {
    if (s.startsWith(prefix + " ")) {
      s = s.slice(prefix.length + 1).trim();
      break;
    }
  }

  return s;
}
