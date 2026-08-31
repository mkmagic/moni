"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus, Repeat, Settings2, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog } from "@/components/ui/dialog";
import { Money } from "@/components/money";
import { BudgetBar } from "@/components/budget-bar";
import {
  HouseholdMonthlyChart,
  type HouseholdMonthlyPoint,
} from "@/components/household-monthly-chart";
import { cn } from "@/lib/utils";
import type { Money as MoneyValue } from "@/lib/money";
import type { CategoryView } from "@/domain/categorization";

/** The listSharedCategories-derived bits the page joins onto each budget line. */
export interface SharedCategoryConfig {
  isRecurring: boolean;
  myLocalCategoryIds: string[];
  splits: { memberId: string; weight: string }[];
}

export interface MemberFigureView {
  memberId: string;
  label: string;
  amount: MoneyValue;
  /** Pre-formatted "as of" date, or null for the caller's own live figure. */
  asOfLabel: string | null;
  isLive: boolean;
  notReported: boolean;
}

export interface SharedCategoryView {
  sharedCategoryId: string;
  name: string;
  isRecurring: boolean;
  combined: MoneyValue;
  myFigure: MoneyValue;
  ceiling: MoneyValue | null;
  provisional: boolean;
  members: MemberFigureView[];
  myLocalCategoryIds: string[];
  splits: { memberId: string; weight: string }[];
}

export interface SettlementMemberView {
  memberId: string;
  label: string;
  share: MoneyValue;
  paid: MoneyValue;
  net: MoneyValue;
}

export interface SettlementView {
  provisional: boolean;
  members: SettlementMemberView[];
  transfers: { fromLabel: string; toLabel: string; fromIsSelf: boolean; amount: MoneyValue }[];
  perCategory: {
    sharedCategoryId: string;
    name: string;
    combined: MoneyValue;
    members: { label: string; share: MoneyValue; paid: MoneyValue }[];
  }[];
}

export interface HouseholdView {
  householdId: string;
  name: string;
  selfId: string;
  memberIds: string[];
  provisional: boolean;
  freshnessLabel: string | null;
  categories: SharedCategoryView[];
  settlement: SettlementView;
  /** Trailing-window combined spend for the monthly bar chart. */
  monthly: HouseholdMonthlyPoint[];
}

interface HouseholdScreenProps {
  households: HouseholdView[];
  /** The caller's own expense categories — the mapping picker's options. */
  expenseCategories: CategoryView[];
  currency: string;
  month: string;
  monthLabel: string;
  previousMonth: string;
  nextMonth: string | null;
}

export function HouseholdScreen({
  households,
  expenseCategories,
  currency,
  month,
  monthLabel,
  previousMonth,
  nextMonth,
}: HouseholdScreenProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <MonthPicker monthLabel={monthLabel} previousMonth={previousMonth} nextMonth={nextMonth} />
      </div>

      {households.map((household) => (
        <HouseholdSection
          key={household.householdId}
          household={household}
          expenseCategories={expenseCategories}
          currency={currency}
          month={month}
        />
      ))}
    </div>
  );
}

