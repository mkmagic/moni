// Categorization — the deterministic-first pipeline that assigns a category
// to a ledger entry, and the user-facing overrides and rules that feed it
// (docs/design/categorization.md).
//
// Resolution order, first layer to produce a category wins:
//   0. attribute lock  — a human already set it; skip the entry entirely
//   1. user rules      — including learned ones, ranked by specificity
//   2. built-in rules  — the shipped Israeli keyword table (code constants)
//   3. suggestion      — derived from everything Moni already knows about
//                        this text; proposed to a person, never written
//                        (there is no AI write path — AGENTS.md)
//
// There is deliberately no separate "learned from history" layer: learning
// writes a real user rule, so it resolves in layer 1. One mechanism, and one
// the user can see and delete.
//
// Why matching happens in memory rather than in SQL: `rule_conditions
// .value_ct` is encrypted, so conditions can't become a WHERE clause. Rules
// are decrypted ONCE per batch into a compiled form (`loadContext`) and the
// batch is evaluated against it — the same decrypt-then-compute trade-off
// already accepted by transactions.ts and dashboard.ts.
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { withUser } from "@/db/client";
import {
  accounts,
  categories,
  categoryRejections,
  entries,
  entryFieldChangelog,
  merchantLookups,
  ruleActions,
  ruleConditions,
  rules,
  users,
} from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import { normalizeDescription } from "@/lib/categorization/normalize";
import {
  blocksEgress,
  classifyBatch,
  getLlmConfig,
  guarded,
  PROMPT_VERSION,
  UNKNOWN,
} from "@/lib/categorization/external";
import {
  evaluate,
  evaluateBuiltins,
  type Candidate,
  type CompiledCondition,
  type CompiledRule,
  type ConditionType,
  type Operator,
} from "@/lib/categorization/matcher";
import {
  flattenDefaultCategories,
  isCategoryColor,
  type CategoryClassification,
} from "@/lib/categorization/default-categories";
import { isCategoryIcon } from "@/lib/categorization/category-icons";
import { BUILTIN_RULES } from "@/lib/categorization/builtin-rules";
import {
  buildCorpus,
  suggest,
  MIN_SUGGESTION_SCORE,
  type Corpus,
  type ExampleSource,
  type LabeledExample,
} from "@/lib/categorization/similarity";
import { decText, encText } from "./fields";
import { isFieldLocked, withFieldLocked, withFieldUnlocked } from "./attribute-locks";

type Tx = Parameters<Parameters<typeof withUser>[1]>[0];

/** `rules.resource_type` for everything in this module. */
const RESOURCE_TYPE = "entry";

/** How far back the learner looks, and how many recent examples it weighs —
 * Actual Budget's thresholds. Older history is deliberately forgotten. */
const LEARN_WINDOW_DAYS = 180;
const LEARN_SAMPLE_SIZE = 5;
const LEARN_AGREEMENT_THRESHOLD = 3;

/** How many recent categorized entries the learner decrypts to find its
 * sample. Descriptions are encrypted, so the same-merchant filter can't run
 * in SQL; this bounds the decrypt set at family scale. */
const LEARN_SCAN_LIMIT = 500;

export class CategoryNotFoundError extends Error {
  constructor(categoryId: string) {
    super(`No category ${categoryId}`);
    this.name = "CategoryNotFoundError";
  }
}

export class InvalidCategoryNestingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCategoryNestingError";
  }
}

/** A category from the shipped set cannot be deleted: `categories:sync` would
 * put it straight back on the next upgrade, so the delete would look like it
 * worked and then quietly undo itself. Renaming and re-iconing are the
 * supported way to make a shipped category your own — `builtin_key` is the
 * identity, so a rename survives the sync. */
export class BuiltinCategoryError extends Error {
  constructor() {
    super("A built-in category can be renamed but not deleted");
    this.name = "BuiltinCategoryError";
  }
}

export class CategoryHasChildrenError extends Error {
  constructor(count: number) {
    super(`Category still has ${count} subcategor${count === 1 ? "y" : "ies"}`);
    this.name = "CategoryHasChildrenError";
  }
}

