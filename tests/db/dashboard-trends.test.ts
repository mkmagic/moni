// src/domain/dashboard.ts + getBudgetSummary — the figures the redesigned
// dashboard's insight panel reads. Three things worth pinning:
//
//   * expenseTrend is LIKE-FOR-LIKE: month-to-date vs the SAME day-span of the
//     previous month — never the in-progress month against a complete one
//     (which always reads "down"), and never a projection (why projectedSpend
//     was retired).
//   * netWorthTrend compares now against six months ago.
//   * getBudgetSummary names the over-budget categories, not just their count.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
const todayDay = Number(today.slice(8, 10));
const curMonth = today.slice(0, 7);

function shiftMonthStart(monthStartUtc: Date, months: number): Date {
  const d = new Date(monthStartUtc);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
const curMonthStart = new Date(`${curMonth}-01T00:00:00Z`);
const prevMonth = shiftMonthStart(curMonthStart, -1).toISOString().slice(0, 7);
const daysInPrevMonth = new Date(`${prevMonth}-01T00:00:00Z`);
daysInPrevMonth.setUTCMonth(daysInPrevMonth.getUTCMonth() + 1);
daysInPrevMonth.setUTCDate(0);
const prevMonthDays = daysInPrevMonth.getUTCDate();
/** Last day of the month six months ago — the oldest point in netWorthHistory. */
const sixMonthsAgoEnd = (() => {
  const d = shiftMonthStart(curMonthStart, -5);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
})();
const pad = (n: number) => String(n).padStart(2, "0");

describe("dashboard expenseTrend (like-for-like)", () => {
  it("compares this month to the same day-span of last month", async () => {
    const fx = await fixture();
    await addEntry(fx, `${prevMonth}-01`, "-200");
    await addEntry(fx, `${curMonth}-01`, "-100");

    const overview = await getOverview(fx.session);
    expect(overview.expenseTrend).toEqual({ direction: "down", pct: 50 });
  });

  it("excludes prior-month spending that falls after today's day-of-month", async () => {
    const fx = await fixture();
    await addEntry(fx, `${prevMonth}-01`, "-100"); // in the same day-span, always
    // A large charge later in the prior month than today's date. Counting it
    // (as a naive full-month comparison would) would swing the trend wildly; the
    // like-for-like rule must leave it out.
    const lateDay = todayDay + 1;
    if (lateDay <= prevMonthDays) {
      await addEntry(fx, `${prevMonth}-${pad(lateDay)}`, "-1000");
    }
    await addEntry(fx, `${curMonth}-01`, "-50");

    const overview = await getOverview(fx.session);
    // Baseline 100 (not 1100) vs current 50 -> down 50%. A full-month baseline
    // would have read ~down 95%.
    expect(overview.expenseTrend).toEqual({ direction: "down", pct: 50 });
  });

  it("is null when there is no comparable prior-period spend", async () => {
    const fx = await fixture();
    await addEntry(fx, `${curMonth}-01`, "-100");

    const overview = await getOverview(fx.session);
    expect(overview.expenseTrend).toBeNull();
  });
});

describe("dashboard netWorthTrend", () => {
  it("compares net worth now against six months ago", async () => {
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
    expect(overview.netWorthTrend).toEqual({ direction: "up", pct: 30 });
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
