// The ONLY place in the codebase allowed to touch a money-bearing JS number
// (docs plan §"Money at the scraper boundary"). israeli-bank-scrapers
// returns `originalAmount`/`chargedAmount` as JS `number` — the invariant
// says never a float "not even transiently", but the float already exists
// inside the library's return value and cannot be avoided at the source.
// Confine it to exactly this one function, called immediately after the
// scraper output has passed Zod validation
// (src/lib/connectors/scraper-output.schema.ts). Everything downstream is a
// Money-shaped decimal string.
import Decimal from "decimal.js";

export function decimalStringFromScraperNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Non-finite amount from scraper: ${n}`);
  }
  // String(n) first: V8 emits the shortest round-tripping decimal
  // representation, so the intended decimal is recovered losslessly for any
  // realistic monetary amount.
  return new Decimal(String(n)).toString();
}
