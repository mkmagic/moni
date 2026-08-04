// src/domain/budget.ts — ceilings, not envelopes (issue #69 part B).
//
// The four things worth pinning down, because each of them is a decision
// rather than an implementation detail:
//
//   * a ceiling is effective-dated, so a finished month keeps the number that
//     was actually in force in it;
//   * a parent group and its subcategories can never both carry a ceiling —
//     otherwise "over budget" has two answers for one shekel;
//   * rollover carries surplus AND deficit, from the ceiling's own
//     `effective_from`, and flipping it on today does not rewrite the past;
//   * every total reconciles: budgeted spend + unbudgeted spend is all the
//     money that left, with no category quietly hidden.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { createCategory } from "@/domain/categorization";
import { encText } from "@/domain/fields";
import {
  BudgetBranchConflictError,
  BudgetCategoryNotBudgetableError,
  createCeilings,
  currentMonth,
  endCeiling,
  getBudgetHistory,
  getBudgetMonth,
  getBudgetSummary,
  listCeilings,
  monthRange,
  setCeiling,
  setPlannedIncome,
  shiftMonth,
  proposeBudget,
} from "@/domain/budget";
import type { Session } from "@/lib/auth/session-store";
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

const createdUserIds: string[] = [];

async function freshFixture(label: string): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  createdUserIds.push(userId);
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

