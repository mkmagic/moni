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
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { withUser } from "@/db/client";
import { budgetCeilings, budgetIncomes, categories, entries } from "@/db/schema";
import { multiply, type Money } from "@/lib/money";
import type { Session } from "@/lib/auth/session-store";
import { decText, encText } from "./fields";
import { countsAsFlow, loadTransferCategoryIds } from "./flows";
import { israelDate } from "./investment-valuation";
import { mappedLocalCategoryIds } from "./shared-categories";
import { RESIDUAL_KEY, RESIDUAL_NAME } from "@/lib/budget/residual";

export { RESIDUAL_KEY, RESIDUAL_NAME };

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

/** A local category mapped to a shared household line takes the HOUSEHOLD
 * ceiling, never a personal one (issue #115: personal ceiling OR shared
 * ceiling, never both). Unmap it to budget it personally again. */
export class BudgetCategorySharedError extends Error {
  constructor(categoryName: string) {
    super(
      `"${categoryName}" is shared with your household — its budget is the household ceiling, not a personal one`,
    );
    this.name = "BudgetCategorySharedError";
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

/**
 * The month "now" falls in, on the Israeli calendar.
 *
 * Exported because the page needs it too, and a page that computed it from
 * UTC would disagree with this module for the first two or three hours of
 * every 1st of the month — defaulting to the previous month, calling it
 * current, and showing a setup flow the domain layer says is a past month.
 */
export function currentMonth(now: Date = new Date()): string {
  return israelDate(now).slice(0, 7);
}

/** Every month from `from` up to and including `to`, in order. */
export function monthRange(from: string, to: string): string[] {
  const months: string[] = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) months.push(m);
  return months;
}

// --- Views ------------------------------------------------------------------

export interface BudgetRowView {
  /** Null on the residual row — it stands for every category no other
   * ceiling reaches, so there is no single one to point at. */
  categoryId: string | null;
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

/** One of the two sections, with its own subtotals — the Everyday subtotal is
 * the number a user can actually act on, and a single blended total is
 * useless when most of it was never discretionary. Summed here so the display
 * edge never adds money together. */
export interface BudgetSectionView {
  rows: BudgetRowView[];
  ceiling: Money;
  spent: Money;
}

export interface BudgetMonthView {
  month: string;
  currency: string;
  /** True when at least one ceiling is in force — the page's empty state. */
  hasBudget: boolean;
  fixed: BudgetSectionView;
  everyday: BudgetSectionView;
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
  /** Spending that a ceiling governs — `spentTotal` minus `unbudgetedSpend`.
   * The only figure comparable with `ceilingTotal`, and so the only honest
   * numerator for "how much of my budget is gone". */
  budgetedSpend: Money;
  /** Days remaining in the month, today excluded. Null for a past month. */
  daysLeft: number | null;
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
  /** Null is the residual ceiling. */
  categoryId: string | null;
  categoryName: string;
  amount: Money;
  effectiveFrom: string;
  rollover: boolean;
}

export interface CeilingSuggestion {
  categoryId: string;
  categoryName: string;
  /** The category's average monthly spend over the chosen window — the
   * recommended ceiling, and what the wizard pre-fills. */
  amount: Money;
  /** Which step of the wizard this belongs in, on the same `is_recurring`
   * reading (parent included) that splits the budget page's two sections. A
   * fixed cost is near-certain and is confirmed; everyday spending is a
   * judgement the user has to make. */
  kind: "fixed" | "everyday";
  /** What the category actually cost in each month of the window, oldest
   * first and including the months it cost nothing. This is what lets the
   * wizard show whether ₪1,900 is typical or one bad month — a mean alone
   * cannot be argued with. */
  history: { month: string; amount: Money }[];
  /** The cheapest and dearest months in the window. Offered as the two
   * alternatives to the mean, so "tight" and "roomy" are numbers the user
   * genuinely lived through rather than a percentage we invented. */
  lowest: Money;
  highest: Money;
  /** Whether to switch rollover on. True only for spending that does not
   * arrive every month — see `looksLumpy`. */
  rollover: boolean;
  /** One sentence naming why, or null when rollover is not recommended.
   * A recommendation the user cannot interrogate is just a default. */
  rolloverReason: string | null;
}

// --- Internal row helpers ---------------------------------------------------

interface CeilingRow {
  /** Null is the residual ceiling — see `RESIDUAL_KEY`. */
  categoryId: string | null;
  /** Null ends the line from `effectiveFrom` — this category stops being
   * budgeted, and the months before it keep the numbers they had. */
  amount: Decimal | null;
  effectiveFrom: string;
  rollover: boolean;
}

async function loadCeilings(tx: Tx, dataKey: Uint8Array): Promise<CeilingRow[]> {
  const rows = await tx.select().from(budgetCeilings).orderBy(asc(budgetCeilings.effectiveFrom));
  return rows.map((row) => ({
    categoryId: row.categoryId,
    amount: row.amountCt
      ? new Decimal(decText(dataKey, row.amountCt, row.id, "amount_ct", row.version) ?? "0")
      : null,
    effectiveFrom: row.effectiveFrom,
    rollover: row.rollover,
  }));
}

/**
 * The ceiling in force for each category in `month` — the latest row whose
 * `effective_from` is not in the future. `rows` must be ordered by
 * `effective_from` ascending.
 *
 * A row with no amount ends the line, so it *removes* the entry rather than
 * replacing it. A later row can start the category budgeting again, which is
 * why this is a delete-and-continue and not a stop.
 */
function ceilingsInForce(rows: CeilingRow[], month: string): Map<string, InForceCeiling> {
  const inForce = new Map<string, InForceCeiling>();
  const cutoff = monthStart(month);
  for (const row of rows) {
    if (row.effectiveFrom > cutoff) continue;
    const key = row.categoryId ?? RESIDUAL_KEY;
    if (row.amount === null) inForce.delete(key);
    else inForce.set(key, { ...row, amount: row.amount }); // ascending, so the last wins
  }
  return inForce;
}

/** A ceiling that is actually in force, so its amount is known to exist. */
type InForceCeiling = CeilingRow & { amount: Decimal };

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

/**
 * Every real category carrying a ceiling in `month`. The residual is
 * excluded on purpose: it is defined as whatever this set fails to reach, so
 * including it would make it cover itself.
 */
function budgetedIdsIn(rows: CeilingRow[], month: string): Set<string> {
  const ids = new Set<string>();
  for (const key of ceilingsInForce(rows, month).keys()) {
    if (key !== RESIDUAL_KEY) ids.add(key);
  }
  return ids;
}

/**
 * What "everything else" cost in `month`: uncategorized spending, plus every
 * category no ceiling in `budgeted` reaches. Returned as a positive
 * magnitude, like `spentOn`.
 *
 * `budgeted` is passed in rather than derived so a rollover replay can hand
 * it the set that was in force in *that* month — budgeting Pharmacy today
 * must not change what March's residual contained.
 */
function residualSpentOn(
  month: string,
  flows: MonthlyFlows,
  budgeted: Set<string>,
  cats: Map<string, CategoryRow>,
): Decimal {
  let total = flows.uncategorizedSpend.get(month) ?? new Decimal(0);
  for (const [categoryId, amount] of flows.byCategory.get(month) ?? []) {
    if (budgetedCategoryOf(categoryId, budgeted, cats) === null) total = total.plus(amount);
  }
  return total.negated();
}

/**
 * The surplus (or deficit) a rollover ceiling carries into `month`, replayed
 * from `fromMonth`.
 *
 * One function for both a category's ceiling and the residual's, because the
 * rules are identical and must stay identical: both signs carry, and a past
 * month contributes only if the ceiling in force *then* had rollover on — so
 * switching rollover on today never hands back history the user never
 * budgeted for. They differ only in what "spent" means, which is the
 * `spentIn` argument.
 *
 * Returns null when this ceiling does not roll over, so the caller can tell
 * "carried nothing" from "does not carry".
 */
function carriedInto(
  key: string,
  month: string,
  fromMonth: string,
  ceilingRows: CeilingRow[],
  rollsOver: boolean,
  spentIn: (month: string) => Decimal,
): Decimal | null {
  if (!rollsOver) return null;
  let carried = new Decimal(0);
  for (const past of monthRange(fromMonth, shiftMonth(month, -1))) {
    const pastCeiling = ceilingsInForce(ceilingRows, past).get(key);
    if (!pastCeiling || !pastCeiling.rollover) continue;
    carried = carried.plus(pastCeiling.amount).minus(spentIn(past));
  }
  return carried;
}

/** Exact, unrounded — rounding to a currency's minor unit happens at the
 * display edge and never here (money-and-currency.md §3). */
const money = (amount: Decimal, currency: string): Money => ({
  amount: amount.toFixed(),
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

  return withUser(userId, async (tx) => {
    const [cats, ceilingRows] = await Promise.all([loadCategories(tx), loadCeilings(tx, dataKey)]);
    const inForce = ceilingsInForce(ceilingRows, month);
    // Only real categories go in here: it is what decides which category a
    // given entry is filed under, and the residual is by definition the
    // ceiling for everything this set does *not* reach.
    const budgeted = budgetedIdsIn(ceilingRows, month);

    // A local category shared with a household has its budget at the household
    // level (issue #115). Suppress — never delete — any personal ceiling on it:
    // drop it from the in-force set so the personal screen shows no rival
    // ceiling, and its spend flows into "everything else". Unmapping restores
    // the ceiling on the next read, since the row was left untouched.
    const shared = await mappedLocalCategoryIds(tx);
    for (const id of shared) {
      inForce.delete(id);
      budgeted.delete(id);
    }

    // Replay only as far back as a rollover ceiling actually reaches; without
    // one, this month alone is all the aggregation needs to read.
    const rolloverStart = ceilingRows
      .filter((row) => row.rollover && inForce.has(row.categoryId ?? RESIDUAL_KEY))
      .map((row) => row.effectiveFrom.slice(0, 7))
      .sort()[0];
    const fromMonth = rolloverStart && rolloverStart < month ? rolloverStart : month;
    const flows = await loadMonthlyFlows(tx, dataKey, cats, fromMonth, month);

    const rows: BudgetRowView[] = [];
    let ceilingTotal = new Decimal(0);
    let budgetedSpend = new Decimal(0);
    let overBudgetCount = 0;

    for (const [categoryId, ceiling] of inForce) {
      if (categoryId === RESIDUAL_KEY) continue; // handled below, once the
      // per-category rows are known and "everything else" has a meaning
      const category = cats.get(categoryId);
      if (!category) continue; // category deleted out from under the ceiling
      const spent = spentOn(categoryId, month, flows, budgeted, cats);

      const carriedIn = carriedInto(
        categoryId,
        month,
        fromMonth,
        ceilingRows,
        ceiling.rollover,
        (past) => spentOn(categoryId, past, flows, budgeted, cats),
      );

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
    const residualSpend = residualSpentOn(month, flows, budgeted, cats);
    const residual = inForce.get(RESIDUAL_KEY);

    if (residual) {
      // Replayed against the categories that were budgeted in each past
      // month, not today's — otherwise giving Pharmacy its own ceiling now
      // would retroactively shrink what the residual carried out of March.
      const carriedIn = carriedInto(
        RESIDUAL_KEY,
        month,
        fromMonth,
        ceilingRows,
        residual.rollover,
        (past) => residualSpentOn(past, flows, budgetedIdsIn(ceilingRows, past), cats),
      );

      const available = residual.amount.plus(carriedIn ?? new Decimal(0));
      const remaining = available.minus(residualSpend);
      if (remaining.isNegative()) overBudgetCount += 1;
      ceilingTotal = ceilingTotal.plus(residual.amount);
      budgetedSpend = budgetedSpend.plus(residualSpend);

      // Last in its section: it is the line every other line is defined
      // against, so reading it before them says nothing.
      rows.push({
        categoryId: null,
        categoryName: RESIDUAL_NAME,
        color: null,
        icon: null,
        // Never Fixed. A bill you can name is a bill you can budget; what
        // lands here is by definition the spending you did not itemize.
        isRecurring: false,
        ceiling: money(residual.amount, baseCurrency),
        available: money(available, baseCurrency),
        spent: money(residualSpend, baseCurrency),
        remaining: money(remaining, baseCurrency),
        rollover: residual.rollover,
        carriedIn: carriedIn ? money(carriedIn, baseCurrency) : null,
      });
    }

    // Once a residual ceiling exists, this spending is budgeted — counting it
    // here as well would double it into `spentTotal`.
    const unbudgetedSpend = residual ? new Decimal(0) : residualSpend;

    const actualIncome = flows.income.get(month) ?? new Decimal(0);
    const spentTotal = budgetedSpend.plus(unbudgetedSpend);
    const plannedIncome = await plannedIncomeFor(tx, dataKey, month);
    const pace = month === currentMonth() ? paceOf(today) : null;

    const fixed = section(
      rows.filter((row) => row.isRecurring),
      baseCurrency,
    );
    const everyday = section(
      rows.filter((row) => !row.isRecurring),
      baseCurrency,
    );

    return {
      month,
      currency: baseCurrency,
      hasBudget: rows.length > 0,
      fixed,
      everyday,
      unbudgetedSpend: money(unbudgetedSpend, baseCurrency),
      ceilingTotal: money(ceilingTotal, baseCurrency),
      spentTotal: money(spentTotal, baseCurrency),
      plannedIncome: plannedIncome ? money(plannedIncome, baseCurrency) : null,
      actualIncome: money(actualIncome, baseCurrency),
      plannedSavings: plannedIncome ? money(plannedIncome.minus(ceilingTotal), baseCurrency) : null,
      actualSavings: money(actualIncome.minus(spentTotal), baseCurrency),
      budgetedSpend: money(budgetedSpend, baseCurrency),
      daysLeft: pace === null ? null : daysLeftIn(today),
      overBudgetCount,
      pace,
    };
  });
}

function section(rows: BudgetRowView[], currency: string): BudgetSectionView {
  const total = (pick: (row: BudgetRowView) => Money) =>
    rows.reduce((sum, row) => sum.plus(new Decimal(pick(row).amount)), new Decimal(0));
  return {
    rows,
    ceiling: money(
      total((row) => row.ceiling),
      currency,
    ),
    spent: money(
      total((row) => row.spent),
      currency,
    ),
  };
}

/** Fraction of the month elapsed at `today`, counting today as spent — the
 * 8th of a 31-day month is 8/31, not 7/31, because today's money is already
 * at risk. */
function paceOf(today: string): number {
  return Number(today.slice(8, 10)) / daysIn(today.slice(0, 7));
}

/** How many days the month has. */
function daysIn(month: string): number {
  return Number(monthEnd(month).slice(8, 10));
}

/** Days still to come this month, today excluded — today is already counted
 * as spent by `paceOf`, and counting it twice would say the month has one
 * more day of room than it does. */
function daysLeftIn(today: string): number {
  return daysIn(today.slice(0, 7)) - Number(today.slice(8, 10));
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
        categoryName: row.categoryId ? (cats.get(row.categoryId)?.name ?? "") : RESIDUAL_NAME,
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

    // A month the user only joined partway through is not a month of
    // history: averaging a three-day May in as if it were a whole one drags
    // every suggestion down. It counts only if the first entry lands on the
    // 1st; otherwise history starts the month after.
    const firstFull =
      earliest.date.endsWith("-01") ? earliest.date.slice(0, 7) : shiftMonth(earliest.date.slice(0, 7), 1); // prettier-ignore
    const lastComplete = shiftMonth(currentMonth(), -1);
    if (firstFull > lastComplete) return 0;
    return Math.min(monthRange(firstFull, lastComplete).length, 12);
  });
}

/**
 * Whether a category's monthly spending arrives in lumps rather than every
 * month — the only case where rollover should be switched on for the user.
 *
 * Read straight off the months: a bill charged every two months, or once a
 * year, is simply zero in the months between. Groceries never are. That is a
 * better signal than the payee's cadence, because a category collects several
 * payees and it is the *category* that carries the ceiling.
 *
 * Requires a zero month **and** at least one month of real spending, so a
 * category with a single month of history — which is all zeroes but one, by
 * construction — does not get rollover on the strength of having no history.
 */
function looksLumpy(series: Decimal[]): boolean {
  if (series.length < 3) return false;
  const quiet = series.filter((m) => m.isZero()).length;
  return quiet > 0 && quiet < series.length;
}

/** What the wizard is handed: a proposed ceiling per category, and a planned
 * income to check them against. */
export interface BudgetProposal {
  ceilings: CeilingSuggestion[];
  /** Average monthly income over the same window, or null if none was
   * earned. A starting figure for the planned-income step, not a claim about
   * next month. */
  income: Money | null;
  /**
   * Average monthly spending that carried **no category at all** — the
   * starting figure for the residual ("everything else") ceiling.
   *
   * History cannot price the rest of what a residual is for. Every category
   * with spending is about to be proposed as its own line, so what is left
   * over in the window is only the uncategorized part; the room for
   * categories that don't exist yet is a forward-looking choice the user
   * makes by dropping lines or typing a bigger number.
   */
  uncategorized: Money;
}

/**
 * A whole proposed budget, from what the user actually spent and earned over
 * the last `windowMonths` complete months.
 *
 * Suggested at the level entries are filed on — the leaf — so accepting the
 * whole set can never violate one-ceiling-per-branch. Nothing is written
 * until the user accepts, the same posture as categorization suggestions.
 *
 * A non-monthly category (annual insurance, ארנונה) still comes out low if
 * the window is shallower than its period: a 3-month window cannot see a
 * charge that lands in month 7, and no amount of arithmetic recovers it. What
 * the window *can* see, it flags — see `looksLumpy`.
 */
export async function proposeBudget(
  session: Session,
  windowMonths: number,
): Promise<BudgetProposal> {
  const { userId, dataKey, baseCurrency } = session;
  return withUser(userId, async (tx) => {
    const cats = await loadCategories(tx);
    const lastComplete = shiftMonth(currentMonth(), -1);
    const fromMonth = shiftMonth(lastComplete, -(windowMonths - 1));
    const months = monthRange(fromMonth, lastComplete);
    const flows = await loadMonthlyFlows(tx, dataKey, cats, fromMonth, lastComplete);

    // Per category, what it cost in every month of the window — including
    // the months it cost nothing, which is the whole signal `looksLumpy`
    // reads and which a running total would have thrown away.
    const perMonth = new Map<string, Decimal[]>();
    for (const month of months) {
      const monthTotals = flows.byCategory.get(month);
      for (const categoryId of new Set([...(monthTotals?.keys() ?? []), ...perMonth.keys()])) {
        const spent = (monthTotals?.get(categoryId) ?? new Decimal(0)).negated();
        const series = perMonth.get(categoryId) ?? months.map(() => new Decimal(0));
        series[months.indexOf(month)] = spent.isPositive() ? spent : new Decimal(0);
        perMonth.set(categoryId, series);
      }
    }

    const earned = months.reduce(
      (acc, month) => acc.plus(flows.income.get(month) ?? new Decimal(0)),
      new Decimal(0),
    );

    const ceilings = [...perMonth]
      .map(([categoryId, series]) => {
        const total = series.reduce((acc, m) => acc.plus(m), new Decimal(0));
        const lumpy = looksLumpy(series);
        return {
          categoryId,
          categoryName: cats.get(categoryId)?.name ?? "",
          kind: isRecurringWithInheritance(categoryId, cats)
            ? ("fixed" as const)
            : ("everyday" as const),
          average: total.dividedBy(months.length),
          series,
          lumpy,
        };
      })
      // A category whose window nets out to nothing spent is not a budget
      // line worth proposing.
      .filter((row) => row.average.greaterThan(0))
      .sort((a, b) => b.average.comparedTo(a.average))
      .map((row) => ({
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        kind: row.kind,
        amount: money(row.average, baseCurrency),
        history: months.map((month, i) => ({
          month,
          amount: money(row.series[i], baseCurrency),
        })),
        lowest: money(Decimal.min(...row.series), baseCurrency),
        highest: money(Decimal.max(...row.series), baseCurrency),
        rollover: row.lumpy,
        rolloverReason: row.lumpy
          ? "This does not arrive every month, so an unspent month should pay for the month it lands in."
          : null,
      }));

    const uncategorized = months.reduce(
      (acc, month) => acc.plus(flows.uncategorizedSpend.get(month) ?? new Decimal(0)),
      new Decimal(0),
    );

    return {
      ceilings,
      income: earned.greaterThan(0) ? money(earned.dividedBy(months.length), baseCurrency) : null,
      uncategorized: money(uncategorized.negated().dividedBy(months.length), baseCurrency),
    };
  });
}

// --- History ----------------------------------------------------------------

/** Explicit locale, matching `domain/recurring.ts` — the chart is a client
 * component, so the label has to be finished before it crosses the boundary. */
const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });

/** One complete month, as the history chart draws it. */
export interface BudgetHistoryPoint {
  month: string;
  /** Pre-formatted on the server — a chart is a client component, and one
   * that called `toLocaleDateString()` would hydrate differently than it
   * rendered (.agents/skills/ui-developer). */
  label: string;
  income: Money;
  /** Every shekel that left, budgeted or not — the same figure the month
   * page calls `spentTotal`, so the two screens cannot disagree. */
  spent: Money;
  /**
   * What the budget allowed that month: the ceilings in force, each with
   * whatever a rollover line had accrued into it. The accrual is the point —
   * a ₪500/month insurance line that has been saving since January genuinely
   * *was* allowed ₪6,000 in the month the annual charge landed, and a plan
   * bar drawn from the bare ceiling would call that month a disaster.
   */
  planned: Money;
}

/** A ceiling that history says is set wrong, and by how much. */
export interface CeilingVerdict {
  /** Null is the residual — "everything else". */
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  icon: string | null;
  /** The ceiling in force now: the number the suggestion would replace. */
  ceiling: Money;
  averageSpend: Money;
  /** `averageSpend - ceiling`. Positive means the ceiling is too low. */
  variance: Money;
  monthsObserved: number;
  /** Of those months, how many finished over what was available. Kept beside
   * the average because "over in 5 of 6" and "over in 1 of 6 by a lot" are
   * different problems and the mean alone cannot tell them apart. */
  monthsOver: number;
  rollover: boolean;
  direction: "under-budgeted" | "over-budgeted";
}