export class SmartCategorizeDisabledError extends Error {
  constructor() {
    super("Smart categorization is disabled in user profile");
    this.name = "SmartCategorizeDisabledError";
  }
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("No API key configured for smart categorization");
    this.name = "LlmNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Gives a user the shipped category tree. Runs inside the caller's
 * transaction (registration's), because a user without categories can't be
 * categorized and the two must land together or not at all.
 *
 * Categories are plaintext Tier-2 labels (data-model.md §5), so this needs no
 * data key — which is what lets it run at signup.
 *
 * **Idempotent, and that is load-bearing.** Adding a category to the shipped
 * set would otherwise reach only users who sign up afterwards, leaving every
 * existing account with a built-in rule pointing at a key it doesn't have.
 * Re-running this is the upgrade path (`npm run categories:sync`). A row the
 * user has renamed keeps its name — `builtin_key` is the identity, not the
 * name, so conflicts are skipped rather than overwritten.
 *
 * Returns how many categories it added.
 */
export async function seedDefaultCategories(tx: Tx, ownerId: string): Promise<number> {
  const existing = await tx
    .select({ id: categories.id, builtinKey: categories.builtinKey })
    .from(categories);
  const idByKey = new Map<string, string>();
  for (const c of existing) {
    if (c.builtinKey) idByKey.set(c.builtinKey, c.id);
  }

  let added = 0;
  // flattenDefaultCategories() yields parents first, so a child's parent_id
  // always resolves — including when only the child is missing.
  for (const c of flattenDefaultCategories()) {
    if (idByKey.has(c.key)) continue;
    const id = randomUUID();
    idByKey.set(c.key, id);
    await tx.insert(categories).values({
      id,
      ownerId,
      name: c.name,
      parentId: c.parentKey ? (idByKey.get(c.parentKey) ?? null) : null,
      classification: c.classification,
      color: c.color,
      icon: c.icon,
      builtinKey: c.key,
    });
    added += 1;
  }
  return added;
}

/**
 * Brings one user's category tree up to date with the shipped set. Needs no
 * data key — categories are plaintext — which is what lets an upgrade script
 * run it for every user without anyone's password.
 */
export async function syncDefaultCategories(ownerId: string): Promise<number> {
  return withUser(ownerId, (tx) => seedDefaultCategories(tx, ownerId));
}

// ---------------------------------------------------------------------------
// Compiling the ruleset
// ---------------------------------------------------------------------------

interface CategorizationContext {
  /** Active user rules, decrypted and ready to match. */
  compiled: CompiledRule[];
  /** `categories.builtin_key` -> id, for resolving a built-in rule's target. */
  builtinKeyToId: Map<string, string>;
}

async function loadContext(
  tx: Tx,
  dataKey: Uint8Array,
  opts: { activeOnly?: boolean } = {},
): Promise<CategorizationContext> {
  const ruleRows = await tx
    .select()
    .from(rules)
    .where(
      opts.activeOnly === false
        ? eq(rules.resourceType, RESOURCE_TYPE)
        : and(eq(rules.resourceType, RESOURCE_TYPE), eq(rules.active, true)),
    );

  const builtinKeyToId = new Map<string, string>();
  const catRows = await tx
    .select({ id: categories.id, builtinKey: categories.builtinKey })
    .from(categories);
  for (const c of catRows) {
    if (c.builtinKey) builtinKeyToId.set(c.builtinKey, c.id);
  }

  if (ruleRows.length === 0) return { compiled: [], builtinKeyToId };

  const ruleIds = ruleRows.map((r) => r.id);
  const conditionRows = await tx
    .select()
    .from(ruleConditions)
    .where(inArray(ruleConditions.ruleId, ruleIds));
  const actionRows = await tx
    .select()
    .from(ruleActions)
    .where(and(inArray(ruleActions.ruleId, ruleIds), eq(ruleActions.actionType, "set_category")));

  const categoryByRule = new Map(actionRows.map((a) => [a.ruleId, a.value]));

  // Decrypt every condition once, then rebuild the parent/child tree in
  // memory. `value_ct` is AAD-bound to the condition row's own id/column/
  // version (encryption.md §3).
  const decrypted = conditionRows.map((c) => ({
    id: c.id,
    ruleId: c.ruleId,
    parentId: c.parentId,
    conditionType: c.conditionType as ConditionType,
    operator: c.operator as Operator,
    value: decText(dataKey, c.valueCt, c.id, "value_ct", c.version) ?? "",
  }));

  const childrenByParent = new Map<string, CompiledCondition[]>();
  for (const c of decrypted) {
    if (!c.parentId) continue;
    const list = childrenByParent.get(c.parentId) ?? [];
    list.push({ conditionType: c.conditionType, operator: c.operator, value: c.value });
    childrenByParent.set(c.parentId, list);
  }

  const topLevelByRule = new Map<string, CompiledCondition[]>();
  for (const c of decrypted) {
    if (c.parentId) continue;
    const list = topLevelByRule.get(c.ruleId) ?? [];
    list.push({
      conditionType: c.conditionType,
      operator: c.operator,
      value: c.value,
      ...(c.conditionType === "group" ? { children: childrenByParent.get(c.id) ?? [] } : {}),
    });
    topLevelByRule.set(c.ruleId, list);
  }

  const compiled: CompiledRule[] = [];
  for (const r of ruleRows) {
    const categoryId = categoryByRule.get(r.id);
    // A rule with no set_category action can't categorize anything. It is
    // not an error — v1.0 just has no other action type yet.
    if (!categoryId) continue;
    compiled.push({
      id: r.id,
      name: r.name,
      categoryId,
      effectiveDate: r.effectiveDate,
      conditions: topLevelByRule.get(r.id) ?? [],
    });
  }

  return { compiled, builtinKeyToId };
}

// ---------------------------------------------------------------------------
// Applying categories
// ---------------------------------------------------------------------------

interface EntryCandidateRow {
  id: string;
  date: string;
  accountId: string;
  descriptionCt: Buffer;
  enteredAmountCt: Buffer;
  version: number;
  lockedAttributes: unknown;
}

function toCandidate(row: EntryCandidateRow, dataKey: Uint8Array): Candidate {
  return {
    description: normalizeDescription(
      decText(dataKey, row.descriptionCt, row.id, "description_ct", row.version) ?? "",
    ),
    amount: decText(dataKey, row.enteredAmountCt, row.id, "entered_amount_ct", row.version) ?? "0",
    accountId: row.accountId,
    date: row.date,
  };
}

/** Appends the field-level provenance row for a category assignment. Its
 * ciphertext is AAD-bound to THIS changelog row, not to the entry
 * (data-model.md §5). */
async function logCategoryChange(
  tx: Tx,
  ownerId: string,
  dataKey: Uint8Array,
  entryId: string,
  categoryId: string | null,
  source: "rule" | "model" | "user",
): Promise<void> {
  const id = randomUUID();
  await tx.insert(entryFieldChangelog).values({
    id,
    ownerId,
    entryId,
    fieldName: "category_id",
    source,
    // A cleared category is a real change worth recording; the empty string
    // is its encoding (the column is NOT NULL).
    valueCt: encText(dataKey, categoryId ?? "", id, "value_ct", 1),
  });
}

/**
 * Runs the deterministic layers over `entryIds` and writes the categories it
 * resolves. Takes the caller's transaction so a scrape stays atomic.
 *
 * Re-derives rather than only filling blanks. A category assigned by a rule
 * or the built-in table is *derived* — the ruleset is its only justification,
 * so when the ruleset changes it has to be recomputed. A category a person
 * set by hand is locked, and locked entries are never candidates here. That
 * is the whole distinction: locked is authoritative, unlocked is derived.
 *
 * It does not *clear* a category when nothing matches. Deleting a rule
 * deliberately leaves behind what it filed (see `deleteRule`), so a pass that
 * blanked unjustified categories would quietly undo that.
 *
 * Only plaintext columns are written (`category_id`). `entries.version` is
 * deliberately NOT bumped: it is one version shared by every ciphertext
 * column on the row (sync-promotion.ts's trap #3), so bumping it here would
 * make every `*_ct` column on the entry fail to decrypt. `entries.source` is
 * likewise left alone — it records where the ENTRY came from (a scrape),
 * not who set one of its fields; that is what the changelog is for.
 *
 * Returns how many entries were categorized.
 */
export async function categorizeEntries(
  tx: Tx,
  ownerId: string,
  dataKey: Uint8Array,
  entryIds: string[],
): Promise<number> {
  if (entryIds.length === 0) return 0;

  const rows = await tx
    .select({
      id: entries.id,
      date: entries.date,
      accountId: entries.accountId,
      categoryId: entries.categoryId,
      descriptionCt: entries.descriptionCt,
      enteredAmountCt: entries.enteredAmountCt,
      version: entries.version,
      lockedAttributes: entries.lockedAttributes,
    })
    .from(entries)
    .where(inArray(entries.id, entryIds));

  const candidates = rows.filter((r) => !isFieldLocked(r.lockedAttributes, "category_id"));
  if (candidates.length === 0) return 0;

  const { compiled, builtinKeyToId } = await loadContext(tx, dataKey);

  // Which side of the balance sheet each entry sits on. A built-in rule can
  // gate on this, because the same merchant text means opposite things on a
  // bank account and on the credit card it settles.
  const acctRows = await tx
    .select({ id: accounts.id, classification: accounts.classification })
    .from(accounts);
  const classificationByAccount = new Map(acctRows.map((a) => [a.id, a.classification]));

  let categorized = 0;
  for (const row of candidates) {
    const candidate = toCandidate(row, dataKey);

    let categoryId: string | null = null;
    const ruleMatch = evaluate(candidate, compiled);
    if (ruleMatch) {
      categoryId = ruleMatch.categoryId;
    } else {
      const builtin = evaluateBuiltins(
        candidate.description,
        classificationByAccount.get(row.accountId) ?? "asset",
      );
      if (builtin) categoryId = builtinKeyToId.get(builtin.categoryKey) ?? null;
    }
    if (!categoryId) continue;
    // Re-deriving the same answer is not a change: writing it anyway would
    // put a changelog row on every entry on every rule edit.
    if (categoryId === row.categoryId) continue;

    await tx.update(entries).set({ categoryId }).where(eq(entries.id, row.id));
    await logCategoryChange(tx, ownerId, dataKey, row.id, categoryId, "rule");
    categorized += 1;
  }

  return categorized;
}

/** Every entry still awaiting a category. */
async function uncategorizedEntryIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(and(isNull(entries.categoryId), eq(entries.excluded, false)));
  return rows.map((r) => r.id);
}

/**
 * Every entry a change to the ruleset may act on: not excluded, and not
 * locked to a category a person chose.
 *
 * Wider than `uncategorizedEntryIds` on purpose. A café named "יאלנס רכבת"
 * is claimed at ingest by the built-in `רכבת` rule; writing a rule that says
 * otherwise has to be able to displace that, or the user's own rule loses to
 * a shipped default on every transaction that arrived first.
 */
async function ruleCandidateEntryIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: entries.id, lockedAttributes: entries.lockedAttributes })
    .from(entries)
    .where(eq(entries.excluded, false));
  return rows.filter((r) => !isFieldLocked(r.lockedAttributes, "category_id")).map((r) => r.id);
}