/** One posted, FX-locked entry. `amount` is sign-carrying: negative spends. */
async function addEntry(
  fx: Fixture,
  date: string,
  amount: string,
  categoryId: string | null,
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

/** Flags a category recurring — the Fixed/Everyday split's only input. */
async function markRecurring(fx: Fixture, categoryId: string): Promise<void> {
  await elevatedDb
    .update(schema.categories)
    .set({ isRecurring: true })
    .where(eq(schema.categories.id, categoryId));
}

async function expenseCategory(fx: Fixture, name: string, parentId: string | null = null) {
  return createCategory(fx.session, {
    name: `${name}-${randomUUID().slice(0, 6)}`,
    parentId,
    classification: "expense",
    color: "chart-1",
    icon: "tag",
  });
}

/** The month picker's own months, so nothing here depends on the wall clock
 * beyond "these are in the past". */
const MONTH = "2026-03";
const PRIOR = shiftMonth(MONTH, -1);

afterAll(async () => cleanupOwners(createdUserIds));

describe("getBudgetMonth", () => {
  it("reports spend against the ceiling, and splits Fixed from Everyday", async () => {
    const fx = await freshFixture("budget-basic");
    const groceries = await expenseCategory(fx, "Groceries");
    const rent = await expenseCategory(fx, "Rent");
    // Rent is a recurring category — that flag, and only that flag, is what
    // puts a row in the Fixed section.
    await markRecurring(fx, rent);

    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await setCeiling(fx.session, {
      categoryId: rent,
      amount: "5000",
      effectiveFrom: MONTH,
      rollover: false,
    });

    await addEntry(fx, `${MONTH}-04`, "-1200", groceries);
    await addEntry(fx, `${MONTH}-18`, "-300", groceries);
    await addEntry(fx, `${MONTH}-01`, "-5000", rent);

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.hasBudget).toBe(true);
    expect(view.everyday.rows).toHaveLength(1);
    expect(view.fixed.rows).toHaveLength(1);

    const everyday = view.everyday.rows[0];
    expect(everyday.spent.amount).toBe("1500");
    expect(everyday.ceiling.amount).toBe("2000");
    expect(everyday.remaining.amount).toBe("500");
    expect(everyday.carriedIn).toBeNull();

    expect(view.fixed.rows[0].spent.amount).toBe("5000");
    expect(view.ceilingTotal.amount).toBe("7000");
    expect(view.spentTotal.amount).toBe("6500");
    expect(view.overBudgetCount).toBe(0);
  });

  it("nets a refund down instead of counting it as income", async () => {
    const fx = await freshFixture("budget-refund");
    const shopping = await expenseCategory(fx, "Shopping");
    await setCeiling(fx.session, {
      categoryId: shopping,
      amount: "1000",
      effectiveFrom: MONTH,
      rollover: false,
    });

    await addEntry(fx, `${MONTH}-05`, "-800", shopping);
    await addEntry(fx, `${MONTH}-09`, "200", shopping); // returned an item

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.everyday.rows[0].spent.amount).toBe("600");
    expect(view.actualIncome.amount).toBe("0");
  });

  it("counts spending in a subcategory against a ceiling on its parent", async () => {
    const fx = await freshFixture("budget-parent");
    const parent = await expenseCategory(fx, "Home");
    const child = await expenseCategory(fx, "Repairs", parent);

    await setCeiling(fx.session, {
      categoryId: parent,
      amount: "1500",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-07`, "-400", child);
    await addEntry(fx, `${MONTH}-08`, "-100", parent);

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.everyday.rows).toHaveLength(1);
    expect(view.everyday.rows[0].spent.amount).toBe("500");
    expect(view.unbudgetedSpend.amount).toBe("0");
  });

  it("collects everything with no ceiling into unbudgeted spending, so the totals reconcile", async () => {
    const fx = await freshFixture("budget-unbudgeted");
    const budgetedCategory = await expenseCategory(fx, "Groceries");
    const other = await expenseCategory(fx, "Hobbies");

    await setCeiling(fx.session, {
      categoryId: budgetedCategory,
      amount: "1000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-03`, "-600", budgetedCategory);
    await addEntry(fx, `${MONTH}-06`, "-250", other);
    await addEntry(fx, `${MONTH}-11`, "-90", null); // never categorized

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.everyday.rows[0].spent.amount).toBe("600");
    expect(view.unbudgetedSpend.amount).toBe("340");
    expect(view.spentTotal.amount).toBe("940");
  });

  it("marks a row over budget and counts it", async () => {
    const fx = await freshFixture("budget-over");
    const dining = await expenseCategory(fx, "Dining");
    await setCeiling(fx.session, {
      categoryId: dining,
      amount: "500",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-20`, "-720", dining);

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.everyday.rows[0].remaining.amount).toBe("-220");
    expect(view.overBudgetCount).toBe(1);
  });

  it("skips a pending-FX entry rather than valuing it at a made-up rate", async () => {
    const fx = await freshFixture("budget-pendingfx");
    const travel = await expenseCategory(fx, "Travel");
    await setCeiling(fx.session, {
      categoryId: travel,
      amount: "1000",
      effectiveFrom: MONTH,
      rollover: false,
    });

    const id = randomUUID();
    await elevatedDb.insert(schema.entries).values({
      id,
      ownerId: fx.userId,
      accountId: fx.accountId,
      entryType: "transaction",
      date: `${MONTH}-12`,
      descriptionCt: encText(fx.dataKey, "Hotel", id, "description_ct", 1),
      categoryId: travel,
      status: "posted",
      enteredAmountCt: encText(fx.dataKey, "-200", id, "entered_amount_ct", 1),
      enteredCurrency: "USD",
      accountAmountCt: encText(fx.dataKey, "-200", id, "account_amount_ct", 1),
      accountCurrency: "USD",
      reportingCurrency: "ILS",
      fxRate: null,
      fxStatus: "pending",
      source: "manual",
    });

    // Documented limitation (#69, and data-model.md §6 tension 7): the row is
    // invisible to the budget rather than valued 1:1. Consistent with
    // dashboard.ts, and deliberately not fixed here.
    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.everyday.rows[0].spent.amount).toBe("0");
  });

  it("ignores excluded entries and transfer categories", async () => {
    const fx = await freshFixture("budget-flows");
    const groceries = await expenseCategory(fx, "Groceries");
    const moving = await createCategory(fx.session, {
      name: `Moving-${randomUUID().slice(0, 6)}`,
      parentId: null,
      classification: "transfer",
      color: "chart-1",
      icon: "tag",
    });
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: MONTH,
      rollover: false,
    });

    await addEntry(fx, `${MONTH}-02`, "-100", groceries);
    await addEntry(fx, `${MONTH}-03`, "-4000", moving); // card settlement
    const excludedId = randomUUID();
    await elevatedDb.insert(schema.entries).values({
      id: excludedId,
      ownerId: fx.userId,
      accountId: fx.accountId,
      entryType: "transaction",
      date: `${MONTH}-04`,
      descriptionCt: encText(fx.dataKey, "Leg", excludedId, "description_ct", 1),
      categoryId: null,
      status: "posted",
      excluded: true,
      enteredAmountCt: encText(fx.dataKey, "-900", excludedId, "entered_amount_ct", 1),
      enteredCurrency: "ILS",
      accountAmountCt: encText(fx.dataKey, "-900", excludedId, "account_amount_ct", 1),
      accountCurrency: "ILS",
      reportingCurrency: "ILS",
      fxRate: "1",
      fxRateDate: `${MONTH}-04`,
      fxSource: "identity",
      fxStatus: "locked",
      source: "manual",
    });

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.everyday.rows[0].spent.amount).toBe("100");
    expect(view.spentTotal.amount).toBe("100");
  });

  it("sets planned savings against actual savings", async () => {
    const fx = await freshFixture("budget-savings");
    const groceries = await expenseCategory(fx, "Groceries");
    const salary = await createCategory(fx.session, {
      name: `Salary-${randomUUID().slice(0, 6)}`,
      parentId: null,
      classification: "income",
      color: "chart-1",
      icon: "tag",
    });

    await setPlannedIncome(fx.session, "18000", MONTH);
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-25`, "17000", salary);
    await addEntry(fx, `${MONTH}-10`, "-2500", groceries);

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.plannedIncome?.amount).toBe("18000");
    expect(view.plannedSavings?.amount).toBe("16000");
    expect(view.actualIncome.amount).toBe("17000");
    expect(view.actualSavings.amount).toBe("14500");
  });

  it("leaves the pace marker off any month that is not the current one", async () => {
    const fx = await freshFixture("budget-pace");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: MONTH,
      rollover: false,
    });

    expect((await getBudgetMonth(fx.session, MONTH)).pace).toBeNull();

    const live = await getBudgetMonth(fx.session, currentMonth());
    expect(live.pace).toBeGreaterThan(0);
    expect(live.pace).toBeLessThanOrEqual(1);
  });
});

