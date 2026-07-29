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
import { listEntries, NO_CATEGORY } from "@/domain/transactions";
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

const session: Session = {
  id: "test-session",
  userId,
  dataKey: Buffer.from(dataKey),
  baseCurrency: "ILS",
  promptSyncOnLogin: false,
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
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  it("returns every entry when no filter is given", async () => {
    const rows = await listEntries(session);
    expect(rows).toHaveLength(4);
  });

  it("filters to a single category", async () => {
    const rows = await listEntries(session, { categoryId: groceriesId });
    expect(rows.map((r) => r.id)).toEqual([inGroceries]);
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
