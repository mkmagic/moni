// Measures the suggestion engine against your own data, and hands you the
// threshold. Run it before changing MIN_SUGGESTION_SCORE — that number cannot
// be reasoned into existence, and a fixture written alongside the algorithm
// would only prove the scorer agrees with itself.
//
// METHOD. Hold out a random fifth of your categorized transactions, build the
// corpus from the rest (plus your rules and the shipped built-in table, which
// always stay in), then ask the engine to re-derive the category you actually
// chose. Two numbers per threshold:
//
//   coverage  — share of held-out transactions that got any suggestion
//   precision — share of those suggestions that matched your own choice
//
// Precision is the one with teeth: accepting a suggestion LOCKS the category
// (docs/design/categorization.md §4), so a wrong suggestion that gets
// one-click accepted is sticky. Coverage only measures how often the feature
// speaks at all.
//
// The "unseen" column is the honest one. Held-out transactions whose match
// text still appears verbatim in the training set are trivially correct —
// that is real behaviour, but it is the learner's job, not similarity's.
// "Unseen" restricts to texts the corpus has never observed, which is where
// this engine either earns its keep or does not.
//
// Aggregates only, never the transactions themselves: descriptions are Tier-1
// (security-design-principles.md §13) and a terminal scrollback is not a
// place to put them.
//
// Usage: MONI_EVAL_EMAIL=you@example.com MONI_EVAL_PASSWORD=... npm run suggestions:eval
import "dotenv/config";
import { authenticate } from "@/domain/auth";
import { getSession } from "@/lib/auth/session-store";
import { loadSuggestionExamples } from "@/domain/categorization";
import {
  buildCorpus,
  suggest,
  MIN_SUGGESTION_SCORE,
  type LabeledExample,
} from "@/lib/categorization/similarity";

const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const HOLDOUT_SHARE = 0.2;

/** Seeded so two runs over unchanged data report the same numbers — a
 * threshold chosen from a number that moves is not chosen at all. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface Tally {
  suggested: number;
  correct: number;
  unseenSuggested: number;
  unseenCorrect: number;
}

async function main(): Promise<void> {
  const email = process.env.MONI_EVAL_EMAIL;
  const password = process.env.MONI_EVAL_PASSWORD;
  if (!email || !password) {
    throw new Error("Set MONI_EVAL_EMAIL and MONI_EVAL_PASSWORD");
  }

  const secret = Buffer.from(password, "utf8");
  const sessionId = await authenticate(email, secret);
  secret.fill(0);
  if (!sessionId) throw new Error("Authentication failed");
  const session = getSession(sessionId);
  if (!session) throw new Error("Session expired immediately — should not happen");

  const examples = await loadSuggestionExamples(session);
  const fromEntries = examples.filter((e) => e.source === "entry");
  const fixed = examples.filter((e) => e.source !== "entry");

  if (fromEntries.length < 20) {
    console.log(
      `Only ${fromEntries.length} categorized transactions — too few to measure. ` +
        `Categorize more, then re-run.`,
    );
    return;
  }

  const shuffled = seededShuffle(fromEntries, 20260728);
  const holdoutSize = Math.max(1, Math.round(shuffled.length * HOLDOUT_SHARE));
  const holdout = shuffled.slice(0, holdoutSize);
  const training: LabeledExample[] = shuffled.slice(holdoutSize);

  const corpus = buildCorpus([...training, ...fixed]);
  const trainingTexts = new Set([...training, ...fixed].map((e) => e.matchText));

  const tallies = new Map<number, Tally>(
    THRESHOLDS.map((t) => [t, { suggested: 0, correct: 0, unseenSuggested: 0, unseenCorrect: 0 }]),
  );
  let unseenTotal = 0;

  for (const held of holdout) {
    const unseen = !trainingTexts.has(held.matchText);
    if (unseen) unseenTotal += 1;

    const ranked = suggest(held.matchText, corpus);
    const top = ranked[0];
    if (!top) continue;

    for (const threshold of THRESHOLDS) {
      if (top.score < threshold) continue;
      const tally = tallies.get(threshold)!;
      tally.suggested += 1;
      if (top.categoryId === held.categoryId) tally.correct += 1;
      if (unseen) {
        tally.unseenSuggested += 1;
        if (top.categoryId === held.categoryId) tally.unseenCorrect += 1;
      }
    }
  }

  const pct = (n: number, d: number) => (d === 0 ? "    —" : `${((100 * n) / d).toFixed(1)}%`);

  console.log(
    `\nCorpus: ${training.length} training transactions, ${fixed.length} rule/built-in examples`,
  );
  console.log(`Held out: ${holdout.length} transactions (${unseenTotal} with an unseen text)\n`);
  console.log("  threshold   coverage  precision  |  unseen cov.  unseen prec.");
  console.log("  ─────────────────────────────────┼──────────────────────────");
  for (const threshold of THRESHOLDS) {
    const t = tallies.get(threshold)!;
    const marker = threshold === MIN_SUGGESTION_SCORE ? " <- current" : "";
    console.log(
      `      ${threshold.toFixed(2)}     ${pct(t.suggested, holdout.length).padStart(7)}    ` +
        `${pct(t.correct, t.suggested).padStart(7)}  |     ` +
        `${pct(t.unseenSuggested, unseenTotal).padStart(7)}       ` +
        `${pct(t.unseenCorrect, t.unseenSuggested).padStart(7)}${marker}`,
    );
  }
  console.log("\nPick the lowest threshold whose precision you would accept on a locking write.\n");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
