// The rule matcher — pure evaluation, no DB, no crypto, no I/O.
//
// Rules cannot be compiled into a SQL WHERE the way Maybe's are, because
// `rule_conditions.value_ct` is encrypted (data-model.md §5). So the domain
// layer decrypts a user's rules ONCE per batch, hands the plaintext here,
// and this module matches in memory — the same decrypt-then-compute
// trade-off already accepted by src/domain/transactions.ts.
//
// Conflict resolution follows Actual Budget rather than Firefly III: there
// is no priority column and no stop-processing flag. Every matching rule is
// scored by how *specific* its conditions are, and the most specific wins,
// with the rule id as a deterministic tiebreak. An exact `equals` beats a
// loose `contains`, which is what users actually expect, and it means the
// learner can write a `contains` rule without ever shadowing a hand-authored
// `equals` one.

import Decimal from "decimal.js";
import { BUILTIN_RULES } from "./builtin-rules";

/** Mirrors `accounts.classification`. */
export type AccountClassification = "asset" | "liability";

export type ConditionType = "description" | "amount" | "account" | "group";

export type Operator = "contains" | "equals" | "starts_with" | "gt" | "lt" | "eq" | "all" | "any";

export interface CompiledCondition {
  conditionType: ConditionType;
  operator: Operator;
  /** Decrypted condition value. Empty for a `group`, whose operands are `children`. */
  value: string;
  /** Only populated for `conditionType: "group"` — the schema's one nesting level. */
  children?: CompiledCondition[];
}

export interface CompiledRule {
  id: string;
  name: string;
  /** The `set_category` action's target. */
  categoryId: string;
  /** ISO date; the rule does not apply to entries dated before it. */
  effectiveDate: string | null;
  /** Implicit AND across the top level. */
  conditions: CompiledCondition[];
}

/** What a rule is matched against. Amounts stay decimal strings throughout. */
export interface Candidate {
  /** Already passed through `normalizeDescription`. */
  description: string;
  /** Signed decimal string in the entry's own currency. */
  amount: string;
  accountId: string;
  /** ISO date, for `effective_date` gating. */
  date: string;
}

export interface Match {
  categoryId: string;
  ruleId: string;
  ruleName: string;
}

/**
 * How specific each operator is. Actual's `OP_SCORES`, reduced to the
 * operators v1.0 actually ships. An exact match is worth an order of
 * magnitude more than a substring match.
 */
const OP_SCORES: Record<Operator, number> = {
  equals: 10,
  eq: 10,
  starts_with: 5,
  gt: 1,
  lt: 1,
  contains: 0,
  // A group scores as its most specific child, resolved in `scoreCondition`.
  all: 0,
  any: 0,
};

function scoreCondition(condition: CompiledCondition): number {
  if (condition.conditionType === "group") {
    const children = condition.children ?? [];
    if (children.length === 0) return 0;
    return Math.max(...children.map(scoreCondition));
  }
  return OP_SCORES[condition.operator] ?? 0;
}

function isExact(condition: CompiledCondition): boolean {
  if (condition.conditionType === "group") {
    return (condition.children ?? []).every(isExact);
  }
  return condition.operator === "equals" || condition.operator === "eq";
}

/**
 * A rule's specificity. Summed condition scores, doubled when *every*
 * condition is an exact match — Actual's rule that a fully-exact rule should
 * outrank a partially-exact one with more conditions.
 */
export function scoreRule(rule: CompiledRule): number {
  if (rule.conditions.length === 0) return 0;
  const base = rule.conditions.reduce((sum, c) => sum + scoreCondition(c), 0);
  return rule.conditions.every(isExact) ? base * 2 : base;
}

function evalCondition(condition: CompiledCondition, candidate: Candidate): boolean {
  switch (condition.conditionType) {
    case "group": {
      const children = condition.children ?? [];
      // An empty group matches nothing rather than everything — a rule with
      // no operands must never sweep the whole ledger.
      if (children.length === 0) return false;
      return condition.operator === "any"
        ? children.some((c) => evalCondition(c, candidate))
        : children.every((c) => evalCondition(c, candidate));
    }
    case "description": {
      const needle = condition.value;
      if (needle === "") return false;
      if (condition.operator === "equals") return candidate.description === needle;
      if (condition.operator === "starts_with") return candidate.description.startsWith(needle);
      return candidate.description.includes(needle);
    }
    case "amount": {
      // Money comparison goes through Decimal, never a JS number
      // (AGENTS.md, "Money is exact-decimal"). A malformed stored value
      // fails the condition rather than throwing mid-batch.
      let left: Decimal;
      let right: Decimal;
      try {
        left = new Decimal(candidate.amount).abs();
        right = new Decimal(condition.value).abs();
      } catch {
        return false;
      }
      if (condition.operator === "gt") return left.greaterThan(right);
      if (condition.operator === "lt") return left.lessThan(right);
      return left.equals(right);
    }
    case "account":
      return candidate.accountId === condition.value;
  }
}

function applies(rule: CompiledRule, candidate: Candidate): boolean {
  // `effective_date` keeps a newly created rule from rewriting history
  // (Maybe's design) — string compare is safe on ISO dates.
  if (rule.effectiveDate && candidate.date < rule.effectiveDate) return false;
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => evalCondition(c, candidate));
}

/**
 * The most specific matching rule, or null. Ties break on rule id so the
 * result is stable across runs and across machines.
 */
export function evaluate(candidate: Candidate, rules: CompiledRule[]): Match | null {
  let best: { rule: CompiledRule; score: number } | null = null;

  for (const rule of rules) {
    if (!applies(rule, candidate)) continue;
    const score = scoreRule(rule);
    if (best === null || score > best.score || (score === best.score && rule.id < best.rule.id)) {
      best = { rule, score };
    }
  }

  if (!best) return null;
  return { categoryId: best.rule.categoryId, ruleId: best.rule.id, ruleName: best.rule.name };
}

export interface BuiltinMatch {
  /** The `BuiltinRule.key` that fired. */
  key: string;
  /** A `key` from default-categories.ts, resolved to a real id by the caller
   * via `categories.builtin_key`. */
  categoryKey: string;
}

/**
 * The built-in keyword table, evaluated against an already-normalized
 * description. Runs only after the user's own rules have failed to match.
 *
 * The longest matching keyword wins, so "רמי לוי תקשורת" (cellular) beats
 * "רמי לוי" (groceries) without the table needing an explicit order; the
 * rule key breaks a length tie so the result is deterministic.
 *
 * `accountClassification` gates the rules that declare `onlyOn`. It is
 * required rather than optional so a new caller cannot silently opt out of
 * the gate and re-introduce the card-settlement double count.
 */
export function evaluateBuiltins(
  normalizedDescription: string,
  accountClassification: AccountClassification,
): BuiltinMatch | null {
  if (normalizedDescription === "") return null;

  let best: { key: string; categoryKey: string; length: number } | null = null;

  for (const rule of BUILTIN_RULES) {
    if (rule.onlyOn && rule.onlyOn !== accountClassification) continue;
    for (const needle of rule.match) {
      if (!normalizedDescription.includes(needle)) continue;
      if (
        best === null ||
        needle.length > best.length ||
        (needle.length === best.length && rule.key < best.key)
      ) {
        best = { key: rule.key, categoryKey: rule.categoryKey, length: needle.length };
      }
    }
  }

  if (!best) return null;
  return { key: best.key, categoryKey: best.categoryKey };
}
