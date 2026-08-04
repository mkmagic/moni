import { WorkerSourceError, readBoundedResponse, type FetchAdapter } from "./workers";

export const TIINGO_API_ORIGIN = "https://api.tiingo.com";
const TIINGO_DAILY_PATH = "/tiingo/daily/";

export interface TiingoEodQuote {
  price: string;
  sourceDate: string;
  splitState: "safe" | "post_split" | "unknown";
}

function jsonString(value: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(value);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function jsonDecimal(value: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))`).exec(value);
  return match?.[1] ?? null;
}

/** Parse only the exact lexical decimals needed from Tiingo's EOD JSON. */
export function parseTiingoEodQuote(body: Buffer): TiingoEodQuote {
  try {
    const text = body.toString("utf8");
    const price = jsonDecimal(text, "close");
    const sourceDate = jsonString(text, "date")?.slice(0, 10);
    const split = jsonDecimal(text, "splitFactor");
    if (!price || !sourceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate))
      throw new WorkerSourceError("provider_rejected");
    return {
      price,
      sourceDate,
      splitState: split === "1" || split === "1.0" ? "safe" : split ? "post_split" : "unknown",
    };
  } finally {
    body.fill(0);
  }
}

/** Tiingo token is sent exclusively as a binary-derived Authorization header. */
export async function fetchTiingoEodQuote(
  symbol: string,
  token: Buffer,
  fetcher: FetchAdapter,
): Promise<TiingoEodQuote> {
  try {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) throw new WorkerSourceError("provider_rejected");
    const url = new URL(
      `${TIINGO_DAILY_PATH}${encodeURIComponent(symbol)}/prices`,
      TIINGO_API_ORIGIN,
    );
    if (url.origin !== TIINGO_API_ORIGIN || !url.pathname.startsWith(TIINGO_DAILY_PATH))
      throw new WorkerSourceError("provider_rejected");
    const response = await fetcher(url.toString(), {
      redirect: "error",
      headers: { Authorization: `Token ${token.toString("utf8")}` },
    });
    if (response.redirected) throw new WorkerSourceError("redirect_rejected");
    if (!response.ok) throw new WorkerSourceError("provider_rejected");
    return parseTiingoEodQuote(await readBoundedResponse(response));
  } finally {
    token.fill(0);
  }
}