/**
 * Re-runs the deterministic layers over every entry that still has no
 * category. The backfill path, and what makes a newly created rule take
 * effect on existing entries.
 */
export async function recategorizeUncategorized(session: Session): Promise<number> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    return categorizeEntries(tx, userId, dataKey, await uncategorizedEntryIds(tx));
  });
}

// ---------------------------------------------------------------------------
// Suggestions (layer 3) — derived, never stored
// ---------------------------------------------------------------------------

/**
 * A proposed category for a transaction no rule could place, with the
 * evidence behind it. Built fresh on every render: the engine is local and
 * free, so re-deriving costs nothing and the answer *improves* as the user
 * categorizes more (docs/adr/0002-*).
 */
export interface SuggestionView {
  categoryId: string;
  categoryName: string;
  /** The corpus text that argued for it. Tier-1 counterparty text — the UI
   * MUST bidi-isolate it (categorization.md §12). */
  matchedText: string;
  matchedSource: ExampleSource;
  /** Past transactions filed this way under `matchedText`; 0 for a rule or
   * a built-in, which carry no count. */
  supportCount: number;
}

/** The rejection set's composite key. The category id goes first because it
 * is a fixed-shape uuid, so no match text can ever collide across the
 * separator no matter what a payee is called. */
function rejectionKey(matchText: string, categoryId: string): string {
  return `${categoryId}:${matchText}`;
}

/**
 * The user's rejections, decrypted once for the caller's whole batch, as a
 * set of `rejectionKey` strings.
 *
 * `match_text_ct` cannot become a WHERE clause any more than
 * `rule_conditions.value_ct` can, so this is the same decrypt-then-compute
 * trade-off `loadContext` already makes. The set is bounded by how many times
 * a person clicked thumbs-down, which is small by construction.
 */
async function loadRejections(tx: Tx, dataKey: Uint8Array): Promise<Set<string>> {
  const rows = await tx.select().from(categoryRejections);
  const suppressed = new Set<string>();
  for (const row of rows) {
    const matchText = decText(dataKey, row.matchTextCt, row.id, "match_text_ct", row.version);
    if (matchText === null) continue;
    suppressed.add(rejectionKey(matchText, row.categoryId));
  }
  return suppressed;
}

/**
 * Every labeled `(match text -> category)` pair Moni knows.
 *
 * Three feeders, deliberately:
 *
 * - **Categorized entries**, with no time window. The learner forgets past
 *   `LEARN_WINDOW_DAYS` on purpose, but forgetting is wrong here: arnona, car
 *   test and insurance recur once a year, and they are exactly the
 *   transactions nobody remembers how they filed last time.
 * - **The user's own rules**, whose description conditions are the strongest
 *   statement of intent in the system. A rule that *almost* fires — an
 *   `equals` on "שופרסל דיל" against "שופרסל אונליין" — contributes nothing
 *   at layer 1 but everything here.
 * - **The shipped built-in table**, which solves cold start: a day-one user
 *   has the largest backlog they will ever have and zero history to learn
 *   from. Rules carrying `onlyOn` are skipped — that gate exists because the
 *   same text means opposite things on a card and on the bank account that
 *   settles it (categorization.md §6a), and similarity has no account to
 *   gate on.
 */
async function collectLabeledExamples(tx: Tx, dataKey: Uint8Array): Promise<LabeledExample[]> {
  const examples: LabeledExample[] = [];

  const categorized = await tx
    .select({
      id: entries.id,
      categoryId: entries.categoryId,
      descriptionCt: entries.descriptionCt,
      version: entries.version,
    })
    .from(entries)
    .where(sql`${entries.categoryId} is not null`);

  for (const row of categorized) {
    if (!row.categoryId) continue;
    const matchText = normalizeDescription(
      decText(dataKey, row.descriptionCt, row.id, "description_ct", row.version) ?? "",
    );
    if (matchText === "") continue;
    examples.push({ matchText, categoryId: row.categoryId, source: "entry" });
  }

  const { compiled, builtinKeyToId } = await loadContext(tx, dataKey);
  for (const rule of compiled) {
    for (const condition of rule.conditions) {
      const leaves = condition.conditionType === "group" ? (condition.children ?? []) : [condition];
      for (const leaf of leaves) {
        if (leaf.conditionType !== "description" || leaf.value === "") continue;
        examples.push({ matchText: leaf.value, categoryId: rule.categoryId, source: "rule" });
      }
    }
  }

  for (const rule of BUILTIN_RULES) {
    if (rule.onlyOn) continue;
    const categoryId = builtinKeyToId.get(rule.categoryKey);
    if (!categoryId) continue;
    for (const needle of rule.match) {
      examples.push({ matchText: needle, categoryId, source: "builtin" });
    }
  }

  return examples;
}

/**
 * The corpus feeders, unbuilt.
 *
 * Exported for `npm run suggestions:eval`, which holds out a slice of the
 * `entry` examples and measures what the rest predicts. It has to read the
 * same examples production does, or it would be tuning a threshold for an
 * engine nobody runs.
 */
export async function loadSuggestionExamples(session: Session): Promise<LabeledExample[]> {
  return withUser(session.userId, (tx) => collectLabeledExamples(tx, session.dataKey));
}

/**
 * Suggests a category for each of `matchTexts`, keyed by the caller's own id
 * for the row (an entry id, in every caller today).
 *
 * The corpus is built once for the whole batch — the expensive part is
 * decrypting history, and doing it per row would repeat that for every
 * transaction on the page.
 *
 * A rejected pairing does not merely blank the row: it is skipped and the
 * next candidate that still clears `MIN_SUGGESTION_SCORE` takes its place.
 * Entries with no suggestion simply have no key in the result.
 */
