import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { encText } from "@/domain/fields";
import { BROKER_ELSE_USER_POLICY_VERSION, deriveInvestmentTaxLots } from "@/domain/investment-lots";
import { upsertBoiFxRate } from "@/domain/fx-rates";
import { decryptField, getDevUserDataKey } from "@/lib/crypto";
import { cleanupFxRates, cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

describe("investment tax-lot derivation", () => {
  let userId: string;
  let accountId: string;
  let instrumentId: string;
  let openingLotId: string;
  let fxRateId: string;

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `lot-derivation-${randomUUID()}@test.moni` })
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
        nameCt: encText(dataKey, "Lot account", accountId, "name_ct", 1),
        currency: "XAA",
      });
      const [instrument] = await elevatedDb
        .insert(schema.instruments)
        .values({ ownerId: userId, kind: "stock" })
        .returning({ id: schema.instruments.id });
      instrumentId = instrument.id;

      const insertActivity = async (input: {
        type: "buy" | "sell";
        date: string;
        quantity: string;
        price: string;
        gross: string;
        executionId: string;
        allocations?: Array<{ sourceLotId: string; quantity: string }>;
      }) => {
        const id = randomUUID();
        await elevatedDb.insert(schema.investmentActivityEvidence).values({
          id,
          ownerId: userId,
          connectionId: connection.id,
          syncRunId: run.id,
          accountId,
          instrumentId,
          source: "ibkr_flex",
          activityType: input.type,
          providerExecutionIdCt: encText(
            dataKey,
            input.executionId,
            id,
            "provider_execution_id_ct",
            1,
          ),
          brokerLotAllocationsCt: input.allocations
            ? encText(
                dataKey,
                JSON.stringify(input.allocations),
                id,
                "broker_lot_allocations_ct",
                1,
              )
            : null,
          idempotencyKey: Buffer.from(input.executionId),
          tradeDate: input.date,
          quantityCt: encText(dataKey, input.quantity, id, "quantity_ct", 1),
          quantityUnit: "shares",
          priceCt: encText(dataKey, input.price, id, "price_ct", 1),
          grossAmountCt: encText(dataKey, input.gross, id, "gross_amount_ct", 1),
          feeAmountCt:
            input.executionId === "BUY-WEEKEND"
              ? encText(dataKey, "-1", id, "fee_amount_ct", 1)
              : null,
          currency: "XAA",
          rawTypeCt: encText(dataKey, "Trade", id, "raw_type_ct", 1),
          provenance: "broker_reported",
        });
      };

      await insertActivity({
        type: "buy",
        date: "2026-09-12",
        quantity: "5",
        price: "10",
        gross: "-50",
        executionId: "BUY-WEEKEND",
      });
      await insertActivity({
        type: "buy",
        date: "1900-01-01",
        quantity: "2",
        price: "8",
        gross: "-16",
        executionId: "BUY-PRE-SERIES",
      });
      await insertActivity({
        type: "sell",
        date: "2026-09-13",
        quantity: "-2",
        price: "11",
        gross: "22",
        executionId: "SELL-ALLOCATED",
        allocations: [{ sourceLotId: "BUY-WEEKEND", quantity: "2" }],
      });
      await insertActivity({
        type: "sell",
        date: "2026-09-14",
        quantity: "-1",
        price: "12",
        gross: "12",
        executionId: "SELL-UNALLOCATED",
      });

      openingLotId = randomUUID();
      await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
        id: openingLotId,
        ownerId: userId,
        accountId,
        instrumentId,
        idempotencyKey: Buffer.from("OPENING-LOT"),
        brokerLotIdCt: encText(dataKey, "OPENING-LOT", openingLotId, "broker_lot_id_ct", 1),
        tradeDate: "2020-01-02",
        originalQuantityCt: encText(dataKey, "3", openingLotId, "original_quantity_ct", 1),
        remainingQuantityCt: encText(dataKey, "3", openingLotId, "remaining_quantity_ct", 1),
        quantityUnit: "shares",
        totalCostCt: encText(dataKey, "30", openingLotId, "total_cost_ct", 1),
        currency: "XAA",
        lockedFxRateCt: encText(dataKey, "3.5", openingLotId, "locked_fx_rate_ct", 1),
        lockedFxConvention: "ILS_PER_XAA",
        lockedFxProvenance: "user_entered",
        provenance: "imported",
      });

      const corporateActionId = randomUUID();
      await elevatedDb.insert(schema.investmentCorporateActionEvidence).values({
        id: corporateActionId,
        ownerId: userId,
        connectionId: connection.id,
        syncRunId: run.id,
        accountId,
        instrumentId,
        source: "ibkr_flex",
        idempotencyKey: Buffer.from("CORP-ACTION"),
        actionDate: "2026-09-15",
        rawTypeCt: encText(dataKey, "FS", corporateActionId, "raw_type_ct", 1),
        provenance: "broker_reported",
      });
    } finally {
      dataKey.fill(0);
    }

    await upsertBoiFxRate({ fromCurrency: "XAA", date: "2026-09-11", rate: "3.14159000" });
    const [rate] = await elevatedDb
      .select({ id: schema.fxRates.id })
      .from(schema.fxRates)
      .where(eq(schema.fxRates.fromCurrency, "XAA"));
    fxRateId = rate.id;
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await cleanupFxRates([fxRateId]);
    await elevatedPool.end();
  });

  async function derive(policyVersion = BROKER_ELSE_USER_POLICY_VERSION) {
    const dataKey = getDevUserDataKey(userId);
    try {
      return await deriveInvestmentTaxLots({
        userId,
        accountId,
        instrumentId,
        policyVersion,
        dataKey,
      });
    } finally {
      dataKey.fill(0);
    }
  }

  function decrypt(
    dataKey: Uint8Array,
    value: Buffer,
    row: { id: string; version: number },
    column: string,
  ): string {
    return decryptField(dataKey, value, { rowId: row.id, column, version: row.version }).toString(
      "utf8",
    );
  }

  it("derives exact lots and applies only explicit broker allocations", async () => {
    await expect(derive()).resolves.toEqual({
      policyVersion: BROKER_ELSE_USER_POLICY_VERSION,
      lots: 3,
      closures: 1,
      unresolvedDisposals: 1,
      completeness: "partial",
      coverageStart: "1900-01-01",
      coverageBasis: "earliest_observed",
    });

    const stored = await withUser(userId, async (tx) => ({
      lots: await tx
        .select()
        .from(schema.investmentTaxLots)
        .where(eq(schema.investmentTaxLots.policyVersion, BROKER_ELSE_USER_POLICY_VERSION)),
      closures: await tx.select().from(schema.investmentLotClosures),
      queue: await tx
        .select()
        .from(schema.investmentDisposalResolutionQueue)
        .where(eq(schema.investmentDisposalResolutionQueue.kind, "unresolved_disposal")),
      coverage: await tx
        .select()
        .from(schema.investmentActivityCoverage)
        .where(
          and(
            eq(schema.investmentActivityCoverage.instrumentId, instrumentId),
            eq(schema.investmentActivityCoverage.metric, "cost_basis"),
          ),
        ),
    }));
    expect(stored.closures).toHaveLength(1);
    expect(stored.queue).toHaveLength(1);
    expect(stored.coverage).toMatchObject([
      {
        coverageStart: "1900-01-01",
        coverageBasis: "earliest_observed",
        completeness: "partial",
      },
    ]);

    const dataKey = getDevUserDataKey(userId);
    try {
      const lots = stored.lots.map((lot) => ({
        source: lot.openingLotEvidenceId ? "opening" : "buy",
        original: decrypt(dataKey, lot.originalQuantityCt, lot, "original_quantity_ct"),
        remaining: decrypt(dataKey, lot.remainingQuantityCt, lot, "remaining_quantity_ct"),
        basis: decrypt(dataKey, lot.costBasisCt, lot, "cost_basis_ct"),
        fx: lot.lockedFxRateCt
          ? decrypt(dataKey, lot.lockedFxRateCt, lot, "locked_fx_rate_ct")
          : null,
        fxDate: lot.lockedFxObservationDate,
        fxProvenance: lot.lockedFxProvenance,
      }));
      expect(lots).toEqual(
        expect.arrayContaining([
          {
            source: "opening",
            original: "3",
            remaining: "3",
            basis: "30",
            fx: "3.5",
            fxDate: null,
            fxProvenance: "user_entered",
          },
          {
            source: "buy",
            original: "5",
            remaining: "3",
            basis: "51",
            fx: "3.14159",
            fxDate: "2026-09-11",
            fxProvenance: "boi_derived",
          },
          {
            source: "buy",
            original: "2",
            remaining: "2",
            basis: "16",
            fx: null,
            fxDate: null,
            fxProvenance: "unresolved",
          },
        ]),
      );
      expect(
        decrypt(
          dataKey,
          stored.closures[0].closedQuantityCt,
          stored.closures[0],
          "closed_quantity_ct",
        ),
      ).toBe("2");
      expect(
        decrypt(dataKey, stored.closures[0].proceedsCt, stored.closures[0], "proceeds_ct"),
      ).toBe("22");
      expect(
        decrypt(
          dataKey,
          stored.closures[0].realizedCostBasisCt,
          stored.closures[0],
          "realized_cost_basis_ct",
        ),
      ).toBe("20.4");
      expect(stored.closures[0]).toMatchObject({
        lockedFxConvention: "ILS_PER_XAA",
        lockedFxObservationDate: "2026-09-11",
        lockedFxProvenance: "boi_derived",
        allocationProvenance: "broker_reported",
      });
    } finally {
      dataKey.fill(0);
    }
  });

  it("is byte-stable on replay and derives a parallel policy set", async () => {
    const before = await withUser(userId, async (tx) => ({
      lots: await tx.select().from(schema.investmentTaxLots),
      closures: await tx.select().from(schema.investmentLotClosures),
      queue: await tx.select().from(schema.investmentDisposalResolutionQueue),
    }));
    await derive();
    const replayed = await withUser(userId, async (tx) => ({
      lots: await tx.select().from(schema.investmentTaxLots),
      closures: await tx.select().from(schema.investmentLotClosures),
      queue: await tx.select().from(schema.investmentDisposalResolutionQueue),
    }));
    expect(replayed).toEqual(before);

    await derive("broker-else-user-v2");
    const after = await withUser(userId, (tx) => tx.select().from(schema.investmentTaxLots));
    expect(after.filter((lot) => lot.policyVersion === BROKER_ELSE_USER_POLICY_VERSION)).toEqual(
      before.lots,
    );
    expect(after.filter((lot) => lot.policyVersion === "broker-else-user-v2")).toHaveLength(3);
  });

  it("writes complete and unknown cost-basis coverage when the evidence supports those states", async () => {
    const [completeInstrument, unknownInstrument] = await elevatedDb
      .insert(schema.instruments)
      .values([
        { ownerId: userId, kind: "stock" },
        { ownerId: userId, kind: "stock" },
      ])
      .returning({ id: schema.instruments.id });
    const dataKey = getDevUserDataKey(userId);
    try {
      const id = randomUUID();
      await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
        id,
        ownerId: userId,
        accountId,
        instrumentId: completeInstrument.id,
        idempotencyKey: Buffer.from("COMPLETE-OPENING"),
        tradeDate: "2021-05-06",
        originalQuantityCt: encText(dataKey, "4", id, "original_quantity_ct", 1),
        remainingQuantityCt: encText(dataKey, "4", id, "remaining_quantity_ct", 1),
        quantityUnit: "shares",
        totalCostCt: encText(dataKey, "40", id, "total_cost_ct", 1),
        currency: "XAA",
        lockedFxProvenance: "unresolved",
        provenance: "user_entered",
      });
      await expect(
        deriveInvestmentTaxLots({
          userId,
          accountId,
          instrumentId: completeInstrument.id,
          dataKey,
        }),
      ).resolves.toMatchObject({
        lots: 1,
        completeness: "complete",
        coverageStart: "2021-05-06",
        coverageBasis: "earliest_observed",
      });
      await expect(
        deriveInvestmentTaxLots({
          userId,
          accountId,
          instrumentId: unknownInstrument.id,
          dataKey,
        }),
      ).resolves.toMatchObject({
        lots: 0,
        completeness: "unknown",
        coverageStart: null,
        coverageBasis: null,
      });
    } finally {
      dataKey.fill(0);
    }
  });
});