describe("effective dating", () => {
  it("keeps a past month on the number that was in force then", async () => {
    const fx = await freshFixture("budget-effective");
    const groceries = await expenseCategory(fx, "Groceries");

    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1500",
      effectiveFrom: PRIOR,
      rollover: false,
    });
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2500",
      effectiveFrom: MONTH,
      rollover: false,
    });

    expect((await getBudgetMonth(fx.session, PRIOR)).everyday.rows[0].ceiling.amount).toBe("1500");
    expect((await getBudgetMonth(fx.session, MONTH)).everyday.rows[0].ceiling.amount).toBe("2500");
  });

  it("has no ceiling at all before the first effective month", async () => {
    const fx = await freshFixture("budget-before");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1500",
      effectiveFrom: MONTH,
      rollover: false,
    });

    const before = await getBudgetMonth(fx.session, shiftMonth(MONTH, -1));
    expect(before.hasBudget).toBe(false);
  });

  it("replaces rather than duplicates when the same month is edited twice", async () => {
    const fx = await freshFixture("budget-replace");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1500",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1700",
      effectiveFrom: MONTH,
      rollover: true,
    });

    const ceilings = await listCeilings(fx.session, MONTH);
    expect(ceilings).toHaveLength(1);
    expect(ceilings[0].amount.amount).toBe("1700");
    expect(ceilings[0].rollover).toBe(true);
  });
});

describe("one ceiling per branch", () => {
  it("refuses a child when its parent is already budgeted", async () => {
    const fx = await freshFixture("budget-branch-child");
    const parent = await expenseCategory(fx, "Home");
    const child = await expenseCategory(fx, "Repairs", parent);
    await setCeiling(fx.session, {
      categoryId: parent,
      amount: "1000",
      effectiveFrom: MONTH,
      rollover: false,
    });

    await expect(
      setCeiling(fx.session, {
        categoryId: child,
        amount: "300",
        effectiveFrom: MONTH,
        rollover: false,
      }),
    ).rejects.toBeInstanceOf(BudgetBranchConflictError);
  });

  it("refuses a parent when one of its children is already budgeted", async () => {
    const fx = await freshFixture("budget-branch-parent");
    const parent = await expenseCategory(fx, "Home");
    const child = await expenseCategory(fx, "Repairs", parent);
    await setCeiling(fx.session, {
      categoryId: child,
      amount: "300",
      effectiveFrom: MONTH,
      rollover: false,
    });

    await expect(
      setCeiling(fx.session, {
        categoryId: parent,
        amount: "1000",
        effectiveFrom: MONTH,
        rollover: false,
      }),
    ).rejects.toBeInstanceOf(BudgetBranchConflictError);
  });

  it("allows two unrelated categories, and a sibling of a budgeted child", async () => {
    const fx = await freshFixture("budget-branch-ok");
    const parent = await expenseCategory(fx, "Home");
    const repairs = await expenseCategory(fx, "Repairs", parent);
    const cleaning = await expenseCategory(fx, "Cleaning", parent);

    await setCeiling(fx.session, {
      categoryId: repairs,
      amount: "300",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await setCeiling(fx.session, {
      categoryId: cleaning,
      amount: "200",
      effectiveFrom: MONTH,
      rollover: false,
    });

    expect(await listCeilings(fx.session, MONTH)).toHaveLength(2);
  });

  it("refuses a ceiling on an income or transfer category", async () => {
    const fx = await freshFixture("budget-income-ceiling");
    const salary = await createCategory(fx.session, {
      name: `Salary-${randomUUID().slice(0, 6)}`,
      parentId: null,
      classification: "income",
      color: "chart-1",
      icon: "tag",
    });

    await expect(
      setCeiling(fx.session, {
        categoryId: salary,
        amount: "1000",
        effectiveFrom: MONTH,
        rollover: false,
      }),
    ).rejects.toBeInstanceOf(BudgetCategoryNotBudgetableError);
  });
});

describe("rollover", () => {
  it("carries a surplus forward", async () => {
    const fx = await freshFixture("budget-rollover-surplus");
    const insurance = await expenseCategory(fx, "Insurance");
    await setCeiling(fx.session, {
      categoryId: insurance,
      amount: "500",
      effectiveFrom: shiftMonth(MONTH, -3),
      rollover: true,
    });
    // Three quiet months, then the annual charge lands.
    await addEntry(fx, `${MONTH}-15`, "-1800", insurance);

    const view = await getBudgetMonth(fx.session, MONTH);
    const row = view.everyday.rows[0];
    expect(row.carriedIn?.amount).toBe("1500"); // 3 × 500, nothing spent
    expect(row.spent.amount).toBe("1800");
    // 500 this month + 1500 carried - 1800 spent: still in credit, so the
    // annual charge does not read as a 360% overspend.
    expect(row.remaining.amount).toBe("200");
    expect(view.overBudgetCount).toBe(0);
  });

  it("carries a deficit forward too", async () => {
    const fx = await freshFixture("budget-rollover-deficit");
    const dining = await expenseCategory(fx, "Dining");
    await setCeiling(fx.session, {
      categoryId: dining,
      amount: "500",
      effectiveFrom: PRIOR,
      rollover: true,
    });
    await addEntry(fx, `${PRIOR}-10`, "-900", dining);

    const row = (await getBudgetMonth(fx.session, MONTH)).everyday.rows[0];
    expect(row.carriedIn?.amount).toBe("-400");
    expect(row.remaining.amount).toBe("100");
  });

  it("does not replay months whose ceiling had rollover off", async () => {
    const fx = await freshFixture("budget-rollover-late");
    const gifts = await expenseCategory(fx, "Gifts");
    // Two unspent months with rollover OFF, then the toggle goes on.
    await setCeiling(fx.session, {
      categoryId: gifts,
      amount: "400",
      effectiveFrom: shiftMonth(MONTH, -2),
      rollover: false,
    });
    await setCeiling(fx.session, {
      categoryId: gifts,
      amount: "400",
      effectiveFrom: MONTH,
      rollover: true,
    });

    const row = (await getBudgetMonth(fx.session, MONTH)).everyday.rows[0];
    // Nothing accrued: turning rollover on today does not hand the user back
    // two months of surplus they never budgeted for.
    expect(row.carriedIn?.amount).toBe("0");
    expect(row.remaining.amount).toBe("400");
  });

  it("reports null carriedIn when rollover is off, so the UI can tell it apart from zero", async () => {
    const fx = await freshFixture("budget-rollover-off");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: PRIOR,
      rollover: false,
    });

    expect((await getBudgetMonth(fx.session, MONTH)).everyday.rows[0].carriedIn).toBeNull();
  });
});