export async function suggestCategories(
  session: Session,
  targets: { id: string; matchText: string }[],
): Promise<Record<string, SuggestionView>> {
  if (targets.length === 0) return {};

  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    const examples = await collectLabeledExamples(tx, dataKey);
    const { builtinKeyToId } = await loadContext(tx, dataKey);
    const ownCorpus = buildCorpus(examples.filter((e) => e.source !== "builtin"));
    const builtinCorpus = buildCorpus(examples.filter((e) => e.source === "builtin"));

    const suppressed = await loadRejections(tx, dataKey);
    const catRows = await tx
      .select({
        id: categories.id,
        name: categories.name,
        classification: categories.classification,
      })
      .from(categories);
    const catInfo = new Map(catRows.map((c) => [c.id, c]));

    // Load merchant_lookups cache once for the batch
    const lookupRows = await tx.select().from(merchantLookups);
    const externalLookups = new Map<string, string | null>();
    for (const row of lookupRows) {
      const matchText = decText(dataKey, row.matchTextCt, row.id, "match_text_ct", row.version);
      if (matchText !== null) {
        externalLookups.set(matchText, row.builtinKey);
      }
    }

    // Pre-query entry amounts for direction guard on external suggestions
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const targetIds = targets.map((t) => t.id).filter((id) => UUID_REGEX.test(id));
    const targetEntryRows =
      targetIds.length > 0
        ? await tx
            .select({
              id: entries.id,
              enteredAmountCt: entries.enteredAmountCt,
              version: entries.version,
            })
            .from(entries)
            .where(inArray(entries.id, targetIds))
        : [];
    const entryAmountIsNegative = new Map<string, boolean>();
    for (const row of targetEntryRows) {
      const amountStr =
        decText(dataKey, row.enteredAmountCt, row.id, "entered_amount_ct", row.version) ?? "0";
      entryAmountIsNegative.set(row.id, new Decimal(amountStr).isNegative());
    }

    /** The best candidate in one corpus that clears the bar and has not been
     * rejected — a rejected top candidate falls through to the next. */
    function pick(matchText: string, corpus: Corpus): SuggestionView | null {
      for (const candidate of suggest(matchText, corpus)) {
        if (candidate.score < MIN_SUGGESTION_SCORE) break;
        if (suppressed.has(rejectionKey(matchText, candidate.categoryId))) continue;
        const info = catInfo.get(candidate.categoryId);
        if (!info) continue;
        return {
          categoryId: candidate.categoryId,
          categoryName: info.name,
          matchedText: candidate.matchedText,
          matchedSource: candidate.matchedSource,
          supportCount: candidate.supportCount,
        };
      }
      return null;
    }

    function pickExternal(targetId: string, matchText: string): SuggestionView | null {
      if (!externalLookups.has(matchText)) return null;
      const builtinKey = externalLookups.get(matchText);
      if (!builtinKey) return null; // asked and model returned unknown

      const categoryId = builtinKeyToId.get(builtinKey);
      if (!categoryId) return null; // builtin_key does not resolve to a category row

      if (suppressed.has(rejectionKey(matchText, categoryId))) return null;

      const info = catInfo.get(categoryId);
      if (!info) return null;

      // Direction guard
      const isNegative = entryAmountIsNegative.get(targetId);
      if (isNegative !== undefined) {
        if (isNegative && info.classification === "income") return null;
        if (!isNegative && info.classification === "expense") return null;
      }

      return {
        categoryId,
        categoryName: info.name,
        matchedText: matchText,
        matchedSource: "external",
        supportCount: 0,
      };
    }

    const byTextAndEntry = new Map<string, SuggestionView | null>();
    const out: Record<string, SuggestionView> = {};

    for (const target of targets) {
      if (target.matchText === "") continue;

      const cacheKey = `${target.id}:${target.matchText}`;
      let view = byTextAndEntry.get(cacheKey);
      if (view === undefined) {
        view =
          pick(target.matchText, ownCorpus) ??
          pick(target.matchText, builtinCorpus) ??
          pickExternal(target.id, target.matchText);
        byTextAndEntry.set(cacheKey, view);
      }

      if (view) out[target.id] = view;
    }

    return out;
  });
}

/**
 * Smart Categorization trigger: sends unrecognized merchant strings to an
 * LLM in batches, caches the response per merchant string, and returns counts.
 *
 * Does NOT write `entries.category_id` automatically.
 */
export async function enrichUnknownMerchants(
  session: Session,
): Promise<{ looked_up: number; placed: number }> {
  const { userId, dataKey } = session;
  const config = getLlmConfig();
  if (!config) {
    throw new LlmNotConfiguredError();
  }

  const eligibleTexts = await withUser(userId, async (tx) => {
    // 1. Check user smartCategorize setting
    const [userRow] = await tx
      .select({ smartCategorize: users.smartCategorize })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!userRow || !userRow.smartCategorize) {
      throw new SmartCategorizeDisabledError();
    }

    // 2. Collect candidate match texts from uncategorized non-excluded entries
    const uncategorizedRows = await tx
      .select({
        id: entries.id,
        descriptionCt: entries.descriptionCt,
        version: entries.version,
      })
      .from(entries)
      .where(and(isNull(entries.categoryId), eq(entries.excluded, false)));

    const candidateTextsSet = new Set<string>();
    const blockedTextsSet = new Set<string>();
    
    for (const row of uncategorizedRows) {
      const raw = decText(dataKey, row.descriptionCt, row.id, "description_ct", row.version) ?? "";
      const matchText = normalizeDescription(raw);
      
      if (matchText !== "") {
        // Block on the raw description before normalization strips prefixes
        if (blocksEgress(raw)) {
          blockedTextsSet.add(matchText);
        } else {
          candidateTextsSet.add(matchText);
        }
      }
    }

    if (candidateTextsSet.size === 0) {
      return [];
    }

    // 3. Subtract anything already in merchant_lookups (decrypt once per batch)
    const existingLookups = await tx.select().from(merchantLookups);
    const cachedTexts = new Set<string>();
    for (const row of existingLookups) {
      const matchText = decText(dataKey, row.matchTextCt, row.id, "match_text_ct", row.version);
      if (matchText !== null) {
        cachedTexts.add(matchText);
      }
    }

    // 4. Subtract anything local engine places above MIN_SUGGESTION_SCORE
    const examples = await collectLabeledExamples(tx, dataKey);
    const ownCorpus = buildCorpus(examples.filter((e) => e.source !== "builtin"));
    const builtinCorpus = buildCorpus(examples.filter((e) => e.source === "builtin"));

    function localPlaces(text: string): boolean {
      for (const candidate of suggest(text, ownCorpus)) {
        if (candidate.score >= MIN_SUGGESTION_SCORE) return true;
        break;
      }
      for (const candidate of suggest(text, builtinCorpus)) {
        if (candidate.score >= MIN_SUGGESTION_SCORE) return true;
        break;
      }
      return false;
    }

    const eligible: string[] = [];
    for (const text of candidateTextsSet) {
      // 5. Subtract anything blocksEgress rejected
      if (blockedTextsSet.has(text)) continue;
      if (cachedTexts.has(text)) continue;
      if (localPlaces(text)) continue;
      eligible.push(text);
    }
    
    return eligible;
  });

  // 6. Cap at 100 texts per invocation
  const toLookup = eligibleTexts.slice(0, 100);
  if (toLookup.length === 0) {
    return { looked_up: 0, placed: 0 };
  }

  let looked_up = 0;
  let placed = 0;
  const BATCH_SIZE = 10;
  const resultsToInsert: { text: string; builtinKey: string | null; answer: any }[] = [];

  for (let start = 0; start < toLookup.length; start += BATCH_SIZE) {
    if (start > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const slice = toLookup.slice(start, start + BATCH_SIZE);
    const batchAnswers = await classifyBatch(slice, start, config);

    for (let i = 0; i < slice.length; i++) {
      const text = slice[i];
      const index = start + i;
      const answer = batchAnswers.get(index) ?? {
        key: UNKNOWN,
        brand: "",
        confidence: "low" as const,
        why: "",
      };

      const shownKey = guarded(answer);
      const builtinKey = shownKey === UNKNOWN ? null : shownKey;

      resultsToInsert.push({ text, builtinKey, answer });
    }
  }

  if (resultsToInsert.length > 0) {
    await withUser(userId, async (tx) => {
      for (const res of resultsToInsert) {
        const id = randomUUID();
        await tx.insert(merchantLookups).values({
          id,
          ownerId: userId,
          matchTextCt: encText(dataKey, res.text, id, "match_text_ct", 1),
          builtinKey: res.builtinKey,
          confidence: res.answer.confidence,
          model: config.model,
          promptVersion: PROMPT_VERSION,
          version: 1,
        });

        looked_up++;
        if (res.builtinKey !== null) {
          placed++;
        }
      }
    });
  }

  return { looked_up, placed };
}

