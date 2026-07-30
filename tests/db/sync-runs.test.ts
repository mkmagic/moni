// src/domain/sync-promotion.ts additions for cluster ③a (tasks 14/15/19):
// getSyncRun's lazy orphaned-run self-heal (task 19) and markSyncRunFailed's
// `WHERE status='running'` guard (task 14 — the child exit handler's safety
// net must never clobber a run that already resolved). computeSyncStartDate
// (decision #7) is a pure function, covered separately in
// tests/unit/sync-window.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import {
  getLatestSyncRunByConnection,
  getSyncRun,
  markSyncRunFailed,
  startSyncRun,
} from "@/domain/sync-promotion";
import { cleanupOwners, elevatedPool, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface Fixture {
  userId: string;
  connectionId: string;
}

async function freshFixture(label: string): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId } = await createUser(email, password, SIGNUP_TOKEN!);
  const credentialKey = await enrollTestCredentialKey(userId);
  const { id: connectionId } = await createConnection(
    userId,
    "leumi",
    { username: "dana", password: "hunter2" },
    credentialKey,
  );
  return { userId, connectionId };
}

/** Backdates a sync_runs row's window_start via the elevated (RLS-bypassing)
 * pool — the only way to simulate "an orphaned run from 20 minutes ago"
 * without actually waiting 15 minutes. */
async function backdateWindowStart(syncRunId: string, minutesAgo: number): Promise<void> {
  await elevatedPool.query(
    `UPDATE sync_runs SET window_start = now() - ($2 || ' minutes')::interval WHERE id = $1`,
    [syncRunId, minutesAgo],
  );
}

describe("domain/sync-promotion — getSyncRun / markSyncRunFailed", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  it("getSyncRun returns a fresh 'running' row unchanged", async () => {
    const fx = await freshFixture("syncrun-fresh");
    createdUserIds.push(fx.userId);

    const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
    const run = await getSyncRun(fx.userId, syncRunId);

    expect(run).not.toBeNull();
    expect(run!.status).toBe("running");
    expect(run!.connectionId).toBe(fx.connectionId);
    expect(run!.error).toBeNull();
  });

  it("getSyncRun returns null for a nonexistent or cross-tenant id", async () => {
    const fx = await freshFixture("syncrun-missing");
    createdUserIds.push(fx.userId);

    const run = await getSyncRun(fx.userId, randomUUID());
    expect(run).toBeNull();
  });

  it("self-heals a 'running' row older than 15 minutes to 'failed' on read (task 19)", async () => {
    const fx = await freshFixture("syncrun-orphaned");
    createdUserIds.push(fx.userId);

    const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
    await backdateWindowStart(syncRunId, 20);

    const run = await getSyncRun(fx.userId, syncRunId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("failed");
    expect(run!.error).toMatch(/orphaned/i);
    expect(run!.windowEnd).not.toBeNull();

    // Reading again must be stable — no re-triggering, no double-write.
    const runAgain = await getSyncRun(fx.userId, syncRunId);
    expect(runAgain!.status).toBe("failed");
    expect(runAgain!.error).toBe(run!.error);
  });

  it("does NOT self-heal a 'running' row younger than 15 minutes", async () => {
    const fx = await freshFixture("syncrun-young");
    createdUserIds.push(fx.userId);

    const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
    await backdateWindowStart(syncRunId, 5);

    const run = await getSyncRun(fx.userId, syncRunId);
    expect(run!.status).toBe("running");
  });

  it("markSyncRunFailed writes 'failed' on a genuinely running row", async () => {
    const fx = await freshFixture("syncrun-markfailed");
    createdUserIds.push(fx.userId);

    const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
    await markSyncRunFailed(fx.userId, syncRunId, "boom");

    const run = await getSyncRun(fx.userId, syncRunId);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("boom");
  });

  it("markSyncRunFailed is a no-op guarded by WHERE status='running' — never clobbers an already-resolved run (task 14's exit-handler safety net)", async () => {
    const fx = await freshFixture("syncrun-guard");
    createdUserIds.push(fx.userId);

    const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
    await markSyncRunFailed(fx.userId, syncRunId, "first failure, the real one");

    // Simulates the sync route's child `exit` handler firing a second time
    // (e.g. after the child's own catch already recorded the real failure)
    // — this call must not overwrite the original error.
    await markSyncRunFailed(fx.userId, syncRunId, "second call, must be ignored");

    const run = await getSyncRun(fx.userId, syncRunId);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("first failure, the real one");
  });

  it("getLatestSyncRunByConnection returns the newest run per connection, carrying its error", async () => {
    const fx = await freshFixture("syncrun-latest");
    createdUserIds.push(fx.userId);

    const older = await startSyncRun(fx.userId, fx.connectionId);
    await markSyncRunFailed(fx.userId, older, "the older failure");
    // created_at is `now()` at statement time; nudge the first row back so
    // the ordering is unambiguous rather than resolution-dependent.
    await elevatedPool.query(
      `UPDATE sync_runs SET created_at = now() - interval '1 hour' WHERE id = $1`,
      [older],
    );
    const newer = await startSyncRun(fx.userId, fx.connectionId);
    await markSyncRunFailed(fx.userId, newer, "GENERIC: Navigation timeout of 30000 ms exceeded");

    const byConnection = await getLatestSyncRunByConnection(fx.userId);
    const latest = byConnection[fx.connectionId];
    expect(latest!.id).toBe(newer);
    expect(latest!.status).toBe("failed");
    expect(latest!.error).toBe("GENERIC: Navigation timeout of 30000 ms exceeded");
  });

  it("getLatestSyncRunByConnection is RLS-scoped — another user's runs never appear", async () => {
    const mine = await freshFixture("syncrun-latest-mine");
    const theirs = await freshFixture("syncrun-latest-theirs");
    createdUserIds.push(mine.userId, theirs.userId);

    await startSyncRun(theirs.userId, theirs.connectionId);

    const byConnection = await getLatestSyncRunByConnection(mine.userId);
    expect(byConnection[theirs.connectionId]).toBeUndefined();
    expect(Object.keys(byConnection)).toHaveLength(0);
  });
});
