import { describe, expect, it, vi } from "vitest";
import {
  BOI_SDMX_URL,
  IBKR_FLEX_URL,
  completeSourceRefresh,
  fetchBoiRates,
  fetchIbkrFlexXml,
  parseBoiSdmxCsv,
  readBoundedResponse,
  refreshBoiWithFallback,
  requiredBoiPairs,
} from "@/lib/investments";
import {
  decodeBinaryChildFrame,
  encodeBinaryChildFrame,
  MAX_CHILD_SEGMENT_BYTES,
  readChildStdin,
} from "@/lib/connectors";

describe("investment worker seams", () => {
  it("permits an exactly-10MiB source segment plus bounded framing overhead", () => {
    const source = Buffer.alloc(MAX_CHILD_SEGMENT_BYTES, 1);
    const key = Buffer.alloc(32, 2);
    const frame = encodeBinaryChildFrame({ userId: "structural" }, [key, source]);
    expect(frame.length).toBeGreaterThan(MAX_CHILD_SEGMENT_BYTES);
    const decoded = decodeBinaryChildFrame(frame);
    expect(decoded.segments[1]).toHaveLength(MAX_CHILD_SEGMENT_BYTES);
    for (const segment of decoded.segments) segment.fill(0);
    frame.fill(0);
    source.fill(0);
    key.fill(0);
    expect(() => encodeBinaryChildFrame({}, [Buffer.alloc(MAX_CHILD_SEGMENT_BYTES + 1)])).toThrow(
      "segment too large",
    );
  });
  it("completes the IBKR SendRequest/GetStatement handshake and wipes credentials", async () => {
    const token = Buffer.from("token");
    const query = Buffer.from("query");
    const report = "<FlexQueryResponse/>";
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("ECONNRESET"))
      .mockResolvedValueOnce(
        new Response(
          "<FlexStatementResponse><Status>Success</Status><ReferenceCode>reference</ReferenceCode><Url>https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>",
        ),
      )
      .mockResolvedValueOnce(new Response(report));
    const body = await fetchIbkrFlexXml(token, query, fetcher);
    expect(body.toString("utf8")).toBe(report);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const sendUrl = new URL(fetcher.mock.calls[1][0]);
    expect(sendUrl.origin + sendUrl.pathname).toBe(`${IBKR_FLEX_URL}/SendRequest`);
    expect(sendUrl.searchParams.get("v")).toBe("3");
    const statementUrl = new URL(fetcher.mock.calls[2][0]);
    expect(statementUrl.origin + statementUrl.pathname).toBe(
      "https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement",
    );
    expect(statementUrl.searchParams.get("q")).toBe("reference");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { "User-Agent": "Moni/0.1" },
    });
    expect([...token, ...query]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    body.fill(0);
  });

  it("does not retry a redirect-policy TypeError", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("redirect mode is set to error"));
    await expect(
      fetchIbkrFlexXml(Buffer.from("token"), Buffer.from("query"), fetcher),
    ).rejects.toThrow("redirect mode");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("polls when IBKR reports statement generation in progress", async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          "<FlexStatementResponse><Status>Success</Status><ReferenceCode>reference</ReferenceCode><Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>",
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>",
        ),
      )
      .mockResolvedValueOnce(new Response("<FlexQueryResponse/>"));

    const body = await fetchIbkrFlexXml(Buffer.from("token"), Buffer.from("query"), fetcher, wait);

    expect(body.toString("utf8")).toBe("<FlexQueryResponse/>");
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(1_000);
    body.fill(0);
  });

  it("parses BOI text decimals with exponent and rejects stale observations", () => {
    const csv = Buffer.from(
      "BASE_CURRENCY,COUNTER_CURRENCY,TIME_PERIOD,OBS_VALUE,UNIT_MULT\nUSD,ILS,2026-07-30,34567,4\n",
    );
    expect(parseBoiSdmxCsv(csv, [{ currency: "USD", date: "2026-07-31" }])).toEqual([
      { currency: "USD", date: "2026-07-30", rate: "3.4567" },
    ]);
    expect([...csv]).toEqual(Array(csv.length).fill(0));
    expect(() =>
      parseBoiSdmxCsv(
        Buffer.from(
          "BASE_CURRENCY,COUNTER_CURRENCY,TIME_PERIOD,OBS_VALUE,UNIT_MULT\nUSD,ILS,2026-07-01,1,0\n",
        ),
        [{ currency: "USD", date: "2026-07-31" }],
      ),
    ).toThrow("missing_fx");
    expect(BOI_SDMX_URL).toBe(
      "https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/",
    );
  });

  it("bounds BOI requests to the required currencies and seven-day date window", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          "BASE_CURRENCY,COUNTER_CURRENCY,TIME_PERIOD,OBS_VALUE,UNIT_MULT\nUSD,ILS,2026-07-28,3058,3\n",
        ),
      );

    await expect(
      fetchBoiRates([{ currency: "USD", date: "2026-07-31" }], fetcher),
    ).resolves.toEqual([{ currency: "USD", date: "2026-07-28", rate: "3.058" }]);

    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.searchParams.get("c[DATA_TYPE]")).toBe("OF00");
    expect(url.searchParams.get("c[BASE_CURRENCY]")).toBe("USD");
    expect(url.searchParams.get("c[COUNTER_CURRENCY]")).toBe("ILS");
    expect(url.searchParams.get("startPeriod")).toBe("2026-07-24");
    expect(url.searchParams.get("endPeriod")).toBe("2026-07-31");
    expect(url.searchParams.get("format")).toBe("csv");
  });

  it("rejects declared and streamed oversized responses before retaining a body", async () => {
    await expect(
      readBoundedResponse(
        new Response("x", { headers: { "content-length": String(10 * 1024 * 1024 + 1) } }),
      ),
    ).rejects.toThrow("source_too_large");
    const first = new Uint8Array(10 * 1024 * 1024);
    const second = new Uint8Array([1]);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBoundedResponse(new Response(stream))).rejects.toThrow("source_too_large");
    expect(cancelled).toBe(true);
    expect(first.every((value) => value === 0)).toBe(true);
    expect(second.every((value) => value === 0)).toBe(true);
  });

  it("wipes stdin chunks after creating the caller-owned frame", async () => {
    const first = Buffer.from("key");
    const second = Buffer.from("payload");
    async function* input() {
      yield first;
      yield second;
    }
    const frame = await readChildStdin(input());
    expect(frame.toString()).toBe("keypayload");
    expect([...first, ...second]).toEqual(Array(first.length + second.length).fill(0));
    frame.fill(0);
  });

  it("waits for BOI cache completion before promotion", async () => {
    const order: string[] = [];
    await completeSourceRefresh({
      envelope: {
        source: "schwab_positions_csv",
        coverage: { kind: "bound_single_account", accountRefs: ["a"] },
        sourceAsOf: { value: "2026-07-31", precision: "date" },
        accounts: [
          {
            sourceAccountRef: "a",
            baseCurrency: "USD",
            positions: [],
            cash: [],
            brokerTotal: { amount: "0", currency: "USD", asOf: "2026-07-31" },
          },
        ],
      },
      cacheBoi: async () => {
        order.push("cache");
      },
      promote: async () => {
        order.push("promote");
      },
    });
    expect(order).toEqual(["cache", "promote"]);
  });

  it("attempts an authoritative BOI refresh even when a usable cached rate exists", async () => {
    const required = [{ currency: "USD", date: "2026-07-31" }];
    const refresh = vi.fn().mockResolvedValue(undefined);
    const missing = vi.fn().mockResolvedValue([]);

    await refreshBoiWithFallback(required, refresh, missing);

    expect(refresh).toHaveBeenCalledWith(required);
    expect(missing).not.toHaveBeenCalled();
  });

  it("uses a recent BOI cache only when the authoritative refresh fails", async () => {
    const required = [{ currency: "USD", date: "2026-07-31" }];
    const failure = new Error("boi_failed");

    await expect(
      refreshBoiWithFallback(
        required,
        vi.fn().mockRejectedValue(failure),
        vi.fn().mockResolvedValue([]),
      ),
    ).resolves.toBeUndefined();

    await expect(
      refreshBoiWithFallback(
        required,
        vi.fn().mockRejectedValue(failure),
        vi.fn().mockResolvedValue(required),
      ),
    ).rejects.toBe(failure);
  });

  it("derives distinct component currency/date pairs using Israel source dates", () => {
    const envelope = {
      source: "schwab_positions_csv" as const,
      coverage: { kind: "bound_single_account" as const, accountRefs: ["a"] },
      sourceAsOf: { value: "2026-08-01T22:30:00Z", precision: "timestamp" as const },
      accounts: [
        {
          sourceAccountRef: "a",
          baseCurrency: "USD",
          positions: [
            {
              sourceSecurityId: "x",
              sourceSecurityIdKind: "id",
              assetKind: "stock" as const,
              quantity: "1",
              quantityUnit: "shares",
              currency: "USD",
              sourceValue: "1",
              sourceValueCurrency: "EUR",
              sourceAsOf: "2026-07-30T22:30:00Z",
            },
          ],
          cash: [{ currency: "GBP", amount: "1" }],
          brokerTotal: { amount: "1", currency: "USD", asOf: "2026-07-31" },
        },
      ],
    };
    expect(requiredBoiPairs(envelope)).toEqual([
      { currency: "EUR", date: "2026-07-31" },
      { currency: "GBP", date: "2026-08-02" },
      { currency: "USD", date: "2026-07-31" },
    ]);
  });
});
