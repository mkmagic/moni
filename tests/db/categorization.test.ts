// src/domain/categorization.ts — the DB-backed half of the categorization
// pipeline: default-category seeding, the ingest hook, attribute locking,
// learned rules, and rules CRUD. The pure matcher is covered separately in
// tests/unit/categorization-engine.test.ts.
//
// Calls promoteScrapeResult() directly, no spawn, following
// tests/db/reconciliation.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { unlockCredentialKey } from "@/domain/auth";
import { createConnection } from "@/domain/connections";
import { promoteScrapeResult, startSyncRun } from "@/domain/sync-promotion";
import {
  deleteRule,
  listCategories,
  listRules,
  recategorizeUncategorized,
  rejectSuggestion,
  setEntryCategory,
  suggestCategories,
  setRuleActive,
  syncDefaultCategories,
  upsertRule,
} from "@/domain/categorization";
import { listEntries } from "@/domain/transactions";
import { getOverview } from "@/domain/dashboard";
import type { Session } from "@/lib/auth/session-store";
import type { ScraperAccount, ScraperTransaction } from "@/lib/connectors";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface Fixture {
  userId: string;
  dataKey: Buffer;
  connectionId: string;
  session: Session;
}

const createdUserIds: string[] = [];

async function freshFixture(label: string): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  createdUserIds.push(userId);
  const credentialKey = await unlockCredentialKey(userId, password);
  if (!credentialKey) throw new Error("test setup: failed to unlock credential key");
  const { id: connectionId } = await createConnection(
    userId,
    "leumi",
    { username: "dana", password: "hunter2" },
    credentialKey,
  );
  // Only the three fields the domain functions under test actually read.
  const session = { id: randomUUID(), userId, dataKey, baseCurrency: "ILS" } as Session;
  return { userId, dataKey, connectionId, session };
}

function txn(overrides: Partial<ScraperTransaction> = {}): ScraperTransaction {
  return {
    type: "normal",
    identifier: randomUUID().slice(0, 8),
    date: "2026-06-01",
    processedDate: "2026-06-01",
    originalAmount: -100,
    originalCurrency: "ILS",
    chargedAmount: -100,
    chargedCurrency: "ILS",
    description: "Coffee shop",
    status: "completed",
    ...overrides,
  };
}

async function scrape(fx: Fixture, txns: ScraperTransaction[]) {
  const accounts: ScraperAccount[] = [
    { accountNumber: "123456", balance: 5000, balanceDate: "2026-06-10", currency: "ILS", txns },
  ];
  const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
  return promoteScrapeResult({
    userId: fx.userId,
    dataKey: fx.dataKey,
    connectionId: fx.connectionId,
    connectorId: "leumi",
    syncRunId,
    accounts,
  });
}

async function categoryNameFor(fx: Fixture, description: string): Promise<string | null> {
  const rows = await listEntries(fx.session, { limit: 200 });
  return rows.find((e) => e.description === description)?.categoryName ?? null;
}

async function categoryIdByBuiltinKey(userId: string, builtinKey: string): Promise<string> {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.builtinKey, builtinKey));
    if (!row) throw new Error(`no seeded category ${builtinKey}`);
    return row.id;
  });
}

/** A second connection on the same user, from a card issuer rather than a
 * bank — so its accounts are classified `liability`. */
