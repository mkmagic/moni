import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { createUser } from "@/domain/registration";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const createdUserIds: string[] = [];

afterAll(async () => cleanupOwners(createdUserIds));

function request(email: string, password: string, source: string): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": source },
    body: JSON.stringify({ email, password }),
  });
}

describe("POST /api/auth/login abuse protection", () => {
  it("keeps unknown-user and wrong-password responses non-enumerating", async () => {
    const email = `login-${randomUUID()}@test.moni`;
    const password = Buffer.from("correct horse battery staple", "utf8");
    const { userId } = await createUser(email, password, SIGNUP_TOKEN);
    password.fill(0);
    createdUserIds.push(userId);

    const wrong = await loginRoute(request(email, "wrong password", "192.0.2.10"));
    const unknown = await loginRoute(
      request(`missing-${randomUUID()}@test.moni`, "wrong password", "192.0.2.11"),
    );

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it("backs off repeated failures from one source before more Argon2 work", async () => {
    const source = "192.0.2.20";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await loginRoute(
        request(`missing-${randomUUID()}@test.moni`, "wrong password", source),
      );
      expect(response.status).toBe(401);
    }

    const blocked = await loginRoute(
      request(`missing-${randomUUID()}@test.moni`, "wrong password", source),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect(await blocked.json()).toEqual({ error: "try again later" });
  });
});
