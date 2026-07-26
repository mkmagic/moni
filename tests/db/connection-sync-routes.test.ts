// HTTP-layer tests for cluster ③a's routes (tasks 14/15): POST/GET
// /api/connections, POST /api/connections/arm, POST
// /api/connections/[id]/sync, and GET /api/sync-runs/[id]. Route handlers
// are called directly (no dev server) with a real `NextRequest` against
// real Postgres, real sessions (src/lib/auth/session-store.ts), and the
// real credential-key window (src/lib/auth/cred-window.ts) — nothing here
// is mocked.
//
// Deliberately NOT exercised: the sync route's actual child-process spawn
// (a successful, armed, existing-connection POST). That would spawn a real
// `tsx scripts/scrape-worker.mts`, which immediately attempts a real
// israeli-bank-scrapers login against a real bank's site — exactly the
// integration risk task 13's "Not automated: Puppeteer against a real
// bank. Manual only" already establishes is not something to fake with a
// mock. A test that stubbed out `child_process.spawn` would prove nothing
// about the real spawn path (the plan's own warning: "a spawn test that
// never spawns proves nothing"), so this file stops at everything the
// route does BEFORE that call: auth, the 423 lock check, Zod validation,
// and the 404 lookup — the parts that are genuinely testable without
// touching a real bank.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createUser } from "@/domain/registration";
import { unlockCredentialKey } from "@/domain/auth";
import { startSyncRun } from "@/domain/sync-promotion";
import { createSession, destroySession } from "@/lib/auth/session-store";
import {
  armCredentialWindow,
  destroyCredentialWindow,
  getCredentialKey,
} from "@/lib/auth/cred-window";
import { SESSION_COOKIE } from "@/domain/auth";
import {
  GET as listConnectionsRoute,
  POST as createConnectionRoute,
} from "@/app/api/connections/route";
import { POST as armRoute } from "@/app/api/connections/arm/route";
import { POST as syncRoute } from "@/app/api/connections/[id]/sync/route";
import { GET as syncRunStatusRoute } from "@/app/api/sync-runs/[id]/route";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

interface TestSession {
  userId: string;
  sessionId: string;
}

async function freshSession(label: string): Promise<TestSession> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from(PASSWORD, "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  const sessionId = createSession(userId, dataKey, "ILS");
  return { userId, sessionId };
}

/** Arms the credential window directly through the domain layer, bypassing
 * HTTP — used by tests that need an armed window as setup, not as the
 * thing under test. */
async function armDirectly(session: TestSession): Promise<void> {
  const password = Buffer.from(PASSWORD, "utf8");
  const credentialKey = await unlockCredentialKey(session.userId, password);
  if (!credentialKey) throw new Error("test setup: failed to unlock credential key");
  armCredentialWindow(session.sessionId, session.userId, credentialKey);
}

function jsonRequest(
  url: string,
  opts: { method: string; sessionId?: string; body?: unknown },
): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.sessionId) headers.set("cookie", `${SESSION_COOKIE}=${opts.sessionId}`);
  return new NextRequest(url, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function paramsFor(id: string): Promise<{ id: string }> {
  return { id };
}

describe("POST/GET /api/connections", () => {
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];
  afterAll(async () => {
    for (const id of createdSessionIds) {
      destroyCredentialWindow(id);
      destroySession(id);
    }
    await cleanupOwners(createdUserIds);
  });

  it("GET is unauthorized without a session cookie", async () => {
    const res = await listConnectionsRoute(
      jsonRequest("http://localhost/api/connections", { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  it("GET returns an empty list for a fresh user, then the created connection after POST", async () => {
    const session = await freshSession("route-list");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const emptyRes = await listConnectionsRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "GET",
        sessionId: session.sessionId,
      }),
    );
    expect(emptyRes.status).toBe(200);
    expect((await emptyRes.json()).connections).toEqual([]);

    const createRes = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        body: {
          connectorId: "leumi",
          credentials: { username: "dana", password: "hunter2" },
          displayName: "My Leumi",
          password: PASSWORD,
        },
      }),
    );
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json();
    expect(typeof id).toBe("string");

    const listRes = await listConnectionsRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "GET",
        sessionId: session.sessionId,
      }),
    );
    const { connections } = await listRes.json();
    expect(connections.map((c: { id: string }) => c.id)).toContain(id);
    // Never the credentials — the route only ever returns the view shape.
    expect(JSON.stringify(connections)).not.toContain("hunter2");
  });

  it("POST arms the credential window on success (first-connect arms inline)", async () => {
    const session = await freshSession("route-armed");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    expect(getCredentialKey(session.sessionId)).toBeNull();

    const res = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        body: {
          connectorId: "leumi",
          credentials: { username: "dana", password: "hunter2" },
          password: PASSWORD,
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(getCredentialKey(session.sessionId)).not.toBeNull();
  });

  it("POST is unauthorized without a session cookie", async () => {
    const res = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        body: { connectorId: "leumi", credentials: {}, password: "x" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("POST rejects a malformed body", async () => {
    const session = await freshSession("route-badbody");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const res = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        body: { connectorId: "leumi" }, // missing credentials/password
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects an unknown connector id", async () => {
    const session = await freshSession("route-unknown-connector");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const res = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        body: { connectorId: "not-a-real-bank", credentials: { x: "y" }, password: PASSWORD },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects credentials that don't match the connector's registered fields", async () => {
    const session = await freshSession("route-badshape");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const res = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        // leumi needs {username, password} — this only has username.
        body: { connectorId: "leumi", credentials: { username: "dana" }, password: PASSWORD },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects the wrong Moni password (CK never unlocked, nothing written)", async () => {
    const session = await freshSession("route-wrongpw");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const res = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        body: {
          connectorId: "leumi",
          credentials: { username: "dana", password: "hunter2" },
          password: "definitely wrong",
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(getCredentialKey(session.sessionId)).toBeNull();
  });
});

describe("POST /api/connections/arm", () => {
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];
  afterAll(async () => {
    for (const id of createdSessionIds) {
      destroyCredentialWindow(id);
      destroySession(id);
    }
    await cleanupOwners(createdUserIds);
  });

  it("is unauthorized without a session cookie", async () => {
    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        body: { password: "x" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const session = await freshSession("arm-badbody");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body: {},
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects the wrong password", async () => {
    const session = await freshSession("arm-wrongpw");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body: { password: "wrong" },
      }),
    );
    expect(res.status).toBe(401);
    expect(getCredentialKey(session.sessionId)).toBeNull();
  });

  it("arms the window on the correct password", async () => {
    const session = await freshSession("arm-ok");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body: { password: PASSWORD },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(getCredentialKey(session.sessionId)).not.toBeNull();
  });
});

