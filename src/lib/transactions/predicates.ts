// Shared decrypt-time predicates for the transactions filter (issue #107).
//
// Income/Payment and expense-size can only be judged after decryption (the
// amount is ciphertext at rest), so they run in JS. These predicates are the
// single definition of both, reused by the client table (`applyTableControls`)
// and the server read (`listEntries` when searching the whole history), so the
// two paths can never disagree on what "Payment" or "Large" means.
//
// Only *types* are imported from `@/domain` — importing a runtime value would
// drag `src/db/client.ts`, and therefore `pg`, into the browser bundle
// (see `src/lib/transactions/filters.ts`).
import Decimal from "decimal.js";
import type { EntryView } from "@/domain/transactions";

export type Direction = "all" | "income" | "payment";
export type SizeKey = "all" | "s" | "m" | "l";

export interface SizeBand {
  key: Exclude<SizeKey, "all">;
  label: string;
  /** The threshold spelled out for the pill's title, in the reporting currency. */
  hint: string;
  /** Magnitude predicate. The bands are disjoint and gapless:
   * S = [0, 100), M = [100, 1000], L = (1000, ∞). */
  test(magnitude: Decimal): boolean;
}

/** ₪ bands agreed with the owner (#107). Applied to the reporting-currency
 * magnitude; pending-FX rows are excluded (see `matchesSize`). */
export const SIZE_BANDS: readonly SizeBand[] = [
  { key: "s", label: "S", hint: "under ₪100", test: (m) => m.lessThan(100) },
  {
    key: "m",
    label: "M",
    hint: "₪100–1,000",
    test: (m) => m.greaterThanOrEqualTo(100) && m.lessThanOrEqualTo(1000),
  },
  { key: "l", label: "L", hint: "over ₪1,000", test: (m) => m.greaterThan(1000) },
] as const;

/**
 * Whether an entry falls in an expense-size band. Magnitude-based, so sign is
 * ignored. Pending-FX rows never match: their `amount` is the entered leg in
 * its own currency, not a reporting-currency figure, so a ₪ threshold would be
 * comparing two currencies as if they were one.
 */
export function matchesSize(entry: EntryView, size: SizeKey): boolean {
  if (size === "all") return true;
  if (entry.fxPending) return false;
  const band = SIZE_BANDS.find((b) => b.key === size);
  if (!band) return true;
  return band.test(new Decimal(entry.amount.amount).abs());
}

/**
 * Whether an entry is income (an inflow) or a payment (an outflow), using
 * Moni's single flow definition: a transfer or an excluded row is money moved
 * rather than earned or spent (`src/domain/flows.ts`), so it is neither — the
 * load-bearing case is a credit-card settlement, whose sign would otherwise
 * read as a huge payment. A zero-amount row matches neither.
 */
export function matchesDirection(entry: EntryView, direction: Direction): boolean {
  if (direction === "all") return true;
  if (entry.excluded || entry.isTransfer) return false;
  const sign = new Decimal(entry.amount.amount).comparedTo(0);
  return direction === "income" ? sign > 0 : sign < 0;
}
