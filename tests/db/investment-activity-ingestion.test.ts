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

    const trade = stored.activities.find((row) => row.providerExecutionIdCt);
    expect(trade).toBeDefined();
    expect(trade!.priceCt?.equals(Buffer.from("200"))).toBe(false);
    const dataKey = getDevUserDataKey(userId);
    try {
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
