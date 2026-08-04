// src/domain/sync-promotion.ts — installment slices (issue #69 part A).
//
// The Israeli card scrapers describe one instalment plan as N independent
// charges that all repeat the WHOLE deal's figures: `originalAmount` is the
// deal sum, not the payment (max.js:192, base-isracard-amex.js:108), and
// `date` is the purchase date on every slice (max.js:184). Promoting those
// verbatim valued a ₪12,000 fridge at ₪12,000 twelve times over, all in the
// purchase month.
//
// What this file pins down: a slice's entry carries that slice's own amount
// and the date it is actually charged, the deal total survives on
// `entry_transactions`, and the twelve slices stay twelve distinct rows even
// on Isracard, where every slice shares one identifier.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import { promoteScrapeResult, startSyncRun } from "@/domain/sync-promotion";
import { decText } from "@/domain/fields";
import type { ScraperAccount, ScraperTransaction } from "@/lib/connectors";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface Fixture {
  userId: string;
  dataKey: Buffer;
  connectionId: string;
}

async function freshFixture(label: string): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  const credentialKey = await enrollTestCredentialKey(userId);
  const { id: connectionId } = await createConnection(
    userId,
    "isracard",
    { id: "123456789", card6Digits: "123456", password: "hunter2" },
    credentialKey,
  );
  return { userId, dataKey, connectionId };
}

/**
 * A ₪12,000 purchase on 2026-01-15 split into 12 payments of ₪1,000, exactly
 * as Isracard emits it: one identifier for the whole deal, the purchase date
 * repeated on every slice, `originalAmount` the deal sum on every slice, and
 * `processedDate` the only field that moves.
 */
function dealSlice(number: number): ScraperTransaction {
  const chargeMonth = String(number).padStart(2, "0");
  return {
    type: "installments",
    identifier: 55501234,
    date: "2026-01-15",
    processedDate: `2026-${chargeMonth}-02`,
    originalAmount: -12000,
    originalCurrency: "ILS",
    chargedAmount: -1000,
    chargedCurrency: "ILS",
    description: "Electric appliances",
    status: "completed",
    installments: { number, total: 12 },
  };
}

function accountWith(txns: ScraperTransaction[]): ScraperAccount[] {
  return [{ accountNumber: "4580", currency: "ILS", txns }];
}

async function promote(fx: Fixture, accounts: ScraperAccount[]) {
  const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
  return promoteScrapeResult({
    userId: fx.userId,
    dataKey: fx.dataKey,
    connectionId: fx.connectionId,
    connectorId: "isracard",
    syncRunId,
    accounts,
  });
}

