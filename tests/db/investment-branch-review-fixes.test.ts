import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { encText } from "@/domain/fields";
import { upsertBoiFxRate } from "@/domain/fx-rates";
import { deriveInvestmentTaxLots } from "@/domain/investment-lots";
import { readInvestmentUnrealizedGain } from "@/domain/investment-returns";
import { decryptField, getDevUserDataKey } from "@/lib/crypto";
import { cleanupFxRates, cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

describe("investment branch-review fixes", () => {
  let userId: string;
  let connectionId: string;
  let syncRunId: string;
  let accountId: string;
  // One instrument per scenario so their evidence and FX never cross-contaminate.
  let feeInstrumentId: string;
  let prorationInstrumentId: string;
  let coverageInstrumentId: string;
  let fxLockInstrumentId: string;
  const fxRateIds: string[] = [];

  const insertBuy = async (input: {
    dataKey: Uint8Array;
    instrumentId: string;
    executionId: string;
    date: string;
    quantity: string;
    price: string;
    gross: string;
    currency: string;
    fee?: string;
  }) => {
    const id = randomUUID();
    await elevatedDb.insert(schema.investmentActivityEvidence).values({
      id,
      ownerId: userId,
      connectionId,
      syncRunId,
      accountId,
      instrumentId: input.instrumentId,
      source: "ibkr_flex",
      activityType: "buy",
      providerExecutionIdCt: encText(
        input.dataKey,
        input.executionId,
        id,
        "provider_execution_id_ct",
        1,
      ),
      idempotencyKey: Buffer.from(input.executionId),
      tradeDate: input.date,
      quantityCt: encText(input.dataKey, input.quantity, id, "quantity_ct", 1),
      quantityUnit: "shares",
      priceCt: encText(input.dataKey, input.price, id, "price_ct", 1),
      grossAmountCt: encText(input.dataKey, input.gross, id, "gross_amount_ct", 1),
      feeAmountCt: input.fee ? encText(input.dataKey, input.fee, id, "fee_amount_ct", 1) : null,
      currency: input.currency,
      rawTypeCt: encText(input.dataKey, "Trade", id, "raw_type_ct", 1),
      provenance: "broker_reported",
    });
  };

  const insertSell = async (input: {
    dataKey: Uint8Array;
    instrumentId: string;
    executionId: string;
    date: string;
    quantity: string;
    gross: string;
    currency: string;
    allocations: Array<{ sourceLotId: string; quantity: string }>;
    fee?: string;
    tax?: string;
  }) => {
    const id = randomUUID();
    await elevatedDb.insert(schema.investmentActivityEvidence).values({
      id,
      ownerId: userId,
      connectionId,
      syncRunId,
      accountId,
      instrumentId: input.instrumentId,
      source: "ibkr_flex",
      activityType: "sell",
      brokerLotAllocationsCt: encText(
        input.dataKey,
        JSON.stringify(input.allocations),
        id,
        "broker_lot_allocations_ct",
        1,
      ),
      idempotencyKey: Buffer.from(input.executionId),
      tradeDate: input.date,
      quantityCt: encText(input.dataKey, input.quantity, id, "quantity_ct", 1),
      quantityUnit: "shares",
      grossAmountCt: encText(input.dataKey, input.gross, id, "gross_amount_ct", 1),
      feeAmountCt: input.fee ? encText(input.dataKey, input.fee, id, "fee_amount_ct", 1) : null,
      taxAmountCt: input.tax ? encText(input.dataKey, input.tax, id, "tax_amount_ct", 1) : null,
      currency: input.currency,
      rawTypeCt: encText(input.dataKey, "Trade", id, "raw_type_ct", 1),
      provenance: "broker_reported",
    });
  };

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `branch-review-${randomUUID()}@test.moni` })
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
    connectionId = connection.id;
    const [run] = await elevatedDb
      .insert(schema.syncRuns)
      .values({ ownerId: userId, connectionId, status: "succeeded" })
      .returning({ id: schema.syncRuns.id });
    syncRunId = run.id;

    const dataKey = getDevUserDataKey(userId);
    try {
      accountId = randomUUID();
      await elevatedDb.insert(schema.accounts).values({
        id: accountId,
        ownerId: userId,
        connectionId,
        accountType: "investment",
        classification: "asset",
        nameCt: encText(dataKey, "Branch review", accountId, "name_ct", 1),
        currency: "XAA",
      });
      const [fee, proration, coverage, fxLock] = await elevatedDb
        .insert(schema.instruments)
        .values([
          { ownerId: userId, kind: "stock" },
          { ownerId: userId, kind: "stock" },
          { ownerId: userId, kind: "stock" },
          { ownerId: userId, kind: "stock" },
        ])
        .returning({ id: schema.instruments.id });
      feeInstrumentId = fee.id;
      prorationInstrumentId = proration.id;
      coverageInstrumentId = coverage.id;
      fxLockInstrumentId = fxLock.id;

      // F1: buy 100 @ $10 + $1 fee, sell 100 @ $12 − $1 fee.
      await insertBuy({
        dataKey,
        instrumentId: feeInstrumentId,
        executionId: "F1-BUY",
        date: "2026-03-01",
        quantity: "100",
        price: "10",
        gross: "-1000",
        currency: "XAA",
        fee: "-1",
      });
      await insertSell({
        dataKey,
        instrumentId: feeInstrumentId,
        executionId: "F1-SELL",
        date: "2026-03-02",
        quantity: "-100",
        gross: "1200",
        currency: "XAA",
        fee: "-1",
        allocations: [{ sourceLotId: "F1-BUY", quantity: "100" }],
      });

      // F7: proceeds 1000 across three equal lots.
      for (const executionId of ["F7-A", "F7-B", "F7-C"]) {
        await insertBuy({
          dataKey,
          instrumentId: prorationInstrumentId,
          executionId,
          date: "2026-03-01",
          quantity: "1",
          price: "10",
          gross: "-10",
          currency: "XAB",
        });
      }
      await insertSell({
        dataKey,
        instrumentId: prorationInstrumentId,
        executionId: "F7-SELL",
        date: "2026-03-02",
        quantity: "-3",
        gross: "1000",
        currency: "XAB",
        allocations: [
          { sourceLotId: "F7-A", quantity: "1" },
          { sourceLotId: "F7-B", quantity: "1" },
          { sourceLotId: "F7-C", quantity: "1" },
        ],
      });

      // F2: snapshot 100 @ $40k, only 60 shares covered at $18k basis.
      const coverageOpeningId = randomUUID();
      await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
        id: coverageOpeningId,
        ownerId: userId,
        accountId,
        instrumentId: coverageInstrumentId,
        idempotencyKey: Buffer.from("f2-covered-opening"),
        tradeDate: "2025-01-01",
        originalQuantityCt: encText(dataKey, "60", coverageOpeningId, "original_quantity_ct", 1),
        remainingQuantityCt: encText(dataKey, "60", coverageOpeningId, "remaining_quantity_ct", 1),
        quantityUnit: "shares",
        totalCostCt: encText(dataKey, "18000", coverageOpeningId, "total_cost_ct", 1),
        currency: "XAC",
        lockedFxProvenance: "unresolved",
        provenance: "imported",
      });
      const coverageLotId = randomUUID();
      await elevatedDb.insert(schema.investmentTaxLots).values({
        id: coverageLotId,
        ownerId: userId,
        accountId,
        instrumentId: coverageInstrumentId,
        openingLotEvidenceId: coverageOpeningId,
        derivationKey: Buffer.from("f2-covered-lot"),
        policyVersion: "broker-else-user-v1",
        tradeDate: "2025-01-01",
        originalQuantityCt: encText(dataKey, "60", coverageLotId, "original_quantity_ct", 1),
        remainingQuantityCt: encText(dataKey, "60", coverageLotId, "remaining_quantity_ct", 1),
        quantityUnit: "shares",
        costBasisCt: encText(dataKey, "18000", coverageLotId, "cost_basis_ct", 1),
        costBasisCurrency: "XAC",
        lockedFxRateCt: encText(dataKey, "3", coverageLotId, "locked_fx_rate_ct", 1),
        lockedFxConvention: "ILS_PER_XAC",
        lockedFxObservationDate: "2025-01-01",
        lockedFxProvenance: "boi_derived",
        completeness: "complete",
      });
      const balanceSnapshotId = randomUUID();
      const snapshotId = randomUUID();
      const positionId = randomUUID();
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
          connectionId,
          syncRunId,
          weekStart: "2025-12-28",
          source: "ibkr_flex",
          sourceAsOf: new Date("2026-01-01T12:00:00Z"),
          sourceAsOfPrecision: "timestamp",
          brokerTotalCt: encText(dataKey, "40000", snapshotId, "broker_total_ct", 1),
          brokerTotalCurrency: "XAC",
          reconciliationState: "matched",
          validationVersion: 1,
        });
        await tx.insert(schema.investmentSnapshotPositions).values({
          id: positionId,
          ownerId: userId,
          snapshotId,
          instrumentId: coverageInstrumentId,
          quantityCt: encText(dataKey, "100", positionId, "quantity_ct", 1),
          quantityUnit: "shares",
          currency: "XAC",
          sourceValueCt: encText(dataKey, "40000", positionId, "source_value_ct", 1),
          sourceValueCurrency: "XAC",
          sourceAsOf: new Date("2026-01-01T12:00:00Z"),
          brokerValuationBasis: "market_value",
        });
      });
      await elevatedDb.insert(schema.investmentActivityCoverage).values({
        ownerId: userId,
        accountId,
        instrumentId: coverageInstrumentId,
        source: "ibkr_flex",
        metric: "cost_basis",
        coverageStart: "2025-01-01",
        coverageBasis: "provider_declared",
        completeness: "complete",
      });

      // F4: buy whose exact trade-date FX is published only after first derive.
      await insertBuy({
        dataKey,
        instrumentId: fxLockInstrumentId,
        executionId: "F4-BUY",
        date: "2026-09-12",
        quantity: "10",
        price: "10",
        gross: "-100",
        currency: "XAD",
      });
    } finally {
      dataKey.fill(0);
    }

    const trackRate = async (fromCurrency: string, date: string, rate: string) => {
      await upsertBoiFxRate({ fromCurrency, date, rate });
      const [row] = await elevatedDb
        .select({ id: schema.fxRates.id })
        .from(schema.fxRates)
        .where(and(eq(schema.fxRates.fromCurrency, fromCurrency), eq(schema.fxRates.date, date)))
        .limit(1);
      fxRateIds.push(row.id);
    };
    // F2 current-valuation FX so the only completeness driver is the coverage gap.
    await trackRate("XAC", "2025-01-01", "3");
    // F4 on-or-before rate that the first derivation must lock and keep.
    await trackRate("XAD", "2026-09-11", "3.14159");
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await cleanupFxRates(fxRateIds);
    await elevatedPool.end();
  });

  function decrypt(dataKey: Uint8Array, value: Buffer, id: string, column: string): string {
    return decryptField(dataKey, value, { rowId: id, column, version: 1 }).toString("utf8");
  }

  async function derive(instrumentId: string) {
    const dataKey = getDevUserDataKey(userId);
    try {
      return await deriveInvestmentTaxLots({ userId, accountId, instrumentId, dataKey });
    } finally {
      dataKey.fill(0);
    }
  }

  async function closuresFor(instrumentId: string) {
    return withUser(userId, async (tx) => {
      const lots = await tx
        .select()
        .from(schema.investmentTaxLots)
        .where(eq(schema.investmentTaxLots.instrumentId, instrumentId));
      const lotIds = new Set(lots.map((lot) => lot.id));
      const closures = (await tx.select().from(schema.investmentLotClosures)).filter((closure) =>
        lotIds.has(closure.closedTaxLotId),
      );
      return closures;
    });
  }

  it("F1: nets sale-side fee out of realized proceeds", async () => {
    await derive(feeInstrumentId);
    const closures = await closuresFor(feeInstrumentId);
    expect(closures).toHaveLength(1);
    const dataKey = getDevUserDataKey(userId);
    try {
      expect(decrypt(dataKey, closures[0].proceedsCt, closures[0].id, "proceeds_ct")).toBe("1199");
      expect(
        decrypt(dataKey, closures[0].realizedCostBasisCt, closures[0].id, "realized_cost_basis_ct"),
      ).toBe("1001");
    } finally {
      dataKey.fill(0);
    }
  });

  it("F7: per-lot proceeds reconcile exactly to the sale total", async () => {
    await derive(prorationInstrumentId);
    const closures = await closuresFor(prorationInstrumentId);
    expect(closures).toHaveLength(3);
    const dataKey = getDevUserDataKey(userId);
    try {
      const total = closures.reduce(
        (sum, closure) => sum.plus(decrypt(dataKey, closure.proceedsCt, closure.id, "proceeds_ct")),
        new Decimal(0),
      );
      expect(total.toFixed()).toBe("1000");
    } finally {
      dataKey.fill(0);
    }
  });

  it("F2: prorates unrealized to covered shares and flags it partial", async () => {
    const dataKey = getDevUserDataKey(userId);
    try {
      await expect(
        readInvestmentUnrealizedGain({
          userId,
          accountId,
          instrumentId: coverageInstrumentId,
          now: new Date("2026-01-02T12:00:00Z"),
          dataKey,
        }),
      ).resolves.toMatchObject({
        native: [{ amount: "6000", currency: "XAC", basis: "native_price_gain" }],
        quality: { completeness: "partial" },
      });
    } finally {
      dataKey.fill(0);
    }
  });

  it("F4: reuses the FX locked on first derive even after the exact-date rate is published", async () => {
    await derive(fxLockInstrumentId);
    const readRate = async () => {
      const dataKey = getDevUserDataKey(userId);
      try {
        const [lot] = await withUser(userId, (tx) =>
          tx
            .select()
            .from(schema.investmentTaxLots)
            .where(eq(schema.investmentTaxLots.instrumentId, fxLockInstrumentId)),
        );
        return lot.lockedFxRateCt
          ? decryptField(dataKey, lot.lockedFxRateCt, {
              rowId: lot.id,
              column: "locked_fx_rate_ct",
              version: lot.version,
            }).toString("utf8")
          : null;
      } finally {
        dataKey.fill(0);
      }
    };
    expect(await readRate()).toBe("3.14159");

    // Publish the exact trade-date observation, then re-derive.
    await upsertBoiFxRate({ fromCurrency: "XAD", date: "2026-09-12", rate: "4" });
    const [exact] = await elevatedDb
      .select({ id: schema.fxRates.id })
      .from(schema.fxRates)
      .where(and(eq(schema.fxRates.fromCurrency, "XAD"), eq(schema.fxRates.date, "2026-09-12")))
      .limit(1);
    fxRateIds.push(exact.id);
    await derive(fxLockInstrumentId);
    expect(await readRate()).toBe("3.14159");
  });
});
