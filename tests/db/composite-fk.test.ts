// domain-layer.md §5 item 2 — "Composite FK Denial": creating a row for
// user A that references user B's id via a composite (owner_id, id)
// foreign key must fail at the DATABASE level, independent of RLS and of
// any application-layer check. These tests run through the ELEVATED
// (superuser) connection specifically so RLS is bypassed entirely — a
// superuser sees and can reference any row — proving the composite FK
// backstop stops cross-tenant linkage on its own, not merely as a side
// effect of RLS filtering rows out first (data-model.md §2's whole point:
// "cross-tenant linkage is impossible even if RLS is bypassed").
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { cleanupOwners, elevatedDb } from "./helpers";

const ct = (s: string) => Buffer.from(s, "utf8");
const FK_VIOLATION = "23503";

/**
 * drizzle-orm wraps the underlying `pg` driver error in a `DrizzleQueryError`
 * and re-exposes the original as `.cause` — so the Postgres error code
 * (`23503` = foreign_key_violation) lives at `error.cause.code`, not
 * `error.code`. Asserts the rejection is specifically a FK violation, not
 * merely "something threw."
 */
async function expectForeignKeyViolation(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ cause: { code: FK_VIOLATION } });
}

describe("composite (owner_id, id) FK backstop", () => {
  let userAId: string;
  let userBId: string;
  let accountA: string;
  let accountB: string;
  let entryA: string;
  let entryB: string;

  beforeAll(async () => {
    const [a] = await elevatedDb
      .insert(schema.users)
      .values({ email: `fk-a-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    const [b] = await elevatedDb
      .insert(schema.users)
      .values({ email: `fk-b-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    userAId = a.id;
    userBId = b.id;

    const [accA] = await elevatedDb
      .insert(schema.accounts)
      .values({
        ownerId: userAId,
        accountType: "checking",
        classification: "asset",
        nameCt: ct("a-account"),
        currency: "ILS",
      })
      .returning({ id: schema.accounts.id });
    const [accB] = await elevatedDb
      .insert(schema.accounts)
      .values({
        ownerId: userBId,
        accountType: "credit_card",
        classification: "liability",
        nameCt: ct("b-account"),
        currency: "ILS",
      })
      .returning({ id: schema.accounts.id });
    accountA = accA.id;
    accountB = accB.id;

    const [entA] = await elevatedDb
      .insert(schema.entries)
      .values({
        ownerId: userAId,
        accountId: accountA,
        entryType: "transaction",
        date: "2026-01-15",
        descriptionCt: ct("a-entry"),
        status: "posted",
        enteredAmountCt: ct("10.00"),
        enteredCurrency: "ILS",
        accountAmountCt: ct("10.00"),
        accountCurrency: "ILS",
        reportingCurrency: "ILS",
        fxStatus: "locked",
        source: "manual",
      })
      .returning({ id: schema.entries.id });
    const [entB] = await elevatedDb
      .insert(schema.entries)
      .values({
        ownerId: userBId,
        accountId: accountB,
        entryType: "transaction",
        date: "2026-01-15",
        descriptionCt: ct("b-entry"),
        status: "posted",
        enteredAmountCt: ct("10.00"),
        enteredCurrency: "ILS",
        accountAmountCt: ct("10.00"),
        accountCurrency: "ILS",
        reportingCurrency: "ILS",
        fxStatus: "locked",
        source: "manual",
      })
      .returning({ id: schema.entries.id });
    entryA = entA.id;
    entryB = entB.id;
  });

  afterAll(async () => {
    await cleanupOwners([userAId, userBId]);
  });

  it("entries -> accounts: an entry owned by A cannot reference B's account", async () => {
    await expectForeignKeyViolation(
      elevatedDb.insert(schema.entries).values({
        ownerId: userAId,
        accountId: accountB, // B's account
        entryType: "transaction",
        date: "2026-01-15",
        descriptionCt: ct("cross-tenant"),
        status: "posted",
        enteredAmountCt: ct("10.00"),
        enteredCurrency: "ILS",
        accountAmountCt: ct("10.00"),
        accountCurrency: "ILS",
        reportingCurrency: "ILS",
        fxStatus: "locked",
        source: "manual",
      }),
    );
  });

  it("credit_card_details -> accounts: a details row owned by A cannot reference B's account", async () => {
    await expectForeignKeyViolation(
      elevatedDb.insert(schema.creditCardDetails).values({
        accountId: accountB, // B's account
        ownerId: userAId,
        statementCloseDay: 1,
        paymentDueDay: 10,
      }),
    );
  });

  it("entry_field_changelog -> entries: a changelog row owned by A cannot reference B's entry", async () => {
    await expectForeignKeyViolation(
      elevatedDb.insert(schema.entryFieldChangelog).values({
        ownerId: userAId,
        entryId: entryB, // B's entry
        fieldName: "description",
        source: "user",
        valueCt: ct("tampered"),
      }),
    );
  });

  it("sanity: the same inserts succeed when correctly scoped to their own owner", async () => {
    const [ccd] = await elevatedDb
      .insert(schema.creditCardDetails)
      .values({
        accountId: accountA,
        ownerId: userAId,
        statementCloseDay: 5,
        paymentDueDay: 20,
      })
      .returning({ accountId: schema.creditCardDetails.accountId });
    expect(ccd.accountId).toBe(accountA);

    const [log] = await elevatedDb
      .insert(schema.entryFieldChangelog)
      .values({
        ownerId: userAId,
        entryId: entryA,
        fieldName: "description",
        source: "user",
        valueCt: ct("legit-change"),
      })
      .returning({ id: schema.entryFieldChangelog.id });
    expect(log.id).toBeDefined();
  });
});
