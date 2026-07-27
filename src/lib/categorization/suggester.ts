// The model fallback — interface and types only. NO PROVIDER IS IMPLEMENTED.
//
// `getSuggester()` returns null in v1.0, so the categorization pipeline runs
// rules-only. That is not a temporary state to be embarrassed about: "Moni
// must run in rules-only mode with no model configured" is a hard invariant
// (AGENTS.md; docs/security/security-design-principles.md §22), so the null
// path is the *supported* path and the one the tests exercise.
//
// Two things are pinned down here because they are the parts that are easy
// to get wrong later:
//
// 1. **The model cannot invent a category.** `allowedCategoryIds` is the
//    exact set a provider must constrain its output to — as a JSON-schema
//    enum, not a hopeful instruction. Maybe round-trips category *names* and
//    maps them back afterwards, which breaks on duplicate names; we use ids.
//
// 2. **Descriptions are untrusted input.** A merchant string is attacker-
//    influenced text (a payee can be named anything). It travels as a
//    tagged data field and must never be concatenated into the instruction
//    portion of a prompt (docs/design/conventions.md). Model output is
//    untrusted too — hence `status: 'pending'` and a human approval step,
//    never a direct write (there is no AI write path in v1.0).

export interface SuggestInput {
  entryId: string;
  /** Untrusted. Tagged data only — never interpolated into instructions. */
  description: string;
  /** Absolute value as a decimal string; never a JS number. */
  amount: string;
  currency: string;
  /** Narrows which categories are plausible: an inflow can't be an expense. */
  direction: "inflow" | "outflow";
}

export interface SuggestionCategory {
  id: string;
  name: string;
  classification: "income" | "expense" | "transfer";
  parentId: string | null;
}

export interface SuggestRequest {
  inputs: SuggestInput[];
  /** The user's own categories — the only permitted outputs. */
  allowedCategories: SuggestionCategory[];
}

export interface Suggestion {
  entryId: string;
  /** Null is a first-class answer meaning "no confident match". Recording it
   * is what stops a later pass from asking about the same entry again. */
  categoryId: string | null;
  /** 0..1 decimal string. */
  confidence: string | null;
  /** Untrusted generated text; stored encrypted if stored at all. */
  reason: string | null;
}

export interface CategorySuggester {
  /** Identifies the backend in `category_suggestions.model`. */
  readonly model: string;
  suggest(request: SuggestRequest): Promise<Suggestion[]>;
}

/**
 * The configured model backend, or null when none is configured — which is
 * every deployment in v1.0. Callers MUST handle null by doing nothing, not
 * by throwing: a Moni with no model is a fully working Moni.
 */
export function getSuggester(): CategorySuggester | null {
  return null;
}
