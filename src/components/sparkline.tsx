"use client";

import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";

interface SparklineProps {
  data: number[];
  /** Optional per-point labels (e.g. month names) shown in the hover tooltip. */
  labels?: string[];
  /** Currency for formatting tooltip values at the chart edge. */
  currency?: string;
  color?: string;
  height?: number;
}

interface SparkPoint {
  index: number;
  value: number;
  label?: string;
}

function SparkTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ value: number; payload: SparkPoint }>;
  currency?: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  // Chart-edge formatting only — never money math, just display.
  const formatted = point.value.toLocaleString("en-US", {
    ...(currency ? { style: "currency" as const, currency } : {}),
    maximumFractionDigits: 0,
  });
  return (
    <div className="rounded-[var(--radius)] border border-border bg-popover px-2.5 py-1.5 text-xs">
      {point.payload.label && (
        <span className="mr-2 text-muted-foreground">{point.payload.label}</span>
      )}
      <span className="tabular-nums text-foreground">{formatted}</span>
    </div>
  );
}

/**
 * Minimal trend line with a hover tooltip + active dot (ui-and-feel.md §6).
 * Margins are non-zero on every side so the active dot ring is never clipped
 * by the chart bounds (a fix for the "circle cut off at the edge" feedback).
 */
export function Sparkline({
  data,
  labels,
  currency,
  color = "var(--color-chart-2)",
  height = 48,
}: SparklineProps) {
  const points: SparkPoint[] = data.map((value, index) => ({
    index,
    value,
    label: labels?.[index],
  }));
  const gradientId = `sparkline-gradient-${color.replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 6, right: 6, bottom: 6, left: 6 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="index" hide />
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Tooltip
            content={<SparkTooltip currency={currency} />}
            cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3, stroke: "var(--color-card)", strokeWidth: 2, fill: color }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
