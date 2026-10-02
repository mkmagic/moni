import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { encText } from "@/domain/fields";
import {
  readInvestmentDividendIncome,
  readInvestmentRealizedGain,
  readInvestmentUnrealizedGain,
} from "@/domain/investment-returns";
import { getDevUserDataKey } from "@/lib/crypto";
import { cleanupFxRates, cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

describe("investment gain and income reads", () => {
  let userId: string;
  let accountId: string;
  let instrumentId: string;
  const fxRateIds: string[] = [];

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `investment-returns-${randomUUID()}@test.moni` })
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
        nameCt: encText(dataKey, "Returns account", accountId, "name_ct", 1),
        currency: "XZZ",
      });
      const [instrument] = await elevatedDb
        .insert(schema.instruments)
        .values({ ownerId: userId, kind: "etf" })
        .returning({ id: schema.instruments.id });
      instrumentId = instrument.id;

      const openingId = randomUUID();
      await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
        id: openingId,
        ownerId: userId,
        accountId,
        instrumentId,
        idempotencyKey: Buffer.from("returns-opening"),
        tradeDate: "2025-01-01",
        originalQuantityCt: encText(dataKey, "10", openingId, "original_quantity_ct", 1),
        remainingQuantityCt: encText(dataKey, "5", openingId, "remaining_quantity_ct", 1),
        quantityUnit: "shares",
        totalCostCt: encText(dataKey, "100", openingId, "total_cost_ct", 1),
        currency: "XZZ",
        lockedFxRateCt: encText(dataKey, "3", openingId, "locked_fx_rate_ct", 1),
        lockedFxConvention: "ILS_PER_XZZ",
        lockedFxObservationDate: "2025-01-01",
        lockedFxProvenance: "user_entered",
        provenance: "user_entered",
      });
      const lotId = randomUUID();
      await elevatedDb.insert(schema.investmentTaxLots).values({
        id: lotId,
        ownerId: userId,
        accountId,
        instrumentId,
        openingLotEvidenceId: openingId,
        derivationKey: Buffer.from("returns-lot"),
        policyVersion: "broker-else-user-v1",
        tradeDate: "2025-01-01",
        originalQuantityCt: encText(dataKey, "10", lotId, "original_quantity_ct", 1),
        remainingQuantityCt: encText(dataKey, "5", lotId, "remaining_quantity_ct", 1),
        quantityUnit: "shares",
        costBasisCt: encText(dataKey, "100", lotId, "cost_basis_ct", 1),
        costBasisCurrency: "XZZ",
        lockedFxRateCt: encText(dataKey, "3", lotId, "locked_fx_rate_ct", 1),
        lockedFxConvention: "ILS_PER_XZZ",
        lockedFxObservationDate: "2025-01-01",
        lockedFxProvenance: "user_entered",
        completeness: "partial",
      });
      const saleId = randomUUID();
      await elevatedDb.insert(schema.investmentActivityEvidence).values({
        id: saleId,
        ownerId: userId,
        connectionId: connection.id,
        syncRunId: run.id,
        accountId,
        instrumentId,
        source: "ibkr_flex",
        activityType: "sell",
        idempotencyKey: Buffer.from("returns-sale"),
        tradeDate: "2025-06-01",
        quantityCt: encText(dataKey, "-5", saleId, "quantity_ct", 1),
        quantityUnit: "shares",
        grossAmountCt: encText(dataKey, "60", saleId, "gross_amount_ct", 1),
        netCashAmountCt: encText(dataKey, "60", saleId, "net_cash_amount_ct", 1),
        currency: "XZZ",
        rawTypeCt: encText(dataKey, "Trade", saleId, "raw_type_ct", 1),
        provenance: "broker_reported",
      });
      const closureId = randomUUID();
      await elevatedDb.insert(schema.investmentLotClosures).values({
        id: closureId,
        ownerId: userId,
        sellActivityEvidenceId: saleId,
        closedTaxLotId: lotId,
        closedQuantityCt: encText(dataKey, "5", closureId, "closed_quantity_ct", 1),
        proceedsCt: encText(dataKey, "60", closureId, "proceeds_ct", 1),
        realizedCostBasisCt: encText(dataKey, "50", closureId, "realized_cost_basis_ct", 1),
        lockedFxRateCt: encText(dataKey, "4", closureId, "locked_fx_rate_ct", 1),
        lockedFxConvention: "ILS_PER_XZZ",
        lockedFxObservationDate: "2025-06-01",
        lockedFxProvenance: "boi_derived",
        allocationProvenance: "broker_reported",
      });
      const dividendId = randomUUID();
      await elevatedDb.insert(schema.investmentActivityEvidence).values({
        id: dividendId,
        ownerId: userId,
        connectionId: connection.id,
        syncRunId: run.id,
        accountId,
        instrumentId,
        source: "ibkr_flex",
        activityType: "dividend",
        idempotencyKey: Buffer.from("returns-dividend"),
        tradeDate: "2025-06-01",
        grossAmountCt: encText(dataKey, "10", dividendId, "gross_amount_ct", 1),
        netCashAmountCt: encText(dataKey, "10", dividendId, "net_cash_amount_ct", 1),
        currency: "XZZ",
        rawTypeCt: encText(dataKey, "Dividends", dividendId, "raw_type_ct", 1),
        provenance: "broker_reported",
      });

      const balanceSnapshotId = randomUUID();
      const snapshotId = randomUUID();
      await elevatedDb.transaction(async (tx) => {
        await tx.insert(schema.accountBalanceSnapshots).values({
          id: balanceSnapshotId,
          ownerId: userId,
          accountId,
          date: "2026-01-01",
          source: "investment",
        });
        await tx.insert(schema.investmentSnapshotDetails).values({
          id: snapshotId,
          ownerId: userId,
          accountBalanceSnapshotId: balanceSnapshotId,
          accountId,
          connectionId: connection.id,
          syncRunId: run.id,
          weekStart: "2025-12-28",
          source: "ibkr_flex",
          sourceAsOf: new Date("2026-01-01T12:00:00Z"),
          sourceAsOfPrecision: "timestamp",
          brokerTotalCt: encText(dataKey, "165", snapshotId, "broker_total_ct", 1),
          brokerTotalCurrency: "XZZ",
          reconciliationState: "matched",
          validationVersion: 1,
        });
        const positionId = randomUUID();
        await tx.insert(schema.investmentSnapshotPositions).values({
          id: positionId,
          ownerId: userId,
          snapshotId,
          instrumentId,
          quantityCt: encText(dataKey, "5", positionId, "quantity_ct", 1),
          quantityUnit: "shares",
          currency: "XZZ",
          sourceValueCt: encText(dataKey, "165", positionId, "source_value_ct", 1),
          sourceValueCurrency: "XZZ",
          sourceAsOf: new Date("2026-01-01T12:00:00Z"),
          brokerValuationBasis: "market_value",
        });
      });
      for (const metric of ["cost_basis", "dividends"] as const) {
        await elevatedDb.insert(schema.investmentActivityCoverage).values({
          ownerId: userId,
          accountId,
          instrumentId,
          source: "ibkr_flex",
          metric,
          coverageStart: "2025-01-01",
          coverageBasis: "provider_declared",
          completeness: metric === "cost_basis" ? "partial" : "complete",
        });
      }
    } finally {
      dataKey.fill(0);
    }
    for (const [date, rate] of [
      ["2025-06-01", "4"],
      ["2026-01-01", "5"],
    ] as const) {
      const [row] = await elevatedDb
        .insert(schema.fxRates)
        .values({ fromCurrency: "XZZ", toCurrency: "ILS", date, rate, source: "boi" })
        .returning({ id: schema.fxRates.id });
      fxRateIds.push(row.id);
    }
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await cleanupFxRates(fxRateIds);
    await elevatedPool.end();
  });

  function input() {
    return {
      userId,
      accountId,
      instrumentId,
      now: new Date("2026-01-01T18:00:00Z"),
      dataKey: getDevUserDataKey(userId),
    };
  }

  it("folds locked acquisition and sale FX into realized ILS gain", async () => {
    const held = input();
    try {
      await expect(readInvestmentRealizedGain(held)).resolves.toMatchObject({
        ils: { amount: "90", currency: "ILS", basis: "ils_gain_includes_fx" },
        native: [{ amount: "10", currency: "XZZ", basis: "native_price_gain" }],
        closureCount: 1,
        quality: { completeness: "partial" },
      });
    } finally {
      held.dataKey.fill(0);
    }
  });

  it("uses locked basis and current BoI FX for unrealized gain", async () => {
    const held = input();
    try {
      await expect(readInvestmentUnrealizedGain(held)).resolves.toMatchObject({
        ils: { amount: "675", currency: "ILS", basis: "ils_gain_includes_fx" },
        native: [{ amount: "115", currency: "XZZ", basis: "native_price_gain" }],
        quality: { completeness: "partial", fxAsOf: "2026-01-01" },
      });
    } finally {
      held.dataKey.fill(0);
    }
  });

  it("counts only the booked dividend cash row", async () => {
    const held = input();
    try {
      await expect(readInvestmentDividendIncome(held)).resolves.toMatchObject({
        ils: { amount: "40", currency: "ILS", basis: "booked_cash_income" },
        native: [{ amount: "10", currency: "XZZ", basis: "booked_cash_income" }],
        bookedCashCount: 1,
        quality: { completeness: "complete" },
      });
    } finally {
      held.dataKey.fill(0);
    }
  });
});
