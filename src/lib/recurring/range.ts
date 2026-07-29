// The tab-wide range control's vocabulary.
//
// Lives in `lib` rather than `@/domain/recurring` so the client-side toolbar
// can import the labels without dragging the domain layer — and `pg` — into
// the browser bundle. A type would be safe to import from the domain (types
// are erased); these are runtime values, and they are not. See
// `src/lib/transactions/filters.ts`, which exists for the same reason.

/** Drives category totals only — never a row's headline (docs/adr/0006-*). */
export type RecurringRange = "3m" | "6m" | "1y" | "all";

export const RECURRING_RANGES: RecurringRange[] = ["3m", "6m", "1y", "all"];

export const RANGE_LABELS: Record<RecurringRange, string> = {
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
  all: "All time",
};

/** How far back each range reaches, in months. `all` has no bound. */
export const RANGE_MONTHS: Record<Exclude<RecurringRange, "all">, number> = {
  "3m": 3,
  "6m": 6,
  "1y": 12,
};

export function isRecurringRange(value: string | undefined): value is RecurringRange {
  return value != null && (RECURRING_RANGES as string[]).includes(value);
}

/** How many payments an expanded graph shows. Counted in payments, not months,
 * so a yearly renewal shows years and a monthly one shows months. */
export const PAYMENT_WINDOWS = [3, 6, 12] as const;
export type PaymentWindow = (typeof PAYMENT_WINDOWS)[number] | "all";
