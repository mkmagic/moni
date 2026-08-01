// src/domain/connections.ts (task 10) — `credentials_ct` round-trips under
// the credential key (CK, never the data key), and cross-tenant reads
// return nothing (RLS backstop, domain-layer.md §5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import {
  createConnection,
  ConnectionCredentialsUnavailableError,
  findConnectionByConnector,
  getDecryptedCredentials,
  InvalidCredentialsShapeError,
  listConnections,
  UnknownConnectorError,
  updateConnectionCredentials,
} from "@/domain/connections";
import { createUser } from "@/domain/registration";
import { cleanupOwners, elevatedDb, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface TestUser {
  userId: string;
  credentialKey: Buffer;
}

async function freshUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId } = await createUser(email, password, SIGNUP_TOKEN!);
  const credentialKey = await enrollTestCredentialKey(userId);
  return { userId, credentialKey };
}

describe("domain/connections", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  it("round-trips credentials_ct under the credential key", async () => {
    const user = await freshUser("conn-roundtrip");
    createdUserIds.push(user.userId);

    const { id } = await createConnection(
      user.userId,
      "leumi",
      { username: "dana", password: "hunter2" },
      user.credentialKey,
      "My Leumi",
    );

    const decrypted = await getDecryptedCredentials(user.userId, id, user.credentialKey);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.connectorId).toBe("leumi");
    expect(decrypted!.credentials).toEqual({ username: "dana", password: "hunter2" });

    const listed = await listConnections(user.userId);
    expect(listed.map((c) => c.id)).toContain(id);

    const found = await findConnectionByConnector(user.userId, "leumi");
    expect(found?.id).toBe(id);
  });

  it("stores credentials_ct as opaque ciphertext — the plaintext never appears in the stored bytes", async () => {
    const user = await freshUser("conn-opaque");
    createdUserIds.push(user.userId);
    const { id } = await createConnection(
      user.userId,
      "leumi",
      { username: "opaque-marker", password: "hunter2" },
      user.credentialKey,
    );

    await withUser(user.userId, async (tx) => {
      const rows = await tx.select().from(schema.connections).where(eq(schema.connections.id, id));
      const stored = Buffer.from(rows[0].credentialsCt!).toString("latin1");
      expect(stored.includes("opaque-marker")).toBe(false);
      expect(stored.includes("hunter2")).toBe(false);
    });
  });

  it("cannot be decrypted with the wrong credential key", async () => {
    const user = await freshUser("conn-wrongkey");
    createdUserIds.push(user.userId);
    const { id } = await createConnection(
      user.userId,
      "leumi",
      { username: "x", password: "y" },
      user.credentialKey,
    );

    const wrongKey = randomBytes(32);
    await expect(getDecryptedCredentials(user.userId, id, wrongKey)).rejects.toThrow();
  });

  it("rejects a credentials shape that doesn't match the connector's registered fields", async () => {
    const user = await freshUser("conn-badshape");
    createdUserIds.push(user.userId);
    await expect(
      createConnection(user.userId, "leumi", { username: "only-one-field" }, user.credentialKey),
    ).rejects.toBeInstanceOf(InvalidCredentialsShapeError);
  });

  it("rejects an unknown connector id", async () => {
    const user = await freshUser("conn-unknown");
    createdUserIds.push(user.userId);
    await expect(
      createConnection(
        user.userId,
        // @ts-expect-error — deliberately invalid at the runtime boundary
        "not-a-real-connector",
        { foo: "bar" },
        user.credentialKey,
      ),
    ).rejects.toBeInstanceOf(UnknownConnectorError);
  });

  it("cross-tenant: user B cannot read user A's connection", async () => {
    const a = await freshUser("conn-a");
    const b = await freshUser("conn-b");
    createdUserIds.push(a.userId, b.userId);

    const { id } = await createConnection(
      a.userId,
      "leumi",
      { username: "a", password: "pw" },
      a.credentialKey,
    );

    const bResult = await getDecryptedCredentials(b.userId, id, b.credentialKey);
    expect(bResult).toBeNull();

    const bList = await listConnections(b.userId);
    expect(bList.map((c) => c.id)).not.toContain(id);
  });
});

describe("connection credential modes", () => {
  let userId: string;

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `connection-mode-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    userId = user.id;
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
  });

  it("rejects credential updates and reads for an import-mode connection", async () => {
    const [connection] = await elevatedDb
      .insert(schema.connections)
      .values({
        ownerId: userId,
        connectorId: "leumi",
        mode: "user_mediated_import",
        credentialsCt: null,
        status: "active",
      })
      .returning({ id: schema.connections.id });

    await expect(
      updateConnectionCredentials(
        userId,
        connection.id,
        { username: "user", password: "secret" },
        Buffer.alloc(32),
      ),
    ).rejects.toBeInstanceOf(ConnectionCredentialsUnavailableError);
    await expect(
      getDecryptedCredentials(userId, connection.id, Buffer.alloc(32)),
    ).rejects.toBeInstanceOf(ConnectionCredentialsUnavailableError);
  });
});