async function cardScrape(fx: Fixture, txns: ScraperTransaction[]) {
  const credentialKey = await unlockCredentialKey(
    fx.userId,
    Buffer.from("correct horse battery staple", "utf8"),
  );
  if (!credentialKey) throw new Error("test setup: failed to unlock credential key");
  const { id: connectionId } = await createConnection(
    fx.userId,
    "max",
    { username: "dana", password: "hunter2" },
    credentialKey,
  );
  const syncRunId = await startSyncRun(fx.userId, connectionId);
  return promoteScrapeResult({
    userId: fx.userId,
    dataKey: fx.dataKey,
    connectionId,
    connectorId: "max",
    syncRunId,
    accounts: [
      { accountNumber: "998877", balance: -2400, balanceDate: today(), currency: "ILS", txns },
    ],
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

afterAll(async () => cleanupOwners(createdUserIds));

describe("default category seeding", () => {
  it("gives a new user the full two-level tree, with no orphans and nothing deeper than one level", async () => {
    const fx = await freshFixture("cat-seed");
    const rows = await listCategories(fx.session);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const parents = rows.filter((r) => !r.parentId);
    expect(parents.length).toBe(11);
    expect(rows.length - parents.length).toBe(50);

    expect(rows.filter((r) => r.parentId && !byId.has(r.parentId))).toEqual([]);
    expect(rows.filter((r) => r.parentId && byId.get(r.parentId)?.parentId)).toEqual([]);
  });

  it("gives every child its parent's classification and color", async () => {
    const fx = await freshFixture("cat-inherit");
    const rows = await listCategories(fx.session);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const child of rows.filter((r) => r.parentId)) {
      const parent = byId.get(child.parentId!)!;
      expect(child.classification).toBe(parent.classification);
      expect(child.color).toBe(parent.color);
    }
  });

  it("seeds the Israeli-specific categories the generic taxonomies lack", async () => {
    const fx = await freshFixture("cat-israel");
    const keys = ["housing-arnona", "housing-vaad-bayit", "health-fund", "transport-car-insurance"];
    for (const key of keys) {
      await expect(categoryIdByBuiltinKey(fx.userId, key)).resolves.toBeTruthy();
    }
  });

  it("re-seeding adds only what is missing, and never renames what the user renamed", async () => {
    const fx = await freshFixture("cat-resync");
    const before = await listCategories(fx.session);

    // Simulate both halves of an upgrade: the user has renamed a shipped
    // category, and a newly shipped one is absent from their tree.
    const groceriesId = await categoryIdByBuiltinKey(fx.userId, "food-groceries");
    await withUser(fx.userId, async (tx) => {
      await tx
        .update(schema.categories)
        .set({ name: "סופר" })
        .where(eq(schema.categories.id, groceriesId));
      await tx
        .delete(schema.categories)
        .where(eq(schema.categories.builtinKey, "transfers-card-payment"));
    });

    expect(await syncDefaultCategories(fx.userId)).toBe(1);
    expect(await syncDefaultCategories(fx.userId)).toBe(0);

    const after = await listCategories(fx.session);
    expect(after).toHaveLength(before.length);
    // `builtin_key` is the identity, not the name — the rename survives.
    expect(after.find((c) => c.id === groceriesId)?.name).toBe("סופר");
  });
});

describe("categorizeEntries via the ingest path", () => {
  it("categorizes scraped Israeli merchants from the built-in table", async () => {
    const fx = await freshFixture("cat-ingest");
    const summary = await scrape(fx, [
      txn({ description: "שופרסל דיל 1234" }),
      txn({ description: "ארנונה עיריית תל אביב" }),
      txn({ description: "NETFLIX.COM" }),
      txn({ description: "חנות בלתי מזוהה כלשהי" }),
    ]);

    expect(summary.newEntries).toBe(4);
    expect(summary.categorized).toBe(3);
    expect(await categoryNameFor(fx, "שופרסל דיל 1234")).toBe("Groceries");
    expect(await categoryNameFor(fx, "ארנונה עיריית תל אביב")).toBe("Arnona (Municipal Tax)");
    expect(await categoryNameFor(fx, "NETFLIX.COM")).toBe("Subscriptions");
    expect(await categoryNameFor(fx, "חנות בלתי מזוהה כלשהי")).toBeNull();
  });

  it("leaves the uncategorized tail in the review queue", async () => {
    const fx = await freshFixture("cat-queue");
    await scrape(fx, [
      txn({ description: "שופרסל דיל" }),
      txn({ description: "חנות בלתי מזוהה כלשהי" }),
    ]);
    const queue = await listEntries(fx.session, { uncategorized: true });
    expect(queue.map((e) => e.description)).toEqual(["חנות בלתי מזוהה כלשהי"]);
  });

  it("stays idempotent: a re-scrape adds no entries and re-categorizes nothing", async () => {
    const fx = await freshFixture("cat-idem");
    const txns = [txn({ identifier: "R1", description: "שופרסל דיל" })];
    await scrape(fx, txns);
    const second = await scrape(fx, txns);
    expect(second.newEntries).toBe(0);
    expect(second.matchedUnchanged).toBe(1);
    expect(second.categorized).toBe(0);
    expect((await listEntries(fx.session, { limit: 100 })).length).toBe(1);
  });

  it("does not bump entries.version, so the row's ciphertext still decrypts", async () => {
    const fx = await freshFixture("cat-version");
    await scrape(fx, [txn({ description: "שופרסל דיל" })]);
    const rows = await withUser(fx.userId, async (tx) => tx.select().from(schema.entries));
    expect(rows[0].version).toBe(1);
    // The real proof: listEntries decrypts description and amount against
    // that version and would throw if the AAD no longer matched.
    const [view] = await listEntries(fx.session, { limit: 10 });
    expect(view.description).toBe("שופרסל דיל");
    expect(view.categoryName).toBe("Groceries");
  });

  it("records rule-sourced assignments in entry_field_changelog", async () => {
    const fx = await freshFixture("cat-changelog");
    await scrape(fx, [txn({ description: "שופרסל דיל" })]);
    const log = await withUser(fx.userId, async (tx) =>
      tx.select().from(schema.entryFieldChangelog),
    );
    expect(log).toHaveLength(1);
    expect(log[0].fieldName).toBe("category_id");
    expect(log[0].source).toBe("rule");
  });
});

describe("manual override and attribute locking", () => {
  it("sets the category, locks the field, and logs the change as user-sourced", async () => {
    const fx = await freshFixture("cat-manual");
    await scrape(fx, [txn({ description: "חנות בלתי מזוהה כלשהי" })]);
    const [entry] = await listEntries(fx.session, { uncategorized: true });
    const restaurantsId = await categoryIdByBuiltinKey(fx.userId, "food-restaurants");

    await setEntryCategory(fx.session, entry.id, restaurantsId);

    const [updated] = await listEntries(fx.session, { limit: 10 });
    expect(updated.categoryName).toBe("Restaurants & Cafés");
    expect(updated.categoryLocked).toBe(true);

    const log = await withUser(fx.userId, async (tx) =>
      tx
        .select()
        .from(schema.entryFieldChangelog)
        .where(eq(schema.entryFieldChangelog.source, "user")),
    );
    expect(log).toHaveLength(1);
  });

  it("does not repurpose entries.source — a scraped entry stays 'scrape'", async () => {
    const fx = await freshFixture("cat-source");
    await scrape(fx, [txn({ description: "חנות בלתי מזוהה כלשהי" })]);
    const [entry] = await listEntries(fx.session, { uncategorized: true });
    await setEntryCategory(
      fx.session,
      entry.id,
      await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
    );
    const rows = await withUser(fx.userId, async (tx) => tx.select().from(schema.entries));
    expect(rows[0].source).toBe("scrape");
  });

  it("a user's correction survives a re-scrape and a re-categorization pass", async () => {
    const fx = await freshFixture("cat-correction");
    // A merchant the built-in table WOULD categorize as groceries.
    await scrape(fx, [txn({ identifier: "L1", description: "שופרסל דיל" })]);
    const [entry] = await listEntries(fx.session, { limit: 10 });
    const restaurantsId = await categoryIdByBuiltinKey(fx.userId, "food-restaurants");
    await setEntryCategory(fx.session, entry.id, restaurantsId);

    await scrape(fx, [txn({ identifier: "L1", description: "שופרסל דיל" })]);
    await recategorizeUncategorized(fx.session);

    const [after] = await listEntries(fx.session, { limit: 10 });
    expect(after.categoryName).toBe("Restaurants & Cafés");
  });

  it("skips a locked entry even when its category is null", async () => {
    // The guard in categorizeEntries, exercised directly. The test has to
    // build this state by hand because no user-facing path produces it
    // today (clearing a category also releases the lock) — but the guard is
    // what makes "the user is the only actor who can override a locked
    // attribute" (domain-layer.md §3.2) true for every future writer,
    // including a model pass that locks after declining to answer.
    const fx = await freshFixture("cat-lock-guard");
    await scrape(fx, [txn({ description: "שופרסל דיל" })]);
    const [entry] = await listEntries(fx.session, { limit: 10 });

    await withUser(fx.userId, async (tx) =>
      tx
        .update(schema.entries)
        .set({ categoryId: null, lockedAttributes: { category_id: true } })
        .where(eq(schema.entries.id, entry.id)),
    );

    await recategorizeUncategorized(fx.session);

    const [after] = await listEntries(fx.session, { limit: 10 });
    expect(after.categoryName).toBeNull();
    expect(after.categoryLocked).toBe(true);
  });

  it("clearing the category releases the lock, so automation can pick it up again", async () => {
    const fx = await freshFixture("cat-unlock");
    await scrape(fx, [txn({ description: "שופרסל דיל" })]);
    const [entry] = await listEntries(fx.session, { limit: 10 });

    await setEntryCategory(fx.session, entry.id, null);
    const [cleared] = await listEntries(fx.session, { limit: 10 });
    expect(cleared.categoryName).toBeNull();
    expect(cleared.categoryLocked).toBe(false);

    await recategorizeUncategorized(fx.session);
    const [recategorized] = await listEntries(fx.session, { limit: 10 });
    expect(recategorized.categoryName).toBe("Groceries");
  });
});

describe("credit-card settlement", () => {
  it("keeps the monthly card charge out of expenses, so card purchases aren't counted twice", async () => {
    const fx = await freshFixture("cat-settlement");
    // The card purchase, on the card account.
    await cardScrape(fx, [
      txn({ identifier: "C1", date: today(), processedDate: today(), description: "שופרסל דיל" }),
    ]);
    // The bank's aggregate payoff of that same card, a month later.
    await scrape(fx, [
      txn({
        identifier: "S1",
        date: today(),
        processedDate: today(),
        originalAmount: -100,
        chargedAmount: -100,
        description: "ישראכרט",
      }),
    ]);

    expect(await categoryNameFor(fx, "שופרסל דיל")).toBe("Groceries");
    expect(await categoryNameFor(fx, "ישראכרט")).toBe("Credit Card Payment");

    // 100 of spending happened, and it is counted once — not 200.
    const overview = await getOverview(fx.session);
    expect(overview.monthlyExpenses.amount).toBe("100");
  });

  it("still counts a card issuer's own charge on the card account as an expense", async () => {
    const fx = await freshFixture("cat-cardfee");
    await cardScrape(fx, [
      txn({
        identifier: "F1",
        date: today(),
        processedDate: today(),
        originalAmount: -29.9,
        chargedAmount: -29.9,
        description: "ישראכרט",
      }),
    ]);

    // Same text, opposite meaning: on the card itself this is a real charge,
    // and `onlyOn: "asset"` is what keeps the settlement rule off it.
    expect(await categoryNameFor(fx, "ישראכרט")).not.toBe("Credit Card Payment");
    expect((await getOverview(fx.session)).monthlyExpenses.amount).toBe("29.9");
  });
});

describe("rules", () => {
  it("a user rule beats the built-in table", async () => {
    const fx = await freshFixture("cat-userrule");
    const restaurantsId = await categoryIdByBuiltinKey(fx.userId, "food-restaurants");
    await upsertRule(fx.session, {
      name: "Shufersal is dining out, apparently",
      active: true,
      effectiveDate: null,
      categoryId: restaurantsId,
      conditions: [{ conditionType: "description", operator: "contains", value: "שופרסל" }],
    });

    await scrape(fx, [txn({ description: "שופרסל דיל" })]);
    expect(await categoryNameFor(fx, "שופרסל דיל")).toBe("Restaurants & Cafés");
  });

  it("effective_date keeps a new rule off older entries", async () => {
    const fx = await freshFixture("cat-effective");
    await upsertRule(fx.session, {
      name: "Only from July",
      active: true,
      effectiveDate: "2026-07-01",
      categoryId: await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
      conditions: [{ conditionType: "description", operator: "contains", value: "מסתורי" }],
    });

    await scrape(fx, [
      txn({ identifier: "E1", date: "2026-06-15", description: "חיוב מסתורי" }),
      txn({ identifier: "E2", date: "2026-07-15", description: "חיוב מסתורי" }),
    ]);

    const rows = await listEntries(fx.session, { limit: 10 });
    expect(rows.find((e) => e.date === "2026-06-15")?.categoryName).toBeNull();
    expect(rows.find((e) => e.date === "2026-07-15")?.categoryName).toBe("Restaurants & Cafés");
  });

  it("deactivating a rule takes it out of evaluation", async () => {
    const fx = await freshFixture("cat-inactive");
    const { id: ruleId } = await upsertRule(fx.session, {
      name: "Mystery charges are travel",
      active: true,
      effectiveDate: null,
      categoryId: await categoryIdByBuiltinKey(fx.userId, "entertainment-travel"),
      conditions: [{ conditionType: "description", operator: "contains", value: "מסתורי" }],
    });

    await setRuleActive(fx.session, ruleId, false);
    await scrape(fx, [txn({ description: "חיוב מסתורי" })]);
    expect(await categoryNameFor(fx, "חיוב מסתורי")).toBeNull();

    // Switching it back on runs it over what is still uncategorized — no
    // separate backfill call, and no waiting for the next scrape.
    expect(await setRuleActive(fx.session, ruleId, true)).toBe(1);
    expect(await categoryNameFor(fx, "חיוב מסתורי")).toBe("Travel & Vacation");
  });

  it("saving a rule categorizes matching entries that are already in the ledger", async () => {
    const fx = await freshFixture("cat-backfill");
    await scrape(fx, [
      txn({ identifier: "B1", description: "חיוב מסתורי" }),
      txn({ identifier: "B2", description: "חיוב אחר" }),
    ]);
    expect(await listEntries(fx.session, { uncategorized: true })).toHaveLength(2);

    const { categorized } = await upsertRule(fx.session, {
      name: "Mystery charges are travel",
      active: true,
      effectiveDate: null,
      categoryId: await categoryIdByBuiltinKey(fx.userId, "entertainment-travel"),
      conditions: [{ conditionType: "description", operator: "contains", value: "מסתורי" }],
    });

    expect(categorized).toBe(1);
    expect(await categoryNameFor(fx, "חיוב מסתורי")).toBe("Travel & Vacation");
    // The non-matching entry is left alone, not swept up by the pass.
    expect(await categoryNameFor(fx, "חיוב אחר")).toBeNull();
  });

  it("saving a rule does not overwrite a category the user set by hand", async () => {
    const fx = await freshFixture("cat-backfill-lock");
    await scrape(fx, [txn({ description: "חיוב מסתורי" })]);
    const [entry] = await listEntries(fx.session, { uncategorized: true });
    await setEntryCategory(
      fx.session,
      entry.id,
      await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
    );

    await upsertRule(fx.session, {
      name: "Mystery charges are travel",
      active: true,
      effectiveDate: null,
      categoryId: await categoryIdByBuiltinKey(fx.userId, "entertainment-travel"),
      conditions: [{ conditionType: "description", operator: "contains", value: "מסתורי" }],
    });

    expect(await categoryNameFor(fx, "חיוב מסתורי")).toBe("Restaurants & Cafés");
  });

  it("round-trips an encrypted condition value through listRules", async () => {
    const fx = await freshFixture("cat-listrules");
    await upsertRule(fx.session, {
      name: "Vaad bayit",
      active: true,
      effectiveDate: null,
      categoryId: await categoryIdByBuiltinKey(fx.userId, "housing-vaad-bayit"),
      conditions: [{ conditionType: "description", operator: "contains", value: "ועד בית" }],
    });

    const [rule] = await listRules(fx.session);
    expect(rule.conditions[0].value).toBe("ועד בית");
    // The value is wrapped in a Unicode bidi isolate (U+2068/U+2069) so a
    // Hebrew merchant name can't reorder the surrounding quotes and operator.
    expect(rule.summary).toBe('description contains "\u2068ועד בית\u2069"');
    expect(rule.categoryName).toBe("Vaad Bayit");
    expect(rule.learned).toBe(false);
  });

  it("deleting a rule removes its conditions and actions", async () => {
    const fx = await freshFixture("cat-delrule");
    const { id: ruleId } = await upsertRule(fx.session, {
      name: "Doomed",
      active: true,
      effectiveDate: null,
      categoryId: await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
      conditions: [{ conditionType: "description", operator: "contains", value: "משהו" }],
    });

    await deleteRule(fx.session, ruleId);

    const leftovers = await withUser(fx.userId, async (tx) => ({
      rules: await tx.select().from(schema.rules),
      conditions: await tx.select().from(schema.ruleConditions),
      actions: await tx.select().from(schema.ruleActions),
    }));
    expect(leftovers.rules).toEqual([]);
    expect(leftovers.conditions).toEqual([]);
    expect(leftovers.actions).toEqual([]);
  });
});

describe("learning from past corrections", () => {
  /** Categorizes `count` sightings of the same merchant, one at a time. */
  async function correctSightings(fx: Fixture, description: string, count: number) {
    const categoryId = await categoryIdByBuiltinKey(fx.userId, "food-restaurants");
    for (let i = 0; i < count; i++) {
      await scrape(fx, [txn({ identifier: `S${i}`, description })]);
      const queue = await listEntries(fx.session, { uncategorized: true });
      const target = queue.find((e) => e.description === description);
      if (target) await setEntryCategory(fx.session, target.id, categoryId);
    }
  }

  it("writes no rule after two agreeing corrections", async () => {
    const fx = await freshFixture("cat-learn2");
    await correctSightings(fx, "חנות מסתורית", 2);
    expect(await listRules(fx.session)).toEqual([]);
  });

  it("materializes a visible, deletable rule after three agreeing corrections", async () => {
    const fx = await freshFixture("cat-learn3");
    await correctSightings(fx, "חנות מסתורית", 3);

    const rules = await listRules(fx.session);
    expect(rules).toHaveLength(1);
    expect(rules[0].learned).toBe(true);
    expect(rules[0].name).toBe("Learned: חנות מסתורית");
    expect(rules[0].categoryName).toBe("Restaurants & Cafés");
    expect(rules[0].conditions[0].value).toBe("חנות מסתורית");
  });

  it("the rule written from the dialog backfills sibling entries, including older ones", async () => {
    const fx = await freshFixture("cat-createrule");
    await scrape(fx, [
      txn({ description: "חנות בלתי מזוהה", date: "2026-06-01", processedDate: "2026-06-01" }),
      // Dated well before the rule is written: an `effective_date` of today
      // would leave this one uncategorized, which is the whole point.
      txn({ description: "חנות בלתי מזוהה", date: "2026-02-14", processedDate: "2026-02-14" }),
    ]);
    const pending = await listEntries(fx.session, { uncategorized: true });
    expect(pending).toHaveLength(2);

    await setEntryCategory(
      fx.session,
      pending[0].id,
      await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
      { createRule: { operator: "contains", value: "חנות בלתי מזוהה" } },
    );

    const rules = await listRules(fx.session);
    expect(rules).toHaveLength(1);
    expect(rules[0].effectiveDate).toBeNull();
    expect(await listEntries(fx.session, { uncategorized: true })).toHaveLength(0);
  });

  it("re-categorizing the same merchant retargets the one rule instead of duplicating it", async () => {
    const fx = await freshFixture("cat-retarget");
    await scrape(fx, [txn({ description: "חנות בלתי מזוהה" })]);
    const [entry] = await listEntries(fx.session, { uncategorized: true });

    await setEntryCategory(
      fx.session,
      entry.id,
      await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
      { createRule: { operator: "contains", value: "חנות בלתי מזוהה" } },
    );
    await setEntryCategory(
      fx.session,
      entry.id,
      await categoryIdByBuiltinKey(fx.userId, "entertainment-travel"),
      { createRule: { operator: "contains", value: "חנות בלתי מזוהה" } },
    );

    const rules = await listRules(fx.session);
    expect(rules).toHaveLength(1);
    expect(rules[0].categoryName).toBe("Travel & Vacation");
  });

  it("an edited rule value reaches siblings the full match text never would", async () => {
    const fx = await freshFixture("cat-widened");
    // Neither text is in the built-in table, so both arrive uncategorized and
    // the assertion can only be satisfied by the rule under test.
    await scrape(fx, [
      txn({ description: "חנות בלתי מזוהה סניף א" }),
      txn({ description: "חנות בלתי מזוהה אונליין", identifier: "b2" }),
    ]);
    const pending = await listEntries(fx.session, { uncategorized: true });
    expect(pending).toHaveLength(2);
    const target = pending.find((e) => e.description === "חנות בלתי מזוהה סניף א")!;

    // The old checkbox could only send the whole match text, which matches
    // exactly one of these two. Editing it down is the entire point.
    await setEntryCategory(
      fx.session,
      target.id,
      await categoryIdByBuiltinKey(fx.userId, "food-groceries"),
      { createRule: { operator: "contains", value: "חנות בלתי מזוהה" } },
    );

    expect(await categoryNameFor(fx, "חנות בלתי מזוהה אונליין")).toBe("Groceries");
  });

  it("a user rule displaces a category the built-in table already assigned", async () => {
    // "יאלנס רכבת" is a café. The built-in `רכבת` (train) rule claims it on
    // sight, so both entries arrive already categorized as Public Transport —
    // and a backfill that only filled blanks would never revisit the sibling.
    const fx = await freshFixture("cat-displace");
    await scrape(fx, [
      txn({ description: "יאלנס רכבת" }),
      txn({ description: "יאלנס רכבת", identifier: "b2", date: "2026-05-11" }),
    ]);
    const all = await listEntries(fx.session, { limit: 200 });
    const both = all.filter((e) => e.description === "יאלנס רכבת");
    expect(both).toHaveLength(2);
    expect(both.map((e) => e.categoryName)).toEqual(["Public Transport", "Public Transport"]);

    await setEntryCategory(
      fx.session,
      both[0].id,
      await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
      { createRule: { operator: "equals", value: "יאלנס רכבת" } },
    );

    const after = await listEntries(fx.session, { limit: 200 });
    const names = after.filter((e) => e.description === "יאלנס רכבת").map((e) => e.categoryName);
    expect(names).toEqual(["Restaurants & Cafés", "Restaurants & Cafés"]);
  });

  it("a hand-set category survives a later rule that would have filed it elsewhere", async () => {
    const fx = await freshFixture("cat-locked-wins");
    await scrape(fx, [
      txn({ description: "חנות בלתי מזוהה" }),
      txn({ description: "חנות בלתי מזוהה", identifier: "b2", date: "2026-05-11" }),
    ]);
    const pending = await listEntries(fx.session, { uncategorized: true });

    // Filed by hand, no rule — this one is locked.
    await setEntryCategory(
      fx.session,
      pending[0].id,
      await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
    );
    // Now a rule that covers the same text, from the sibling.
    await setEntryCategory(
      fx.session,
      pending[1].id,
      await categoryIdByBuiltinKey(fx.userId, "entertainment-travel"),
      { createRule: { operator: "contains", value: "חנות" } },
    );

    const after = await listEntries(fx.session, { limit: 200 });
    const byId = new Map(after.map((e) => [e.id, e.categoryName]));
    expect(byId.get(pending[0].id)).toBe("Restaurants & Cafés");
    expect(byId.get(pending[1].id)).toBe("Travel & Vacation");
  });

  it("narrowing to 'is exactly' writes a second rule rather than rewriting the broad one", async () => {
    const fx = await freshFixture("cat-operator");
    await scrape(fx, [txn({ description: "חנות בלתי מזוהה" })]);
    const [entry] = await listEntries(fx.session, { uncategorized: true });

    await setEntryCategory(
      fx.session,
      entry.id,
      await categoryIdByBuiltinKey(fx.userId, "food-restaurants"),
      { createRule: { operator: "contains", value: "חנות" } },
    );
    await setEntryCategory(
      fx.session,
      entry.id,
      await categoryIdByBuiltinKey(fx.userId, "entertainment-travel"),
      { createRule: { operator: "equals", value: "חנות בלתי מזוהה" } },
    );

    const rules = await listRules(fx.session);
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.conditions[0].operator).sort()).toEqual(["contains", "equals"]);
  });
});

