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
  longTermSavingsDetails,
  longTermSavingsSnapshotDeposits,
  longTermSavingsSnapshotTracks,
  longTermSavingsSnapshots,
} from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import type { Money } from "@/lib/money";
import { decText } from "./fields";

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

export interface LongTermSavingsSnapshotView {
  id: string;
  asOf: string;
  statedPeriodStart: string;
  statedPeriodEnd: string;
  quarter: number | null;
  fiscalYear: number | null;
  /**
   * The report's stated retirement age, so a locked badge can say "until 67"
   * rather than "until retirement". This is the only part of the projection
   * block that surfaces — the projected pension amounts stay stored and unshown
   * (#76 D8), since they assume no further contributions and read as a forecast
   * that is wrong by an order of magnitude.
   */
  retirementAge: number | null;
  closingBalance: Money;
  openingBalance: Money;
  /** Everything paid in over the stated period. */
  contributions: Money;
  /** Signed: gains in a good period, losses in a bad one. */
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
  product: LongTermSavingsProductName;
  liquidity: LongTermSavingsLiquidity;
  liquidFrom: string | null;
  /** Null until the first report has been imported for this account. */
  latest: LongTermSavingsSnapshotView | null;
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

    const snapshots = await tx
      .select()
      .from(longTermSavingsSnapshots)
      .orderBy(desc(longTermSavingsSnapshots.asOf));
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
      const snapshot = newest.get(account.id);
      const money = (ct: Uint8Array, column: string): Money => ({
        amount: decText(dataKey, ct, snapshot!.id, column, snapshot!.version) ?? "0",
        currency: snapshot!.currency,
      });
      return {
        accountId: account.id,
        name: decText(dataKey, account.nameCt, account.id, "name_ct", account.version) ?? "",
        institution: account.institution,
        connectionId: account.connectionId,
        product: detail.product,
        liquidity: detail.liquidity,
        liquidFrom: detail.liquidFrom,
        latest: !snapshot
          ? null
          : {
              id: snapshot.id,
              asOf: snapshot.asOf,
              statedPeriodStart: snapshot.statedPeriodStart,
              statedPeriodEnd: snapshot.statedPeriodEnd,
              quarter: snapshot.quarter,
              fiscalYear: snapshot.fiscalYear,
              retirementAge: snapshot.projectionRetirementAge,
              closingBalance: money(snapshot.closingBalanceCt, "closing_balance_ct"),
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
