// How often a merchant charges, read from the gaps between its transaction
// dates. Pure: no DB, no crypto, no I/O — the dates are plaintext structural
// columns, so nothing here needs decrypting.
//
// Deliberately not stored (docs/adr/0006-*). The user may override the answer
// on the merchant, which is the escape hatch for the case no amount of
// cleverness fixes: an annual subscription with one payment so far has no gap
// to read at all.

/** The vocabulary in CONTEXT.md — `irregular` is a real answer, not a failure. */
export type Cadence = "monthly" | "bi-monthly" | "quarterly" | "yearly" | "irregular" | "unknown";

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