describe("rules-only mode", () => {
  it("the whole pipeline completes with no model backend configured", async () => {
    const fx = await freshFixture("cat-rulesonly");
    const summary = await scrape(fx, [
      txn({ description: "שופרסל דיל" }),
      txn({ description: "חנות בלתי מזוהה כלשהי" }),
    ]);
    expect(summary.categorized).toBe(1);

    // The tail is still reachable for the user to clear by hand, and layer 3
    // reaches no network at all — a Moni with nothing configured is whole.
    const queue = await listEntries(fx.session, { uncategorized: true });
    expect(queue).toHaveLength(1);
    await expect(
      suggestCategories(fx.session, [{ id: queue[0].id, matchText: queue[0].matchText }]),
    ).resolves.toBeDefined();
  });
});

describe("suggestions", () => {
  /** Categorizes `description` by hand, which is what puts it into the
   * suggestion corpus. Returns the category it was filed under. */
  async function fileByHand(fx: Fixture, description: string, builtinKey: string): Promise<string> {
    const rows = await listEntries(fx.session, { limit: 200 });
    const entry = rows.find((e) => e.description === description);
    if (!entry) throw new Error(`no entry ${description}`);
    const categoryId = await categoryIdByBuiltinKey(fx.userId, builtinKey);
    await setEntryCategory(fx.session, entry.id, categoryId);
    return categoryId;
  }

  async function suggestFor(fx: Fixture, description: string) {
    const queue = await listEntries(fx.session, { uncategorized: true });
    const entry = queue.find((e) => e.description === description);
    if (!entry) throw new Error(`${description} is not uncategorized`);
    const out = await suggestCategories(fx.session, [{ id: entry.id, matchText: entry.matchText }]);
    return { entry, suggestion: out[entry.id] ?? null };
  }

  it("suggests from a near-miss the rule layer cannot match", async () => {
    const fx = await freshFixture("cat-suggest-nearmiss");
    // A made-up merchant, so nothing in the built-in table can reach it and
    // the suggestion can only come from the user's own history.
    await scrape(fx, [
      txn({ description: "מרקטפלייס גלעדי סניף חולון" }),
      txn({ description: "מרקטפלייס גלעדי אונליין" }),
    ]);

    const categoryId = await fileByHand(fx, "מרקטפלייס גלעדי סניף חולון", "food-groceries");

    const { suggestion } = await suggestFor(fx, "מרקטפלייס גלעדי אונליין");
    expect(suggestion?.categoryId).toBe(categoryId);
    expect(suggestion?.matchedSource).toBe("entry");
    expect(suggestion?.matchedText).toBe("מרקטפלייס גלעדי סניף חולון");
  });

  it("a rejection suppresses the pairing for every entry sharing the match text", async () => {
    const fx = await freshFixture("cat-suggest-reject");
    await scrape(fx, [
      txn({ description: "מרקטפלייס גלעדי סניף חולון" }),
      txn({ description: "מרקטפלייס גלעדי אונליין" }),
      txn({ description: "מרקטפלייס גלעדי אונליין", identifier: "second" }),
    ]);
    const categoryId = await fileByHand(fx, "מרקטפלייס גלעדי סניף חולון", "food-groceries");

    const before = await suggestFor(fx, "מרקטפלייס גלעדי אונליין");
    expect(before.suggestion?.categoryId).toBe(categoryId);

    await rejectSuggestion(fx.session, before.entry.matchText, categoryId);

    // Both entries share the match text, so one thumbs-down clears both.
    const queue = await listEntries(fx.session, { uncategorized: true });
    const targets = queue.filter((e) => e.description === "מרקטפלייס גלעדי אונליין");
    expect(targets).toHaveLength(2);
    const after = await suggestCategories(
      fx.session,
      targets.map((e) => ({ id: e.id, matchText: e.matchText })),
    );
    for (const target of targets) {
      expect(after[target.id]?.categoryId).not.toBe(categoryId);
    }
  });

  it("rejecting suppresses suggestions only — a rule still assigns the category", async () => {
    const fx = await freshFixture("cat-suggest-reject-rule");
    await scrape(fx, [txn({ description: "מרקטפלייס גלעדי אונליין" })]);
    const categoryId = await categoryIdByBuiltinKey(fx.userId, "food-groceries");
    const queue = await listEntries(fx.session, { uncategorized: true });

    await rejectSuggestion(fx.session, queue[0].matchText, categoryId);

    await upsertRule(fx.session, {
      name: "Giladi",
      active: true,
      effectiveDate: null,
      categoryId,
      conditions: [{ conditionType: "description", operator: "contains", value: "מרקטפלייס" }],
    });

    expect(await categoryNameFor(fx, "מרקטפלייס גלעדי אונליין")).not.toBeNull();
  });

  it("rejections are idempotent", async () => {
    const fx = await freshFixture("cat-suggest-reject-twice");
    const categoryId = await categoryIdByBuiltinKey(fx.userId, "food-groceries");
    await rejectSuggestion(fx.session, "מרקטפלייס גלעדי", categoryId);
    await rejectSuggestion(fx.session, "מרקטפלייס גלעדי", categoryId);

    const rows = await withUser(fx.userId, async (tx) =>
      tx.select().from(schema.categoryRejections),
    );
    expect(rows).toHaveLength(1);
  });

  it("the user's own history outranks the shipped built-in table", async () => {
    const fx = await freshFixture("cat-suggest-precedence");
    // Neither description contains a built-in needle as a SUBSTRING, so
    // layer 2 leaves both alone and the question reaches layer 3 — where the
    // built-in "רמי לוי" and the user's own filing both score above the bar
    // and disagree. Cosine favours the shorter built-in text, so only the
    // corpus ordering keeps the user's answer on top.
    await scrape(fx, [
      txn({ description: "לוי רמי מרקט סניף" }),
      txn({ description: "לוי רמי מרקט" }),
    ]);

    const homeId = await fileByHand(fx, "לוי רמי מרקט סניף", "housing-maintenance");
    const groceriesId = await categoryIdByBuiltinKey(fx.userId, "food-groceries");
    expect(homeId).not.toBe(groceriesId);

    const { suggestion } = await suggestFor(fx, "לוי רמי מרקט");
    expect(suggestion?.categoryId).toBe(homeId);
    expect(suggestion?.matchedSource).toBe("entry");
  });

  it("cold start: a built-in merchant is suggested with no history at all", async () => {
    const fx = await freshFixture("cat-suggest-coldstart");
    // Built-in matching is substring-based, so a reordered name — which
    // issuers do emit — misses layer 2 entirely. Token similarity does not
    // care about order, and this user has no history of their own.
    await scrape(fx, [txn({ description: "לוי רמי" })]);
    const { suggestion } = await suggestFor(fx, "לוי רמי");
    expect(suggestion?.matchedSource).toBe("builtin");
    expect(suggestion?.categoryName).toBe("Groceries");
  });
});

