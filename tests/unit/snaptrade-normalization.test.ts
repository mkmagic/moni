import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  InvestmentNormalizationError,
  normalizeSnaptradeHoldings,
  parseJsonPreservingNumbers,
  type SnaptradeAccountPayload,
} from "@/lib/investments";
import { signSnaptradeRequest } from "@/lib/investments/snaptrade";

const POSITIONS_JSON = readFileSync(
  join(process.cwd(), "tests/fixtures/investments/snaptrade-positions.json"),
  "utf8",
);

const ACCOUNT = {
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
};

function payload(overrides: Partial<SnaptradeAccountPayload> = {}): SnaptradeAccountPayload {
  return {
    account: ACCOUNT,
    balances: [{ currency: { code: "USD" }, cash: "252.18" }],
    positions: parseJsonPreservingNumbers(POSITIONS_JSON) as SnaptradeAccountPayload["positions"],
    ...overrides,
  } as SnaptradeAccountPayload;
}

describe("parseJsonPreservingNumbers", () => {
  it("keeps the provider's digits instead of routing money through a float", () => {
    // 518.4274 and 0.1+0.2-style values must survive byte-for-byte.
    const parsed = parseJsonPreservingNumbers(POSITIONS_JSON) as {
      results: Array<{ units: unknown; price: unknown }>;
    };
    expect(parsed.results[0].units).toBe("518.4274");
    expect(parsed.results[0].price).toBe("368.21");
  });

  it("does not rewrite numerals inside strings, and leaves null and booleans alone", () => {
    expect(
      parseJsonPreservingNumbers('{"a":"1.50","b":null,"c":true,"d":[1.5,-2],"e":"x:9"}'),
    ).toEqual({ a: "1.50", b: null, c: true, d: ["1.5", "-2"], e: "x:9" });
  });

  it("preserves precision a float would destroy", () => {
    const parsed = parseJsonPreservingNumbers('{"units":9007199254740993.0000001}') as {
      units: string;
    };
    expect(parsed.units).toBe("9007199254740993.0000001");
  });

  it("rejects malformed bodies as an unsupported shape", () => {
    expect(() => parseJsonPreservingNumbers("{oops")).toThrow(InvestmentNormalizationError);
  });
});

describe("signSnaptradeRequest", () => {
  // The byte-wise encoder must agree with the encodeURI(string) the SDK uses.
  const reference = (path: string, query: string, key: string) =>
    createHmac("sha256", encodeURI(key))
      .update(JSON.stringify({ content: null, path, query }))
      .digest("base64");

  it.each([
    "plain-consumer-key",
    "key+with/base64=chars",
    "key with spaces and %",
    "unicode-Ā-key",
    "quote'paren()key",
  ])("matches encodeURI-based signing for %s", (key) => {
    const path = "/accounts/abc/positions/all";
    const query = "clientId=moni&timestamp=1785588190";
    expect(signSnaptradeRequest(path, query, Buffer.from(key, "utf8"))).toBe(
      reference(path, query, key),
    );
  });

  it("leaves the caller's key intact — fetchSnaptradeHoldings owns wiping it", () => {
    const key = Buffer.from("secret-key", "utf8");
    signSnaptradeRequest("/accounts", "clientId=moni&timestamp=1", key);
    expect(key.toString("utf8")).toBe("secret-key");
  });
});

describe("normalizeSnaptradeHoldings", () => {
  it("maps a live Schwab-via-SnapTrade payload onto the envelope", () => {
    const envelope = normalizeSnaptradeHoldings([payload()]);
    expect(envelope.source).toBe("snaptrade");
    expect(envelope.coverage).toEqual({
      kind: "configured_query_accounts",
      accountRefs: [ACCOUNT.institution_account_id],
    });
    expect(envelope.sourceAsOf).toEqual({
      value: "2026-08-01T18:30:01.430350+00:00",
      precision: "timestamp",
    });
    expect(envelope.accounts).toHaveLength(1);
    const account = envelope.accounts[0];
    expect(account.baseCurrency).toBe("USD");
    expect(account.cash).toEqual([{ currency: "USD", amount: "252.18" }]);
    expect(account.brokerTotal).toEqual({
      amount: "191142.33",
      currency: "USD",
      asOf: "2026-08-01T18:30:01.430350+00:00",
    });
    expect(account.positions).toEqual([
      {
        sourceSecurityId: "BBG000HRBDF4",
        sourceSecurityIdKind: "snaptrade_figi",
        symbol: "VTI",
        name: "VANGUARD TOTAL STOCK MKT ETF",
        // ARCX (NYSE Arca) is translated so Tiingo eligibility can match it.
        exchange: "NYSE",
        assetKind: "etf",
        quantity: "518.4274",
        quantityUnit: "shares",
        currency: "USD",
        sourcePrice: "368.21",
        sourcePriceCurrency: "USD",
        sourceAsOf: "2026-08-01T18:44:24Z",
      },
    ]);
  });

  it("leaves sourceValue unset so promotion records quantity_times_price", () => {
    const [account] = normalizeSnaptradeHoldings([payload()]).accounts;
    expect(account.positions[0].sourceValue).toBeUndefined();
    expect(account.positions[0].sourceValueCurrency).toBeUndefined();
  });

  it("falls back to the SnapTrade account id when the institution ref is absent", () => {
    const envelope = normalizeSnaptradeHoldings([
      payload({ account: { ...ACCOUNT, institution_account_id: null } }),
    ]);
    expect(envelope.coverage.accountRefs).toEqual([ACCOUNT.id]);
  });

  it("refuses a snapshot whose holdings sync never completed", () => {
    expect(() =>
      normalizeSnaptradeHoldings([
        payload({
          account: {
            ...ACCOUNT,
            sync_status: {
              holdings: { ...ACCOUNT.sync_status.holdings, initial_sync_completed: false },
            },
          },
        }),
      ]),
    ).toThrow(new InvestmentNormalizationError("incomplete_snapshot"));
  });

  it("refuses an empty account list rather than promoting empty coverage", () => {
    expect(() => normalizeSnaptradeHoldings([])).toThrow(
      new InvestmentNormalizationError("incomplete_coverage"),
    );
  });

  it("rejects two rows claiming the same security", () => {
    const positions = parseJsonPreservingNumbers(POSITIONS_JSON) as {
      results: unknown[];
      data_freshness: unknown;
    };
    positions.results.push(positions.results[0]);
    expect(() =>
      normalizeSnaptradeHoldings([payload({ positions } as Partial<SnaptradeAccountPayload>)]),
    ).toThrow(new InvestmentNormalizationError("identity_conflict"));
  });

  it("rejects a non-decimal quantity", () => {
    const positions = parseJsonPreservingNumbers(POSITIONS_JSON) as {
      results: Array<{ units: string }>;
    };
    positions.results[0].units = "5e2";
    expect(() =>
      normalizeSnaptradeHoldings([payload({ positions } as Partial<SnaptradeAccountPayload>)]),
    ).toThrow(InvestmentNormalizationError);
  });
});

describe("exchange translation", () => {
  it("passes through a venue it does not recognize rather than guessing", () => {
    const positions = parseJsonPreservingNumbers(POSITIONS_JSON) as {
      results: Array<{ instrument: { exchange: string } }>;
    };
    positions.results[0].instrument.exchange = "XTAE";
    const envelope = normalizeSnaptradeHoldings([
      payload({ positions } as Partial<SnaptradeAccountPayload>),
    ]);
    expect(envelope.accounts[0].positions[0].exchange).toBe("XTAE");
  });
});
