// How often a merchant charges, read from the gaps between its transaction
// dates. Pure: no DB, no crypto, no I/O — the dates are plaintext structural
// columns, so nothing here needs decrypting.
//
// Deliberately not stored (docs/adr/0006-*). The user may override the answer
// on the merchant, which is the escape hatch for the case no amount of
// cleverness fixes: an annual subscription with one payment so far has no gap
// to read at all.

/**
 * The cadences a user may choose as an override.
 *
 * One list, consulted by the API's validator, the picker's options and the
 * labels below — adding a cadence should be one edit, not four. `irregular`
 * and `unknown` are deliberately absent: they are outcomes of reading the
 * dates, never things a person asks for.
 */
export const SETTABLE_CADENCES = ["monthly", "bi-monthly", "quarterly", "yearly"] as const;
export type SettableCadence = (typeof SETTABLE_CADENCES)[number];

/** The vocabulary in CONTEXT.md — `irregular` is a real answer, not a failure. */
export type Cadence = SettableCadence | "irregular" | "unknown";

/** Display text for every cadence, including the two that can't be chosen. */
export const CADENCE_LABELS: Record<Cadence, string> = {
  monthly: "Monthly",
  "bi-monthly": "Every 2 months",
  quarterly: "Quarterly",
  yearly: "Yearly",
  irregular: "Irregular",
  unknown: "Not enough history",
};

/**
 * How many months one payment at this cadence covers — the divisor that
 * turns "what they charge" into "what it costs per month", which is the only
 * form in which a quarterly bill and a monthly one can be added together or
 * budgeted against.
 *
 * `irregular` and `unknown` are absent because they have no period: a caller
 * that needs a monthly figure for those has to derive one from the observed
 * span and say that it is an estimate.
 */
export const CADENCE_MONTHS: Record<SettableCadence, number> = {
  monthly: 1,
  "bi-monthly": 2,
  quarterly: 3,
  yearly: 12,
};

/** Narrows a stored override string, which the database types only as `text`. */
export function asSettableCadence(value: string | null): SettableCadence | null {
  return value != null && (SETTABLE_CADENCES as readonly string[]).includes(value)
    ? (value as SettableCadence)
    : null;
}

/**
 * Day-count windows for each cadence. Wide enough to absorb month lengths
 * (28-31), weekend drift, and a biller that charges "the first working day".
 * A gap in none of these windows votes for nothing.
 */
const BANDS: { cadence: Exclude<Cadence, "irregular" | "unknown">; min: number; max: number }[] = [
  { cadence: "monthly", min: 24, max: 38 },
  { cadence: "bi-monthly", min: 52, max: 70 },
  { cadence: "quarterly", min: 80, max: 100 },
  { cadence: "yearly", min: 330, max: 400 },
];

/**
 * Share of gaps that must agree before we call it a cadence. Below this the
 * answer is `irregular`.
 *
 * 0.6 is what lets a monthly series survive one missed month (two agreeing
 * gaps out of three) while refusing a series that is half monthly and half
 * noise (one out of two).
 */
const AGREEMENT = 0.6;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function bandOf(gapDays: number): Cadence | null {
  return BANDS.find((b) => gapDays >= b.min && gapDays <= b.max)?.cadence ?? null;
}

/**
 * Reads the cadence of a series of transaction dates ("YYYY-MM-DD").
 *
 * Classifies each consecutive gap into a band and takes the most popular one,
 * rather than the median gap: a median is dragged by a single 200-day hole
 * into a band the payee never charged at, whereas a vote lets the outlier
 * simply lose. `unknown` below two dates, since one date has no gap.
 */