/**
 * Records that a category is wrong for a match text.
 *
 * Scoped to the text, not to the transaction the user clicked: one
 * thumbs-down on a recurring merchant clears the wrong guess from every entry
 * sharing it. It suppresses *suggestions only* — a rule may still assign that
 * category, and the learner may still write one, which is what keeps the
 * blast radius small.
 *
 * Idempotent. There is no unique constraint to lean on, because the key is
 * encrypted and ciphertext is randomized, so the dedupe happens here.
 */
export async function rejectSuggestion(
  session: Session,
  matchText: string,
  categoryId: string,
): Promise<void> {
  const { userId, dataKey } = session;
  await withUser(userId, async (tx) => {
    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!category) throw new CategoryNotFoundError(categoryId);

    const suppressed = await loadRejections(tx, dataKey);
    if (suppressed.has(rejectionKey(matchText, categoryId))) return;

    const id = randomUUID();
    await tx.insert(categoryRejections).values({
      id,
      ownerId: userId,
      matchTextCt: encText(dataKey, matchText, id, "match_text_ct", 1),
      categoryId,
    });
  });
}

// ---------------------------------------------------------------------------
// The user path
// ---------------------------------------------------------------------------

/** The description operators a rule written from the categorize dialog may
 * use — the description third of `rule-form`'s vocabulary, minus the amount
 * operators, which have no meaning for a payee string. */
export type DescriptionOperator = "contains" | "starts_with" | "equals";

export interface SetEntryCategoryOptions {
  /** Also write a rule so future transactions matching this text get the
   * same category. The value is normalized before it is stored, because the
   * matcher compares against a normalized description. */
  createRule?: { operator: DescriptionOperator; value: string };
}

/**
 * The manual override. Sets the category, LOCKS the field so no rule or
 * model ever overwrites it, and records the change with `source: 'user'`.
 * Passing `null` clears the category and releases the lock.
 */
export async function setEntryCategory(
  session: Session,
  entryId: string,
  categoryId: string | null,
  opts: SetEntryCategoryOptions = {},
): Promise<void> {
  const { userId, dataKey } = session;
  await withUser(userId, async (tx) => {
    const [entry] = await tx.select().from(entries).where(eq(entries.id, entryId)).limit(1);
    // RLS already scopes this to the caller, so a miss means "not yours or
    // not there" — the same thing, deliberately indistinguishable.
    if (!entry) throw new CategoryNotFoundError(entryId);

    if (categoryId !== null) {
      const [category] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.id, categoryId))
        .limit(1);
      if (!category) throw new CategoryNotFoundError(categoryId);
    }

    await tx
      .update(entries)
      .set({
        categoryId,
        lockedAttributes:
          categoryId === null
            ? withFieldUnlocked(entry.lockedAttributes, "category_id")
            : withFieldLocked(entry.lockedAttributes, "category_id"),
      })
      .where(eq(entries.id, entryId));

    await logCategoryChange(tx, userId, dataKey, entryId, categoryId, "user");

    if (categoryId === null) return;

    const description = normalizeDescription(
      decText(dataKey, entry.descriptionCt, entry.id, "description_ct", entry.version) ?? "",
    );

    let ruleChanged = false;
    if (opts.createRule) {
      const value = normalizeDescription(opts.createRule.value);
      if (value !== "") {
        ruleChanged = await upsertDescriptionRule(tx, userId, dataKey, {
          operator: opts.createRule.operator,
          value,
          categoryId,
          name: value,
        });
      }
    } else {
      ruleChanged = await learnCategoryRule(tx, userId, dataKey, description, categoryId);
    }

    // A new rule that only applies to transactions not yet scraped would be
    // useless the moment it is written; run it over every entry it is allowed
    // to touch. The entry being edited was locked a few lines above, so it is
    // not among them — this pass is for its siblings.
    if (ruleChanged) {
      await categorizeEntries(tx, userId, dataKey, await ruleCandidateEntryIds(tx));
    }
  });
}

/**
 * Actual Budget's `getProbableCategory`, materialized as a rule.
 *
 * Looks at the most recent `LEARN_SAMPLE_SIZE` entries sharing this
 * description within `LEARN_WINDOW_DAYS`; if at least
 * `LEARN_AGREEMENT_THRESHOLD` of them agree on a category, writes a rule for
 * it. Writing a real rule rather than hidden state is the whole point — the
 * user can see why a transaction was categorized, and delete the reason.
 *
 * Returns whether it actually wrote one.
 */
