// HTTP-layer test for task 16's POST /api/auth/signup — the route wraps
// createUser() (already covered end-to-end by tests/db/registration.test.ts)
// with the HTTP/session concerns: Zod at the boundary, the auto-login
// cookie, and the three failure statuses (400 malformed body, 403 bad
// signup token, 409 duplicate email). The route takes a plain `Request` and
// sets its session cookie via `NextResponse.cookies` (never `next/headers`'s
// `cookies()`), so — like the login route — it's callable directly, no live
// Next request scope needed.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { SESSION_COOKIE } from "@/domain/auth";
import { destroySession, getSession } from "@/lib/auth/session-store";
import { decryptField, encryptField } from "@/lib/crypto";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

function freshEmail(label: string): string {
  return `${label}-${randomUUID()}@test.moni`;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/signup", () => {
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];

  afterAll(async () => {
    for (const id of createdSessionIds) destroySession(id);
    await cleanupOwners(createdUserIds);
  });

  it("creates a user, auto-logs in, and the session can decrypt a Tier-1 field", async () => {
    const email = freshEmail("signup");
    const res = await signupRoute(
      jsonRequest({
        email,
        password: "correct horse battery staple",
        signupToken: SIGNUP_TOKEN,
      }),
    );
    expect(res.status).toBe(201);

    const sessionId = res.cookies.get(SESSION_COOKIE)?.value;
    expect(sessionId).toBeTruthy();
    createdSessionIds.push(sessionId!);

    const session = getSession(sessionId);
    expect(session).not.toBeNull();
    createdUserIds.push(session!.userId);

    // No second Argon2id derivation happened — the session's data key is
    // usable right away, exactly what createUser() returned.
    const rowId = randomUUID();
    const ciphertext = encryptField(session!.dataKey, Buffer.from("hello", "utf8"), {
      rowId,
      column: "test_ct",
      version: 1,
    });
    const decrypted = decryptField(session!.dataKey, ciphertext, {
      rowId,
      column: "test_ct",
      version: 1,
    });
    expect(decrypted.toString("utf8")).toBe("hello");
  });

  it("rejects a malformed body with 400", async () => {
    const res = await signupRoute(jsonRequest({ email: "not-an-email", password: "short" }));
    expect(res.status).toBe(400);
  });

  it("rejects a wrong signup token with 403", async () => {
    const res = await signupRoute(
      jsonRequest({
        email: freshEmail("bad-token"),
        password: "correct horse battery staple",
        signupToken: "definitely-wrong",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a duplicate email with 409", async () => {
    const email = freshEmail("dup");
    const first = await signupRoute(
      jsonRequest({ email, password: "correct horse battery staple", signupToken: SIGNUP_TOKEN }),
    );
    expect(first.status).toBe(201);
    const firstSessionId = first.cookies.get(SESSION_COOKIE)?.value;
    createdSessionIds.push(firstSessionId!);
    createdUserIds.push(getSession(firstSessionId)!.userId);

    const second = await signupRoute(
      jsonRequest({ email, password: "another password", signupToken: SIGNUP_TOKEN }),
    );
    expect(second.status).toBe(409);
  });
});
