import { afterEach, describe, expect, it } from "vitest";
import { upsertBoiFxRate } from "@/domain/fx-rates";
import { elevatedPool } from "./helpers";

const date = "2099-01-01";

afterEach(async () => {
  await elevatedPool.query("delete from fx_rates where from_currency = 'ZZZ' and date = $1", [
    date,
  ]);
});

describe("upsertBoiFxRate", () => {
  it("uses the normal app connection to insert and correction-update a BOI rate", async () => {
    await upsertBoiFxRate({ fromCurrency: "ZZZ", date, rate: "1.2345" });
    await upsertBoiFxRate({ fromCurrency: "ZZZ", date, rate: "1.9876" });
    const { rows } = await elevatedPool.query<{ rate: string; source: string }>(
      "select rate, source from fx_rates where from_currency = 'ZZZ' and date = $1",
      [date],
    );
    expect(rows).toEqual([{ rate: "1.9876", source: "boi" }]);
  });
});
