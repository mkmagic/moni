import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const children = vi.hoisted(
  (): Array<
    EventEmitter & {
      stdin: { write: (value: Buffer, cb?: () => void) => void; end: () => void };
      frame?: Buffer;
      written?: Buffer;
      kill: (signal?: NodeJS.Signals) => boolean;
    }
  > => [],
);
const spawnFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:child_process", () => ({
  spawn: () => {
    if (spawnFailure.enabled) throw new Error("spawn must not leak");
    const child: (typeof children)[number] = Object.assign(new EventEmitter(), {
      stdin: {
        write: (value: Buffer, cb?: () => void) => {
          child.written = value;
          child.frame = Buffer.from(value);
          cb?.();
        },
        end: () => undefined,
      },
      kill: () => true,
    });
    children.push(child);
    return child;
  },
}));

import { createUser } from "@/domain/registration";
import { createConnection, getDecryptedCredentials } from "@/domain/connections";
import { startSyncRun } from "@/domain/sync-promotion";
import { createSession, destroySession } from "@/lib/auth/session-store";
import { armCredentialWindow, destroyCredentialWindow } from "@/lib/auth/cred-window";
import { decodeBinaryChildFrame } from "@/lib/connectors";
import { SESSION_COOKIE } from "@/domain/auth";
import { GET as overview } from "@/app/api/investments/overview/route";
import { GET as holdings } from "@/app/api/investments/holdings/route";
import { GET as history } from "@/app/api/investments/history/route";
import { GET as snapshot } from "@/app/api/investments/snapshots/[week]/route";
import { POST as createConnectionRoute } from "@/app/api/connections/route";
import { POST as sync } from "@/app/api/connections/[id]/sync/route";
import { POST as archive } from "@/app/api/accounts/[id]/archive/route";
import { POST as refreshQuotes } from "@/app/api/investments/quotes/refresh/route";
import { PATCH as connectionPatch } from "@/app/api/connections/[id]/route";
import { WORKER_TIMEOUT_MS } from "@/lib/investments/route-orchestration";
import { spawnInvestmentSyncWorker } from "@/lib/investments/route-orchestration";
import { startConnectionSync } from "@/lib/sync-client";
import { cleanupOwners, elevatedDb, enrollTestCredentialKey } from "./helpers";
import * as schema from "@/db/schema";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN!;
const PASSWORD = "correct horse battery staple";
type TestSession = { userId: string; sessionId: string; dataKey: Buffer; credentialKey: Buffer };

