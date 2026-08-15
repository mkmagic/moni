// src/domain/recurring.ts — the read behind /transactions/recurring.
// Everything it reports is derived; the only stored state involved is
// `categories.is_recurring` (docs/adr/0006-*).
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
let subscriptionsId: string;

interface EntrySpec {
  description: string;
  date: string;
  amount: string;
  categoryId: string;
  fxPending?: boolean;
}

async function insertEntry(spec: EntrySpec): Promise<void> {
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
    fxRate: spec.fxPending ? null : "1",
    fxRateDate: spec.date,
    fxSource: spec.fxPending ? null : "test",
    fxStatus: spec.fxPending ? "pending" : "locked",
    source: "scrape",
  });
}

async function insertCategory(
  name: string,
  classification: "income" | "expense",
  isRecurring: boolean,
): Promise<string> {
  const id = randomUUID();
  await elevatedDb
    .insert(schema.categories)
    .values({ id, ownerId: userId, name, classification, isRecurring });
  return id;
}

describe("getRecurringView", () => {
  beforeAll(async () => {
    userId = randomUUID();
    dataKey = getDevUserDataKey(userId);
    await elevatedDb
      .insert(schema.users)
      .values({ id: userId, email: `rec-${randomUUID()}@test.moni`, baseCurrency: "ILS" });

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

    subscriptionsId = await insertCategory("Subscriptions", "expense", true);
    const salary = await insertCategory("Salary", "income", true);
    const groceries = await insertCategory("Groceries", "expense", false);

    // Netflix, monthly, with a price rise in the third month — the case that
    // decided the headline is the latest amount, not the 3-average.
    await insertEntry({ description: "NETFLIX", date: "2026-05-05", amount: "-45.00", categoryId: subscriptionsId }); // prettier-ignore
    await insertEntry({ description: "NETFLIX", date: "2026-06-05", amount: "-45.00", categoryId: subscriptionsId }); // prettier-ignore
    await insertEntry({ description: "NETFLIX", date: "2026-07-05", amount: "-63.00", categoryId: subscriptionsId }); // prettier-ignore

    // A single one-off filed in a recurring category. Deliberately NOT
    // hidden: it shows with one payment, which is what makes it look odd.
    await insertEntry({ description: "APP STORE ONE OFF", date: "2026-06-20", amount: "-19.90", categoryId: subscriptionsId }); // prettier-ignore

    // No locked FX rate — skipped everywhere, never counted at 1:1.
    await insertEntry({ description: "SPOTIFY", date: "2026-07-02", amount: "-21.00", categoryId: subscriptionsId, fxPending: true }); // prettier-ignore

    // Income side.
    await insertEntry({ description: "MONTHLY SALARY", date: "2026-05-01", amount: "12500.00", categoryId: salary }); // prettier-ignore
    await insertEntry({ description: "MONTHLY SALARY", date: "2026-06-01", amount: "12500.00", categoryId: salary }); // prettier-ignore
    await insertEntry({ description: "MONTHLY SALARY", date: "2026-07-01", amount: "13000.00", categoryId: salary }); // prettier-ignore

    // Not a recurring category — must never appear.
    await insertEntry({ description: "SHUFERSAL", date: "2026-07-03", amount: "-312.50", categoryId: groceries }); // prettier-ignore

    session = {
      id: "test-session",
      userId,
      dataKey: Buffer.from(dataKey),
      baseCurrency: "ILS",
      syncPromptDismissed: false,
      expiresAt: Date.now() + 3_600_000,
    };
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  it("splits income from expenses and never offers a combined total", async () => {
    const view = await getRecurringView(session, { range: "all" });
    expect(view.expenses.map((g) => g.categoryName)).toEqual(["Subscriptions"]);
    expect(view.income.map((g) => g.categoryName)).toEqual(["Salary"]);
    expect(view).not.toHaveProperty("total");
  });

  it("leaves out a category the user has not flagged recurring", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const allCategories = [...view.income, ...view.expenses].map((g) => g.categoryName);
    expect(allCategories).not.toContain("Groceries");
  });

  it("headlines the latest amount and shows the 3-average beneath it", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const netflix = view.expenses[0].rows.find((r) => r.merchantName === "Netflix");
    // The price rise: latest is 63, the 3-average is (45+45+63)/3 = 51.
    expect(netflix?.latest.amount).toBe("63");
    expect(netflix?.averageOfLast3.amount).toBe("51");
  });

  it("reports how long a payee has been recurring, which is what exposes a one-off", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const rows = view.expenses[0].rows;
    const netflix = rows.find((r) => r.merchantName === "Netflix");
    expect(netflix?.paymentCount).toBe(3);
    expect(netflix?.firstSeen).toBe("2026-05-05");
    expect(netflix?.cadence).toBe("monthly");

    const oneOff = rows.find((r) => r.merchantName === "app store one off");
    expect(oneOff?.paymentCount).toBe(1);
    expect(oneOff?.cadence).toBe("unknown");
  });

  it("skips an entry with no locked FX rate rather than counting it at 1:1", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const names = view.expenses[0].rows.map((r) => r.merchantName);
    expect(names).not.toContain("Spotify");
    // 45 + 45 + 63 + 19.90, with the pending 21.00 left out.
    expect(view.expenses[0].total.amount).toBe("172.9");
  });

  it("reports expense totals as positive magnitudes, like the dashboard", async () => {
    const view = await getRecurringView(session, { range: "all" });
    expect(view.expenses[0].total.amount).not.toMatch(/^-/);
    expect(view.income[0].total.amount).toBe("38000");
  });

  it("rolls the categories up into per-section aggregates, income apart from expenses (#98)", async () => {
    const view = await getRecurringView(session, { range: "all" });

    // Expenses: Netflix's 51/mo plus the App Store one-off spread over its one
    // observed month (19.90) — 70.90/mo, flagged an estimate because the
    // one-off's cadence is unknown. The range total matches the category's.
    expect(view.expensesSummary.monthlyAverage.amount).toBe("70.9");
    expect(view.expensesSummary.monthlyAverageIsEstimate).toBe(true);
    expect(view.expensesSummary.total.amount).toBe("172.9");

    // Income is summed on its own — never folded in with expenses.
    expect(view.incomeSummary.total.amount).toBe("38000");
    expect(view).not.toHaveProperty("summary");
  });

  it("narrows category totals to the selected range, leaving row headlines alone", async () => {
    // "3m" from the latest entry (2026-07-05) reaches back to 2026-04-05, so
    // everything is in range; "1m" would need a range key we don't offer.
    const all = await getRecurringView(session, { range: "all" });
    const year = await getRecurringView(session, { range: "1y" });
    expect(year.expenses[0].total).toEqual(all.expenses[0].total);

    const netflixAll = all.expenses[0].rows.find((r) => r.merchantName === "Netflix");
    const netflixYear = year.expenses[0].rows.find((r) => r.merchantName === "Netflix");
    expect(netflixYear?.latest).toEqual(netflixAll?.latest);
    expect(netflixYear?.paymentCount).toBe(netflixAll?.paymentCount);
  });

  it("returns every payment for the graph, oldest first", async () => {
    const view = await getRecurringView(session, { range: "all" });
    const netflix = view.expenses[0].rows.find((r) => r.merchantName === "Netflix");
    expect(netflix?.payments.map((p) => p.date)).toEqual([
      "2026-05-05",
      "2026-06-05",
      "2026-07-05",
    ]);
    expect(netflix?.payments.map((p) => p.amount.amount)).toEqual(["45", "45", "63"]);
  });

  it("upgrades a match-text fallback to the current catalog presentation", async () => {
    const merchantId = randomUUID();
    const matchText = "openai chatgpt subs";
    await elevatedDb.insert(schema.merchants).values({
      id: merchantId,
      ownerId: userId,
      nameCt: enc(dataKey, merchantId, "name_ct", matchText),
      matchTextCt: enc(dataKey, merchantId, "match_text_ct", matchText),
      source: "match_text",
    });
    await insertEntry({
      description: "OPENAI CHATGPT SUBS",
      date: "2026-08-01",
      amount: "-70.00",
      categoryId: subscriptionsId,
    });

    const view = await getRecurringView(session, { range: "all" });
    const openai = view.expenses[0].rows.find((r) => r.matchText === matchText);
    expect(openai).toMatchObject({
      merchantName: "OpenAI",
      matchText,
      logoUrl: "/merchants/openai.png",
    });
  });

  it("does not replace a curated merchant name with the catalog name", async () => {
    const merchantId = randomUUID();
    const matchText = "anthropic claude";
    await elevatedDb.insert(schema.merchants).values({
      id: merchantId,
      ownerId: userId,
      nameCt: enc(dataKey, merchantId, "name_ct", "Claude Team"),
      matchTextCt: enc(dataKey, merchantId, "match_text_ct", matchText),
      source: "external",
    });
    await insertEntry({
      description: "ANTHROPIC CLAUDE",
      date: "2026-08-02",
      amount: "-59.00",
      categoryId: subscriptionsId,
    });

    const view = await getRecurringView(session, { range: "all" });
    const anthropic = view.expenses[0].rows.find((r) => r.matchText === matchText);
    expect(anthropic).toMatchObject({
      merchantName: "Claude Team",
      matchText,
      logoUrl: "/merchants/anthropic.png",
    });
  });
});
