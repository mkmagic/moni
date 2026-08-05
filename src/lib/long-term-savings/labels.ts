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

import { getConnectorDefinition } from "@/lib/connectors";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

function month(isoDate: string): string {
  return MONTH.format(new Date(`${isoDate}T00:00:00Z`));
}

export type ProductName =
  "pension" | "hishtalmut" | "gemel" | "gemel_investment" | "managers_insurance";

/**
 * What the account IS, in the vocabulary CONTEXT.md pins. Hebrew where the
 * product has no honest English name — "provident fund" as a catch-all is
 * exactly what that entry says to avoid, and it would collapse three products
 * with different liquidity horizons into one word.
 */
export const PRODUCT_LABEL: Record<ProductName, string> = {
  pension: "Pension",
  hishtalmut: "קרן השתלמות",
  gemel: "קופת גמל",
  gemel_investment: "קופת גמל להשקעה",
  managers_insurance: "ביטוח מנהלים",
};

/**
 * The account's name: the provider and the product held there ("Harel
 * Pension"), not the document that reported it.
 *
 * A long-term savings statement carries no account name and no account number,
 * so everything stored in `accounts.name_ct` is either a nickname the user
 * typed or a string Moni derived. This corrects the derived one — the original
 * `<provider> <document>` default, which read "Harel Quarterly Pension Report"
 * — without waiting for the next import, and leaves a nickname alone because a
 * nickname never matches that pattern.
 */
export function longTermSavingsAccountName(
  storedName: string,
  connectorId: string | null,
  product: ProductName,
): string {
  const definition = connectorId ? getConnectorDefinition(connectorId) : undefined;
  const provider = definition?.institutionLabel;
  if (!provider) return storedName;
  return storedName === `${provider} ${definition.label}`
    ? `${provider} ${PRODUCT_LABEL[product]}`
    : storedName;
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

/** "Mar 2026" — the ends of a span the reports cover. */
export function monthYearLabel(isoDate: string): string {
  return `${month(isoDate)} ${isoDate.slice(0, 4)}`;
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
