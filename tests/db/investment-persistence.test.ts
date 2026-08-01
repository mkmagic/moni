// Task 2's database foundation: tenant FKs/RLS, ciphertext-at-rest, and the
// deferred account-balance-snapshot investment subtype invariant.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { decryptField, encryptField, getDevUserDataKey } from "@/lib/crypto";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const ct = (value: string) => Buffer.from(value, "utf8");
const FK_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

interface Fixture {
  userId: string;
  connectionId: string;
  syncRunId: string;
  investmentAccountId: string;
  instrumentId: string;
  mappingId: string;
  snapshotId: string;
  detailId: string;
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
  const [run] = await elevatedDb
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
  const [mapping] = await elevatedDb
    .insert(schema.instrumentSourceMappings)
    .values({
      ownerId: user.id,
      instrumentId: instrument.id,
      provider: "tiingo",
      identifierKind: "ticker",
      providerIdentifierCt: ct(`${label}-identifier`),
      currency: "USD",
    })
    .returning({ id: schema.instrumentSourceMappings.id });
  await elevatedDb.insert(schema.investmentMarketQuotes).values({
    ownerId: user.id,
    instrumentId: instrument.id,
    instrumentSourceMappingId: mapping.id,
    provider: "tiingo",
    providerSymbolCt: ct(`${label}-symbol`),
    priceCt: ct("100"),
    currency: "USD",
    sourceDate: "2026-01-31",
    fetchedAt: new Date("2026-01-31T12:00:00Z"),
    splitState: "safe",
    qualityState: "accepted",
  });
  const { snapshotId, detailId } = await elevatedDb.transaction(async (tx) => {
    const [snapshot] = await tx
      .insert(schema.accountBalanceSnapshots)
      .values({
        ownerId: user.id,
        accountId: account.id,
        date: "2026-01-31",
        nativeBalanceCt: null,
        currency: null,
        source: "investment",
      })
      .returning({ id: schema.accountBalanceSnapshots.id });
    const [detail] = await tx
      .insert(schema.investmentSnapshotDetails)
      .values({
        ownerId: user.id,
        accountBalanceSnapshotId: snapshot.id,
        accountId: account.id,
        connectionId: connection.id,
        syncRunId: run.id,
        weekStart: "2026-01-25",
        source: "ibkr_flex",
        sourceAsOf: new Date("2026-01-31T12:00:00Z"),
        sourceAsOfPrecision: "timestamp",
        brokerTotalCt: ct("100"),
        brokerTotalCurrency: "USD",
        reconciliationState: "matched",
        validationVersion: 1,
      })
      .returning({ id: schema.investmentSnapshotDetails.id });
    await tx.insert(schema.investmentSnapshotPositions).values({
      ownerId: user.id,
      snapshotId: detail.id,
      instrumentId: instrument.id,
      quantityCt: ct("1"),
      quantityUnit: "shares",
      currency: "USD",
      sourceValueCt: ct("100"),
      sourceValueCurrency: "USD",
      brokerValuationBasis: "market_value",
    });
    await tx.insert(schema.investmentSnapshotCashBalances).values({
      ownerId: user.id,
      snapshotId: detail.id,
      currency: "USD",
      amountCt: ct("0"),
    });
    await tx.insert(schema.investmentSourceEvidence).values({
      ownerId: user.id,
      connectionId: connection.id,
      syncRunId: run.id,
      accountId: account.id,
      source: "ibkr_flex",
      sourceAsOf: new Date("2026-01-31T12:00:00Z"),
      sourceAsOfPrecision: "timestamp",
      validationVersion: 1,
      positionRowCount: 1,
      cashRowCount: 1,
      qualityCodes: [],
      normalizedFingerprint: ct(`${label}-fingerprint`),
    });
    return { snapshotId: snapshot.id, detailId: detail.id };
  });
  return {
    userId: user.id,
    connectionId: connection.id,
    syncRunId: run.id,
    investmentAccountId: account.id,
    instrumentId: instrument.id,
    mappingId: mapping.id,
    snapshotId,
    detailId,
  };
}

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ cause: { code } });
}

