// Domain read: server-side aggregation over the whole ledger (issue #113
// Phase 3, docs/design/mcp-and-api.md §6). The AI agent surface's workhorse —
// it groups and sums entries in the app tier so a model gets computed figures,
// never a year of raw rows to add up itself.
//
// Every money rule here is the SAME one the dashboard uses (src/domain/
// dashboard.ts), deliberately not a second implementation:
//   * a flow is judged by `countsAsFlow` (excluded / transfer categories out);
//   * pending-FX entries are skipped, never faked to 1:1;
//   * the reporting amount is entered × the entry's own locked fx_rate;
//   * all arithmetic is decimal.js, returned as exact strings.
import Decimal from "decimal.js";
import { and, eq, gte, lte } from "drizzle-orm";
import { withUser } from "@/db/client";
import { categories, entries } from "@/db/schema";
import { multiply } from "@/lib/money";
import { decText } from "./fields";
import { countsAsFlow, loadTransferCategoryIds } from "./flows";

export type SpendingGroupBy = "category" | "month";

export interface SpendingGroup {
  /** Group key: a category id, `"uncategorized"`, or a `"YYYY-MM"` month. */
  key: string;
  label: string;
  income: string;
  /** Positive magnitude. */
  expenses: string;
  net: string;
}

export interface SpendingAggregate {
  baseCurrency: string;
  groupBy: SpendingGroupBy;
  /** The window actually applied (echoing back resolved/defaulted bounds). */
  from: string | null;
  to: string | null;
  groups: SpendingGroup[];
  totals: { income: string; expenses: string; net: string };
  /** Entries that counted toward the totals. */
  countedEntries: number;
  /** Entries in range dropped because their FX rate is not locked yet — their
   * base-currency amount is unknowable, so they are excluded, not guessed. */
  skippedPendingFx: number;
}

/**
 * Groups the user's flow entries and sums them, in base currency, through the
 * domain's own money math. `from`/`to` are inclusive ISO dates; omit either to
 * leave that side unbounded (the full ledger). Runs RLS-scoped to `userId`.
 */
export async function aggregateSpending(
  userId: string,
  dataKey: Buffer,
  baseCurrency: string,
  opts: {
    from?: string;
    to?: string;
    groupBy: SpendingGroupBy;
    /** Narrow to one category / merchant — used to reconcile a filtered raw
     * drill-down against Moni's own totals for the same filter. */
    categoryId?: string;
    merchantId?: string;
  },
): Promise<SpendingAggregate> {
  const { from, to, groupBy, categoryId, merchantId } = opts;
  return withUser(userId, async (tx) => {
    const conds = [];
    if (from) conds.push(gte(entries.date, from));
    if (to) conds.push(lte(entries.date, to));
    if (categoryId) conds.push(eq(entries.categoryId, categoryId));
    if (merchantId) conds.push(eq(entries.merchantId, merchantId));
    const entryRows = await tx
      .select()
      .from(entries)
      .where(conds.length ? and(...conds) : undefined);

    const transferCategoryIds = await loadTransferCategoryIds(tx);
    const catRows = await tx.select({ id: categories.id, name: categories.name }).from(categories);
    const catName = new Map(catRows.map((c) => [c.id, c.name]));

    const buckets = new Map<string, { label: string; income: Decimal; expenses: Decimal }>();
    let countedEntries = 0;
    let skippedPendingFx = 0;

    for (const e of entryRows) {
      if (!countsAsFlow(e, transferCategoryIds)) continue;
      if (e.fxStatus === "pending" || !e.fxRate) {
        skippedPendingFx += 1;
        continue;
      }
      const entered = decText(dataKey, e.enteredAmountCt, e.id, "entered_amount_ct", e.version);
      if (entered == null) continue;
      const reporting = new Decimal(
        multiply({ amount: entered, currency: e.enteredCurrency }, e.fxRate).amount,
      );

      const [key, label] =
        groupBy === "month"
          ? [e.date.slice(0, 7), e.date.slice(0, 7)]
          : e.categoryId === null
            ? ["uncategorized", "Uncategorized"]
            : [e.categoryId, catName.get(e.categoryId) ?? "Unknown category"];

      const b = buckets.get(key) ?? { label, income: new Decimal(0), expenses: new Decimal(0) };
      if (reporting.isPositive()) b.income = b.income.plus(reporting);
      else b.expenses = b.expenses.plus(reporting.abs());
      buckets.set(key, b);
      countedEntries += 1;
    }

    let totalIncome = new Decimal(0);
    let totalExpenses = new Decimal(0);
    const groups: SpendingGroup[] = [...buckets.entries()]
      .map(([key, b]) => {
        totalIncome = totalIncome.plus(b.income);
        totalExpenses = totalExpenses.plus(b.expenses);
        return {
          key,
          label: b.label,
          income: b.income.toString(),
          expenses: b.expenses.toString(),
          net: b.income.minus(b.expenses).toString(),
        };
      })
      // Largest absolute impact first (month keys sort naturally too).
      .sort((a, b) =>
        groupBy === "month"
          ? a.key.localeCompare(b.key)
          : new Decimal(b.expenses)
              .plus(b.income)
              .comparedTo(new Decimal(a.expenses).plus(a.income)),
      );

    return {
      baseCurrency,
      groupBy,
      from: from ?? null,
      to: to ?? null,
      groups,
      totals: {
        income: totalIncome.toString(),
        expenses: totalExpenses.toString(),
        net: totalIncome.minus(totalExpenses).toString(),
      },
      countedEntries,
      skippedPendingFx,
    };
  });
}
