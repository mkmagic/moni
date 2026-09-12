import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { encText } from "@/domain/fields";
import { BROKER_ELSE_USER_POLICY_VERSION } from "@/domain/investment-lots";
import { reconcileInvestmentActivity } from "@/domain/investment-valuation";
import { decryptField, getDevUserDataKey } from "@/lib/crypto";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

describe("investment activity reconciliation", () => {
  let userId: string;
  let accountId: string;
  let snapshotId: string;
  let gapInstrumentId: string;

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `investment-reconciliation-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    userId = user.id;
    const [connection] = await elevatedDb
      .insert(schema.connections)
      .values({
        ownerId: userId,
        connectorId: "ibkr_flex",
        credentialsCt: Buffer.from("test-only"),
        status: "active",
      })
      .returning({ id: schema.connections.id });
    const [run] = await elevatedDb
      .insert(schema.syncRuns)
      .values({ ownerId: userId, connectionId: connection.id, status: "succeeded" })
      .returning({ id: schema.syncRuns.id });
    const dataKey = getDevUserDataKey(userId);
    try {
      accountId = randomUUID();
      await elevatedDb.insert(schema.accounts).values({
        id: accountId,
        ownerId: userId,
        connectionId: connection.id,
        accountType: "investment",
        classification: "asset",
        nameCt: encText(dataKey, "Reconciliation account", accountId, "name_ct", 1),
        currency: "USD",
      });
      const instruments = await elevatedDb
        .insert(schema.instruments)
        .values([
          { ownerId: userId, kind: "etf" },
          { ownerId: userId, kind: "stock" },
        ])
        .returning({ id: schema.instruments.id });
      gapInstrumentId = instruments[0].id;
      const matchedInstrumentId = instruments[1].id;
      const balanceSnapshotId = randomUUID();
      snapshotId = randomUUID();
      await elevatedDb.transaction(async (tx) => {
        await tx.insert(schema.accountBalanceSnapshots).values({
          id: balanceSnapshotId,
          ownerId: userId,
          accountId,
          date: "2026-09-12",
          source: "investment",
        });
        await tx.insert(schema.investmentSnapshotDetails).values({
          id: snapshotId,
          ownerId: userId,
          accountBalanceSnapshotId: balanceSnapshotId,
          accountId,
          connectionId: connection.id,
          syncRunId: run.id,
          weekStart: "2026-09-06",
          source: "ibkr_flex",
          sourceAsOf: new Date("2026-09-12T12:00:00Z"),
          sourceAsOfPrecision: "timestamp",
          brokerTotalCt: encText(dataKey, "1000", snapshotId, "broker_total_ct", 1),
          brokerTotalCurrency: "USD",
          reconciliationState: "matched",
          validationVersion: 1,
        });
      });
      for (const [instrumentId, quantity] of [
        [gapInstrumentId, "100"],
        [matchedInstrumentId, "5"],
      ] as const) {
        const id = randomUUID();
        await elevatedDb.insert(schema.investmentSnapshotPositions).values({
          id,
          ownerId: userId,
          snapshotId,
          instrumentId,
          quantityCt: encText(dataKey, quantity, id, "quantity_ct", 1),
          quantityUnit: "shares",
          currency: "USD",
          sourceValueCt: encText(dataKey, "1", id, "source_value_ct", 1),
          sourceValueCurrency: "USD",
          brokerValuationBasis: "market_value",
        });
        const openingLotId = randomUUID();
        await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
          id: openingLotId,
          ownerId: userId,
          accountId,
          instrumentId,
          idempotencyKey: Buffer.from(`opening-${instrumentId}`),
          tradeDate: "2020-01-01",
          originalQuantityCt: encText(dataKey, quantity, openingLotId, "original_quantity_ct", 1),
          remainingQuantityCt: encText(
            dataKey,
            instrumentId === gapInstrumentId ? "60" : quantity,
            openingLotId,
            "remaining_quantity_ct",
            1,
          ),
          quantityUnit: "shares",
          totalCostCt: encText(dataKey, "1", openingLotId, "total_cost_ct", 1),
          currency: "USD",
          lockedFxProvenance: "unresolved",
          provenance: "user_entered",
        });
        const lotId = randomUUID();
        await elevatedDb.insert(schema.investmentTaxLots).values({
          id: lotId,
          ownerId: userId,
          accountId,
          instrumentId,
          openingLotEvidenceId: openingLotId,
          derivationKey: Buffer.from(`lot-${instrumentId}`),
          policyVersion: BROKER_ELSE_USER_POLICY_VERSION,
          tradeDate: "2020-01-01",
          originalQuantityCt: encText(dataKey, quantity, lotId, "original_quantity_ct", 1),
          remainingQuantityCt: encText(
            dataKey,
            instrumentId === gapInstrumentId ? "60" : quantity,
            lotId,
            "remaining_quantity_ct",
            1,
          ),
          quantityUnit: "shares",
          costBasisCt: encText(dataKey, "1", lotId, "cost_basis_ct", 1),
          costBasisCurrency: "USD",
          lockedFxProvenance: "unresolved",
          completeness: "complete",
        });
      }
      await elevatedDb.insert(schema.investmentActivityCoverage).values({
        ownerId: userId,
        accountId,
        instrumentId: gapInstrumentId,
        source: "ibkr_flex",
        metric: "cost_basis",
        completeness: "complete",
      });
    } finally {
      dataKey.fill(0);
    }
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  async function reconcile() {
    const dataKey = getDevUserDataKey(userId);
    try {
      return await reconcileInvestmentActivity({ userId, accountId, snapshotId, dataKey });
    } finally {
      dataKey.fill(0);
    }
  }

  it("records a gap without changing the authoritative snapshot or inventing a lot", async () => {
    await expect(reconcile()).resolves.toMatchObject({
      snapshotId,
      affectedInstrumentIds: [gapInstrumentId],
    });
    const stored = await withUser(userId, async (tx) => ({
      allQuality: await tx.select().from(schema.investmentReconciliationQuality),
      quality: await tx
        .select()
        .from(schema.investmentReconciliationQuality)
        .where(eq(schema.investmentReconciliationQuality.dimension, "position_quantity")),
      coverage: await tx
        .select()
        .from(schema.investmentActivityCoverage)
        .where(
          and(
            eq(schema.investmentActivityCoverage.instrumentId, gapInstrumentId),
            eq(schema.investmentActivityCoverage.metric, "cost_basis"),
          ),
        ),
      queue: await tx
        .select()
        .from(schema.investmentDisposalResolutionQueue)
        .where(eq(schema.investmentDisposalResolutionQueue.kind, "reconciliation_gap")),
      lots: await tx.select().from(schema.investmentTaxLots),
      positions: await tx.select().from(schema.investmentSnapshotPositions),
    }));
    expect(stored.quality).toHaveLength(1);
    const dataKey = getDevUserDataKey(userId);
    try {
      expect(
        decryptField(dataKey, stored.quality[0].expectedValueCt!, {
          rowId: stored.quality[0].id,
          column: "expected_value_ct",
          version: stored.quality[0].version,
        }).toString("utf8"),
      ).toBe("100");
      expect(
        decryptField(dataKey, stored.quality[0].observedValueCt!, {
          rowId: stored.quality[0].id,
          column: "observed_value_ct",
          version: stored.quality[0].version,
        }).toString("utf8"),
      ).toBe("60");
    } finally {
      dataKey.fill(0);
    }
    expect(stored.coverage[0].completeness).toBe("partial");
    expect(stored.queue).toHaveLength(1);
    expect(stored.lots).toHaveLength(2);
    expect(stored.positions).toHaveLength(2);

    await reconcile();
    const replay = await withUser(userId, async (tx) => ({
      quality: await tx.select().from(schema.investmentReconciliationQuality),
      queue: await tx
        .select()
        .from(schema.investmentDisposalResolutionQueue)
        .where(eq(schema.investmentDisposalResolutionQueue.kind, "reconciliation_gap")),
    }));
    expect(replay.quality).toEqual(stored.allQuality);
    expect(replay.queue).toEqual(stored.queue);
  });
});
