// HTTP-layer tests for DELETE /api/account (issue #31). The handler is
// called directly with a real `NextRequest` against real Postgres and real
// sessions — nothing is mocked, same convention as
// tests/db/passkey-routes.test.ts.
//
// The row-level "deleted everything, and only this user's everything"
// guarantees live in tests/db/account-deletion.test.ts. What this file covers
// is the edge: every gate that decides a request never reaches the domain,
// and the cookie teardown that the domain layer cannot do from where it sits.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createUser } from "@/domain/registration";
import { SESSION_COOKIE } from "@/domain/auth";
import { createSession, destroySession, getSession } from "@/lib/auth/session-store";
import { DELETE as deleteAccountRoute } from "@/app/api/account/route";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

afterAll(async () => {
  for (const id of createdSessionIds) destroySession(id);
  await cleanupOwners(createdUserIds);
});

async function freshSession(label: string): Promise<{ userId: string; sessionId: string }> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const { userId, dataKey } = await createUser(email, Buffer.from(PASSWORD, "utf8"), SIGNUP_TOKEN!);
  const sessionId = createSession(userId, dataKey, "ILS");
  createdUserIds.push(userId);
  createdSessionIds.push(sessionId);
  return { userId, sessionId };
}

function deleteRequest(opts: { sessionId?: string; body?: unknown }): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.sessionId) headers.set("cookie", `${SESSION_COOKIE}=${opts.sessionId}`);
  return new NextRequest("http://localhost:3000/api/account", {
    method: "DELETE",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("DELETE /api/account", () => {
  it("401s with no session", async () => {
    const res = await deleteAccountRoute(deleteRequest({ body: { password: PASSWORD } }));
    expect(res.status).toBe(401);
  });

  it("400s when the password field is missing", async () => {
    const { sessionId } = await freshSession("no-password");
    const res = await deleteAccountRoute(deleteRequest({ sessionId, body: {} }));
    expect(res.status).toBe(400);
  });

  it("400s on a body that isn't JSON at all", async () => {
    const { sessionId } = await freshSession("bad-body");
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`);
    const req = new NextRequest("http://localhost:3000/api/account", {
      method: "DELETE",
      headers,
      body: "not json",
    });
    expect((await deleteAccountRoute(req)).status).toBe(400);
  });

  it("401s on a wrong password and leaves the session alive", async () => {
    const { sessionId } = await freshSession("wrong-password");
    const res = await deleteAccountRoute(
      deleteRequest({ sessionId, body: { password: "not the password" } }),
    );
    expect(res.status).toBe(401);
    expect(getSession(sessionId)).not.toBeNull();
  });

  it("deletes the account, ends the session and clears the cookie", async () => {
    const { sessionId } = await freshSession("happy");
    const res = await deleteAccountRoute(
      deleteRequest({ sessionId, body: { password: PASSWORD } }),
    );

    expect(res.status).toBe(200);
    expect(getSession(sessionId)).toBeNull();

    const cookie = res.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
  });

  it("cannot delete a second user's account with the first user's session", async () => {
    // The route only ever passes `session.userId` to the domain layer, so
    // there is no id to tamper with in the request — this pins that shape.
    const victim = await freshSession("cross-victim");
    const attacker = await freshSession("cross-attacker");

    const res = await deleteAccountRoute(
      deleteRequest({ sessionId: attacker.sessionId, body: { password: PASSWORD } }),
    );
    expect(res.status).toBe(200);

    // The attacker's own account is gone; the other user's session — and
    // therefore their user row — is untouched.
    expect(getSession(attacker.sessionId)).toBeNull();
    expect(getSession(victim.sessionId)).not.toBeNull();
  });
});
