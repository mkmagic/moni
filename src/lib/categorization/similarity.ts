// Suggestion scoring — pure evaluation, no DB, no crypto, no I/O.
//
// Fills layer 3 of the pipeline (docs/design/categorization.md §1), which was
// reserved for a model and shipped empty. The signal is entirely local: every
// (match text -> category) pair Moni already knows about — the user's
// categorized entries, their own rules, and the shipped built-in table.
//
// WHY THIS EXISTS AT ALL. The learner (categorization.md §8) only fires when
// 3 of 5 recent entries share an EXACTLY equal match text. Every manual
// categorization below that bar, and every near-miss spelling, is thrown
// away. This module spends that discarded evidence.
//
// WHY IDF RATHER THAN A STOPWORD LIST. Israeli descriptions are
// overwhelmingly BRAND · BRANCH · CITY — "שופרסל דיל רמת גן". The brand
// decides the category and the rest is noise, but *which* words are noise
// depends on the household: "רמת גן" is meaningless for someone who shops
// there daily and highly informative for someone who passed through once.
// Inverse document frequency reads that off the user's own corpus, so there
// is no hand-written Hebrew stopword list to fall out of date.
//
// WHY COSINE RATHER THAN COVERAGE. Dividing shared weight by the query's
// weight alone would let "רמי לוי רמת גן" score well against "שופרסל דיל
// רמת גן" whenever the city tokens happen to be rare — coverage never
// charges for the brand it failed to explain. Cosine normalizes by both
// sides, so an unmatched high-weight token costs the score on whichever side
// it sits. It also tolerates the length mismatch that a Jaccard-style union
// over-punishes: "שופרסל דיל סניף חולון" and "שופרסל דיל אונליין" are the
// same shop, and only one of the two measures says so.

/** Where a labeled example came from. Surfaced to the user as evidence, so a
 * suggestion can always be traced back to something they can go and change. */
export type ExampleSource = "entry" | "rule" | "builtin";

export interface LabeledExample {
  /** Already through `normalizeDescription` — this module never normalizes. */
  matchText: string;
  categoryId: string;
  source: ExampleSource;
}

export interface SuggestionCandidate {
  categoryId: string;
  /** Cosine, 0..1. Reaches 1 only on an identical token set. */
  score: number;
  /** The corpus text that produced this score — the evidence shown to the
   * user. Tier-1 counterparty text: bidi-isolate it when rendering
   * (docs/design/categorization.md §12). */
  matchedText: string;
  matchedSource: ExampleSource;
  /** Past transactions filed under this category with `matchedText`. Zero
   * when the evidence is a rule or a built-in, which have no count. */
  supportCount: number;
}

/**
 * The score a candidate must beat to be shown at all.
 *
 * Deliberately conservative. Accepting a suggestion **locks** the category
 * (categorization.md §4), so a wrong suggestion that gets one-click accepted
 * is sticky and needs a manual clear to undo — whereas showing nothing costs
 * the user only what they already had.
 *
 * 0.5 means "at least half the informational content lines up". Two texts
 * sharing only a city — the worst realistic false positive — sit at or below
 * this even in a degenerate corpus where every token weighs the same, and
 * well below it once a real history makes the city token common.
 *
 * Tune with `npm run suggestions:eval`, which reports coverage and precision
 * across thresholds against real data. Do not move it by intuition.
 */
export const MIN_SUGGESTION_SCORE = 0.5;

/**
 * Tokens are whitespace-separated: `normalizeDescription` has already
 * lowercased, folded punctuation to spaces and dropped long digit runs, so
 * there is nothing left to split on. Single characters are discarded — a lone
 * Hebrew letter is a stranded prefix, never a merchant.
 */
function tokenize(matchText: string): string[] {
  return matchText.split(" ").filter((t) => t.length > 1);
}

/** Which source wins when one text carries labels from several. A rule the
 * user wrote is a stronger statement of intent than a transaction they filed,
 * which in turn beats something Moni shipped. */
const SOURCE_RANK: Record<ExampleSource, number> = { rule: 0, entry: 1, builtin: 2 };

interface Label {
  source: ExampleSource;
  /** Only `entry` examples are counted; rules and built-ins have no count. */
  entryCount: number;
}

interface CorpusText {
  text: string;
  /** Distinct, in first-seen order. */
  tokens: string[];
  /** √Σ idf² over `tokens` — this text's vector length, the right half of
   * every cosine denominator it takes part in. */
  norm: number;
  /** One text can be labeled more than one way: a user who files שופרסל
   * under Groceries and once under Home leaves both here. */
  labels: Map<string, Label>;
}

