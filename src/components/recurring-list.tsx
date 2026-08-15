"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { MerchantIcon } from "@/components/merchant-icon";
import { RecurringPaymentsChart } from "@/components/recurring-payments-chart";
import {
  PAYMENT_WINDOWS,
  RANGE_LABELS,
  RECURRING_RANGES,
  type PaymentWindow,
  type RecurringRange,
} from "@/lib/recurring/range";
import { CADENCE_LABELS, SETTABLE_CADENCES } from "@/lib/recurring/cadence";
import { cn } from "@/lib/utils";
import type { RecurringGroup, RecurringRow, RecurringSummary } from "@/domain/recurring";

interface Props {
  income: RecurringGroup[];
  expenses: RecurringGroup[];
  incomeSummary: RecurringSummary;
  expensesSummary: RecurringSummary;
  range: RecurringRange;
}

export function RecurringList({ income, expenses, incomeSummary, expensesSummary, range }: Props) {
  const router = useRouter();

  function setRange(next: RecurringRange) {
    // In the URL, not component state: the range survives a reload and the
    // view stays deep-linkable, like the other route-based tabs.
    const params = new URLSearchParams(window.location.search);
    params.set("range", next);
    router.push(`/transactions/recurring?${params.toString()}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {
            "Per-month figures spread each payee over its cadence and cover all time. Category totals cover the selected period."
          }
        </p>
        <div className="flex gap-1">
          {RECURRING_RANGES.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setRange(key)}
              className={cn(
                "rounded-[var(--radius)] border px-2.5 py-1 text-xs transition focus:outline-none focus:ring-2 focus:ring-ring",
                key === range
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted",
              )}
            >
              {RANGE_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {/* Income and expenses never share a total: "recurring income minus
          recurring payments" is not a number anyone wants. */}
      <Section
        title="Recurring payments"
        groups={expenses}
        summary={expensesSummary}
        tone="negative"
        range={range}
      />
      <Section
        title="Recurring income"
        groups={income}
        summary={incomeSummary}
        tone="positive"
        range={range}
      />

      {income.length === 0 && expenses.length === 0 && (
        <Card className="px-5 pb-5 pt-6">
          <p className="text-sm text-muted-foreground">
            {
              "Nothing here yet. Flag a category as recurring on the Categories tab — the repeat icon beside its name — and its payees show up here."
            }
          </p>
        </Card>
      )}
    </div>
  );
}

function Section({
  title,
  groups,
  summary,
  tone,
  range,
}: {
  title: string;
  groups: RecurringGroup[];
  summary: RecurringSummary;
  tone: "positive" | "negative";
  range: RecurringRange;
}) {
  if (groups.length === 0) return null;
  const rangeLabel = RANGE_LABELS[range];

  return (
    <section className="flex flex-col gap-3">
      {/* The section header carries the roll-up across every category below it
          (#98): the per-month figure a budget is set from, with the range
          total beside it. Laid out like a category card's header so the eye
          reads the two levels the same way. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        <div className="flex items-baseline gap-3">
          <span
            className={cn(
              "text-sm font-medium",
              tone === "positive" ? "text-positive" : "text-negative",
            )}
          >
            {summary.monthlyAverageIsEstimate && "≈ "}
            <Money value={summary.monthlyAverage} />
            {" / mo"}
          </span>
          <span className="text-xs text-muted-foreground">
            <Money value={summary.total} />
            {` over ${rangeLabel.toLowerCase()}`}
          </span>
        </div>
      </div>
      {groups.map((group) => (
        <Card key={group.categoryId} className="flex flex-col gap-3 px-5 pb-4 pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-3">
            <bdi className="font-medium text-foreground">{group.categoryName}</bdi>
            {/* The per-month figure leads: it is what a budget is set from,
                and unlike the range total it does not change when the range
                control does. */}
            <div className="flex items-baseline gap-3">
              <span
                className={cn("text-sm", tone === "positive" ? "text-positive" : "text-negative")}
              >
                {group.monthlyAverageIsEstimate && "≈ "}
                <Money value={group.monthlyAverage} />
                {" / mo"}
              </span>
              <span className="text-xs text-muted-foreground">
                <Money value={group.total} />
                {` over ${rangeLabel.toLowerCase()}`}
              </span>
            </div>
          </div>
          <div className="flex flex-col divide-y divide-border">
            {group.rows.map((row) => (
              <Row key={row.id} row={row} tone={tone} />
            ))}
          </div>
        </Card>
      ))}
    </section>
  );
}

function Row({ row, tone }: { row: RecurringRow; tone: "positive" | "negative" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Not named `window` — that shadows the global one line away from a
  // `window.location` read in this same file.
  const [paymentWindow, setPaymentWindow] = useState<PaymentWindow>(6);
  const [savingCadence, setSavingCadence] = useState(false);

  const shown = paymentWindow === "all" ? row.payments : row.payments.slice(-paymentWindow);
  const Chevron = open ? ChevronDown : ChevronRight;

  async function setCadence(value: string) {
    setSavingCadence(true);
    await fetch("/api/merchants/cadence", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchText: row.matchText, cadence: value === "" ? null : value }),
    });
    setSavingCadence(false);
    router.refresh();
  }

  return (
    <div className="py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius)] px-1 py-1 text-left transition hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" />
        <MerchantIcon name={row.merchantName} logoUrl={row.logoUrl} brandColor={row.brandColor} />
        {/* `basis-40` reserves the name a full line so the wide "Not enough
            history" badge wraps below with the figures on a phone, instead of
            squeezing the name to zero and stacking it letter-by-letter. */}
        <div className="min-w-0 grow basis-40">
          <span className="block truncate text-sm text-foreground">
            <bdi>{row.merchantName}</bdi>
          </span>
          {row.merchantName.toLowerCase() !== row.matchText.toLowerCase() && (
            <span className="block truncate text-xs text-muted-foreground" title={row.matchText}>
              {"Match: "}
              <bdi>{row.matchText}</bdi>
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {`${row.paymentCount} payment${row.paymentCount === 1 ? "" : "s"} ${row.firstSeenLabel}`}
          </span>
        </div>
        <Badge className="shrink-0">{CADENCE_LABELS[row.cadence]}</Badge>
        {/* Fixed slot: without it a longer cadence badge shifts this row's
            figures and the amounts stop lining up between rows. `ml-auto`
            pins it to the edge when it wraps to its own line on mobile. */}
        <div className="ml-auto flex w-32 shrink-0 flex-col items-end">
          <Money
            value={row.latest}
            className={cn("text-sm", tone === "positive" ? "text-positive" : "text-negative")}
          />
          <span className="text-xs text-muted-foreground">
            {"avg "}
            <Money value={row.averageOfLast3} />
          </span>
          {/* Only where it says something new. Compared on the amounts rather
              than on the cadence: a monthly payee is the obvious case, but a
              lone payment with an unknown cadence lands on the same figure
              too, and that row was printing one number three times. */}
          {row.monthlyAverage.amount !== row.averageOfLast3.amount && (
            <span className="text-xs text-muted-foreground">
              {row.monthlyAverageIsEstimate && "≈ "}
              <Money value={row.monthlyAverage} />
              {" / mo"}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius)] bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {row.cadenceIsOverride ? "Cadence (set by you)" : "Cadence (read from the dates)"}
              <select
                value={row.cadenceIsOverride ? row.cadence : ""}
                disabled={savingCadence}
                onChange={(e) => setCadence(e.target.value)}
                className="rounded-[var(--radius)] border border-input bg-card px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                <option value="">{"Read from the dates"}</option>
                {SETTABLE_CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            {/* Counted in payments, not months: a yearly renewal shows years
                and a monthly one shows months, so no graph is ever empty. */}
            <div className="flex gap-1">
              {[...PAYMENT_WINDOWS, "all" as const].map((w) => (
                <button
                  key={String(w)}
                  type="button"
                  onClick={() => setPaymentWindow(w)}
                  className={cn(
                    "rounded-[var(--radius)] border px-2 py-0.5 text-[11px] transition focus:outline-none focus:ring-2 focus:ring-ring",
                    w === paymentWindow
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {w === "all" ? "All" : `Last ${w}`}
                </button>
              ))}
            </div>
          </div>
          <RecurringPaymentsChart
            payments={shown.map((p) => ({
              dateLabel: p.dateLabel,
              amount: p.amount.amount,
              currency: p.amount.currency,
            }))}
            color={tone === "positive" ? "var(--color-positive)" : "var(--color-chart-3)"}
          />
        </div>
      )}
    </div>
  );
}
