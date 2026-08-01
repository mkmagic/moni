// src/domain/categorization.ts — the category CRUD behind the Categories tab:
// the tree read with usage counts, the depth-1 and inheritance invariants,
// and what deleting a category does to the rows that pointed at it.
//
// The categorization *engine* is covered by tests/db/categorization.test.ts;
// this file is only about managing the categories themselves.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import { promoteScrapeResult, startSyncRun } from "@/domain/sync-promotion";
import {
  BuiltinCategoryError,
  CategoryHasChildrenError,
  InvalidCategoryNestingError,
  createCategory,
  deleteCategory,
  listCategoryTree,
  listRules,
  setEntryCategory,
  syncDefaultCategories,
  updateCategory,
  upsertRule,
} from "@/domain/categorization";
import { listEntries } from "@/domain/transactions";
import type { Session } from "@/lib/auth/session-store";
import type { ScraperAccount, ScraperTransaction } from "@/lib/connectors";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

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
  const credentialKey = await enrollTestCredentialKey(userId);
  const { id: connectionId } = await createConnection(
    userId,
    "leumi",
    { username: "dana", password: "hunter2" },
    credentialKey,
  );
  const session = { id: randomUUID(), userId, dataKey, baseCurrency: "ILS" } as Session;
  return { userId, dataKey, connectionId, session };
}

