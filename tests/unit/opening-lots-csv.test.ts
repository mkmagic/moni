import { describe, expect, it } from "vitest";

import {
  OPENING_LOT_AI_CONVERSION_PROMPT,
  OPENING_LOT_CSV_COLUMNS,
  parseOpeningLotsCsv,
} from "@/lib/investments";

const header = OPENING_LOT_CSV_COLUMNS.join(",");

describe("opening-lot CSV", () => {
  it("parses the locked columns, defaults remaining quantity, and derives total cost exactly", () => {
    const source = Buffer.from(
      `${header}\nU123,US0378331005,AAPL,NASDAQ,2020-01-02,2.5,,10.25,,USD,0.75,,LOT-1\n`,
    );

    expect(parseOpeningLotsCsv(source)).toEqual([
      {
        account: "U123",
        isin: "US0378331005",
        symbol: "AAPL",
        exchange: "NASDAQ",
        tradeDate: "2020-01-02",
        quantity: "2.5",
        remainingQuantity: "2.5",
        unitCost: "10.25",
        totalCost: "25.625",
        currency: "USD",
        fee: "0.75",
        ilsFxRate: undefined,
        brokerLotId: "LOT-1",
      },
    ]);
    expect(source.every((value) => value === 0)).toBe(true);
  });

  it("rejects a ticker without either ISIN or exchange", () => {
    expect(() =>
      parseOpeningLotsCsv(Buffer.from(`${header}\nU123,,AAPL,,2020-01-02,1,,,10,USD,,,\n`)),
    ).toThrow("invalid_row:2");
  });

  it("rejects non-positive quantities and remaining greater than original", () => {
    const row = (quantity: string, remaining: string) =>
      Buffer.from(
        `${header}\nU123,US0378331005,AAPL,NASDAQ,2020-01-02,${quantity},${remaining},,1000,USD,,,\n`,
      );
    expect(() => parseOpeningLotsCsv(row("10", "15"))).toThrow("invalid_row:2");
    expect(() => parseOpeningLotsCsv(row("0", ""))).toThrow("invalid_row:2");
    expect(() => parseOpeningLotsCsv(row("-5", ""))).toThrow("invalid_row:2");
  });

  it("requires the exact locked header", () => {
    expect(() =>
      parseOpeningLotsCsv(Buffer.from(`account,symbol,trade_date\nU123,AAPL,2020-01-02\n`)),
    ).toThrow("invalid_header");
  });

  it("exports a complete copy-paste conversion prompt", () => {
    expect(OPENING_LOT_AI_CONVERSION_PROMPT).toContain(header);
    expect(OPENING_LOT_AI_CONVERSION_PROMPT).toContain("YYYY-MM-DD");
    expect(OPENING_LOT_AI_CONVERSION_PROMPT).toContain(
      "Leave ils_fx_rate blank if your export has no ILS rate",
    );
    expect(OPENING_LOT_AI_CONVERSION_PROMPT).toContain(
      "At least one of isin or symbol+exchange is required",
    );
  });
});
