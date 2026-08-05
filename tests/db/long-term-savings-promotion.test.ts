// Promotion gate for src/domain/long-term-savings-promotion.ts — the four
// behaviours issue #76 lists under Verification that only a database can show:
// a real report imports end to end, re-importing it is idempotent, backfilling
// an older report leaves the cached balance alone, and a corrupted balance
// fails at ±₪50 having written nothing.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { decText } from "@/domain/fields";
import {
  LongTermSavingsPromotionError,
  promoteLongTermSavingsSnapshot,
} from "@/domain/long-term-savings-promotion";
import {
  harelPensionQuarterlyParser,
  type HarelPensionQuarterlyReport,
} from "@/lib/connectors/documents/harel/pension-quarterly";
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

/** A user with a Harel connection and a sync run already marked running. */
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
  return { userId, dataKey, connectionId };
}

async function startRun(userId: string, connectionId: string): Promise<string> {
  const syncRunId = randomUUID();
  await withUser(userId, async (tx) => {
    await tx
      .insert(schema.syncRuns)
      .values({ id: syncRunId, ownerId: userId, connectionId, status: "running" });
  });
  return syncRunId;
}

async function importReport(
  ctx: Awaited<ReturnType<typeof fixture>>,
  parsed: HarelPensionQuarterlyReport,
) {
  return promoteLongTermSavingsSnapshot({
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    syncRunId: await startRun(ctx.userId, ctx.connectionId),
    dataKey: ctx.dataKey,
    parserId: harelPensionQuarterlyParser.id,
    parserVersion: harelPensionQuarterlyParser.version,
    product: "pension",
    accountLabel: "Harel Quarterly Pension Report",
    report: parsed,
  });
}

async function cachedBalance(userId: string, dataKey: Uint8Array, accountId: string) {
  return withUser(userId, async (tx) => {
    const [row] = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
    return decText(dataKey, row.currentBalanceCt, row.id, "current_balance_ct", row.version);
  });
}