export interface Corpus {
  texts: CorpusText[];
  idf: Map<string, number>;
  /** The weight of a token nobody has ever seen. Maximal on purpose: an
   * unrecognized token is both maximally informative and, since no example
   * contains it, maximally unexplained — it can only ever cost a score. */
  unseenIdf: number;
  /** token -> indices into `texts`. Without this, scoring one page of
   * uncategorized rows is |rows| × |history| comparisons. */
  postings: Map<string, number[]>;
}

/**
 * Indexes labeled examples for scoring.
 *
 * Document frequency is counted over **distinct match texts**, not over
 * examples. Otherwise a merchant the household visits weekly would drive its
 * own brand token's frequency up until the token looked like noise — exactly
 * inverting the signal.
 */
export function buildCorpus(examples: Iterable<LabeledExample>): Corpus {
  const byText = new Map<string, { tokens: string[]; labels: Map<string, Label> }>();

  for (const example of examples) {
    const tokens = [...new Set(tokenize(example.matchText))];
    if (tokens.length === 0) continue;

    let entry = byText.get(example.matchText);
    if (!entry) {
      entry = { tokens, labels: new Map() };
      byText.set(example.matchText, entry);
    }

    const existing = entry.labels.get(example.categoryId);
    const entryCount = (existing?.entryCount ?? 0) + (example.source === "entry" ? 1 : 0);
    const source =
      existing && SOURCE_RANK[existing.source] <= SOURCE_RANK[example.source]
        ? existing.source
        : example.source;
    entry.labels.set(example.categoryId, { source, entryCount });
  }

  const documentFrequency = new Map<string, number>();
  for (const { tokens } of byText.values()) {
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const total = byText.size;
  const idf = new Map<string, number>();
  for (const [token, df] of documentFrequency) {
    idf.set(token, Math.log(1 + total / df));
  }
  const unseenIdf = Math.log(1 + total);

  const texts: CorpusText[] = [];
  const postings = new Map<string, number[]>();
  for (const [text, { tokens, labels }] of byText) {
    const index = texts.length;
    let sumOfSquares = 0;
    for (const token of tokens) {
      const weight = idf.get(token) ?? unseenIdf;
      sumOfSquares += weight * weight;
      const list = postings.get(token);
      if (list) list.push(index);
      else postings.set(token, [index]);
    }
    texts.push({ text, tokens, norm: Math.sqrt(sumOfSquares), labels });
  }

  return { texts, idf, unseenIdf, postings };
}

/**
 * Every category the corpus can argue for, best first.
 *
 * Returns candidates at *any* score — applying `MIN_SUGGESTION_SCORE` is the
 * caller's job, because the caller is also the only one that knows which
 * pairings the user has rejected, and a rejected top candidate must fall
 * through to the next one that still clears the bar.
 *
 * Ordering is fully deterministic (score, then support, then category id), so
 * the same history produces the same suggestion on every render and on every
 * machine.
 */
export function suggest(matchText: string, corpus: Corpus): SuggestionCandidate[] {
  const queryTokens = [...new Set(tokenize(matchText))];
  if (queryTokens.length === 0 || corpus.texts.length === 0) return [];

  const weightOf = (token: string) => corpus.idf.get(token) ?? corpus.unseenIdf;

  const queryNorm = Math.sqrt(queryTokens.reduce((sum, token) => sum + weightOf(token) ** 2, 0));
  if (queryNorm === 0) return [];

  // The dot product per candidate text, accumulated one query token at a time
  // through the postings list — only texts sharing at least one token are
  // ever touched. Both vectors are binary in term frequency (a merchant name
  // does not repeat a word meaningfully), so a shared token contributes idf².
  const dot = new Map<number, number>();
  for (const token of queryTokens) {
    const list = corpus.postings.get(token);
    if (!list) continue;
    const contribution = weightOf(token) ** 2;
    for (const index of list) {
      dot.set(index, (dot.get(index) ?? 0) + contribution);
    }
  }

  const best = new Map<string, SuggestionCandidate>();
  for (const [index, dotProduct] of dot) {
    const candidate = corpus.texts[index];
    if (candidate.norm === 0) continue;
    const score = dotProduct / (queryNorm * candidate.norm);

    for (const [categoryId, label] of candidate.labels) {
      const current = best.get(categoryId);
      if (current && current.score >= score) continue;
      best.set(categoryId, {
        categoryId,
        score,
        matchedText: candidate.text,
        matchedSource: label.source,
        supportCount: label.entryCount,
      });
    }
  }

  return [...best.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.supportCount - a.supportCount ||
      (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0),
  );
}
