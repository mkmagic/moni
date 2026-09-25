import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { encText } from "@/domain/fields";
import { ingestInvestmentActivityEvidence } from "@/domain/investment-activity";
import { deriveAndReconcileInvestmentActivity } from "@/domain/investment-activity-sync";
import { getDevUserDataKey } from "@/lib/crypto";
import { normalizeIbkrFlexActivityXml, type IbkrFlexActivityEvidenceSet } from "@/lib/investments";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const fixtureXml = readFileSync(
  new URL("../fixtures/investments/ibkr-flex-activity-redacted.xml", import.meta.url),
  "utf8",
);

function parse(): IbkrFlexActivityEvidenceSet {
  const fingerprintKey = Buffer.from("worker-activity-sync-fingerprint-key");
  try {
    return normalizeIbkrFlexActivityXml(fixtureXml, fingerprintKey);
  } finally {
    fingerprintKey.fill(0);
  }
}

describe("ibkr worker activity sync wiring", () => {
  let userId: string;
  let connectionId: string;
  let syncRunId: string;

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `worker-activity-sync-${randomUUID()}@test.moni` })
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

  it("ingests activity and derives tax lots from the same statement the worker fetches", async () => {
    const dataKey = getDevUserDataKey(userId);
    try {
      const ingested = await ingestInvestmentActivityEvidence({
        userId,
        connectionId,
        syncRunId,
        dataKey,
        evidence: parse(),
      });
      expect(ingested.activitiesInserted).toBeGreaterThan(0);

      await deriveAndReconcileInvestmentActivity({ userId, connectionId, dataKey });
    } finally {
      dataKey.fill(0);
    }

    const counts = await withUser(userId, async (tx) => ({
      activities: (await tx.select().from(schema.investmentActivityEvidence)).length,
      lots: (await tx.select().from(schema.investmentTaxLots)).length,
    }));
    expect(counts.activities).toBeGreaterThan(0);
    expect(counts.lots).toBeGreaterThan(0);
  });
});
