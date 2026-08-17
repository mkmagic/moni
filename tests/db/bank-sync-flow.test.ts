// The bank sync spawn boundary (issue #92): the parent hands the FETCHER only
// [CK, ciphertext] — never the DK, the userId, or a DB handle — and, on a clean
// fetch, hands the PROMOTER [DK, accounts]. These assertions are the security
// contract of the fetcher/promoter split; the promotion logic itself is
// exercised by the sync-promotion tests.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type MockChild = EventEmitter & {
  stdin: { write: (value: Buffer, cb?: () => void) => void; end: () => void };
  stdout: EventEmitter;
  frame?: Buffer;
  kill: (signal?: NodeJS.Signals) => boolean;
};
const children = vi.hoisted((): MockChild[] => []);
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: {
        write: (value: Buffer, cb?: () => void) => {
          child.frame = Buffer.from(value);
          cb?.();
        },
        end: () => undefined,
      },
      stdout: new EventEmitter(),
      kill: () => true,
    }) as MockChild;
    children.push(child);
    return child;
  },
}));

import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import { getSyncRun } from "@/domain/sync-promotion";
import { createSession, destroySession } from "@/lib/auth/session-store";
import { armCredentialWindow, destroyCredentialWindow } from "@/lib/auth/cred-window";
import { decodeBinaryChildFrame, decryptWorkerCredentials } from "@/lib/connectors";
import { SESSION_COOKIE } from "@/domain/auth";
import { POST as sync } from "@/app/api/connections/[id]/sync/route";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

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

function syncRequest(connectionId: string, sessionId: string): NextRequest {
  return new NextRequest(`http://localhost/api/connections/${connectionId}/sync`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${sessionId}`,
    }),
    body: JSON.stringify({}),
  });
}
function params(id: string): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

describe("bank sync flow", () => {
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

  it("frames the fetcher with [CK, ciphertext] only and the promoter with [DK, accounts]", async () => {
    children.length = 0;
    const session = await fresh("bank-success");
    owners.push(session.userId);
    sessions.push(session);
    const creds = { username: "dana", password: "hunter2 שלום" };
    const { id: connectionId } = await createConnection(
      session.userId,
      "leumi",
      creds,
      session.credentialKey,
      "Leumi",
    );
    armCredentialWindow(session.sessionId, session.userId, session.credentialKey);

    const response = await sync(syncRequest(connectionId, session.sessionId), {
      params: params(connectionId),
    });
    expect(response.status).toBe(202);
    const { syncRunId } = (await response.json()) as { syncRunId: string };

    // Fetcher: exactly [CK, ct] + non-secret metadata, no DK/userId/syncRunId.
    expect(children).toHaveLength(1);
    const fetchFrame = decodeBinaryChildFrame(children[0].frame!);
    expect(fetchFrame.metadata).toEqual({
      connectionId,
      connectorId: "leumi",
      startDate: expect.any(String),
      version: "1",
    });
    expect(fetchFrame.segments).toHaveLength(2);
    for (const segment of fetchFrame.segments) {
      expect(segment.equals(session.dataKey)).toBe(false);
    }
    // The two segments really are the CK and this connection's ciphertext.
    expect(
      decryptWorkerCredentials(fetchFrame.segments[0], fetchFrame.segments[1], {
        rowId: connectionId,
        version: 1,
      }),
    ).toEqual(creds);

    // A clean fetch spawns the promoter with [DK, accounts].
    children[0].stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ accounts: [{ accountNumber: "123", txns: [] }] })}\n`),
    );
    children[0].emit("close", 0, null);

    await vi.waitFor(() => expect(children).toHaveLength(2));
    const promoteFrame = decodeBinaryChildFrame(children[1].frame!);
    expect(promoteFrame.metadata).toEqual({
      userId: session.userId,
      connectionId,
      connectorId: "leumi",
      syncRunId,
    });
    expect(promoteFrame.segments).toHaveLength(2);
    expect(promoteFrame.segments[0].equals(session.dataKey)).toBe(true);
    const payload = JSON.parse(promoteFrame.segments[1].toString("utf8")) as {
      accounts: unknown[];
    };
    expect(payload.accounts).toHaveLength(1);
    children[1].emit("close", 0, null);

    for (const segment of [...fetchFrame.segments, ...promoteFrame.segments]) segment.fill(0);
  });

  it("records the fetcher's failure code and never spawns a promoter", async () => {
    children.length = 0;
    const session = await fresh("bank-fail");
    owners.push(session.userId);
    sessions.push(session);
    const { id: connectionId } = await createConnection(
      session.userId,
      "leumi",
      { username: "a", password: "b" },
      session.credentialKey,
    );
    armCredentialWindow(session.sessionId, session.userId, session.credentialKey);

    const response = await sync(syncRequest(connectionId, session.sessionId), {
      params: params(connectionId),
    });
    expect(response.status).toBe(202);
    const { syncRunId } = (await response.json()) as { syncRunId: string };

    expect(children).toHaveLength(1);
    children[0].stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ code: "invalid_credentials" })}\n`),
    );
    children[0].emit("close", 1, null);

    await vi.waitFor(async () => {
      const run = await getSyncRun(session.userId, syncRunId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("invalid_credentials");
    });
    expect(children).toHaveLength(1);
  });
});
