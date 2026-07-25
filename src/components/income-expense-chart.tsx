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

export function IncomeExpenseChart({ months }: IncomeExpenseChartProps) {
  // Chart-edge conversion only — the domain layer returned exact decimal strings.
  const data: ChartRow[] = months.map((m) => ({
    month: monthLabel(m.month),
    income: Number(m.income),
    expenses: Number(m.expenses),
  }));

  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
          <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          <XAxis
            dataKey="month"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          />
          <YAxis axisLine={false} tickLine={false} hide />
          <Tooltip content={<ChartTooltip />} />
          <Area
            type="monotone"
            dataKey="income"
            name="Income"
            stroke="var(--color-chart-2)"
            strokeWidth={2}
            fill="url(#income-gradient)"
            dot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="expenses"
            name="Expenses"
            stroke="var(--color-chart-3)"
            strokeWidth={2}
            fill="url(#expenses-gradient)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
