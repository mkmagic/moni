"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/lib/format";

/** One month of combined household spend (exact-decimal strings from the
 * domain; converted to Numbers only at the chart edge for bar heights). */
export interface HouseholdMonthlyPoint {
  label: string;
  combined: string;
  ceiling: string | null;
}

interface Props {
  months: HouseholdMonthlyPoint[];
  currency: string;
}

const SPENT_COLOR = "var(--color-chart-3)"; // coral = spending, everywhere in Moni

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
  payload?: Array<{ payload: { combined: number; ceiling: number | null } }>;
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const { combined, ceiling } = payload[0].payload;
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-xs">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <p className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: SPENT_COLOR }}
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
    </div>
  );
}

/**
 * Combined household spend on shared categories, one bar per month — a simple
 * trailing-window view so a couple can see the shape of their shared spending.
 */
export function HouseholdMonthlyChart({ months, currency }: Props) {
  const data = months.map((m) => ({
    month: m.label,
    combined: Number(m.combined),
    ceiling: m.ceiling === null ? null : Number(m.ceiling),
  }));

  return (
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
          <Bar
            dataKey="combined"
            name="Combined"
            fill={SPENT_COLOR}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
