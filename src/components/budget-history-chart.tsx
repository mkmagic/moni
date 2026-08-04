"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/lib/format";
import type { BudgetHistoryPoint } from "@/domain/budget";

interface BudgetHistoryChartProps {
  months: BudgetHistoryPoint[];
  currency: string;
}

/** Identity is fixed per series and never reassigned, so a series keeps its
 * colour no matter how many months are drawn. Teal/coral already mean
 * income/expense everywhere else in Moni; blue is the neutral third — it is
 * the reference the other two are read against and must not itself look like
 * a verdict. */
const SERIES = [
  { key: "income", label: "Income", color: "var(--color-chart-2)" },
  { key: "spent", label: "Spent", color: "var(--color-chart-3)" },
  { key: "planned", label: "Budgeted", color: "var(--color-chart-4)" },
] as const;

/** Axis ticks have room for "₪8K", not "₪8,450.00". The exact strings live in
 * the tooltip, where there is space to be precise. */
function compactTick(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function ChartTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-xs">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          {/* The swatch carries identity; the text stays in ink tokens so it
              never has to pass a contrast check against a series colour. */}
          <span className="text-muted-foreground">{entry.name}</span>
          <span className="ml-auto tabular-nums text-foreground">
            {formatMoney({ amount: String(entry.value), currency })}
          </span>
        </p>
      ))}
    </div>
  );
}

/**
 * Income, spending and the plan, one group of bars per complete month.
 *
 * One axis for all three series — they are the same measure in the same
 * currency, so a second scale would let two bars of equal height mean
 * different amounts.
 */
export function BudgetHistoryChart({ months, currency }: BudgetHistoryChartProps) {
  // Chart-edge conversion only — the domain layer returned exact decimal
  // strings, and these Numbers become bar heights, never a figure anyone
  // reads (money-and-currency.md §3/§6).
  const data = months.map((m) => ({
    month: m.label,
    income: Number(m.income.amount),
    spent: Number(m.spent.amount),
    planned: Number(m.planned.amount),
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        {SERIES.map((series) => (
          <span key={series.key} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: series.color }}
            />
            {series.label}
          </span>
        ))}
      </div>

      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* The three bars of a month are one group and have to read as one,
              so the space goes *between* months (`barCategoryGap`) rather
              than between the bars. `maxBarSize` is deliberately not used: it
              caps each bar inside a slot it no longer fills, which floats the
              group apart into three unrelated columns. */}
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            barGap={2}
            barCategoryGap="25%"
          >
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="month"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={64}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
              tickFormatter={(value: number) => compactTick(value, currency)}
            />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
              content={<ChartTooltip currency={currency} />}
            />
            {SERIES.map((series) => (
              <Bar
                key={series.key}
                dataKey={series.key}
                name={series.label}
                fill={series.color}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
