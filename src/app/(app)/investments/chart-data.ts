import type { PortfolioHistory } from "@/domain/investments";

export interface ValuationChartPoint {
  week: string;
  total: string;
  values: Record<string, number>;
  exact: Record<string, string>;
}

/**
 * Recharts plots the ILS valuation itself, so the stack's top edge is the
 * portfolio's worth that week and the bands below it say where that worth sat.
 * Only these plotted numbers are floats; `total` and `exact` stay exact for
 * anything that renders as money.
 */
export function valuationCoordinates(history: PortfolioHistory): ValuationChartPoint[] {
  return history.points.map((point) => {
    const exact: Record<string, string> = {};
    const values: Record<string, number> = {};
    for (const item of point.composition) {
      exact[item.id] = item.ilsValue;
      values[item.id] = Number(item.ilsValue);
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
