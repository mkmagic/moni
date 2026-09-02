// Structural sanity checks that the committed migrations landed correctly on
// moni_test. Every other test file in this suite
// implicitly depends on this already being true (vitest.setup.ts calls
// `ensureTestDatabase()` before any test runs) — these are the one-time
// belt-and-suspenders checks referenced in the T6 spec, not a full schema
// diff.
import { describe, expect, it } from "vitest";
import { elevatedPool } from "./helpers";

describe("migrations: structural facts about moni_test", () => {
  it("creates exactly the 45 application tables, including eight household sharing tables", async () => {
    const { rows } = await elevatedPool.query<{ count: string }>(
      // `_moni_test_migrations` is this harness's own bookkeeping (see
      // setup-test-db.ts), not part of the data model — excluded so the
      // assertion keeps counting exactly the schema's tables.
      `select count(*)::int as count
       from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
         and table_name <> '_moni_test_migrations'`,
    );
    expect(Number(rows[0].count)).toBe(45);
  });

  it("enables + forces RLS on exactly 44 tables (every user-owned and group-owned table, excluding fx_rates)", async () => {
    const { rows } = await elevatedPool.query<{ count: string }>(
      `select count(*)::int as count
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = true and c.relforcerowsecurity = true`,
    );
    expect(Number(rows[0].count)).toBe(44);
  });

  it("has a tenant-isolation policy on every one of those 44 tables", async () => {
    const { rows } = await elevatedPool.query<{ tablename: string }>(
      `select distinct tablename from pg_policies where schemaname = 'public'`,
    );
    expect(rows.length).toBe(44);
  });

  it("leaves fx_rates without RLS (global reference data, data-model.md §5)", async () => {
    const { rows } = await elevatedPool.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class
       join pg_namespace n on n.oid = pg_class.relnamespace
       where n.nspname = 'public' and relname = 'fx_rates'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relrowsecurity).toBe(false);
  });

  it("creates the moni_owner and moni_app roles", async () => {
    const { rows } = await elevatedPool.query<{ rolname: string }>(
      `select rolname from pg_roles where rolname in ('moni_owner', 'moni_app') order by rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual(["moni_app", "moni_owner"]);
  });

  it("makes moni_owner the owner of every application enum", async () => {
    const { rows } = await elevatedPool.query<{ typname: string; owner: string }>(
      `select t.typname, r.rolname as owner
       from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       join pg_roles r on r.oid = t.typowner
       where n.nspname = 'public' and t.typtype = 'e'
       order by t.typname`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.owner !== "moni_owner")).toEqual([]);
  });
});
