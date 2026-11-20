// src/domain/recurring.ts — payees that stopped, and payees that are one bill
// paid from several places. Both change what a category costs per month.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { encryptField, getDevUserDataKey, type AadContext } from "@/lib/crypto";
import { getRecurringView, type RecurringGroup } from "@/domain/recurring";
import type { Session } from "@/lib/auth/session-store";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

function enc(dataKey: Uint8Array, rowId: string, column: string, value: string): Buffer {
  const aad: AadContext = { rowId, column, version: 1 };
  return encryptField(dataKey, Buffer.from(value, "utf8"), aad);
}

let userId: string;
let dataKey: Uint8Array;
let session: Session;
let accountId: string;

async function insertEntry(description: string, date: string, amount: string, categoryId: string) {
  const id = randomUUID();
  await elevatedDb.insert(schema.entries).values({
    id,
    ownerId: userId,
    accountId,
    entryType: "transaction",
    date,
    descriptionCt: enc(dataKey, id, "description_ct", description),
    categoryId,
    status: "posted",
    enteredAmountCt: enc(dataKey, id, "entered_amount_ct", amount),
    enteredCurrency: "ILS",
    accountAmountCt: enc(dataKey, id, "account_amount_ct", amount),
    accountCurrency: "ILS",
    reportingCurrency: "ILS",
    fxRate: "1",
    fxRateDate: date,
    fxSource: "test",
    fxStatus: "locked",
    source: "scrape",
  });
}

async function insertCategory(name: string): Promise<string> {
  const id = randomUUID();
  await elevatedDb
    .insert(schema.categories)
    .values({ id, ownerId: userId, name, classification: "expense", isRecurring: true });
  return id;
}

function group(groups: RecurringGroup[], name: string): RecurringGroup {
  const g = groups.find((x) => x.categoryName === name);
  if (!g) throw new Error(`no group ${name}`);
  return g;
}

describe("getRecurringView — stopped and pooled payees", () => {
  beforeAll(async () => {
    userId = randomUUID();
    dataKey = getDevUserDataKey(userId);
    await elevatedDb
      .insert(schema.users)
      .values({ id: userId, email: `rec-${randomUUID()}@test.moni`, baseCurrency: "ILS" });
    accountId = randomUUID();
    await elevatedDb.insert(schema.accounts).values({
      id: accountId,
      ownerId: userId,
      accountType: "credit_card",
      classification: "liability",
      nameCt: enc(dataKey, accountId, "name_ct", "Card"),
      currentBalanceCt: enc(dataKey, accountId, "current_balance_ct", "0"),
      currency: "ILS",
    });

    const savings = await insertCategory("Savings");
    const meds = await insertCategory("Medication");
    const subs = await insertCategory("Subscriptions");

    // The data runs to 2026-11-20 — "stopped" is judged from there.
    // Savings: one deposit in August and nothing since (stopped, dimmed);
    // one in January (stopped long enough ago to be hidden); one live.
    await insertEntry("OLD PENSION", "2026-01-10", "-900.00", savings);
    await insertEntry("HAREL PENSION", "2026-08-01", "-1685.00", savings);
    await insertEntry("MIGDAL PENSION", "2026-09-20", "-500.00", savings);
    await insertEntry("MIGDAL PENSION", "2026-10-20", "-500.00", savings);
    await insertEntry("MIGDAL PENSION", "2026-11-20", "-500.00", savings);

    // Medication: one need, two sources, never in the same month.
    await insertEntry("PHARMACY", "2026-08-03", "-375.00", meds);
    await insertEntry("PHARMACY", "2026-09-02", "-375.00", meds);
    await insertEntry("PHARMACY", "2026-10-04", "-375.00", meds);
    await insertEntry("BIT TRANSFER", "2026-11-03", "-339.00", meds);

    // Subscriptions: two concurrent monthlies — never pooled.
    for (const m of ["08", "09", "10", "11"]) {
      await insertEntry("NETFLIX", `2026-${m}-05`, "-50.00", subs);
      await insertEntry("SPOTIFY", `2026-${m}-15`, "-20.00", subs);
    }

    session = {
      id: "test-session",
      userId,
      dataKey: Buffer.from(dataKey),
      baseCurrency: "ILS",
      syncPromptDismissed: false,
      expiresAt: Date.now() + 3_600_000,
    };
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  it("dims a payee that stopped and leaves it out of the per-month figure", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const g = group(view.expenses, "Savings");
    const harel = g.rows.find((r) => r.matchText === "harel pension");
    expect(harel?.stopped).toBe(true);
    expect(harel?.lastPaidLabel).toBe("1 Aug 2026");
    // Migdal alone: 500/mo. Harel's 1685 is gone from it.
    expect(g.monthlyAverage.amount).toBe("500");
    // Stopped rows sort last.
    expect(g.rows.at(-1)?.matchText).toBe("harel pension");
  });

  it("hides a stopped payee 180 days after its last payment, but keeps the money in the range total", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const g = group(view.expenses, "Savings");
    expect(g.rows.map((r) => r.matchText)).not.toContain("old pension");
    expect(g.total.amount).toBe("4085");
  });

  it("reads two sources of one purchase as one monthly bill", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const g = group(view.expenses, "Medication");
    expect(g.pools).toHaveLength(1);
    const pool = g.pools[0];
    expect(pool.cadence).toBe("monthly");
    expect(pool.paymentCount).toBe(4);
    // (375 + 375 + 339) / 3 — one purchase a month, not two.
    expect(pool.averageOfLast3.amount).toBe("363");
    expect(g.monthlyAverage.amount).toBe("363");
    expect(g.monthlyAverageIsEstimate).toBe(false);
    // Newest source first.
    expect(pool.rowIds.map((id) => g.rows.find((r) => r.id === id)?.matchText)).toEqual([
      "bit transfer",
      "pharmacy",
    ]);
  });

  it("does not pool concurrent subscriptions", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const g = group(view.expenses, "Subscriptions");
    expect(g.pools).toEqual([]);
    expect(g.monthlyAverage.amount).toBe("70");
  });
});
