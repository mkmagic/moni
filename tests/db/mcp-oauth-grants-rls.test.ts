// RLS coverage for `mcp_oauth_grants` (issue #113 OAuth phase, step 1). The
// grant table is the crown-jewel refresh envelope at a long lifetime, so it
// must hold the same two properties `agent_tokens` does:
//
//   1. Tenant isolation — a user sees/writes only their own grants under
//      withUser(); no cross-owner read even by explicit id, no cross-owner
//      write.
//   2. Pre-auth lookup — the /token refresh path resolves a presented refresh
//      secret to its row *by hash* before app.user_id is set, via the
//      mcp_oauth_grants_app_select policy (drizzle/0034), the same shape as
//      agent_tokens_app_select.
//
// Fixtures are seeded on the elevated (superuser) connection because seeding
// two owners in one step is exactly what no RLS-subject role can do; every
// assertion that simulates the app's real access pattern goes through the real
// withUser() from src/db/client.ts, or a fresh unscoped moni_app client for
// the pre-auth window.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { cleanupOwners, elevatedDb, newAppRoleClient } from "./helpers";

const bytea = (s: string) => Buffer.from(s, "utf8");

interface GrantFixture {
  userId: string;
  grantId: string;
  refreshTokenHash: Buffer;
}

async function seedOwnerWithGrant(label: string): Promise<GrantFixture> {
  const [user] = await elevatedDb
    .insert(schema.users)
    .values({ email: `${label}-${randomUUID()}@test.moni`, baseCurrency: "ILS" })
    .returning({ id: schema.users.id });

  const refreshTokenHash = createHash("sha256").update(randomBytes(32)).digest();
  const [grant] = await elevatedDb
    .insert(schema.mcpOauthGrants)
    .values({
      ownerId: user.id,
      clientId: `client-${label}`,
      refreshTokenHash,
      refreshWrappedDk: bytea(`${label}-wrapped-dk`),
      scope: "mcp:read",
      label: `${label}-connector`,
    })
    .returning({ id: schema.mcpOauthGrants.id });

  return { userId: user.id, grantId: grant.id, refreshTokenHash };
}

describe("mcp_oauth_grants RLS", () => {
  let a: GrantFixture;
  let b: GrantFixture;

  beforeAll(async () => {
    a = await seedOwnerWithGrant("grant-a");
    b = await seedOwnerWithGrant("grant-b");
  });

  afterAll(async () => {
    await cleanupOwners([a.userId, b.userId]);
  });

  it("A sees only A's grant under withUser()", async () => {
    const rows = await withUser(a.userId, (tx) =>
      tx.select({ id: schema.mcpOauthGrants.id }).from(schema.mcpOauthGrants),
    );
    expect(rows.map((r) => r.id)).toEqual([a.grantId]);
  });

  it("A cannot read B's grant even by explicit id", async () => {
    const rows = await withUser(a.userId, (tx) =>
      tx
        .select({ id: schema.mcpOauthGrants.id })
        .from(schema.mcpOauthGrants)
        .where(eq(schema.mcpOauthGrants.id, b.grantId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("scoped as A, INSERT with owner_id = B is rejected", async () => {
    await expect(
      withUser(a.userId, (tx) =>
        tx.insert(schema.mcpOauthGrants).values({
          ownerId: b.userId,
          clientId: "smuggled",
          refreshTokenHash: createHash("sha256").update(randomBytes(32)).digest(),
          refreshWrappedDk: bytea("smuggled-dk"),
          scope: "mcp:read",
        }),
      ),
    ).rejects.toThrow();
  });

  it("scoped as A, UPDATE moving a grant's owner_id to B is rejected", async () => {
    await expect(
      withUser(a.userId, (tx) =>
        tx
          .update(schema.mcpOauthGrants)
          .set({ ownerId: b.userId })
          .where(eq(schema.mcpOauthGrants.id, a.grantId)),
      ),
    ).rejects.toThrow();

    // The row still belongs to A (superuser read, bypassing RLS).
    const [row] = await elevatedDb
      .select({ ownerId: schema.mcpOauthGrants.ownerId })
      .from(schema.mcpOauthGrants)
      .where(eq(schema.mcpOauthGrants.id, a.grantId));
    expect(row.ownerId).toBe(a.userId);
  });

  describe("pre-auth lookup by refresh_token_hash (app.user_id unset)", () => {
    it("an unscoped moni_app client resolves a grant by hash", async () => {
      const client = newAppRoleClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ id: string; owner_id: string }>(
          `select id, owner_id from mcp_oauth_grants where refresh_token_hash = $1`,
          [a.refreshTokenHash],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(a.grantId);
        expect(rows[0].owner_id).toBe(a.userId);
      } finally {
        await client.end();
      }
    });

    it("once app.user_id is scoped to A, the pre-auth policy yields nothing for B's hash", async () => {
      const rows = await withUser(a.userId, (tx) =>
        tx
          .select({ id: schema.mcpOauthGrants.id })
          .from(schema.mcpOauthGrants)
          .where(eq(schema.mcpOauthGrants.refreshTokenHash, b.refreshTokenHash)),
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("revoking scoped as A flips only A's grant", async () => {
    await withUser(a.userId, (tx) =>
      tx
        .update(schema.mcpOauthGrants)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.mcpOauthGrants.id, a.grantId))),
    );

    const [aRow] = await elevatedDb
      .select({ revokedAt: schema.mcpOauthGrants.revokedAt })
      .from(schema.mcpOauthGrants)
      .where(eq(schema.mcpOauthGrants.id, a.grantId));
    const [bRow] = await elevatedDb
      .select({ revokedAt: schema.mcpOauthGrants.revokedAt })
      .from(schema.mcpOauthGrants)
      .where(eq(schema.mcpOauthGrants.id, b.grantId));
    expect(aRow.revokedAt).not.toBeNull();
    expect(bRow.revokedAt).toBeNull();
  });
});