async function learnCategoryRule(
  tx: Tx,
  ownerId: string,
  dataKey: Uint8Array,
  description: string,
  categoryId: string,
): Promise<boolean> {
  if (description === "") return false;

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - LEARN_WINDOW_DAYS);
  const sinceIso = since.toISOString().slice(0, 10);

  const recent = await tx
    .select({
      id: entries.id,
      categoryId: entries.categoryId,
      descriptionCt: entries.descriptionCt,
      version: entries.version,
    })
    .from(entries)
    .where(and(gte(entries.date, sinceIso), sql`${entries.categoryId} is not null`))
    .orderBy(desc(entries.date))
    .limit(LEARN_SCAN_LIMIT);

  const sample: string[] = [];
  for (const row of recent) {
    const rowDescription = normalizeDescription(
      decText(dataKey, row.descriptionCt, row.id, "description_ct", row.version) ?? "",
    );
    if (rowDescription !== description) continue;
    if (row.categoryId) sample.push(row.categoryId);
    if (sample.length === LEARN_SAMPLE_SIZE) break;
  }

  const agreeing = sample.filter((c) => c === categoryId).length;
  if (agreeing < LEARN_AGREEMENT_THRESHOLD) return false;

  return upsertDescriptionRule(tx, ownerId, dataKey, {
    operator: "contains",
    value: description,
    categoryId,
    name: `Learned: ${description}`,
  });
}

/**
 * Creates — or retargets — the single `description <operator> <value>` rule
 * for this pairing. Retargeting rather than duplicating is Maybe's
 * `eligible_for_category_rule?` dedupe: a user who re-categorizes the same
 * merchant twice should end up with one rule, not two contradictory ones.
 * The operator is part of that identity, so narrowing an existing
 * `contains X` to `is exactly X` writes a second, more specific rule rather
 * than silently rewriting the broad one someone may still be relying on.
 *
 * `effective_date` is left null: the engine only ever writes to entries whose
 * `category_id` IS NULL, so a rule cannot rewrite history no matter its date,
 * and dating it today would only stop it from filling in the blanks the user
 * created it to fill. The column stays user-settable for "apply from date X".
 *
 * Reports whether the ruleset actually changed, so the caller knows whether a
 * backfill pass is worth running.
 */
async function upsertDescriptionRule(
  tx: Tx,
  ownerId: string,
  dataKey: Uint8Array,
  input: { operator: DescriptionOperator; value: string; categoryId: string; name: string },
): Promise<boolean> {
  // Condition values are encrypted, so finding "the rule for this text"
  // means decrypting the ruleset — which loadContext already does.
  const { compiled } = await loadContext(tx, dataKey, { activeOnly: false });
  const existing = compiled.find(
    (r) =>
      r.conditions.length === 1 &&
      r.conditions[0].conditionType === "description" &&
      r.conditions[0].operator === input.operator &&
      r.conditions[0].value === input.value,
  );

  if (existing) {
    if (existing.categoryId === input.categoryId) return false;
    await tx
      .update(ruleActions)
      .set({ value: input.categoryId })
      .where(and(eq(ruleActions.ruleId, existing.id), eq(ruleActions.actionType, "set_category")));
    return true;
  }

  const ruleId = randomUUID();
  const conditionId = randomUUID();
  await tx.insert(rules).values({
    id: ruleId,
    ownerId,
    name: input.name,
    resourceType: RESOURCE_TYPE,
    active: true,
    effectiveDate: null,
  });
  await tx.insert(ruleConditions).values({
    id: conditionId,
    ownerId,
    ruleId,
    conditionType: "description",
    operator: input.operator,
    valueCt: encText(dataKey, input.value, conditionId, "value_ct", 1),
  });
  await tx.insert(ruleActions).values({
    ownerId,
    ruleId,
    actionType: "set_category",
    value: input.categoryId,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Reads for the UI
// ---------------------------------------------------------------------------

export interface CategoryView {
  id: string;
  name: string;
  classification: CategoryClassification;
  color: string | null;
  icon: string | null;
  parentId: string | null;
}

/** Every category, parents before their children, alphabetical within a
 * group — the order the picker renders. */
export async function listCategories(session: Session): Promise<CategoryView[]> {
  return withUser(session.userId, async (tx) => {
    const rows = await tx.select().from(categories);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const nameOf = (id: string) => byId.get(id)?.name ?? "";

    return rows
      .map((r): CategoryView => ({
        id: r.id,
        name: r.name,
        classification: r.classification,
        color: r.color,
        icon: r.icon,
        parentId: r.parentId,
      }))
      .sort((a, b) => {
        const groupA = a.parentId ? nameOf(a.parentId) : a.name;
        const groupB = b.parentId ? nameOf(b.parentId) : b.name;
        if (groupA !== groupB) return groupA.localeCompare(groupB);
        // Parent first within its own group, then children alphabetically.
        if (!a.parentId) return -1;
        if (!b.parentId) return 1;
        return a.name.localeCompare(b.name);
      });
  });
}

// ---------------------------------------------------------------------------
// Categories CRUD (the Categories tab)
// ---------------------------------------------------------------------------

export interface CategoryDetailView extends CategoryView {
  /** Shipped as part of the default set, so it is rename-only (see
   * `BuiltinCategoryError`). */
  builtin: boolean;
  /** Entries currently filed under this exact category — the children of a
   * parent are counted against the child, not rolled up. */
  entryCount: number;
  /** Rules whose `set_category` action points here. Deleting the category
   * deletes them, because a rule that assigns a category that no longer
   * exists cannot run. */
  ruleCount: number;
  /** The user has said spending here repeats — the only gate on the
   * recurring view (docs/adr/0006-*). A flag on a parent covers its
   * children, so a child may show as recurring without its own flag set. */
  isRecurring: boolean;
}

export interface CategoryGroupView extends CategoryDetailView {
  children: CategoryDetailView[];
}

/**
 * The category tree with usage counts — what the Categories tab renders.
 *
 * The counts exist to make deletion an informed decision rather than a leap:
 * the confirmation has to be able to say how many transactions fall back to
 * uncategorized and how many rules go with it.
 */
export async function listCategoryTree(session: Session): Promise<CategoryGroupView[]> {
  return withUser(session.userId, async (tx) => {
    // Sequential, NOT Promise.all — one pooled client per transaction.
    const rows = await tx.select().from(categories);
    const entryCounts = await tx
      .select({ categoryId: entries.categoryId, n: sql<number>`count(*)::int` })
      .from(entries)
      .groupBy(entries.categoryId);
    const ruleCounts = await tx
      .select({ categoryId: ruleActions.value, n: sql<number>`count(*)::int` })
      .from(ruleActions)
      .where(eq(ruleActions.actionType, "set_category"))
      .groupBy(ruleActions.value);

    const entryCountBy = new Map(entryCounts.map((r) => [r.categoryId, r.n]));
    const ruleCountBy = new Map(ruleCounts.map((r) => [r.categoryId, r.n]));

    const toDetail = (r: (typeof rows)[number]): CategoryDetailView => ({
      id: r.id,
      name: r.name,
      classification: r.classification,
      color: r.color,
      icon: r.icon,
      parentId: r.parentId,
      builtin: r.builtinKey !== null,
      entryCount: entryCountBy.get(r.id) ?? 0,
      ruleCount: ruleCountBy.get(r.id) ?? 0,
      isRecurring: r.isRecurring,
    });

    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

    return rows
      .filter((r) => !r.parentId)
      .map((parent): CategoryGroupView => ({
        ...toDetail(parent),
        children: rows
          .filter((r) => r.parentId === parent.id)
          .map(toDetail)
          .sort(byName),
      }))
      .sort(byName);
  });
}

export interface CategoryInput {
  name: string;
  /** Null for a top-level group. A subcategory's parent must itself be
   * top-level — the depth-1 cap from data-model.md §5, enforced here because
   * the schema's self-FK permits any depth. */
  parentId: string | null;
  /** Honoured only for a top-level category; a subcategory inherits its
   * parent's, so the two can never disagree. */
  classification: CategoryClassification;
  color: string;
  icon: string;
}

/** Shared validation, and the place inheritance is resolved. Returns the
 * values to write, which for a subcategory are the parent's. */
async function resolveCategoryInput(
  tx: Tx,
  input: CategoryInput,
  /** Set when updating, so a category cannot be made its own parent. */
  selfId?: string,
): Promise<{
  name: string;
  parentId: string | null;
  classification: CategoryClassification;
  color: string;
  icon: string;
}> {
  const name = input.name.trim();
  if (name === "") throw new InvalidCategoryNestingError("A category needs a name");
  if (!isCategoryIcon(input.icon)) throw new InvalidCategoryNestingError("Unknown icon");
  if (!isCategoryColor(input.color)) throw new InvalidCategoryNestingError("Unknown color");

  if (!input.parentId) {
    return {
      name,
      parentId: null,
      classification: input.classification,
      color: input.color,
      icon: input.icon,
    };
  }

  if (input.parentId === selfId) {
    throw new InvalidCategoryNestingError("A category cannot be its own parent");
  }
  const [parent] = await tx
    .select()
    .from(categories)
    .where(eq(categories.id, input.parentId))
    .limit(1);
  if (!parent) throw new CategoryNotFoundError(input.parentId);
  if (parent.parentId) {
    throw new InvalidCategoryNestingError("Categories nest one level deep");
  }

  return {
    name,
    parentId: parent.id,
    // Inherited, never declared: a subcategory whose classification differed
    // from its parent's would put its transactions on the wrong side of every
    // income/expense total while still displaying under that parent.
    classification: parent.classification,
    color: parent.color ?? input.color,
    icon: input.icon,
  };
}

export async function createCategory(session: Session, input: CategoryInput): Promise<string> {
  return withUser(session.userId, async (tx) => {
    const resolved = await resolveCategoryInput(tx, input);
    const id = randomUUID();
    await tx.insert(categories).values({
      id,
      ownerId: session.userId,
      ...resolved,
      // Null: user-created, so `categories:sync` leaves it alone and it stays
      // deletable. Only the shipped set carries a `builtin_key`.
      builtinKey: null,
    });
    return id;
  });
}

/**
 * Renames / re-parents / re-styles a category. Built-in categories are
 * editable here — that is exactly what `builtin_key` is for, since identity
 * lives in the key rather than the name and a rename survives an upgrade.
 */
/**
 * Flags (or unflags) a category as recurring — the one gate on the recurring
 * view (docs/adr/0006-*).
 *
 * Its own function rather than a field on `CategoryInput` because it is a
 * one-click toggle on a list row, and routing it through the edit dialog's
 * full-body PATCH would make a checkbox rewrite the name, colour, icon and
 * parent it never touched.
 */
export async function setCategoryRecurring(
  session: Session,
  categoryId: string,
  isRecurring: boolean,
): Promise<void> {
  await withUser(session.userId, async (tx) => {
    const [existing] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!existing) throw new CategoryNotFoundError(categoryId);
    await tx.update(categories).set({ isRecurring }).where(eq(categories.id, categoryId));
  });
}

export async function updateCategory(
  session: Session,
  categoryId: string,
  input: CategoryInput,
): Promise<void> {
  await withUser(session.userId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!existing) throw new CategoryNotFoundError(categoryId);

    const children = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.parentId, categoryId));
    if (input.parentId && children.length > 0) {
      throw new InvalidCategoryNestingError(
        "A category with subcategories cannot become a subcategory itself",
      );
    }

    const resolved = await resolveCategoryInput(tx, input, categoryId);
    await tx.update(categories).set(resolved).where(eq(categories.id, categoryId));

    // Children inherit classification and color, so a change to the parent
    // has to travel down or the invariant only holds at creation time.
    if (children.length > 0) {
      await tx
        .update(categories)
        .set({ classification: resolved.classification, color: resolved.color })
        .where(eq(categories.parentId, categoryId));
    }
  });
}

