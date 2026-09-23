import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { withUser } from "@/db/client";
import {
  accounts,
  investmentActivityEvidence,
  investmentOpeningLotEvidence,
  investmentTaxLots,
} from "@/db/schema";
import type { IbkrFlexActivityEvidenceSet } from "@/lib/investments";
import {
  ingestInvestmentActivityEvidence,
  type InvestmentActivityIngestionResult,
} from "./investment-activity";
import { deriveInvestmentTaxLots } from "./investment-lots";
import { reconcileInvestmentActivity } from "./investment-valuation";

/**
 * Persists parsed IBKR Flex activity evidence for a still-running sync. Skips
 * silently (returns null) when the connection has no investment account yet:
 * the account is created by snapshot promotion, so a connection's very first
 * sync has nothing for activity to attach to. IBKR Flex re-serves an
 * overlapping window each run, so the next sync ingests it once the account
 * exists. Must run BEFORE snapshot promotion, which transitions the run to
 * `succeeded`; activity ingestion requires the run to be `running`.
 */
export async function ingestIbkrFlexActivity(input: {
  userId: string;
  connectionId: string;
  syncRunId: string;
  /** Tier-1 data key. The caller owns its lifetime and wiping. */
  dataKey: Uint8Array;
  evidence: IbkrFlexActivityEvidenceSet;
}): Promise<InvestmentActivityIngestionResult | null> {
  const hasAccount = await withUser(input.userId, async (tx) => {
    const rows = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.connectionId, input.connectionId), eq(accounts.accountType, "investment")),
      )
      .limit(1);
    return rows.length > 0;
  });
  if (!hasAccount) return null;
  return ingestInvestmentActivityEvidence({
    userId: input.userId,
    connectionId: input.connectionId,
    syncRunId: input.syncRunId,
    dataKey: input.dataKey,
    evidence: input.evidence,
  });
}

/**
 * Derives tax lots for every (account, instrument) the connection has activity
 * or opening-lot evidence for, then reconciles each account against its latest
 * snapshot. Must run AFTER snapshot promotion so reconciliation sees the fresh
 * snapshot. Idempotent: derivation upserts and reconciliation is recomputed.
 */
export async function deriveAndReconcileInvestmentActivity(input: {
  userId: string;
  connectionId: string;
  /** Tier-1 data key. The caller owns its lifetime and wiping. */
  dataKey: Uint8Array;
}): Promise<void> {
  const scopes = await withUser(input.userId, async (tx) => {
    const connectionAccounts = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.connectionId, input.connectionId));
    const accountIds = connectionAccounts.map((row) => row.id);
    if (accountIds.length === 0) return [] as Array<{ accountId: string; instrumentId: string }>;
    const activityScopes = await tx
      .select({
        accountId: investmentActivityEvidence.accountId,
        instrumentId: investmentActivityEvidence.instrumentId,
      })
      .from(investmentActivityEvidence)
      .where(
        and(
          eq(investmentActivityEvidence.connectionId, input.connectionId),
          isNotNull(investmentActivityEvidence.instrumentId),
        ),
      );
    const lotScopes = await tx
      .select({
        accountId: investmentOpeningLotEvidence.accountId,
        instrumentId: investmentOpeningLotEvidence.instrumentId,
      })
      .from(investmentOpeningLotEvidence)
      .where(inArray(investmentOpeningLotEvidence.accountId, accountIds));
    // Corrected activity can lose its former instrument (e.g. FX once treated
    // as shares). Replay those old scopes too, so obsolete derived lots go away.
    const derivedScopes = await tx
      .select({
        accountId: investmentTaxLots.accountId,
        instrumentId: investmentTaxLots.instrumentId,
      })
      .from(investmentTaxLots)
      .where(inArray(investmentTaxLots.accountId, accountIds));
    return [...activityScopes, ...lotScopes, ...derivedScopes].filter(
      (scope): scope is { accountId: string; instrumentId: string } => scope.instrumentId !== null,
    );
  });

  const uniqueScopes = [
    ...new Map(scopes.map((scope) => [`${scope.accountId}:${scope.instrumentId}`, scope])).values(),
  ];
  for (const scope of uniqueScopes) {
    await deriveInvestmentTaxLots({
      userId: input.userId,
      accountId: scope.accountId,
      instrumentId: scope.instrumentId,
      dataKey: input.dataKey,
    });
  }
  for (const accountId of new Set(uniqueScopes.map((scope) => scope.accountId))) {
    try {
      await reconcileInvestmentActivity({
        userId: input.userId,
        accountId,
        dataKey: input.dataKey,
      });
    } catch (error) {
      // A scope can have activity but no promoted snapshot yet; that is not a
      // reconciliation failure, only nothing to reconcile against.
      if (!(error instanceof Error) || error.message !== "investment snapshot not found")
        throw error;
    }
  }
}
