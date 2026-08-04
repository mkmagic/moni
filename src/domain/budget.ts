// Domain read/write: the budget (issue #69).
//
// Moni's budget is **ceilings, not envelopes** — a monthly target per
// category, with spent-vs-target bars. Overspending shows as an over-budget
// row; it never forces a reallocation. Envelope budgeting was rejected
// because it assumes a trustworthy current cash position, and Moni's is
// structurally unavailable: scrapes are user-triggered, and an Israeli credit
// card settles a month after the purchases Moni dates at purchase time.
//
// Two shapes govern everything here:
//
//   * **Effective-dated ceilings.** Editing writes a new row from that month
//     forward; the old row stays. March keeps the number that was actually in
//     force in March, so a finished month reads as it was lived rather than
//     being restated against today's target.
//   * **One ceiling per branch.** A user budgets a parent group as a single
//     number OR its subcategories individually, never both — so there is
//     exactly one authority for any given shekel and "over budget" is never
//     ambiguous. The database cannot express this (it spans rows, and the
//     effective-dating means several rows per category are correct), so it is
//     enforced here.
//
// Aggregation follows the house shape: narrow in SQL on plaintext structural
// columns, decrypt the narrowed set, aggregate in memory with decimal.js
// (data-model.md §6 tension 1). No persisted rollups.
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { withUser } from "@/db/client";
import { budgetCeilings, budgetIncomes, categories, entries } from "@/db/schema";
import { multiply, type Money } from "@/lib/money";
import type { Session } from "@/lib/auth/session-store";
import { decText, encText } from "./fields";
import { countsAsFlow, loadTransferCategoryIds } from "./flows";
import { israelDate } from "./investment-valuation";

type Tx = Parameters<Parameters<typeof withUser>[1]>[0];

export class BudgetBranchConflictError extends Error {
  constructor(conflictingCategoryName: string) {
    super(
      `"${conflictingCategoryName}" is already budgeted — a group and its subcategories cannot both carry a ceiling`,
    );
    this.name = "BudgetBranchConflictError";
  }
}

export class BudgetCategoryNotBudgetableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BudgetCategoryNotBudgetableError";
  }
}

// --- Month arithmetic -------------------------------------------------------
// A "month" is always "YYYY-MM"; a ceiling's `effective_from` is always that
// month's first day, so the two are one `-01` apart and comparable as text.

/** "YYYY-MM" -> "YYYY-MM-01", the form stored in `effective_from`. */
export function monthStart(month: string): string {
  return `${month}-01`;
}

/** "YYYY-MM" -> its last day, as an ISO date. */
export function monthEnd(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

/** The month `count` months after `month` (negative counts go back). */
export function shiftMonth(month: string, count: number): string {
  const [year, number] = month.split("-").map(Number);
  const d = new Date(Date.UTC(year, number - 1 + count, 1));
  return d.toISOString().slice(0, 7);
}

/** Every month from `from` up to and including `to`, in order. */
export function monthRange(from: string, to: string): string[] {
  const months: string[] = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) months.push(m);
  return months;
}

// --- Views ------------------------------------------------------------------

export interface BudgetRowView {
  categoryId: string;
  categoryName: string;
  color: string | null;
  icon: string | null;
  /** Drives the Fixed / Everyday split — `categories.is_recurring`. */
  isRecurring: boolean;
  ceiling: Money;
  /** `ceiling + carriedIn` — what this month's spending is actually measured
   * against, and what the bar is drawn from. Equal to `ceiling` when rollover
   * is off. Computed here so the display edge never does money arithmetic. */
  available: Money;
  /** Positive magnitude. Sign-carrying underneath, so a refund nets it down. */
  spent: Money;
  /** `ceiling + carriedIn - spent`. Negative means over budget. */
  remaining: Money;
  rollover: boolean;
  /** Surplus (or deficit) accrued from earlier months. Null when rollover is
   * off, so the UI can tell "carried nothing" from "does not carry". */
  carriedIn: Money | null;
}