export interface BudgetHistoryView {
  currency: string;
  /** Oldest first. Empty until at least one complete month has been budgeted. */
  months: BudgetHistoryPoint[];
  /** Worst divergence first. */
  verdicts: CeilingVerdict[];
}

/** How many complete months a line must have been in force before its average
 * is worth arguing with. */
const VERDICT_MIN_MONTHS = 3;

/** A rollover line needs more. It exists precisely because its spending is
 * *not* monthly, so a window shallower than its cycle sees only the quiet
 * months and would confidently recommend cutting the ceiling that pays for
 * the charge it cannot see. */
const VERDICT_MIN_ROLLOVER_MONTHS = 6;

/** How far the average has to sit from the ceiling before it is worth saying
 * anything, as a fraction of the ceiling. Below this it is ordinary
 * month-to-month variation, not a ceiling set wrong. */
const VERDICT_THRESHOLD = new Decimal("0.15");

interface LineMonth {
  month: string;
  /** The bare ceiling in force that month. */
  ceiling: Decimal;
  /** `ceiling` plus anything a rollover line had accrued — what that month's
   * spending was actually measured against. */
  available: Decimal;
  spent: Decimal;
}

/**
 * One ceiling's whole run through the window: what it allowed and what it
 * cost, in each month it was in force.
 *
 * A single forward pass, deliberately reproducing `carriedInto`'s rule rather
 * than calling it once per month: a month whose ceiling had rollover **off**
 * contributes nothing to the balance and does not reset it, and a month with
 * no ceiling at all does neither. Those are the semantics the month page
 * ships, and a history that used any other rule would restate months the user
 * has already read.
 */
