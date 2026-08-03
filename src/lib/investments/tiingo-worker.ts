import type { TiingoQuoteTarget } from "@/domain/investment-valuation";
import { decodeBinaryChildFrame } from "@/lib/connectors";
import { logFetch, syncLog } from "@/lib/sync-log";
import type { FetchAdapter } from "./workers";
import type { TiingoEodQuote } from "./tiingo";

export interface TiingoQuoteRefreshDependencies {
  listTargets: (dataKey: Uint8Array) => Promise<TiingoQuoteTarget[]>;
  fetchQuote: (symbol: string, token: Buffer, fetcher: FetchAdapter) => Promise<TiingoEodQuote>;
  replaceQuote: (
    dataKey: Uint8Array,
    target: TiingoQuoteTarget & TiingoEodQuote & { fetchedAt: Date },
  ) => Promise<void>;
}

/** Decodes a structural user-id frame and clears every worker-owned buffer. */
export async function runTiingoQuoteWorkerFrame(
  frame: Buffer,
  run: (input: { userId: string; dataKey: Buffer; token: Buffer }) => Promise<void>,
): Promise<void> {
  let segments: Buffer[] = [];
  try {
    const decoded = decodeBinaryChildFrame(frame);
    segments = decoded.segments;
    if (typeof decoded.metadata.userId !== "string" || segments.length !== 2)
      throw new Error("invalid_frame");
    await run({ userId: decoded.metadata.userId, dataKey: segments[0], token: segments[1] });
  } finally {
    for (const segment of segments) segment.fill(0);
    frame.fill(0);
  }
}

/**
 * Best-effort, sequential quote refresh. Provider failures intentionally leave
 * the existing quote untouched so valuation can fall back per position.
 */
export async function refreshTiingoQuotes(
  input: {
    dataKey: Uint8Array;
    token: Buffer;
    fetcher: FetchAdapter;
    now?: () => Date;
  } & TiingoQuoteRefreshDependencies,
): Promise<{ attempted: number; updated: number }> {
  const targets = await input.listTargets(input.dataKey);
  syncLog("quotes.targets", {
    count: targets.length,
    symbols: targets.map((target) => target.symbol).join(","),
  });
  let updated = 0;
  for (const target of targets) {
    const token = Buffer.from(input.token);
    try {
      const quote = await logFetch("quotes.tiingo.fetch", { symbol: target.symbol }, () =>
        input.fetchQuote(target.symbol, token, input.fetcher),
      );
      await input.replaceQuote(input.dataKey, {
        ...target,
        ...quote,
        fetchedAt: (input.now ?? (() => new Date()))(),
      });
      syncLog("quotes.stored", {
        symbol: target.symbol,
        sourceDate: quote.sourceDate,
        splitState: quote.splitState,
      });
      updated += 1;
    } catch {
      // Individual provider failures are non-fatal and retain the last quote.
      // logFetch already reported which symbol failed and why.
    } finally {
      token.fill(0);
    }
  }
  return { attempted: targets.length, updated };
}