/**
 * Deletes a user-created category and everything that pointed at it.
 *
 * Its transactions fall back to uncategorized **and lose the `category_id`
 * attribute lock**: the lock records "a human chose this", and the thing they
 * chose no longer exists, so leaving it set would freeze those entries out of
 * categorization forever with nothing to show for it.
 *
 * Rules targeting the category are deleted with it. A `set_category` action
 * naming a row that is gone would fail the entries FK on the next scrape, and
 * the rule's entire purpose was to assign this category.
 */
export async function deleteCategory(session: Session, categoryId: string): Promise<void> {
  await withUser(session.userId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!existing) throw new CategoryNotFoundError(categoryId);
    if (existing.builtinKey !== null) throw new BuiltinCategoryError();

    const children = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.parentId, categoryId));
    if (children.length > 0) throw new CategoryHasChildrenError(children.length);

    // Per-entry rather than one bulk UPDATE so the lock map goes through
    // `withFieldUnlocked` — attribute-locks.ts is the only definition of that
    // shape, and a hand-written `jsonb - 'category_id'` here would become a
    // second one to keep in step.
    const affected = await tx
      .select({ id: entries.id, lockedAttributes: entries.lockedAttributes })
      .from(entries)
      .where(eq(entries.categoryId, categoryId));
    for (const entry of affected) {
      await tx
        .update(entries)
        .set({
          categoryId: null,
          lockedAttributes: withFieldUnlocked(entry.lockedAttributes, "category_id"),
        })
        .where(eq(entries.id, entry.id));
    }

    await tx.delete(categoryRejections).where(eq(categoryRejections.categoryId, categoryId));

    const targeting = await tx
      .select({ ruleId: ruleActions.ruleId })
      .from(ruleActions)
      .where(and(eq(ruleActions.actionType, "set_category"), eq(ruleActions.value, categoryId)));
    const ruleIds = [...new Set(targeting.map((r) => r.ruleId))];
    if (ruleIds.length > 0) {
      await tx.delete(ruleConditions).where(inArray(ruleConditions.ruleId, ruleIds));
      await tx.delete(ruleActions).where(inArray(ruleActions.ruleId, ruleIds));
      await tx.delete(rules).where(inArray(rules.id, ruleIds));
    }

    await tx.delete(categories).where(eq(categories.id, categoryId));
  });
}

// ---------------------------------------------------------------------------
// Rules CRUD (the Rules tab)
// ---------------------------------------------------------------------------

/** Prefix `learnCategoryRule` puts on the rules it writes, so the UI can
 * label them and the user knows where they came from. */
const LEARNED_PREFIX = "Learned: ";

