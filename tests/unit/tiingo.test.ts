import { describe, expect, it, vi } from "vitest";
import {
  TIINGO_API_ORIGIN,
  fetchTiingoEodQuote,
  parseTiingoEodQuote,
  refreshTiingoQuotes,
  runTiingoQuoteWorkerFrame,
} from "@/lib/investments";
import { tiingoWorkerConfiguration } from "@/domain/investment-valuation";
import { decodeBinaryChildFrame, encodeBinaryChildFrame } from "@/lib/connectors";

describe("Tiingo EOD adapter", () => {
  it("uses the fixed origin and Authorization-only token, then wipes it", async () => {
    const token = Buffer.from("tier-zero-token");
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('[{"date":"2026-08-01T00:00:00.000Z","close":123.4500,"splitFactor":1}]'),
      );
    await expect(fetchTiingoEodQuote("SPY", token, fetcher)).resolves.toEqual({
      price: "123.4500",
      sourceDate: "2026-08-01",
      splitState: "safe",
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).origin).toBe(TIINGO_API_ORIGIN);
    expect(new URL(url).pathname).toBe("/tiingo/daily/SPY/prices");
    expect(url).not.toContain("tier-zero-token");
    expect(init).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Token tier-zero-token" },
    });
    expect(token.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects redirects, rejects malformed symbols, and does not retain the response body", async () => {
    const redirected = vi.fn().mockResolvedValue(new Response("[]", { status: 302 }));
    await expect(fetchTiingoEodQuote("SPY", Buffer.from("token"), redirected)).rejects.toThrow(
      "provider_rejected",
    );
    const token = Buffer.from("token");
    await expect(fetchTiingoEodQuote("SPY/unsafe", token, vi.fn())).rejects.toThrow(
      "provider_rejected",
    );
    expect(token.every((byte) => byte === 0)).toBe(true);
    const body = Buffer.from('[{"date":"2026-08-01","close":1,"splitFactor":2}]');
    expect(parseTiingoEodQuote(body).splitState).toBe("post_split");
    expect(body.every((byte) => byte === 0)).toBe(true);
  });

  it("requires both instance token and explicit multi-user authorization", () => {
    expect(tiingoWorkerConfiguration({})).toBeNull();
    expect(tiingoWorkerConfiguration({ MONI_TIINGO_TOKEN: "token" })).toBeNull();
    const configured = tiingoWorkerConfiguration({
      MONI_TIINGO_TOKEN: "token",
      MONI_TIINGO_MULTI_USER_AUTHORIZED: "true",
    });
    expect(configured?.toString()).toBe("token");
    configured?.fill(0);
  });

  it("refreshes targets sequentially and isolates provider failures", async () => {
    const token = Buffer.from("tier-zero-token");
    const dataKey = Buffer.from("data-key");
    const order: string[] = [];
    const fetchedTokens: Buffer[] = [];
    const result = await refreshTiingoQuotes({
      dataKey,
      token,
      fetcher: vi.fn(),
      now: () => new Date("2026-08-01T00:00:00Z"),
      listTargets: async () => [
        { instrumentId: "first", mappingId: "mapping-first", symbol: "SPY" },
        { instrumentId: "second", mappingId: "mapping-second", symbol: "FAIL" },
        { instrumentId: "third", mappingId: "mapping-third", symbol: "QQQ" },
      ],
      fetchQuote: async (symbol, suppliedToken) => {
        order.push(`fetch:${symbol}`);
        fetchedTokens.push(suppliedToken);
        if (symbol === "FAIL") throw new Error("provider failed");
        return { price: "1.00", sourceDate: "2026-08-01", splitState: "safe" };
      },
      replaceQuote: async (_, target) => {
        order.push(`replace:${target.instrumentId}`);
      },
    });
    expect(result).toEqual({ attempted: 3, updated: 2 });
    expect(order).toEqual([
      "fetch:SPY",
      "replace:first",
      "fetch:FAIL",
      "fetch:QQQ",
      "replace:third",
    ]);
    expect(token.toString()).toBe("tier-zero-token");
    expect(dataKey.toString()).toBe("data-key");
    expect(fetchedTokens.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it("keeps the worker token in a raw frame segment, never metadata", () => {
    const token = Buffer.from("tier-zero-token");
    expect(() => encodeBinaryChildFrame({ token: "tier-zero-token" }, [])).toThrow(
      "sensitive metadata",
    );
    const frame = encodeBinaryChildFrame({ userId: "internal-user-id" }, [token]);
    const decoded = decodeBinaryChildFrame(frame);
    expect(decoded.metadata).toEqual({ userId: "internal-user-id" });
    expect(decoded.segments[0].toString()).toBe("tier-zero-token");
    decoded.segments[0].fill(0);
    token.fill(0);
    frame.fill(0);
    expect(decoded.segments[0].every((byte) => byte === 0)).toBe(true);
    expect(token.every((byte) => byte === 0)).toBe(true);
    expect(frame.every((byte) => byte === 0)).toBe(true);
  });

  it("passes only structural metadata and wipes the worker-owned frame segments", async () => {
    const dataKey = Buffer.from("data-key");
    const token = Buffer.from("tier-zero-token");
    const frame = encodeBinaryChildFrame({ userId: "internal-user-id" }, [dataKey, token]);
    let owned: { dataKey: Buffer; token: Buffer } | undefined;
    await runTiingoQuoteWorkerFrame(frame, async (input) => {
      expect(input.userId).toBe("internal-user-id");
      owned = input;
    });
    expect(owned?.dataKey.every((byte) => byte === 0)).toBe(true);
    expect(owned?.token.every((byte) => byte === 0)).toBe(true);
    expect(frame.every((byte) => byte === 0)).toBe(true);
    dataKey.fill(0);
    token.fill(0);
  });
});
