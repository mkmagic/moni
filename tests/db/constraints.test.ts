// Schema-level sanity checks from docs/design/data-model.md §4.2/§4.3 and
// §1 (flow vs. snapshot separation): a missing FX rate is representable
// (never faked), there is genuinely no stored reporting-amount column, and
// entries/account_balance_snapshots are separate tables.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const ct = (s: string) => Buffer.from(s, "utf8");

describe("fx_status = 'pending' is representable (no faked rate)", () => {
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `pending-fx-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [account] = await elevatedDb
      .insert(schema.accounts)
      .values({
        ownerId: userId,
        accountType: "checking",
        classification: "asset",
        nameCt: ct("pending-fx-account"),
        currency: "USD",
      })
      .returning({ id: schema.accounts.id });
    accountId = account.id;
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
  });

  it("inserts successfully with fx_status = 'pending' and fx_rate = null", async () => {
    const [entry] = await elevatedDb
      .insert(schema.entries)
      .values({
        ownerId: userId,
        accountId,
        entryType: "transaction",
        date: "2026-01-15",
        descriptionCt: ct("no rate available yet"),
        status: "posted",
        enteredAmountCt: ct("100.00"),
        enteredCurrency: "USD",
        accountAmountCt: ct("100.00"),
        accountCurrency: "USD",
        reportingCurrency: "ILS",
        fxRate: null,
        fxRateDate: null,
        fxStatus: "pending",
        source: "scrape",
      })
      .returning({
        id: schema.entries.id,
        fxRate: schema.entries.fxRate,
        fxStatus: schema.entries.fxStatus,
      });

    expect(entry.fxStatus).toBe("pending");
    expect(entry.fxRate).toBeNull();
  });
});

describe("no reporting_amount-shaped column exists anywhere in the schema", () => {
  it("has no column named reporting_amount / reporting_amount_ct on any table (data-model.md §4.3)", async () => {
    const { rows } = await elevatedPool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
       from information_schema.columns
       where table_schema = 'public'
         and (column_name = 'reporting_amount' or column_name = 'reporting_amount_ct' or column_name ilike '%reporting_amount%')`,
    );
    expect(rows).toEqual([]);
  });

  it("entries does carry reporting_currency + locked fx_rate, but no reporting amount leg", async () => {
    const { rows } = await elevatedPool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'entries'
       order by column_name`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toContain("reporting_currency");
    expect(columns).toContain("fx_rate");
    expect(columns).toContain("fx_rate_date");
    expect(columns).not.toContain("reporting_amount");
    expect(columns).not.toContain("reporting_amount_ct");
  });
});

describe("flow vs. snapshot separation: entries and account_balance_snapshots are genuinely separate tables", () => {
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `flow-vs-snapshot-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [account] = await elevatedDb
      .insert(schema.accounts)
      .values({
        ownerId: userId,
        accountType: "savings",
        classification: "asset",
        nameCt: ct("flow-vs-snapshot-account"),
        currency: "ILS",
      })
      .returning({ id: schema.accounts.id });
    accountId = account.id;
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
  });

  it("inserting a balance snapshot does not create a row in entries", async () => {
    const entriesCountBefore = await countRowsForOwner("entries", userId);
    expect(entriesCountBefore).toBe(0);

    await elevatedDb.insert(schema.accountBalanceSnapshots).values({
      ownerId: userId,
      accountId,
      date: "2026-01-15",
      nativeBalanceCt: ct("50000.00"),
      currency: "ILS",
      source: "manual",
    });

    const entriesCountAfter = await countRowsForOwner("entries", userId);
    expect(entriesCountAfter).toBe(0);

    const snapshotCount = await countRowsForOwner("account_balance_snapshots", userId);
    expect(snapshotCount).toBe(1);
  });

  it("inserting an entry does not create a row in account_balance_snapshots", async () => {
    const snapshotsBefore = await countRowsForOwner("account_balance_snapshots", userId);

    await elevatedDb.insert(schema.entries).values({
      ownerId: userId,
      accountId,
      entryType: "transaction",
      date: "2026-01-16",
      descriptionCt: ct("a flow, not a snapshot"),
      status: "posted",
      enteredAmountCt: ct("-42.00"),
      enteredCurrency: "ILS",
      accountAmountCt: ct("-42.00"),
      accountCurrency: "ILS",
      reportingCurrency: "ILS",
      fxStatus: "locked",
      fxRate: "1",
      source: "manual",
    });

    const snapshotsAfter = await countRowsForOwner("account_balance_snapshots", userId);
    expect(snapshotsAfter).toBe(snapshotsBefore);
  });
});

async function countRowsForOwner(table: string, ownerId: string): Promise<number> {
  const { rows } = await elevatedPool.query<{ count: string }>(
    `select count(*)::int as count from "${table}" where owner_id = $1`,
    [ownerId],
  );
  return Number(rows[0].count);
}