export interface RuleConditionInput {
  conditionType: ConditionType;
  operator: Operator;
  value: string;
  /** Only for `conditionType: "group"` — the schema's one nesting level. */
  children?: { conditionType: ConditionType; operator: Operator; value: string }[];
}

export interface RuleInput {
  /** Omitted to create, present to replace. */
  id?: string;
  name: string;
  active: boolean;
  effectiveDate: string | null;
  categoryId: string;
  conditions: RuleConditionInput[];
}

export interface RuleView {
  id: string;
  name: string;
  active: boolean;
  effectiveDate: string | null;
  categoryId: string;
  categoryName: string | null;
  /** Human-readable, e.g. `description contains "שופרסל"`. */
  summary: string;
  learned: boolean;
  conditions: RuleConditionInput[];
}

export class RuleNotFoundError extends Error {
  constructor(ruleId: string) {
    super(`No rule ${ruleId}`);
    this.name = "RuleNotFoundError";
  }
}

/** Unicode bidi isolate. A Hebrew merchant name dropped into an LTR
 * technical string reorders the surrounding quotes and operator — the value
 * has to be isolated so the two directions can't reflow each other. */
function isolate(value: string): string {
  return `⁨${value}⁩`;
}

function describeCondition(c: RuleConditionInput): string {
  if (c.conditionType === "group") {
    const joiner = c.operator === "any" ? " or " : " and ";
    return `(${(c.children ?? []).map(describeCondition).join(joiner)})`;
  }
  return `${c.conditionType} ${c.operator.replace("_", " ")} "${isolate(c.value)}"`;
}

export async function listRules(session: Session): Promise<RuleView[]> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    // Sequential, NOT Promise.all: every query inside a `withUser` shares one
    // pooled pg client, and issuing two on the same client concurrently is
    // deprecated in pg@8 and removed in pg@9. Anything taking a `tx` must
    // await its queries in order.
    const { compiled } = await loadContext(tx, dataKey, { activeOnly: false });
    const catRows = await tx.select({ id: categories.id, name: categories.name }).from(categories);
    const ruleRows = await tx.select().from(rules).where(eq(rules.resourceType, RESOURCE_TYPE));

    const catName = new Map(catRows.map((c) => [c.id, c.name]));
    const activeById = new Map(ruleRows.map((r) => [r.id, r.active]));

    return compiled
      .map((r): RuleView => {
        const conditions: RuleConditionInput[] = r.conditions.map((c) => ({
          conditionType: c.conditionType,
          operator: c.operator,
          value: c.value,
          ...(c.children ? { children: c.children } : {}),
        }));
        return {
          id: r.id,
          name: r.name,
          active: activeById.get(r.id) ?? false,
          effectiveDate: r.effectiveDate,
          categoryId: r.categoryId,
          categoryName: catName.get(r.categoryId) ?? null,
          summary: conditions.map(describeCondition).join(" and "),
          learned: r.name.startsWith(LEARNED_PREFIX),
          conditions,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/**
 * Creates or fully replaces a rule. Replacing deletes the old conditions and
 * actions rather than diffing them — a rule is small, and a rebuild can't
 * leave a stale condition behind.
 */
export async function upsertRule(
  session: Session,
  input: RuleInput,
): Promise<{ id: string; categorized: number }> {
  const { userId, dataKey } = session;
  if (input.conditions.length === 0) {
    // A rule with no conditions would match nothing (the matcher refuses
    // it), so accepting one would silently create a dead rule.
    throw new InvalidCategoryNestingError("A rule needs at least one condition");
  }

  return withUser(userId, async (tx) => {
    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, input.categoryId))
      .limit(1);
    if (!category) throw new CategoryNotFoundError(input.categoryId);

    let ruleId = input.id;
    if (ruleId) {
      const [existing] = await tx.select().from(rules).where(eq(rules.id, ruleId)).limit(1);
      if (!existing) throw new RuleNotFoundError(ruleId);
      await tx
        .update(rules)
        .set({ name: input.name, active: input.active, effectiveDate: input.effectiveDate })
        .where(eq(rules.id, ruleId));
      // Parent and child condition rows go in one statement; the self-FK is
      // NO ACTION, checked at statement end, so order doesn't matter.
      await tx.delete(ruleConditions).where(eq(ruleConditions.ruleId, ruleId));
      await tx.delete(ruleActions).where(eq(ruleActions.ruleId, ruleId));
    } else {
      ruleId = randomUUID();
      await tx.insert(rules).values({
        id: ruleId,
        ownerId: userId,
        name: input.name,
        resourceType: RESOURCE_TYPE,
        active: input.active,
        effectiveDate: input.effectiveDate,
      });
    }

    for (const condition of input.conditions) {
      const parentId = randomUUID();
      await tx.insert(ruleConditions).values({
        id: parentId,
        ownerId: userId,
        ruleId,
        conditionType: condition.conditionType,
        operator: condition.operator,
        valueCt: encText(dataKey, condition.value, parentId, "value_ct", 1),
      });
      for (const child of condition.children ?? []) {
        const childId = randomUUID();
        await tx.insert(ruleConditions).values({
          id: childId,
          ownerId: userId,
          ruleId,
          parentId,
          conditionType: child.conditionType,
          operator: child.operator,
          valueCt: encText(dataKey, child.value, childId, "value_ct", 1),
        });
      }
    }

    await tx.insert(ruleActions).values({
      ownerId: userId,
      ruleId,
      actionType: "set_category",
      value: input.categoryId,
    });

    // Saving a rule runs it immediately — a rule that only took effect on the
    // next scrape would look broken. It can re-file entries a weaker rule or
    // the built-in table had claimed; anything a person categorized by hand is
    // locked and stays put.
    const categorized = await categorizeEntries(
      tx,
      userId,
      dataKey,
      await ruleCandidateEntryIds(tx),
    );

    return { id: ruleId, categorized };
  });
}

/** Returns how many entries the change categorized — non-zero only when a
 * rule is being switched back on. */
export async function setRuleActive(
  session: Session,
  ruleId: string,
  active: boolean,
): Promise<number> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    const updated = await tx
      .update(rules)
      .set({ active })
      .where(eq(rules.id, ruleId))
      .returning({ id: rules.id });
    if (updated.length === 0) throw new RuleNotFoundError(ruleId);
    if (!active) return 0;
    return categorizeEntries(tx, userId, dataKey, await ruleCandidateEntryIds(tx));
  });
}

/** Deletes a rule and its conditions and actions. Entries the rule already
 * categorized keep their category — deleting the reason does not un-do the
 * result, which the user can still override per-entry. */
export async function deleteRule(session: Session, ruleId: string): Promise<void> {
  await withUser(session.userId, async (tx) => {
    await tx.delete(ruleConditions).where(eq(ruleConditions.ruleId, ruleId));
    await tx.delete(ruleActions).where(eq(ruleActions.ruleId, ruleId));
    const deleted = await tx.delete(rules).where(eq(rules.id, ruleId)).returning({ id: rules.id });
    if (deleted.length === 0) throw new RuleNotFoundError(ruleId);
  });
}
