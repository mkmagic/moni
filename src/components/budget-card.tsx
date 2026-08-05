import Link from "next/link";
import { Target } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Money } from "@/components/money";
import { BudgetBar } from "@/components/budget-bar";
import { cn } from "@/lib/utils";
import type { Money as MoneyValue } from "@/lib/money";

interface BudgetCardProps {
  hasBudget: boolean;
  spent: MoneyValue;
  ceilingTotal: MoneyValue;
  overBudgetCount: number;
}

/**
 * The budget's one line on the dashboard: spend against the total of every
 * ceiling, plus how many categories are over. Over-budget signalling is
 * passive and in-app only — there is no job runner to schedule a threshold
 * check against, and none is assumed (AGENTS.md).
 */
export function BudgetCard({ hasBudget, spent, ceilingTotal, overBudgetCount }: BudgetCardProps) {
  return (
    <Link href="/budget" className="card-link">
      <Card className="card-glow relative h-full overflow-hidden">
        <span
          aria-hidden
          className="card-glow-top pointer-events-none absolute inset-x-0 top-0 h-px"
        />
        <CardContent className="flex flex-col gap-4 px-5 pb-5 pt-6">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Budget
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-[var(--radius)] bg-muted text-foreground">
              <Target className="h-3.5 w-3.5" />
            </div>
          </div>

          {hasBudget ? (
            <>
              <Money value={spent} className="text-2xl font-bold" />
              <BudgetBar spent={spent} available={ceilingTotal} />
              <p
                className={cn(
                  "text-xs",
                  overBudgetCount > 0 ? "text-negative" : "text-muted-foreground",
                )}
              >
                {"of "}
                <Money value={ceilingTotal} />
                {overBudgetCount > 0
                  ? ` · ${overBudgetCount} categor${overBudgetCount === 1 ? "y" : "ies"} over`
                  : " budgeted"}
              </p>
            </>
          ) : (
            <>
              <span className="text-2xl font-bold text-foreground">Not set</span>
              <p className="text-xs text-muted-foreground">
                {"Build one from your spending history."}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
