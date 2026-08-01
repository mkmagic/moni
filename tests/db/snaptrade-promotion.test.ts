import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { listTiingoQuoteTargetsForUser } from "@/domain/investment-valuation";
import { createUser } from "@/domain/registration";
import {
  normalizeSnaptradeHoldings,
  parseJsonPreservingNumbers,
  type InvestmentSyncEnvelope,
  type SnaptradeAccountPayload,
} from "@/lib/investments";
import { cleanupOwners, elevatedDb } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");

const users: string[] = [];

async function fixture() {
  const { userId, dataKey } = await createUser(
    `${randomUUID()}@test.moni`,
    Buffer.from("test password"),
    SIGNUP_TOKEN!,
  );
  users.push(userId);
  const connectionId = randomUUID();
  await withUser(userId, (tx) =>
    tx.insert(schema.connections).values({
      id: connectionId,
      ownerId: userId,
      connectorId: "snaptrade",
      mode: "credentialed_fetch",
      credentialsCt: Buffer.from([1]),
      status: "active",
    }),
  );
  await elevatedDb
    .insert(schema.fxRates)
    .values({
      id: randomUUID(),
      fromCurrency: "USD",
      toCurrency: "ILS",
      date: "2026-08-01",
      rate: "3.5",
      source: "boi",
    })
    .onConflictDoNothing();
  const syncRunId = randomUUID();
  await withUser(userId, (tx) =>
    tx
      .insert(schema.syncRuns)
      .values({ id: syncRunId, ownerId: userId, connectionId, status: "running" }),
  );
  return { userId, dataKey, connectionId, syncRunId };
}

/** The exact payload a live Schwab-via-SnapTrade account returned. */
function snaptradeEnvelope(): InvestmentSyncEnvelope {
  const positions = parseJsonPreservingNumbers(
    readFileSync(
      join(process.cwd(), "tests/fixtures/investments/snaptrade-positions.json"),
      "utf8",
    ),
  ) as SnaptradeAccountPayload["positions"];
  return normalizeSnaptradeHoldings([
    {
      account: {
        id: "c925331b-52b8-47ff-95f0-aefacc4236a8",
        institution_account_id: "EB5AE622BC903C53DD86B729D2C920AB0089806D7849F5414B170F6FB372EE23",
        institution_name: "Schwab",
        sync_status: {
          holdings: {
            last_successful_sync: "2026-08-01T18:30:01.430350+00:00",
            initial_sync_completed: true,
          },
        },
        balance: { total: { amount: "191142.33", currency: "USD" } },
      },
      balances: [{ currency: { code: "USD" }, cash: "252.18" }],
      positions,
    },
  ]);
}

// Guards the whole SnapTrade write path against the schema, not just the
// normalizer. sync_runs.investment_source is a `text` column with its own
// CHECK constraint (drizzle/0019) rather than the investment_source enum, so a
// new source that passes every unit test can still fail at the final status
// update — which is exactly what happened, reported only as a generic failure.
describe("snaptrade promotion", () => {
  afterAll(async () => cleanupOwners(users));

  it("promotes a real snaptrade envelope and records the source on the run", async () => {
    const f = await fixture();
    const result = await promoteInvestmentSnapshot({ ...f, envelope: snaptradeEnvelope() });
    expect(result).toEqual({ outcome: "promoted", accounts: 1, positions: 1, cashBalances: 1 });
    await withUser(f.userId, async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.id, f.syncRunId));
      expect(run.status).toBe("succeeded");
      expect(run.investmentSource).toBe("snaptrade");
      const [position] = await tx.select().from(schema.investmentSnapshotPositions);
      // SnapTrade carries no market value, so promotion derives quantity x price.
      expect(position.brokerValuationBasis).toBe("quantity_times_price");
      // 518.4274 x 368.21 + 252.18 lands 0.002954 USD above the broker's own
      // 191142.33 total. That is the price's rounding, not a missing holding,
      // so it must not read as a mismatch.
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(detail.reconciliationState).toBe("matched");
    });
  });

  it("still reports a mismatch when a holding is genuinely missing", async () => {
    // The slack only covers what the reported price's rounding can hide
    // (quantity x half a cent, about 9 ILS here). A whole absent position is
    // orders of magnitude outside it.
    const f = await fixture();
    const envelope = snaptradeEnvelope();
    envelope.accounts[0].brokerTotal.amount = "241142.33";
    await promoteInvestmentSnapshot({ ...f, envelope });
    await withUser(f.userId, async (tx) => {
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(detail.reconciliationState).toBe("mismatch");
    });
  });
});

describe("snaptrade instrument metadata", () => {
  afterAll(async () => cleanupOwners(users));

  it("refreshes a mapping's exchange when the provider reports a new one", async () => {
    // The first sync stored the raw MIC. Once the normalizer translates it,
    // valuation must see the translated venue — the mapping is the only place
    // listTiingoQuoteTargets reads it from, so a stale one silently keeps the
    // position ineligible for a quote forever.
    const f = await fixture();
    const stale = snaptradeEnvelope();
    stale.accounts[0].positions[0].exchange = "ARCX";
    await promoteInvestmentSnapshot({ ...f, envelope: stale });
    expect(await listTiingoQuoteTargetsForUser(f.userId, f.dataKey)).toEqual([]);

    const fresh = snaptradeEnvelope();
    fresh.sourceAsOf = { value: "2026-08-02T18:30:01.430350+00:00", precision: "timestamp" };
    fresh.accounts[0].brokerTotal.asOf = "2026-08-02T18:30:01.430350+00:00";
    const syncRunId = randomUUID();
    await withUser(f.userId, (tx) =>
      tx.insert(schema.syncRuns).values({
        id: syncRunId,
        ownerId: f.userId,
        connectionId: f.connectionId,
        status: "running",
      }),
    );
    await promoteInvestmentSnapshot({ ...f, syncRunId, envelope: fresh });
    const targets = await listTiingoQuoteTargetsForUser(f.userId, f.dataKey);
    expect(targets.map((target) => target.symbol)).toEqual(["VTI"]);
  });
});
