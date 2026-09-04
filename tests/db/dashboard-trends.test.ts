// src/domain/dashboard.ts + getBudgetSummary — the figures the redesigned
// dashboard's insight panel reads. Three things worth pinning:
//
//   * netWorthTrend compares now against the oldest TRACKED month (from the
//     user's join month, never a pre-join zero) and carries that span.
//   * netWorthHistory is trimmed to start at the month the user joined, so the
//     months before they tracked accounts here don't read as a false spike.
//   * getBudgetSummary names the over-budget categories, not just their count.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Session } from "@/lib/auth/session-store";
import * as schema from "@/db/schema";
import { getOverview } from "@/domain/dashboard";
import { getBudgetSummary, setCeiling } from "@/domain/budget";
import { createCategory } from "@/domain/categorization";
import { encText } from "@/domain/fields";
import { israelDate } from "@/domain/investment-valuation";
import { createUser } from "@/domain/registration";
import { cleanupOwners, elevatedDb } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface Fixture {
  userId: string;
  dataKey: Buffer;
  session: Session;
  accountId: string;
}

const owners: string[] = [];
afterAll(() => cleanupOwners(owners));

async function fixture(): Promise<Fixture> {
  const { userId, dataKey } = await createUser(
    `${randomUUID()}@trends.test`,
    Buffer.from("pw"),
    SIGNUP_TOKEN!,
  );
  owners.push(userId);
  // createUser stamps createdAt = now; the dashboard trims net-worth history to
  // the join month, so backdate it well before the six-month window these tests
  // assert over. (The join-month trim itself is covered by its own test below.)
  await elevatedDb
    .update(schema.users)
    .set({ createdAt: new Date(Date.UTC(2000, 0, 1)) })
    .where(eq(schema.users.id, userId));
  const session = { id: randomUUID(), userId, dataKey, baseCurrency: "ILS" } as Session;
  const accountId = randomUUID();
  await elevatedDb.insert(schema.accounts).values({
    id: accountId,
    ownerId: userId,
    nameCt: encText(dataKey, "Card", accountId, "name_ct", 1),
    accountType: "credit_card",
    classification: "liability",
    currency: "ILS",
    currentBalanceCt: encText(dataKey, "0", accountId, "current_balance_ct", 1),
    status: "active",
  });
  return { userId, dataKey, session, accountId };
}

/** One posted, FX-locked ILS entry. `amount` is sign-carrying: negative spends. */
async function addEntry(
  fx: Fixture,
  date: string,
  amount: string,
  categoryId: string | null = null,
): Promise<void> {
  const id = randomUUID();
  await elevatedDb.insert(schema.entries).values({
    id,
    ownerId: fx.userId,
    accountId: fx.accountId,
    entryType: "transaction",
    date,
    descriptionCt: encText(fx.dataKey, "Purchase", id, "description_ct", 1),
    categoryId,
    status: "posted",
    enteredAmountCt: encText(fx.dataKey, amount, id, "entered_amount_ct", 1),
    enteredCurrency: "ILS",
    accountAmountCt: encText(fx.dataKey, amount, id, "account_amount_ct", 1),
    accountCurrency: "ILS",
    reportingCurrency: "ILS",
    fxRate: "1",
    fxRateDate: date,
    fxSource: "identity",
    fxStatus: "locked",
    source: "manual",
  });
}

// --- Dates, off the same clock the domain uses --------------------------------
const today = israelDate(new Date());
const curMonth = today.slice(0, 7);

