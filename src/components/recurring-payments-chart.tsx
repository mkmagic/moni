"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface ChartPayment {
  dateLabel: string;
  /** Exact decimal string from the domain layer — widened at the chart edge only. */
  amount: string;
  currency: string;
}

interface Props {
  payments: ChartPayment[];
  color: string;
}

interface Point {
  label: string;
  value: number;
  currency: string;
}

function PaymentTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ value: number; payload: Point }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  // Chart-edge formatting only, never money math (money-and-currency.md §3).
  const formatted = point.value.toLocaleString("en-US", {
    style: "currency",
    currency: point.payload.currency,
    maximumFractionDigits: 2,
  });
  return (
    <div className="rounded-[var(--radius)] border border-border bg-popover px-2.5 py-1.5 text-xs">
      <span className="mr-2 text-muted-foreground">{point.payload.label}</span>
      <span className="tabular-nums text-foreground">{formatted}</span>
    </div>
  );
}

/**
 * One bar per payment. Bars rather than a line because these are discrete
 * charges, not a continuous quantity — a line between two monthly bills
 * implies values in between that were never paid.
 *
 * `Number()` on a money string is the sanctioned display-edge widening: it
 * happens here, inside the chart data array, and nowhere upstream.
 */
export function RecurringPaymentsChart({ payments, color }: Props) {
  const data: Point[] = payments.map((p) => ({
    label: p.dateLabel,
    value: Number(p.amount),
    currency: p.currency,
  }));

  return (
    <div className="h-40">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            width={52}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
          />
          <Tooltip content={<PaymentTooltip />} cursor={{ fill: "var(--color-muted)" }} />
          <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
