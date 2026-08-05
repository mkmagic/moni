/**
 * Domain read: long-term-savings accounts and their latest imported report.
 *
 * Decrypt-then-shape in the app tier, like every other read here — money comes
 * back as exact decimal strings and is never formatted or rounded on this side
 * of the boundary.
 *
 * Two things this layer decides rather than the UI. The **fee verdict**: whether
 * the member pays more than the fund average is a comparison of two exact
 * decimals, so it happens here and the screen only renders the answer. And the
 * **stated period**: an Israeli quarterly report states its flows year-to-date
 * (#76 D6), so `statedPeriodStart`/`End` travel with every flow figure and the
 * screen labels them with that range — never "this quarter", which the document
 * does not say.
 */
import Decimal from "decimal.js";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { withUser } from "@/db/client";
import {
  accounts,
  connections,
  longTermSavingsDetails,
  longTermSavingsSnapshotDeposits,
  longTermSavingsSnapshotTracks,
  longTermSavingsSnapshots,
} from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import type { Money } from "@/lib/money";
import { decText } from "./fields";

type SnapshotRow = typeof longTermSavingsSnapshots.$inferSelect;

export type LongTermSavingsProductName = (typeof longTermSavingsDetails.product.enumValues)[number];
export type LongTermSavingsLiquidity = (typeof longTermSavingsDetails.liquidity.enumValues)[number];

/** Enough to badge an account card: when the money unlocks, and how old the figure is. */
export interface LongTermSavingsSummary {
  accountId: string;
  product: LongTermSavingsProductName;
  liquidity: LongTermSavingsLiquidity;
  /** Set only when `liquidity` is `liquid_after`. */
  liquidFrom: string | null;
  /** The latest report's own date. Null until the first import. */
  asOf: string | null;
  quarter: number | null;
  fiscalYear: number | null;
  /** The report's stated retirement age, so "locked until 67" can be specific. */
  retirementAge: number | null;
}

export interface LongTermSavingsFees {
  onDeposit: string | null;
  onSavings: string | null;
  fundAverageOnDeposit: string | null;
  fundAverageOnSavings: string | null;
  /**
   * Dimensions where the member pays more than the fund average. Fees are the
   * only *actionable* figure in the report — negotiable in Israel, and an extra
   * 1% a year costs roughly a fifth of the final balance — so this is what the
   * screen promotes to a callout. Empty means there is nothing to do, and the
   * screen stays quiet.
   */
  aboveAverage: Array<{ dimension: "deposits" | "savings"; rate: string; fundAverage: string }>;
}

export interface LongTermSavingsDepositRow {
  rowIndex: number;
  employer: string | null;
  depositDate: string;
  /** The salary month the deposit is for, `YYYY-MM` exactly as printed. */
  forMonth: string;
  salary: Money | null;
  employee: Money;
  employerContribution: Money;
  severance: Money;
  total: Money;
}

export interface LongTermSavingsTrackRow {
  rowIndex: number;
  name: string;
  returnPercent: string | null;
  annualCostPercent: string | null;
}

/**
 * What a report adds on top of the one before it.
 *
 * An Israeli quarterly report states its flows **year-to-date**, so a Q3
 * report's contributions cover January–September. Differencing it against the
 * previous report of the same fiscal year is what turns that into the quarter —
 * the derivation CONTEXT.md's "Stated period" entry names, and the reason flows
 * are stored exactly as published rather than pre-differenced.
 */
export interface LongTermSavingsPeriodFlows {
  start: string;
  end: string;
  /**
   * False when there is no earlier report in the same fiscal year to difference
   * against. The figures are then the document's own year-to-date ones, and the
   * view says so rather than presenting nine months as a quarter.
   */
  derived: boolean;
  contributions: Money;
  investmentResult: Money;
  feesCharged: Money;
}

/** One imported report, in the list of everything held for an account. */
export interface LongTermSavingsReportView {
  id: string;
  asOf: string;
  statedPeriodStart: string;
  statedPeriodEnd: string;
  quarter: number | null;
  fiscalYear: number | null;
  closingBalance: Money;
  /** This report's own share of the flows. */
  period: LongTermSavingsPeriodFlows;
}

/**
 * Everything the imported reports add up to, so the card can answer "how much
 * have I put in" rather than only "what did the last statement say".
 *
 * Summed from each report's `period`, which is why differencing has to happen
 * before this: adding four year-to-date figures would count January four times.
 */
