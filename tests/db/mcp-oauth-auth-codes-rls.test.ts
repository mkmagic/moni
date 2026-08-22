// RLS coverage for `mcp_oauth_auth_codes` (issue #113 OAuth phase). Auth
// codes are short-lived DK envelopes, so they have the same two access modes
// as OAuth grants: owner-scoped writes through withUser(), and a pre-auth
// SELECT by the presented code hash at the /token boundary.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { cleanupOwners, elevatedDb, newAppRoleClient } from "./helpers";

interface AuthCodeFixture {
  userId: string;
  codeId: string;
  codeHash: Buffer;
}

async function seedOwnerWithAuthCode(label: string): Promise<AuthCodeFixture> {
  const [user] = await elevatedDb
    .insert(schema.users)
    .values({ email: `${label}-${randomUUID()}@test.moni`, baseCurrency: "ILS" })
    .returning({ id: schema.users.id });

  const codeHash = createHash("sha256").update(randomBytes(32)).digest();
  const [code] = await elevatedDb
    .insert(schema.mcpOauthAuthCodes)
    .values({
      ownerId: user.id,
      clientId: `https://claude.ai/${label}`,
      codeHash,
      wrappedDk: Buffer.from(`${label}-wrapped-dk`, "utf8"),
      codeChallenge: randomBytes(32).toString("base64url"),
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      scope: "mcp:read",
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning({ id: schema.mcpOauthAuthCodes.id });

  return { userId: user.id, codeId: code.id, codeHash };
}

describe("mcp_oauth_auth_codes RLS", () => {
  let a: AuthCodeFixture;
  let b: AuthCodeFixture;

  beforeAll(async () => {
    a = await seedOwnerWithAuthCode("code-a");
    b = await seedOwnerWithAuthCode("code-b");
  });

  afterAll(async () => cleanupOwners([a.userId, b.userId]));

  it("A sees only A's authorization code under withUser()", async () => {
    const rows = await withUser(a.userId, (tx) =>
      tx.select({ id: schema.mcpOauthAuthCodes.id }).from(schema.mcpOauthAuthCodes),
    );
    expect(rows.map((row) => row.id)).toEqual([a.codeId]);
  });

  it("A cannot read B's authorization code even by explicit id", async () => {
    const rows = await withUser(a.userId, (tx) =>
      tx
        .select({ id: schema.mcpOauthAuthCodes.id })
        .from(schema.mcpOauthAuthCodes)
        .where(eq(schema.mcpOauthAuthCodes.id, b.codeId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("scoped as A, INSERT with owner_id = B is rejected", async () => {
    await expect(
      withUser(a.userId, (tx) =>
        tx.insert(schema.mcpOauthAuthCodes).values({
          ownerId: b.userId,
          clientId: "https://claude.ai/smuggled",
          codeHash: createHash("sha256").update(randomBytes(32)).digest(),
          wrappedDk: Buffer.from("smuggled-dk", "utf8"),
          codeChallenge: randomBytes(32).toString("base64url"),
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
          scope: "mcp:read",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toThrow();
  });

  it("scoped as A, UPDATE moving a code's owner_id to B is rejected", async () => {
    await expect(
      withUser(a.userId, (tx) =>
        tx
          .update(schema.mcpOauthAuthCodes)
          .set({ ownerId: b.userId })
          .where(eq(schema.mcpOauthAuthCodes.id, a.codeId)),
      ),
    ).rejects.toThrow();

    const [row] = await elevatedDb
      .select({ ownerId: schema.mcpOauthAuthCodes.ownerId })
      .from(schema.mcpOauthAuthCodes)
      .where(eq(schema.mcpOauthAuthCodes.id, a.codeId));
    expect(row.ownerId).toBe(a.userId);
  });

  describe("pre-auth lookup by code_hash (app.user_id unset)", () => {
    it("an unscoped moni_app client resolves an authorization code by hash", async () => {
      const client = newAppRoleClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ id: string; owner_id: string }>(
          `select id, owner_id from mcp_oauth_auth_codes where code_hash = $1`,
          [a.codeHash],
        );
        expect(rows).toEqual([{ id: a.codeId, owner_id: a.userId }]);
      } finally {
        await client.end();
      }
    });

    it("once scoped to A, the pre-auth policy yields nothing for B's hash", async () => {
      const rows = await withUser(a.userId, (tx) =>
        tx
          .select({ id: schema.mcpOauthAuthCodes.id })
          .from(schema.mcpOauthAuthCodes)
          .where(eq(schema.mcpOauthAuthCodes.codeHash, b.codeHash)),
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("consuming scoped as A changes only A's authorization code", async () => {
    await withUser(a.userId, (tx) =>
      tx
        .update(schema.mcpOauthAuthCodes)
        .set({ consumedAt: new Date() })
        .where(eq(schema.mcpOauthAuthCodes.id, a.codeId)),
    );

    const rows = await elevatedDb
      .select({ id: schema.mcpOauthAuthCodes.id, consumedAt: schema.mcpOauthAuthCodes.consumedAt })
      .from(schema.mcpOauthAuthCodes);
    expect(rows.find((row) => row.id === a.codeId)?.consumedAt).not.toBeNull();
    expect(rows.find((row) => row.id === b.codeId)?.consumedAt).toBeNull();
  });
});
