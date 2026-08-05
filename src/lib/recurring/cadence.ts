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