export interface BudgetMonthView {
  month: string;
  currency: string;
  /** True when at least one ceiling is in force — the page's empty state. */
  hasBudget: boolean;
  fixed: BudgetRowView[];
  everyday: BudgetRowView[];
  /** Spending that fell outside every ceiling. Display-only: it takes no
   * ceiling, but it is shown so the totals reconcile and no money hides. */
  unbudgetedSpend: Money;
  ceilingTotal: Money;
  /** Every shekel spent this month, budgeted or not. */
  spentTotal: Money;
  plannedIncome: Money | null;
  actualIncome: Money;
  /** `plannedIncome - ceilingTotal`. Null until planned income is set. */
  plannedSavings: Money | null;
  /** `actualIncome - spentTotal`. */
  actualSavings: Money;
  overBudgetCount: number;
  /**
   * How far through the month today is, 0..1 — the pace marker. Null for any
   * month that is not the current one, because pacing a finished month says
   * nothing. The UI draws it on Everyday rows only: Rent is 100% spent on day
   * one by design, and a marker there would read as alarming.
   */
  pace: number | null;
}

export interface CeilingView {
  categoryId: string;
  categoryName: string;
  amount: Money;
  effectiveFrom: string;
  rollover: boolean;
}

export interface CeilingSuggestion {
  categoryId: string;
  categoryName: string;
  /** The category's average monthly spend over the chosen window. */
  amount: Money;
}

// --- Internal row helpers ---------------------------------------------------

interface CeilingRow {
  categoryId: string;
  amount: Decimal;
  effectiveFrom: string;
  rollover: boolean;
}

async function loadCeilings(tx: Tx, dataKey: Uint8Array): Promise<CeilingRow[]> {
  const rows = await tx.select().from(budgetCeilings).orderBy(asc(budgetCeilings.effectiveFrom));
  return rows.map((row) => ({
    categoryId: row.categoryId,
    amount: new Decimal(decText(dataKey, row.amountCt, row.id, "amount_ct", row.version) ?? "0"),
    effectiveFrom: row.effectiveFrom,
    rollover: row.rollover,
  }));
}

/**
 * The ceiling in force for each category in `month` — the latest row whose
 * `effective_from` is not in the future. `rows` must be ordered by
 * `effective_from` ascending.
 */
function ceilingsInForce(rows: CeilingRow[], month: string): Map<string, CeilingRow> {
  const inForce = new Map<string, CeilingRow>();
  const cutoff = monthStart(month);
  for (const row of rows) {
    if (row.effectiveFrom > cutoff) continue;
    inForce.set(row.categoryId, row); // ascending order, so the last wins
  }
  return inForce;
}

interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  classification: "income" | "expense" | "transfer";
  color: string | null;
  icon: string | null;
  isRecurring: boolean;
}

async function loadCategories(tx: Tx): Promise<Map<string, CategoryRow>> {
  const rows = await tx.select().from(categories);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        parentId: r.parentId,
        classification: r.classification,
        color: r.color,
        icon: r.icon,
        // A recurring flag on a parent covers its children (ADR 0006), so a
        // subcategory of Housing is Fixed even when only Housing is flagged.
        isRecurring: r.isRecurring,
      },
    ]),
  );
}

function isRecurringWithInheritance(id: string, cats: Map<string, CategoryRow>): boolean {
  const row = cats.get(id);
  if (!row) return false;
  if (row.isRecurring) return true;
  return row.parentId ? (cats.get(row.parentId)?.isRecurring ?? false) : false;
}

/**
 * Which budgeted category an entry's spending answers to: the entry's own
 * category if that carries the ceiling, otherwise its parent if the parent
 * does. A ceiling on a parent covers everything filed under it, exactly as a
 * parent already filters entries in the transactions list.
 */
