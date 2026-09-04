import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/money";
import { BudgetBar } from "@/components/budget-bar";
import { IncomeExpenseChart } from "@/components/income-expense-chart";
import { cn } from "@/lib/utils";
import type { Money as MoneyValue } from "@/lib/money";
import type { MonthPoint } from "@/domain/dashboard";
import type { OverBudgetCategory } from "@/domain/budget";

interface ThisMonthCardProps {
  monthLabel: string;
  income: MoneyValue;
  expenses: MoneyValue;
  budget: {
    hasBudget: boolean;
    spent: MoneyValue;
    ceilingTotal: MoneyValue;
    overBudgetCount: number;
    overCategories: OverBudgetCategory[];
  };
  months: MonthPoint[];
}

const LABEL = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

function OverChip({ category }: { category: OverBudgetCategory }) {
  const inner = (
    <>
      <bdi className="truncate">{category.categoryName}</bdi>
      <span className="shrink-0 text-negative">
        {"+"}
        <Money value={category.over} />
      </span>
    </>
  );
  const className =
    "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-negative/30 bg-negative/5 px-2.5 py-1 text-xs text-foreground transition hover:bg-negative/10";
  // The residual ("everything else") has no single category to filter to, so it
  // reads as plain text rather than a link that would lie (ui-and-feel, budget).
  return category.categoryId ? (
    <Link href={`/transactions?category=${category.categoryId}`} className={className}>
      {inner}
    </Link>
  ) : (
    <span className={className}>{inner}</span>
  );
}

/**
 * The month's day-to-day figures in one card — income, expenses, the budget
 * with its over-budget categories named, and a compact Income-vs-Expenses
 * sparkline. Grouped deliberately: three separate stat tiles spread the same
 * story across the view.
 */
export function ThisMonthCard({
  monthLabel,
  income,
  expenses,
  budget,
  months,
}: ThisMonthCardProps) {
  return (
    <Card data-tour="dash-this-month" className="overflow-hidden">
      <div className={cn(LABEL, "px-5 pb-3 pt-5")}>This month · {monthLabel}</div>

      <div className="grid grid-cols-2 border-t border-border">
        <div className="border-r border-border px-5 py-4">
          <span className={LABEL}>Income</span>
          <Money value={income} className="mt-1.5 block text-lg font-semibold text-positive" />
        </div>

        <div className="px-5 py-4">
          <span className={LABEL}>Expenses</span>
          <Money value={expenses} className="mt-1.5 block text-lg font-semibold text-negative" />
        </div>

        <div className="col-span-2 border-t border-border px-5 py-4">
          {budget.hasBudget ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <Link href="/budget" className={cn(LABEL, "transition hover:text-foreground")}>
                  Budget
                </Link>
                {budget.overBudgetCount > 0 ? (
                  <Link href="/budget" className="text-xs text-negative transition hover:underline">
                    {budget.overBudgetCount} over →
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">on track</span>
                )}
              </div>
              <p className="mt-1.5 text-lg font-semibold">
                <Money value={budget.spent} />
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  of <Money value={budget.ceilingTotal} />
                </span>
              </p>
              <div className="mt-2.5">
                {/* No pace marker: the total includes rent, 100% spent on day
                    one by design — same rule as the budget headline. */}
                <BudgetBar spent={budget.spent} available={budget.ceilingTotal} />
              </div>
              {budget.overCategories.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {budget.overCategories.slice(0, 3).map((c) => (
                    <OverChip key={c.categoryId ?? "residual"} category={c} />
                  ))}
                  {budget.overCategories.length > 3 && (
                    <Link
                      href="/budget"
                      className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted"
                    >
                      +{budget.overCategories.length - 3} more
                    </Link>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <span className={LABEL}>Budget</span>
              <p className="mt-1.5 text-lg font-semibold">Not set</p>
              <Link
                href="/budget"
                className="text-xs text-muted-foreground transition hover:text-foreground"
              >
                Build one from your spending history →
              </Link>
            </>
          )}
        </div>

        <div className="col-span-2 border-t border-border px-5 py-4">
          <div className="flex items-center justify-between gap-2">
            <span className={LABEL}>Income vs. expenses · 6mo</span>
            <span className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-[2px] bg-positive" />
                In
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-[2px] bg-negative" />
                Out
              </span>
            </span>
          </div>
          <div className="mt-2">
            <IncomeExpenseChart months={months} compact />
          </div>
        </div>
      </div>
    </Card>
  );
}