function lineHistory(
  key: string,
  months: string[],
  ceilingRows: CeilingRow[],
  flows: MonthlyFlows,
  cats: Map<string, CategoryRow>,
): LineMonth[] {
  const out: LineMonth[] = [];
  let carried = new Decimal(0);
  for (const month of months) {
    const inForce = ceilingsInForce(ceilingRows, month).get(key);
    if (!inForce) continue;
    // The residual is defined against whatever was budgeted in *that* month,
    // not today — budgeting Pharmacy now must not rewrite what March's
    // "everything else" contained.
    const budgeted = budgetedIdsIn(ceilingRows, month);
    const spent =
      key === RESIDUAL_KEY
        ? residualSpentOn(month, flows, budgeted, cats)
        : spentOn(key, month, flows, budgeted, cats);
    const available = inForce.rollover ? inForce.amount.plus(carried) : inForce.amount;
    out.push({ month, ceiling: inForce.amount, available, spent });
    if (inForce.rollover) carried = carried.plus(inForce.amount).minus(spent);
  }
  return out;
}

/**
 * Income, spending and the plan for every complete month a budget governed,
 * plus a verdict on each ceiling that history says is set wrong.
 *
 * The window starts at the first month any ceiling took effect — before that
 * there is no plan to draw a bar against — and stops at the last **complete**
 * month. A month still being lived has partial income and partial spending;
 * drawn beside whole months it reads as a windfall followed by a collapse.
 */
