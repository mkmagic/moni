// The core cross-tenant test suite — docs/design/domain-layer.md §5 items 1
// ("Direct Access Denial") and 4 ("Agent Confinement", exercised here via
// the same withUser() call any MCP read would go through), plus the
// "Sanity checks" in docs/security/security-design-principles.md around
// fail-closed behavior when app.user_id is unset or stale.
//
// Fixture setup/teardown uses the elevated (superuser) connection to
// moni_test, since seeding two different owners' rows in one step is
// exactly what no RLS-subject role (including moni_owner, which is also
// FORCE-RLS'd) can do. Every assertion that's meant to simulate the app's
// real access pattern goes through the real `withUser()` from
// src/db/client.ts — not a hand-rolled equivalent — because validating that
// helper against a live RLS-protected database is the point of this file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import {
  cleanupFxRates,
  cleanupOwners,
  elevatedDb,
  elevatedPool,
  newAppRoleClient,
} from "./helpers";

// Fixture bytea placeholders. These tests only assert row visibility, not
// encryption correctness (crypto.test.ts owns that) — arbitrary non-null
// bytea satisfies the NOT NULL columns.
const ct = (s: string) => Buffer.from(s, "utf8");

interface OwnerFixture {
  userId: string;
  categoryId: string;
  accountId: string;
  entryId: string;
}

async function seedOwner(label: string): Promise<OwnerFixture> {
  const [user] = await elevatedDb
    .insert(schema.users)
    .values({ email: `${label}-${randomUUID()}@test.moni`, baseCurrency: "ILS" })
    .returning({ id: schema.users.id });

  const [category] = await elevatedDb
    .insert(schema.categories)
    .values({ ownerId: user.id, name: `${label}-groceries`, classification: "expense" })
    .returning({ id: schema.categories.id });

  const [account] = await elevatedDb
    .insert(schema.accounts)
    .values({
      ownerId: user.id,
      accountType: "checking",
      classification: "asset",
      nameCt: ct(`${label}-account`),
      currency: "ILS",
    })
    .returning({ id: schema.accounts.id });

  const [entry] = await elevatedDb
    .insert(schema.entries)
    .values({
      ownerId: user.id,
      accountId: account.id,
      entryType: "transaction",
      date: "2026-01-15",
      descriptionCt: ct(`${label}-entry`),
      categoryId: category.id,
      status: "posted",
      enteredAmountCt: ct("100.00"),
      enteredCurrency: "ILS",
      accountAmountCt: ct("100.00"),
      accountCurrency: "ILS",
      reportingCurrency: "ILS",
      fxStatus: "locked",
      source: "manual",
    })
    .returning({ id: schema.entries.id });

  return { userId: user.id, categoryId: category.id, accountId: account.id, entryId: entry.id };
}

