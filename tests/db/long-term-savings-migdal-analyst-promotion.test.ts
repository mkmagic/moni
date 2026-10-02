// Promotion gate for the Migdal pension and Analyst קרן השתלמות imports.
//
// The pension suite already covers what promotion does for every product
// (idempotent re-import, backfill, the ±₪50 gate writing nothing). What is
// specific here is what these reports carry that Harel's do not: Migdal's
// transfer-in and actuarial-adjustment lines, which the schema grew columns
// for, and its blank first-year opening balance; and Analyst's empty deposits
// table on an account that is still `liquid_after` a printed date.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { decText } from "@/domain/fields";
import { promoteLongTermSavingsSnapshot } from "@/domain/long-term-savings-promotion";
import { createUser } from "@/domain/registration";
import { LONG_TERM_SAVINGS_IMPORTERS } from "@/lib/connectors/documents/registry";
import type { LongTermSavingsProduct } from "@/lib/connectors";
import type { ConnectorId } from "@/lib/connectors/types";
import type { Item } from "@/lib/connectors/documents/pdf-text";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");

const owners: string[] = [];
afterAll(() => cleanupOwners(owners));

async function importFixture(
  connectorId: ConnectorId,
  product: LongTermSavingsProduct,
  name: string,
) {
  const importer = LONG_TERM_SAVINGS_IMPORTERS[connectorId]!;
  const items = JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/long-term-savings", `${name}.json`), "utf8"),
  ) as Item[];

  const { userId, dataKey } = await createUser(
    `${randomUUID()}@test.moni`,
    Buffer.from("test password"),
    SIGNUP_TOKEN!,
  );
  owners.push(userId);
  const connectionId = randomUUID();
  const syncRunId = randomUUID();
  await withUser(userId, async (tx) => {
    await tx.insert(schema.connections).values({
      id: connectionId,
      ownerId: userId,
      connectorId,
      mode: "user_mediated_import",
      status: "active",
    });
    await tx.insert(schema.syncRuns).values({
      id: syncRunId,
      ownerId: userId,
      connectionId,
      status: "running",
    });
  });
  const result = await promoteLongTermSavingsSnapshot({
    userId,
    connectionId,
    syncRunId,
    dataKey,
    parserId: importer.parserId,
    parserVersion: importer.parserVersion,
    product,
    accountLabel: name,
    report: importer.read(items),
  });

  const [snapshot] = await withUser(userId, (tx) =>
    tx
      .select()
      .from(schema.longTermSavingsSnapshots)
      .where(eq(schema.longTermSavingsSnapshots.id, result.snapshotId)),
  );
  const [details] = await withUser(userId, (tx) =>
    tx
      .select()
      .from(schema.longTermSavingsDetails)
      .where(eq(schema.longTermSavingsDetails.accountId, result.accountId)),
  );
  const money = (ct: Uint8Array | null, column: string) =>
    ct === null ? null : decText(dataKey, ct, snapshot.id, column, snapshot.version);
  return { result, snapshot, details, money };
}

describe("promoteLongTermSavingsSnapshot — Migdal pension", () => {
  it("stores the transfer-in and actuarial lines, and the blank opening as ₪0", async () => {
    const { result, snapshot, details, money } = await importFixture(
      "migdal_pension_quarterly",
      "pension",
      "migdal-pension-2026-q2",
    );
    expect(result.balanceDrift).toBe("1");
    expect(result.depositRows).toBe(3);
    expect(result.trackRows).toBe(2);
    expect(details.liquidity).toBe("locked_retirement");
    expect(details.liquidFrom).toBeNull();

    expect(money(snapshot.closingBalanceCt, "closing_balance_ct")).toBe("136444");
    expect(money(snapshot.openingBalanceCt, "opening_balance_ct")).toBe("0");
    expect(money(snapshot.transfersInCt, "transfers_in_ct")).toBe("125911");
    expect(money(snapshot.actuarialAdjustmentCt, "actuarial_adjustment_ct")).toBe("-32");
    expect(money(snapshot.insuranceDeathCt, "insurance_death_ct")).toBe("0");
    expect(money(snapshot.depositsTotalCt, "deposits_total_ct")).toBe("4311");
    expect(snapshot.parserId).toBe("migdal_pension_quarterly");
  });
});

describe("promoteLongTermSavingsSnapshot — Analyst קרן השתלמות", () => {
  it("imports a report with no deposits, liquid from its printed date", async () => {
    const { result, snapshot, details, money } = await importFixture(
      "analyst_hishtalmut",
      "hishtalmut",
      "analyst-hishtalmut-2026-q2",
    );
    expect(result.balanceDrift).toBe("0");
    expect(result.depositRows).toBe(0);
    expect(details.liquidity).toBe("liquid_after");
    expect(details.liquidFrom).toBe("2028-05-29");

    expect(money(snapshot.closingBalanceCt, "closing_balance_ct")).toBe("74437");
    expect(snapshot.transfersInCt).toBeNull();
    expect(snapshot.actuarialAdjustmentCt).toBeNull();
    expect(snapshot.depositsTotalCt).toBeNull();
    expect(snapshot.feeRateSavings).toBe("0.6");
  });
});