export async function getBudgetHistory(session: Session): Promise<BudgetHistoryView> {
  const { userId, dataKey, baseCurrency } = session;

  return withUser(userId, async (tx) => {
    const [cats, ceilingRows] = await Promise.all([loadCategories(tx), loadCeilings(tx, dataKey)]);

    // `loadCeilings` orders by `effective_from`, so the first row is the
    // earliest month any budget existed.
    const firstMonth = ceilingRows[0]?.effectiveFrom.slice(0, 7);
    const lastMonth = shiftMonth(currentMonth(), -1);
    if (!firstMonth || firstMonth > lastMonth) {
      return { currency: baseCurrency, months: [], verdicts: [] };
    }

    const months = monthRange(firstMonth, lastMonth);
    const flows = await loadMonthlyFlows(tx, dataKey, cats, firstMonth, lastMonth);

    // Every ceiling that was in force at any point in the window, each walked
    // once. Both the chart and the verdicts read these same series, so the
    // plan bar and the advice underneath it can never disagree.
    const keys = new Set<string>();
    for (const month of months) {
      for (const key of ceilingsInForce(ceilingRows, month).keys()) keys.add(key);
    }
    const lines = new Map(
      [...keys].map((key) => [key, lineHistory(key, months, ceilingRows, flows, cats)]),
    );

    const planned = new Map(months.map((month) => [month, new Decimal(0)]));
    const spent = new Map(months.map((month) => [month, new Decimal(0)]));
    for (const line of lines.values()) {
      for (const m of line) {
        planned.set(m.month, planned.get(m.month)!.plus(m.available));
        spent.set(m.month, spent.get(m.month)!.plus(m.spent));
      }
    }
    // Spending no ceiling reached still left the account. Counted only while
    // no residual ceiling governs it, or the residual's own line above would
    // have counted it already.
    for (const month of months) {
      if (ceilingsInForce(ceilingRows, month).has(RESIDUAL_KEY)) continue;
      const uncovered = residualSpentOn(month, flows, budgetedIdsIn(ceilingRows, month), cats);
      spent.set(month, spent.get(month)!.plus(uncovered));
    }

    const points: BudgetHistoryPoint[] = months.map((month) => ({
      month,
      label: MONTH_LABEL.format(new Date(`${monthStart(month)}T00:00:00Z`)),
      income: money(flows.income.get(month) ?? new Decimal(0), baseCurrency),
      spent: money(spent.get(month)!, baseCurrency),
      planned: money(planned.get(month)!, baseCurrency),
    }));

    // Only lines still in force are worth a verdict: the fix writes a new
    // ceiling from this month forward, and there is nothing to re-tune on a
    // line the user has already stopped budgeting.
    const live = ceilingsInForce(ceilingRows, currentMonth());
    const verdicts: CeilingVerdict[] = [];

    for (const [key, ceiling] of live) {
      if (!ceiling.amount.isPositive()) continue; // no ceiling to take a fraction of
      const series = lines.get(key) ?? [];
      const minMonths = ceiling.rollover ? VERDICT_MIN_ROLLOVER_MONTHS : VERDICT_MIN_MONTHS;
      if (series.length < minMonths) continue;
      // A rollover line whose window is all quiet months is one whose charge
      // simply has not landed yet. Saying anything about it would be advice
      // drawn from the absence of evidence.
      if (ceiling.rollover && series.every((m) => m.spent.isZero())) continue;

      const category = key === RESIDUAL_KEY ? null : cats.get(key);
      if (key !== RESIDUAL_KEY && !category) continue; // category deleted under the ceiling

      const total = series.reduce((sum, m) => sum.plus(m.spent), new Decimal(0));
      const average = total.dividedBy(series.length);
      const variance = average.minus(ceiling.amount);
      if (variance.abs().lessThan(ceiling.amount.times(VERDICT_THRESHOLD))) continue;

      verdicts.push({
        categoryId: key === RESIDUAL_KEY ? null : key,
        categoryName: category?.name ?? RESIDUAL_NAME,
        color: category?.color ?? null,
        icon: category?.icon ?? null,
        ceiling: money(ceiling.amount, baseCurrency),
        averageSpend: money(average, baseCurrency),
        variance: money(variance, baseCurrency),
        monthsObserved: series.length,
        monthsOver: series.filter((m) => m.spent.greaterThan(m.available)).length,
        rollover: ceiling.rollover,
        direction: variance.isPositive() ? "under-budgeted" : "over-budgeted",
      });
    }

    // Worst first — a ₪40 drift on a ₪200 line clears the threshold, and it
    // is not the line anyone should look at first.
    verdicts.sort((a, b) =>
      new Decimal(b.variance.amount).abs().comparedTo(new Decimal(a.variance.amount).abs()),
    );

    return { currency: baseCurrency, months: points, verdicts };
  });
}