function budgetedCategoryOf(
  categoryId: string | null,
  budgeted: Set<string>,
  cats: Map<string, CategoryRow>,
): string | null {
  if (!categoryId) return null;
  if (budgeted.has(categoryId)) return categoryId;
  const parentId = cats.get(categoryId)?.parentId ?? null;
  return parentId && budgeted.has(parentId) ? parentId : null;
}

/** An entry's reporting-currency amount, sign carried, or null when it can't
 * be valued. Pending-FX entries are skipped rather than faked to 1:1 — the
 * same rule dashboard.ts applies (money-and-currency.md §4). */
function reportingAmount(
  entry: { fxStatus: string; fxRate: string | null; enteredCurrency: string },
  entered: string,
): Decimal | null {
  if (entry.fxStatus === "pending" || !entry.fxRate) return null;
  return new Decimal(
    multiply({ amount: entered, currency: entry.enteredCurrency }, entry.fxRate).amount,
  );
}

interface MonthlyFlows {
  /** month -> category id -> net reporting amount (sign carried). */
  byCategory: Map<string, Map<string, Decimal>>;
  /** month -> total income (positive). */
  income: Map<string, Decimal>;
  /** month -> spending with no category at all. */
  uncategorizedSpend: Map<string, Decimal>;
}

/**
 * Nets every flow entry between two months into per-month, per-category
 * totals. One pass; the caller decides which categories are budgeted.
 *
 * Income and spending are told apart by the entry's category classification,
 * not by sign — that is what lets a refund in an expense category net its own
 * category down instead of registering as income. An entry with no category
 * has no classification to consult, so there its sign decides.
 */
async function loadMonthlyFlows(
  tx: Tx,
  dataKey: Uint8Array,
  cats: Map<string, CategoryRow>,
  fromMonth: string,
  toMonth: string,
): Promise<MonthlyFlows> {
  const rows = await tx
    .select()
    .from(entries)
    .where(and(gte(entries.date, monthStart(fromMonth)), lte(entries.date, monthEnd(toMonth))));
  const transferCategoryIds = await loadTransferCategoryIds(tx);

  const byCategory = new Map<string, Map<string, Decimal>>();
  const income = new Map<string, Decimal>();
  const uncategorizedSpend = new Map<string, Decimal>();

  for (const entry of rows) {
    if (!countsAsFlow(entry, transferCategoryIds)) continue;
    const entered = decText(
      dataKey,
      entry.enteredAmountCt,
      entry.id,
      "entered_amount_ct",
      entry.version,
    );
    if (entered == null) continue;
    const amount = reportingAmount(entry, entered);
    if (amount == null) continue;

    const month = entry.date.slice(0, 7);
    const classification = entry.categoryId
      ? (cats.get(entry.categoryId)?.classification ?? "expense")
      : null;

    if (classification === "income" || (classification === null && amount.isPositive())) {
      income.set(month, (income.get(month) ?? new Decimal(0)).plus(amount));
      continue;
    }
    if (!entry.categoryId) {
      uncategorizedSpend.set(month, (uncategorizedSpend.get(month) ?? new Decimal(0)).plus(amount));
      continue;
    }
    const monthTotals = byCategory.get(month) ?? new Map<string, Decimal>();
    monthTotals.set(
      entry.categoryId,
      (monthTotals.get(entry.categoryId) ?? new Decimal(0)).plus(amount),
    );
    byCategory.set(month, monthTotals);
  }

  return { byCategory, income, uncategorizedSpend };
}

/** Spending attributed to one budgeted category in one month, as a positive
 * magnitude. Sums the category itself and — when the ceiling sits on a parent
 * — everything filed under it. */
function spentOn(
  budgetedId: string,
  month: string,
  flows: MonthlyFlows,
  budgeted: Set<string>,
  cats: Map<string, CategoryRow>,
): Decimal {
  const monthTotals = flows.byCategory.get(month);
  if (!monthTotals) return new Decimal(0);
  let total = new Decimal(0);
  for (const [categoryId, amount] of monthTotals) {
    if (budgetedCategoryOf(categoryId, budgeted, cats) === budgetedId) total = total.plus(amount);
  }
  return total.negated();
}