export interface LongTermSavingsTotals {
  contributions: Money;
  investmentResult: Money;
  feesCharged: Money;
  reportCount: number;
  /** The span the reports actually cover. */
  from: string;
  to: string;
  /**
   * True when the covered periods don't join up — a year with no report, or a
   * quarter that had to fall back to year-to-date. The totals are then a sum of
   * what was imported, not of the account's whole life, and the view says so.
   */
  hasGaps: boolean;
}

export interface LongTermSavingsSnapshotView extends LongTermSavingsReportView {
  /**
   * The report's stated retirement age, so a locked badge can say "until 67"
   * rather than "until retirement". This is the only part of the projection
   * block that surfaces — the projected pension amounts stay stored and unshown
   * (#76 D8), since they assume no further contributions and read as a forecast
   * that is wrong by an order of magnitude.
   */
  retirementAge: number | null;
  openingBalance: Money;
  /** As published: everything paid in over the STATED period, not the quarter. */
  contributions: Money;
  /** Signed: gains in a good period, losses in a bad one. As published. */
  investmentResult: Money;
  feesCharged: Money;
  fees: LongTermSavingsFees;
  deposits: LongTermSavingsDepositRow[];
  tracks: LongTermSavingsTrackRow[];
}

export interface LongTermSavingsAccountView {
  accountId: string;
  name: string;
  institution: string | null;
  connectionId: string | null;
  connectorId: string | null;
  product: LongTermSavingsProductName;
  liquidity: LongTermSavingsLiquidity;
  liquidFrom: string | null;
  /** Newest first. Empty until the first report has been imported. */
  reports: LongTermSavingsReportView[];
  /** The newest report, with its deposit table and tracks. */
  latest: LongTermSavingsSnapshotView | null;
  /** Null until the first report has been imported. */
  totals: LongTermSavingsTotals | null;
}

/** The day after `isoDate` — a differenced period starts where the last one ended. */
function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Turns a run of reports into per-period flows and their totals.
 *
 * The differencing rule is the fiscal year: an Israeli quarterly report restates
 * its flows from the start of the year, so a report is differenced against the
 * previous report **of the same year** and stands alone otherwise. That makes a
 * Q1 report correct without differencing, and a Q3 report with no Q2 fall back
 * to what the document literally says rather than to an invented quarter.
 *
 * Rows arrive oldest first; the returned reports are newest first.
 */
function deriveReports(
  dataKey: Uint8Array,
  held: SnapshotRow[],
): { reports: LongTermSavingsReportView[]; totals: LongTermSavingsTotals | null } {
  const reports: LongTermSavingsReportView[] = [];
  let contributions = new Decimal(0);
  let investmentResult = new Decimal(0);
  let feesCharged = new Decimal(0);
  let hasGaps = false;
  let coveredThrough: string | null = null;

  for (const [index, row] of held.entries()) {
    const flow = (ct: Uint8Array, column: string) =>
      new Decimal(decText(dataKey, ct, row.id, column, row.version) ?? "0");
    const previous = held[index - 1];
    const sameYear =
      previous !== undefined &&
      previous.fiscalYear !== null &&
      previous.fiscalYear === row.fiscalYear;
    const base = sameYear
      ? {
          contributions: new Decimal(
            decText(
              dataKey,
              previous.contributionsCt,
              previous.id,
              "contributions_ct",
              previous.version,
            ) ?? "0",
          ),
          investmentResult: new Decimal(
            decText(
              dataKey,
              previous.investmentResultCt,
              previous.id,
              "investment_result_ct",
              previous.version,
            ) ?? "0",
          ),
          feesCharged: new Decimal(
            decText(
              dataKey,
              previous.feesChargedCt,
              previous.id,
              "fees_charged_ct",
              previous.version,
            ) ?? "0",
          ),
        }
      : null;

    const periodContributions = flow(row.contributionsCt, "contributions_ct").minus(
      base?.contributions ?? 0,
    );
    const periodResult = flow(row.investmentResultCt, "investment_result_ct").minus(
      base?.investmentResult ?? 0,
    );
    const periodFees = flow(row.feesChargedCt, "fees_charged_ct").minus(base?.feesCharged ?? 0);
    const start = base ? nextDay(previous.statedPeriodEnd) : row.statedPeriodStart;

    // A hole between what the last report covered and where this one starts
    // means the totals below are a sum of what was imported, not of the
    // account's whole life.
    if (coveredThrough !== null && start > nextDay(coveredThrough)) hasGaps = true;
    coveredThrough = row.statedPeriodEnd;

    contributions = contributions.plus(periodContributions);
    investmentResult = investmentResult.plus(periodResult);
    feesCharged = feesCharged.plus(periodFees);

    reports.push({
      id: row.id,
      asOf: row.asOf,
      statedPeriodStart: row.statedPeriodStart,
      statedPeriodEnd: row.statedPeriodEnd,
      quarter: row.quarter,
      fiscalYear: row.fiscalYear,
      closingBalance: {
        amount:
          decText(dataKey, row.closingBalanceCt, row.id, "closing_balance_ct", row.version) ?? "0",
        currency: row.currency,
      },
      period: {
        start,
        end: row.statedPeriodEnd,
        derived: base !== null,
        contributions: { amount: periodContributions.toFixed(), currency: row.currency },
        investmentResult: { amount: periodResult.toFixed(), currency: row.currency },
        feesCharged: { amount: periodFees.toFixed(), currency: row.currency },
      },
    });
  }

  reports.reverse();
  const first = held[0];
  const last = held.at(-1);
  return {
    reports,
    totals:
      first === undefined || last === undefined
        ? null
        : {
            contributions: { amount: contributions.toFixed(), currency: last.currency },
            investmentResult: { amount: investmentResult.toFixed(), currency: last.currency },
            feesCharged: { amount: feesCharged.toFixed(), currency: last.currency },
            reportCount: held.length,
            from: first.statedPeriodStart,
            to: last.statedPeriodEnd,
            hasGaps,
          },
  };
}

