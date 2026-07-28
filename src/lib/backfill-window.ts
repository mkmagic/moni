/**
 * The backfill window: the start date a user picks when adding a connection,
 * applied to that connection's FIRST sync run only (ADR 0001). Every later
 * run uses the server-computed sync window in `domain/sync-promotion.ts`
 * instead — nothing here touches that rule.
 *
 * Pure `YYYY-MM-DD` string arithmetic, shared by the client picker and the
 * sync route's validation so both agree on where the cap falls. Dates are
 * handled as calendar dates, never as instants: a `Date` here would drag the
 * browser's timezone into a value the server has to re-check.
 */

/** Furthest back a user may reach. Fetch time grows with the window and the
 * scrape child is killed after 5 minutes (ADR 0001). */
export const BACKFILL_MAX_MONTHS = 12;

export interface BackfillPreset {
  /** Stable key for React and for the selected-state comparison. */
  key: string;
  label: string;
  /** Applied to today's date to produce the start date. */
  months?: number;
  days?: number;
}

/** Offered in the picker, shortest first. The 30-day option matches what an
 * unpicked first sync would have fetched before this feature existed. */
export const BACKFILL_PRESETS: readonly BackfillPreset[] = [
  { key: "30d", label: "30 days", days: 30 },
  { key: "3m", label: "3 months", months: 3 },
  { key: "6m", label: "6 months", months: 6 },
  { key: "12m", label: "12 months", months: BACKFILL_MAX_MONTHS },
] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The server's local calendar date. Local, not UTC: the picker's bounds are
 * rendered from this on the server and the route re-checks against it, so the
 * only requirement is that both sides agree — and a UTC date would disagree
 * with the household's own idea of "today" for the first hours of every day.
 */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Day-of-month is clamped to the target month's length, so "3 months back"
 * from the 31st lands on the 28th/30th rather than overflowing into the next
 * month. */
export function subtractMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function subtractDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

export function presetStartDate(preset: BackfillPreset, today: string): string {
  return preset.months !== undefined
    ? subtractMonths(today, preset.months)
    : subtractDays(today, preset.days ?? 0);
}

/** Earliest date the picker offers and the route accepts. */
export function earliestBackfillStart(today: string): string {
  return subtractMonths(today, BACKFILL_MAX_MONTHS);
}

/**
 * Whether an explicit start date is inside the cap. Plain string comparison
 * is correct for zero-padded ISO dates. Enforced client-side by the picker's
 * `min`/`max` and again here at the trust boundary, because a client-side
 * clamp is advisory.
 */
export function isBackfillStartAllowed(startDate: string, today: string): boolean {
  return startDate <= today && startDate >= earliestBackfillStart(today);
}
