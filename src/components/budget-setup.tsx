"use client";

import { useState, useTransition } from "react";
import Decimal from "decimal.js";
import { ArrowLeft, ArrowRight, Check, Undo2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import type { BudgetProposal, CeilingSuggestion } from "@/domain/budget";

interface BudgetSetupProps {
  /** Complete months of history, capped at 12 — the window can't exceed it,
   * or a three-month backfill would average in nine empty months. */
  historyMonths: number;
  currency: string;
  /** The month the accepted ceilings take effect from. */
  effectiveFrom: string;
  onManual: () => void;
  onDone: () => void;
}

/** Below this the wizard is not offered. Two months cannot tell a habit from
 * a coincidence, and a budget built on one is worse than none: the user
 * spends a month failing to hit a number that was never real. */
const MINIMUM_MONTHS = 3;

const WINDOWS = [3, 6, 12] as const;

type Step = "intro" | "fixed" | "everyday" | "income";

/** A half-typed amount ("", "1.", "-") is not a number yet; it contributes
 * nothing rather than throwing. */
function decimalOrZero(value: string | undefined): Decimal {
  if (!value) return new Decimal(0);
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/**
 * A suggested ceiling, as a number a person would actually choose.
 *
 * The domain layer returns the mean unrounded and must keep doing so — it is
 * forbidden from rounding (money-and-currency.md §3) — but ₪1,242.68333333
 * is not a target anyone sets. Rounding up to the next ₪10 happens here, at
 * the display edge, and up rather than to-nearest because a ceiling rounded
 * down is a ceiling the user's own history already breaks.
 */
function roundCeiling(amount: string): string {
  return new Decimal(amount).dividedBy(10).ceil().times(10).toFixed();
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "short" });

/**
 * The budget planner: proposes a whole budget from what the user actually
 * spent, and walks them through confirming it.
 *
 * Four steps, because the questions are genuinely different in kind. Fixed
 * costs are near-certain and are *confirmed*; everyday spending is a
 * judgement, so it is shown against the months it came from; income and the
 * resulting savings are the verdict on the two. Nothing is written until the
 * final step — the same posture as categorization suggestions (ADR 0002).
 */
export function BudgetSetup({
  historyMonths,
  currency,
  effectiveFrom,
  onManual,
  onDone,
}: BudgetSetupProps) {
  const [step, setStep] = useState<Step>("intro");
  const [proposal, setProposal] = useState<BudgetProposal | null>(null);
  const [months, setMonths] = useState(0);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [rollovers, setRollovers] = useState<Record<string, boolean>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [income, setIncome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  async function propose(windowMonths: number) {
    setError(null);
    const res = await fetch(`/api/budget/suggestions?months=${windowMonths}`);
    if (!res.ok) {
      setError("Could not read your history");
      return;
    }
    const body = (await res.json()) as BudgetProposal & { months: number };
    setProposal({ ceilings: body.ceilings, income: body.income });
    setMonths(body.months);
    setAmounts(
      Object.fromEntries(body.ceilings.map((c) => [c.categoryId, roundCeiling(c.amount.amount)])),
    );
    setRollovers(Object.fromEntries(body.ceilings.map((c) => [c.categoryId, c.rollover])));
    setDropped(new Set());
    setIncome(body.income ? roundCeiling(body.income.amount) : "");
    setStep("fixed");
  }

  async function accept() {
    if (!proposal) return;
    setError(null);
    const ceilings = proposal.ceilings
      .filter((c) => !dropped.has(c.categoryId))
      .map((c) => ({
        categoryId: c.categoryId,
        amount: amounts[c.categoryId],
        effectiveFrom,
        rollover: rollovers[c.categoryId] ?? false,
      }));

    const res = await fetch("/api/budget/ceilings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ceilings }),
    });
    if (!res.ok) {
      setError(
        ((await res.json().catch(() => null)) as { error?: string } | null)?.error ??
          "Could not create the budget",
      );
      return;
    }

    // Planned income is optional — a budget without it still works, it just
    // cannot say what you are saving. Its failure must not lose the ceilings
    // that were already written, so it is reported and not thrown.
    if (decimalOrZero(income).isPositive()) {
      const incomeRes = await fetch("/api/budget/income", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: income, effectiveFrom }),
      });
      if (!incomeRes.ok) {
        setError("The ceilings were saved, but the planned income was not");
        return;
      }
    }

    onDone();
  }

  const kept = (proposal?.ceilings ?? []).filter((c) => !dropped.has(c.categoryId));
  const ceilingTotal = kept.reduce(
    (acc, c) => acc.plus(decimalOrZero(amounts[c.categoryId])),
    new Decimal(0),
  );

  if (historyMonths < MINIMUM_MONTHS) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-4 px-6 pb-6 pt-7">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-foreground">Set your first ceiling</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {historyMonths === 0
                ? "There's no spending history to build a budget from yet. Add a category and the number you want to stay under; sync a connection and Moni can plan the rest for you."
                : `Moni can plan a budget from your own spending once there are ${MINIMUM_MONTHS} complete months to read — there ${historyMonths === 1 ? "is 1" : `are ${historyMonths}`} so far. Until then, set the ceilings you already know.`}
            </p>
          </div>
          <Button onClick={onManual}>Add a category</Button>
        </CardContent>
      </Card>
    );
  }

  if (step === "intro" || !proposal) {
    const deepest = [...WINDOWS].reverse().find((w) => w <= historyMonths) ?? MINIMUM_MONTHS;
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-5 px-6 pb-6 pt-7">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-foreground">Plan your budget</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {`Moni will read the last ${deepest} months, separate the bills you can't change from the spending you can, and propose a monthly ceiling for each. You'll confirm every number, and nothing is saved until the last step.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => startTransition(() => propose(deepest))} disabled={busy}>
              {busy ? "Reading your history…" : "Plan my budget"}
              {!busy && <ArrowRight className="h-4 w-4" />}
            </Button>
            <button
              type="button"
              onClick={onManual}
              className="text-sm text-muted-foreground underline underline-offset-2 transition hover:text-foreground"
            >
              Set ceilings by hand instead
            </button>
          </div>
          {error && <p className="text-sm text-negative">{error}</p>}
        </CardContent>
      </Card>
    );
  }

  const fixed = kept.filter((c) => c.kind === "fixed");
  const everyday = kept.filter((c) => c.kind === "everyday");
  const shown = step === "fixed" ? fixed : step === "everyday" ? everyday : [];

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 px-6 pb-6 pt-7">
        <StepHeader step={step} months={months} />

        {step !== "income" && (
          <>
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {step === "fixed"
                  ? "None of your categories are flagged as recurring, so there's nothing fixed to confirm. Flag them on the Categories tab and Moni will treat them as bills next time."
                  : "Everything Moni found is a fixed cost — there's no everyday spending to set a ceiling on."}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {shown.map((suggestion) => (
                  <SuggestionRow
                    key={suggestion.categoryId}
                    suggestion={suggestion}
                    value={amounts[suggestion.categoryId] ?? ""}
                    rollover={rollovers[suggestion.categoryId] ?? false}
                    showHistory={step === "everyday"}
                    onAmount={(next) =>
                      setAmounts((prev) => ({ ...prev, [suggestion.categoryId]: next }))
                    }
                    onRollover={(next) =>
                      setRollovers((prev) => ({ ...prev, [suggestion.categoryId]: next }))
                    }
                    onDrop={() => setDropped((prev) => new Set(prev).add(suggestion.categoryId))}
                  />
                ))}
              </ul>
            )}
            {dropped.size > 0 && (
              <button
                type="button"
                onClick={() => setDropped(new Set())}
                className="flex items-center gap-1.5 self-start text-xs text-muted-foreground underline underline-offset-2 transition hover:text-foreground"
              >
                <Undo2 className="h-3.5 w-3.5" />
                {`Bring back ${dropped.size} removed ${dropped.size === 1 ? "category" : "categories"}`}
              </button>
            )}
          </>
        )}

        {step === "income" && (
          <Verdict
            income={income}
            onIncome={setIncome}
            suggested={proposal.income}
            ceilingTotal={ceilingTotal}
            currency={currency}
            fixedCount={fixed.length}
            everydayCount={everyday.length}
          />
        )}

        {error && <p className="text-sm text-negative">{error}</p>}

        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <button
            type="button"
            onClick={() =>
              setStep(step === "income" ? "everyday" : step === "everyday" ? "fixed" : "intro")
            }
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          {step === "income" ? (
            <Button onClick={() => startTransition(() => accept())} disabled={busy}>
              {busy ? "Saving…" : `Create this budget`}
              {!busy && <Check className="h-4 w-4" />}
            </Button>
          ) : (
            <Button onClick={() => setStep(step === "fixed" ? "everyday" : "income")}>
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StepHeader({ step, months }: { step: Step; months: number }) {
  const copy: Record<Exclude<Step, "intro">, { title: string; blurb: string }> = {
    fixed: {
      title: "Step 1 of 3 · Your fixed costs",
      blurb: `These recur, so Moni is fairly sure of them. Check the numbers and change any that are about to move — a rent rise won't be in the last ${months} months.`,
    },
    everyday: {
      title: "Step 2 of 3 · Your everyday spending",
      blurb:
        "This is where a budget is actually decided. Each bar is one month you lived through, so you can see whether the suggested number is typical or one bad month.",
    },
    income: {
      title: "Step 3 of 3 · What's left",
      blurb: "What you expect to earn each month, and what this budget leaves you.",
    },
  };
  if (step === "intro") return null;
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-sm font-medium text-foreground">{copy[step].title}</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">{copy[step].blurb}</p>
    </div>
  );
}