function HouseholdSection({
  household,
  expenseCategories,
  currency,
  month,
}: {
  household: HouseholdView;
  expenseCategories: CategoryView[];
  currency: string;
  month: string;
}) {
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<SharedCategoryView | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {/* One shared budget per line, combined actual vs household ceiling. */}
      <Card>
        <CardHeader className="flex-row items-baseline justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-foreground">
              <bdi>{household.name}</bdi>
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Combined spend on shared categories, against the household ceiling.
            </p>
          </div>
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add shared category
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col">
          {household.categories.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No shared categories yet. Add one, then map your own local categories onto it — its
              combined spend and split appear here.
            </p>
          ) : (
            household.categories.map((category) => (
              <SharedCategoryRow
                key={category.sharedCategoryId}
                category={category}
                onConfigure={() => setConfiguring(category)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {household.freshnessLabel && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {`Combined figures are current to each member's last sync — as of ${household.freshnessLabel} for the least-recently-synced member.`}
        </p>
      )}

      <SettlementCard settlement={household.settlement} />

      {household.monthly.length > 0 && (
        <Card>
          <CardHeader className="flex-col items-stretch gap-1">
            <CardTitle className="text-foreground">Monthly household spending</CardTitle>
            <p className="text-xs text-muted-foreground">
              Combined spend on shared categories, over recent months.
            </p>
          </CardHeader>
          <CardContent className="pb-6">
            <HouseholdMonthlyChart months={household.monthly} currency={currency} />
          </CardContent>
        </Card>
      )}

      {adding && (
        <AddSharedCategoryDialog
          householdId={household.householdId}
          onClose={() => setAdding(false)}
        />
      )}
      {configuring && (
        <ConfigureDialog
          household={household}
          category={configuring}
          expenseCategories={expenseCategories}
          currency={currency}
          month={month}
          onClose={() => setConfiguring(null)}
        />
      )}
    </div>
  );
}

function SharedCategoryRow({
  category,
  onConfigure,
}: {
  category: SharedCategoryView;
  onConfigure: () => void;
}) {
  return (
    <div className="flex items-start gap-4 border-b border-border py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Stack the name and the amount on narrow screens so a long category
            name is never truncated by the amount crowding its column. */}
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
          <span className="flex min-w-0 items-center gap-2 truncate text-sm text-foreground">
            <bdi>{category.name}</bdi>
            {category.isRecurring && (
              <Badge className="gap-1">
                <Repeat className="h-3 w-3" />
                fixed
              </Badge>
            )}
            {category.provisional && (
              <Badge className="border-primary/40 text-primary">provisional</Badge>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <Money value={category.combined} />
            {category.ceiling ? (
              <>
                {" of "}
                <Money value={category.ceiling} />
              </>
            ) : (
              " spent"
            )}
          </span>
        </div>

        {category.ceiling ? (
          <BudgetBar spent={category.combined} available={category.ceiling} pace={null} />
        ) : (
          <p className="text-xs text-muted-foreground">
            No household ceiling set — configure one to track it against a limit.
          </p>
        )}

        {/* Per-member contributions. Never a silent ₪0: a member who has not
            published this period is shown as "not yet reported". */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {category.members.map((m) => (
            <span key={m.memberId} className="text-muted-foreground">
              <span className="text-foreground">{m.label}</span>{" "}
              {m.notReported ? (
                <span className="text-primary">not yet reported</span>
              ) : (
                <>
                  <Money value={m.amount} />
                  {m.isLive ? (
                    <span className="ml-1 text-muted-foreground/70">now</span>
                  ) : m.asOfLabel ? (
                    <span className="ml-1 text-muted-foreground/70">as of {m.asOfLabel}</span>
                  ) : null}
                </>
              )}
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={onConfigure}
        className="flex shrink-0 items-center gap-1 rounded-[var(--radius)] px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <Settings2 className="h-3.5 w-3.5" />
        Configure
      </button>
    </div>
  );
}

function SettlementCard({ settlement }: { settlement: SettlementView }) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const hasTransfers = settlement.transfers.length > 0;

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-foreground">Settle up</CardTitle>
          <p className="text-xs text-muted-foreground">
            The same combined figures, split by your agreed ratio.
          </p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pb-6">
        {settlement.provisional && (
          <p className="rounded-[var(--radius)] border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
            {
              "Provisional — not every member has reported this month yet, so this can still change as they sync."
            }
          </p>
        )}

        {hasTransfers ? (
          <div className="flex flex-col gap-2">
            {settlement.transfers.map((t, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border px-4 py-3"
              >
                <span className="text-sm text-foreground">
                  <span className="font-medium">{t.fromLabel}</span>
                  {/* Second person "You pay", third person "Partner pays". */}
                  {t.fromIsSelf ? " pay " : " pays "}
                  <span className="font-medium">{t.toLabel}</span>
                </span>
                <Money value={t.amount} className="text-sm font-semibold" />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {settlement.provisional
              ? "Nothing to settle so far this month."
              : "All settled up for this month — nobody owes anybody."}
          </p>
        )}

        {/* Per-member balances: what each was due vs. what they paid. */}
        <div className="flex flex-col divide-y divide-border rounded-[var(--radius)] border border-border">
          {settlement.members.map((m) => {
            const owes = m.net.amount.startsWith("-");
            return (
              <div key={m.memberId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-sm text-foreground">{m.label}</span>
                <span className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>
                    paid <Money value={m.paid} />
                  </span>
                  <span>
                    share <Money value={m.share} />
                  </span>
                  <span className={cn("font-medium", owes ? "text-negative" : "text-positive")}>
                    {owes ? (
                      <>
                        owes <Money value={{ ...m.net, amount: m.net.amount.slice(1) }} />
                      </>
                    ) : m.net.amount === "0.00" ? (
                      "even"
                    ) : (
                      <>
                        owed <Money value={m.net} />
                      </>
                    )}
                  </span>
                </span>
              </div>
            );
          })}
        </div>

        {settlement.perCategory.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowBreakdown((v) => !v)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {showBreakdown ? "Hide per-category breakdown" : "Show per-category breakdown"}
            </button>
            {showBreakdown && (
              <div className="mt-3 flex flex-col gap-3">
                {settlement.perCategory.map((p) => (
                  <div key={p.sharedCategoryId} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm text-foreground">
                        <bdi>{p.name}</bdi>
                      </span>
                      <Money value={p.combined} className="text-xs text-muted-foreground" />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      {p.members.map((m, i) => (
                        <span key={i}>
                          {m.label} paid <Money value={m.paid} /> · share <Money value={m.share} />
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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
        href={`/household?month=${previousMonth}`}
        aria-label="Previous month"
        className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
      </Link>
      <span className="min-w-32 text-center text-sm text-foreground">{monthLabel}</span>
      {nextMonth ? (
        <Link
          href={`/household?month=${nextMonth}`}
          aria-label="Next month"
          className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </Link>
      ) : (
        <span className="p-1.5 text-muted-foreground/40">
          <ChevronRight className="h-4 w-4" />
        </span>
      )}
    </div>
  );
}

function AddSharedCategoryDialog({
  householdId,
  onClose,
}: {
  householdId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [isRecurring, setIsRecurring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  async function save() {
    setError(null);
    const res = await fetch("/api/households/shared-categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ householdId, name: name.trim(), isRecurring }),
    });
    if (!res.ok) {
      setError(
        ((await res.json().catch(() => null)) as { error?: string } | null)?.error ??
          "Could not create the shared category.",
      );
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a shared category"
      description="A shared budget line both members' spend counts toward. Map your own local categories onto it after creating it."
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Groceries"
            maxLength={80}
          />
        </label>
        <div className="flex items-start justify-between gap-4">
          <div className="flex max-w-sm flex-col gap-1">
            <span id="recurring-label" className="text-sm text-foreground">
              Fixed cost
            </span>
            <span className="text-xs text-muted-foreground">
              Group it under Fixed rather than Everyday — a committed bill like rent, not day-to-day
              spending.
            </span>
          </div>
          <Switch
            checked={isRecurring}
            onCheckedChange={setIsRecurring}
            aria-labelledby="recurring-label"
          />
        </div>
        {error && (
          <p className="rounded-[var(--radius)] border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => startTransition(save)} disabled={busy || name.trim() === ""}>
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ConfigureDialog({
  household,
  category,
  expenseCategories,
  currency,
  month,
  onClose,
}: {
  household: HouseholdView;
  category: SharedCategoryView;
  expenseCategories: CategoryView[];
  currency: string;
  month: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  // --- Mapping ---
  const initialMapped = useMemo(
    () => new Set(category.myLocalCategoryIds),
    [category.myLocalCategoryIds],
  );
  const [mapped, setMapped] = useState<Set<string>>(initialMapped);
  // Show the categories already on this line first, so what's currently mapped
  // is visible without scrolling a long list. Ordered by the INITIAL mapping so
  // items don't jump as the user toggles.
  const orderedCategories = useMemo(
    () =>
      [...expenseCategories].sort(
        (a, b) => (initialMapped.has(b.id) ? 1 : 0) - (initialMapped.has(a.id) ? 1 : 0),
      ),
    [expenseCategories, initialMapped],
  );
  // A local category already folded into ANOTHER shared line can't cleanly feed
  // two — disable it here so its spend isn't double-counted across lines.
  const mappedElsewhere = useMemo(() => {
    const set = new Set<string>();
    for (const c of household.categories) {
      if (c.sharedCategoryId === category.sharedCategoryId) continue;
      for (const id of c.myLocalCategoryIds) set.add(id);
    }
    return set;
  }, [household.categories, category.sharedCategoryId]);

  function toggleMap(id: string) {
    setMapped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // --- Split (built for two members) ---
  const others = household.memberIds.filter((id) => id !== household.selfId);
  const twoMember = household.memberIds.length === 2 && others.length === 1;
  const partnerId = others[0];
  const currentMyWeight = category.splits.find((s) => s.memberId === household.selfId)?.weight;
  const [myPct, setMyPct] = useState<number>(
    currentMyWeight !== undefined ? Math.round(Number(currentMyWeight) * 100) : 50,
  );
  const splitDirty =
    currentMyWeight === undefined || Math.round(Number(currentMyWeight) * 100) !== myPct;

  // --- Ceiling ---
  const [ceilingAmount, setCeilingAmount] = useState(category.ceiling?.amount ?? "");
  const [rollover, setRollover] = useState(false);
  const initialCeiling = category.ceiling?.amount ?? "";
  const ceilingDirty = ceilingAmount.trim() !== initialCeiling;

  async function patch(body: unknown): Promise<boolean> {
    const res = await fetch(`/api/households/shared-categories/${category.sharedCategoryId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ householdId: household.householdId, ...(body as object) }),
    });
    if (!res.ok) {
      setError(
        ((await res.json().catch(() => null)) as { error?: string } | null)?.error ??
          "Could not save your changes.",
      );
      return false;
    }
    return true;
  }

  async function save() {
    setError(null);

    // Map / unmap the diff.
    for (const id of mapped) {
      if (!initialMapped.has(id)) {
        if (!(await patch({ op: "map", localCategoryId: id }))) return;
      }
    }
    for (const id of initialMapped) {
      if (!mapped.has(id)) {
        if (!(await patch({ op: "unmap", localCategoryId: id }))) return;
      }
    }

    // Split — only when it changed and we can express both members' weights.
    if (twoMember && splitDirty) {
      const myWeight = (myPct / 100).toString();
      const partnerWeight = ((100 - myPct) / 100).toString();
      const ok = await patch({
        op: "split",
        weights: [
          { memberId: household.selfId, weight: myWeight },
          { memberId: partnerId, weight: partnerWeight },
        ],
      });
      if (!ok) return;
    }

    // Ceiling — only when the amount changed, so opening this dialog to edit a
    // mapping doesn't silently reset the ceiling.
    if (ceilingDirty && ceilingAmount.trim() !== "") {
      const ok = await patch({
        op: "ceiling",
        amount: ceilingAmount.trim(),
        effectiveFrom: month,
        rollover,
      });
      if (!ok) return;
    }

    onClose();
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Configure ${category.name}`}
      description="Map your categories, set the split, and set the household ceiling for this month."
      className="max-w-lg"
    >
      <div className="flex flex-col gap-6">
        {/* Mapping */}
        <section className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">Your categories</span>
            <span className="text-xs text-muted-foreground">
              Which of your own categories count toward this shared line. Only your spend on these
              crosses — as a single monthly total.
            </span>
          </div>
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-[var(--radius)] border border-border p-2">
            {orderedCategories.map((c) => {
              const elsewhere = mappedElsewhere.has(c.id) && !mapped.has(c.id);
              return (
                <label
                  key={c.id}
                  className={cn(
                    "flex items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-sm",
                    elsewhere ? "opacity-40" : "hover:bg-muted",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={mapped.has(c.id)}
                    disabled={elsewhere}
                    onChange={() => toggleMap(c.id)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className={cn("min-w-0 flex-1 truncate", c.parentId && "pl-3")}>
                    <bdi>{c.name}</bdi>
                  </span>
                  {elsewhere && (
                    <span className="shrink-0 text-xs text-muted-foreground">on another line</span>
                  )}
                </label>
              );
            })}
          </div>
        </section>

        {/* Split */}
        <section className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">Split</span>
            <span className="text-xs text-muted-foreground">
              How the combined total divides when you settle up.
            </span>
          </div>
          {twoMember ? (
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-foreground">
                Your share
                <Input
                  value={String(myPct)}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/[^0-9]/g, ""));
                    setMyPct(Math.min(100, Math.max(0, Number.isNaN(n) ? 0 : n)));
                  }}
                  inputMode="numeric"
                  className="w-16 text-center"
                  aria-label="Your share percent"
                />
                %
              </label>
              <span className="text-xs text-muted-foreground">Partner gets {100 - myPct}%</span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Splitting is set up for two-member households. Current weights:{" "}
              {category.splits.length > 0
                ? category.splits.map((s) => `${Math.round(Number(s.weight) * 100)}%`).join(" / ")
                : "not set"}
              .
            </p>
          )}
        </section>

        {/* Ceiling */}
        <section className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">Household ceiling</span>
            <span className="text-xs text-muted-foreground">
              {`The combined limit for this line, from ${month} onward (${currency}). This replaces any personal ceiling on the categories above.`}
            </span>
          </div>
          <Input
            value={ceilingAmount}
            onChange={(e) => setCeilingAmount(e.target.value)}
            inputMode="decimal"
            placeholder="2000"
            className="sm:max-w-xs"
            aria-label="Household ceiling amount"
          />
          <div className="flex items-start justify-between gap-4">
            <div className="flex max-w-sm flex-col gap-1">
              <span id="hh-rollover-label" className="text-sm text-foreground">
                Carry the balance forward
              </span>
              <span className="text-xs text-muted-foreground">
                Unspent room accrues and an overspend follows into next month — for costs that
                aren&apos;t evenly monthly.
              </span>
            </div>
            <Switch
              checked={rollover}
              onCheckedChange={setRollover}
              aria-labelledby="hh-rollover-label"
            />
          </div>
        </section>

        {error && (
          <p className="rounded-[var(--radius)] border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => startTransition(save)} disabled={busy}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
