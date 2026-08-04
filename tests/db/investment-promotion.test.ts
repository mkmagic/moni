import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { decText } from "@/domain/fields";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { createUser } from "@/domain/registration";
import { decryptField } from "@/lib/crypto";
import type { InvestmentSyncEnvelope } from "@/lib/investments";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");

const users: string[] = [];

async function fixture(source: "schwab_positions_csv" | "ibkr_flex" = "schwab_positions_csv") {
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
      connectorId: source,
      mode: source === "schwab_positions_csv" ? "user_mediated_import" : "credentialed_fetch",
      credentialsCt: source === "ibkr_flex" ? Buffer.from([1]) : null,
      status: "active",
    }),
  );
  await elevatedDb
    .insert(schema.fxRates)
    .values({
      id: randomUUID(),
      fromCurrency: "USD",
      toCurrency: "ILS",
      date: "2026-07-31",
      rate: "3.5",
      source: "boi",
    })
    .onConflictDoNothing();
  return { userId, dataKey, connectionId };
}

function ibkrEnvelope(
  accounts: InvestmentSyncEnvelope["accounts"],
  asOf = "2026-07-31T10:00:00Z",
): InvestmentSyncEnvelope {
  return {
    source: "ibkr_flex",
    coverage: {
      kind: "configured_query_accounts",
      accountRefs: accounts.map((account) => account.sourceAccountRef),
    },
    sourceAsOf: { value: asOf, precision: "timestamp" },
    accounts,
  };
}

function ibkrAccount(ref: string, value = "100"): InvestmentSyncEnvelope["accounts"][number] {
  return {
    sourceAccountRef: ref,
    baseCurrency: "USD",
    positions: [
      {
        sourceSecurityId: `conid-${ref}`,
        sourceSecurityIdKind: "conid",
        symbol: "SPY",
        name: "S&P",
        assetKind: "etf",
        quantity: "1",
        quantityUnit: "shares",
        currency: "USD",
        sourceValue: value,
        sourceValueCurrency: "USD",
      },
    ],
    cash: [{ currency: "USD", amount: "10" }],
    brokerTotal: {
      amount: value === "100" ? "110" : "210",
      currency: "USD",
      asOf: "2026-07-31T10:00:00Z",
    },
  };
}

function envelope(value = "100", asOf = "2026-07-31T10:00:00Z"): InvestmentSyncEnvelope {
  return {
    source: "schwab_positions_csv",
    coverage: { kind: "bound_single_account", accountRefs: ["****1234"] },
    sourceAsOf: { value: asOf, precision: "timestamp" },
    accounts: [
      {
        sourceAccountRef: "****1234",
        baseCurrency: "USD",
        positions: [
          {
            sourceSecurityId: "SPY",
            sourceSecurityIdKind: "schwab_symbol",
            symbol: "SPY",
            name: "S&P 500",
            assetKind: "etf",
            quantity: "1",
            quantityUnit: "shares",
            currency: "USD",
            sourceValue: value,
            sourceValueCurrency: "USD",
            sourceAsOf: asOf,
          },
        ],
        cash: [{ currency: "USD", amount: "10" }],
        brokerTotal: { amount: value === "100" ? "110" : "1009", currency: "USD", asOf },
      },
    ],
  };
}

async function running(userId: string, connectionId: string) {
  const id = randomUUID();
  await withUser(userId, (tx) =>
    tx.insert(schema.syncRuns).values({ id, ownerId: userId, connectionId, status: "running" }),
  );
  return id;
}