describe("setup from history", () => {
  it("suggests each category's average monthly spend over the window", async () => {
    const fx = await freshFixture("budget-suggest");
    const groceries = await expenseCategory(fx, "Groceries");
    const thisMonth = currentMonth();
    const window = monthRange(shiftMonth(thisMonth, -3), shiftMonth(thisMonth, -1));
    for (const month of window) {
      await addEntry(fx, `${month}-10`, "-900", groceries);
    }

    const { ceilings: suggestions } = await proposeBudget(fx.session, 3);
    const row = suggestions.find((s) => s.categoryId === groceries);
    expect(row?.amount.amount).toBe("900");
  });

  it("writes nothing until the suggestions are accepted", async () => {
    const fx = await freshFixture("budget-suggest-write");
    const groceries = await expenseCategory(fx, "Groceries");
    await addEntry(fx, `${shiftMonth(currentMonth(), -1)}-10`, "-600", groceries);

    await proposeBudget(fx.session, 3);
    expect(await listCeilings(fx.session, MONTH)).toHaveLength(0);

    const written = await createCeilings(fx.session, [
      { categoryId: groceries, amount: "600", effectiveFrom: MONTH, rollover: false },
    ]);
    expect(written).toBe(1);
    expect(await listCeilings(fx.session, MONTH)).toHaveLength(1);
  });

  it("refuses a batch that would budget a parent over an already-budgeted child", async () => {
    // The mirror of the case below. `createCeilings` is a public route of its
    // own, so an invariant enforced only on `setCeiling` is not enforced.
    const fx = await freshFixture("budget-batch-parent");
    const parent = await expenseCategory(fx, "Home");
    const child = await expenseCategory(fx, "Repairs", parent);
    await setCeiling(fx.session, {
      categoryId: child,
      amount: "300",
      effectiveFrom: MONTH,
      rollover: false,
    });

    await expect(
      createCeilings(fx.session, [
        { categoryId: parent, amount: "1000", effectiveFrom: MONTH, rollover: false },
      ]),
    ).rejects.toBeInstanceOf(BudgetBranchConflictError);
  });

  it("refuses a batch that budgets both a parent and its own child at once", async () => {
    const fx = await freshFixture("budget-batch-both");
    const parent = await expenseCategory(fx, "Home");
    const child = await expenseCategory(fx, "Repairs", parent);

    await expect(
      createCeilings(fx.session, [
        { categoryId: parent, amount: "1000", effectiveFrom: MONTH, rollover: false },
        { categoryId: child, amount: "300", effectiveFrom: MONTH, rollover: false },
      ]),
    ).rejects.toBeInstanceOf(BudgetBranchConflictError);
  });

  it("refuses a batch containing an income category", async () => {
    const fx = await freshFixture("budget-batch-income");
    const salary = await createCategory(fx.session, {
      name: `Salary-${randomUUID().slice(0, 6)}`,
      parentId: null,
      classification: "income",
      color: "chart-1",
      icon: "tag",
    });

    await expect(
      createCeilings(fx.session, [
        { categoryId: salary, amount: "1000", effectiveFrom: MONTH, rollover: false },
      ]),
    ).rejects.toBeInstanceOf(BudgetCategoryNotBudgetableError);
  });

  it("refuses a batch that would budget a child under a budgeted parent", async () => {
    const fx = await freshFixture("budget-suggest-branch");
    const parent = await expenseCategory(fx, "Home");
    const child = await expenseCategory(fx, "Repairs", parent);
    await setCeiling(fx.session, {
      categoryId: parent,
      amount: "1000",
      effectiveFrom: MONTH,
      rollover: false,
    });

    await expect(
      createCeilings(fx.session, [
        { categoryId: child, amount: "300", effectiveFrom: MONTH, rollover: false },
      ]),
    ).rejects.toBeInstanceOf(BudgetBranchConflictError);
  });
});

