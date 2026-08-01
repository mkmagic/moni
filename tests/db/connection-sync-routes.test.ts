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
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createUser } from "@/domain/registration";
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
import { POST as armOptionsRoute } from "@/app/api/connections/arm/options/route";
import { POST as syncRoute } from "@/app/api/connections/[id]/sync/route";
import { GET as syncRunStatusRoute } from "@/app/api/sync-runs/[id]/route";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

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

/** Enrolls a second factor and arms the credential window directly through
 * the domain layer, bypassing the WebAuthn ceremony — used by tests that
 * need an armed window as setup, not as the thing under test. */
async function armDirectly(session: TestSession): Promise<void> {
  const credentialKey = await enrollTestCredentialKey(session.userId);
  armCredentialWindow(session.sessionId, session.userId, credentialKey);
}

/** A structurally valid assertion body that will never verify — enough to
 * get past Zod so the route's own gates (credential lookup, signature
 * verification) are what decides the response. */
function fakeAssertion(credentialIdB64Url: string) {
  const b64 = randomBytes(32).toString("base64url");
  return {
    id: credentialIdB64Url,
    rawId: credentialIdB64Url,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64,
      authenticatorData: b64,
      signature: b64,
    },
  };
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

    await armDirectly(session);
    const createRes = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        body: {
          connectorId: "leumi",
          credentials: { username: "dana", password: "hunter2" },
          displayName: "My Leumi",
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

  it("POST returns 423 when the credential window is locked (CK is only reachable via a passkey)", async () => {
    const session = await freshSession("route-locked");
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
        },
      }),
    );
    expect(res.status).toBe(423);
    expect((await res.json()).error).toBe("credential_window_locked");
  });

  it("POST no longer accepts a Moni password as a way to reach CK (issue #7)", async () => {
    const session = await freshSession("route-nopassword");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);

    // The legacy extra password field is now rejected at the strict boundary;
    // it cannot influence credential-window behavior or create a connection.
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
    expect(res.status).toBe(400);
    expect(getCredentialKey(session.sessionId)).toBeNull();

    const listRes = await listConnectionsRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "GET",
        sessionId: session.sessionId,
      }),
    );
    expect((await listRes.json()).connections).toEqual([]);
  });

  it("POST is unauthorized without a session cookie", async () => {
    const res = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        body: { connectorId: "leumi", credentials: {} },
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
        body: { connectorId: "leumi" }, // missing credentials
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
        body: { connectorId: "not-a-real-bank", credentials: { x: "y" } },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects credentials that don't match the connector's registered fields", async () => {
    const session = await freshSession("route-badshape");
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);
    await armDirectly(session);

    const res = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        // leumi needs {username, password} — this only has username.
        body: { connectorId: "leumi", credentials: { username: "dana" } },
      }),
    );
    expect(res.status).toBe(400);
  });
});