export function deriveCadence(dates: string[]): Cadence {
  if (dates.length < 2) return "unknown";

  const sorted = [...dates].sort();
  const votes = new Map<Cadence, number>();
  let gapCount = 0;

  for (let i = 1; i < sorted.length; i++) {
    const gapDays = Math.round(
      (Date.parse(`${sorted[i]}T00:00:00Z`) - Date.parse(`${sorted[i - 1]}T00:00:00Z`)) /
        MS_PER_DAY,
    );
    gapCount++;
    const band = bandOf(gapDays);
    if (band) votes.set(band, (votes.get(band) ?? 0) + 1);
  }

  let best: Cadence = "irregular";
  let bestVotes = 0;
  for (const [cadence, count] of votes) {
    if (count > bestVotes) {
      best = cadence;
      bestVotes = count;
    }
  }

  return bestVotes / gapCount >= AGREEMENT ? best : "irregular";
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * Days without a payment after which a payee counts as stopped.
 *
 * Monthly through quarterly: two expected payments missed, past the band's
 * jitter (band max + one period) — one missed month is a skipped charge, not
 * a cancellation (see AGREEMENT). Yearly: one missed renewal (the band max) —
 * waiting for a second would take another year.
 */
const STOPPED_AFTER_DAYS: Record<SettableCadence, number> = {
  monthly: 68,
  "bi-monthly": 131,
  quarterly: 191,
  yearly: 400,
};

/** A stopped payee is hidden once its last payment is this old. */
export const HIDE_STOPPED_AFTER_DAYS = 180;

/**
 * True when a payee has gone quiet for longer than its cadence allows.
 *
 * `asOf` is the date the data runs to, not the wall clock: a user who hasn't
 * synced for three months has not cancelled everything.
 *
 * `unknown` (one payment) is judged as monthly — the common case in a
 * recurring category; an annual payee with one payment so far needs its
 * cadence set by hand, which is the existing escape hatch. `irregular` has no
 * period, so it is judged against its own history: twice its longest gap,
 * never less than the monthly allowance.
 */
export function isStopped(cadence: Cadence, dates: string[], asOf: string): boolean {
  const sorted = [...dates].sort();
  const since = daysBetween(sorted[sorted.length - 1], asOf);
  if (cadence === "unknown") return since > STOPPED_AFTER_DAYS.monthly;
  if (cadence !== "irregular") return since > STOPPED_AFTER_DAYS[cadence];
  let longest = 0;
  for (let i = 1; i < sorted.length; i++) {
    longest = Math.max(longest, daysBetween(sorted[i - 1], sorted[i]));
  }
  return since > Math.max(STOPPED_AFTER_DAYS.monthly, 2 * longest);
}

/** Days since the last of `dates`, as of `asOf`. */
export function daysSinceLast(dates: string[], asOf: string): number {
  return daysBetween([...dates].sort()[dates.length - 1], asOf);
}

/**
 * The cadence of several payees read as one bill, or null when they aren't one.
 *
 * Substitution — the same need paid from different places (medication bought
 * at the pharmacy one month and reimbursed over Bit the next, or a service
 * moved from one provider to another) — leaves a signature: the merged dates
 * keep a cadence, and no two payments land inside one period. Two concurrent
 * subscriptions fail the second test, since their charges interleave.
 */
export function pooledCadence(dates: string[]): SettableCadence | null {
  const cadence = deriveCadence(dates);
  if (cadence === "irregular" || cadence === "unknown") return null;
  const min = BANDS.find((b) => b.cadence === cadence)!.min;
  const sorted = [...dates].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (daysBetween(sorted[i - 1], sorted[i]) < min) return null;
  }
  return cadence;
}

/**
 * Groups payees that read as one bill (`pooledCadence`), greedily, oldest
 * first. Returns groups of ids; a payee that pools with nothing is a group of
 * one. Input order is irrelevant.
 */
export function poolPayees(series: { id: string; dates: string[] }[]): string[][] {
  const byFirst = [...series].sort((a, b) =>
    [...a.dates].sort()[0].localeCompare([...b.dates].sort()[0]),
  );
  const pools: { ids: string[]; dates: string[] }[] = [];
  for (const s of byFirst) {
    const home = pools.find((p) => pooledCadence([...p.dates, ...s.dates]) !== null);
    if (home) {
      home.ids.push(s.id);
      home.dates.push(...s.dates);
    } else {
      pools.push({ ids: [s.id], dates: [...s.dates] });
    }
  }
  return pools.map((p) => p.ids);
}
