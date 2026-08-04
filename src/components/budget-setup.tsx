"use client";

import { useState, useTransition } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import type { CeilingSuggestion } from "@/domain/budget";

interface BudgetSetupProps {
  /** Complete months of history, capped at 12 — the windows on offer can't
   * exceed it, or a three-month backfill would average in nine empty months. */
  historyMonths: number;
  currency: string;
  /** The month the accepted ceilings take effect from. */
  effectiveFrom: string;
  onManual: () => void;
  onDone: () => void;
}

const WINDOWS = [3, 6, 12] as const;

/**
 * The empty state: "Create a budget from your existing history?"
 *
 * Nothing is written until the user accepts — the same posture as
 * categorization suggestions (ADR 0002). The proposal is editable in place,
 * and a category can be dropped from it before it is saved.
 */
export function BudgetSetup({
  historyMonths,
  currency,
  effectiveFrom,
  onManual,
  onDone,
}: BudgetSetupProps) {
  const [suggestions, setSuggestions] = useState<CeilingSuggestion[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  // Not named `window` — that shadows the global in a file that could later
  // reach for it (skill feedback, 2026-07-29).
  const [chosenWindow, setChosenWindow] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  async function propose(months: number) {
    setError(null);
    setChosenWindow(months);
    const res = await fetch(`/api/budget/suggestions?months=${months}`);
    if (!res.ok) {
      setError("Could not read your history");
      return;
    }
    const body = (await res.json()) as { suggestions: CeilingSuggestion[] };
    setSuggestions(body.suggestions);
    setAmounts(Object.fromEntries(body.suggestions.map((s) => [s.categoryId, s.amount.amount])));
    setDropped(new Set());
  }

  async function accept() {
    if (!suggestions) return;
    setError(null);
    const ceilings = suggestions
      .filter((s) => !dropped.has(s.categoryId))
      .map((s) => ({
        categoryId: s.categoryId,
        amount: amounts[s.categoryId],
        effectiveFrom,
        rollover: false,
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
    onDone();
  }

  if (historyMonths === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-4 px-6 pb-6 pt-7">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-foreground">Set your first ceiling</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {
                "There's no spending history to build a budget from yet. Add a category and the number you want to stay under; sync a connection and Moni can suggest the rest."
              }
            </p>
          </div>
          <Button onClick={onManual}>Add a category</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 px-6 pb-6 pt-7">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">
            Create a budget from your existing history?
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {
              "Moni will suggest a monthly ceiling per category from what you actually spent. Nothing is saved until you accept it."
            }
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {WINDOWS.filter((months) => months <= historyMonths).map((months) => (
            <button
              key={months}
              type="button"
              onClick={() => startTransition(() => propose(months))}
              disabled={busy}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm transition",
                chosenWindow === months
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted",
              )}
            >
              {`Last ${months} months`}
            </button>
          ))}
          <button
            type="button"
            onClick={onManual}
            className="rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground transition hover:border-primary/50 hover:bg-muted"
          >
            Set ceilings manually
          </button>
        </div>

        {historyMonths < 12 && (
          <p className="max-w-2xl text-xs text-muted-foreground">
            {`You have ${historyMonths} complete month${historyMonths === 1 ? "" : "s"} of history, so that's as far back as a suggestion can look. Anything that isn't monthly — annual insurance, ארנונה — is worth setting by hand.`}
          </p>
        )}

        {suggestions && suggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {
              "No categorized spending in that window. Categorize some transactions first, or set ceilings by hand."
            }
          </p>
        )}

        {suggestions && suggestions.length > 0 && (
          <>
            <ul className="flex flex-col">
              {suggestions.map((suggestion) => {
                const isDropped = dropped.has(suggestion.categoryId);
                return (
                  <li
                    key={suggestion.categoryId}
                    className="flex items-center gap-4 border-b border-border py-2.5 last:border-b-0"
                  >
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm",
                        isDropped ? "text-muted-foreground line-through" : "text-foreground",
                      )}
                    >
                      <bdi>{suggestion.categoryName}</bdi>
                    </span>
                    <span className="w-32 shrink-0">
                      <Input
                        value={amounts[suggestion.categoryId] ?? ""}
                        onChange={(e) =>
                          setAmounts((prev) => ({
                            ...prev,
                            [suggestion.categoryId]: e.target.value,
                          }))
                        }
                        disabled={isDropped}
                        inputMode="decimal"
                        className="text-right"
                        aria-label={`Ceiling for ${suggestion.categoryName}`}
                      />
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setDropped((prev) => {
                          const next = new Set(prev);
                          if (next.has(suggestion.categoryId)) next.delete(suggestion.categoryId);
                          else next.add(suggestion.categoryId);
                          return next;
                        })
                      }
                      className="w-16 shrink-0 text-xs text-muted-foreground transition hover:text-foreground"
                    >
                      {isDropped ? "Keep" : "Drop"}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">
                {"Total budgeted "}
                <Money
                  value={{
                    // Every suggestion is already in the reporting currency at
                    // two decimals, so this preview total is a display sum, not
                    // domain arithmetic.
                    amount: suggestions
                      .filter((s) => !dropped.has(s.categoryId))
                      .reduce((total, s) => total + Number(amounts[s.categoryId] || 0), 0)
                      .toFixed(2),
                    currency,
                  }}
                />
              </span>
              <Button onClick={() => startTransition(accept)} disabled={busy}>
                Create budget
              </Button>
            </div>
          </>
        )}

        {error && (
          <p className="rounded-[var(--radius)] border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