// The passkey arm flow (issue #7). The SUCCESS path needs a real
// authenticator to produce a signed assertion and a PRF output, which is the
// same class of thing as the real-bank scrape this file already declines to
// fake — a stubbed authenticator would prove nothing about the ceremony. So
// these stop at everything the routes do around the verification: auth, the
// "nothing enrolled" gate, single-use challenges, and the credential lookup
// and signature checks that must reject anything not produced by an enrolled
// passkey. Enrollment itself is exercised through the production domain path
// in tests/db/credential-unlock.test.ts.
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

  async function armSession(label: string): Promise<TestSession> {
    const session = await freshSession(label);
    createdUserIds.push(session.userId);
    createdSessionIds.push(session.sessionId);
    return session;
  }

  it("is unauthorized without a session cookie", async () => {
    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        body: { assertionResponse: fakeAssertion("x"), prfSecret: "y" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("options: 409 when no passkey is enrolled — the remediation is enrolment, not re-login", async () => {
    const session = await armSession("arm-nopasskey");

    const res = await armOptionsRoute(
      jsonRequest("http://localhost/api/connections/arm/options", {
        method: "POST",
        sessionId: session.sessionId,
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_passkey_enrolled");
  });

  it("options: issues a challenge that allows only the enrolled credential", async () => {
    const session = await armSession("arm-options-ok");
    const credentialKey = await enrollTestCredentialKey(session.userId);
    credentialKey.fill(0);

    const res = await armOptionsRoute(
      jsonRequest("http://localhost/api/connections/arm/options", {
        method: "POST",
        sessionId: session.sessionId,
      }),
    );
    expect(res.status).toBe(200);
    const { authenticationOptions } = await res.json();
    expect(authenticationOptions.challenge).toBeTruthy();
    expect(authenticationOptions.allowCredentials).toHaveLength(1);
    // A client claim of "the user was verified" is worthless; the server
    // asks for UV and re-checks the flag on verify.
    expect(authenticationOptions.userVerification).toBe("required");
  });

  it("rejects an arm with no challenge outstanding", async () => {
    const session = await armSession("arm-nochallenge");
    await enrollTestCredentialKey(session.userId);

    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body: { assertionResponse: fakeAssertion("nope"), prfSecret: "z" },
      }),
    );
    expect(res.status).toBe(400);
    expect(getCredentialKey(session.sessionId)).toBeNull();
  });

  it("rejects a malformed body once a challenge is outstanding", async () => {
    const session = await armSession("arm-badbody");
    await enrollTestCredentialKey(session.userId);
    await armOptionsRoute(
      jsonRequest("http://localhost/api/connections/arm/options", {
        method: "POST",
        sessionId: session.sessionId,
      }),
    );

    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body: {},
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an assertion from a credential that isn't enrolled", async () => {
    const session = await armSession("arm-unknown-cred");
    await enrollTestCredentialKey(session.userId);
    await armOptionsRoute(
      jsonRequest("http://localhost/api/connections/arm/options", {
        method: "POST",
        sessionId: session.sessionId,
      }),
    );

    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body: {
          assertionResponse: fakeAssertion(randomBytes(16).toString("base64url")),
          prfSecret: randomBytes(32).toString("base64url"),
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(getCredentialKey(session.sessionId)).toBeNull();
  });

  it("rejects a forged assertion for an ENROLLED credential — the signature is actually checked", async () => {
    const session = await armSession("arm-forged");
    await enrollTestCredentialKey(session.userId);
    const optionsRes = await armOptionsRoute(
      jsonRequest("http://localhost/api/connections/arm/options", {
        method: "POST",
        sessionId: session.sessionId,
      }),
    );
    const { authenticationOptions } = await optionsRes.json();
    const enrolledId = authenticationOptions.allowCredentials[0].id;

    const res = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body: {
          assertionResponse: fakeAssertion(enrolledId),
          prfSecret: randomBytes(32).toString("base64url"),
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(getCredentialKey(session.sessionId)).toBeNull();
  });

  it("a challenge is single-use — replaying it after a failure is rejected", async () => {
    const session = await armSession("arm-replay");
    await enrollTestCredentialKey(session.userId);
    await armOptionsRoute(
      jsonRequest("http://localhost/api/connections/arm/options", {
        method: "POST",
        sessionId: session.sessionId,
      }),
    );

    const body = {
      assertionResponse: fakeAssertion(randomBytes(16).toString("base64url")),
      prfSecret: randomBytes(32).toString("base64url"),
    };
    const first = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body,
      }),
    );
    expect(first.status).toBe(401);

    const replay = await armRoute(
      jsonRequest("http://localhost/api/connections/arm", {
        method: "POST",
        sessionId: session.sessionId,
        body,
      }),
    );
    expect(replay.status).toBe(400);
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
    // composite FK to connections(owner_id, id)) using the window armed
    // above, then startSyncRun directly — no HTTP spawn involved.
    const createRes = await createConnectionRoute(
      jsonRequest("http://localhost/api/connections", {
        method: "POST",
        sessionId: session.sessionId,
        body: {
          connectorId: "leumi",
          credentials: { username: "dana", password: "hunter2" },
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
