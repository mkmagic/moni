/**
 * Promotion for an imported long-term-savings report: maps a parsed document
 * into a dated snapshot, its balance-snapshot row, and its detail rows.
 *
 * The parser produces a raw shape faithful to the page; this is where it
 * becomes domain data — the same boundary `scraper-output.schema.ts` →
 * `sync-promotion.ts` draws for scrapes.
 *
 * A report import writes a snapshot and nothing else. No `entries`: the deposit
 * table looks like a transaction feed but is not one (D3).
 */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { withUser, type UserTransaction as Tx } from "@/db/client";
import {
  accountBalanceSnapshots,
  accounts,
  longTermSavingsDetails,
  longTermSavingsSnapshotDeposits,
  longTermSavingsSnapshotTracks,
  longTermSavingsLiquidityEnum,
  longTermSavingsSnapshots,
  syncRuns,
} from "@/db/schema";
import type { LongTermSavingsProduct } from "@/lib/connectors";
import {
  checkHarelPensionReport,
  type HarelPensionQuarterlyReport,
} from "@/lib/connectors/documents/harel/pension-quarterly";
import { errorLabel, syncLog } from "@/lib/sync-log";
import { decText, encText } from "./fields";
import { markSyncRunFailed } from "./sync-promotion";

/**
 * Tolerance on the balance equation, in shekels.
 *
 * The equation has seven shekel-rounded terms, so the theoretical bound is
 * ±3.5 — but a real Q3 report drifts ₪11, so the printed figures are rounded
 * from more than they show. ₪50 is deliberate headroom for that and for
 * document quirks not yet seen. The consequence to accept: a small term dropped
 * entirely could hide under it, which is why the actual drift is recorded on
 * every successful import (D9) so this number can be tuned against real data.
 */
export const BALANCE_TOLERANCE = new Decimal(50);

export type LongTermSavingsPromotionErrorCode =
  "invalid_sync" | "balance_check_failed" | "account_type_mismatch" | "promotion_failed";

export class LongTermSavingsPromotionError extends Error {
  constructor(
    readonly code: LongTermSavingsPromotionErrorCode,
    /**
     * Appended to `sync_runs.error`, which is a plaintext `text` column.
     *
     * Check NAMES only. §D9 asked for full check detail here, but that detail
     * quotes the figures it compared — and the drift is itself a difference of
     * amounts, which is why `balance_drift_ct` is encrypted. Putting the same
     * number in plaintext would contradict that, so the Tier-1 rule wins over
     * the diagnostic. On a successful import the drift is recoverable from
     * `balance_drift_ct`; on a failed one nothing is written at all, and the
     * user is told which check failed rather than by how much.
     */
    readonly detail?: string,
  ) {
    super(code);
    this.name = "LongTermSavingsPromotionError";
  }
}

export interface LongTermSavingsPromotionResult {
  accountId: string;
  snapshotId: string;
  asOf: string;
  /** True when this became the account's cached current balance. */
  isLatest: boolean;
  depositRows: number;
  trackRows: number;
  balanceDrift: string;
}

export interface LongTermSavingsPromotionInput {
  userId: string;
  connectionId: string;
  syncRunId: string;
  dataKey: Uint8Array;
  parserId: string;
  parserVersion: number;
  product: LongTermSavingsProduct;
  /** Shown to the user as the account name until they rename it. */
  accountLabel: string;
  report: HarelPensionQuarterlyReport;
}

/** Reports are denominated in shekels; there is no currency on the page. */
const CURRENCY = "ILS";

/**
 * When each product's money becomes reachable.
 *
 * Exhaustive over `LongTermSavingsProduct` on purpose: liquidity varies
 * *within* a product name — קופת גמל להשקעה is liquid today while קופת גמל
 * לתגמולים is locked to retirement (D1) — so adding a product must be a
 * decision someone makes, not something it inherits from whichever parser
 * happened to land first.
 */
const LIQUIDITY_BY_PRODUCT: Record<
  LongTermSavingsProduct,
  (typeof longTermSavingsLiquidityEnum.enumValues)[number]
> = {
  pension: "locked_retirement",
  hishtalmut: "liquid_after",
  gemel: "locked_retirement",
  gemel_investment: "liquid",
  managers_insurance: "locked_retirement",
};

function fail(code: LongTermSavingsPromotionErrorCode, detail?: string): never {
  throw new LongTermSavingsPromotionError(code, detail);
}

/**
 * One connection is one account (D4). The document carries no policy or account
 * number — only a fund name, member name and ת.ז. — so there is nothing to
 * match on, and the connection itself is the account's identity.
 */