describe("promoteInvestmentSnapshot", () => {
  afterAll(async () => cleanupOwners(users));

  it("persists a real normalized Schwab-shaped complete snapshot and exact repeats are no-ops", async () => {
    const f = await fixture();
    const first = await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: envelope(),
    });
    expect(first).toEqual({ outcome: "promoted", accounts: 1, positions: 1, cashBalances: 1 });
    const repeat = await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: envelope(),
    });
    expect(repeat.outcome).toBe("unchanged");
    await withUser(f.userId, async (tx) => {
      expect((await tx.select().from(schema.investmentSnapshotDetails)).length).toBe(1);
      const position = (await tx.select().from(schema.investmentSnapshotPositions))[0];
      expect(position.sourceValueCt).not.toBeNull();
    });
  });

  it("rejects an older observation and records only the safe failure code", async () => {
    const f = await fixture();
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: envelope("100", "2026-07-31T10:00:00Z"),
    });
    const syncRunId = await running(f.userId, f.connectionId);
    await expect(
      promoteInvestmentSnapshot({
        ...f,
        syncRunId,
        envelope: envelope("999", "2026-07-31T09:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "stale_source" });
    await withUser(f.userId, async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.id, syncRunId));
      expect(run).toMatchObject({ status: "failed", error: "stale_source" });
    });
  });

  it("replaces children for newer and same-time corrections, including an accepted zero state", async () => {
    const f = await fixture();
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: envelope("100"),
    });
    const newer = envelope("200", "2026-07-31T11:00:00Z");
    newer.accounts[0].brokerTotal.amount = "210";
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: newer,
    });
    const correction = envelope("300", "2026-07-31T11:00:00Z");
    correction.accounts[0].brokerTotal.amount = "310";
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: correction,
    });
    const zero = envelope("0", "2026-07-31T12:00:00Z");
    zero.accounts[0].positions = [];
    zero.accounts[0].cash = [];
    zero.accounts[0].brokerTotal.amount = "0";
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: zero,
    });
    await withUser(f.userId, async (tx) => {
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(
        decText(f.dataKey, detail.brokerTotalCt, detail.id, "broker_total_ct", detail.version),
      ).toBe("0");
      expect(await tx.select().from(schema.investmentSnapshotPositions)).toHaveLength(0);
      expect(await tx.select().from(schema.investmentSnapshotCashBalances)).toHaveLength(0);
    });
  });

  it("promotes IBKR coverage atomically and leaves prior accepted data unchanged after a failed replacement", async () => {
    const f = await fixture("ibkr_flex");
    const accepted = ibkrEnvelope([ibkrAccount("U1"), ibkrAccount("U2")]);
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: accepted,
    });
    const failed = ibkrEnvelope(
      [
        ibkrAccount("U1", "200"),
        {
          ...ibkrAccount("U2"),
          positions: [
            { ...ibkrAccount("U2").positions[0], sourceValue: undefined, sourcePrice: undefined },
          ],
        },
      ],
      "2026-07-31T11:00:00Z",
    );
    const syncRunId = await running(f.userId, f.connectionId);
    await expect(
      promoteInvestmentSnapshot({ ...f, syncRunId, envelope: failed }),
    ).rejects.toMatchObject({ code: "unvalued_position" });
    await withUser(f.userId, async (tx) => {
      expect(await tx.select().from(schema.investmentSnapshotDetails)).toHaveLength(2);
      const [connection] = await tx
        .select()
        .from(schema.connections)
        .where(eq(schema.connections.id, f.connectionId));
      const [run] = await tx
        .select()
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.id, syncRunId));
      expect(connection.status).toBe("active");
      expect(run.error).toBe("unvalued_position");
    });
  });

  it("uses broker source value before price, otherwise exact quantity times price, cash and BOI conversion", async () => {
    const f = await fixture();
    const source = envelope("100");
    source.accounts[0].positions = [
      {
        ...source.accounts[0].positions[0],
        sourceValue: "7.25",
        sourcePrice: "999",
        sourcePriceCurrency: "USD",
      },
      {
        ...source.accounts[0].positions[0],
        sourceSecurityId: "QQQ",
        symbol: "QQQ",
        quantity: "2.5",
        sourceValue: undefined,
        sourceValueCurrency: undefined,
        sourcePrice: "4.2",
        sourcePriceCurrency: "USD",
      },
    ];
    source.accounts[0].cash = [{ currency: "USD", amount: "-1.5" }];
    source.accounts[0].brokerTotal.amount = "17.25";
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: source,
    });
    await withUser(f.userId, async (tx) => {
      const rows = await tx.select().from(schema.investmentSnapshotPositions);
      const values = rows.map((row) =>
        decText(f.dataKey, row.sourceValueCt, row.id, "source_value_ct", row.version),
      );
      const prices = rows.map((row) =>
        decText(f.dataKey, row.sourcePriceCt, row.id, "source_price_ct", row.version),
      );
      expect(values).toContain("7.25");
      expect(prices).toContain("4.2");
      const [cash] = await tx.select().from(schema.investmentSnapshotCashBalances);
      expect(decText(f.dataKey, cash.amountCt, cash.id, "amount_ct", cash.version)).toBe("-1.5");
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(detail.reconciliationState).toBe("mismatch");
    });
  });

  it("enforces RLS ownership and AAD-bound ciphertext", async () => {
    const owner = await fixture();
    const other = await fixture();
    const syncRunId = await running(owner.userId, owner.connectionId);
    await expect(
      promoteInvestmentSnapshot({
        userId: other.userId,
        dataKey: other.dataKey,
        connectionId: owner.connectionId,
        syncRunId,
        envelope: envelope(),
      }),
    ).rejects.toMatchObject({ code: "invalid_sync" });
    await promoteInvestmentSnapshot({
      ...owner,
      syncRunId: await running(owner.userId, owner.connectionId),
      envelope: envelope(),
    });
    await withUser(owner.userId, async (tx) => {
      const [account] = await tx.select().from(schema.accounts);
      expect(
        decText(
          owner.dataKey,
          account.externalAccountRefCt,
          account.id,
          "external_account_ref_ct",
          account.version,
        ),
      ).toBe("****1234");
      expect(() =>
        decryptField(other.dataKey, account.externalAccountRefCt!, {
          rowId: account.id,
          column: "external_account_ref_ct",
          version: account.version,
        }),
      ).toThrow();
      expect(() =>
        decryptField(owner.dataKey, account.externalAccountRefCt!, {
          rowId: randomUUID(),
          column: "external_account_ref_ct",
          version: account.version,
        }),
      ).toThrow();
      expect(() =>
        decryptField(owner.dataKey, account.externalAccountRefCt!, {
          rowId: account.id,
          column: "name_ct",
          version: account.version,
        }),
      ).toThrow();
      expect(() =>
        decryptField(owner.dataKey, account.externalAccountRefCt!, {
          rowId: account.id,
          column: "external_account_ref_ct",
          version: account.version + 1,
        }),
      ).toThrow();
    });
  });

  it("never lets a Schwab symbol merge with another provider's mapping", async () => {
    const f = await fixture("ibkr_flex");
    const ibkr = ibkrAccount("U1");
    ibkr.positions[0].sourceSecurityId = "SPY";
    ibkr.positions[0].sourceSecurityIdKind = "schwab_symbol";
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: ibkrEnvelope([ibkr]),
    });
    const schwabConnection = randomUUID();
    await withUser(f.userId, (tx) =>
      tx.insert(schema.connections).values({
        id: schwabConnection,
        ownerId: f.userId,
        connectorId: "schwab_positions_csv",
        mode: "user_mediated_import",
        status: "active",
      }),
    );
    await promoteInvestmentSnapshot({
      userId: f.userId,
      dataKey: f.dataKey,
      connectionId: schwabConnection,
      syncRunId: await running(f.userId, schwabConnection),
      envelope: envelope(),
    });
    await withUser(f.userId, async (tx) => {
      expect(await tx.select().from(schema.instruments)).toHaveLength(2);
      expect(await tx.select().from(schema.instrumentSourceMappings)).toHaveLength(2);
    });
  });

  it("reuses a compatible durable identifier across providers and rolls back an incompatible correction", async () => {
    const f = await fixture("ibkr_flex");
    const ibkr = ibkrAccount("U1");
    ibkr.positions[0].sourceSecurityId = "US78462F1030";
    ibkr.positions[0].sourceSecurityIdKind = "isin";
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: ibkrEnvelope([ibkr]),
    });
    const schwabConnection = randomUUID();
    await withUser(f.userId, (tx) =>
      tx.insert(schema.connections).values({
        id: schwabConnection,
        ownerId: f.userId,
        connectorId: "schwab_positions_csv",
        mode: "user_mediated_import",
        status: "active",
      }),
    );
    const durable = envelope();
    durable.accounts[0].positions[0].sourceSecurityId = "US78462F1030";
    durable.accounts[0].positions[0].sourceSecurityIdKind = "isin";
    await promoteInvestmentSnapshot({
      userId: f.userId,
      dataKey: f.dataKey,
      connectionId: schwabConnection,
      syncRunId: await running(f.userId, schwabConnection),
      envelope: durable,
    });
    await withUser(f.userId, async (tx) => {
      expect(await tx.select().from(schema.instruments)).toHaveLength(1);
      expect(await tx.select().from(schema.instrumentSourceMappings)).toHaveLength(2);
    });
    const incompatible = structuredClone(durable);
    incompatible.sourceAsOf.value = "2026-07-31T11:00:00Z";
    incompatible.accounts[0].positions[0].assetKind = "stock";
    incompatible.accounts[0].positions[0].sourceAsOf = incompatible.sourceAsOf.value;
    incompatible.accounts[0].brokerTotal.asOf = incompatible.sourceAsOf.value;
    await expect(
      promoteInvestmentSnapshot({
        userId: f.userId,
        dataKey: f.dataKey,
        connectionId: schwabConnection,
        syncRunId: await running(f.userId, schwabConnection),
        envelope: incompatible,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await withUser(f.userId, async (tx) => {
      expect(await tx.select().from(schema.instruments)).toHaveLength(1);
      expect(await tx.select().from(schema.investmentSnapshotDetails)).toHaveLength(2);
    });
  });

  it("uses the Israeli calendar for timestamp snapshots while date precision remains literal", async () => {
    const f = await fixture();
    const boundary = envelope("100", "2026-08-01T22:30:00Z");
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: boundary,
    });
    await withUser(f.userId, async (tx) => {
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      const [parent] = await tx.select().from(schema.accountBalanceSnapshots);
      expect(detail.weekStart).toBe("2026-08-02");
      expect(parent.date).toBe("2026-08-02");
    });
  });

  it("rolls back financial writes when the guarded terminal success transition is lost", async () => {
    const f = await fixture();
    const syncRunId = await running(f.userId, f.connectionId);
    const functionName = `block_investment_success_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `block_investment_success_trigger_${randomUUID().replaceAll("-", "")}`;
    await elevatedPool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id::text = TG_ARGV[0] AND NEW.status = 'succeeded' THEN RETURN NULL; END IF; RETURN NEW; END; $$`,
    );
    await elevatedPool.query(
      `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON sync_runs FOR EACH ROW EXECUTE FUNCTION ${functionName}('${syncRunId}')`,
    );
    try {
      await expect(
        promoteInvestmentSnapshot({ ...f, syncRunId, envelope: envelope() }),
      ).rejects.toMatchObject({ code: "invalid_sync" });
      await withUser(f.userId, async (tx) => {
        expect(await tx.select().from(schema.accounts)).toHaveLength(0);
        expect(await tx.select().from(schema.investmentSnapshotDetails)).toHaveLength(0);
        expect(await tx.select().from(schema.instruments)).toHaveLength(0);
        const [run] = await tx
          .select()
          .from(schema.syncRuns)
          .where(eq(schema.syncRuns.id, syncRunId));
        expect(run).toMatchObject({ status: "failed", error: "invalid_sync" });
      });
    } finally {
      await elevatedPool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON sync_runs`);
      await elevatedPool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it("rejects missing or stale local BOI FX and durable-identifier kind conflicts without changing accepted state", async () => {
    const f = await fixture();
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: await running(f.userId, f.connectionId),
      envelope: envelope(),
    });
    const conflict = envelope("100", "2026-07-31T11:00:00Z");
    conflict.accounts[0].positions[0].assetKind = "stock";
    const conflictRun = await running(f.userId, f.connectionId);
    await expect(
      promoteInvestmentSnapshot({ ...f, syncRunId: conflictRun, envelope: conflict }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    const fxFixture = await fixture();
    const eur = envelope("100", "2026-07-31T12:00:00Z");
    eur.accounts[0].baseCurrency = "EUR";
    eur.accounts[0].positions[0].currency = "EUR";
    eur.accounts[0].positions[0].sourceValueCurrency = "EUR";
    eur.accounts[0].cash[0].currency = "EUR";
    eur.accounts[0].brokerTotal.currency = "EUR";
    const missingRun = await running(fxFixture.userId, fxFixture.connectionId);
    await expect(
      promoteInvestmentSnapshot({ ...fxFixture, syncRunId: missingRun, envelope: eur }),
    ).rejects.toMatchObject({ code: "missing_fx" });
    await elevatedDb
      .insert(schema.fxRates)
      .values({
        id: randomUUID(),
        fromCurrency: "EUR",
        toCurrency: "ILS",
        date: "2026-07-20",
        rate: "4",
        source: "boi",
      })
      .onConflictDoNothing();
    const staleRun = await running(fxFixture.userId, fxFixture.connectionId);
    await expect(
      promoteInvestmentSnapshot({ ...fxFixture, syncRunId: staleRun, envelope: eur }),
    ).rejects.toMatchObject({ code: "missing_fx" });
    await withUser(fxFixture.userId, async (tx) => {
      expect(await tx.select().from(schema.investmentSnapshotDetails)).toHaveLength(0);
      const [run] = await tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, staleRun));
      expect(run.error).toBe("missing_fx");
    });
  });

  it("accepts a BOI observation exactly seven calendar days before a timestamped snapshot", async () => {
    const f = await fixture();
    const boundary = envelope("100", "2026-07-31T23:59:00Z");
    boundary.accounts[0].baseCurrency = "JPY";
    boundary.accounts[0].positions[0].currency = "JPY";
    boundary.accounts[0].positions[0].sourceValueCurrency = "JPY";
    boundary.accounts[0].cash[0].currency = "JPY";
    boundary.accounts[0].brokerTotal.currency = "JPY";
    await elevatedDb
      .insert(schema.fxRates)
      .values({
        id: randomUUID(),
        fromCurrency: "JPY",
        // 23:59Z on 07-31 is already 08-01 in Jerusalem, and the window is
        // counted in Israeli calendar days (investment-valuation.ts's
        // withinSevenDays), so 07-25 — not 07-24 — is the seventh day back.
        toCurrency: "ILS",
        date: "2026-07-25",
        rate: "0.02",
        source: "boi",
      })
      .onConflictDoNothing();

    await expect(
      promoteInvestmentSnapshot({
        ...f,
        syncRunId: await running(f.userId, f.connectionId),
        envelope: boundary,
      }),
    ).resolves.toMatchObject({ outcome: "promoted" });
  });
});
