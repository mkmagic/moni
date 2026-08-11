"use client";

import {
  AreaChart,
  Area,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import type { MonthPoint } from "@/domain/dashboard";

interface IncomeExpenseChartProps {
  months: MonthPoint[];
  /** Sparkline mode for the dashboard's "This month" card: short, no grid or
   * axes, thinner strokes — the same two series, sized to sit inside a cell. */
  compact?: boolean;
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "short" });

function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return MONTH_LABEL.format(new Date(Date.UTC(year, month - 1, 1)));
}

interface ChartRow {
  month: string;
  income: number;
  expenses: number;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-xs shadow-none">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="tabular-nums" style={{ color: entry.color }}>
          {entry.name}: {entry.value.toLocaleString("en-US", { maximumFractionDigits: 0 })}
        </p>
      ))}
    </div>
  );
}

export function IncomeExpenseChart({ months, compact = false }: IncomeExpenseChartProps) {
  // Chart-edge conversion only — the domain layer returned exact decimal strings.
  const data: ChartRow[] = months.map((m) => ({
    month: monthLabel(m.month),
    income: Number(m.income),
    expenses: Number(m.expenses),
  }));

  const stroke = compact ? 1.6 : 2;

  return (
    <div style={{ height: compact ? 56 : 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={
            compact
              ? { top: 6, right: 6, bottom: 6, left: 6 }
              : { top: 8, right: 8, bottom: 0, left: 0 }
          }
        >
          <defs>
            <linearGradient id="income-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-chart-2)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-chart-2)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="expenses-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-chart-3)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-chart-3)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {/* A sparkline is just the two lines; the grid and axis belong to the
              full chart on a detail view, not to a cell inside a card. */}
          {!compact && (
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          )}
          <XAxis
            dataKey="month"
            axisLine={false}
            tickLine={false}
            hide={compact}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            hide
            domain={compact ? ["dataMin", "dataMax"] : undefined}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey="income"
            name="Income"
            stroke="var(--color-chart-2)"
            strokeWidth={stroke}
            fill="url(#income-gradient)"
            dot={false}
            activeDot={{
              r: 3,
              stroke: "var(--color-card)",
              strokeWidth: 2,
              fill: "var(--color-chart-2)",
            }}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="expenses"
            name="Expenses"
            stroke="var(--color-chart-3)"
            strokeWidth={stroke}
            fill="url(#expenses-gradient)"
            dot={false}
            activeDot={{
              r: 3,
              stroke: "var(--color-card)",
              strokeWidth: 2,
              fill: "var(--color-chart-3)",
            }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