async function resolveAccount(
  tx: Tx,
  input: LongTermSavingsPromotionInput,
): Promise<{ accountId: string; version: number }> {
  const existing = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.connectionId, input.connectionId));
  if (existing.length > 1) fail("invalid_sync");
  if (existing.length === 1) {
    const row = existing[0];
    // A connection that already owns some other kind of account means the user
    // is pointing this import at the wrong connection. Refuse rather than
    // quietly writing a pension balance over a brokerage account.
    if (row.accountType !== "long_term_savings" || row.currency !== CURRENCY)
      fail("account_type_mismatch");
    return { accountId: row.id, version: row.version };
  }

  const id = randomUUID();
  await tx.insert(accounts).values({
    id,
    ownerId: input.userId,
    accountType: "long_term_savings",
    // Always an asset; liquidity governs presentation, never whether the
    // balance counts (D2).
    classification: "asset",
    connectionId: input.connectionId,
    nameCt: encText(input.dataKey, input.accountLabel, id, "name_ct", 1),
    institution: input.report.fundName,
    currency: CURRENCY,
    status: "active",
  });
  await tx.insert(longTermSavingsDetails).values({
    accountId: id,
    ownerId: input.userId,
    product: input.product,
    liquidity: LIQUIDITY_BY_PRODUCT[input.product],
  });
  return { accountId: id, version: 1 };
}