const money = (amount: Decimal, currency: string): Money => ({
  amount: amount.toFixed(2),
  currency,
});

// --- Reads ------------------------------------------------------------------

/**
 * The whole budget page for one month.
 *
 * Rollover, when a category has it on, makes "remaining" a running balance
 * rather than a single-month subtraction: it replays every month from the
 * category's first ceiling forward, so a ₪500/month accrual is there when the
 * ₪6,000 annual insurance charge lands. Only months whose ceiling actually
 * had rollover on contribute, which is what makes flipping the toggle on
 * today not rewrite the past.
 */
export async function getBudgetMonth(session: Session, month: string): Promise<BudgetMonthView> {
  const { userId, dataKey, baseCurrency } = session;
  const today = israelDate(new Date());
  const currentMonth = today.slice(0, 7);

  return withUser(userId, async (tx) => {
    const [cats, ceilingRows] = await Promise.all([loadCategories(tx), loadCeilings(tx, dataKey)]);
    const inForce = ceilingsInForce(ceilingRows, month);
    const budgeted = new Set(inForce.keys());

    // Replay only as far back as a rollover ceiling actually reaches; without
    // one, this month alone is all the aggregation needs to read.
    const rolloverStart = ceilingRows
      .filter((row) => row.rollover && budgeted.has(row.categoryId))
      .map((row) => row.effectiveFrom.slice(0, 7))
      .sort()[0];
    const fromMonth = rolloverStart && rolloverStart < month ? rolloverStart : month;
    const flows = await loadMonthlyFlows(tx, dataKey, cats, fromMonth, month);

    const rows: BudgetRowView[] = [];
    let ceilingTotal = new Decimal(0);
    let budgetedSpend = new Decimal(0);
    let overBudgetCount = 0;

    for (const [categoryId, ceiling] of inForce) {
      const category = cats.get(categoryId);
      if (!category) continue; // category deleted out from under the ceiling
      const spent = spentOn(categoryId, month, flows, budgeted, cats);

      // Both surplus and deficit carry, and only from months that were
      // themselves rollover months.
      let carriedIn: Decimal | null = null;
      if (ceiling.rollover) {
        carriedIn = new Decimal(0);
        for (const past of monthRange(fromMonth, shiftMonth(month, -1))) {
          const pastCeiling = ceilingsInForce(ceilingRows, past).get(categoryId);
          if (!pastCeiling || !pastCeiling.rollover) continue;
          carriedIn = carriedIn
            .plus(pastCeiling.amount)
            .minus(spentOn(categoryId, past, flows, budgeted, cats));
        }
      }

      const available = ceiling.amount.plus(carriedIn ?? new Decimal(0));
      const remaining = available.minus(spent);
      if (remaining.isNegative()) overBudgetCount += 1;
      ceilingTotal = ceilingTotal.plus(ceiling.amount);
      budgetedSpend = budgetedSpend.plus(spent);

      rows.push({
        categoryId,
        categoryName: category.name,
        color: category.color,
        icon: category.icon,
        isRecurring: isRecurringWithInheritance(categoryId, cats),
        ceiling: money(ceiling.amount, baseCurrency),
        available: money(available, baseCurrency),
        spent: money(spent, baseCurrency),
        remaining: money(remaining, baseCurrency),
        rollover: ceiling.rollover,
        carriedIn: carriedIn ? money(carriedIn, baseCurrency) : null,
      });
    }

    rows.sort((a, b) => a.categoryName.localeCompare(b.categoryName));

    // Everything that fell outside a ceiling, so the totals reconcile.
    let unbudgeted = flows.uncategorizedSpend.get(month) ?? new Decimal(0);
    for (const [categoryId, amount] of flows.byCategory.get(month) ?? []) {
      if (budgetedCategoryOf(categoryId, budgeted, cats) === null)
        unbudgeted = unbudgeted.plus(amount);
    }
    const unbudgetedSpend = unbudgeted.negated();

    const actualIncome = flows.income.get(month) ?? new Decimal(0);
    const spentTotal = budgetedSpend.plus(unbudgetedSpend);
    const plannedIncome = await plannedIncomeFor(tx, dataKey, month);

    return {
      month,
      currency: baseCurrency,
      hasBudget: rows.length > 0,
      fixed: rows.filter((row) => row.isRecurring),
      everyday: rows.filter((row) => !row.isRecurring),
      unbudgetedSpend: money(unbudgetedSpend, baseCurrency),
      ceilingTotal: money(ceilingTotal, baseCurrency),
      spentTotal: money(spentTotal, baseCurrency),
      plannedIncome: plannedIncome ? money(plannedIncome, baseCurrency) : null,
      actualIncome: money(actualIncome, baseCurrency),
      plannedSavings: plannedIncome ? money(plannedIncome.minus(ceilingTotal), baseCurrency) : null,
      actualSavings: money(actualIncome.minus(spentTotal), baseCurrency),
      overBudgetCount,
      pace: month === currentMonth ? paceOf(today) : null,
    };
  });
}

