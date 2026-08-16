// `listEntries` Income/Payment and expense-size filters (issue #107). Unlike
// date and category, these depend on the decrypted amount, so they run after
// decryption. The load-bearing property pinned here is COMPLETENESS: the scan
// reaches past the display `limit`, so a filter over a range finds its matches
// even when they are older than the newest page — otherwise the newest `limit`
// rows would be filtered and the leftovers passed off as the whole answer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { encryptField, getDevUserDataKey, type AadContext } from "@/lib/crypto";
import { listEntries } from "@/domain/transactions";
import type { Session } from "@/lib/auth/session-store";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

function enc(dataKey: Uint8Array, rowId: string, column: string, value: string): Buffer {
  const aad: AadContext = { rowId, column, version: 1 };
  return encryptField(dataKey, Buffer.from(value, "utf8"), aad);
}

const userId = randomUUID();
const dataKey = getDevUserDataKey(userId);
const accountId = randomUUID();
const expenseCat = randomUUID();
const incomeCat = randomUUID();
const transferCat = randomUUID();

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
  amount: string;
  currency?: string;
  categoryId?: string | null;
  excluded?: boolean;
  pending?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const currency = opts.currency ?? "ILS";
  await elevatedDb.insert(schema.entries).values({
    id,
    ownerId: userId,
    accountId,
    entryType: "transaction",
    date: opts.date,
    descriptionCt: enc(dataKey, id, "description_ct", "row"),
    status: "posted",
    categoryId: opts.categoryId ?? null,
    excluded: opts.excluded ?? false,
    enteredAmountCt: enc(dataKey, id, "entered_amount_ct", opts.amount),
    enteredCurrency: currency,
    accountAmountCt: enc(dataKey, id, "account_amount_ct", opts.amount),
    accountCurrency: currency,
    reportingCurrency: "ILS",
    fxRate: "1",
    fxRateDate: opts.date,
    fxSource: "test",
    fxStatus: opts.pending ? "pending" : "locked",
    source: "manual",
  });
  return id;
}

// Newest rows are the non-income ones, so an income filter that finds the
// January rows can only have scanned past them.
const payments: string[] = [];
let smallPayment: string;
let transfer: string;
let excludedInflow: string;
let pendingUsdPayment: string;
const incomes: string[] = [];

describe("listEntries — Income/Payment and size", () => {
  beforeAll(async () => {
    await elevatedDb
      .insert(schema.users)
      .values({ id: userId, email: `flow-${randomUUID()}@test.moni`, baseCurrency: "ILS" });
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
      { id: expenseCat, ownerId: userId, name: "Shopping", classification: "expense" },
      { id: incomeCat, ownerId: userId, name: "Salary", classification: "income" },
      { id: transferCat, ownerId: userId, name: "Transfer", classification: "transfer" },
    ]);

    // Four large payments + one small, newest in the ledger.
    for (const [i, date] of ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"].entries()) {
      payments.push(await addEntry({ date, amount: "-1500.00", categoryId: expenseCat }));
      void i;
    }
    smallPayment = await addEntry({ date: "2026-08-14", amount: "-40.00", categoryId: expenseCat });
    transfer = await addEntry({ date: "2026-08-15", amount: "-2000.00", categoryId: transferCat });
    excludedInflow = await addEntry({
      date: "2026-08-16",
      amount: "500.00",
      categoryId: incomeCat,
      excluded: true,
    });
    pendingUsdPayment = await addEntry({
      date: "2026-08-17",
      amount: "-3000.00",
      currency: "USD",
      categoryId: expenseCat,
      pending: true,
    });

    // Three large incomes, the oldest rows — past any small display window.
    for (const date of ["2026-01-05", "2026-01-06", "2026-01-07"]) {
      incomes.push(await addEntry({ date, amount: "8000.00", categoryId: incomeCat }));
    }
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  it("finds income that is older than the display window (completeness)", async () => {
    // With a limit of 3 and eight newer non-income rows, a filter applied only
    // to the newest page would return nothing. The three January incomes prove
    // the scan reached past the page before filtering.
    const rows = await listEntries(session, { direction: "income", limit: 3 });
    expect(rows.map((r) => r.id).sort()).toEqual([...incomes].sort());
  });

  it("payment keeps every outflow, including a pending-FX one, and drops transfers/excluded/income", async () => {
    const rows = await listEntries(session, { direction: "payment" });
    expect(rows.map((r) => r.id).sort()).toEqual(
      [...payments, smallPayment, pendingUsdPayment].sort(),
    );
    expect(rows.map((r) => r.id)).not.toContain(transfer);
    expect(rows.map((r) => r.id)).not.toContain(excludedInflow);
  });

  it("size Large is magnitude-based and excludes pending-FX rows", async () => {
    const rows = await listEntries(session, { size: "l" });
    // Large (>₪1,000): the four 1,500 payments, the three 8,000 incomes, and
    // the 2,000 transfer (size ignores classification). The 3,000 USD payment
    // is pending, so its amount is not a ₪ figure and it is excluded.
    expect(rows.map((r) => r.id).sort()).toEqual([...payments, ...incomes, transfer].sort());
    expect(rows.map((r) => r.id)).not.toContain(pendingUsdPayment);
    expect(rows.map((r) => r.id)).not.toContain(smallPayment);
  });

  it("composes direction and size — Large payments only", async () => {
    const rows = await listEntries(session, { direction: "payment", size: "l" });
    expect(rows.map((r) => r.id).sort()).toEqual([...payments].sort());
  });

  it("leaves the read unchanged when neither filter is set", async () => {
    const rows = await listEntries(session, { direction: "all", size: "all" });
    expect(rows).toHaveLength(11);
  });
});