/**
 * One proposed ceiling. On the everyday step it carries the months it was
 * derived from, because a mean the user cannot see behind is just an
 * assertion.
 */
function SuggestionRow({
  suggestion,
  value,
  rollover,
  showHistory,
  onAmount,
  onRollover,
  onDrop,
}: {
  suggestion: CeilingSuggestion;
  value: string;
  rollover: boolean;
  showHistory: boolean;
  onAmount: (next: string) => void;
  onRollover: (next: boolean) => void;
  onDrop: () => void;
}) {
  const choices: { label: string; amount: string }[] = [
    { label: "Tight", amount: roundCeiling(suggestion.lowest.amount) },
    { label: "Typical", amount: roundCeiling(suggestion.amount.amount) },
    { label: "Roomy", amount: roundCeiling(suggestion.highest.amount) },
  ];

  return (
    <li className="flex flex-col gap-3 border-b border-border py-3 last:border-b-0">
      <div className="flex items-center gap-4">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          <bdi>{suggestion.categoryName}</bdi>
        </span>
        {showHistory && <HistoryBars suggestion={suggestion} />}
        <span className="w-32 shrink-0">
          <Input
            value={value}
            onChange={(e) => onAmount(e.target.value)}
            inputMode="decimal"
            aria-label={`Monthly ceiling for ${suggestion.categoryName}`}
          />
        </span>
        <button
          type="button"
          onClick={onDrop}
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 transition hover:text-foreground"
        >
          Remove
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {showHistory &&
          choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              onClick={() => onAmount(choice.amount)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition",
                value === choice.amount
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted",
              )}
            >
              {choice.label}
              {" · "}
              <Money value={{ amount: choice.amount, currency: suggestion.amount.currency }} />
            </button>
          ))}

        {/* Rollover is offered per row rather than as a global default,
            because it is only right for spending that doesn't arrive every
            month — and the row is where Moni can say which this is. */}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span title={suggestion.rolloverReason ?? undefined}>Carry the balance forward</span>
          <Switch checked={rollover} onCheckedChange={onRollover} />
        </label>
      </div>

      {suggestion.rolloverReason && (
        <p className="text-xs text-muted-foreground">{suggestion.rolloverReason}</p>
      )}
    </li>
  );
}