/** Fraction of the month elapsed at `today`, counting today as spent — the
 * 8th of a 31-day month is 8/31, not 7/31, because today's money is already
 * at risk. */
function paceOf(today: string): number {
  const day = Number(today.slice(8, 10));
  const days = Number(monthEnd(today.slice(0, 7)).slice(8, 10));
  return day / days;
}

async function plannedIncomeFor(
  tx: Tx,
  dataKey: Uint8Array,
  month: string,
): Promise<Decimal | null> {
  const rows = await tx
    .select()
    .from(budgetIncomes)
    .where(lte(budgetIncomes.effectiveFrom, monthStart(month)))
    .orderBy(asc(budgetIncomes.effectiveFrom));
  const row = rows.at(-1);
  if (!row) return null;
  return new Decimal(decText(dataKey, row.amountCt, row.id, "amount_ct", row.version) ?? "0");
}

/** Every ceiling currently in force, for the editing UI. */
export async function listCeilings(session: Session, month: string): Promise<CeilingView[]> {
  const { userId, dataKey, baseCurrency } = session;
  return withUser(userId, async (tx) => {
    const [cats, rows] = await Promise.all([loadCategories(tx), loadCeilings(tx, dataKey)]);
    return [...ceilingsInForce(rows, month).values()]
      .map((row) => ({
        categoryId: row.categoryId,
        categoryName: cats.get(row.categoryId)?.name ?? "",
        amount: money(row.amount, baseCurrency),
        effectiveFrom: row.effectiveFrom,
        rollover: row.rollover,
      }))
      .sort((a, b) => a.categoryName.localeCompare(b.categoryName));
  });
}

/**
 * How many complete months of history exist, so the setup step can't offer a
 * 12-month window to someone who backfilled three. Capped at 12, which is
 * also the backfill cap (ADR 0001).
 */
export async function availableHistoryMonths(session: Session): Promise<number> {
  return withUser(session.userId, async (tx) => {
    const [earliest] = await tx
      .select({ date: entries.date })
      .from(entries)
      .orderBy(asc(entries.date))
      .limit(1);
    if (!earliest) return 0;
    const currentMonth = israelDate(new Date()).slice(0, 7);
    const months = monthRange(earliest.date.slice(0, 7), shiftMonth(currentMonth, -1)).length;
    return Math.min(months, 12);
  });
}

