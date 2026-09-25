import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { encText } from "@/domain/fields";
import { ingestInvestmentActivityEvidence } from "@/domain/investment-activity";
import { decryptField, getDevUserDataKey } from "@/lib/crypto";
import {
  normalizeIbkrFlexActivityXml,
  type IbkrFlexActivityEvidenceSet,
  type InvestmentActivityEvidence,
} from "@/lib/investments";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const fixtureXml = readFileSync(
  new URL("../fixtures/investments/ibkr-flex-activity-redacted.xml", import.meta.url),
  "utf8",
);

describe("investment activity ingestion", () => {
  let userId: string;
  let connectionId: string;
  let syncRunId: string;

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `activity-ingestion-${randomUUID()}@test.moni` })
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
      .values({ ownerId: userId, connectionId, status: "running" })
      .returning({ id: schema.syncRuns.id });
    syncRunId = run.id;
    const accountId = randomUUID();
    const dataKey = getDevUserDataKey(userId);
    try {
      await elevatedDb.insert(schema.accounts).values({
        id: accountId,
        ownerId: userId,
        connectionId,
        accountType: "investment",
        classification: "asset",
        nameCt: encText(dataKey, "IBKR activity", accountId, "name_ct", 1),
        externalAccountRefCt: encText(
          dataKey,
          "REDACTED-ACCOUNT",
          accountId,
          "external_account_ref_ct",
          1,
        ),
        currency: "USD",
        status: "active",
      });
    } finally {
      dataKey.fill(0);
    }
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  function fixture(): IbkrFlexActivityEvidenceSet {
    const fingerprintKey = Buffer.from("activity-ingestion-fingerprint-key");
    try {
      return normalizeIbkrFlexActivityXml(fixtureXml, fingerprintKey);
    } finally {
      fingerprintKey.fill(0);
    }
  }

  async function ingest(evidence: IbkrFlexActivityEvidenceSet) {
    const dataKey = getDevUserDataKey(userId);
    try {
      return await ingestInvestmentActivityEvidence({
        userId,
        connectionId,
        syncRunId,
        dataKey,
        evidence,
      });
    } finally {
      dataKey.fill(0);
    }
  }

  it("persists the W2 fixture once across overlapping replays and keeps ciphertext opaque", async () => {
    await expect(ingest(fixture())).resolves.toMatchObject({
      activitiesInserted: 10,
      openingLotsInserted: 2,
      corporateActionsInserted: 1,
    });
    await expect(ingest(fixture())).resolves.toMatchObject({
      activitiesInserted: 0,
      activitiesSkipped: 10,
      openingLotsInserted: 0,
      openingLotsSkipped: 2,
      corporateActionsInserted: 0,
      corporateActionsSkipped: 1,
    });

    const stored = await withUser(userId, async (tx) => ({
      activities: await tx.select().from(schema.investmentActivityEvidence),
      lots: await tx.select().from(schema.investmentOpeningLotEvidence),
      actions: await tx.select().from(schema.investmentCorporateActionEvidence),
    }));
    expect(stored.activities).toHaveLength(10);
    expect(stored.lots).toHaveLength(2);
    expect(stored.actions).toHaveLength(1);
    expect(stored.actions[0].classification).toBe("UNSUPPORTED_CORPORATE_ACTION");

    const dataKey = getDevUserDataKey(userId);
    try {
      const trade = stored.activities.find(
        (row) =>
          row.providerExecutionIdCt &&
          decryptField(dataKey, row.providerExecutionIdCt, {
            rowId: row.id,
            column: "provider_execution_id_ct",
            version: row.version,
          }).toString("utf8") === "EXEC-1",
      );
      expect(trade).toBeDefined();
      expect(trade!.priceCt?.equals(Buffer.from("200"))).toBe(false);
      expect(
        decryptField(dataKey, trade!.priceCt!, {
          rowId: trade!.id,
          column: "price_ct",
          version: trade!.version,
        }).toString("utf8"),
      ).toBe("200");
    } finally {
      dataKey.fill(0);
    }
  });

  it("keeps genuine identical fills distinct when their execution ids differ", async () => {
    const base = fixture().activities[0];
    const evidence: IbkrFlexActivityEvidenceSet = {
      activities: [
        { ...base, idempotencyKey: "A:exec:SAME-1", sourceExecutionId: "SAME-1" },
        { ...base, idempotencyKey: "A:exec:SAME-2", sourceExecutionId: "SAME-2" },
      ],
      openLots: [],
      dividendAccruals: [],
      corporateActions: [],
    };

    await expect(ingest(evidence)).resolves.toMatchObject({ activitiesInserted: 2 });
  });

  it("encrypts and replays an explicitly supplied broker lot allocation", async () => {
    const sale: InvestmentActivityEvidence = {
      ...fixture().activities[2],
      idempotencyKey: "REDACTED-ACCOUNT:exec:ALLOCATED-SELL",
      sourceExecutionId: "ALLOCATED-SELL",
      sourceTradeId: "ALLOCATED-SELL-TRADE",
      sourceRevisionOfId: undefined,
      brokerLotAllocations: [{ sourceLotId: "LOT-1", quantity: "1" }],
    };

    await expect(
      ingest({
        activities: [sale],
        openLots: [],
        dividendAccruals: [],
        corporateActions: [],
      }),
    ).resolves.toMatchObject({ activitiesInserted: 1 });
    await expect(
      ingest({
        activities: [sale],
        openLots: [],
        dividendAccruals: [],
        corporateActions: [],
      }),
    ).resolves.toMatchObject({ activitiesSkipped: 1 });

    const rows = await withUser(userId, (tx) =>
      tx
        .select()
        .from(schema.investmentActivityEvidence)
        .where(eq(schema.investmentActivityEvidence.tradeDate, sale.tradeDate)),
    );
    const dataKey = getDevUserDataKey(userId);
    try {
      const row = rows.find(
        (held) =>
          held.providerExecutionIdCt &&
          decryptField(dataKey, held.providerExecutionIdCt, {
            rowId: held.id,
            column: "provider_execution_id_ct",
            version: held.version,
          }).toString("utf8") === "ALLOCATED-SELL",
      );
      expect(row).toBeDefined();
      expect(
        decryptField(dataKey, row!.brokerLotAllocationsCt!, {
          rowId: row!.id,
          column: "broker_lot_allocations_ct",
          version: row!.version,
        }).toString("utf8"),
      ).toBe('[{"sourceLotId":"LOT-1","quantity":"1"}]');
    } finally {
      dataKey.fill(0);
    }
  });

  it("updates a corrected trade in place and links the collapsed revision", async () => {
    const base = fixture().activities[0];
    const original: InvestmentActivityEvidence = {
      ...base,
      idempotencyKey: "REDACTED-ACCOUNT:exec:CORRECTION-OLD-EXEC",
      sourceExecutionId: "CORRECTION-OLD-EXEC",
      sourceTradeId: "CORRECTION-OLD-TRADE",
      price: "100",
    };
    const correction: InvestmentActivityEvidence = {
      ...original,
      idempotencyKey: "REDACTED-ACCOUNT:exec:CORRECTION-NEW-EXEC",
      sourceExecutionId: "CORRECTION-NEW-EXEC",
      sourceTradeId: "CORRECTION-NEW-TRADE",
      sourceRevisionOfId: "CORRECTION-OLD-TRADE",
      price: "101",
      rawCode: "C",
      rawDescription: "Corrected",
    };
    const evidence = {
      activities: [original, correction],
      openLots: [],
      dividendAccruals: [],
      corporateActions: [],
    };

    await expect(ingest(evidence)).resolves.toMatchObject({
      activitiesInserted: 1,
      activitiesUpdated: 1,
    });
    const dataKey = getDevUserDataKey(userId);
    try {
      const rows = await withUser(userId, (tx) =>
        tx
          .select()
          .from(schema.investmentActivityEvidence)
          .where(
            eq(
              schema.investmentActivityEvidence.revisionOfId,
              schema.investmentActivityEvidence.id,
            ),
          ),
      );
      expect(rows).toHaveLength(1);
      expect(
        decryptField(dataKey, rows[0].priceCt!, {
          rowId: rows[0].id,
          column: "price_ct",
          version: rows[0].version,
        }).toString("utf8"),
      ).toBe("101");
    } finally {
      dataKey.fill(0);
    }
    await ingest(evidence);
    const correctedRows = await withUser(userId, (tx) =>
      tx
        .select()
        .from(schema.investmentActivityEvidence)
        .where(
          eq(schema.investmentActivityEvidence.revisionOfId, schema.investmentActivityEvidence.id),
        ),
    );
    expect(correctedRows).toHaveLength(1);
  });

  it("does not treat a fresh execution with a C code but no origTradeID as a correction", async () => {
    const base = fixture().activities[0];
    const fresh: InvestmentActivityEvidence = {
      ...base,
      idempotencyKey: "REDACTED-ACCOUNT:exec:F10-EXEC",
      sourceExecutionId: "F10-EXEC",
      sourceTradeId: "F10-TRADE",
      sourceRevisionOfId: undefined,
      rawCode: undefined,
      rawDescription: undefined,
      price: "100",
    };
    await expect(
      ingest({ activities: [fresh], openLots: [], dividendAccruals: [], corporateActions: [] }),
    ).resolves.toMatchObject({ activitiesInserted: 1 });
    // Same execution replayed with different content and a benign C code/note.
    const amended: InvestmentActivityEvidence = {
      ...fresh,
      price: "105",
      rawCode: "Ca",
      rawDescription: "position correction expected",
    };
    await expect(
      ingest({ activities: [amended], openLots: [], dividendAccruals: [], corporateActions: [] }),
    ).resolves.toMatchObject({ activitiesUpdated: 1 });

    const dataKey = getDevUserDataKey(userId);
    try {
      const rows = await withUser(userId, (tx) =>
        tx.select().from(schema.investmentActivityEvidence),
      );
      const row = rows.find(
        (held) =>
          held.providerExecutionIdCt &&
          decryptField(dataKey, held.providerExecutionIdCt, {
            rowId: held.id,
            column: "provider_execution_id_ct",
            version: held.version,
          }).toString("utf8") === "F10-EXEC",
      );
      expect(row).toBeDefined();
      expect(row!.revisionOfId).toBeNull();
    } finally {
      dataKey.fill(0);
    }
  });

  it("dedups a re-fetched transactionID-keyed dividend to one updated row", async () => {
    const base = fixture().activities.find((activity) => activity.activityType === "dividend")!;
    const make = (description: string): InvestmentActivityEvidence => ({
      ...base,
      idempotencyKey: "REDACTED-ACCOUNT:cash:txn:F9-TXN",
      sourceActivityId: "REDACTED-ACCOUNT:cash:txn:F9-TXN",
      sourceTradeId: undefined,
      sourceRevisionOfId: undefined,
      grossAmount: "50",
      netCashAmount: "50",
      rawDescription: description,
    });
    await expect(
      ingest({
        activities: [make("AAPL dividend")],
        openLots: [],
        dividendAccruals: [],
        corporateActions: [],
      }),
    ).resolves.toMatchObject({ activitiesInserted: 1 });
    await expect(
      ingest({
        activities: [make("AAPL cash dividend (reformatted)")],
        openLots: [],
        dividendAccruals: [],
        corporateActions: [],
      }),
    ).resolves.toMatchObject({ activitiesInserted: 0, activitiesUpdated: 1 });
  });

  it("queues a non-identical fingerprint collision instead of merging it", async () => {
    const base = fixture().activities.find((activity) => activity.idempotencyKey.includes(":fp:"));
    expect(base).toBeDefined();
    await ingest({
      activities: [base!],
      openLots: [],
      dividendAccruals: [],
      corporateActions: [],
    });
    await expect(
      ingest({
        activities: [{ ...base!, netCashAmount: "-999" }],
        openLots: [],
        dividendAccruals: [],
        corporateActions: [],
      }),
    ).resolves.toMatchObject({ identityAmbiguitiesQueued: 1, activitiesSkipped: 1 });

    const queued = await withUser(userId, (tx) =>
      tx.select().from(schema.investmentDisposalResolutionQueue),
    );
    expect(queued.filter((row) => row.kind === "identity_ambiguity")).toHaveLength(1);
  });
});