function shiftMonthStart(monthStartUtc: Date, months: number): Date {
  const d = new Date(monthStartUtc);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
const curMonthStart = new Date(`${curMonth}-01T00:00:00Z`);
/** Last day of the month six months ago — the oldest point in netWorthHistory. */
const sixMonthsAgoEnd = (() => {
  const d = shiftMonthStart(curMonthStart, -5);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
})();

describe("dashboard netWorthHistory join-month trim", () => {
  it("drops the months before the user joined so the chart starts at their join month", async () => {
    const fx = await fixture();
    // This user joined two months ago. A pre-join snapshot would otherwise
    // carry forward across every earlier month in the window and read as a
    // false spike into the join month; the trim must leave only join month on.
    const joinMonthStart = shiftMonthStart(curMonthStart, -2);
    const joinMonth = joinMonthStart.toISOString().slice(0, 7);
    await elevatedDb
      .update(schema.users)
      .set({ createdAt: new Date(`${joinMonth}-15T12:00:00Z`) })
      .where(eq(schema.users.id, fx.userId));

    const accountId = randomUUID();
    const snapshotId = randomUUID();
    await elevatedDb.insert(schema.accounts).values({
      id: accountId,
      ownerId: fx.userId,
      nameCt: encText(fx.dataKey, "Savings", accountId, "name_ct", 1),
      accountType: "checking",
      classification: "asset",
      currency: "ILS",
      currentBalanceCt: encText(fx.dataKey, "100", accountId, "current_balance_ct", 1),
      status: "active",
    });
    // Snapshot dated four months ago — before the join. Without the trim it
    // would populate months five..one; with it, only the join month onward.
    const fourMonthsAgoEnd = (() => {
      const d = shiftMonthStart(curMonthStart, -3);
      d.setUTCDate(0);
      return d.toISOString().slice(0, 10);
    })();
    await elevatedDb.insert(schema.accountBalanceSnapshots).values({
      id: snapshotId,
      ownerId: fx.userId,
      accountId,
      date: fourMonthsAgoEnd,
      nativeBalanceCt: encText(fx.dataKey, "100", snapshotId, "native_balance_ct", 1),
      currency: "ILS",
      source: "manual",
    });

    const overview = await getOverview(fx.session);
    expect(overview.netWorthHistory.every((point) => point.month >= joinMonth)).toBe(true);
    expect(overview.netWorthHistory[0]?.month).toBe(joinMonth);
    // Join month + the month before this one (the window ends at last month).
    expect(overview.netWorthHistory).toHaveLength(2);
  });
});

describe("dashboard netWorthTrend", () => {
  it("compares net worth now against the oldest tracked month, labelled by span", async () => {
    const fx = await fixture();
    const accountId = randomUUID();
    const snapshotId = randomUUID();
    await elevatedDb.insert(schema.accounts).values({
      id: accountId,
      ownerId: fx.userId,
      nameCt: encText(fx.dataKey, "Savings", accountId, "name_ct", 1),
      accountType: "checking",
      classification: "asset",
      currency: "ILS",
      currentBalanceCt: encText(fx.dataKey, "130", accountId, "current_balance_ct", 1),
      status: "active",
    });
    await elevatedDb.insert(schema.accountBalanceSnapshots).values({
      id: snapshotId,
      ownerId: fx.userId,
      accountId,
      date: sixMonthsAgoEnd,
      nativeBalanceCt: encText(fx.dataKey, "100", snapshotId, "native_balance_ct", 1),
      currency: "ILS",
      source: "manual",
    });

    const overview = await getOverview(fx.session);
    expect(overview.netWorthHistory[0]?.amount).toBe("100");
    expect(overview.netWorth.amount).toBe("130");
    // This user joined in 2000 (see fixture), so all six window months are
    // tracked: baseline is six months ago and the badge reads "6mo".
    expect(overview.netWorthTrend).toEqual({ direction: "up", pct: 30, months: 6 });
  });

  it("measures growth from the join month, not a pre-join zero, and needs two months", async () => {
    const fx = await fixture();
    // Joined last month: the window has exactly one tracked month, so there is
    // no span to measure — no trend, and the hero hides its one-dot chart.
    const joinMonthStart = shiftMonthStart(curMonthStart, -1);
    const joinMonth = joinMonthStart.toISOString().slice(0, 7);
    await elevatedDb
      .update(schema.users)
      .set({ createdAt: new Date(`${joinMonth}-10T12:00:00Z`) })
      .where(eq(schema.users.id, fx.userId));

    const accountId = randomUUID();
    const snapshotId = randomUUID();
    await elevatedDb.insert(schema.accounts).values({
      id: accountId,
      ownerId: fx.userId,
      nameCt: encText(fx.dataKey, "Savings", accountId, "name_ct", 1),
      accountType: "checking",
      classification: "asset",
      currency: "ILS",
      currentBalanceCt: encText(fx.dataKey, "500", accountId, "current_balance_ct", 1),
      status: "active",
    });
    // A snapshot at the join month — a real balance, not zero. Six months ago it
    // did not exist, so the old code compared 500-now against a ~0 baseline and
    // produced an absurd percentage; the new baseline is the join month itself.
    const joinMonthEnd = (() => {
      const d = shiftMonthStart(curMonthStart, 0);
      d.setUTCDate(0);
      return d.toISOString().slice(0, 10);
    })();
    await elevatedDb.insert(schema.accountBalanceSnapshots).values({
      id: snapshotId,
      ownerId: fx.userId,
      accountId,
      date: joinMonthEnd,
      nativeBalanceCt: encText(fx.dataKey, "480", snapshotId, "native_balance_ct", 1),
      currency: "ILS",
      source: "manual",
    });

    const overview = await getOverview(fx.session);
    expect(overview.netWorthHistory).toHaveLength(1);
    expect(overview.netWorthTrend).toBeNull();
  });
});

describe("dashboard income/expense months trim", () => {
  it("drops leading zero-filled months so the flow chart starts at the first activity", async () => {
    const fx = await fixture();
    // A single expense three months ago. The window's earlier months are
    // zero-filled and must be trimmed away; the series starts at that month.
    const threeAgo = shiftMonthStart(curMonthStart, -3).toISOString().slice(0, 7);
    await addEntry(fx, `${threeAgo}-15`, "-200");

    const overview = await getOverview(fx.session);
    expect(overview.months[0]?.month).toBe(threeAgo);
    // First active month through the current month = four points, no leading zeros.
    expect(overview.months).toHaveLength(4);
    expect(overview.months.every((m) => m.month >= threeAgo)).toBe(true);
  });

  it("returns no months when there has been no activity at all", async () => {
    const fx = await fixture();
    const overview = await getOverview(fx.session);
    expect(overview.months).toEqual([]);
  });
});

describe("getBudgetSummary overCategories", () => {
  it("names the categories that are over, worst first", async () => {
    const fx = await fixture();
    const groceries = await createCategory(fx.session, {
      name: `Groceries-${randomUUID().slice(0, 6)}`,
      parentId: null,
      classification: "expense",
      color: "chart-1",
      icon: "tag",
    });
    const dining = await createCategory(fx.session, {
      name: `Dining-${randomUUID().slice(0, 6)}`,
      parentId: null,
      classification: "expense",
      color: "chart-2",
      icon: "tag",
    });
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "300",
      effectiveFrom: curMonth,
      rollover: false,
    });
    await setCeiling(fx.session, {
      categoryId: dining,
      amount: "100",
      effectiveFrom: curMonth,
      rollover: false,
    });
    await addEntry(fx, `${curMonth}-01`, "-500", groceries); // 200 over
    await addEntry(fx, `${curMonth}-01`, "-180", dining); // 80 over

    const summary = await getBudgetSummary(fx.session);
    expect(summary.overBudgetCount).toBe(2);
    expect(summary.overCategories.map((c) => ({ id: c.categoryId, over: c.over.amount }))).toEqual([
      { id: groceries, over: "200" }, // worst first
      { id: dining, over: "80" },
    ]);
  });
});
