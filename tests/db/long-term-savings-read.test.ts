// Read gate for src/domain/long-term-savings.ts and the account grouping the
// accounts page reads (#77 §1/§2/§3). What only a database can show: an
// imported report comes back decrypted with the newest snapshot chosen, the fee
// verdict is decided on the exact decimals rather than in the UI, and a pension
// balance lands in its own asset group with a subtotal.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { listAccountsGrouped } from "@/domain/accounts";
import { encText } from "@/domain/fields";
import {
  listLongTermSavingsAccounts,
  listLongTermSavingsSummaries,
} from "@/domain/long-term-savings";
import { promoteLongTermSavingsSnapshot } from "@/domain/long-term-savings-promotion";
import {
  harelPensionQuarterlyParser,
  type HarelPensionQuarterlyReport,
} from "@/lib/connectors/documents/harel/pension-quarterly";
import type { Session } from "@/lib/auth/session-store";
import type { Item } from "@/lib/connectors/documents/pdf-text";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");

const owners: string[] = [];
afterAll(() => cleanupOwners(owners));

function report(name: string): HarelPensionQuarterlyReport {
  const items = JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/long-term-savings", `${name}.json`), "utf8"),
  ) as Item[];
  return harelPensionQuarterlyParser.parse(items);
}

const q1 = report("harel-pension-2026-q1");
const q3 = report("harel-pension-2025-q3");

async function fixture() {
  const { userId, dataKey } = await createUser(
    `${randomUUID()}@test.moni`,
    Buffer.from("test password"),
    SIGNUP_TOKEN!,
  );
  owners.push(userId);
  const connectionId = randomUUID();
  await withUser(userId, async (tx) => {
    await tx.insert(schema.connections).values({
      id: connectionId,
      ownerId: userId,
      connectorId: "harel_pension_quarterly",
      mode: "user_mediated_import",
      status: "active",
    });
  });
  const session = { id: randomUUID(), userId, dataKey, baseCurrency: "ILS" } as Session;
  return { userId, dataKey, connectionId, session };
}

async function importReport(
  ctx: Awaited<ReturnType<typeof fixture>>,
  parsed: HarelPensionQuarterlyReport,
) {
  const syncRunId = randomUUID();
  await withUser(ctx.userId, async (tx) => {
    await tx.insert(schema.syncRuns).values({
      id: syncRunId,
      ownerId: ctx.userId,
      connectionId: ctx.connectionId,
      status: "running",
    });
  });
  return promoteLongTermSavingsSnapshot({
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    syncRunId,
    dataKey: ctx.dataKey,
    parserId: harelPensionQuarterlyParser.id,
    parserVersion: harelPensionQuarterlyParser.version,
    product: "pension",
    accountLabel: "Harel Quarterly Pension Report",
    report: parsed,
  });
}

describe("listLongTermSavingsAccounts", () => {
  it("returns the imported report decrypted, with its flows labelled by the stated period", async () => {
    const ctx = await fixture();
    await importReport(ctx, q1);

    const [account] = await listLongTermSavingsAccounts(ctx.session);
    expect(account.name).toBe("Harel Quarterly Pension Report");
    expect(account.product).toBe("pension");
    expect(account.liquidity).toBe("locked_retirement");
    expect(account.latest).toMatchObject({
      asOf: "2026-03-31",
      quarter: 1,
      fiscalYear: 2026,
      // Year-to-date on the page, so the screen can never call it "this
      // quarter" without saying which months it covers (#76 D6).
      statedPeriodStart: "2026-01-01",
      statedPeriodEnd: "2026-03-31",
      closingBalance: { amount: "76243", currency: "ILS" },
      contributions: { amount: "7076", currency: "ILS" },
      investmentResult: { amount: "-2954", currency: "ILS" },
    });
    expect(account.latest!.deposits).toHaveLength(4);
    expect(account.latest!.tracks).toEqual([
      {
        rowIndex: 0,
        name: "עוקב מדד S&P 500",
        returnPercent: "-3.81",
        annualCostPercent: "0.10",
      },
    ]);
  });

  it("stays quiet about fees when the member is at or below the fund average", async () => {
    const ctx = await fixture();
    await importReport(ctx, q1);

    const [account] = await listLongTermSavingsAccounts(ctx.session);
    expect(account.latest!.fees).toMatchObject({
      onDeposit: "0.00",
      onSavings: "0.0018",
      fundAverageOnDeposit: "1.47",
      fundAverageOnSavings: "0.13",
      aboveAverage: [],
    });
  });

  it("names every dimension the member pays above the fund average on", async () => {
    const ctx = await fixture();
    await importReport(ctx, {
      ...q1,
      managementFees: {
        onDeposit: "1.80",
        onSavings: "0.50",
        fundAverageOnDeposit: "1.47",
        fundAverageOnSavings: "0.13",
      },
    });

    const [account] = await listLongTermSavingsAccounts(ctx.session);
    expect(account.latest!.fees.aboveAverage).toEqual([
      { dimension: "deposits", rate: "1.80", fundAverage: "1.47" },
      { dimension: "savings", rate: "0.50", fundAverage: "0.13" },
    ]);
  });

  it("shows the newest report when several have been imported", async () => {
    const ctx = await fixture();
    // Backfilled out of order on purpose: "newest" must come from `as_of`, not
    // from which import happened to run last.
    await importReport(ctx, q1);
    await importReport(ctx, q3);

    const [account] = await listLongTermSavingsAccounts(ctx.session);
    expect(account.latest!.asOf).toBe("2026-03-31");

    const summaries = await listLongTermSavingsSummaries(ctx.session);
    expect(summaries.get(account.accountId)).toMatchObject({
      asOf: "2026-03-31",
      quarter: 1,
      fiscalYear: 2026,
      liquidity: "locked_retirement",
    });
  });
});