describe("deleteCeiling and the dashboard summary", () => {
  it("ends a budget line from this month on, leaving earlier months alone", async () => {
    const fx = await freshFixture("budget-end");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: PRIOR,
      rollover: false,
    });
    await addEntry(fx, `${PRIOR}-08`, "-1400", groceries); // over budget then

    await endCeiling(fx.session, groceries, MONTH);

    // From MONTH on there is no ceiling...
    expect((await getBudgetMonth(fx.session, MONTH)).hasBudget).toBe(false);
    // ...but PRIOR still reads exactly as it was lived. Deleting the history
    // would have made a finished month stop being over budget because of
    // something the user did later.
    const past = await getBudgetMonth(fx.session, PRIOR);
    expect(past.hasBudget).toBe(true);
    expect(past.ceilingTotal.amount).toBe("1000");
    expect(past.overBudgetCount).toBe(1);
  });

  it("leaves no row at all when a line is ended in the month it began", async () => {
    const fx = await freshFixture("budget-end-same-month");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    // Nothing was ever in force, so there is no history to protect and no
    // end-marker worth keeping.
    await endCeiling(fx.session, groceries, MONTH);
    expect(await listCeilings(fx.session, MONTH)).toHaveLength(0);
    expect((await getBudgetMonth(fx.session, MONTH)).hasBudget).toBe(false);
  });

  it("can start budgeting a category again after ending it", async () => {
    const fx = await freshFixture("budget-end-restart");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: shiftMonth(PRIOR, -1),
      rollover: false,
    });
    await endCeiling(fx.session, groceries, PRIOR);
    expect((await getBudgetMonth(fx.session, PRIOR)).hasBudget).toBe(false);

    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1200",
      effectiveFrom: MONTH,
      rollover: false,
    });
    expect((await getBudgetMonth(fx.session, MONTH)).ceilingTotal.amount).toBe("1200");
    // The gap month stays a gap.
    expect((await getBudgetMonth(fx.session, PRIOR)).hasBudget).toBe(false);
  });

  it("summarises the current month for the dashboard card", async () => {
    const fx = await freshFixture("budget-summary");
    const groceries = await expenseCategory(fx, "Groceries");
    const thisMonth = currentMonth();
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: thisMonth,
      rollover: false,
    });
    await addEntry(fx, `${thisMonth}-02`, "-1200", groceries);
    await addEntry(fx, `${thisMonth}-03`, "-50", null); // unbudgeted

    const summary = await getBudgetSummary(fx.session);
    expect(summary.hasBudget).toBe(true);
    expect(summary.ceilingTotal.amount).toBe("1000");
    // Budgeted spend only — the card is about the budget, not the month.
    expect(summary.spent.amount).toBe("1200");
    expect(summary.overBudgetCount).toBe(1);
  });

  it("says there is no budget for a user who has not set one", async () => {
    const fx = await freshFixture("budget-empty");
    const summary = await getBudgetSummary(fx.session);
    expect(summary.hasBudget).toBe(false);
    expect(summary.ceilingTotal.amount).toBe("0");
  });
});

// The wizard's proposal. What matters is not the mean — that was already
// covered above — but the three judgements layered on it: which step a
// category belongs in, whether rollover should be on, and what the months
// behind the mean actually looked like.
describe("proposeBudget", () => {
  it("files a recurring category under fixed and the rest under everyday", async () => {
    const fx = await freshFixture("propose-kind");
    const rent = await expenseCategory(fx, "Rent");
    const groceries = await expenseCategory(fx, "Groceries");
    await markRecurring(fx, rent);

    for (const month of monthRange(
      shiftMonth(currentMonth(), -3),
      shiftMonth(currentMonth(), -1),
    )) {
      await addEntry(fx, `${month}-01`, "-4500", rent);
      await addEntry(fx, `${month}-09`, "-800", groceries);
    }

    const { ceilings } = await proposeBudget(fx.session, 3);
    expect(ceilings.find((c) => c.categoryId === rent)?.kind).toBe("fixed");
    expect(ceilings.find((c) => c.categoryId === groceries)?.kind).toBe("everyday");
  });

  it("does not switch rollover on for spending that arrives every month", async () => {
    const fx = await freshFixture("propose-monthly");
    const groceries = await expenseCategory(fx, "Groceries");
    for (const month of monthRange(
      shiftMonth(currentMonth(), -3),
      shiftMonth(currentMonth(), -1),
    )) {
      await addEntry(fx, `${month}-09`, "-800", groceries);
    }

    const row = (await proposeBudget(fx.session, 3)).ceilings.find(
      (c) => c.categoryId === groceries,
    );
    expect(row?.rollover).toBe(false);
    expect(row?.rolloverReason).toBeNull();
  });

  it("switches rollover on for a bill that skips months, and says why", async () => {
    const fx = await freshFixture("propose-lumpy");
    const arnona = await expenseCategory(fx, "Arnona");
    const window = monthRange(shiftMonth(currentMonth(), -3), shiftMonth(currentMonth(), -1));
    // Every other month — the shape of ארנונה, and the whole signal.
    await addEntry(fx, `${window[0]}-10`, "-600", arnona);
    await addEntry(fx, `${window[2]}-10`, "-600", arnona);

    const row = (await proposeBudget(fx.session, 3)).ceilings.find((c) => c.categoryId === arnona);
    expect(row?.rollover).toBe(true);
    expect(row?.rolloverReason).toContain("does not arrive every month");
    // Spread across all three months, not averaged over the two it landed in.
    expect(row?.amount.amount).toBe("400");
  });

  it("reports the months behind the mean, including the empty ones", async () => {
    const fx = await freshFixture("propose-history");
    const hobbies = await expenseCategory(fx, "Hobbies");
    const window = monthRange(shiftMonth(currentMonth(), -3), shiftMonth(currentMonth(), -1));
    await addEntry(fx, `${window[0]}-10`, "-300", hobbies);
    await addEntry(fx, `${window[2]}-10`, "-900", hobbies);

    const row = (await proposeBudget(fx.session, 3)).ceilings.find((c) => c.categoryId === hobbies);
    expect(row?.history.map((h) => h.amount.amount)).toEqual(["300", "0", "900"]);
    expect(row?.history.map((h) => h.month)).toEqual(window);
    expect(row?.lowest.amount).toBe("0");
    expect(row?.highest.amount).toBe("900");
  });

  it("proposes average monthly income alongside the ceilings", async () => {
    const fx = await freshFixture("propose-income");
    const salary = await createCategory(fx.session, {
      name: `Salary-${randomUUID().slice(0, 6)}`,
      parentId: null,
      classification: "income",
      color: "chart-1",
      icon: "tag",
    });
    for (const month of monthRange(
      shiftMonth(currentMonth(), -3),
      shiftMonth(currentMonth(), -1),
    )) {
      await addEntry(fx, `${month}-25`, "12000", salary);
    }

    const { income } = await proposeBudget(fx.session, 3);
    expect(income?.amount).toBe("12000");
  });

  it("reports no income to propose when none was earned", async () => {
    const fx = await freshFixture("propose-no-income");
    const groceries = await expenseCategory(fx, "Groceries");
    await addEntry(fx, `${shiftMonth(currentMonth(), -1)}-09`, "-800", groceries);
    expect((await proposeBudget(fx.session, 3)).income).toBeNull();
  });
});

