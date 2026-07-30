// src/domain/sync-promotion.ts (task 11) — the reconciliation gate. Calls
// promoteScrapeResult() directly, no spawn (docs plan §"Tests"): a scrape
// must be idempotent on re-run, a pending->posted transition must update
// the same entries row in place (never a second row), and a forced
// mid-promotion failure must leave zero rows and sync_runs never
// 'succeeded' — the atomic-failure contract (docs plan §D).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import { promoteScrapeResult, startSyncRun } from "@/domain/sync-promotion";
import { decText } from "@/domain/fields";
import type { ScraperAccount, ScraperTransaction } from "@/lib/connectors";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface Fixture {
  userId: string;
  dataKey: Buffer;
  connectionId: string;
}

async function freshFixture(label: string): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  const credentialKey = await enrollTestCredentialKey(userId);
  const { id: connectionId } = await createConnection(
    userId,
    "leumi",
    { username: "dana", password: "hunter2" },
    credentialKey,
  );
  return { userId, dataKey, connectionId };
}

async function countEntries(userId: string): Promise<number> {
  return withUser(userId, async (tx) => {
    const rows = await tx.select().from(schema.entries);
    return rows.length;
  });
}

async function findEntryByDate(userId: string, date: string) {
  return withUser(userId, async (tx) => {
    const rows = await tx.select().from(schema.entries).where(eq(schema.entries.date, date));
    return rows[0] ?? null;
  });
}

async function getSyncRunStatus(userId: string, syncRunId: string): Promise<string | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, syncRunId));
    return rows[0]?.status ?? null;
  });
}

/** Decrypt-and-match, the same technique src/domain/sync-promotion.ts's
 * resolveAccount() uses — a test-side check that account reuse really did
 * find the same row, not a fresh one. */
async function findAccountIdByExternalRef(
  userId: string,
  dataKey: Buffer,
  externalRef: string,
): Promise<string | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx.select().from(schema.accounts);
    for (const row of rows) {
      if (!row.externalAccountRefCt) continue;
      const ref = decText(
        dataKey,
        row.externalAccountRefCt,
        row.id,
        "external_account_ref_ct",
        row.version,
      );
      if (ref === externalRef) return row.id;
    }
    return null;
  });
}

function txn(overrides: Partial<ScraperTransaction> = {}): ScraperTransaction {
  return {
    type: "normal",
    identifier: "A1",
    date: "2026-06-01",
    processedDate: "2026-06-01",
    originalAmount: -100,
    originalCurrency: "ILS",
    chargedAmount: -100,
    chargedCurrency: "ILS",
    description: "Coffee shop",
    status: "pending",
    ...overrides,
  };
}

