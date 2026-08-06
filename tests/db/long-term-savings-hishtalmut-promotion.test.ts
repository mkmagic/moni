// Promotion gate for the קרן השתלמות import path.
//
// The pension suite next door already covers what promotion does for EVERY
// product — idempotent re-import, backfill leaving the cached balance alone, a
// corrupted balance failing at ±₪50 having written nothing. Repeating those
// here would only re-test promotion.
//
// What is specific to this product is what the report does NOT carry, and
// what the schema stores in its place: no insurance lines, no severance
// column, no pension projections, and — uniquely — a withdrawal date that is
// the whole reason the account is `liquid_after` rather than merely locked.
// Those are the assertions below.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { promoteLongTermSavingsSnapshot } from "@/domain/long-term-savings-promotion";
import { decText } from "@/domain/fields";
import {
  harelHishtalmutParser,
  normaliseHarelHishtalmut,
} from "@/lib/connectors/documents/harel/hishtalmut";
import type { LongTermSavingsReport } from "@/lib/connectors/documents/long-term-savings-report";
import type { Item } from "@/lib/connectors/documents/pdf-text";
import { eq } from "drizzle-orm";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");

const owners: string[] = [];
afterAll(() => cleanupOwners(owners));

function report(name: string): LongTermSavingsReport {
  const items = JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/long-term-savings", `${name}.json`), "utf8"),
  ) as Item[];
  return normaliseHarelHishtalmut(harelHishtalmutParser.parse(items));
}

const q3 = report("harel-hishtalmut-2025-q3");
const annual = report("harel-hishtalmut-2025-annual");

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
      connectorId: "harel_hishtalmut",
      mode: "user_mediated_import",
      status: "active",
    });
  });
  return { userId, dataKey, connectionId };
}

async function importReport(
  ctx: Awaited<ReturnType<typeof fixture>>,
  parsed: LongTermSavingsReport,
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
    parserId: harelHishtalmutParser.id,
    parserVersion: harelHishtalmutParser.version,
    product: "hishtalmut",
    accountLabel: "Harel קרן השתלמות",
    report: parsed,
  });
}

describe("promoteLongTermSavingsSnapshot — קרן השתלמות", () => {
  it("imports a quarterly report end to end", async () => {
    const ctx = await fixture();
    const result = await importReport(ctx, q3);

    expect(result.depositRows).toBe(15);
    expect(result.trackRows).toBe(1);
    // Section ב has four terms here and closes exactly, unlike the pension
    // report's six.
    expect(result.balanceDrift).toBe("0");
    expect(result.isLatest).toBe(true);

    const [account] = await withUser(ctx.userId, (tx) =>
      tx.select().from(schema.accounts).where(eq(schema.accounts.id, result.accountId)),
    );
    expect(account.accountType).toBe("long_term_savings");
    expect(
      decText(
        ctx.dataKey,
        account.currentBalanceCt,
        account.id,
        "current_balance_ct",
        account.version,
      ),
    ).toBe("6109");
  });

  it("records the withdrawal date the report prints, so the account is liquid from a date", async () => {
    const ctx = await fixture();
    const result = await importReport(ctx, q3);

    const [details] = await withUser(ctx.userId, (tx) =>
      tx
        .select()
        .from(schema.longTermSavingsDetails)
        .where(eq(schema.longTermSavingsDetails.accountId, result.accountId)),
    );
    expect(details.product).toBe("hishtalmut");
    expect(details.liquidity).toBe("liquid_after");
    // Without this the liquidity would say "liquid from a date" and carry no
    // date, and the PDF it came from is discarded after parsing.
    expect(details.liquidFrom).toBe("2030-03-31");
  });

  it("stores the absent insurance and severance figures as ₪0, and no projections", async () => {
    const ctx = await fixture();
    const result = await importReport(ctx, q3);

    const [snapshot] = await withUser(ctx.userId, (tx) =>
      tx
        .select()
        .from(schema.longTermSavingsSnapshots)
        .where(eq(schema.longTermSavingsSnapshots.id, result.snapshotId)),
    );
    const money = (ct: Uint8Array | null, column: string) =>
      ct === null ? null : decText(ctx.dataKey, ct, snapshot.id, column, snapshot.version);

    expect(money(snapshot.insuranceDisabilityCt, "insurance_disability_ct")).toBe("0");
    expect(money(snapshot.insuranceDeathCt, "insurance_death_ct")).toBe("0");
    // The deposits table prints no severance total at all, so this stays null
    // rather than becoming a zero that looks like a stated figure.
    expect(snapshot.depositsTotalSeveranceCt).toBeNull();
    expect(snapshot.projectionRetirementAge).toBeNull();
    expect(snapshot.projectionMonthlyPensionCt).toBeNull();
    // No deposit fee on this product; the savings rate and fund average are real.
    expect(snapshot.feeRateDeposit).toBeNull();
    expect(snapshot.feeRateSavings).toBe("0.18");
    expect(snapshot.fundAvgFeeSavings).toBe("0.20");

    const [row] = await withUser(ctx.userId, (tx) =>
      tx
        .select()
        .from(schema.longTermSavingsSnapshotDeposits)
        .where(eq(schema.longTermSavingsSnapshotDeposits.snapshotId, result.snapshotId)),
    );
    expect(decText(ctx.dataKey, row.severanceCt, row.id, "severance_ct", row.version)).toBe("0");
    // No employer column on this table — the employer is stated once in the
    // page header and is not a property of a row.
    expect(row.employerCt).toBeNull();
  });

  it("stores the annual report's extra fee rate and its derived period", async () => {
    const ctx = await fixture();
    const result = await importReport(ctx, annual);

    const [snapshot] = await withUser(ctx.userId, (tx) =>
      tx
        .select()
        .from(schema.longTermSavingsSnapshots)
        .where(eq(schema.longTermSavingsSnapshots.id, result.snapshotId)),
    );
    expect(result.depositRows).toBe(21);
    expect(snapshot.asOf).toBe("2025-12-31");
    expect(snapshot.quarter).toBeNull();
    expect(snapshot.fiscalYear).toBe(2025);
    expect(snapshot.statedPeriodStart).toBe("2025-01-01");
    expect(snapshot.statedPeriodEnd).toBe("2025-12-31");
    // Printed only on the annual report, and the column that holds it is the
    // one thing this parser needed the schema to grow.
    expect(snapshot.feeRateInvestmentExpenses).toBe("0.22");
  });
});