// --- Writes -----------------------------------------------------------------

export interface SetCeilingInput {
  /** Null sets the residual ceiling — "everything else". */
  categoryId: string | null;
  /** Canonical decimal string, positive — a ceiling is a spending target. */
  amount: string;
  /** The month it takes effect, "YYYY-MM". */
  effectiveFrom: string;
  rollover: boolean;
}

/** The real categories among a set of ceiling rows — the residual's null is
 * dropped, since the branch rule only speaks about the category tree. */
function budgetedIdsOf(rows: { categoryId: string | null }[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) if (row.categoryId !== null) ids.add(row.categoryId);
  return ids;
}

/**
 * The two rules that decide whether a category may carry a ceiling at all.
 * Both write paths go through here — `setCeiling` and the batch
 * `createCeilings` — because either one alone is a public route, and an
 * invariant enforced on only one of them is not enforced.
 *
 * `budgetedIds` is every category that already has a ceiling, plus (for a
 * batch) every category the same batch proposes: a batch that budgets both a
 * parent and its child is exactly as ambiguous as doing it in two calls.
 */
function assertBudgetable(
  cats: Map<string, CategoryRow>,
  budgetedIds: Set<string>,
  categoryId: string | null,
): void {
  // The residual ceiling sits outside the category tree, so neither rule
  // applies: it has no classification to check and no branch to conflict
  // with. It also cannot duplicate — the unique index is NULLS NOT DISTINCT.
  if (categoryId === null) return;
  const category = cats.get(categoryId);
  if (!category) throw new BudgetCategoryNotBudgetableError("No such category");
  if (category.classification !== "expense") {
    throw new BudgetCategoryNotBudgetableError(
      `"${category.name}" is not an expense category — only spending takes a ceiling`,
    );
  }
  // One authority per shekel: a parent and its children cannot both carry a
  // ceiling, or "over budget" would have two answers.
  if (category.parentId && budgetedIds.has(category.parentId)) {
    throw new BudgetBranchConflictError(cats.get(category.parentId)?.name ?? "the parent group");
  }
  for (const [id, row] of cats) {
    if (id !== categoryId && row.parentId === categoryId && budgetedIds.has(id)) {
      throw new BudgetBranchConflictError(row.name);
    }
  }
}