async function promote(
  tx: Tx,
  input: LongTermSavingsPromotionInput,
): Promise<LongTermSavingsPromotionResult> {
  const { userId, dataKey, report } = input;

  const run = await tx
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.id, input.syncRunId), eq(syncRuns.status, "running")));
  if (run.length !== 1 || run[0].connectionId !== input.connectionId) fail("invalid_sync");

  // The only gating check. Everything else is recorded, never blocking: those
  // guard drill-down detail, and are exactly where shekel rounding produces
  // harmless drift (D9).
  const { balanceDrift, checks } = checkHarelPensionReport(report);
  if (new Decimal(balanceDrift).gt(BALANCE_TOLERANCE))
    fail("balance_check_failed", "balance_equation");

  const { accountId, version: accountVersion } = await resolveAccount(tx, input);
  const asOf = report.reportDate;

  // Re-importing the same report date replaces that snapshot in place, so the
  // import is idempotent (D5). Deleting the balance snapshot cascades to the
  // report snapshot, which cascades to its deposit and track rows.
  const superseded = await tx
    .select({ id: longTermSavingsSnapshots.accountBalanceSnapshotId })
    .from(longTermSavingsSnapshots)
    .where(
      and(
        eq(longTermSavingsSnapshots.accountId, accountId),
        eq(longTermSavingsSnapshots.asOf, asOf),
      ),
    );
  for (const row of superseded)
    await tx.delete(accountBalanceSnapshots).where(eq(accountBalanceSnapshots.id, row.id));

  const balanceSnapshotId = randomUUID();
  await tx.insert(accountBalanceSnapshots).values({
    id: balanceSnapshotId,
    ownerId: userId,
    accountId,
    date: asOf,
    nativeBalanceCt: encText(
      dataKey,
      report.movements.closingBalance,
      balanceSnapshotId,
      "native_balance_ct",
      1,
    ),
    currency: CURRENCY,
    source: "long_term_savings",
  });

  const snapshotId = randomUUID();
  const money = (value: string, column: string) => encText(dataKey, value, snapshotId, column, 1);
  const optionalMoney = (value: string | null, column: string) =>
    value === null ? null : money(value, column);
  const m = report.movements;
  const p = report.expectedPayments;
  const totals = report.deposits.totals;

  await tx.insert(longTermSavingsSnapshots).values({
    id: snapshotId,
    ownerId: userId,
    accountBalanceSnapshotId: balanceSnapshotId,
    accountId,
    connectionId: input.connectionId,
    syncRunId: input.syncRunId,
    asOf,
    statedPeriodStart: report.statedPeriodStart,
    statedPeriodEnd: report.statedPeriodEnd,
    quarter: report.quarter,
    fiscalYear: report.year,
    currency: CURRENCY,
    closingBalanceCt: money(m.closingBalance, "closing_balance_ct"),
    openingBalanceCt: money(m.openingBalance, "opening_balance_ct"),
    contributionsCt: money(m.contributions, "contributions_ct"),
    investmentResultCt: money(m.investmentResult, "investment_result_ct"),
    feesChargedCt: money(m.managementFeesCharged, "fees_charged_ct"),
    insuranceDisabilityCt: money(m.disabilityInsuranceCost, "insurance_disability_ct"),
    insuranceDeathCt: money(m.deathInsuranceCost, "insurance_death_ct"),
    feeRateDeposit: report.managementFees.onDeposit,
    feeRateSavings: report.managementFees.onSavings,
    fundAvgFeeDeposit: report.managementFees.fundAverageOnDeposit,
    fundAvgFeeSavings: report.managementFees.fundAverageOnSavings,
    projectionRetirementAge: p.retirementAge,
    projectionMonthlyPensionCt: optionalMoney(
      p.monthlyPensionAtRetirement,
      "projection_monthly_pension_ct",
    ),
    projectionSurvivorPensionCt: optionalMoney(
      p.monthlySurvivorPension,
      "projection_survivor_pension_ct",
    ),
    projectionOrphanPensionCt: optionalMoney(
      p.monthlyOrphanPension,
      "projection_orphan_pension_ct",
    ),
    projectionDependentParentPensionCt: optionalMoney(
      p.monthlyDependentParentPension,
      "projection_dependent_parent_pension_ct",
    ),
    projectionDisabilityPensionCt: optionalMoney(
      p.monthlyFullDisabilityPension,
      "projection_disability_pension_ct",
    ),
    projectionContributionWaiverCt: optionalMoney(
      p.contributionWaiverOnDisability,
      "projection_contribution_waiver_ct",
    ),
    depositsTotalEmployeeCt: optionalMoney(
      totals?.employeeContribution ?? null,
      "deposits_total_employee_ct",
    ),
    depositsTotalEmployerCt: optionalMoney(
      totals?.employerContribution ?? null,
      "deposits_total_employer_ct",
    ),
    depositsTotalSeveranceCt: optionalMoney(
      totals?.severance ?? null,
      "deposits_total_severance_ct",
    ),
    depositsTotalCt: optionalMoney(totals?.total ?? null, "deposits_total_ct"),
    balanceDriftCt: money(balanceDrift, "balance_drift_ct"),
    checkResultsCt: money(JSON.stringify(checks), "check_results_ct"),
    parserId: input.parserId,
    parserVersion: input.parserVersion,
  });

  for (const [index, row] of report.deposits.rows.entries()) {
    const id = randomUUID();
    const cell = (value: string, column: string) => encText(dataKey, value, id, column, 1);
    await tx.insert(longTermSavingsSnapshotDeposits).values({
      id,
      ownerId: userId,
      snapshotId,
      rowIndex: index,
      employerCt: row.employer ? cell(row.employer, "employer_ct") : null,
      depositDate: row.depositDate,
      forMonth: row.forMonth,
      salaryCt: row.salary === null ? null : cell(row.salary, "salary_ct"),
      employeeCt: cell(row.employeeContribution, "employee_ct"),
      employerContributionCt: cell(row.employerContribution, "employer_contribution_ct"),
      severanceCt: cell(row.severance, "severance_ct"),
      totalCt: cell(row.total, "total_ct"),
    });
  }

  for (const [index, track] of report.investmentTracks.entries()) {
    const id = randomUUID();
    await tx.insert(longTermSavingsSnapshotTracks).values({
      id,
      ownerId: userId,
      snapshotId,
      rowIndex: index,
      nameCt: encText(dataKey, track.name, id, "name_ct", 1),
      returnPct: track.returnPercent,
      annualCostPct: track.expectedAnnualCostPercent,
    });
  }

  // The cached balance moves only when this is the newest report held for the
  // account, so backfilling an older one adds history without disturbing net
  // worth (D5).
  const held = await tx
    .select({ asOf: longTermSavingsSnapshots.asOf })
    .from(longTermSavingsSnapshots)
    .where(eq(longTermSavingsSnapshots.accountId, accountId));
  const isLatest = held.every((row) => row.asOf <= asOf);
  if (isLatest) {
    const version = accountVersion + 1;
    const [row] = await tx
      .select({ nameCt: accounts.nameCt })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    await tx
      .update(accounts)
      .set({
        currentBalanceCt: encText(
          dataKey,
          m.closingBalance,
          accountId,
          "current_balance_ct",
          version,
        ),
        // Carried across unchanged in value, but re-encrypted because the
        // version bump moved the AAD — leaving it behind would make the name
        // stop decrypting.
        nameCt: encText(
          dataKey,
          decText(dataKey, row.nameCt, accountId, "name_ct", accountVersion)!,
          accountId,
          "name_ct",
          version,
        ),
        version,
      })
      .where(eq(accounts.id, accountId));
  }

  const transitioned = await tx
    .update(syncRuns)
    .set({ status: "succeeded", windowEnd: new Date(), promotedAccountCount: 1 })
    .where(and(eq(syncRuns.id, input.syncRunId), eq(syncRuns.status, "running")))
    .returning({ id: syncRuns.id });
  if (transitioned.length !== 1) fail("invalid_sync");

  return {
    accountId,
    snapshotId,
    asOf,
    isLatest,
    depositRows: report.deposits.rows.length,
    trackRows: report.investmentTracks.length,
    balanceDrift,
  };
}

export async function promoteLongTermSavingsSnapshot(
  input: LongTermSavingsPromotionInput,
): Promise<LongTermSavingsPromotionResult> {
  try {
    return await withUser(input.userId, (tx) => promote(tx, input));
  } catch (error) {
    const promotion = error instanceof LongTermSavingsPromotionError;
    syncLog("promotion.failed", {
      source: input.parserId,
      code: promotion ? error.code : "promotion_failed",
      error: promotion ? undefined : errorLabel(error),
    });
    const code = promotion ? error.code : "promotion_failed";
    const detail = promotion && error.detail ? `${code}: ${error.detail}` : code;
    // The whole write is one transaction, so a failure has already rolled back
    // — nothing partial survives, per the atomic-failure contract.
    await markSyncRunFailed(input.userId, input.syncRunId, detail);
    throw promotion ? error : new LongTermSavingsPromotionError("promotion_failed");
  }
}