describe("promoteLongTermSavingsSnapshot", () => {
  it("imports a report end to end and leaves the account showing its closing balance", async () => {
    const ctx = await fixture();
    const result = await importReport(ctx, q1);

    expect(result).toMatchObject({
      asOf: "2026-03-31",
      isLatest: true,
      depositRows: 4,
      trackRows: 1,
      balanceDrift: "1",
    });
    expect(await cachedBalance(ctx.userId, ctx.dataKey, result.accountId)).toBe("76243");

    await withUser(ctx.userId, async (tx) => {
      const [account] = await tx
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, result.accountId));
      expect(account.accountType).toBe("long_term_savings");
      expect(account.classification).toBe("asset");
      expect(account.currency).toBe("ILS");

      const [details] = await tx
        .select()
        .from(schema.longTermSavingsDetails)
        .where(eq(schema.longTermSavingsDetails.accountId, result.accountId));
      expect(details).toMatchObject({ product: "pension", liquidity: "locked_retirement" });

      // The balance also lands in account_balance_snapshots, which is what
      // puts it into net-worth history and not just today's figure.
      const [balance] = await tx
        .select()
        .from(schema.accountBalanceSnapshots)
        .where(eq(schema.accountBalanceSnapshots.accountId, result.accountId));
      expect(balance.date).toBe("2026-03-31");
      expect(balance.source).toBe("long_term_savings");
      expect(
        decText(
          ctx.dataKey,
          balance.nativeBalanceCt,
          balance.id,
          "native_balance_ct",
          balance.version,
        ),
      ).toBe("76243");

      const [snapshot] = await tx
        .select()
        .from(schema.longTermSavingsSnapshots)
        .where(eq(schema.longTermSavingsSnapshots.id, result.snapshotId));
      // Flows are stated year-to-date, stored for the period the document
      // itself asserts (D6).
      expect(snapshot).toMatchObject({
        statedPeriodStart: "2026-01-01",
        statedPeriodEnd: "2026-03-31",
        quarter: 1,
        fiscalYear: 2026,
        parserId: "harel_pension_quarterly",
        parserVersion: 1,
      });
      const money = (ct: Buffer | null, column: string) =>
        decText(ctx.dataKey, ct, snapshot.id, column, snapshot.version);
      expect(money(snapshot.openingBalanceCt, "opening_balance_ct")).toBe("72306");
      expect(money(snapshot.contributionsCt, "contributions_ct")).toBe("7076");
      expect(money(snapshot.investmentResultCt, "investment_result_ct")).toBe("-2954");
      // Stored, never displayed in v1 (D8).
      expect(snapshot.projectionRetirementAge).toBe(60);
      expect(money(snapshot.projectionMonthlyPensionCt, "projection_monthly_pension_ct")).toBe(
        "1290",
      );
      // Printed as a dash on this report, so genuinely absent rather than zero.
      expect(snapshot.projectionSurvivorPensionCt).toBeNull();
      // The printed totals row is stored, not re-summed — the PDF is discarded,
      // so anything the parser reads and doesn't persist is unrecoverable (D10).
      expect(money(snapshot.depositsTotalCt, "deposits_total_ct")).toBe("7076");
      expect(money(snapshot.depositsTotalSeveranceCt, "deposits_total_severance_ct")).toBe("1578");

      const deposits = await tx
        .select()
        .from(schema.longTermSavingsSnapshotDeposits)
        .where(eq(schema.longTermSavingsSnapshotDeposits.snapshotId, result.snapshotId))
        .orderBy(schema.longTermSavingsSnapshotDeposits.rowIndex);
      expect(deposits).toHaveLength(4);
      expect(deposits[3]).toMatchObject({ depositDate: "2026-03-01", forMonth: "2026-03" });
      // The self-employed row has no salary cell.
      expect(deposits[3].salaryCt).toBeNull();

      // No ledger entries — a deposit table is not a transaction feed (D3).
      expect(await tx.select().from(schema.entries)).toHaveLength(0);
    });
  });

  it("replaces the snapshot in place when the same report is imported again", async () => {
    const ctx = await fixture();
    const first = await importReport(ctx, q1);
    const second = await importReport(ctx, q1);

    expect(second.accountId).toBe(first.accountId);
    expect(second.snapshotId).not.toBe(first.snapshotId);

    await withUser(ctx.userId, async (tx) => {
      expect(await tx.select().from(schema.longTermSavingsSnapshots)).toHaveLength(1);
      expect(await tx.select().from(schema.accountBalanceSnapshots)).toHaveLength(1);
      // The superseded snapshot's children went with it rather than being
      // orphaned or duplicated.
      expect(await tx.select().from(schema.longTermSavingsSnapshotDeposits)).toHaveLength(4);
      expect(await tx.select().from(schema.longTermSavingsSnapshotTracks)).toHaveLength(1);
    });
    expect(await cachedBalance(ctx.userId, ctx.dataKey, first.accountId)).toBe("76243");
  });

  it("adds history without disturbing the cached balance when an older report is backfilled", async () => {
    const ctx = await fixture();
    const newer = await importReport(ctx, q1);
    const older = await importReport(ctx, q3);

    expect(older.isLatest).toBe(false);
    expect(older.accountId).toBe(newer.accountId);
    await withUser(ctx.userId, async (tx) => {
      const rows = await tx
        .select({ asOf: schema.longTermSavingsSnapshots.asOf })
        .from(schema.longTermSavingsSnapshots)
        .orderBy(schema.longTermSavingsSnapshots.asOf);
      expect(rows.map((row) => row.asOf)).toEqual(["2025-09-30", "2026-03-31"]);
    });
    // Still the Q1 2026 closing balance, not the older Q3 2025 one.
    expect(await cachedBalance(ctx.userId, ctx.dataKey, newer.accountId)).toBe("76243");
  });

  it("carries the whole multi-page deposits table onto the snapshot", async () => {
    const ctx = await fixture();
    const result = await importReport(ctx, q3);
    expect(result.depositRows).toBe(21);
    // Real drift on a real document, well past a naive rounding bound and well
    // inside the ±₪50 gate.
    expect(result.balanceDrift).toBe("11");
  });

  it("fails at ±₪50 and writes nothing", async () => {
    const ctx = await fixture();
    const corrupted: HarelPensionQuarterlyReport = {
      ...q1,
      movements: { ...q1.movements, closingBalance: "76343" },
    };
    const syncRunId = await startRun(ctx.userId, ctx.connectionId);

    await expect(
      promoteLongTermSavingsSnapshot({
        userId: ctx.userId,
        connectionId: ctx.connectionId,
        syncRunId,
        dataKey: ctx.dataKey,
        parserId: harelPensionQuarterlyParser.id,
        parserVersion: harelPensionQuarterlyParser.version,
        product: "pension",
        accountLabel: "Harel Quarterly Pension Report",
        report: corrupted,
      }),
    ).rejects.toThrow(LongTermSavingsPromotionError);

    await withUser(ctx.userId, async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.id, syncRunId));
      expect(run.status).toBe("failed");
      expect(run.error).toContain("balance_check_failed");
      // The failing check is named, and nothing else. sync_runs.error is a
      // plaintext column, and both the balances and the drift derived from
      // them are Tier-1 — the equation expects 76244 against a printed 76343,
      // so neither those nor the drift of 99 may appear here.
      expect(run.error).toBe("balance_check_failed: balance_equation");

      expect(await tx.select().from(schema.longTermSavingsSnapshots)).toHaveLength(0);
      expect(await tx.select().from(schema.accountBalanceSnapshots)).toHaveLength(0);
      expect(await tx.select().from(schema.accounts)).toHaveLength(0);
    });
  });

  it("refuses a connection whose account is not long-term savings", async () => {
    const ctx = await fixture();
    const accountId = randomUUID();
    await withUser(ctx.userId, async (tx) => {
      await tx.insert(schema.accounts).values({
        id: accountId,
        ownerId: ctx.userId,
        accountType: "investment",
        classification: "asset",
        connectionId: ctx.connectionId,
        nameCt: Buffer.from("x"),
        currency: "ILS",
        status: "active",
      });
    });

    await expect(importReport(ctx, q1)).rejects.toMatchObject({
      code: "account_type_mismatch",
    });
    await withUser(ctx.userId, async (tx) => {
      expect(await tx.select().from(schema.longTermSavingsSnapshots)).toHaveLength(0);
    });
  });

  it("keeps one user's snapshots invisible to another", async () => {
    const mine = await fixture();
    const theirs = await fixture();
    await importReport(mine, q1);

    await withUser(theirs.userId, async (tx) => {
      expect(await tx.select().from(schema.longTermSavingsSnapshots)).toHaveLength(0);
      expect(await tx.select().from(schema.longTermSavingsSnapshotDeposits)).toHaveLength(0);
      expect(await tx.select().from(schema.longTermSavingsDetails)).toHaveLength(0);
    });
  });
});
