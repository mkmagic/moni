// src/domain/sync-promotion.ts — Leumi pending transactions.
//
// Leumi gives a pending ("today") transaction a provisional reference number
// that differs from the one it carries once posted (prod: pending 699035449
// -> posted 35449), and its timestamp can move between scrapes while it is
// still pending. Both feed the import key, so the posted row never matched
// the pending one: every Leumi pending charge left a ghost row beside its
// posted twin. Leumi pending items are therefore not imported at all — the
// posted version arrives on the next day's sync.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import { promoteScrapeResult, startSyncRun } from "@/domain/sync-promotion";
import type { ConnectorId, ScraperAccount, ScraperTransaction } from "@/lib/connectors";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface Fixture {
  userId: string;
  dataKey: Buffer;
  connectionId: string;
  connectorId: ConnectorId;
}

async function freshFixture(label: string, connectorId: ConnectorId): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  const credentialKey = await enrollTestCredentialKey(userId);
  const { id: connectionId } = await createConnection(
    userId,
    connectorId,
    { username: "user", password: "hunter2" },
    credentialKey,
  );
  return { userId, dataKey, connectionId, connectorId };
}

/** The 22 Sep 2026 transfer as Leumi reported it: pending, then posted. */
function transfer(status: "pending" | "completed", identifier: number): ScraperTransaction {
  return {
    type: "normal",
    identifier,
    date: "2026-09-21T21:00:00.000Z",
    processedDate: "2026-09-21T21:00:00.000Z",
    originalAmount: -20000,
    originalCurrency: "ILS",
    chargedAmount: -20000,
    description: "העברה דיגיטל",
    status,
  };
}

async function promote(fx: Fixture, txns: ScraperTransaction[]) {
  const accounts: ScraperAccount[] = [{ accountNumber: "800_13", txns }];
  const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
  return promoteScrapeResult({
    userId: fx.userId,
    dataKey: fx.dataKey,
    connectionId: fx.connectionId,
    connectorId: fx.connectorId,
    syncRunId,
    accounts,
  });
}

async function readStatuses(fx: Fixture) {
  return withUser(fx.userId, async (tx) =>
    (await tx.select().from(schema.entries)).map((entry) => entry.status),
  );
}

describe("promoteScrapeResult: Leumi pending transactions", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  it("leaves one posted entry when a pending charge posts under a new reference", async () => {
    const fx = await freshFixture("leumi-pending", "leumi");
    createdUserIds.push(fx.userId);

    await promote(fx, [transfer("pending", 699035449)]);
    await promote(fx, [transfer("completed", 35449)]);

    expect(await readStatuses(fx)).toEqual(["posted"]);
  });

  it("still logs the skipped pending item to the staging buffer, unpromoted", async () => {
    const fx = await freshFixture("leumi-staging", "leumi");
    createdUserIds.push(fx.userId);

    const summary = await promote(fx, [transfer("pending", 699035449)]);
    expect(summary.newEntries).toBe(0);

    const staged = await withUser(fx.userId, async (tx) => tx.select().from(schema.syncStaging));
    expect(
      staged.map((row) => ({
        scraperStatus: row.scraperStatus,
        reconcileState: row.reconcileState,
        promotedEntryId: row.promotedEntryId,
      })),
    ).toEqual([{ scraperStatus: "pending", reconcileState: "new", promotedEntryId: null }]);
  });

  it("still imports pending transactions from other banks", async () => {
    const fx = await freshFixture("other-pending", "mizrahi");
    createdUserIds.push(fx.userId);

    await promote(fx, [transfer("pending", 699035449)]);

    expect(await readStatuses(fx)).toEqual(["pending"]);
  });
});