// The hero card's own figures. `budgetedSpend` is the only numerator that can
// honestly sit over `ceilingTotal`; the projection and the day count are what
// stop a part-finished month reading as a triumph.
describe("the month's headline figures", () => {
  it("separates budgeted spend from everything that left", async () => {
    const fx = await freshFixture("headline-budgeted");
    const groceries = await expenseCategory(fx, "Groceries");
    const hobbies = await expenseCategory(fx, "Hobbies");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-04`, "-1200", groceries);
    await addEntry(fx, `${MONTH}-06`, "-500", hobbies);

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.budgetedSpend.amount).toBe("1200");
    expect(view.unbudgetedSpend.amount).toBe("500");
    expect(view.spentTotal.amount).toBe("1700");
  });

  it("has no day count or pace for a finished month", async () => {
    const fx = await freshFixture("headline-past");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-04`, "-1200", groceries);

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.daysLeft).toBeNull();
    expect(view.pace).toBeNull();
  });

  it("counts down the days on the current month", async () => {
    const fx = await freshFixture("headline-current");
    const groceries = await expenseCategory(fx, "Groceries");
    const thisMonth = currentMonth();
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: thisMonth,
      rollover: false,
    });
    await addEntry(fx, `${thisMonth}-01`, "-100", groceries);

    const view = await getBudgetMonth(fx.session, thisMonth);
    expect(view.pace).not.toBeNull();
    expect(view.daysLeft).not.toBeNull();
  });
});