/**
 * A starting ceiling per category, from what the user actually spent: the
 * category's total over the last `windowMonths` complete months divided by
 * how many months that is.
 *
 * Suggested at the level entries are filed on — the leaf — so accepting the
 * whole set can never violate one-ceiling-per-branch. Nothing is written
 * until the user accepts, the same posture as categorization suggestions.
 *
 * A non-monthly category (annual insurance, ארנונה) comes out wrong here and
 * is meant to be set by hand: a 3-month window suggests ₪0 for a charge that
 * lands in month 7, and a user who backfilled shallowly has no better number
 * available. Accepted, not worked around.
 */
export async function suggestCeilings(
  session: Session,
  windowMonths: number,
): Promise<CeilingSuggestion[]> {
  const { userId, dataKey, baseCurrency } = session;
  return withUser(userId, async (tx) => {
    const cats = await loadCategories(tx);
    const lastComplete = shiftMonth(israelDate(new Date()).slice(0, 7), -1);
    const fromMonth = shiftMonth(lastComplete, -(windowMonths - 1));
    const months = monthRange(fromMonth, lastComplete);
    const flows = await loadMonthlyFlows(tx, dataKey, cats, fromMonth, lastComplete);

    const totals = new Map<string, Decimal>();
    for (const month of months) {
      for (const [categoryId, amount] of flows.byCategory.get(month) ?? []) {
        totals.set(categoryId, (totals.get(categoryId) ?? new Decimal(0)).plus(amount));
      }
    }

    return (
      [...totals]
        .map(([categoryId, total]) => ({
          categoryId,
          categoryName: cats.get(categoryId)?.name ?? "",
          average: total.negated().dividedBy(months.length),
        }))
        // A category whose window nets out to nothing spent is not a budget
        // line worth proposing.
        .filter((row) => row.average.isPositive())
        .sort((a, b) => b.average.comparedTo(a.average))
        .map((row) => ({
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          amount: money(row.average, baseCurrency),
        }))
    );
  });
}

// --- Writes -----------------------------------------------------------------

export interface SetCeilingInput {
  categoryId: string;
  /** Canonical decimal string, positive — a ceiling is a spending target. */
  amount: string;
  /** The month it takes effect, "YYYY-MM". */
  effectiveFrom: string;
  rollover: boolean;
}

/**
 * Sets a category's ceiling from `effectiveFrom` forward. Editing the same
 * month again replaces that row; editing a later month adds one and leaves
 * the earlier month's number intact, which is what makes a past month
 * trustworthy.
 */
export async function setCeiling(session: Session, input: SetCeilingInput): Promise<void> {
  const { userId, dataKey } = session;
  await withUser(userId, async (tx) => {
    const cats = await loadCategories(tx);
    const category = cats.get(input.categoryId);
    if (!category) throw new BudgetCategoryNotBudgetableError("No such category");
    if (category.classification !== "expense") {
      throw new BudgetCategoryNotBudgetableError(
        `"${category.name}" is not an expense category — only spending takes a ceiling`,
      );
    }

    const existing = await tx.select().from(budgetCeilings);
    const budgetedIds = new Set(existing.map((row) => row.categoryId));
    // One authority per shekel: a parent and its children cannot both carry a
    // ceiling, or "over budget" would have two answers.
    if (category.parentId && budgetedIds.has(category.parentId)) {
      throw new BudgetBranchConflictError(cats.get(category.parentId)?.name ?? "the parent group");
    }
    for (const [id, row] of cats) {
      if (row.parentId === input.categoryId && budgetedIds.has(id)) {
        throw new BudgetBranchConflictError(row.name);
      }
    }

    const effectiveFrom = monthStart(input.effectiveFrom);
    const replaced = existing.find(
      (row) => row.categoryId === input.categoryId && row.effectiveFrom === effectiveFrom,
    );
    if (replaced) {
      const version = replaced.version + 1;
      await tx
        .update(budgetCeilings)
        .set({
          amountCt: encText(dataKey, input.amount, replaced.id, "amount_ct", version),
          rollover: input.rollover,
          version,
        })
        .where(eq(budgetCeilings.id, replaced.id));
      return;
    }

    const id = randomUUID();
    await tx.insert(budgetCeilings).values({
      id,
      ownerId: userId,
      categoryId: input.categoryId,
      amountCt: encText(dataKey, input.amount, id, "amount_ct", 1),
      effectiveFrom,
      rollover: input.rollover,
    });
  });
}

