// The box-wide bank-scrape slot, exercised through the real sync route (issue
// #82). `node:child_process` is mocked so no real `tsx scripts/scrape-worker.mts`
// (Chrome + a real bank login) runs — exactly the boundary
// connection-sync-routes.test.ts declines to cross — but everything up to and
// including the spawn is the production path: the route takes the slot, hands
// it to `startBankSync`, and the fetcher's exit releases it.
//
// This is the test that answers "does the guard break a normal scrape?": a
// first scrape starts and is fed its frame, a concurrent one is refused with
// 409 without spawning a second child, and once the first fetcher exits the
// slot frees so the next scrape starts normally.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

interface MockChild extends EventEmitter {
  stdin: EventEmitter & {
    write: (value: Buffer, cb?: () => void) => void;
    end: () => void;
  };
  stdout: EventEmitter;
  frame?: Buffer;
  kill: (signal?: NodeJS.Signals) => boolean;
}

const children = vi.hoisted((): MockChild[] => []);
vi.mock("node:child_process", () => ({
  spawn: (): MockChild => {
    const stdin = Object.assign(new EventEmitter(), {
      write: (value: Buffer, cb?: () => void) => {
        child.frame = Buffer.from(value);
        cb?.();
      },
      end: () => undefined,
    });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new EventEmitter(),
      kill: () => true,
    }) as MockChild;
    children.push(child);
    return child;
  },
}));

import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import { createSession, destroySession } from "@/lib/auth/session-store";
import { armCredentialWindow, destroyCredentialWindow } from "@/lib/auth/cred-window";
import { SESSION_COOKIE } from "@/domain/auth";
import { POST as syncRoute } from "@/app/api/connections/[id]/sync/route";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN!;
const PASSWORD = "correct horse battery staple";

interface TestSession {
  userId: string;
  sessionId: string;
  /** The one credential key this user's window is armed with — reused to
   * encrypt each connection's credentials so the armed window can decrypt them. */
  credentialKey: Buffer;
}

async function armedSession(label: string): Promise<TestSession> {
  const { userId, dataKey } = await createUser(
    `${label}-${randomUUID()}@test.moni`,
    Buffer.from(PASSWORD),
    SIGNUP_TOKEN,
  );
  const sessionId = createSession(userId, dataKey, "ILS");
  const credentialKey = await enrollTestCredentialKey(userId);
  armCredentialWindow(sessionId, userId, credentialKey);
  return { userId, sessionId, credentialKey };
}

function syncRequest(id: string, sessionId: string): NextRequest {
  return new NextRequest(`http://localhost/api/connections/${id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${sessionId}` },
    body: "{}",
  });
}

function post(id: string, sessionId: string) {
  return syncRoute(syncRequest(id, sessionId), { params: Promise.resolve({ id }) });
}

/** Polls the route until the slot has actually been released (the unlock is an
 * async statement on the held connection, so it settles a few ms after the
 * fetcher's `close`). Returns the first non-409 response. */
async function postUntilAccepted(id: string, sessionId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const res = await post(id, sessionId);
    if (res.status !== 409) return res;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("slot never freed");
}

describe("bank scrape concurrency slot (route)", () => {
  const userIds: string[] = [];
  const sessionIds: string[] = [];
  afterAll(async () => {
    // Free the slot for other tests in this worker, then tear down.
    for (const child of children) child.emit("close", 0, null);
    for (const id of sessionIds) {
      destroyCredentialWindow(id);
      destroySession(id);
    }
    await cleanupOwners(userIds);
  });

  it("starts one scrape, refuses a concurrent one, and frees the slot when the fetcher exits", async () => {
    const owner = await armedSession("bank-slot");
    userIds.push(owner.userId);
    sessionIds.push(owner.sessionId);
    const { id: leumi } = await createConnection(
      owner.userId,
      "leumi",
      { username: "dana", password: "hunter2" },
      owner.credentialKey,
    );
    const { id: max } = await createConnection(
      owner.userId,
      "max",
      { username: "dana", password: "hunter2" },
      owner.credentialKey,
    );

    // A second user, to prove the guard is cross-tenant and not per-user.
    const other = await armedSession("bank-slot-other");
    userIds.push(other.userId);
    sessionIds.push(other.sessionId);
    const { id: otherLeumi } = await createConnection(
      other.userId,
      "leumi",
      { username: "roni", password: "hunter2" },
      other.credentialKey,
    );

    children.length = 0;

    // First scrape starts: 202, one fetcher spawned and fed its frame.
    const first = await post(leumi, owner.sessionId);
    expect(first.status).toBe(202);
    expect(children).toHaveLength(1);
    const fetcher = children[0];
    expect(fetcher.frame).toBeDefined();

    // A concurrent scrape by the SAME user on a different connection is refused
    // with a clear code — and crucially spawns no second Chrome child.
    const sameUser = await post(max, owner.sessionId);
    expect(sameUser.status).toBe(409);
    expect(await sameUser.json()).toEqual({ error: "sync_already_in_progress" });
    expect(children).toHaveLength(1);

    // A concurrent scrape by a DIFFERENT user is refused too: the slot is the
    // whole box, not one tenant. This is the OOM case the issue is about.
    const otherUser = await post(otherLeumi, other.sessionId);
    expect(otherUser.status).toBe(409);
    expect(await otherUser.json()).toEqual({ error: "sync_already_in_progress" });
    expect(children).toHaveLength(1);

    // The fetcher (the ~1.5 GB Chrome part) exits → the slot is released.
    fetcher.emit("close", 0, null);

    // The next scrape now starts normally — the guard did not wedge scraping.
    const afterRelease = await postUntilAccepted(max, owner.sessionId);
    expect(afterRelease.status).toBe(202);
  });
});
