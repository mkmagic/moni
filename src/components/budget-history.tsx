"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Repeat } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { CategoryIconTile } from "@/components/category-icon";
import { BudgetHistoryChart } from "@/components/budget-history-chart";
import { RESIDUAL_KEY } from "@/lib/budget/residual";
import { roundCeiling } from "@/lib/budget/round-ceiling";
import type { BudgetHistoryView, CeilingVerdict } from "@/domain/budget";

interface BudgetHistoryProps {
  view: BudgetHistoryView;
  /** The month a corrected ceiling takes effect — always the current one, so
   * finished months keep the numbers they were lived under (ADR 0010). */
  effectiveFrom: string;
}

export function BudgetHistory({ view, effectiveFrom }: BudgetHistoryProps) {
  const router = useRouter();

  if (view.months.length === 0) {
    return (
      <Card>
        <CardContent className="px-6 pb-6 pt-7">
          <p className="max-w-xl text-sm text-muted-foreground">
            {
              "Nothing to compare yet. This tab reads whole months only — the one you are living in has partial spending, and drawn beside finished months it would look like a month you barely spent anything. Come back once your first budgeted month has ended."
            }
          </p>
        </CardContent>
      </Card>
    );
  }

  const tooLow = view.verdicts.filter((v) => v.direction === "under-budgeted");
  const tooHigh = view.verdicts.filter((v) => v.direction === "over-budgeted");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Month by month</CardTitle>
          <p className="text-xs text-muted-foreground">
            {
              "What came in, what went out, and what the budget allowed — including anything a rollover line had saved up by then. Complete months only."
            }
          </p>
        </CardHeader>
        <CardContent>
          <BudgetHistoryChart months={view.months} currency={view.currency} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Ceilings worth revisiting</CardTitle>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {
              "Lines whose typical month sits well clear of the number you set. Changing one applies from this month forward — every finished month keeps the ceiling it was lived under."
            }
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {view.verdicts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {
                "Nothing stands out. Every ceiling with enough history behind it is within 15% of what you actually spend."
              }
            </p>
          ) : (
            <>
              <VerdictGroup
                title="Budgeted too low"
                caption="You spend more than these allow, month after month."
                verdicts={tooLow}
                effectiveFrom={effectiveFrom}
                onSaved={() => router.refresh()}
              />
              <VerdictGroup
                title="Budgeted too high"
                caption="Room these lines never use — money the budget could be planning to save instead."
                verdicts={tooHigh}
                effectiveFrom={effectiveFrom}
                onSaved={() => router.refresh()}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function VerdictGroup({
  title,
  caption,
  verdicts,
  effectiveFrom,
  onSaved,
}: {
  title: string;
  caption: string;
  verdicts: CeilingVerdict[];
  effectiveFrom: string;
  onSaved: () => void;
}) {
  if (verdicts.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
      <div className="mt-2 flex flex-col">
        {verdicts.map((verdict) => (
          <VerdictRow
            key={verdict.categoryId ?? RESIDUAL_KEY}
            verdict={verdict}
            effectiveFrom={effectiveFrom}
            onSaved={onSaved}
          />
        ))}
      </div>
    </div>
  );
}

function VerdictRow({
  verdict,
  effectiveFrom,
  onSaved,
}: {
  verdict: CeilingVerdict;
  effectiveFrom: string;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const tooLow = verdict.direction === "under-budgeted";
  // Rounded at the display edge, exactly as the planner wizard rounds its own
  // suggestions — the domain layer is forbidden from rounding money.
  const suggested = { ...verdict.averageSpend, amount: roundCeiling(verdict.averageSpend.amount) };
  // A line the user has never spent anything on averages zero, and "lower it
  // to ₪0" is not a ceiling — it is a request to stop budgeting the line,
  // which is a different action (and one the API rightly refuses, since a
  // ceiling must be positive). The row still states the finding; what it
  // cannot offer is a one-click number.
  const actionable = suggested.amount !== "0";
  // The magnitude, with the sign carried by the surrounding words instead.
  const gap = {
    ...verdict.variance,
    amount: verdict.variance.amount.replace(/^-/, ""),
  };

  async function apply() {
    setError(null);
    const res = await fetch("/api/budget/ceilings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        categoryId: verdict.categoryId,
        amount: suggested.amount,
        effectiveFrom,
        // Preserved rather than recomputed: whether a line accrues is the
        // user's decision about the shape of the spending, and this button
        // is only offering to change the number.
        rollover: verdict.rollover,
      }),
    });
    if (!res.ok) {
      setError(
        ((await res.json().catch(() => null)) as { error?: string } | null)?.error ??
          "Could not save",
      );
      return;
    }
    onSaved();
  }

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-border py-3 last:border-b-0">
      <CategoryIconTile icon={verdict.icon} color={verdict.color} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          {/* Hebrew category names reorder an adjacent LTR badge unless they
              are bidi-isolated. */}
          <span className="min-w-0 truncate text-sm text-foreground">
            <bdi>{verdict.categoryName}</bdi>
          </span>
          {verdict.rollover && (
            <Badge className="gap-1">
              <Repeat className="h-3 w-3" />
              carries over
            </Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {"Averages "}
          <Money value={verdict.averageSpend} />
          {" against a "}
          <Money value={verdict.ceiling} />
          {" ceiling — "}
          <span className={tooLow ? "text-negative" : undefined}>
            <Money value={gap} />
            {tooLow ? " over" : " unused"}
          </span>
          {`, across ${verdict.monthsObserved} month${verdict.monthsObserved === 1 ? "" : "s"}`}
          {/* "at the time" is load-bearing: the average is measured against
              the ceiling in force *now*, while this count is measured against
              whatever each month's own ceiling was. Without it, a line whose
              ceiling was recently changed reads as a contradiction. */}
          {verdict.monthsOver > 0 && ` · over budget in ${verdict.monthsOver} of them at the time`}
        </span>
        {error && <span className="text-xs text-negative">{error}</span>}
      </div>
      {actionable ? (
        <Button variant="outline" onClick={() => startTransition(apply)} disabled={busy}>
          {tooLow ? "Raise to " : "Lower to "}
          <Money value={suggested} />
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">{"Never used"}</span>
      )}
    </div>
  );
}