async function scrape(fx: Fixture, descriptions: string[]) {
  const txns: ScraperTransaction[] = descriptions.map((description) => ({
    type: "normal",
    identifier: randomUUID().slice(0, 8),
    date: "2026-06-01",
    processedDate: "2026-06-01",
    originalAmount: -100,
    originalCurrency: "ILS",
    chargedAmount: -100,
    chargedCurrency: "ILS",
    description,
    status: "completed",
  }));
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

async function entryIdFor(fx: Fixture, description: string): Promise<string> {
  const rows = await listEntries(fx.session, { limit: 200 });
  const row = rows.find((e) => e.description === description);
  if (!row) throw new Error(`no entry for ${description}`);
  return row.id;
}

async function rawCategory(userId: string, id: string) {
  return withUser(userId, async (tx) => {
    const [row] = await tx.select().from(schema.categories).where(eq(schema.categories.id, id));
    return row ?? null;
  });
}

afterAll(async () => {
  await cleanupOwners(createdUserIds);
});

describe("listCategoryTree", () => {
  it("returns the shipped set as groups with children, all marked built-in", async () => {
    const fx = await freshFixture("cat-tree");
    const groups = await listCategoryTree(fx.session);

    expect(groups.length).toBe(11);
    expect(groups.every((g) => g.builtin)).toBe(true);
    expect(groups.every((g) => g.parentId === null)).toBe(true);
    expect(groups.flatMap((g) => g.children).length).toBe(50);

    const transfers = groups.find((g) => g.name === "Transfers");
    expect(transfers?.classification).toBe("transfer");
    // Children inherit their group's classification, so a transfer group can
    // never contain an expense child (src/domain/flows.ts depends on this).
    expect(transfers?.children.every((c) => c.classification === "transfer")).toBe(true);
  });

  it("counts the transactions filed under each category", async () => {
    const fx = await freshFixture("cat-counts");
    // Two known Israeli supermarkets — the built-in rules file both under
    // Groceries, so the count lands on the child, not the group.
    await scrape(fx, ["שופרסל דיל", "רמי לוי שיווק"]);

    const groups = await listCategoryTree(fx.session);
    const food = groups.find((g) => g.name === "Food & Drink");
    const groceries = food?.children.find((c) => c.name === "Groceries");
    expect(groceries?.entryCount).toBe(2);
    expect(food?.entryCount).toBe(0);
  });

  it("counts the rules that target a category", async () => {
    const fx = await freshFixture("cat-rulecount");
    const groups = await listCategoryTree(fx.session);
    const target = groups
      .find((g) => g.name === "Food & Drink")!
      .children.find((c) => c.name === "Restaurants & Cafés")!;

    await upsertRule(fx.session, {
      name: "Cafelix",
      active: true,
      effectiveDate: null,
      categoryId: target.id,
      conditions: [{ conditionType: "description", operator: "contains", value: "cafelix" }],
    });

    const after = await listCategoryTree(fx.session);
    const reread = after
      .find((g) => g.name === "Food & Drink")!
      .children.find((c) => c.name === "Restaurants & Cafés")!;
    expect(reread.ruleCount).toBe(1);
  });
});

describe("createCategory", () => {
  it("creates a top-level group with its own classification and color", async () => {
    const fx = await freshFixture("cat-create-group");
    const id = await createCategory(fx.session, {
      name: "  Side Hustle  ",
      parentId: null,
      classification: "income",
      color: "chart-2",
      icon: "coins",
    });

    const row = await rawCategory(fx.userId, id);
    expect(row?.name).toBe("Side Hustle");
    expect(row?.classification).toBe("income");
    expect(row?.color).toBe("chart-2");
    // Null builtin_key is what keeps `categories:sync` from touching it and
    // what makes it deletable.
    expect(row?.builtinKey).toBeNull();
  });

  it("forces a subcategory to inherit its parent's classification and color", async () => {
    const fx = await freshFixture("cat-inherit");
    const groups = await listCategoryTree(fx.session);
    const transfers = groups.find((g) => g.name === "Transfers")!;

    const id = await createCategory(fx.session, {
      name: "Paybox",
      parentId: transfers.id,
      // Deliberately wrong on both counts: the caller does not get to decide.
      classification: "expense",
      color: "chart-1",
      icon: "smartphone",
    });

    const row = await rawCategory(fx.userId, id);
    expect(row?.classification).toBe("transfer");
    expect(row?.color).toBe(transfers.color);
    expect(row?.icon).toBe("smartphone");
  });

  it("refuses a third level of nesting", async () => {
    const fx = await freshFixture("cat-depth");
    const groups = await listCategoryTree(fx.session);
    const child = groups.find((g) => g.name === "Food & Drink")!.children[0];

    await expect(
      createCategory(fx.session, {
        name: "Too deep",
        parentId: child.id,
        classification: "expense",
        color: "chart-1",
        icon: "tag",
      }),
    ).rejects.toBeInstanceOf(InvalidCategoryNestingError);
  });

  it("refuses an empty name, an unknown icon, and an unknown color", async () => {
    const fx = await freshFixture("cat-validate");
    const base = {
      parentId: null,
      classification: "expense" as const,
      color: "chart-1",
      icon: "tag",
    };

    await expect(createCategory(fx.session, { ...base, name: "   " })).rejects.toBeInstanceOf(
      InvalidCategoryNestingError,
    );
    await expect(
      createCategory(fx.session, { ...base, name: "X", icon: "not-a-lucide-icon" }),
    ).rejects.toBeInstanceOf(InvalidCategoryNestingError);
    // A raw color value is exactly what the token rule forbids
    // (docs/design/ui-and-feel.md).
    await expect(
      createCategory(fx.session, { ...base, name: "X", color: "#ff0000" }),
    ).rejects.toBeInstanceOf(InvalidCategoryNestingError);
  });
});

describe("updateCategory", () => {
  it("renames a built-in without disturbing its builtin_key, so a sync doesn't duplicate it", async () => {
    const fx = await freshFixture("cat-rename-builtin");
    const groups = await listCategoryTree(fx.session);
    const healthFund = groups
      .find((g) => g.name === "Healthcare")!
      .children.find((c) => c.name === "Health Fund")!;

    await updateCategory(fx.session, healthFund.id, {
      name: "Kupat Holim",
      parentId: healthFund.parentId,
      classification: healthFund.classification,
      color: healthFund.color!,
      icon: "stethoscope",
    });

    const added = await syncDefaultCategories(fx.userId);
    expect(added).toBe(0);

    const row = await rawCategory(fx.userId, healthFund.id);
    expect(row?.name).toBe("Kupat Holim");
    expect(row?.builtinKey).toBe("health-fund");
  });

  it("pushes a group's classification and color down to its children", async () => {
    const fx = await freshFixture("cat-propagate");
    const groups = await listCategoryTree(fx.session);
    const giving = groups.find((g) => g.name === "Gifts & Donations")!;

    await updateCategory(fx.session, giving.id, {
      name: giving.name,
      parentId: null,
      classification: "transfer",
      color: "chart-5",
      icon: giving.icon!,
    });

    const after = await listCategoryTree(fx.session);
    const reread = after.find((g) => g.id === giving.id)!;
    expect(reread.children.length).toBeGreaterThan(0);
    expect(reread.children.every((c) => c.classification === "transfer")).toBe(true);
    expect(reread.children.every((c) => c.color === "chart-5")).toBe(true);
  });

  it("refuses to turn a group that still has children into a subcategory", async () => {
    const fx = await freshFixture("cat-demote");
    const groups = await listCategoryTree(fx.session);
    const food = groups.find((g) => g.name === "Food & Drink")!;
    const shopping = groups.find((g) => g.name === "Shopping")!;

    await expect(
      updateCategory(fx.session, food.id, {
        name: food.name,
        parentId: shopping.id,
        classification: food.classification,
        color: food.color!,
        icon: food.icon!,
      }),
    ).rejects.toBeInstanceOf(InvalidCategoryNestingError);
  });

  it("refuses to make a category its own parent", async () => {
    const fx = await freshFixture("cat-self-parent");
    const groups = await listCategoryTree(fx.session);
    const child = groups.find((g) => g.name === "Shopping")!.children[0];

    await expect(
      updateCategory(fx.session, child.id, {
        name: child.name,
        parentId: child.id,
        classification: child.classification,
        color: child.color!,
        icon: child.icon!,
      }),
    ).rejects.toBeInstanceOf(InvalidCategoryNestingError);
  });
});

describe("deleteCategory", () => {
  it("refuses to delete a built-in, because categories:sync would put it straight back", async () => {
    const fx = await freshFixture("cat-del-builtin");
    const groups = await listCategoryTree(fx.session);
    const groceries = groups
      .find((g) => g.name === "Food & Drink")!
      .children.find((c) => c.name === "Groceries")!;

    await expect(deleteCategory(fx.session, groceries.id)).rejects.toBeInstanceOf(
      BuiltinCategoryError,
    );
  });

  it("refuses to delete a group that still has subcategories", async () => {
    const fx = await freshFixture("cat-del-parent");
    const parentId = await createCategory(fx.session, {
      name: "Pets",
      parentId: null,
      classification: "expense",
      color: "chart-3",
      icon: "dog",
    });
    await createCategory(fx.session, {
      name: "Vet",
      parentId,
      classification: "expense",
      color: "chart-3",
      icon: "stethoscope",
    });

    await expect(deleteCategory(fx.session, parentId)).rejects.toBeInstanceOf(
      CategoryHasChildrenError,
    );
  });

  it("uncategorizes its transactions, releases the attribute lock, and deletes its rules", async () => {
    const fx = await freshFixture("cat-del-cascade");
    await scrape(fx, ["Cafelix Rothschild"]);

    const parentId = await createCategory(fx.session, {
      name: "Pets",
      parentId: null,
      classification: "expense",
      color: "chart-3",
      icon: "dog",
    });
    const vetId = await createCategory(fx.session, {
      name: "Vet",
      parentId,
      classification: "expense",
      color: "chart-3",
      icon: "stethoscope",
    });

    const entryId = await entryIdFor(fx, "Cafelix Rothschild");
    // Setting it by hand is what locks `category_id`.
    await setEntryCategory(fx.session, entryId, vetId);
    await upsertRule(fx.session, {
      name: "Vet visits",
      active: true,
      effectiveDate: null,
      categoryId: vetId,
      conditions: [{ conditionType: "description", operator: "contains", value: "cafelix" }],
    });

    const locked = await withUser(fx.userId, async (tx) => {
      const [row] = await tx.select().from(schema.entries).where(eq(schema.entries.id, entryId));
      return row;
    });
    expect(locked?.categoryId).toBe(vetId);
    expect(locked?.lockedAttributes).toEqual({ category_id: true });

    await deleteCategory(fx.session, vetId);

    const after = await withUser(fx.userId, async (tx) => {
      const [row] = await tx.select().from(schema.entries).where(eq(schema.entries.id, entryId));
      return row;
    });
    expect(after?.categoryId).toBeNull();
    // The lock recorded "a human chose this"; the thing they chose is gone,
    // so keeping it would freeze the entry out of categorization for good.
    expect(after?.lockedAttributes).toEqual({});

    expect(await listRules(fx.session)).toEqual([]);
    const orphanConditions = await withUser(fx.userId, (tx) =>
      tx.select().from(schema.ruleConditions),
    );
    expect(orphanConditions).toEqual([]);
    expect(await rawCategory(fx.userId, vetId)).toBeNull();
  });
});