describe("promoteScrapeResult: reconciliation", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  it("scrapes once correctly: creates the account, both entries, and a balance snapshot", async () => {
    const fx = await freshFixture("recon-basic");
    createdUserIds.push(fx.userId);

    const accounts: ScraperAccount[] = [
      {
        accountNumber: "123456",
        balance: 5000,
        balanceDate: "2026-06-10",
        currency: "ILS",
        txns: [
          txn({
            identifier: "A1",
            date: "2026-06-01",
            status: "pending",
            description: "Coffee shop",
          }),
          txn({
            identifier: "A2",
            date: "2026-06-02",
            status: "completed",
            description: "Groceries",
            originalAmount: -50,
            chargedAmount: -50,
          }),
        ],
      },
    ];

    const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
    const summary = await promoteScrapeResult({
      userId: fx.userId,
      dataKey: fx.dataKey,
      connectionId: fx.connectionId,
      connectorId: "leumi",
      syncRunId,
      accounts,
    });

    expect(summary.accountsCreated).toBe(1);
    expect(summary.newEntries).toBe(2);
    expect(summary.matchedUnchanged).toBe(0);
    expect(summary.updatedPendingToPosted).toBe(0);
    expect(summary.balanceSnapshots).toBe(1);

    expect(await countEntries(fx.userId)).toBe(2);
    expect(await getSyncRunStatus(fx.userId, syncRunId)).toBe("succeeded");

    const entry = await findEntryByDate(fx.userId, "2026-06-01");
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe("pending");
    const description = decText(
      fx.dataKey,
      entry!.descriptionCt,
      entry!.id,
      "description_ct",
      entry!.version,
    );
    expect(description).toBe("Coffee shop");
  });

  it("scrape-twice is idempotent: zero new entries on a re-run", async () => {
    const fx = await freshFixture("recon-idempotent");
    createdUserIds.push(fx.userId);

    const accounts: ScraperAccount[] = [
      {
        accountNumber: "123456",
        currency: "ILS",
        txns: [txn({ identifier: "A1", date: "2026-06-01", status: "pending" })],
      },
    ];

    const syncRunId1 = await startSyncRun(fx.userId, fx.connectionId);
    await promoteScrapeResult({
      userId: fx.userId,
      dataKey: fx.dataKey,
      connectionId: fx.connectionId,
      connectorId: "leumi",
      syncRunId: syncRunId1,
      accounts,
    });
    expect(await countEntries(fx.userId)).toBe(1);

    const syncRunId2 = await startSyncRun(fx.userId, fx.connectionId);
    const summary2 = await promoteScrapeResult({
      userId: fx.userId,
      dataKey: fx.dataKey,
      connectionId: fx.connectionId,
      connectorId: "leumi",
      syncRunId: syncRunId2,
      accounts,
    });

    expect(summary2.newEntries).toBe(0);
    expect(summary2.matchedUnchanged).toBe(1);
    expect(summary2.accountsCreated).toBe(0);
    expect(await countEntries(fx.userId)).toBe(1);
    expect(await getSyncRunStatus(fx.userId, syncRunId2)).toBe("succeeded");
  });

  it("pending -> posted updates the SAME entries.id in place, never a second row", async () => {
    const fx = await freshFixture("recon-pending-posted");
    createdUserIds.push(fx.userId);

    const pendingAccounts: ScraperAccount[] = [
      {
        accountNumber: "123456",
        currency: "ILS",
        txns: [
          txn({
            identifier: "A1",
            date: "2026-06-01",
            status: "pending",
            description: "Pending charge",
          }),
        ],
      },
    ];

    const syncRunId1 = await startSyncRun(fx.userId, fx.connectionId);
    await promoteScrapeResult({
      userId: fx.userId,
      dataKey: fx.dataKey,
      connectionId: fx.connectionId,
      connectorId: "leumi",
      syncRunId: syncRunId1,
      accounts: pendingAccounts,
    });

    const before = await findEntryByDate(fx.userId, "2026-06-01");
    expect(before).not.toBeNull();
    expect(before!.status).toBe("pending");
    expect(before!.version).toBe(1);

    // Same stable fields (amount/currency/date/identifier — the import_key
    // inputs) but now posted, with the description/processedDate a bank
    // typically mutates on posting.
    const postedAccounts: ScraperAccount[] = [
      {
        accountNumber: "123456",
        currency: "ILS",
        txns: [
          txn({
            identifier: "A1",
            date: "2026-06-01",
            processedDate: "2026-06-03",
            status: "completed",
            description: "Posted charge — final",
          }),
        ],
      },
    ];

    const syncRunId2 = await startSyncRun(fx.userId, fx.connectionId);
    const summary2 = await promoteScrapeResult({
      userId: fx.userId,
      dataKey: fx.dataKey,
      connectionId: fx.connectionId,
      connectorId: "leumi",
      syncRunId: syncRunId2,
      accounts: postedAccounts,
    });

    expect(summary2.newEntries).toBe(0);
    expect(summary2.updatedPendingToPosted).toBe(1);
    expect(await countEntries(fx.userId)).toBe(1); // still one row, not two

    const after = await findEntryByDate(fx.userId, "2026-06-01");
    expect(after!.id).toBe(before!.id); // the SAME row, updated in place
    expect(after!.status).toBe("posted");
    expect(after!.version).toBe(2); // version bumped

    const description = decText(
      fx.dataKey,
      after!.descriptionCt,
      after!.id,
      "description_ct",
      after!.version,
    );
    expect(description).toBe("Posted charge — final");
    const amount = decText(
      fx.dataKey,
      after!.enteredAmountCt,
      after!.id,
      "entered_amount_ct",
      after!.version,
    );
    expect(amount).toBe("-100");
  });

  it("a forced mid-promotion failure leaves zero rows and sync_runs never 'succeeded'", async () => {
    const fx = await freshFixture("recon-atomic-failure");
    createdUserIds.push(fx.userId);

    const accounts: ScraperAccount[] = [
      {
        accountNumber: "123456",
        currency: "ILS",
        txns: [
          txn({ identifier: "GOOD", date: "2026-06-01", status: "pending" }),
          // Postgres rejects this at INSERT time (invalid date syntax) —
          // deliberately placed AFTER a valid txn in the same account, to
          // prove the whole transaction (including the already-processed
          // good row) rolls back, not just the bad one.
          txn({ identifier: "BAD", date: "not-a-date", status: "pending" }),
        ],
      },
    ];

    const syncRunId = await startSyncRun(fx.userId, fx.connectionId);

    await expect(
      promoteScrapeResult({
        userId: fx.userId,
        dataKey: fx.dataKey,
        connectionId: fx.connectionId,
        connectorId: "leumi",
        syncRunId,
        accounts,
      }),
    ).rejects.toThrow();

    expect(await countEntries(fx.userId)).toBe(0);
    // Still 'running': promoteScrapeResult never reached its final
    // sync_runs update, and it does NOT write 'failed' itself — that's the
    // caller's job, in a separate transaction (docs plan §D,
    // markSyncRunFailed).
    expect(await getSyncRunStatus(fx.userId, syncRunId)).toBe("running");
  });

  it("auto-creates an account on first sight, then reuses it by decrypt-and-match on subsequent syncs", async () => {
    const fx = await freshFixture("recon-account-reuse");
    createdUserIds.push(fx.userId);

    const firstAccounts: ScraperAccount[] = [
      {
        accountNumber: "987654",
        currency: "ILS",
        txns: [txn({ identifier: "A1", date: "2026-06-01" })],
      },
    ];

    const syncRunId1 = await startSyncRun(fx.userId, fx.connectionId);
    const summary1 = await promoteScrapeResult({
      userId: fx.userId,
      dataKey: fx.dataKey,
      connectionId: fx.connectionId,
      connectorId: "leumi",
      syncRunId: syncRunId1,
      accounts: firstAccounts,
    });
    expect(summary1.accountsCreated).toBe(1);

    const accountId1 = await findAccountIdByExternalRef(fx.userId, fx.dataKey, "987654");
    expect(accountId1).not.toBeNull();

    const secondAccounts: ScraperAccount[] = [
      {
        accountNumber: "987654",
        currency: "ILS",
        txns: [txn({ identifier: "A2", date: "2026-06-05" })],
      },
    ];

    const syncRunId2 = await startSyncRun(fx.userId, fx.connectionId);
    const summary2 = await promoteScrapeResult({
      userId: fx.userId,
      dataKey: fx.dataKey,
      connectionId: fx.connectionId,
      connectorId: "leumi",
      syncRunId: syncRunId2,
      accounts: secondAccounts,
    });
    expect(summary2.accountsCreated).toBe(0);

    const accountId2 = await findAccountIdByExternalRef(fx.userId, fx.dataKey, "987654");
    expect(accountId2).toBe(accountId1); // the SAME account row, reused
  });
});
