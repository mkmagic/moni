/**
 * Display labels for long-term savings. Lives in `lib/` rather than the domain
 * layer so a `"use client"` screen can import it: a runtime value imported from
 * `@/domain/**` drags `src/db/client.ts` and then `pg` into the browser bundle
 * (see `src/lib/budget/residual.ts` for the same reason).
 *
 * Every date here is formatted with a PINNED locale. An unpinned
 * `toLocaleString` renders differently on the server and in the browser, which
 * React reports as a hydration error.
 */

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

function month(isoDate: string): string {
  return MONTH.format(new Date(`${isoDate}T00:00:00Z`));
}

export interface LiquidityBadge {
  /** True when the money cannot be reached yet — the caller picks the icon. */
  locked: boolean;
  text: string;
}

/**
 * When the money becomes reachable. Governs presentation only: every balance
 * counts fully toward net worth whatever this says (#76 D2).
 */
export function liquidityBadge(input: {
  liquidity: "locked_retirement" | "liquid_after" | "liquid";
  liquidFrom: string | null;
  /** The report's own stated retirement age, when one was imported. */
  retirementAge: number | null;
}): LiquidityBadge {
  if (input.liquidity === "liquid") return { locked: false, text: "Available now" };
  if (input.liquidity === "liquid_after")
    return {
      locked: false,
      text: input.liquidFrom
        ? `Available from ${input.liquidFrom.slice(0, 4)}`
        : "Available after a qualifying period",
    };
  // The age is the document's, not Moni's — say "retirement" rather than
  // asserting a number no report has stated yet.
  return {
    locked: true,
    text: input.retirementAge ? `Locked until ${input.retirementAge}` : "Locked until retirement",
  };
}

/** How old the figure is, as the report itself states it: "Q1 2026". */
export function asOfLabel(input: {
  asOf: string;
  quarter: number | null;
  fiscalYear: number | null;
}): string {
  if (input.quarter && input.fiscalYear) return `Q${input.quarter} ${input.fiscalYear}`;
  return `${month(input.asOf)} ${input.asOf.slice(0, 4)}`;
}

/**
 * The period a flow figure actually covers, as printed. Israeli quarterly
 * reports state flows year-to-date, so a Q3 report's contributions cover
 * January–September (#76 D6) — labelling them "this quarter" would be a claim
 * the document does not make.
 */
export function statedPeriodLabel(start: string, end: string): string {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return sameYear
    ? `${month(start)}–${month(end)}`
    : `${month(start)} ${start.slice(0, 4)}–${month(end)} ${end.slice(0, 4)}`;
}

/**
 * A rate exactly as the report prints it. Never rounded or re-scaled: "0.0018"
 * on the page means 0.0018%, and shortening it would change the figure.
 */
export function formatPercent(value: string): string {
  return `${value}%`;
}

/** "2026-03" as printed in the deposit table's "for month" column. */
export function forMonthLabel(forMonth: string): string {
  const [year, monthNumber] = forMonth.split("-");
  if (!year || !monthNumber) return forMonth;
  return `${MONTH.format(new Date(Date.UTC(Number(year), Number(monthNumber) - 1, 1)))} ${year}`;
}

/** A deposit date, pinned like every other date here. */
export function dayLabel(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );
}
