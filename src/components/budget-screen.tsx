"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus, Repeat, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog } from "@/components/ui/dialog";
import { Money } from "@/components/money";
import { CategoryIconTile } from "@/components/category-icon";
import { BudgetBar } from "@/components/budget-bar";
import { BudgetSetup } from "@/components/budget-setup";
import { cn } from "@/lib/utils";
import { isZero } from "@/lib/money";
import type { BudgetMonthView, BudgetRowView, BudgetSectionView } from "@/domain/budget";
import type { CategoryView } from "@/domain/categorization";

interface BudgetScreenProps {
  view: BudgetMonthView;
  /** Pre-formatted on the server: a client component that called
   * `toLocaleDateString()` would hydrate differently than it rendered
   * (.agents/skills/ui-developer). */
  monthLabel: string;
  previousMonth: string;
  nextMonth: string | null;
  /** First and last day of the month, for the drill-down link. */
  monthFrom: string;
  monthTo: string;
  /** False for a past month. The setup flow only makes sense on the current
   * month: a "create a budget" prompt on a finished month would offer to
   * backdate ceilings the user never lived under. */
  isCurrentMonth: boolean;
  /** Expense categories, the only ones a ceiling can sit on. */
  categories: CategoryView[];
  /** How many complete months of history exist, capped at 12. */
  historyMonths: number;
}