async function fresh(label: string): Promise<TestSession> {
  const { userId, dataKey } = await createUser(
    `${label}-${randomUUID()}@test.moni`,
    Buffer.from(PASSWORD),
    SIGNUP_TOKEN,
  );
  const sessionId = createSession(userId, dataKey, "ILS");
  const credentialKey = await enrollTestCredentialKey(userId);
  return { userId, sessionId, dataKey, credentialKey };
}
function request(url: string, sessionId?: string, body?: unknown, method = "GET"): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`);
  return new NextRequest(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function params(id: string): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

describe("investment route flows", () => {
  const owners: string[] = [];
  const sessions: TestSession[] = [];
  afterAll(async () => {
    for (const session of sessions) {
      destroyCredentialWindow(session.sessionId);
      destroySession(session.sessionId);
      session.credentialKey.fill(0);
    }
    await cleanupOwners(owners);
  });

  it("validates and RLS-scopes all portfolio read routes", async () => {
    expect((await overview(request("http://localhost/api/investments/overview"))).status).toBe(401);
    const session = await fresh("investment-reads");
    owners.push(session.userId);
    sessions.push(session);
    expect(
      (
        await overview(
          request("http://localhost/api/investments/overview?bad=1", session.sessionId),
        )
      ).status,
    ).toBe(400);
    expect(
      (await overview(request("http://localhost/api/investments/overview", session.sessionId)))
        .status,
    ).toBe(200);
    expect(
      (
        await history(
          request(
            "http://localhost/api/investments/history?start=2026-02-30&end=2026-03-01",
            session.sessionId,
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await holdings(
          request("http://localhost/api/investments/holdings?connectionId=bad", session.sessionId),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await holdings(
          request("http://localhost/api/investments/holdings?limit=201", session.sessionId),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await holdings(
          request("http://localhost/api/investments/holdings?cursor=tampered", session.sessionId),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await history(
          request(
            "http://localhost/api/investments/history?start=2026-02-01&end=2026-01-01",
            session.sessionId,
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await history(
          request(
            "http://localhost/api/investments/history?start=2026-01-01&end=2026-02-01&groupBy=account",
            session.sessionId,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await snapshot(
          request("http://localhost/api/investments/snapshots/not-a-week", session.sessionId),
          { params: Promise.resolve({ week: "not-a-week" }) },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await snapshot(
          request(
            "http://localhost/api/investments/snapshots/2026-01-25?limit=50",
            session.sessionId,
          ),
          { params: Promise.resolve({ week: "2026-01-25" }) },
        )
      ).status,
    ).toBe(200);
  });

  it("rejects unauthenticated quote refreshes", async () => {
    children.length = 0;
    expect(
      (
        await refreshQuotes(
          request("http://localhost/api/investments/quotes/refresh", undefined, {}, "POST"),
        )
      ).status,
    ).toBe(401);
    expect(children).toHaveLength(0);
  });

  it("makes quote refresh a local no-op without explicitly authorized Tiingo configuration", async () => {
    const session = await fresh("quote-refresh-no-config");
    owners.push(session.userId);
    sessions.push(session);
    const previousToken = process.env.MONI_TIINGO_TOKEN;
    const previousAuthorization = process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED;
    delete process.env.MONI_TIINGO_TOKEN;
    process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED = "true";
    children.length = 0;
    try {
      const response = await refreshQuotes(
        request("http://localhost/api/investments/quotes/refresh", session.sessionId, {}, "POST"),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ refreshed: false });
      expect(children).toHaveLength(0);
    } finally {
      if (previousToken === undefined) delete process.env.MONI_TIINGO_TOKEN;
      else process.env.MONI_TIINGO_TOKEN = previousToken;
      if (previousAuthorization === undefined) delete process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED;
      else process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED = previousAuthorization;
    }
  });

  it("frames authorized quote refresh secrets, wipes parent buffers, and returns worker success", async () => {
    const session = await fresh("quote-refresh-success");
    owners.push(session.userId);
    sessions.push(session);
    const previousToken = process.env.MONI_TIINGO_TOKEN;
    const previousAuthorization = process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED;
    process.env.MONI_TIINGO_TOKEN = "test-tiingo-token";
    process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED = "true";
    children.length = 0;
    try {
      const response = refreshQuotes(
        request("http://localhost/api/investments/quotes/refresh", session.sessionId, {}, "POST"),
      );
      const child = children.at(-1)!;
      const frame = decodeBinaryChildFrame(child.frame!);
      expect(frame.metadata).toEqual({ userId: session.userId });
      expect(frame.segments).toHaveLength(2);
      expect(frame.segments[1].toString()).toBe("test-tiingo-token");
      expect(child.written!.every((byte) => byte === 0)).toBe(true);
      for (const segment of frame.segments) segment.fill(0);
      child.emit("close", 0, null);
      expect((await response).status).toBe(200);
    } finally {
      if (previousToken === undefined) delete process.env.MONI_TIINGO_TOKEN;
      else process.env.MONI_TIINGO_TOKEN = previousToken;
      if (previousAuthorization === undefined) delete process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED;
      else process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED = previousAuthorization;
    }
  });

  it("returns a safe failure response when the quote worker fails or times out", async () => {
    const session = await fresh("quote-refresh-failure");
    owners.push(session.userId);
    sessions.push(session);
    const previousToken = process.env.MONI_TIINGO_TOKEN;
    const previousAuthorization = process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED;
    process.env.MONI_TIINGO_TOKEN = "test-tiingo-token";
    process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED = "true";
    try {
      children.length = 0;
      const failed = refreshQuotes(
        request("http://localhost/api/investments/quotes/refresh", session.sessionId, {}, "POST"),
      );
      children.at(-1)!.emit("error", new Error("provider details must not leak"));
      expect((await failed).status).toBe(502);

      vi.useFakeTimers();
      children.length = 0;
      const timedOut = refreshQuotes(
        request("http://localhost/api/investments/quotes/refresh", session.sessionId, {}, "POST"),
      );
      await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS);
      expect((await timedOut).status).toBe(502);
      expect(children.at(-1)!.written!.every((byte) => byte === 0)).toBe(true);
    } finally {
      vi.useRealTimers();
      if (previousToken === undefined) delete process.env.MONI_TIINGO_TOKEN;
      else process.env.MONI_TIINGO_TOKEN = previousToken;
      if (previousAuthorization === undefined) delete process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED;
      else process.env.MONI_TIINGO_MULTI_USER_AUTHORIZED = previousAuthorization;
    }
  });

  it("dispatches IBKR and Schwab only in their registered modes and keeps source bytes in segments", async () => {
    const session = await fresh("investment-dispatch");
    owners.push(session.userId);
    sessions.push(session);
    const { id: ibkr } = await createConnection(
      session.userId,
      "ibkr_flex",
      { flexToken: "token", queryId: "query" },
      session.credentialKey,
    );
    const { id: schwab } = await createConnection(
      session.userId,
      "schwab_positions_csv",
      null,
      null,
    );
    armCredentialWindow(session.sessionId, session.userId, session.credentialKey);
    children.length = 0;
    const ibkrRes = await sync(
      request(`http://localhost/api/connections/${ibkr}/sync`, session.sessionId, {}, "POST"),
      { params: params(ibkr) },
    );
    expect(ibkrRes.status).toBe(202);
    const ibkrChild = children.at(-1)!;
    const ibkrFrame = decodeBinaryChildFrame(ibkrChild.frame!);
    expect(ibkrFrame.metadata).toMatchObject({ connectionId: ibkr });
    expect(ibkrFrame.segments).toHaveLength(3);
    expect(ibkrFrame.segments.slice(1).map((part) => part.toString())).toEqual(["token", "query"]);
    for (const part of ibkrFrame.segments) part.fill(0);
    ibkrChild.emit("close", 0, null);
    expect(
      (
        await sync(
          request(`http://localhost/api/connections/${schwab}/sync`, session.sessionId, {}, "POST"),
          { params: params(schwab) },
        )
      ).status,
    ).toBe(400);
    const form = new FormData();
    form.set("valuationCurrency", "USD");
    form.set("file", new File(["Symbol,Quantity\n"], "positions.csv", { type: "text/csv" }));
    const importReq = new NextRequest(`http://localhost/api/connections/${schwab}/sync`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session.sessionId}` },
      body: form,
    });
    const schwabRes = await sync(importReq, { params: params(schwab) });
    expect(schwabRes.status).toBe(202);
    const schwabFrame = decodeBinaryChildFrame(children.at(-1)!.frame!);
    expect(schwabFrame.metadata).toMatchObject({ valuationCurrency: "USD", connectionId: schwab });
    expect(schwabFrame.segments).toHaveLength(2);
    expect(schwabFrame.segments[1].toString()).toContain("Symbol,Quantity");
    for (const part of schwabFrame.segments) part.fill(0);
    children.at(-1)!.emit("close", 0, null);
  });

  it("rejects oversized or disconnected imports before spawning", async () => {
    const session = await fresh("import-boundary");
    owners.push(session.userId);
    sessions.push(session);
    const { id } = await createConnection(session.userId, "schwab_positions_csv", null, null);
    const oversized = new FormData();
    oversized.set("valuationCurrency", "USD");
    oversized.set("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "positions.csv"));
    children.length = 0;
    expect(
      (
        await sync(
          new NextRequest(`http://localhost/api/connections/${id}/sync`, {
            method: "POST",
            headers: { cookie: `${SESSION_COOKIE}=${session.sessionId}` },
            body: oversized,
          }),
          { params: params(id) },
        )
      ).status,
    ).toBe(400);
    expect(children).toHaveLength(0);
    expect(
      (
        await connectionPatch(
          request(
            `http://localhost/api/connections/${id}`,
            session.sessionId,
            { disconnect: true },
            "PATCH",
          ),
          { params: params(id) },
        )
      ).status,
    ).toBe(200);
    const importAfterDisconnect = new FormData();
    importAfterDisconnect.set("valuationCurrency", "USD");
    importAfterDisconnect.set("file", new File(["header\n"], "positions.csv"));
    expect(
      (
        await sync(
          new NextRequest(`http://localhost/api/connections/${id}/sync`, {
            method: "POST",
            headers: { cookie: `${SESSION_COOKIE}=${session.sessionId}` },
            body: importAfterDisconnect,
          }),
          { params: params(id) },
        )
      ).status,
    ).toBe(409);
    expect(children).toHaveLength(0);
  });

  it("fails an already-created investment run safely when child start throws and wipes owned buffers", async () => {
    const session = await fresh("sync-start-failure");
    owners.push(session.userId);
    sessions.push(session);
    const { id: ibkr } = await createConnection(
      session.userId,
      "ibkr_flex",
      { flexToken: "token", queryId: "query" },
      session.credentialKey,
    );
    armCredentialWindow(session.sessionId, session.userId, session.credentialKey);
    children.length = 0;
    spawnFailure.enabled = true;
    try {
      const response = await sync(
        request(`http://localhost/api/connections/${ibkr}/sync`, session.sessionId, {}, "POST"),
        { params: params(ibkr) },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "sync_unavailable" });
      expect(children).toHaveLength(0);
      const runs = await elevatedDb
        .select({ status: schema.syncRuns.status, error: schema.syncRuns.error })
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.connectionId, ibkr));
      expect(runs).toEqual([{ status: "failed", error: "source_worker_start_failed" }]);

      const runId = await startSyncRun(session.userId, ibkr);
      const key = Buffer.from("owned-key");
      const source = Buffer.from("owned-source");
      await expect(
        spawnInvestmentSyncWorker({
          script: "schwab-import-worker.mts",
          metadata: { userId: session.userId, connectionId: ibkr, syncRunId: runId },
          segments: [key, source],
          userId: session.userId,
          syncRunId: runId,
        }),
      ).resolves.toBe(false);
      expect(key.every((byte) => byte === 0)).toBe(true);
      expect(source.every((byte) => byte === 0)).toBe(true);
      const failed = await elevatedDb
        .select({ status: schema.syncRuns.status, error: schema.syncRuns.error })
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.id, runId));
      expect(failed).toEqual([{ status: "failed", error: "source_worker_start_failed" }]);
    } finally {
      spawnFailure.enabled = false;
    }
  });

  it("archives owned accounts and disconnect refuses a running run while preserving accounts", async () => {
    const mine = await fresh("investment-lifecycle-mine");
    const other = await fresh("investment-lifecycle-other");
    owners.push(mine.userId, other.userId);
    sessions.push(mine, other);
    const { id: connectionId } = await createConnection(
      mine.userId,
      "leumi",
      { username: "user", password: "secret" },
      mine.credentialKey,
    );
    const [account] = await elevatedDb
      .insert(schema.accounts)
      .values({
        ownerId: mine.userId,
        connectionId,
        accountType: "investment",
        classification: "asset",
        nameCt: Buffer.from("name"),
        currency: "USD",
        currentBalanceCt: null,
      })
      .returning({ id: schema.accounts.id });
    expect(
      (
        await archive(
          request(
            `http://localhost/api/accounts/${account.id}/archive`,
            other.sessionId,
            {},
            "POST",
          ),
          { params: params(account.id) },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await archive(
          request(
            `http://localhost/api/accounts/${account.id}/archive`,
            mine.sessionId,
            {},
            "POST",
          ),
          { params: params(account.id) },
        )
      ).status,
    ).toBe(200);
    const archived = await elevatedDb
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id));
    expect(archived[0]!.status).toBe("archived");
    expect(archived[0]!.archivedAt).not.toBeNull();
    const [ordinary] = await elevatedDb
      .insert(schema.accounts)
      .values({
        ownerId: mine.userId,
        connectionId,
        accountType: "checking",
        classification: "asset",
        nameCt: Buffer.from("ordinary"),
        currency: "ILS",
        currentBalanceCt: Buffer.from("0"),
      })
      .returning({ id: schema.accounts.id });
    expect(
      (
        await archive(
          request(
            `http://localhost/api/accounts/${ordinary.id}/archive`,
            mine.sessionId,
            {},
            "POST",
          ),
          { params: params(ordinary.id) },
        )
      ).status,
    ).toBe(404);
    const running = await startSyncRun(mine.userId, connectionId);
    expect(
      (
        await connectionPatch(
          request(
            `http://localhost/api/connections/${connectionId}`,
            mine.sessionId,
            { disconnect: true },
            "PATCH",
          ),
          { params: params(connectionId) },
        )
      ).status,
    ).toBe(409);
    await elevatedDb
      .update(schema.syncRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.syncRuns.id, running));
    expect(
      (
        await connectionPatch(
          request(
            `http://localhost/api/connections/${connectionId}`,
            mine.sessionId,
            { disconnect: true },
            "PATCH",
          ),
          { params: params(connectionId) },
        )
      ).status,
    ).toBe(200);
    await expect(
      getDecryptedCredentials(mine.userId, connectionId, mine.credentialKey),
    ).rejects.toThrow();
    expect(
      (
        await elevatedDb.select().from(schema.accounts).where(eq(schema.accounts.id, account.id))
      ).map((row) => row.id),
    ).toEqual([account.id]);
  });

  it("reports manual sources as file-required and fetches credentialed sources", async () => {
    expect(await startConnectionSync({ id: "manual", mode: "user_mediated_import" })).toEqual({
      kind: "file_required",
    });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ syncRunId: "run" }), { status: 202 }));
    expect(await startConnectionSync({ id: "fetchable", mode: "credentialed_fetch" })).toEqual({
      kind: "started",
      syncRunId: "run",
    });
    fetcher.mockRestore();
  });

  it("rejects unknown create and patch fields", async () => {
    const session = await fresh("strict-input");
    owners.push(session.userId);
    sessions.push(session);
    armCredentialWindow(session.sessionId, session.userId, session.credentialKey);
    expect(
      (
        await createConnectionRoute(
          request(
            "http://localhost/api/connections",
            session.sessionId,
            { connectorId: "leumi", credentials: { username: "a", password: "b" }, extra: true },
            "POST",
          ),
        )
      ).status,
    ).toBe(400);
  });
});
