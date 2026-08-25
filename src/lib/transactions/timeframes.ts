// Timeframe presets for the transactions filter (issue #107). Pure
// `YYYY-MM-DD` string math, mirroring `src/lib/backfill-window.ts`, so the
// client picker and the server read agree on where a range falls.
//
// "today" is the Asia/Jerusalem calendar date, computed on the SERVER and
// passed down — never derived here. Deriving it in the browser would make the
// rendered range depend on the client clock and timezone (a hydration
// mismatch), the same rule `BackfillWindowPicker` follows.
//
// Week starts Sunday, matching `israelWeekStart` in
// `src/domain/investment-valuation.ts`. That helper lives in the domain layer
// (which imports the db), so the tiny pure part is replicated here rather than
// imported — a client import of the domain module would pull `pg` into the
// browser bundle.
import { subtractMonths } from "@/lib/backfill-window";

export interface TimeframePreset {
  /** Stable key for React and for the URL, never shown. */
  key: string;
  label: string;
  /** The `{ from, to }` this preset sets, given the server's "today". */
  range(today: string): { from: string; to: string };
}

/** Sunday-anchored start of the week containing `iso`. */
export function startOfWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/** First day of the month containing `iso`. */
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export const TIMEFRAME_PRESETS: readonly TimeframePreset[] = [
  { key: "week", label: "This Week", range: (t) => ({ from: startOfWeek(t), to: t }) },
  { key: "month", label: "This Month", range: (t) => ({ from: startOfMonth(t), to: t }) },
  { key: "3m", label: "Last 3 Months", range: (t) => ({ from: subtractMonths(t, 3), to: t }) },
] as const;

/**
 * The preset whose range exactly matches the current `from`/`to`, for
 * derived pill selection — `undefined` for a custom or empty range. Mirrors
 * `presetStartDate`'s selection idiom in `backfill-window-picker.tsx`.
 */
export function matchingTimeframe(from: string, to: string, today: string): string | undefined {
  if (!from || !to) return undefined;
  return TIMEFRAME_PRESETS.find((p) => {
    const r = p.range(today);
    return r.from === from && r.to === to;
  })?.key;
}
