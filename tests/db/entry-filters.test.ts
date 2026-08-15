// `listEntries` filtering (issue #14). The transactions table pushes the
// filters SQL can actually do — date range and category — down to Postgres,
// because those columns are plaintext. Payee and amount cannot go here at all
// (they are ciphertext), which is why the table filters them in the browser.
//
// The sharp edge pinned below: `uncategorized` is the *review queue* and also
// drops excluded rows, while `categoryId: NO_CATEGORY` is the table's plain
// "show me what has no category" and must keep them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { encryptField, getDevUserDataKey, type AadContext } from "@/lib/crypto";
import { listEntries } from "@/domain/transactions";
import { NO_CATEGORY } from "@/lib/transactions/filters";
import type { Session } from "@/lib/auth/session-store";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

function enc(dataKey: Uint8Array, rowId: string, column: string, value: string): Buffer {
  const aad: AadContext = { rowId, column, version: 1 };
  return encryptField(dataKey, Buffer.from(value, "utf8"), aad);
}

const userId = randomUUID();
const dataKey = getDevUserDataKey(userId);
const accountId = randomUUID();
const groceriesId = randomUUID();
const rentId = randomUUID();
const incomeId = randomUUID();
const salaryId = randomUUID();
const bonusId = randomUUID();

const session: Session = {
  id: "test-session",
  userId,
  dataKey: Buffer.from(dataKey),
  baseCurrency: "ILS",
  syncPromptDismissed: false,
  expiresAt: Date.now() + 3_600_000,
};

async function addEntry(opts: {
  date: string;
  description: string;
  categoryId?: string | null;
  excluded?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await elevatedDb.insert(schema.entries).values({
    id,
    ownerId: userId,
    accountId,
    entryType: "transaction",
    date: opts.date,
    descriptionCt: enc(dataKey, id, "description_ct", opts.description),
    status: "posted",
    categoryId: opts.categoryId ?? null,
    excluded: opts.excluded ?? false,
    enteredAmountCt: enc(dataKey, id, "entered_amount_ct", "-50.00"),
    enteredCurrency: "ILS",
    accountAmountCt: enc(dataKey, id, "account_amount_ct", "-50.00"),
    accountCurrency: "ILS",
    reportingCurrency: "ILS",
    fxRate: "1",
    fxRateDate: opts.date,
    fxSource: "test",
    fxStatus: "locked",
    source: "manual",
  });
  return id;
}

let inGroceries: string;
let inRent: string;
let plainUncategorized: string;
let excludedUncategorized: string;
let inSalary: string;
let inBonus: string;
let onIncomeItself: string;

describe("listEntries filters", () => {
  beforeAll(async () => {
    await elevatedDb
      .insert(schema.users)
      .values({ id: userId, email: `filters-${randomUUID()}@test.moni`, baseCurrency: "ILS" });

    await elevatedDb.insert(schema.accounts).values({
      id: accountId,
      ownerId: userId,
      accountType: "checking",
      classification: "asset",
      nameCt: enc(dataKey, accountId, "name_ct", "Checking"),
      currentBalanceCt: enc(dataKey, accountId, "current_balance_ct", "1000.00"),
      currency: "ILS",
    });

    await elevatedDb.insert(schema.categories).values([
      { id: groceriesId, ownerId: userId, name: "Groceries", classification: "expense" },
      { id: rentId, ownerId: userId, name: "Rent", classification: "expense" },
      { id: incomeId, ownerId: userId, name: "Income", classification: "income" },
      {
        id: salaryId,
        ownerId: userId,
        name: "Salary",
        classification: "income",
        parentId: incomeId,
      },
      { id: bonusId, ownerId: userId, name: "Bonus", classification: "income", parentId: incomeId },
    ]);

    inGroceries = await addEntry({
      date: "2026-03-10",
      description: "market",
      categoryId: groceriesId,
    });
    inRent = await addEntry({ date: "2026-05-01", description: "landlord", categoryId: rentId });
    plainUncategorized = await addEntry({ date: "2026-06-15", description: "mystery" });
    excludedUncategorized = await addEntry({
      date: "2026-06-20",
      description: "card settlement",
      excluded: true,
    });
    inSalary = await addEntry({ date: "2026-02-01", description: "payroll", categoryId: salaryId });
    inBonus = await addEntry({ date: "2026-02-05", description: "q4 bonus", categoryId: bonusId });
    onIncomeItself = await addEntry({
      date: "2026-02-09",
      description: "rebate",
      categoryId: incomeId,
    });
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  it("returns every entry when no filter is given", async () => {
    const rows = await listEntries(session);
    expect(rows).toHaveLength(7);
  });

  it("filters to a single category", async () => {
    const rows = await listEntries(session, { categoryId: groceriesId });
    expect(rows.map((r) => r.id)).toEqual([inGroceries]);
  });

  it("a parent category matches everything filed under its children", async () => {
    // Entries carry the subcategory they were filed under, so a parent is a
    // heading rather than a label. Filtering by "Income" and getting an empty
    // table while its children plainly have rows is the bug this pins.
    const rows = await listEntries(session, { categoryId: incomeId });
    expect(rows.map((r) => r.id).sort()).toEqual([inSalary, inBonus, onIncomeItself].sort());
  });

  it("a child category does not reach back up to its siblings", async () => {
    const rows = await listEntries(session, { categoryId: salaryId });
    expect(rows.map((r) => r.id)).toEqual([inSalary]);
  });

  it("a childless category still matches its own entries", async () => {
    // The parent's id stays in the expanded list — otherwise widening the
    // predicate would break every flat category.
    const rows = await listEntries(session, { categoryId: rentId });
    expect(rows.map((r) => r.id)).toEqual([inRent]);
  });

  it("filters to entries with no category, keeping excluded ones", async () => {
    // The table's Uncategorized option is a statement about the category
    // column and nothing else — an excluded transfer still has no category.
    const rows = await listEntries(session, { categoryId: NO_CATEGORY });
    expect(rows.map((r) => r.id).sort()).toEqual(
      [plainUncategorized, excludedUncategorized].sort(),
    );
  });

  it("the review-queue flag stays narrower than the category filter", async () => {
    // `uncategorized` also drops excluded rows: a transfer leg is not
    // "needing review", it is deliberately out of the totals.
    const rows = await listEntries(session, { uncategorized: true });
    expect(rows.map((r) => r.id)).toEqual([plainUncategorized]);
  });

  it("filters by an inclusive date range", async () => {
    const rows = await listEntries(session, { from: "2026-05-01", to: "2026-06-15" });
    expect(rows.map((r) => r.id).sort()).toEqual([inRent, plainUncategorized].sort());
  });

  it("combines a date range with a category filter", async () => {
    expect(
      await listEntries(session, { from: "2026-04-01", categoryId: groceriesId }),
    ).toHaveLength(0);
    expect(await listEntries(session, { from: "2026-01-01", categoryId: rentId })).toHaveLength(1);
  });
});
