"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "@/lib/format";

/** One month of combined household spend (exact-decimal strings from the
 * domain; converted to Numbers only at the chart edge for bar heights). */
export interface HouseholdMonthlyPoint {
  label: string;
  combined: string;
  ceiling: string | null;
  /** Within the total ceiling that month? Null when no ceiling was set. */
  withinBudget: boolean | null;
}

interface Props {
  months: HouseholdMonthlyPoint[];
  currency: string;
}

// The bar's colour is the verdict: within the household ceiling is a good
// month, over it is not. Same teal/coral the rest of Moni uses for
// inflow/outflow and under/over budget; a month with no ceiling can't be
// judged, so it stays neutral.
const WITHIN_COLOR = "var(--color-positive)";
const OVER_COLOR = "var(--color-negative)";
const NEUTRAL_COLOR = "var(--color-muted-foreground)";

function barColor(withinBudget: boolean | null): string {
  if (withinBudget === null) return NEUTRAL_COLOR;
  return withinBudget ? WITHIN_COLOR : OVER_COLOR;
}

function compactTick(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

interface Datum {
  month: string;
  combined: number;
  ceiling: number | null;
  withinBudget: boolean | null;
}

function ChartTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload: Datum }>;
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const { combined, ceiling, withinBudget } = payload[0].payload;
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-xs">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <p className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: barColor(withinBudget) }}
        />
        <span className="text-muted-foreground">Combined</span>
        <span className="ml-auto tabular-nums text-foreground">
          {formatMoney({ amount: String(combined), currency })}
        </span>
      </p>
      {ceiling !== null && (
        <p className="mt-0.5 flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0" />
          <span className="text-muted-foreground">Ceiling</span>
          <span className="ml-auto tabular-nums text-muted-foreground">
            {formatMoney({ amount: String(ceiling), currency })}
          </span>
        </p>
      )}
      {withinBudget !== null && (
        <p className="mt-1" style={{ color: barColor(withinBudget) }}>
          {withinBudget ? "Within budget" : "Over budget"}
        </p>
      )}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/**
 * Combined household spend on shared categories, one bar per month — a simple
 * trailing-window view so a couple can see the shape of their shared spending.
 * Each bar is green when the household stayed within its ceiling that month and
 * red when it went over.
 */
export function HouseholdMonthlyChart({ months, currency }: Props) {
  const data: Datum[] = months.map((m) => ({
    month: m.label,
    combined: Number(m.combined),
    ceiling: m.ceiling === null ? null : Number(m.ceiling),
    withinBudget: m.withinBudget,
  }));

  const hasWithin = data.some((d) => d.withinBudget === true);
  const hasOver = data.some((d) => d.withinBudget === false);
  const hasNeutral = data.some((d) => d.withinBudget === null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        {hasWithin && <LegendSwatch color={WITHIN_COLOR} label="Within budget" />}
        {hasOver && <LegendSwatch color={OVER_COLOR} label="Over budget" />}
        {hasNeutral && <LegendSwatch color={NEUTRAL_COLOR} label="No ceiling set" />}
      </div>

      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            barCategoryGap="30%"
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
            <Bar dataKey="combined" name="Combined" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={i} fill={barColor(d.withinBudget)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