function above(
  dimension: "deposits" | "savings",
  rate: string | null,
  fundAverage: string | null,
): LongTermSavingsFees["aboveAverage"] {
  if (rate === null || fundAverage === null) return [];
  return new Decimal(rate).gt(fundAverage) ? [{ dimension, rate, fundAverage }] : [];
}

/**
 * The liquidity badge and as-of quarter for every long-term-savings account,
 * keyed by account id. Deliberately narrower than
 * {@link listLongTermSavingsAccounts} — the accounts page needs neither the
 * deposit table nor the tracks.
 */
export async function listLongTermSavingsSummaries(
  session: Session,
): Promise<Map<string, LongTermSavingsSummary>> {
  const { userId } = session;
  return withUser(userId, async (tx) => {
    const details = await tx.select().from(longTermSavingsDetails);
    if (details.length === 0) return new Map();
    const snapshots = await tx
      .select({
        accountId: longTermSavingsSnapshots.accountId,
        asOf: longTermSavingsSnapshots.asOf,
        quarter: longTermSavingsSnapshots.quarter,
        fiscalYear: longTermSavingsSnapshots.fiscalYear,
        retirementAge: longTermSavingsSnapshots.projectionRetirementAge,
      })
      .from(longTermSavingsSnapshots)
      .orderBy(asc(longTermSavingsSnapshots.asOf));
    // Ascending, so the last write per account wins — the newest report.
    const latest = new Map(snapshots.map((row) => [row.accountId, row]));
    return new Map(
      details.map((detail) => {
        const newest = latest.get(detail.accountId);
        return [
          detail.accountId,
          {
            accountId: detail.accountId,
            product: detail.product,
            liquidity: detail.liquidity,
            liquidFrom: detail.liquidFrom,
            asOf: newest?.asOf ?? null,
            quarter: newest?.quarter ?? null,
            fiscalYear: newest?.fiscalYear ?? null,
            retirementAge: newest?.retirementAge ?? null,
          },
        ];
      }),
    );
  });
}

