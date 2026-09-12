import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { decryptField, encryptField, getDevUserDataKey } from "@/lib/crypto";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const ct = (value: string): Buffer => Buffer.from(value, "utf8");

interface Fixture {
  userId: string;
  connectionId: string;
  syncRunId: string;
  accountId: string;
  instrumentId: string;
  activityId: string;
}

async function seedFixture(label: string): Promise<Fixture> {
  const [user] = await elevatedDb
    .insert(schema.users)
    .values({ email: `${label}-${randomUUID()}@test.moni` })
    .returning({ id: schema.users.id });
  const [connection] = await elevatedDb
    .insert(schema.connections)
    .values({
      ownerId: user.id,
      connectorId: "leumi",
      credentialsCt: ct(`${label}-credentials`),
      status: "active",
    })
    .returning({ id: schema.connections.id });
  const [syncRun] = await elevatedDb
    .insert(schema.syncRuns)
    .values({ ownerId: user.id, connectionId: connection.id, status: "succeeded" })
    .returning({ id: schema.syncRuns.id });
  const [account] = await elevatedDb
    .insert(schema.accounts)
    .values({
      ownerId: user.id,
      connectionId: connection.id,
      accountType: "investment",
      classification: "asset",
      nameCt: ct(`${label}-account`),
      currency: "USD",
      currentBalanceCt: null,
    })
    .returning({ id: schema.accounts.id });
  const [instrument] = await elevatedDb
    .insert(schema.instruments)
    .values({ ownerId: user.id, kind: "etf", canonicalNameCt: ct(`${label}-instrument`) })
    .returning({ id: schema.instruments.id });

  const activityId = randomUUID();
  const key = getDevUserDataKey(user.id);
  let encryptedPrice: Buffer;
  try {
    encryptedPrice = encryptField(key, Buffer.from("123.4500", "utf8"), {
      rowId: activityId,
      column: "price_ct",
      version: 1,
    });
  } finally {
    key.fill(0);
  }
  const [activity] = await elevatedDb
    .insert(schema.investmentActivityEvidence)
    .values({
      id: activityId,
      ownerId: user.id,
      connectionId: connection.id,
      syncRunId: syncRun.id,
      accountId: account.id,
      instrumentId: instrument.id,
      source: "ibkr_flex",
      activityType: "buy",
      providerExecutionIdCt: ct(`${label}-execution`),
      idempotencyKey: ct(`${label}-activity-key`),
      tradeDate: "2026-08-31",
      quantityCt: ct("2"),
      quantityUnit: "shares",
      priceCt: encryptedPrice,
      currency: "USD",
      rawTypeCt: ct("Trade"),
      provenance: "broker_reported",
    })
    .returning({ id: schema.investmentActivityEvidence.id });
  await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
    ownerId: user.id,
    accountId: account.id,
    instrumentId: instrument.id,
    idempotencyKey: ct(`${label}-opening-key`),
    tradeDate: "2020-01-02",
    originalQuantityCt: ct("10"),
    remainingQuantityCt: ct("4"),
    quantityUnit: "shares",
    totalCostCt: ct("1000"),
    currency: "USD",
    lockedFxProvenance: "unresolved",
    provenance: "imported",
  });
  await elevatedDb.insert(schema.investmentCorporateActionEvidence).values({
    ownerId: user.id,
    connectionId: connection.id,
    syncRunId: syncRun.id,
    accountId: account.id,
    instrumentId: instrument.id,
    source: "ibkr_flex",
    idempotencyKey: ct(`${label}-corp-key`),
    actionDate: "2026-09-01",
    rawTypeCt: ct("FS"),
    provenance: "broker_reported",
  });
  await elevatedDb.insert(schema.investmentActivityCoverage).values({
    ownerId: user.id,
    accountId: account.id,
    source: "ibkr_flex",
    metric: "dividends",
    coverageStart: "2026-01-01",
    coverageBasis: "provider_declared",
    completeness: "complete",
  });
  const [taxLot] = await elevatedDb
    .insert(schema.investmentTaxLots)
    .values({
      ownerId: user.id,
      accountId: account.id,
      instrumentId: instrument.id,
      acquisitionActivityId: activity.id,
      derivationKey: ct(`${label}-derived-key`),
      policyVersion: "broker-reported-else-user-selected/v1",
      tradeDate: "2026-08-31",
      originalQuantityCt: ct("2"),
      remainingQuantityCt: ct("2"),
      quantityUnit: "shares",
      costBasisCt: ct("246.90"),
      costBasisCurrency: "USD",
      lockedFxProvenance: "unresolved",
      completeness: "partial",
    })
    .returning({ id: schema.investmentTaxLots.id });
  await elevatedDb.insert(schema.investmentLotClosures).values({
    ownerId: user.id,
    sellActivityEvidenceId: activity.id,
    closedTaxLotId: taxLot.id,
    closedQuantityCt: ct("1"),
    proceedsCt: ct("130"),
    realizedCostBasisCt: ct("123.45"),
    lockedFxConvention: "ILS_PER_USD",
    lockedFxProvenance: "unresolved",
    allocationProvenance: "broker_reported",
  });
  const [quality] = await elevatedDb
    .insert(schema.investmentReconciliationQuality)
    .values({
      ownerId: user.id,
      accountId: account.id,
      instrumentId: instrument.id,
      dimension: "unexplained_opening_quantity",
      expectedValueCt: ct("6"),
      observedValueCt: ct("0"),
      completeness: "partial",
    })
    .returning({ id: schema.investmentReconciliationQuality.id });
  await elevatedDb.insert(schema.investmentDisposalResolutionQueue).values({
    ownerId: user.id,
    accountId: account.id,
    reconciliationQualityId: quality.id,
    kind: "reconciliation_gap",
    policyVersion: "broker-reported-else-user-selected/v1",
  });

  return {
    userId: user.id,
    connectionId: connection.id,
    syncRunId: syncRun.id,
    accountId: account.id,
    instrumentId: instrument.id,
    activityId: activity.id,
  };
}

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ cause: { code } });
}

