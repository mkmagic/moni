// HTTP-layer tests for the passkey enrollment routes (issue #7): POST
// /api/passkeys/options and POST /api/passkeys. Route handlers are called
// directly with a real `NextRequest` against real Postgres, real sessions
// and the real credential-key window — nothing is mocked.
//
// Deliberately NOT exercised: a successful enrollment. That needs a real
// authenticator to produce a signed attestation plus a PRF output, and a
// faked one would only prove that a fake verifies — the same reasoning
// connection-sync-routes.test.ts applies to the real-bank scrape. The
// success path is covered where it can be honestly covered: at the domain
// seam, which takes opaque bytes (tests/db/credential-unlock.test.ts).
// What is testable at the edge is every gate that decides a request never
// reaches the domain, and that is what this file covers.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createUser } from "@/domain/registration";
import { SESSION_COOKIE } from "@/domain/auth";
import { createSession, destroySession } from "@/lib/auth/session-store";
import { armCredentialWindow, destroyCredentialWindow } from "@/lib/auth/cred-window";
import { POST as optionsRoute } from "@/app/api/passkeys/options/route";
import { POST as enrollRoute } from "@/app/api/passkeys/route";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

afterAll(async () => {
  for (const id of createdSessionIds) {
    destroyCredentialWindow(id);
    destroySession(id);
  }
  await cleanupOwners(createdUserIds);
});

async function freshSession(label: string): Promise<{ userId: string; sessionId: string }> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from(PASSWORD, "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  const sessionId = createSession(userId, dataKey, "ILS");
  createdUserIds.push(userId);
  createdSessionIds.push(sessionId);
  return { userId, sessionId };
}

function jsonRequest(url: string, opts: { sessionId?: string; body?: unknown }): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.sessionId) headers.set("cookie", `${SESSION_COOKIE}=${opts.sessionId}`);
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const OPTIONS_URL = "http://localhost/api/passkeys/options";
const ENROLL_URL = "http://localhost/api/passkeys";

describe("POST /api/passkeys/options", () => {
  it("is unauthorized without a session cookie", async () => {
    const res = await optionsRoute(jsonRequest(OPTIONS_URL, {}));
    expect(res.status).toBe(401);
  });

  it("issues both ceremony challenges for a user with no passkey yet", async () => {
    const session = await freshSession("pk-options-first");

    const res = await optionsRoute(jsonRequest(OPTIONS_URL, { sessionId: session.sessionId }));
    expect(res.status).toBe(200);
    const { registrationOptions, activationOptions } = await res.json();
    // Both halves in one round trip: the create proves PRF support, the get
    // produces the output that actually wraps CK.
    expect(registrationOptions.challenge).toBeTruthy();
    expect(activationOptions.challenge).toBeTruthy();
    expect(registrationOptions.challenge).not.toBe(activationOptions.challenge);
    expect(registrationOptions.excludeCredentials).toHaveLength(0);
    expect(registrationOptions.authenticatorSelection.userVerification).toBe("required");
  });

  it("refuses to start a second enrollment while the credential window is locked", async () => {
    const session = await freshSession("pk-options-locked");
    const credentialKey = await enrollTestCredentialKey(session.userId);
    credentialKey.fill(0);

    const res = await optionsRoute(jsonRequest(OPTIONS_URL, { sessionId: session.sessionId }));
    // Refused here rather than at POST /api/passkeys, which consumes the
    // challenges single-use: a 423 there would cost two biometric prompts
    // and leave nothing to retry with.
    expect(res.status).toBe(423);
    expect((await res.json()).error).toBe("credential_window_locked");
  });

  it("starts a second enrollment once the window is armed, excluding the enrolled passkey", async () => {
    const session = await freshSession("pk-options-armed");
    const credentialKey = await enrollTestCredentialKey(session.userId);
    armCredentialWindow(session.sessionId, session.userId, credentialKey);

    const res = await optionsRoute(jsonRequest(OPTIONS_URL, { sessionId: session.sessionId }));
    expect(res.status).toBe(200);
    const { registrationOptions } = await res.json();
    // Without this the provider would silently replace the passkey that is
    // the only thing holding CK.
    expect(registrationOptions.excludeCredentials).toHaveLength(1);
  });
});

describe("POST /api/passkeys", () => {
  it("is unauthorized without a session cookie", async () => {
    const res = await enrollRoute(jsonRequest(ENROLL_URL, { body: {} }));
    expect(res.status).toBe(401);
  });

  it("rejects an enrollment with no challenge outstanding", async () => {
    const session = await freshSession("pk-enroll-nochallenge");

    const res = await enrollRoute(
      jsonRequest(ENROLL_URL, { sessionId: session.sessionId, body: {} }),
    );
    // The challenge check comes before the body is even parsed, so a
    // replayed or fabricated ceremony never reaches verification.
    expect(res.status).toBe(400);
  });

  it("consumes the challenge even when the body is junk, so it cannot be retried", async () => {
    const session = await freshSession("pk-enroll-singleuse");
    await optionsRoute(jsonRequest(OPTIONS_URL, { sessionId: session.sessionId }));

    const first = await enrollRoute(
      jsonRequest(ENROLL_URL, { sessionId: session.sessionId, body: { label: "x" } }),
    );
    expect(first.status).toBe(400);

    const second = await enrollRoute(
      jsonRequest(ENROLL_URL, { sessionId: session.sessionId, body: { label: "x" } }),
    );
    expect(second.status).toBe(400);
    expect((await second.json()).error).toBe("enrollment expired — start again");
  });
});