/** One small bar per month of the window — the spread behind the mean. */
function HistoryBars({ suggestion }: { suggestion: CeilingSuggestion }) {
  const peak = new Decimal(suggestion.highest.amount);
  return (
    <div className="hidden shrink-0 items-end gap-1 sm:flex" aria-hidden>
      {suggestion.history.map((month) => {
        // A layout percentage, not a money value — the arithmetic above it is
        // exact and only the bar's height is a float (ui-developer skill).
        const height = peak.isZero()
          ? 0
          : Number(new Decimal(month.amount.amount).dividedBy(peak).times(100));
        return (
          <span
            key={month.month}
            title={`${monthLabel(month.month)}: ${month.amount.amount}`}
            className="flex h-8 w-3 items-end rounded-sm bg-muted"
          >
            <span
              className="w-full rounded-sm bg-primary/60"
              style={{ height: `${Math.max(height, 3)}%` }}
            />
          </span>
        );
      })}
    </div>
  );
}

/** The last step: income in, ceilings out, and the difference — the only
 * place a planned-vs-actual comparison is honest, because at wizard time
 * there is no actual to confuse it with. */
function Verdict({
  income,
  onIncome,
  suggested,
  ceilingTotal,
  currency,
  fixedCount,
  everydayCount,
}: {
  income: string;
  onIncome: (next: string) => void;
  suggested: { amount: string; currency: string } | null;
  ceilingTotal: Decimal;
  currency: string;
  fixedCount: number;
  everydayCount: number;
}) {
  const left = decimalOrZero(income).minus(ceilingTotal);
  const hasIncome = decimalOrZero(income).isPositive();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Expected monthly income
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-40">
            <Input value={income} onChange={(e) => onIncome(e.target.value)} inputMode="decimal" />
          </span>
          {suggested && (
            <button
              type="button"
              onClick={() => onIncome(roundCeiling(suggested.amount))}
              className="text-xs text-muted-foreground underline underline-offset-2 transition hover:text-foreground"
            >
              {"Use your average: "}
              <Money value={suggested} />
            </button>
          )}
        </div>
      </div>

      <dl className="flex flex-col gap-2 rounded-[var(--radius)] bg-muted/40 p-4 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">
            {`Budgeted out · ${fixedCount} fixed, ${everydayCount} everyday`}
          </dt>
          <dd className="text-foreground">
            <Money value={{ amount: ceilingTotal.toFixed(), currency }} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
          <dt className="text-foreground">{"Left over each month"}</dt>
          <dd>
            {hasIncome ? (
              <Money
                value={{ amount: left.toFixed(), currency }}
                className="text-base font-semibold"
                signColor
              />
            ) : (
              <span className="text-muted-foreground">{"—"}</span>
            )}
          </dd>
        </div>
      </dl>

      {hasIncome && left.isNegative() && (
        <p className="text-sm text-negative">
          {
            "These ceilings add up to more than you expect to earn. That's allowed — a ceiling is a target, not a rule — but it means the plan starts in the red. Go back and tighten one, or raise the income figure."
          }
        </p>
      )}
    </div>
  );
}

/** For the history bars' tooltips. */
function monthLabel(month: string): string {
  return MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`));
}
