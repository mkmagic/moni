// src/lib/categorization/similarity.ts — the pure suggestion scorer.
//
// The threshold itself is NOT asserted here on purpose: it is tuned against
// real data by `npm run suggestions:eval`, and a fixture written alongside
// the algorithm would only prove the scorer agrees with itself. What these
// cover is the ordering the algorithm promises — that the brand decides, that
// a shared neighbourhood does not, and that the output is deterministic.
import { describe, expect, it } from "vitest";
import {
  buildCorpus,
  suggest,
  MIN_SUGGESTION_SCORE,
  type LabeledExample,
} from "@/lib/categorization/similarity";

const GROCERIES = "11111111-1111-1111-1111-111111111111";
const RESTAURANTS = "22222222-2222-2222-2222-222222222222";
const TRANSPORT = "33333333-3333-3333-3333-333333333333";

function entry(matchText: string, categoryId: string): LabeledExample {
  return { matchText, categoryId, source: "entry" };
}

describe("buildCorpus / suggest", () => {
  it("an identical token set scores 1", () => {
    const corpus = buildCorpus([entry("שופרסל דיל", GROCERIES)]);
    const [top] = suggest("שופרסל דיל", corpus);
    expect(top.categoryId).toBe(GROCERIES);
    expect(top.score).toBeCloseTo(1);
  });

  it("token order is irrelevant — substring matching's blind spot", () => {
    const corpus = buildCorpus([entry("רמי לוי", GROCERIES)]);
    const [top] = suggest("לוי רמי", corpus);
    expect(top.score).toBeCloseTo(1);
  });

  it("the rare brand outranks the shared neighbourhood", () => {
    // "רמת גן" appears in every example, so IDF flattens it to nothing;
    // the brand appears once and carries the decision.
    const corpus = buildCorpus([
      entry("שופרסל דיל רמת גן", GROCERIES),
      entry("ארומה רמת גן", RESTAURANTS),
      entry("סונול רמת גן", TRANSPORT),
    ]);

    const ranked = suggest("שופרסל אקספרס רמת גן", corpus);
    expect(ranked[0].categoryId).toBe(GROCERIES);
    // And the merchants that merely share the city fall under the bar.
    expect(ranked.slice(1).every((c) => c.score < MIN_SUGGESTION_SCORE)).toBe(true);
  });

  it("a text labeled two ways yields both categories, best first", () => {
    const corpus = buildCorpus([
      entry("שופרסל דיל", GROCERIES),
      entry("שופרסל דיל", GROCERIES),
      entry("שופרסל דיל אונליין", RESTAURANTS),
    ]);
    const ranked = suggest("שופרסל דיל", corpus);
    expect(ranked.map((c) => c.categoryId)).toEqual([GROCERIES, RESTAURANTS]);
    expect(ranked[0].supportCount).toBe(2);
  });

  it("a rule outranks an entry as the evidence for the same text", () => {
    const corpus = buildCorpus([
      entry("שופרסל דיל", GROCERIES),
      { matchText: "שופרסל דיל", categoryId: GROCERIES, source: "rule" },
    ]);
    expect(suggest("שופרסל דיל", corpus)[0].matchedSource).toBe("rule");
  });

  it("only entry examples are counted as support", () => {
    const corpus = buildCorpus([
      { matchText: "שופרסל דיל", categoryId: GROCERIES, source: "builtin" },
    ]);
    const [top] = suggest("שופרסל דיל", corpus);
    expect(top.matchedSource).toBe("builtin");
    expect(top.supportCount).toBe(0);
  });

  it("single characters are not tokens", () => {
    // "ב" is a stranded Hebrew prefix, not a merchant; sharing it must not
    // make two unrelated descriptions look alike.
    const corpus = buildCorpus([entry("ב ארומה", RESTAURANTS)]);
    expect(suggest("ב סונול", corpus)).toEqual([]);
  });

  it("an empty query, an empty corpus, and an all-punctuation query yield nothing", () => {
    const corpus = buildCorpus([entry("שופרסל דיל", GROCERIES)]);
    expect(suggest("", corpus)).toEqual([]);
    expect(suggest("א", corpus)).toEqual([]);
    expect(suggest("שופרסל", buildCorpus([]))).toEqual([]);
  });

  it("ranking is deterministic when scores tie", () => {
    // Two categories, equally good, distinguished only by id — the tiebreak
    // has to be stable or the same page renders differently twice.
    const corpus = buildCorpus([entry("מרקט", RESTAURANTS), entry("מרקט", GROCERIES)]);
    const ranked = suggest("מרקט", corpus).map((c) => c.categoryId);
    expect(ranked).toEqual([GROCERIES, RESTAURANTS]);
    expect(suggest("מרקט", corpus).map((c) => c.categoryId)).toEqual(ranked);
  });

  it("a merchant visited weekly does not become its own noise", () => {
    // Document frequency counts distinct texts, not examples. Repeating one
    // text 50 times must not make its brand token look common.
    const repeated: LabeledExample[] = Array.from({ length: 50 }, () =>
      entry("שופרסל דיל רמת גן", GROCERIES),
    );
    const corpus = buildCorpus([...repeated, entry("ארומה רמת גן", RESTAURANTS)]);
    const [top] = suggest("שופרסל אקספרס רמת גן", corpus);
    expect(top.categoryId).toBe(GROCERIES);
    expect(top.score).toBeGreaterThan(MIN_SUGGESTION_SCORE);
  });
});