describe("cross-user isolation", () => {
  it("one user's rules never categorize another user's entries", async () => {
    const a = await freshFixture("cat-iso-a");
    const b = await freshFixture("cat-iso-b");

    await upsertRule(a.session, {
      name: "A's rule",
      active: true,
      effectiveDate: null,
      categoryId: await categoryIdByBuiltinKey(a.userId, "entertainment-travel"),
      conditions: [{ conditionType: "description", operator: "contains", value: "משותף" }],
    });

    await scrape(b, [txn({ description: "חיוב משותף" })]);
    expect(await categoryNameFor(b, "חיוב משותף")).toBeNull();
    expect(await listRules(b.session)).toEqual([]);

    // Sanity: the same rule does fire for its own owner.
    await scrape(a, [txn({ description: "חיוב משותף" })]);
    expect(await categoryNameFor(a, "חיוב משותף")).toBe("Travel & Vacation");
  });

  it("a rule cannot target another user's category", async () => {
    const a = await freshFixture("cat-iso-cat-a");
    const b = await freshFixture("cat-iso-cat-b");
    const aCategoryId = await categoryIdByBuiltinKey(a.userId, "food-restaurants");

    await expect(
      upsertRule(b.session, {
        name: "Cross-tenant rule",
        active: true,
        effectiveDate: null,
        categoryId: aCategoryId,
        conditions: [{ conditionType: "description", operator: "contains", value: "x" }],
      }),
    ).rejects.toThrow();
  });
});