describe("investment persistence foundation", () => {
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    a = await seedFixture("investment-a");
    b = await seedFixture("investment-b");
  });

  afterAll(async () => {
    await cleanupOwners([a.userId, b.userId]);
    await elevatedPool.end();
  });

  it("RLS confines the seven investment tables to the current owner", async () => {
    await withUser(a.userId, async (tx) => {
      const rows = [
        await tx.select().from(schema.instruments),
        await tx.select().from(schema.instrumentSourceMappings),
        await tx.select().from(schema.investmentSnapshotDetails),
        await tx.select().from(schema.investmentSnapshotPositions),
        await tx.select().from(schema.investmentSnapshotCashBalances),
        await tx.select().from(schema.investmentSourceEvidence),
        await tx.select().from(schema.investmentMarketQuotes),
      ];
      for (const tableRows of rows) {
        expect(tableRows.length).toBeGreaterThan(0);
        expect(tableRows.every((row) => row.ownerId === a.userId)).toBe(true);
      }
    });
  });

  it("rejects a source mapping that crosses owners at the composite FK", async () => {
    await expectCode(
      elevatedDb.insert(schema.instrumentSourceMappings).values({
        ownerId: a.userId,
        instrumentId: b.instrumentId,
        provider: "ibkr_flex",
        identifierKind: "isin",
        providerIdentifierCt: ct("cross-owner"),
        currency: "USD",
      }),
      FK_VIOLATION,
    );
  });

  it("rejects cross-owner parent references from every investment child table", async () => {
    const [crossRun] = await elevatedDb
      .insert(schema.syncRuns)
      .values({ ownerId: a.userId, connectionId: a.connectionId, status: "succeeded" })
      .returning({ id: schema.syncRuns.id });
    await expectCode(
      elevatedDb.insert(schema.investmentSnapshotDetails).values({
        ownerId: a.userId,
        accountBalanceSnapshotId: b.snapshotId,
        accountId: a.investmentAccountId,
        connectionId: a.connectionId,
        syncRunId: crossRun.id,
        weekStart: "2026-02-08",
        source: "ibkr_flex",
        sourceAsOf: new Date("2026-02-08T12:00:00Z"),
        sourceAsOfPrecision: "timestamp",
        brokerTotalCt: ct("1"),
        brokerTotalCurrency: "USD",
        reconciliationState: "matched",
        validationVersion: 1,
      }),
      FK_VIOLATION,
    );
    await expectCode(
      elevatedDb.insert(schema.investmentSnapshotPositions).values({
        ownerId: a.userId,
        snapshotId: b.detailId,
        instrumentId: a.instrumentId,
        quantityCt: ct("1"),
        quantityUnit: "shares",
        currency: "USD",
        sourceValueCt: ct("1"),
        sourceValueCurrency: "USD",
        brokerValuationBasis: "market_value",
      }),
      FK_VIOLATION,
    );
    await expectCode(
      elevatedDb.insert(schema.investmentSnapshotCashBalances).values({
        ownerId: a.userId,
        snapshotId: b.detailId,
        currency: "USD",
        amountCt: ct("0"),
      }),
      FK_VIOLATION,
    );
    await expectCode(
      elevatedDb.insert(schema.investmentSourceEvidence).values({
        ownerId: a.userId,
        connectionId: b.connectionId,
        syncRunId: crossRun.id,
        accountId: a.investmentAccountId,
        source: "ibkr_flex",
        sourceAsOf: new Date("2026-02-08T12:00:00Z"),
        sourceAsOfPrecision: "timestamp",
        validationVersion: 1,
        positionRowCount: 0,
        cashRowCount: 0,
        qualityCodes: [],
        normalizedFingerprint: ct("cross-owner"),
      }),
      FK_VIOLATION,
    );
    await expectCode(
      elevatedDb.insert(schema.investmentMarketQuotes).values({
        ownerId: a.userId,
        instrumentId: b.instrumentId,
        instrumentSourceMappingId: b.mappingId,
        provider: "tiingo",
        providerSymbolCt: ct("cross-owner"),
        priceCt: ct("1"),
        currency: "USD",
        sourceDate: "2026-02-08",
        fetchedAt: new Date("2026-02-08T12:00:00Z"),
        splitState: "safe",
        qualityState: "accepted",
      }),
      FK_VIOLATION,
    );
  });

  it("keeps investment identifiers encrypted from the first database write and AAD-bound", async () => {
    const id = randomUUID();
    const key = getDevUserDataKey(a.userId);
    try {
      const ciphertext = encryptField(key, Buffer.from("US0378331005", "utf8"), {
        rowId: id,
        column: "provider_identifier_ct",
        version: 1,
      });
      const [mapping] = await elevatedDb
        .insert(schema.instrumentSourceMappings)
        .values({
          id,
          ownerId: a.userId,
          instrumentId: a.instrumentId,
          provider: "ibkr_flex",
          identifierKind: "isin",
          providerIdentifierCt: ciphertext,
          currency: "USD",
        })
        .returning({ stored: schema.instrumentSourceMappings.providerIdentifierCt });

      expect(mapping.stored.equals(Buffer.from("US0378331005", "utf8"))).toBe(false);
      expect(
        decryptField(key, mapping.stored, {
          rowId: id,
          column: "provider_identifier_ct",
          version: 1,
        }).toString("utf8"),
      ).toBe("US0378331005");
      const wrongKey = getDevUserDataKey(b.userId);
      try {
        expect(() =>
          decryptField(wrongKey, mapping.stored, {
            rowId: id,
            column: "provider_identifier_ct",
            version: 1,
          }),
        ).toThrow();
      } finally {
        wrongKey.fill(0);
      }
      expect(() =>
        decryptField(key, mapping.stored, {
          rowId: id,
          column: "provider_identifier_ct",
          version: 2,
        }),
      ).toThrow();
    } finally {
      key.fill(0);
    }
  });

  it("rejects credential/mode and archive lifecycle mismatches", async () => {
    await expectCode(
      elevatedDb.insert(schema.connections).values({
        ownerId: a.userId,
        connectorId: "leumi",
        mode: "user_mediated_import",
        credentialsCt: ct("must-not-store"),
        status: "active",
      }),
      CHECK_VIOLATION,
    );
    await expectCode(
      elevatedDb.insert(schema.accounts).values({
        ownerId: a.userId,
        accountType: "checking",
        classification: "asset",
        nameCt: ct("bad-archive"),
        currency: "ILS",
        status: "archived",
        archivedAt: null,
      }),
      CHECK_VIOLATION,
    );
  });

  it("rejects half-null ordinary balance snapshots", async () => {
    await expectCode(
      elevatedDb.insert(schema.accountBalanceSnapshots).values({
        ownerId: a.userId,
        accountId: a.investmentAccountId,
        date: "2026-02-01",
        nativeBalanceCt: ct("1"),
        currency: null,
        source: "manual",
      }),
      CHECK_VIOLATION,
    );
  });

  it("requires a matching detail for a rich investment snapshot at commit", async () => {
    await expectCode(
      elevatedDb.transaction(async (tx) => {
        await tx.insert(schema.accountBalanceSnapshots).values({
          ownerId: a.userId,
          accountId: a.investmentAccountId,
          date: "2026-02-01",
          nativeBalanceCt: null,
          currency: null,
          source: "investment",
        });
      }),
      "P0001",
    );
  });

  it("accepts a complete rich investment snapshot and enforces one per account/week", async () => {
    await elevatedDb.transaction(async (tx) => {
      const [snapshot] = await tx
        .insert(schema.accountBalanceSnapshots)
        .values({
          ownerId: a.userId,
          accountId: a.investmentAccountId,
          date: "2026-02-01",
          nativeBalanceCt: null,
          currency: null,
          source: "investment",
        })
        .returning({ id: schema.accountBalanceSnapshots.id });
      await tx.insert(schema.investmentSnapshotDetails).values({
        ownerId: a.userId,
        accountBalanceSnapshotId: snapshot.id,
        accountId: a.investmentAccountId,
        connectionId: a.connectionId,
        syncRunId: a.syncRunId,
        weekStart: "2026-02-01",
        source: "ibkr_flex",
        sourceAsOf: new Date("2026-02-01T12:00:00Z"),
        sourceAsOfPrecision: "timestamp",
        brokerTotalCt: ct("1"),
        brokerTotalCurrency: "USD",
        reconciliationState: "matched",
        validationVersion: 1,
      });
    });

    await expectCode(
      elevatedDb.transaction(async (tx) => {
        const [snapshot] = await tx
          .insert(schema.accountBalanceSnapshots)
          .values({
            ownerId: a.userId,
            accountId: a.investmentAccountId,
            date: "2026-02-02",
            nativeBalanceCt: null,
            currency: null,
            source: "investment",
          })
          .returning({ id: schema.accountBalanceSnapshots.id });
        await tx.insert(schema.investmentSnapshotDetails).values({
          ownerId: a.userId,
          accountBalanceSnapshotId: snapshot.id,
          accountId: a.investmentAccountId,
          connectionId: a.connectionId,
          syncRunId: a.syncRunId,
          weekStart: "2026-02-01",
          source: "ibkr_flex",
          sourceAsOf: new Date("2026-02-02T12:00:00Z"),
          sourceAsOfPrecision: "timestamp",
          brokerTotalCt: ct("1"),
          brokerTotalCurrency: "USD",
          reconciliationState: "matched",
          validationVersion: 1,
        });
      }),
      "23505",
    );
  });

  it("revalidates every rich snapshot when account subtype fields change", async () => {
    for (const values of [
      { accountType: "checking" as const },
      { classification: "liability" as const },
      { currentBalanceCt: ct("1") },
    ]) {
      await expectCode(
        elevatedDb.transaction((tx) =>
          tx
            .update(schema.accounts)
            .set(values)
            .where(sql`${schema.accounts.id} = ${a.investmentAccountId}`),
        ),
        "P0001",
      );
    }
  });

  it("revalidates both parents when a detail is reparented", async () => {
    await expectCode(
      elevatedDb.transaction(async (tx) => {
        const [newSnapshot] = await tx
          .insert(schema.accountBalanceSnapshots)
          .values({
            ownerId: a.userId,
            accountId: a.investmentAccountId,
            date: "2026-02-08",
            nativeBalanceCt: null,
            currency: null,
            source: "investment",
          })
          .returning({ id: schema.accountBalanceSnapshots.id });
        await tx
          .update(schema.investmentSnapshotDetails)
          .set({ accountBalanceSnapshotId: newSnapshot.id })
          .where(sql`${schema.investmentSnapshotDetails.id} = ${a.detailId}`);
      }),
      "P0001",
    );
  });

  it("requires a market quote provider to match its source mapping", async () => {
    await expectCode(
      elevatedDb.insert(schema.investmentMarketQuotes).values({
        ownerId: a.userId,
        instrumentId: a.instrumentId,
        instrumentSourceMappingId: a.mappingId,
        provider: "ibkr_flex",
        providerSymbolCt: ct("wrong-provider"),
        priceCt: ct("1"),
        currency: "USD",
        sourceDate: "2026-02-08",
        fetchedAt: new Date("2026-02-08T12:00:00Z"),
        splitState: "safe",
        qualityState: "accepted",
      }),
      "P0001",
    );
  });
});