/** Stops budgeting a category entirely, history included — the user is
 * saying "this was never a budget line", not "it ended". Ending a line is
 * `setCeiling` with a new amount from this month forward. */
export async function deleteCeiling(session: Session, categoryId: string): Promise<void> {
  await withUser(session.userId, async (tx) => {
    await tx.delete(budgetCeilings).where(eq(budgetCeilings.categoryId, categoryId));
  });
}

/** Sets planned monthly income from `effectiveFrom` forward, same shape and
 * same reasoning as a ceiling. */
export async function setPlannedIncome(
  session: Session,
  amount: string,
  effectiveFrom: string,
): Promise<void> {
  const { userId, dataKey } = session;
  await withUser(userId, async (tx) => {
    const from = monthStart(effectiveFrom);
    const [existing] = await tx
      .select()
      .from(budgetIncomes)
      .where(eq(budgetIncomes.effectiveFrom, from));
    if (existing) {
      const version = existing.version + 1;
      await tx
        .update(budgetIncomes)
        .set({ amountCt: encText(dataKey, amount, existing.id, "amount_ct", version), version })
        .where(eq(budgetIncomes.id, existing.id));
      return;
    }
    const id = randomUUID();
    await tx.insert(budgetIncomes).values({
      id,
      ownerId: userId,
      amountCt: encText(dataKey, amount, id, "amount_ct", 1),
      effectiveFrom: from,
    });
  });
}

/** Accepts a whole suggested budget in one go — what the empty state's
 * "create from history" writes. Rejects the batch if any category is already
 * budgeted, rather than half-applying it. */
export async function createCeilings(session: Session, inputs: SetCeilingInput[]): Promise<number> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    const cats = await loadCategories(tx);
    const proposed = new Set(inputs.map((input) => input.categoryId));
    const existing = await tx.select().from(budgetCeilings);
    const budgetedIds = new Set([...existing.map((row) => row.categoryId), ...proposed]);

    for (const input of inputs) {
      const category = cats.get(input.categoryId);
      if (!category) throw new BudgetCategoryNotBudgetableError("No such category");
      if (category.parentId && budgetedIds.has(category.parentId)) {
        throw new BudgetBranchConflictError(
          cats.get(category.parentId)?.name ?? "the parent group",
        );
      }
    }

    const values = inputs.map((input) => {
      const id = randomUUID();
      return {
        id,
        ownerId: userId,
        categoryId: input.categoryId,
        amountCt: encText(dataKey, input.amount, id, "amount_ct", 1),
        effectiveFrom: monthStart(input.effectiveFrom),
        rollover: input.rollover,
      };
    });
    if (values.length === 0) return 0;
    await tx.insert(budgetCeilings).values(values);
    return values.length;
  });
}

/** The one line the dashboard card needs. Deliberately the same computation
 * as the page, not a second one that could disagree with it. */
export async function getBudgetSummary(session: Session): Promise<{
  hasBudget: boolean;
  month: string;
  spent: Money;
  ceilingTotal: Money;
  overBudgetCount: number;
}> {
  const month = israelDate(new Date()).slice(0, 7);
  const view = await getBudgetMonth(session, month);
  return {
    hasBudget: view.hasBudget,
    month,
    // The card is about the budget, so it shows budgeted spend against the
    // ceilings — not `spentTotal`, which includes money no ceiling governs.
    spent: money(
      new Decimal(view.spentTotal.amount).minus(view.unbudgetedSpend.amount),
      view.currency,
    ),
    ceilingTotal: view.ceilingTotal,
    overBudgetCount: view.overBudgetCount,
  };
}