/** Every entry, joined to its transaction subtype, with the money decrypted. */
async function readLedger(fx: Fixture) {
  return withUser(fx.userId, async (tx) => {
    const entryRows = await tx.select().from(schema.entries);
    const subtypeRows = await tx.select().from(schema.entryTransactions);
    const subtypeById = new Map(subtypeRows.map((row) => [row.entryId, row]));
    return entryRows
      .map((entry) => {
        const subtype = subtypeById.get(entry.id)!;
        return {
          date: entry.date,
          entered: decText(
            fx.dataKey,
            entry.enteredAmountCt,
            entry.id,
            "entered_amount_ct",
            entry.version,
          )!,
          enteredCurrency: entry.enteredCurrency,
          status: entry.status,
          installmentNumber: subtype.installmentNumber,
          totalInstallments: subtype.totalInstallments,
          purchaseDate: subtype.installmentPurchaseDate,
          dealTotal: decText(
            fx.dataKey,
            subtype.installmentTotalAmountCt,
            subtype.entryId,
            "installment_total_amount_ct",
            subtype.version,
          ),
          dealTotalCurrency: subtype.installmentTotalCurrency,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  });
}

describe("promoteScrapeResult: installments", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  it("keeps twelve slices of one deal as twelve entries, summing to the deal total", async () => {
    const fx = await freshFixture("inst-twelve");
    createdUserIds.push(fx.userId);

    const slices = Array.from({ length: 12 }, (_, i) => dealSlice(i + 1));
    const summary = await promote(fx, accountWith(slices));
    expect(summary.newEntries).toBe(12);

    const ledger = await readLedger(fx);
    expect(ledger).toHaveLength(12);

    // Each slice is worth its own payment, not the deal.
    expect(ledger.map((row) => row.entered)).toEqual(Array(12).fill("-1000"));

    // And they sum to exactly the deal total — the headline check.
    const total = ledger.reduce((sum, row) => sum.plus(new Decimal(row.entered)), new Decimal(0));
    expect(total.toString()).toBe("-12000");
  });

  it("dates each slice when it is charged, not when the purchase happened", async () => {
    const fx = await freshFixture("inst-dates");
    createdUserIds.push(fx.userId);

    await promote(fx, accountWith(Array.from({ length: 12 }, (_, i) => dealSlice(i + 1))));

    const ledger = await readLedger(fx);
    expect(ledger.map((row) => row.date)).toEqual([
      "2026-01-02",
      "2026-02-02",
      "2026-03-02",
      "2026-04-02",
      "2026-05-02",
      "2026-06-02",
      "2026-07-02",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-02",
      "2026-12-02",
    ]);
    // One charge per month: the January total stops growing as later slices
    // arrive, which is the whole point of re-dating.
    expect(new Set(ledger.map((row) => row.date.slice(0, 7))).size).toBe(12);
  });

  it("preserves the deal total and the purchase date on the transaction subtype", async () => {
    const fx = await freshFixture("inst-meta");
    createdUserIds.push(fx.userId);

    await promote(fx, accountWith([dealSlice(3)]));

    const [row] = await readLedger(fx);
    expect(row.installmentNumber).toBe(3);
    expect(row.totalInstallments).toBe(12);
    expect(row.dealTotal).toBe("-12000");
    expect(row.dealTotalCurrency).toBe("ILS");
    expect(row.purchaseDate).toBe("2026-01-15");
  });

  it("re-scraping the same deal is idempotent", async () => {
    const fx = await freshFixture("inst-idempotent");
    createdUserIds.push(fx.userId);

    const slices = Array.from({ length: 12 }, (_, i) => dealSlice(i + 1));
    await promote(fx, accountWith(slices));
    const second = await promote(fx, accountWith(slices));

    expect(second.newEntries).toBe(0);
    expect(second.matchedUnchanged).toBe(12);
    expect(await readLedger(fx)).toHaveLength(12);
  });

  it("re-dates a slice in place once its charge date is known", async () => {
    const fx = await freshFixture("inst-repost");
    createdUserIds.push(fx.userId);

    // Max reports a not-yet-charged slice with processedDate falling back to
    // the purchase date (max.js:183). The charge date arrives with the next
    // scrape; the entry must move, not fork.
    const pending: ScraperTransaction = {
      ...dealSlice(4),
      processedDate: "2026-01-15",
      status: "pending",
    };
    await promote(fx, accountWith([pending]));
    expect((await readLedger(fx))[0]).toMatchObject({ date: "2026-01-15", status: "pending" });

    const posted = await promote(fx, accountWith([dealSlice(4)]));
    expect(posted.newEntries).toBe(0);
    expect(posted.updatedPendingToPosted).toBe(1);

    const ledger = await readLedger(fx);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ date: "2026-04-02", status: "posted", entered: "-1000" });
  });

  it("leaves an ordinary charge on its purchase date and amount", async () => {
    const fx = await freshFixture("inst-normal");
    createdUserIds.push(fx.userId);

    await promote(
      fx,
      accountWith([
        {
          type: "normal",
          identifier: "N1",
          date: "2026-03-04",
          processedDate: "2026-04-02",
          originalAmount: -250,
          originalCurrency: "ILS",
          chargedAmount: -250,
          chargedCurrency: "ILS",
          description: "Groceries",
          status: "completed",
        },
      ]),
    );

    const [row] = await readLedger(fx);
    expect(row).toMatchObject({
      date: "2026-03-04",
      entered: "-250",
      installmentNumber: null,
      dealTotal: null,
      purchaseDate: null,
    });
  });

  it("records the deal total in the currency the source stated it in", async () => {
    const fx = await freshFixture("inst-fx");
    createdUserIds.push(fx.userId);

    // A foreign purchase split into payments: the deal is in USD, but each
    // payment is charged in shekels. The slice's own amount exists only on
    // the charged leg, so that is what the entered leg records.
    await promote(
      fx,
      accountWith([
        {
          ...dealSlice(2),
          originalAmount: -600,
          originalCurrency: "USD",
          chargedAmount: -750,
          chargedCurrency: "ILS",
        },
      ]),
    );

    const [row] = await readLedger(fx);
    expect(row.entered).toBe("-750");
    expect(row.enteredCurrency).toBe("ILS");
    expect(row.dealTotal).toBe("-600");
    expect(row.dealTotalCurrency).toBe("USD");
  });
});
