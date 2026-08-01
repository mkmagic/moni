import Decimal from "decimal.js";
import type { PortfolioHistory } from "@/domain/investments";

export interface CompositionChartPoint {
  week: string;
  total: string;
  values: Record<string, number>;
  exact: Record<string, string>;
}

/** Recharts receives only unitless composition ratios. Exact values remain in `exact`. */
export function compositionCoordinates(history: PortfolioHistory): CompositionChartPoint[] {
  return history.points.map((point) => {
    const total = new Decimal(point.ilsValue);
    const exact: Record<string, string> = {};
    const values: Record<string, number> = {};
    for (const item of point.composition) {
      exact[item.id] = item.ilsValue;
      values[item.id] = total.isZero()
        ? 0
        : new Decimal(item.ilsValue).div(total).mul(100).toNumber();
    }
    return { week: point.week, total: point.ilsValue, values, exact };
  });
}

/**
 * Names a week by the day it ends. The estimate the chart appends carries the
 * literal label "Estimated now" rather than a week start, so anything that
 * isn't an ISO date passes through untouched instead of throwing on an
 * invalid `Date`.
 */
export function weekEnding(week: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return week;
  const date = new Date(`${week}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}