describe("condition types beyond description", () => {
  it("matches on amount and account, ANDed together", async () => {
    const fx = await freshFixture("cat-conditions");
    await scrape(fx, [
      txn({
        identifier: "C1",
        description: "חיוב גדול",
        originalAmount: -900,
        chargedAmount: -900,
      }),
      txn({ identifier: "C2", description: "חיוב קטן", originalAmount: -20, chargedAmount: -20 }),
    ]);
    const [anyEntry] = await listEntries(fx.session, { limit: 1 });

    await upsertRule(fx.session, {
      name: "Big charges on this account",
      active: true,
      effectiveDate: null,
      categoryId: await categoryIdByBuiltinKey(fx.userId, "entertainment-travel"),
      conditions: [
        { conditionType: "amount", operator: "gt", value: "500" },
        { conditionType: "account", operator: "eq", value: anyEntry.accountId },
      ],
    });

    await recategorizeUncategorized(fx.session);
    expect(await categoryNameFor(fx, "חיוב גדול")).toBe("Travel & Vacation");
    expect(await categoryNameFor(fx, "חיוב קטן")).toBeNull();
  });

  it("supports a one-level `any` group", async () => {
    const fx = await freshFixture("cat-group");
    await upsertRule(fx.session, {
      name: "Either merchant",
      active: true,
      effectiveDate: null,
      categoryId: await categoryIdByBuiltinKey(fx.userId, "entertainment-travel"),
      conditions: [
        {
          conditionType: "group",
          operator: "any",
          value: "",
          children: [
            { conditionType: "description", operator: "contains", value: "אלפא" },
            { conditionType: "description", operator: "contains", value: "ביתא" },
          ],
        },
      ],
    });

    await scrape(fx, [
      txn({ identifier: "G1", description: "חיוב אלפא" }),
      txn({ identifier: "G2", description: "חיוב ביתא" }),
      txn({ identifier: "G3", description: "חיוב גאמא" }),
    ]);

    expect(await categoryNameFor(fx, "חיוב אלפא")).toBe("Travel & Vacation");
    expect(await categoryNameFor(fx, "חיוב ביתא")).toBe("Travel & Vacation");
    expect(await categoryNameFor(fx, "חיוב גאמא")).toBeNull();
  });
});