export function BudgetScreen({
  view,
  monthLabel,
  previousMonth,
  nextMonth,
  monthFrom,
  monthTo,
  isCurrentMonth,
  categories,
  historyMonths,
}: BudgetScreenProps) {
  const router = useRouter();
  const [editing, setEditing] = useState<BudgetRowView | "new" | null>(null);
  const [editingIncome, setEditingIncome] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">Budget</h1>
          <p className="text-sm text-muted-foreground">
            {"What you meant to spend, against what you did."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MonthPicker
            monthLabel={monthLabel}
            previousMonth={previousMonth}
            nextMonth={nextMonth}
          />
          {view.hasBudget && (
            <Button variant="outline" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" />
              Add category
            </Button>
          )}
        </div>
      </div>

      {view.hasBudget ? (
        <>
          <Headline view={view} onEditIncome={() => setEditingIncome(true)} />

          <Section
            title="Fixed"
            caption="Money already committed — rent, insurance, subscriptions."
            section={view.fixed}
            monthFrom={monthFrom}
            monthTo={monthTo}
            pace={null}
            onEdit={setEditing}
          />
          <Section
            title="Everyday"
            caption="Money still in play this month."
            section={view.everyday}
            monthFrom={monthFrom}
            monthTo={monthTo}
            pace={view.pace}
            onEdit={setEditing}
          />

          <Card>
            <CardContent className="flex items-center justify-between px-5 pb-5 pt-6">
              <div className="flex flex-col gap-1">
                <span className="text-sm text-foreground">Unbudgeted spending</span>
                <span className="text-xs text-muted-foreground">
                  {"Everything no ceiling covers. Shown so the totals still add up."}
                </span>
              </div>
              <Money value={view.unbudgetedSpend} className="text-sm" />
            </CardContent>
          </Card>
        </>
      ) : isCurrentMonth ? (
        <BudgetSetup
          historyMonths={historyMonths}
          currency={view.currency}
          effectiveFrom={view.month}
          onManual={() => setEditing("new")}
          onDone={() => router.refresh()}
        />
      ) : (
        <Card>
          <CardContent className="px-6 pb-6 pt-7">
            <p className="text-sm text-muted-foreground">
              {`No budget was in force in ${monthLabel}. A ceiling only applies from the month it was set, so earlier months stay as they were lived.`}
            </p>
          </CardContent>
        </Card>
      )}

      {editing && (
        <CeilingDialog
          row={editing === "new" ? null : editing}
          categories={categories}
          budgetedIds={[...view.fixed.rows, ...view.everyday.rows].map((row) => row.categoryId)}
          effectiveFrom={view.month}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      {editingIncome && (
        <IncomeDialog
          current={view.plannedIncome?.amount ?? ""}
          effectiveFrom={view.month}
          onClose={() => setEditingIncome(false)}
          onSaved={() => {
            setEditingIncome(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function MonthPicker({
  monthLabel,
  previousMonth,
  nextMonth,
}: {
  monthLabel: string;
  previousMonth: string;
  nextMonth: string | null;
}) {
  return (
    <div className="flex items-center gap-1 rounded-[var(--radius)] border border-border px-1 py-1">
      <Link
        href={`/budget?month=${previousMonth}`}
        aria-label="Previous month"
        className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
      </Link>
      <span className="min-w-32 text-center text-sm text-foreground">{monthLabel}</span>
      {nextMonth ? (
        <Link
          href={`/budget?month=${nextMonth}`}
          aria-label="Next month"
          className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </Link>
      ) : (
        // No link past the current month: a budget for a month that hasn't
        // happened has nothing to report.
        <span className="p-1.5 text-muted-foreground/40">
          <ChevronRight className="h-4 w-4" />
        </span>
      )}
    </div>
  );
}

/**
 * How much of the budget is gone, and whether that is ahead of the month.
 *
 * This deliberately replaced a Planned-vs-Actual savings pair. Those two
 * figures were not comparable — "planned" assumed every ceiling was spent to
 * the brim and covered only budgeted categories, while "actual" counted
 * everything that left — and comparing a part-finished month against a whole
 * month's plan reads euphoric on the 4th and grim on the 28th. Spend against
 * budget, with the pace marker the rows already use, is the question this
 * page exists to answer. Savings is the quieter line underneath.
 */
function Headline({ view, onEditIncome }: { view: BudgetMonthView; onEditIncome: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 px-6 pb-6 pt-7">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Spent this month
            </span>
            <span className="flex items-baseline gap-2">
              <Money value={view.budgetedSpend} className="text-3xl font-bold" />
              <span className="text-sm text-muted-foreground">
                {"of "}
                <Money value={view.ceilingTotal} />
              </span>
            </span>
          </div>
          {view.daysLeft !== null && (
            <span className="text-sm text-muted-foreground">
              {view.daysLeft === 0
                ? "Last day of the month"
                : `${view.daysLeft} day${view.daysLeft === 1 ? "" : "s"} left`}
              {view.projectedSpend && (
                <>
                  {" · on track for "}
                  <Money value={view.projectedSpend} />
                </>
              )}
            </span>
          )}
        </div>

        {/* No pace marker here, for the same reason Fixed rows don't get one:
            this total includes rent, which is 100% spent on the 1st by
            design. A marker over it would call every early month alarming.
            The projection in the caption carries the pace signal instead, and
            it knows to extrapolate only the everyday half. */}
        <BudgetBar spent={view.budgetedSpend} available={view.ceilingTotal} pace={null} />

        <p className="text-sm text-muted-foreground">
          {view.plannedIncome ? (
            <>
              <Money value={view.plannedIncome} /> planned in, so this budget leaves{" "}
              <Money value={view.plannedSavings ?? view.actualSavings} signColor /> a month.{" "}
            </>
          ) : (
            "Set what you expect to earn and Moni can say what this budget leaves you. "
          )}
          <button
            type="button"
            onClick={onEditIncome}
            className="underline underline-offset-2 transition hover:text-foreground"
          >
            {view.plannedIncome ? "Edit" : "Set planned income"}
          </button>
        </p>

        {!isZero(view.unbudgetedSpend) && (
          <p className="text-xs text-muted-foreground">
            {"A further "}
            <Money value={view.unbudgetedSpend} />
            {" went to categories with no ceiling."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  caption,
  section,
  monthFrom,
  monthTo,
  pace,
  onEdit,
}: {
  title: string;
  caption: string;
  section: BudgetSectionView;
  monthFrom: string;
  monthTo: string;
  pace: number | null;
  onEdit: (row: BudgetRowView) => void;
}) {
  if (section.rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-foreground">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{caption}</p>
        </div>
        {/* Subtotals come from the domain layer already summed — the display
            edge never adds money together. */}
        <span className="text-sm text-muted-foreground">
          <Money value={section.spent} /> of <Money value={section.ceiling} />
        </span>
      </CardHeader>
      <CardContent className="flex flex-col">
        {section.rows.map((row) => (
          <BudgetRow
            key={row.categoryId}
            row={row}
            monthFrom={monthFrom}
            monthTo={monthTo}
            pace={pace}
            onEdit={onEdit}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function BudgetRow({
  row,
  monthFrom,
  monthTo,
  pace,
  onEdit,
}: {
  row: BudgetRowView;
  monthFrom: string;
  monthTo: string;
  pace: number | null;
  onEdit: (row: BudgetRowView) => void;
}) {
  const over = row.remaining.amount.startsWith("-");
  return (
    <div className="flex items-center gap-4 border-b border-border py-3 last:border-b-0">
      <CategoryIconTile icon={row.icon} color={row.color} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <Link
            href={`/transactions?category=${row.categoryId}&from=${monthFrom}&to=${monthTo}`}
            className="min-w-0 truncate text-sm text-foreground transition hover:text-primary"
          >
            {/* Hebrew category names reorder an adjacent LTR badge unless they
                are bidi-isolated. */}
            <bdi>{row.categoryName}</bdi>
          </Link>
          <span className="shrink-0 text-xs text-muted-foreground">
            <Money value={row.spent} /> of <Money value={row.ceiling} />
          </span>
        </div>
        <BudgetBar spent={row.spent} available={row.available} pace={pace} />
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {row.rollover && row.carriedIn && (
              <Badge className="gap-1">
                <Repeat className="h-3 w-3" />
                carried <Money value={row.carriedIn} />
              </Badge>
            )}
          </span>
          <span
            className={cn("shrink-0 text-xs", over ? "text-negative" : "text-muted-foreground")}
          >
            {over ? (
              <>
                <Money value={{ ...row.remaining, amount: row.remaining.amount.slice(1) }} /> over
              </>
            ) : (
              <>
                <Money value={row.remaining} /> left
              </>
            )}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onEdit(row)}
        className="shrink-0 rounded-[var(--radius)] px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        Edit
      </button>
    </div>
  );
}

function CeilingDialog({
  row,
  categories,
  budgetedIds,
  effectiveFrom,
  onClose,
  onSaved,
}: {
  row: BudgetRowView | null;
  categories: CategoryView[];
  budgetedIds: string[];
  effectiveFrom: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState(row?.categoryId ?? "");
  const [amount, setAmount] = useState(row?.ceiling.amount ?? "");
  const [rollover, setRollover] = useState(row?.rollover ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const budgeted = new Set(budgetedIds);
  const available = categories.filter(
    (category) => category.id === row?.categoryId || !budgeted.has(category.id),
  );

  async function save() {
    setError(null);
    const res = await fetch("/api/budget/ceilings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryId, amount, effectiveFrom, rollover }),
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

  async function remove() {
    await fetch(`/api/budget/ceilings/${categoryId}`, { method: "DELETE" });
    onSaved();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={row ? `Budget for ${row.categoryName}` : "Add a category to the budget"}
      description={`Takes effect from ${effectiveFrom} onward. Earlier months keep the number they had.`}
    >
      <div className="flex flex-col gap-4">
        {!row && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Category</span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Choose a category…</option>
              {available.map((category) => (
                <option key={category.id} value={category.id}>
                  {/* Leading plain whitespace in an <option> is collapsed, so
                      nesting has to be drawn with non-breaking spaces. */}
                  {category.parentId ? `  ${category.name}` : category.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Monthly ceiling</span>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="2000"
          />
        </label>

        <div className="flex items-start justify-between gap-4">
          <div className="flex max-w-sm flex-col gap-1">
            <span id="rollover-label" className="text-sm text-foreground">
              Carry the balance forward
            </span>
            <span className="text-xs text-muted-foreground">
              {
                "For spending that isn't monthly — ארנונה, insurance, טסט. Unspent money accrues, and an overspend follows you into next month."
              }
            </span>
          </div>
          <Switch
            checked={rollover}
            onCheckedChange={setRollover}
            aria-labelledby="rollover-label"
          />
        </div>

        {error && (
          <p className="rounded-[var(--radius)] border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          {row ? (
            <Button variant="destructive" onClick={() => startTransition(remove)} disabled={busy}>
              <Trash2 className="h-4 w-4" />
              Stop budgeting
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => startTransition(save)}
              disabled={busy || !categoryId || amount.trim() === ""}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function IncomeDialog({
  current,
  effectiveFrom,
  onClose,
  onSaved,
}: {
  current: string;
  effectiveFrom: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(current);
  const [busy, startTransition] = useTransition();

  async function save() {
    const res = await fetch("/api/budget/income", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, effectiveFrom }),
    });
    if (res.ok) onSaved();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Planned monthly income"
      description={`Takes effect from ${effectiveFrom} onward.`}
    >
      <div className="flex flex-col gap-4">
        <Input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="18000"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => startTransition(save)} disabled={busy || amount.trim() === ""}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