describe("RLS cross-tenant isolation", () => {
  let userA: OwnerFixture;
  let userB: OwnerFixture;

  beforeAll(async () => {
    userA = await seedOwner("a");
    userB = await seedOwner("b");
  });

  afterAll(async () => {
    await cleanupOwners([userA.userId, userB.userId]);
    await elevatedPool.end();
  });

  it("A sees only A's rows across categories/accounts/entries", async () => {
    await withUser(userA.userId, async (tx) => {
      const categories = await tx.select().from(schema.categories);
      expect(categories.map((c) => c.id)).toEqual([userA.categoryId]);

      const accounts = await tx.select().from(schema.accounts);
      expect(accounts.map((a) => a.id)).toEqual([userA.accountId]);

      const entries = await tx.select().from(schema.entries);
      expect(entries.map((e) => e.id)).toEqual([userA.entryId]);
    });
  });

  it("B sees only B's rows across categories/accounts/entries", async () => {
    await withUser(userB.userId, async (tx) => {
      const categories = await tx.select().from(schema.categories);
      expect(categories.map((c) => c.id)).toEqual([userB.categoryId]);

      const accounts = await tx.select().from(schema.accounts);
      expect(accounts.map((a) => a.id)).toEqual([userB.accountId]);

      const entries = await tx.select().from(schema.entries);
      expect(entries.map((e) => e.id)).toEqual([userB.entryId]);
    });
  });

  it("an explicit owner_id = B filter, scoped as A, still yields zero rows (RLS filters silently, no error)", async () => {
    await withUser(userA.userId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.categories)
        .where(sql`${schema.categories.ownerId} = ${userB.userId}::uuid`);
      expect(rows).toEqual([]);
    });
  });

  it("scoped as A, UPDATE attempting to move a row's owner_id to B is rejected", async () => {
    await expect(
      withUser(userA.userId, async (tx) => {
        await tx
          .update(schema.categories)
          .set({ ownerId: userB.userId })
          .where(sql`${schema.categories.id} = ${userA.categoryId}::uuid`);
      }),
    ).rejects.toThrow();

    // The row must be unchanged and still owned by A.
    const { rows } = await elevatedPool.query(`select owner_id from categories where id = $1`, [
      userA.categoryId,
    ]);
    expect(rows[0].owner_id).toBe(userA.userId);
  });

  it("scoped as A, INSERT with owner_id = B is rejected", async () => {
    await expect(
      withUser(userA.userId, async (tx) => {
        await tx.insert(schema.categories).values({
          ownerId: userB.userId,
          name: "should-not-be-insertable",
          classification: "expense",
        });
      }),
    ).rejects.toThrow();
  });

  it("scoped as B, UPDATE attempting to move a row's owner_id to A is rejected (symmetric)", async () => {
    await expect(
      withUser(userB.userId, async (tx) => {
        await tx
          .update(schema.categories)
          .set({ ownerId: userA.userId })
          .where(sql`${schema.categories.id} = ${userB.categoryId}::uuid`);
      }),
    ).rejects.toThrow();
  });

  it("scoped as B, INSERT with owner_id = A is rejected (symmetric)", async () => {
    await expect(
      withUser(userB.userId, async (tx) => {
        await tx.insert(schema.categories).values({
          ownerId: userA.userId,
          name: "should-not-be-insertable",
          classification: "expense",
        });
      }),
    ).rejects.toThrow();
  });

  describe("fail-closed behavior when app.user_id is unset or stale", () => {
    it("a fresh, virgin connection with app.user_id never set returns zero rows, not an error", async () => {
      const client = newAppRoleClient();
      await client.connect();
      try {
        const { rows } = await client.query("select * from categories");
        expect(rows).toEqual([]);
      } finally {
        await client.end();
      }
    });

    it(
      "a connection whose app.user_id was set via a completed (committed) transaction, then " +
        "queried again without re-setting it, does not leak another user's rows — Postgres's " +
        "set_config(..., true) [local] GUC reverts to '' (not NULL) after commit, so the next " +
        "query on the same connection either throws a uuid-cast error on owner_id = ''::uuid or " +
        "(if the driver/pool masks that) returns zero rows. Both are fail-closed; only a leak " +
        "would be a real failure.",
      async () => {
        const client = newAppRoleClient();
        await client.connect();
        try {
          // Mirrors withUser()'s exact mechanism (src/db/client.ts): a LOCAL
          // set_config inside a transaction, scoped to that transaction only.
          await client.query("BEGIN");
          await client.query("select set_config('app.user_id', $1, true)", [userA.userId]);
          const scoped = await client.query("select * from categories");
          expect(scoped.rows.map((r) => r.id)).toEqual([userA.categoryId]);
          await client.query("COMMIT");

          // Same physical connection, no re-set_config — the LOCAL setting
          // reverted to '' on commit. Assert this does NOT return B's (or
          // any other owner's) rows: either it throws (cast error) or it
          // comes back empty. Never assert the empty-only case in isolation,
          // since the error case is equally safe and is the realistic
          // outcome here.
          let rows: unknown[] = [];
          let threw = false;
          try {
            const result = await client.query("select * from categories");
            rows = result.rows;
          } catch {
            threw = true;
          }
          expect(rows.length === 0 || threw).toBe(true);
        } finally {
          await client.end();
        }
      },
    );
  });

  describe("fx_rates: global reference data, no RLS", () => {
    const fxRateId = randomUUID();

    beforeAll(async () => {
      await elevatedPool.query(
        `insert into fx_rates (id, from_currency, to_currency, date, rate, source)
         values ($1, 'USD', 'ILS', '2026-01-15', '3.70', 'test-fixture')`,
        [fxRateId],
      );
    });

    afterAll(async () => {
      await cleanupFxRates([fxRateId]);
    });

    it("is readable by moni_app with no app.user_id set at all", async () => {
      const client = newAppRoleClient();
      await client.connect();
      try {
        const { rows } = await client.query("select * from fx_rates where id = $1", [fxRateId]);
        expect(rows).toHaveLength(1);
      } finally {
        await client.end();
      }
    });

    it("cannot be written to by moni_app (INSERT/UPDATE/DELETE all permission-denied)", async () => {
      const client = newAppRoleClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into fx_rates (from_currency, to_currency, date, rate, source)
             values ('EUR', 'ILS', '2026-01-15', '4.00', 'moni_app-should-fail')`,
          ),
        ).rejects.toThrow(/permission denied/i);

        await expect(
          client.query(`update fx_rates set rate = '1.00' where id = $1`, [fxRateId]),
        ).rejects.toThrow(/permission denied/i);

        await expect(
          client.query(`delete from fx_rates where id = $1`, [fxRateId]),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await client.end();
      }
    });
  });
});