/**
 * Refuses a personal ceiling on a local category that is mapped to a shared
 * household line — that branch's budget is the household ceiling (issue #115).
 * A no-op for users in no household (the mapped set is empty).
 */
async function assertNotShared(
  tx: Tx,
  cats: Map<string, CategoryRow>,
  categoryId: string | null,
): Promise<void> {
  if (categoryId === null) return;
  const mapped = await mappedLocalCategoryIds(tx);
  if (mapped.has(categoryId)) {
    throw new BudgetCategorySharedError(cats.get(categoryId)?.name ?? "This category");
  }
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
    const existing = await tx.select().from(budgetCeilings);
    assertBudgetable(cats, budgetedIdsOf(existing), input.categoryId);
    await assertNotShared(tx, cats, input.categoryId);

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

/**
 * Stops budgeting a category from `effectiveFrom` forward, leaving every
 * earlier month exactly as it was lived.
 *
 * Written as an ordinary effective-dated row with no amount, not as a
 * DELETE. Deleting the history would restate every finished month against a
 * budget that no longer exists — March would stop being over budget because
 * of something the user did in August — and a past month telling the truth is
 * the entire reason these rows are effective-dated (ADR 0010).
 *
 * Ending a line that was never in force in an earlier month is therefore a
 * no-op rather than an error: there is nothing to end and nothing to keep.
 */
export async function endCeiling(
  session: Session,
  categoryId: string | null,
  effectiveFrom: string,
): Promise<void> {
  const { userId } = session;
  await withUser(userId, async (tx) => {
    const from = monthStart(effectiveFrom);
    // `= NULL` matches nothing in SQL, so the residual needs `IS NULL`.
    const sameCategory =
      categoryId === null
        ? isNull(budgetCeilings.categoryId)
        : eq(budgetCeilings.categoryId, categoryId);

    const [replaced] = await tx
      .select()
      .from(budgetCeilings)
      .where(and(sameCategory, eq(budgetCeilings.effectiveFrom, from)));

    // A ceiling set this month and ended this month leaves no row at all:
    // the month never had one in force, so there is no history to protect.
    if (replaced) {
      await tx.delete(budgetCeilings).where(eq(budgetCeilings.id, replaced.id));
    }

    const stillBudgeted = ceilingsInForce(await loadCeilingRowsFor(tx), effectiveFrom).has(
      categoryId ?? RESIDUAL_KEY,
    );
    if (!stillBudgeted) return;

    await tx.insert(budgetCeilings).values({
      id: randomUUID(),
      ownerId: userId,
      categoryId,
      amountCt: null,
      effectiveFrom: from,
      rollover: false,
    });
  });
}

/** The ceiling rows, structural columns only — enough for `ceilingsInForce`,
 * which never looks at an amount, and so needs no data key. */
async function loadCeilingRowsFor(tx: Tx): Promise<CeilingRow[]> {
  const rows = await tx
    .select({
      categoryId: budgetCeilings.categoryId,
      amountCt: budgetCeilings.amountCt,
      effectiveFrom: budgetCeilings.effectiveFrom,
      rollover: budgetCeilings.rollover,
    })
    .from(budgetCeilings)
    .orderBy(asc(budgetCeilings.effectiveFrom));
  return rows.map((row) => ({
    categoryId: row.categoryId,
    // Only presence matters here, so the ciphertext is never opened.
    amount: row.amountCt ? new Decimal(0) : null,
    effectiveFrom: row.effectiveFrom,
    rollover: row.rollover,
  }));
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
    const existing = await tx.select().from(budgetCeilings);
    const budgetedIds = budgetedIdsOf([...existing, ...inputs]);

    for (const input of inputs) {
      assertBudgetable(cats, budgetedIds, input.categoryId);
      await assertNotShared(tx, cats, input.categoryId);
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

/** A category that finished the month over what its ceiling allowed. */
export interface OverBudgetCategory {
  /** Null is the residual — "everything else". */
  categoryId: string | null;
  categoryName: string;
  /** How far past the available ceiling, as a positive magnitude. */
  over: Money;
}

/** The one line the dashboard card needs. Deliberately the same computation
 * as the page, not a second one that could disagree with it. */
export async function getBudgetSummary(session: Session): Promise<{
  hasBudget: boolean;
  month: string;
  spent: Money;
  ceilingTotal: Money;
  overBudgetCount: number;
  /** Which categories are over, worst first — so the dashboard can name them
   * instead of only counting. Derived from the same rows `overBudgetCount` is,
   * so the two can never disagree. */
  overCategories: OverBudgetCategory[];
}> {
  const month = currentMonth();
  const view = await getBudgetMonth(session, month);
  const overCategories = [...view.fixed.rows, ...view.everyday.rows]
    // `remaining` is `available - spent`, already exact; negative means over.
    .filter((row) => new Decimal(row.remaining.amount).isNegative())
    .map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      over: money(new Decimal(row.remaining.amount).negated(), view.currency),
    }))
    .sort((a, b) => new Decimal(b.over.amount).comparedTo(new Decimal(a.over.amount)));
  return {
    hasBudget: view.hasBudget,
    month,
    // The card is about the budget, so it shows budgeted spend against the
    // ceilings — not `spentTotal`, which includes money no ceiling governs.
    spent: view.budgetedSpend,
    ceilingTotal: view.ceilingTotal,
    overBudgetCount: view.overBudgetCount,
    overCategories,
  };
}
