import { afterEach, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import { upsertBoiFxRate } from "@/domain/fx-rates";
import { lockAcquisitionFx } from "@/domain/investment-fx";
import { elevatedPool } from "./helpers";

const userId = "00000000-0000-4000-8000-000000000135";
const currencies = ["XAA", "XBB", "XCC"];

afterEach(async () => {
  await elevatedPool.query("delete from fx_rates where from_currency = any($1::text[])", [
    currencies,
  ]);
});

async function lock(input: Parameters<typeof lockAcquisitionFx>[1]) {
  return withUser(userId, (tx) => lockAcquisitionFx(tx, input));
}

describe("acquisition FX locking", () => {
  it("uses the preceding BoI observation for a weekend trade date", async () => {
    await upsertBoiFxRate({ fromCurrency: "XAA", date: "2026-09-11", rate: "3.14159000" });

    await expect(
      lock({
        tradeDate: "2026-09-12",
        settlementDate: "2026-09-14",
        fromCurrency: "XAA",
        toCurrency: "ILS",
      }),
    ).resolves.toEqual({
      rateString: "3.14159",
      convention: "ILS_PER_XAA",
      observationDate: "2026-09-11",
      provenance: "boi_derived",
    });
  });

  it("uses an exact-date observation and returns its exact decimal digits as a string", async () => {
    await upsertBoiFxRate({ fromCurrency: "XBB", date: "2026-09-12", rate: "0.123456789" });

    const result = await lock({
      tradeDate: "2026-09-12",
      fromCurrency: "XBB",
      toCurrency: "ILS",
    });

    expect(result).toEqual({
      rateString: "0.123456789",
      convention: "ILS_PER_XBB",
      observationDate: "2026-09-12",
      provenance: "boi_derived",
    });
    expect(typeof result.rateString).toBe("string");
  });

  it("returns unresolved without throwing when the latest observation is over seven days old", async () => {
    await upsertBoiFxRate({ fromCurrency: "XCC", date: "2026-09-04", rate: "2.75" });

    await expect(
      lock({ tradeDate: "2026-09-12", fromCurrency: "XCC", toCurrency: "ILS" }),
    ).resolves.toEqual({
      rateString: null,
      convention: "ILS_PER_XCC",
      observationDate: null,
      provenance: "unresolved",
    });
  });

  it("does not invert or invent a rate outside the BoI currency-to-ILS direction", async () => {
    await expect(
      lock({ tradeDate: "2026-09-12", fromCurrency: "ILS", toCurrency: "XAA" }),
    ).resolves.toEqual({
      rateString: null,
      convention: "XAA_PER_ILS",
      observationDate: null,
      provenance: "unresolved",
    });
  });
});