/**
 * A second 2026 report, so the fiscal year has two statements to difference.
 * The fixtures are Q1 2026 and Q3 2025 — different years, which is the case
 * that must NOT be differenced.
 */
const q2 = {
  ...q1,
  reportDate: "2026-06-30",
  quarter: 2,
  statedPeriodEnd: "2026-06-30",
  movements: {
    ...q1.movements,
    contributions: "14000",
    investmentResult: "-1000",
    disabilityInsuranceCost: "-262",
    deathInsuranceCost: "-106",
    // Balances the equation: 72306 + 14000 - 1000 + 0 - 262 - 106.
    closingBalance: "84938",
  },
};

describe("report history", () => {
  it("differences a report against the previous one of the same fiscal year", async () => {
    const ctx = await fixture();
    await importReport(ctx, q1);
    await importReport(ctx, q2);

    const [account] = await listLongTermSavingsAccounts(ctx.session);
    expect(account.reports.map((report) => report.asOf)).toEqual(["2026-06-30", "2026-03-31"]);
    expect(account.reports[0].period).toMatchObject({
      // Starts the day after Q1's stated period ended, not in January.
      start: "2026-04-01",
      end: "2026-06-30",
      includesEarlierQuarters: false,
      contributions: { amount: "6924", currency: "ILS" },
      investmentResult: { amount: "1954", currency: "ILS" },
    });
    // The first report of a year has nothing to difference against, and needs
    // nothing: Q1's year-to-date already IS its quarter, so no caveat.
    expect(account.reports[1].period).toMatchObject({
      start: "2026-01-01",
      includesEarlierQuarters: false,
      contributions: { amount: "7076", currency: "ILS" },
    });
  });

  it("splits the year-to-date figures so no month is counted twice", async () => {
    const ctx = await fixture();
    await importReport(ctx, q1);
    await importReport(ctx, q2);

    const [account] = await listLongTermSavingsAccounts(ctx.session);
    // The two reports state 7,076 and 14,000 year-to-date. Read as periods they
    // partition the half-year exactly, which is what makes them addable at all.
    expect(account.reports.map((report) => report.period.contributions.amount).reverse()).toEqual([
      "7076",
      "6924",
    ]);
  });

  it("never differences across a fiscal year", async () => {
    const ctx = await fixture();
    await importReport(ctx, q3);
    await importReport(ctx, q1);

    const [account] = await listLongTermSavingsAccounts(ctx.session);
    // Q1 2026 restates from January, so subtracting Q3 2025 would be nonsense.
    // It still needs no caveat — Q1's year-to-date is exactly its quarter.
    expect(account.reports[0]).toMatchObject({
      asOf: "2026-03-31",
      period: { start: "2026-01-01", includesEarlierQuarters: false },
    });
    // Q3 does: ₪19,371 is nine months of contributions, not July–September,
    // and no Q1 or Q2 2025 report was imported to narrow it.
    expect(account.reports[1].period).toMatchObject({
      start: "2025-01-01",
      includesEarlierQuarters: true,
    });
  });
});

describe("listAccountsGrouped", () => {
  it("puts a pension in its own group and subtotals it", async () => {
    const ctx = await fixture();
    await importReport(ctx, q1);

    const grouped = await listAccountsGrouped(ctx.session);
    expect(grouped.assetGroups.map((group) => group.key)).toEqual(["long_term_savings"]);
    expect(grouped.assetGroups[0].subtotal).toEqual({ amount: "76243", currency: "ILS" });
    expect(grouped.assetGroups[0].unvaluedCount).toBe(0);
    expect(grouped.liabilities).toEqual([]);
  });

  it("merges checking and savings into one Cash group, ordered ahead of the rest", async () => {
    const ctx = await fixture();
    await importReport(ctx, q1);
    await withUser(ctx.userId, async (tx) => {
      for (const accountType of ["checking", "savings"] as const) {
        const id = randomUUID();
        await tx.insert(schema.accounts).values({
          id,
          ownerId: ctx.userId,
          accountType,
          classification: "asset",
          nameCt: encText(ctx.dataKey, accountType, id, "name_ct", 1),
          currency: "ILS",
          status: "active",
        });
      }
    });

    const grouped = await listAccountsGrouped(ctx.session);
    expect(grouped.assetGroups.map((group) => group.key)).toEqual(["cash", "long_term_savings"]);
    expect(grouped.assetGroups[0].accounts).toHaveLength(2);
    // Neither cash account has a stored balance, so the subtotal says so
    // rather than quietly reading zero.
    expect(grouped.assetGroups[0]).toMatchObject({
      subtotal: { amount: "0", currency: "ILS" },
      unvaluedCount: 2,
    });
  });
});