describe("POST /api/connections/[id]/sync", () => {
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];
  afterAll(async () => {
    for (const id of createdSessionIds) {
      destroyCredentialWindow(id);
      destroySession(id);
    }
    await cleanupOwners(createdUserIds);
  });

  it("is unauthorized without a session cookie", async () => {
    const id = randomUUID();
    const res = await syncRoute(
      jsonRequest(`http://localhost/api/connections/${id}/sync`, { method: "POST" }),
      {
        params: paramsFor(id),
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 423 credential_window_locked when the window isn't armed", async () => {
    const session = await freshSession("sync-locked");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const id = randomUUID();
    const res = await syncRoute(
      jsonRequest(`http://localhost/api/connections/${id}/sync`, {
        method: "POST",
        sessionId: session.sessionId,
      }),
      { params: paramsFor(id) },
    );
    expect(res.status).toBe(423);
    expect((await res.json()).error).toBe("credential_window_locked");
  });

  it("returns 404 for a nonexistent connection even when armed", async () => {
    const session = await freshSession("sync-notfound");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);
    await armDirectly(session);

    const id = randomUUID();
    const res = await syncRoute(
      jsonRequest(`http://localhost/api/connections/${id}/sync`, {
        method: "POST",
        sessionId: session.sessionId,
      }),
      { params: paramsFor(id) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed connection id (not a uuid)", async () => {
    const session = await freshSession("sync-badid");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);
    await armDirectly(session);

    const res = await syncRoute(
      jsonRequest(`http://localhost/api/connections/not-a-uuid/sync`, {
        method: "POST",
        sessionId: session.sessionId,
      }),
      { params: paramsFor("not-a-uuid") },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sync-runs/[id]", () => {
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];
  afterAll(async () => {
    for (const id of createdSessionIds) {
      destroyCredentialWindow(id);
      destroySession(id);
    }
    await cleanupOwners(createdUserIds);
  });

  it("is unauthorized without a session cookie", async () => {
    const id = randomUUID();
    const res = await syncRunStatusRoute(
      jsonRequest(`http://localhost/api/sync-runs/${id}`, { method: "GET" }),
      {
        params: paramsFor(id),
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for a nonexistent sync run", async () => {
    const session = await freshSession("syncrun-notfound");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const id = randomUUID();
    const res = await syncRunStatusRoute(
      jsonRequest(`http://localhost/api/sync-runs/${id}`, {
        method: "GET",
        sessionId: session.sessionId,
      }),
      { params: paramsFor(id) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed sync-run id", async () => {
    const session = await freshSession("syncrun-badid");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    const res = await syncRunStatusRoute(
      jsonRequest(`http://localhost/api/sync-runs/not-a-uuid`, {
        method: "GET",
        sessionId: session.sessionId,
      }),
      { params: paramsFor("not-a-uuid") },
    );
    expect(res.status).toBe(400);
  });

  it("returns the run's status for a real running sync_runs row", async () => {
    const session = await freshSession("syncrun-ok");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);
    await armDirectly(session);

    // Create a real connection first (sync_runs.connection_id is a
    // composite FK to connections(owner_id, id)) via the arm route's same
    // credential key, then startSyncRun directly — no HTTP spawn involved.
    const createRes = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        body: {
          connectorId: "leumi",
          credentials: { username: "dana", password: "hunter2" },
          password: PASSWORD,
        },
      }),
    );
    const { id: connectionId } = await createRes.json();
    const syncRunId = await startSyncRun(session.userId, connectionId);

    const res = await syncRunStatusRoute(
      jsonRequest(`http://localhost/api/sync-runs/${syncRunId}`, {
        method: "GET",
        sessionId: session.sessionId,
      }),
      { params: paramsFor(syncRunId) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(syncRunId);
    expect(body.status).toBe("running");
    expect(body.connectionId).toBe(connectionId);
  });
});