describe("investment activity and lot schema", () => {
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    a = await seedFixture("activity-a");
    b = await seedFixture("activity-b");
  });

  afterAll(async () => {
    await cleanupOwners([a.userId, b.userId]);
    await elevatedPool.end();
  });

  it("confines all eight activity and lot tables to the current owner through RLS", async () => {
    await withUser(a.userId, async (tx) => {
      const rows = [
        await tx.select().from(schema.investmentActivityEvidence),
        await tx.select().from(schema.investmentOpeningLotEvidence),
        await tx.select().from(schema.investmentCorporateActionEvidence),
        await tx.select().from(schema.investmentActivityCoverage),
        await tx.select().from(schema.investmentTaxLots),
        await tx.select().from(schema.investmentLotClosures),
        await tx.select().from(schema.investmentReconciliationQuality),
        await tx.select().from(schema.investmentDisposalResolutionQueue),
      ];
      for (const tableRows of rows) {
        expect(tableRows).toHaveLength(1);
        expect(tableRows[0].ownerId).toBe(a.userId);
      }
    });
  });

  it("stores encrypted financial values and binds them to row, column, and version", async () => {
    const [stored] = await elevatedDb
      .select({ priceCt: schema.investmentActivityEvidence.priceCt })
      .from(schema.investmentActivityEvidence)
      .where(eq(schema.investmentActivityEvidence.id, a.activityId));
    expect(stored.priceCt?.equals(Buffer.from("123.4500", "utf8"))).toBe(false);

    const key = getDevUserDataKey(a.userId);
    try {
      expect(
        decryptField(key, stored.priceCt!, {
          rowId: a.activityId,
          column: "price_ct",
          version: 1,
        }).toString("utf8"),
      ).toBe("123.4500");
    } finally {
      key.fill(0);
    }
  });

  it("rejects cross-owner links at composite foreign keys", async () => {
    await expectCode(
      elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
        ownerId: a.userId,
        accountId: a.accountId,
        instrumentId: b.instrumentId,
        idempotencyKey: ct("cross-owner-opening"),
        tradeDate: "2020-01-02",
        originalQuantityCt: ct("1"),
        remainingQuantityCt: ct("1"),
        quantityUnit: "shares",
        totalCostCt: ct("100"),
        currency: "USD",
        lockedFxProvenance: "unresolved",
        provenance: "user_entered",
      }),
      "23503",
    );
  });

  it("enforces the per-owner, per-provider activity idempotency key", async () => {
    await expectCode(
      elevatedDb.insert(schema.investmentActivityEvidence).values({
        ownerId: a.userId,
        connectionId: a.connectionId,
        syncRunId: a.syncRunId,
        accountId: a.accountId,
        instrumentId: a.instrumentId,
        source: "ibkr_flex",
        activityType: "buy",
        idempotencyKey: ct("activity-a-activity-key"),
        tradeDate: "2026-08-31",
        quantityCt: ct("1"),
        quantityUnit: "shares",
        rawTypeCt: ct("Trade"),
        provenance: "broker_reported",
      }),
      "23505",
    );
  });
});
