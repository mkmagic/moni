// The session cookie's attributes, across all four routes that write it.
//
// WHY THIS FILE EXISTS
// A cookie is cleared by overwriting it, and the browser only treats the
// overwrite as the *same* cookie when the attributes match the ones it was
// set with. So `logout` and `account` must emit exactly what `signup` and
// `login` emit — differ in one attribute and the clear silently becomes a
// second, unrelated cookie while the real session cookie survives in the
// browser. Nothing throws, and the user stays logged in after pressing
// Log out.
//
// Before `SESSION_COOKIE_ATTRS` the four routes each carried their own copy
// of the attribute block, so that drift was one careless edit away and
// nothing in the suite would have caught it. This file asserts the four
// AGREE rather than asserting any particular value — the point is that they
// match, not that `sameSite` happens to be "lax" today.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { DELETE as deleteAccountRoute } from "@/app/api/account/route";
import { SESSION_COOKIE } from "@/domain/auth";
import { createUser } from "@/domain/registration";
import { createSession, destroySession, SESSION_TTL_SECONDS } from "@/lib/auth/session-store";
import { cleanupOwners, elevatedPool } from "./helpers";

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
  await elevatedPool.end();
});

const freshEmail = (label: string) => `${label}-${randomUUID()}@test.moni`;

/**
 * The attributes that must match between a set and a clear. `maxAge` is
 * excluded on purpose: it is the one attribute that legitimately differs (a
 * TTL when setting, 0 when clearing), and the browser does not compare it
 * when deciding which cookie an overwrite replaces.
 */
function matchAttrs(res: NextResponse) {
  const c = res.cookies.get(SESSION_COOKIE);
  if (!c) throw new Error("route did not write the session cookie");
  return { httpOnly: c.httpOnly, sameSite: c.sameSite, secure: c.secure, path: c.path };
}

const maxAgeOf = (res: NextResponse) => res.cookies.get(SESSION_COOKIE)?.maxAge;

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Runs each of the four cookie-writing routes once. */
async function writeCookieEverywhere() {
  // signup — sets, via auto-login.
  const signupEmail = freshEmail("cookie-signup");
  const signup = await signupRoute(
    jsonRequest("http://localhost/api/auth/signup", {
      email: signupEmail,
      password: PASSWORD,
      signupToken: SIGNUP_TOKEN,
    }),
  );
  const signupSessionId = signup.cookies.get(SESSION_COOKIE)?.value;
  if (signupSessionId) createdSessionIds.push(signupSessionId);
  const { rows } = await elevatedPool.query<{ id: string }>(
    `SELECT id FROM "users" WHERE email = $1`,
    [signupEmail],
  );
  createdUserIds.push(...rows.map((r) => r.id));

  // login — sets.
  const loginEmail = freshEmail("cookie-login");
  const { userId: loginUserId, dataKey } = await createUser(
    loginEmail,
    Buffer.from(PASSWORD, "utf8"),
    SIGNUP_TOKEN!,
  );
  dataKey.fill(0); // this fixture logs in for real below; it doesn't need the key
  createdUserIds.push(loginUserId);
  const login = await loginRoute(
    jsonRequest("http://localhost/api/auth/login", { email: loginEmail, password: PASSWORD }),
  );
  const loginSessionId = login.cookies.get(SESSION_COOKIE)?.value;
  if (loginSessionId) createdSessionIds.push(loginSessionId);

  // logout — clears.
  const logout = await logoutRoute(
    new NextRequest("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: new Headers({ cookie: `${SESSION_COOKIE}=${loginSessionId ?? "none"}` }),
    }),
  );

  // account deletion — clears. Needs its own user, since it destroys one.
  const deleteEmail = freshEmail("cookie-delete");
  const { userId: deleteUserId, dataKey: deleteKey } = await createUser(
    deleteEmail,
    Buffer.from(PASSWORD, "utf8"),
    SIGNUP_TOKEN!,
  );
  createdUserIds.push(deleteUserId);
  const deleteSessionId = createSession(deleteUserId, deleteKey, "ILS");
  createdSessionIds.push(deleteSessionId);
  const deleted = await deleteAccountRoute(
    new NextRequest("http://localhost:3000/api/account", {
      method: "DELETE",
      headers: new Headers({
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${deleteSessionId}`,
      }),
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );

  return { signup, login, logout, deleted };
}

describe("session cookie attributes agree across every route that writes them", () => {
  it("the two clear routes emit exactly what the two set routes emit", async () => {
    const { signup, login, logout, deleted } = await writeCookieEverywhere();

    const setAttrs = matchAttrs(signup);
    expect(matchAttrs(login), "login must set what signup sets").toEqual(setAttrs);
    expect(matchAttrs(logout), "logout cannot clear a cookie it doesn't match").toEqual(setAttrs);
    expect(matchAttrs(deleted), "account deletion cannot clear a cookie it doesn't match").toEqual(
      setAttrs,
    );
  });

  it("set routes use the session TTL; clear routes expire immediately", async () => {
    const { signup, login, logout, deleted } = await writeCookieEverywhere();

    // The cookie must never outlive the RAM session it points at — a longer
    // one just means the browser keeps presenting an id the store has
    // already dropped.
    expect(maxAgeOf(signup)).toBe(SESSION_TTL_SECONDS);
    expect(maxAgeOf(login)).toBe(SESSION_TTL_SECONDS);
    expect(maxAgeOf(logout)).toBe(0);
    expect(maxAgeOf(deleted)).toBe(0);
  });

  it("the session lifetime has exactly one origin in the source", async () => {
    // The cookie's maxAge, the RAM store's expiry and the sync-reminder gap
    // all have to agree, and they used to agree only by three copies of
    // `8 * 60 * 60 [* 1000]` plus comments claiming they matched. Grep the
    // source rather than the values: identical numbers would pass a value
    // comparison while still being three independent literals, which is the
    // thing being prevented.
    const { readFile } = await import("node:fs/promises");
    const files = ["src/lib/auth/session-store.ts", "src/domain/auth.ts"];
    const hits: string[] = [];
    for (const f of files) {
      const src = await readFile(new URL(`../../${f}`, import.meta.url), "utf8");
      for (const line of src.split("\n")) {
        const code = line.trim();
        // Skip comment lines — prose is allowed to mention the number.
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (/\b8 \* 60 \* 60\b/.test(code)) hits.push(`${f}: ${code}`);
      }
    }
    expect(hits, "the 8h literal should appear exactly once, in session-store").toHaveLength(1);
    expect(hits[0]).toContain("session-store.ts");
    expect(hits[0]).toContain("SESSION_TTL_MS");
  });

  it("logout still ends the session it was handed", async () => {
    // Guards the `next/headers` -> `NextRequest` swap in the logout route:
    // it must still read the id it is clearing, not just blank the cookie.
    const email = freshEmail("cookie-logout-ends");
    const { userId, dataKey } = await createUser(
      email,
      Buffer.from(PASSWORD, "utf8"),
      SIGNUP_TOKEN!,
    );
    createdUserIds.push(userId);
    const sessionId = createSession(userId, dataKey, "ILS");
    createdSessionIds.push(sessionId);

    const { getSession } = await import("@/lib/auth/session-store");
    expect(getSession(sessionId)).not.toBeNull();

    await logoutRoute(
      new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: new Headers({ cookie: `${SESSION_COOKIE}=${sessionId}` }),
      }),
    );

    expect(getSession(sessionId)).toBeNull();
  });
});
