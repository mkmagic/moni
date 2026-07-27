// Categorization — the deterministic-first pipeline that assigns a category
// to a ledger entry, and the user-facing overrides and rules that feed it
// (docs/design/categorization.md).
//
// Resolution order, first layer to produce a category wins:
//   0. attribute lock  — a human already set it; skip the entry entirely
//   1. user rules      — including learned ones, ranked by specificity
//   2. built-in rules  — the shipped Israeli keyword table (code constants)
//   3. model           — scaffold only in v1.0; writes a suggestion, never a
//                        category (there is no AI write path — AGENTS.md)
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
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { withUser } from "@/db/client";
import {
  accounts,
  categories,
  categorySuggestions,
  entries,
  entryFieldChangelog,
  recurringSeries,
  ruleActions,
  ruleConditions,
  rules,
} from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import { normalizeDescription } from "@/lib/categorization/normalize";
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
import { getSuggester, type SuggestInput } from "@/lib/categorization/suggester";
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
      descriptionCt: entries.descriptionCt,
      enteredAmountCt: entries.enteredAmountCt,
      version: entries.version,
      lockedAttributes: entries.lockedAttributes,
    })
    .from(entries)
    .where(and(inArray(entries.id, entryIds), isNull(entries.categoryId)));

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

    await tx.update(entries).set({ categoryId }).where(eq(entries.id, row.id));
    await logCategoryChange(tx, ownerId, dataKey, row.id, categoryId, "rule");
    categorized += 1;
  }

  return categorized;
}

/** Every entry still awaiting a category — the backfill candidate set. */
async function uncategorizedEntryIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(and(isNull(entries.categoryId), eq(entries.excluded, false)));
  return rows.map((r) => r.id);
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
// The model fallback (scaffold — no provider ships in v1.0)
// ---------------------------------------------------------------------------

/**
 * Asks the configured model backend about the entries the deterministic
 * layers couldn't place, and records what it says as *suggestions* awaiting
 * approval. It never writes `entries.category_id` — v1.0 has no AI write
 * path (AGENTS.md).
 *
 * With no backend configured — every v1.0 deployment — this returns 0
 * without touching the database. That is the supported path, not a stub:
 * rules-only mode is a hard invariant.
 *
 * The unique `(owner_id, entry_id)` constraint is the freeze: one answer per
 * entry, forever, so the same input can never re-categorize differently. An
 * entry the model declined gets a row with a null `category_id`, which is
 * what stops the next pass from paying to ask again.
 */
export async function runSuggestionPass(session: Session, limit = 50): Promise<number> {
  const suggester = getSuggester();
  if (!suggester) return 0;

  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    const answered = await tx
      .select({ entryId: categorySuggestions.entryId })
      .from(categorySuggestions);
    const alreadyAnswered = new Set(answered.map((r) => r.entryId));

    const rows = await tx
      .select()
      .from(entries)
      .where(and(isNull(entries.categoryId), eq(entries.excluded, false)))
      .orderBy(desc(entries.date))
      .limit(limit + alreadyAnswered.size);

    const pending = rows
      .filter((r) => !alreadyAnswered.has(r.id))
      .filter((r) => !isFieldLocked(r.lockedAttributes, "category_id"))
      .slice(0, limit);
    if (pending.length === 0) return 0;

    const allowedCategories = (await tx.select().from(categories)).map((c) => ({
      id: c.id,
      name: c.name,
      classification: c.classification,
      parentId: c.parentId,
    }));

    const inputs: SuggestInput[] = pending.map((r) => {
      const amount =
        decText(dataKey, r.enteredAmountCt, r.id, "entered_amount_ct", r.version) ?? "0";
      return {
        entryId: r.id,
        // Raw, NOT normalized — a model reads the original text better than
        // the matcher's stripped form. Untrusted: tagged data, never
        // instructions (conventions.md).
        description: decText(dataKey, r.descriptionCt, r.id, "description_ct", r.version) ?? "",
        amount: amount.startsWith("-") ? amount.slice(1) : amount,
        currency: r.enteredCurrency,
        direction: amount.startsWith("-") ? ("outflow" as const) : ("inflow" as const),
      };
    });

    const allowedIds = new Set(allowedCategories.map((c) => c.id));
    const suggestions = await suggester.suggest({ inputs, allowedCategories });

    let written = 0;
    for (const s of suggestions) {
      // Model output is untrusted: a category id it invented, or one for
      // another user, is dropped rather than stored.
      const categoryId = s.categoryId && allowedIds.has(s.categoryId) ? s.categoryId : null;
      const id = randomUUID();
      await tx.insert(categorySuggestions).values({
        id,
        ownerId: userId,
        entryId: s.entryId,
        categoryId,
        confidence: s.confidence,
        model: suggester.model,
        reasonCt: s.reason ? encText(dataKey, s.reason, id, "reason_ct", 1) : null,
      });
      written += 1;
    }
    return written;
  });
}

// ---------------------------------------------------------------------------
// The user path
// ---------------------------------------------------------------------------

export interface SetEntryCategoryOptions {
  /** Also write a rule so future transactions matching this text get the
   * same category. The text is normalized before it is stored. */
  createRule?: { matchText: string };
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
      const matchText = normalizeDescription(opts.createRule.matchText);
      if (matchText !== "") {
        ruleChanged = await upsertDescriptionRule(tx, userId, dataKey, {
          matchText,
          categoryId,
          name: matchText,
        });
      }
    } else {
      ruleChanged = await learnCategoryRule(tx, userId, dataKey, description, categoryId);
    }

    // A new rule that only applies to transactions not yet scraped would be
    // useless the moment it is written; run it over everything still
    // uncategorized. Entries that already have a category are untouched —
    // `categorizeEntries` only ever writes where `category_id` IS NULL.
    if (ruleChanged) {
      await categorizeEntries(tx, userId, dataKey, await uncategorizedEntryIds(tx));
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
    matchText: description,
    categoryId,
    name: `Learned: ${description}`,
  });
}

/**
 * Creates — or retargets — the single `description contains <matchText>`
 * rule for this text. Retargeting rather than duplicating is Maybe's
 * `eligible_for_category_rule?` dedupe: a user who re-categorizes the same
 * merchant twice should end up with one rule, not two contradictory ones.
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
  input: { matchText: string; categoryId: string; name: string },
): Promise<boolean> {
  // Condition values are encrypted, so finding "the rule for this text"
  // means decrypting the ruleset — which loadContext already does.
  const { compiled } = await loadContext(tx, dataKey, { activeOnly: false });
  const existing = compiled.find(
    (r) =>
      r.conditions.length === 1 &&
      r.conditions[0].conditionType === "description" &&
      r.conditions[0].operator === "contains" &&
      r.conditions[0].value === input.matchText,
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
    operator: "contains",
    valueCt: encText(dataKey, input.matchText, conditionId, "value_ct", 1),
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

    await tx.delete(categorySuggestions).where(eq(categorySuggestions.categoryId, categoryId));
    await tx
      .update(recurringSeries)
      .set({ categoryId: null })
      .where(eq(recurringSeries.categoryId, categoryId));

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

    // Saving a rule runs it immediately over everything still uncategorized —
    // a rule that only took effect on the next scrape would look broken.
    // Already-categorized entries are safe: `categorizeEntries` writes only
    // where `category_id` IS NULL, and a hand-set category is locked besides.
    const categorized = await categorizeEntries(
      tx,
      userId,
      dataKey,
      await uncategorizedEntryIds(tx),
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
    return categorizeEntries(tx, userId, dataKey, await uncategorizedEntryIds(tx));
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
