import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as importOpeningLots } from "@/app/api/investments/activity/opening-lots/import/route";
import { POST as previewOpeningLots } from "@/app/api/investments/activity/opening-lots/preview/route";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { SESSION_COOKIE } from "@/domain/auth";
import { encText } from "@/domain/fields";
import { upsertBoiFxRate } from "@/domain/fx-rates";
import { previewOpeningLotImport, promoteOpeningLotImport } from "@/domain/investment-opening-lots";
import { decryptField, getDevUserDataKey } from "@/lib/crypto";
import { createSession, destroySession } from "@/lib/auth/session-store";
import { parseOpeningLotsCsv } from "@/lib/investments";
import { cleanupFxRates, cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const header =
  "account,isin,symbol,exchange,trade_date,quantity,remaining_quantity,unit_cost,total_cost,currency,fee,ils_fx_rate,broker_lot_id";

describe("opening-lot import", () => {
  let userId: string;
  let accountId: string;
  let fxRateId: string;
  let sessionId: string;
  const accountRef = "OPENING-ACCOUNT-135";

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `opening-lots-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    userId = user.id;
    const [connection] = await elevatedDb
      .insert(schema.connections)
      .values({
        ownerId: userId,
        connectorId: "ibkr_flex",
        credentialsCt: Buffer.from("test-only"),
        status: "active",
      })
      .returning({ id: schema.connections.id });
    accountId = randomUUID();
    const dataKey = getDevUserDataKey(userId);
    try {
      await elevatedDb.insert(schema.accounts).values({
        id: accountId,
        ownerId: userId,
        connectionId: connection.id,
        accountType: "investment",
        classification: "asset",
        nameCt: encText(dataKey, "Opening lots", accountId, "name_ct", 1),
        externalAccountRefCt: encText(dataKey, accountRef, accountId, "external_account_ref_ct", 1),
        currency: "USD",
        status: "active",
      });
    } finally {
      dataKey.fill(0);
    }
    sessionId = createSession(userId, Buffer.from(getDevUserDataKey(userId)), "ILS");
    await upsertBoiFxRate({
      fromCurrency: "XAA",
      date: "2026-09-11",
      rate: "3.14159000",
    });
    const [rate] = await elevatedDb
      .select({ id: schema.fxRates.id })
      .from(schema.fxRates)
      .where(eq(schema.fxRates.fromCurrency, "XAA"))
      .limit(1);
    fxRateId = rate.id;
  });

  afterAll(async () => {
    destroySession(sessionId);
    await cleanupOwners([userId]);
    await cleanupFxRates([fxRateId]);
    await elevatedPool.end();
  });

  function rows() {
    return parseOpeningLotsCsv(
      Buffer.from(
        `${header}\n` +
          `${accountRef},US0378331005,AAPL,NASDAQ,2020-01-02,2,,10,20,USD,0.5,3.45,USER-RATE\n` +
          `${accountRef},,DERIVED,XTAE,2026-09-12,4,3,,80,XAA,,,DERIVED-RATE\n` +
          `${accountRef},,OLD,XTAE,1900-01-01,1,,,5,XZZ,,,OLD-RATE\n`,
      ),
    );
  }

  async function withKey<T>(fn: (dataKey: Uint8Array) => Promise<T>): Promise<T> {
    const dataKey = getDevUserDataKey(userId);
    try {
      return await fn(dataKey);
    } finally {
      dataKey.fill(0);
    }
  }

  it("previews without writes, then atomically promotes all FX provenance states", async () => {
    const preview = await withKey((dataKey) =>
      previewOpeningLotImport({ userId, dataKey, rows: rows() }),
    );
    expect(preview).toMatchObject({ ready: 3, skipped: 0, unresolvedFx: 1 });
    expect(preview.rows.map((row) => [row.lockedFxRate, row.lockedFxProvenance])).toEqual([
      ["3.45", "user_entered"],
      ["3.14159", "boi_derived"],
      [null, "unresolved"],
    ]);
    await expect(
      withUser(userId, (tx) => tx.select().from(schema.investmentOpeningLotEvidence)),
    ).resolves.toHaveLength(0);

    await expect(
      withKey((dataKey) => promoteOpeningLotImport({ userId, dataKey, rows: rows() })),
    ).resolves.toEqual({ inserted: 3, skipped: 0, unresolvedFx: 1 });

    const stored = await withUser(userId, (tx) =>
      tx.select().from(schema.investmentOpeningLotEvidence),
    );
    expect(stored).toHaveLength(3);
    expect(stored.map((row) => row.lockedFxProvenance).sort()).toEqual([
      "boi_derived",
      "unresolved",
      "user_entered",
    ]);
    const userRate = stored.find((row) => row.lockedFxProvenance === "user_entered")!;
    expect(userRate.totalCostCt.equals(Buffer.from("20"))).toBe(false);
    await withKey(async (dataKey) => {
      expect(
        decryptField(dataKey, userRate.lockedFxRateCt!, {
          rowId: userRate.id,
          column: "locked_fx_rate_ct",
          version: 1,
        }).toString("utf8"),
      ).toBe("3.45");
    });
  });

  it("wires uploaded CSV bytes through parse, preview, and promotion", async () => {
    function upload(source: string): NextRequest {
      const form = new FormData();
      form.set("file", new File([source], "opening-lots.csv", { type: "text/csv" }));
      return new NextRequest("http://localhost/api/investments/activity/opening-lots/preview", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
        body: form,
      });
    }

    const invalid = await previewOpeningLots(
      upload(`${header}\n${accountRef},,MISSING-EXCHANGE,,2021-01-02,1,,,25,USD,,,ROUTE-BAD\n`),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ row: 2 });

    const preview = await previewOpeningLots(
      upload(`${header}\n${accountRef},,ROUTE,XTAE,2021-01-02,2,2,25,50,USD,,3.5,ROUTE-OK\n`),
    );
    expect(preview.status).toBe(200);
    const payload = (await preview.json()) as {
      preview: { ready: number };
      rows: unknown[];
    };
    expect(payload.preview.ready).toBe(1);
    expect(payload.rows).toHaveLength(1);

    const promoted = await importOpeningLots(
      new NextRequest("http://localhost/api/investments/activity/opening-lots/import", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionId}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ rows: payload.rows }),
      }),
    );
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toMatchObject({ inserted: 1, skipped: 0 });
  });

  it("reports the same file as skipped and creates no duplicate lots", async () => {
    await expect(
      withKey((dataKey) => previewOpeningLotImport({ userId, dataKey, rows: rows() })),
    ).resolves.toMatchObject({ ready: 0, skipped: 3 });
    await expect(
      withKey((dataKey) => promoteOpeningLotImport({ userId, dataKey, rows: rows() })),
    ).resolves.toEqual({ inserted: 0, skipped: 3, unresolvedFx: 0 });
  });

  it("skips FX for ILS lots and rejects a non-positive user override", async () => {
    const ilsRows = parseOpeningLotsCsv(
      Buffer.from(`${header}\n${accountRef},,ILSCO,XTAE,2020-02-02,3,,,90,ILS,,,ILS-LOT\n`),
    );
    const preview = await withKey((dataKey) =>
      previewOpeningLotImport({ userId, dataKey, rows: ilsRows }),
    );
    expect(preview.unresolvedFx).toBe(0);
    expect(preview.rows[0]).toMatchObject({
      lockedFxRate: "1",
      lockedFxConvention: null,
      lockedFxProvenance: "boi_derived",
    });

    const badRows = parseOpeningLotsCsv(
      Buffer.from(`${header}\n${accountRef},,BADFX,XTAE,2020-02-02,1,,,10,USD,,-3,BAD-LOT\n`),
    );
    await expect(
      withKey((dataKey) => previewOpeningLotImport({ userId, dataKey, rows: badRows })),
    ).rejects.toThrow("invalid_fx_override");
  });

  it("rolls back the whole promotion when a later account cannot be resolved", async () => {
    const before = await withUser(userId, (tx) =>
      tx.select().from(schema.investmentOpeningLotEvidence),
    );
    const candidate = rows()[0];
    await expect(
      withKey((dataKey) =>
        promoteOpeningLotImport({
          userId,
          dataKey,
          rows: [
            { ...candidate, brokerLotId: "ROLLBACK-FIRST" },
            { ...candidate, account: "UNKNOWN", brokerLotId: "ROLLBACK-SECOND" },
          ],
        }),
      ),
    ).rejects.toThrow("account_not_found");
    await expect(
      withUser(userId, (tx) => tx.select().from(schema.investmentOpeningLotEvidence)),
    ).resolves.toHaveLength(before.length);
  });
});