// The residual ceiling: one row, category_id NULL, meaning "everything no
// other ceiling reaches this month". The point of it is that the budget's
// totals stop excluding money nobody itemized.
describe("the residual ceiling", () => {
  it("governs everything no other ceiling reaches, and reconciles the totals", async () => {
    const fx = await freshFixture("residual-basic");
    const groceries = await expenseCategory(fx, "Groceries");
    const hobbies = await expenseCategory(fx, "Hobbies");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await setCeiling(fx.session, {
      categoryId: null,
      amount: "800",
      effectiveFrom: MONTH,
      rollover: false,
    });

    await addEntry(fx, `${MONTH}-04`, "-1200", groceries);
    await addEntry(fx, `${MONTH}-06`, "-500", hobbies);
    await addEntry(fx, `${MONTH}-07`, "-100", null); // never categorized

    const view = await getBudgetMonth(fx.session, MONTH);
    const residual = view.everyday.rows.find((row) => row.categoryId === null);
    expect(residual?.categoryName).toBe("Everything else");
    expect(residual?.spent.amount).toBe("600"); // 500 hobbies + 100 uncategorized
    expect(residual?.remaining.amount).toBe("200");

    // The whole reason it exists: this money is now budgeted, counted once.
    expect(view.ceilingTotal.amount).toBe("2800");
    expect(view.budgetedSpend.amount).toBe("1800");
    expect(view.spentTotal.amount).toBe("1800");
    expect(view.unbudgetedSpend.amount).toBe("0");
  });

  it("leaves unbudgeted spending display-only when there is no residual ceiling", async () => {
    const fx = await freshFixture("residual-absent");
    const groceries = await expenseCategory(fx, "Groceries");
    const hobbies = await expenseCategory(fx, "Hobbies");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-04`, "-1200", groceries);
    await addEntry(fx, `${MONTH}-06`, "-500", hobbies);

    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.everyday.rows.some((row) => row.categoryId === null)).toBe(false);
    expect(view.unbudgetedSpend.amount).toBe("500");
    expect(view.ceilingTotal.amount).toBe("2000");
  });

  it("shrinks when a category it covered gets a ceiling of its own", async () => {
    const fx = await freshFixture("residual-narrows");
    const hobbies = await expenseCategory(fx, "Hobbies");
    await setCeiling(fx.session, {
      categoryId: null,
      amount: "800",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-06`, "-500", hobbies);

    const before = await getBudgetMonth(fx.session, MONTH);
    expect(before.everyday.rows.find((r) => r.categoryId === null)?.spent.amount).toBe("500");

    await setCeiling(fx.session, {
      categoryId: hobbies,
      amount: "600",
      effectiveFrom: MONTH,
      rollover: false,
    });
    const after = await getBudgetMonth(fx.session, MONTH);
    expect(after.everyday.rows.find((r) => r.categoryId === null)?.spent.amount).toBe("0");
    expect(after.everyday.rows.find((r) => r.categoryId === hobbies)?.spent.amount).toBe("500");
  });

  it("keeps a past month's residual on the categories that were budgeted then", async () => {
    const fx = await freshFixture("residual-past");
    const hobbies = await expenseCategory(fx, "Hobbies");
    await setCeiling(fx.session, {
      categoryId: null,
      amount: "800",
      effectiveFrom: PRIOR,
      rollover: false,
    });
    await addEntry(fx, `${PRIOR}-06`, "-500", hobbies);

    // Hobbies gets its own ceiling only from MONTH onward.
    await setCeiling(fx.session, {
      categoryId: hobbies,
      amount: "600",
      effectiveFrom: MONTH,
      rollover: false,
    });

    const past = await getBudgetMonth(fx.session, PRIOR);
    // In PRIOR, Hobbies had no ceiling, so its spending was the residual's.
    expect(past.everyday.rows.find((r) => r.categoryId === null)?.spent.amount).toBe("500");
    expect(past.everyday.rows.some((r) => r.categoryId === hobbies)).toBe(false);
  });

  it("is never a fixed cost", async () => {
    const fx = await freshFixture("residual-everyday");
    await setCeiling(fx.session, {
      categoryId: null,
      amount: "800",
      effectiveFrom: MONTH,
      rollover: false,
    });
    const view = await getBudgetMonth(fx.session, MONTH);
    expect(view.fixed.rows).toHaveLength(0);
    expect(view.everyday.rows).toHaveLength(1);
  });

  it("replaces rather than stacks a second residual in the same month", async () => {
    const fx = await freshFixture("residual-unique");
    await setCeiling(fx.session, {
      categoryId: null,
      amount: "800",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await setCeiling(fx.session, {
      categoryId: null,
      amount: "950",
      effectiveFrom: MONTH,
      rollover: false,
    });

    const ceilings = await listCeilings(fx.session, MONTH);
    const residuals = ceilings.filter((c) => c.categoryId === null);
    expect(residuals).toHaveLength(1);
    expect(residuals[0].amount.amount).toBe("950");
  });

  it("takes no branch or classification check, having no place in the tree", async () => {
    const fx = await freshFixture("residual-guards");
    const parent = await expenseCategory(fx, "Home");
    const child = await expenseCategory(fx, "Repairs", parent);
    await setCeiling(fx.session, {
      categoryId: parent,
      amount: "1500",
      effectiveFrom: MONTH,
      rollover: false,
    });
    // A residual alongside a parent-and-child pair is not a branch conflict:
    // it is not in the branch at all.
    await expect(
      setCeiling(fx.session, {
        categoryId: null,
        amount: "800",
        effectiveFrom: MONTH,
        rollover: false,
      }),
    ).resolves.toBeUndefined();
    expect(await listCeilings(fx.session, MONTH)).toHaveLength(2);
    void child;
  });

  it("carries a balance forward like any other ceiling", async () => {
    const fx = await freshFixture("residual-rollover");
    const hobbies = await expenseCategory(fx, "Hobbies");
    await setCeiling(fx.session, {
      categoryId: null,
      amount: "800",
      effectiveFrom: PRIOR,
      rollover: true,
    });
    await addEntry(fx, `${PRIOR}-06`, "-300", hobbies); // 500 unspent

    const view = await getBudgetMonth(fx.session, MONTH);
    const residual = view.everyday.rows.find((r) => r.categoryId === null);
    expect(residual?.carriedIn?.amount).toBe("500");
    expect(residual?.available.amount).toBe("1300");
  });

  it("is ended by its own key, not by a uuid", async () => {
    const fx = await freshFixture("residual-end");
    await setCeiling(fx.session, {
      categoryId: null,
      amount: "800",
      effectiveFrom: PRIOR,
      rollover: false,
    });
    expect(await listCeilings(fx.session, PRIOR)).toHaveLength(1);

    await endCeiling(fx.session, null, MONTH);
    expect(await listCeilings(fx.session, MONTH)).toHaveLength(0);
    // The month it governed keeps it.
    expect(await listCeilings(fx.session, PRIOR)).toHaveLength(1);
  });
});

// The history tab (issue #69 part C): whole months only, a plan bar that
// knows what a rollover line had saved up, and a verdict on the ceilings
// whose typical month sits well clear of the number the user set.
//
// Every window here is anchored to the wall clock, because the domain layer's
// is — so the months are derived rather than hardcoded, and these stay true
// in January.
describe("getBudgetHistory", () => {
  /** Every complete month a ceiling set in `from` would be observed over. */
  const windowFrom = (from: string) => monthRange(from, shiftMonth(currentMonth(), -1));

  /** A window of exactly `count` complete months, ending last month. */
  const windowOf = (count: number) => shiftMonth(currentMonth(), -count);

  it("has nothing to show before any ceiling existed", async () => {
    const fx = await freshFixture("history-empty");
    const view = await getBudgetHistory(fx.session);
    expect(view.months).toEqual([]);
    expect(view.verdicts).toEqual([]);
  });

  it("starts at the first budgeted month and stops before the month being lived", async () => {
    const fx = await freshFixture("history-window");
    const groceries = await expenseCategory(fx, "Groceries");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: MONTH,
      rollover: false,
    });

    const view = await getBudgetHistory(fx.session);
    expect(view.months.map((m) => m.month)).toEqual(windowFrom(MONTH));
    // The current month is deliberately absent: it is still being lived, and
    // its partial spending drawn beside whole months reads as a windfall.
    expect(view.months.map((m) => m.month)).not.toContain(currentMonth());
  });

  it("counts what a rollover line has accrued into the month's plan", async () => {
    const fx = await freshFixture("history-cadence");
    const insurance = await expenseCategory(fx, "Insurance");
    await setCeiling(fx.session, {
      categoryId: insurance,
      amount: "500",
      effectiveFrom: MONTH,
      rollover: true,
    });

    const view = await getBudgetHistory(fx.session);
    // Nothing spent, so the accrual is the whole story: the plan grows by the
    // ceiling every month, which is what makes the month the annual charge
    // finally lands read as budgeted rather than as a disaster.
    expect(view.months[0].planned.amount).toBe("500");
    expect(view.months[1].planned.amount).toBe("1000");
    expect(view.months[2].planned.amount).toBe("1500");
  });

  it("agrees with the month page about what a month cost", async () => {
    const fx = await freshFixture("history-reconciles");
    const groceries = await expenseCategory(fx, "Groceries");
    const hobbies = await expenseCategory(fx, "Hobbies");
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "2000",
      effectiveFrom: MONTH,
      rollover: false,
    });
    await addEntry(fx, `${MONTH}-04`, "-1200", groceries);
    // No ceiling reaches this one, so it is unbudgeted — and it still left
    // the account, so the expense bar has to include it.
    await addEntry(fx, `${MONTH}-06`, "-500", hobbies);
    await addEntry(fx, `${MONTH}-01`, "9000", null);

    const [history, month] = await Promise.all([
      getBudgetHistory(fx.session),
      getBudgetMonth(fx.session, MONTH),
    ]);
    const point = history.months.find((m) => m.month === MONTH)!;
    expect(point.spent.amount).toBe(month.spentTotal.amount);
    expect(point.spent.amount).toBe("1700");
    expect(point.income.amount).toBe(month.actualIncome.amount);
    expect(point.planned.amount).toBe("2000");
  });

  it("flags a ceiling the user reliably overspends, and suggests what they spend", async () => {
    const fx = await freshFixture("history-too-low");
    const groceries = await expenseCategory(fx, "Groceries");
    const from = windowOf(3);
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: from,
      rollover: false,
    });
    for (const month of windowFrom(from)) await addEntry(fx, `${month}-04`, "-1500", groceries);

    const view = await getBudgetHistory(fx.session);
    expect(view.verdicts).toHaveLength(1);
    const [verdict] = view.verdicts;
    expect(verdict.categoryId).toBe(groceries);
    expect(verdict.direction).toBe("under-budgeted");
    expect(verdict.averageSpend.amount).toBe("1500");
    expect(verdict.variance.amount).toBe("500");
    expect(verdict.monthsObserved).toBe(3);
    expect(verdict.monthsOver).toBe(3);
  });

  it("flags a ceiling nobody comes close to using", async () => {
    const fx = await freshFixture("history-too-high");
    const groceries = await expenseCategory(fx, "Groceries");
    const from = windowOf(3);
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: from,
      rollover: false,
    });
    for (const month of windowFrom(from)) await addEntry(fx, `${month}-04`, "-400", groceries);

    const view = await getBudgetHistory(fx.session);
    expect(view.verdicts).toHaveLength(1);
    expect(view.verdicts[0].direction).toBe("over-budgeted");
    expect(view.verdicts[0].variance.amount).toBe("-600");
    expect(view.verdicts[0].monthsOver).toBe(0);
  });

  it("stays quiet about ordinary month-to-month variation", async () => {
    const fx = await freshFixture("history-within-threshold");
    const groceries = await expenseCategory(fx, "Groceries");
    const from = windowOf(3);
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: from,
      rollover: false,
    });
    // 10% over on average — inside the 15% band, so it is variation rather
    // than a ceiling set wrong, and saying something would be noise.
    for (const month of windowFrom(from)) await addEntry(fx, `${month}-04`, "-1100", groceries);

    const view = await getBudgetHistory(fx.session);
    expect(view.verdicts).toEqual([]);
  });

  it("says nothing about a line it has barely seen", async () => {
    const fx = await freshFixture("history-thin");
    const groceries = await expenseCategory(fx, "Groceries");
    const from = windowOf(2);
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: from,
      rollover: false,
    });
    for (const month of windowFrom(from)) await addEntry(fx, `${month}-04`, "-5000", groceries);

    const view = await getBudgetHistory(fx.session);
    // Two months cannot tell a habit from a coincidence.
    expect(view.verdicts).toEqual([]);
  });

  it("does not tell a user to cut a rollover line whose charge has not landed", async () => {
    const fx = await freshFixture("history-rollover-quiet");
    const insurance = await expenseCategory(fx, "Insurance");
    await setCeiling(fx.session, {
      categoryId: insurance,
      amount: "500",
      effectiveFrom: windowOf(6),
      rollover: true,
    });

    // Six quiet months look exactly like a ceiling set far too high, and the
    // advice — "lower it" — would break the very month it is saving for.
    const view = await getBudgetHistory(fx.session);
    expect(view.verdicts).toEqual([]);
  });

  it("leaves a line the user has stopped budgeting out of the verdicts", async () => {
    const fx = await freshFixture("history-ended");
    const groceries = await expenseCategory(fx, "Groceries");
    const from = windowOf(4);
    await setCeiling(fx.session, {
      categoryId: groceries,
      amount: "1000",
      effectiveFrom: from,
      rollover: false,
    });
    for (const month of windowFrom(from)) await addEntry(fx, `${month}-04`, "-1500", groceries);
    await endCeiling(fx.session, groceries, currentMonth());

    const view = await getBudgetHistory(fx.session);
    // The chart still shows the months it governed — they happened — but
    // there is no ceiling left to re-tune.
    expect(view.months.map((m) => m.month)).toEqual(windowFrom(from));
    expect(view.verdicts).toEqual([]);
  });
});