export async function listLongTermSavingsAccounts(
  session: Session,
): Promise<LongTermSavingsAccountView[]> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({ account: accounts, detail: longTermSavingsDetails })
      .from(longTermSavingsDetails)
      .innerJoin(accounts, eq(accounts.id, longTermSavingsDetails.accountId))
      .orderBy(asc(accounts.createdAt));
    if (rows.length === 0) return [];

    const [snapshots, connectionRows] = await Promise.all([
      tx.select().from(longTermSavingsSnapshots).orderBy(desc(longTermSavingsSnapshots.asOf)),
      tx.select({ id: connections.id, connectorId: connections.connectorId }).from(connections),
    ]);
    // The connector is what names the provider ("Harel") at the display edge.
    const connectorByConnection = new Map(connectionRows.map((row) => [row.id, row.connectorId]));
    // Descending, so the FIRST row seen per account is its newest report.
    const newest = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots)
      if (!newest.has(snapshot.accountId)) newest.set(snapshot.accountId, snapshot);
    const shownIds = [...newest.values()].map((snapshot) => snapshot.id);

    const [depositRows, trackRows] = shownIds.length
      ? await Promise.all([
          tx
            .select()
            .from(longTermSavingsSnapshotDeposits)
            .where(inArray(longTermSavingsSnapshotDeposits.snapshotId, shownIds))
            .orderBy(asc(longTermSavingsSnapshotDeposits.rowIndex)),
          tx
            .select()
            .from(longTermSavingsSnapshotTracks)
            .where(inArray(longTermSavingsSnapshotTracks.snapshotId, shownIds))
            .orderBy(asc(longTermSavingsSnapshotTracks.rowIndex)),
        ])
      : [[], []];

    return rows.map(({ account, detail }): LongTermSavingsAccountView => {
      // Oldest first: differencing needs each report's predecessor, and the
      // list is reversed once at the end.
      const held = snapshots
        .filter((row) => row.accountId === account.id)
        .sort((a, b) => a.asOf.localeCompare(b.asOf));
      const snapshot = newest.get(account.id);
      const money = (ct: Uint8Array, column: string): Money => ({
        amount: decText(dataKey, ct, snapshot!.id, column, snapshot!.version) ?? "0",
        currency: snapshot!.currency,
      });
      const { reports, totals } = deriveReports(dataKey, held);
      return {
        accountId: account.id,
        name: decText(dataKey, account.nameCt, account.id, "name_ct", account.version) ?? "",
        institution: account.institution,
        connectionId: account.connectionId,
        connectorId: connectorByConnection.get(account.connectionId ?? "") ?? null,
        product: detail.product,
        liquidity: detail.liquidity,
        liquidFrom: detail.liquidFrom,
        reports,
        totals,
        latest: !snapshot
          ? null
          : {
              ...reports[0],
              retirementAge: snapshot.projectionRetirementAge,
              openingBalance: money(snapshot.openingBalanceCt, "opening_balance_ct"),
              contributions: money(snapshot.contributionsCt, "contributions_ct"),
              investmentResult: money(snapshot.investmentResultCt, "investment_result_ct"),
              feesCharged: money(snapshot.feesChargedCt, "fees_charged_ct"),
              fees: {
                onDeposit: snapshot.feeRateDeposit,
                onSavings: snapshot.feeRateSavings,
                fundAverageOnDeposit: snapshot.fundAvgFeeDeposit,
                fundAverageOnSavings: snapshot.fundAvgFeeSavings,
                aboveAverage: [
                  ...above("deposits", snapshot.feeRateDeposit, snapshot.fundAvgFeeDeposit),
                  ...above("savings", snapshot.feeRateSavings, snapshot.fundAvgFeeSavings),
                ],
              },
              deposits: depositRows
                .filter((row) => row.snapshotId === snapshot.id)
                .map((row): LongTermSavingsDepositRow => {
                  const cell = (ct: Uint8Array, column: string): Money => ({
                    amount: decText(dataKey, ct, row.id, column, row.version) ?? "0",
                    currency: snapshot.currency,
                  });
                  return {
                    rowIndex: row.rowIndex,
                    employer: row.employerCt
                      ? decText(dataKey, row.employerCt, row.id, "employer_ct", row.version)
                      : null,
                    depositDate: row.depositDate,
                    forMonth: row.forMonth,
                    salary: row.salaryCt ? cell(row.salaryCt, "salary_ct") : null,
                    employee: cell(row.employeeCt, "employee_ct"),
                    employerContribution: cell(
                      row.employerContributionCt,
                      "employer_contribution_ct",
                    ),
                    severance: cell(row.severanceCt, "severance_ct"),
                    total: cell(row.totalCt, "total_ct"),
                  };
                }),
              tracks: trackRows
                .filter((row) => row.snapshotId === snapshot.id)
                .map((row): LongTermSavingsTrackRow => ({
                  rowIndex: row.rowIndex,
                  name: decText(dataKey, row.nameCt, row.id, "name_ct", row.version) ?? "",
                  returnPercent: row.returnPct,
                  annualCostPercent: row.annualCostPct,
                })),
            },
      };
    });
  });
}
