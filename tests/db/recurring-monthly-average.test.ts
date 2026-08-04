// The per-month figures on the recurring view. Its own file rather than more
// cases in recurring-view.test.ts: proving the cadence divisor needs payees
// that are not monthly, and adding those to that file's fixture would move
// every range-total assertion in it.
//
// The bug this covers: a category's headline was the sum of its entries in
// the selected range, so a monthly ₪613 subscription read as ₪3,679 under a
// six-month range and there was no way to tell a dear subscription from a
// long window.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { encryptField, getDevUserDataKey, type AadContext } from "@/lib/crypto";
import { getRecurringView } from "@/domain/recurring";
import type { Session } from "@/lib/auth/session-store";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

function enc(dataKey: Uint8Array, rowId: string, column: string, value: string): Buffer {
  const aad: AadContext = { rowId, column, version: 1 };
  return encryptField(dataKey, Buffer.from(value, "utf8"), aad);
}

let userId: string;
let dataKey: Uint8Array;
let session: Session;
let accountId: string;

async function insertEntry(spec: {
  description: string;
  date: string;
  amount: string;
  categoryId: string;
}): Promise<void> {
  const id = randomUUID();
  await elevatedDb.insert(schema.entries).values({
    id,
    ownerId: userId,
    accountId,
    entryType: "transaction",
    date: spec.date,
    descriptionCt: enc(dataKey, id, "description_ct", spec.description),
    categoryId: spec.categoryId,
    status: "posted",
    enteredAmountCt: enc(dataKey, id, "entered_amount_ct", spec.amount),
    enteredCurrency: "ILS",
    accountAmountCt: enc(dataKey, id, "account_amount_ct", spec.amount),
    accountCurrency: "ILS",
    reportingCurrency: "ILS",
    fxRate: "1",
    fxRateDate: spec.date,
    fxSource: "test",
    fxStatus: "locked",
    source: "scrape",
  });
}

function rowNamed(view: Awaited<ReturnType<typeof getRecurringView>>, name: string) {
  return view.expenses[0].rows.find((r) => r.merchantName.toLowerCase() === name.toLowerCase());
}

describe("getRecurringView monthly averages", () => {
  beforeAll(async () => {
    userId = randomUUID();
    dataKey = getDevUserDataKey(userId);
    await elevatedDb
      .insert(schema.users)
      .values({ id: userId, email: `recavg-${randomUUID()}@test.moni`, baseCurrency: "ILS" });

    accountId = randomUUID();
    await elevatedDb.insert(schema.accounts).values({
      id: accountId,
      ownerId: userId,
      accountType: "credit_card",
      classification: "liability",
      nameCt: enc(dataKey, accountId, "name_ct", "Card"),
      currentBalanceCt: enc(dataKey, accountId, "current_balance_ct", "-500.00"),
      currency: "ILS",
    });

    const bills = randomUUID();
    await elevatedDb.insert(schema.categories).values({
      id: bills,
      ownerId: userId,
      name: "Bills",
      classification: "expense",
      isRecurring: true,
    });

    // Monthly: ₪100 × 6. The per-month figure must equal the per-payment one.
    for (const date of [
      "2026-02-04",
      "2026-03-04",
      "2026-04-04",
      "2026-05-04",
      "2026-06-04",
      "2026-07-04",
    ]) {
      // prettier-ignore
      await insertEntry({ description: "MOBILE PLAN", date, amount: "-100.00", categoryId: bills });
    }

    // Every two months (ארנונה): ₪600 a time, so ₪300 a month.
    for (const date of ["2026-01-10", "2026-03-10", "2026-05-10", "2026-07-10"]) {
      await insertEntry({ description: "ARNONA", date, amount: "-600.00", categoryId: bills });
    }

    // Yearly: ₪1,200 a time, so ₪100 a month.
    for (const date of ["2025-07-20", "2026-07-20"]) {
      await insertEntry({ description: "CAR INSURANCE", date, amount: "-1200.00", categoryId: bills }); // prettier-ignore
    }

    // Irregular: no period to divide by. ₪90 + ₪30 across Mar–Jul, five
    // calendar months.
    await insertEntry({ description: "HANDYMAN", date: "2026-03-01", amount: "-90.00", categoryId: bills }); // prettier-ignore
    await insertEntry({ description: "HANDYMAN", date: "2026-07-25", amount: "-30.00", categoryId: bills }); // prettier-ignore

    session = {
      id: "test-session",
      userId,
      dataKey: Buffer.from(dataKey),
      baseCurrency: "ILS",
      promptSyncOnLogin: false,
      expiresAt: Date.now() + 3_600_000,
    };
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  it("leaves a monthly payee's figure alone", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const row = rowNamed(view, "mobile plan");
    expect(row?.cadence).toBe("monthly");
    expect(row?.monthlyAverage.amount).toBe("100");
    expect(row?.monthlyAverageIsEstimate).toBe(false);
  });

  it("spreads a two-monthly bill over the months it covers", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const row = rowNamed(view, "arnona");
    expect(row?.cadence).toBe("bi-monthly");
    expect(row?.averageOfLast3.amount).toBe("600");
    expect(row?.monthlyAverage.amount).toBe("300");
  });

  it("spreads a yearly bill over twelve months", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const row = rowNamed(view, "car insurance");
    expect(row?.cadence).toBe("yearly");
    expect(row?.averageOfLast3.amount).toBe("1200");
    expect(row?.monthlyAverage.amount).toBe("100");
  });

  it("estimates an irregular payee from its observed span and says so", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const row = rowNamed(view, "handyman");
    expect(row?.cadence).toBe("irregular");
    // (90 + 30) over March..July inclusive = five months.
    expect(row?.monthlyAverage.amount).toBe("24");
    expect(row?.monthlyAverageIsEstimate).toBe(true);
  });

  it("sums the category's per-month figure across cadences", async () => {
    const view = await getRecurringView(session, { range: "all" });
    // 100 monthly + 300 bi-monthly + 100 yearly + 24 estimated.
    expect(view.expenses[0].monthlyAverage.amount).toBe("524");
    expect(view.expenses[0].monthlyAverageIsEstimate).toBe(true);
  });

  it("holds the per-month figure steady while the range total moves", async () => {
    const year = await getRecurringView(session, { range: "1y" });
    const quarter = await getRecurringView(session, { range: "3m" });
    expect(quarter.expenses[0].monthlyAverage).toEqual(year.expenses[0].monthlyAverage);
    // The total is the thing that was being read as a monthly number.
    expect(quarter.expenses[0].total.amount).not.toBe(year.expenses[0].total.amount);
  });
});
