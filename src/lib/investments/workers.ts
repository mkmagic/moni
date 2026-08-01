import Decimal from "decimal.js";
import { parse } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import { normalizeIbkrFlexXml, normalizeSchwabPositionsCsv, type InvestmentSyncEnvelope } from ".";

export const IBKR_FLEX_URL =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
export const BOI_SDMX_URL =
  "https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/";
const MAX = 10 * 1024 * 1024;

export type FetchAdapter = (input: string, init?: RequestInit) => Promise<Response>;
type SleepAdapter = (milliseconds: number) => Promise<void>;
export class WorkerSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const sleep: SleepAdapter = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchIbkrResponse(url: URL, fetcher: FetchAdapter): Promise<Buffer> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetcher(url.toString(), {
        redirect: "error",
        headers: { "User-Agent": "Moni/0.1" },
      });
      if (response.redirected) throw new WorkerSourceError("redirect_rejected");
      if (!response.ok) throw new WorkerSourceError("provider_rejected");
      return await readBoundedResponse(response);
    } catch (error) {
      last = error;
      if (error instanceof WorkerSourceError || !transient(error) || attempt === 2) throw error;
    }
  }
  throw last;
}

interface IbkrStatus {
  status?: string;
  referenceCode?: string;
  url?: string;
  errorCode?: string;
}

function ibkrStatus(xml: Buffer): IbkrStatus | null {
  const parser = new XMLParser({ parseTagValue: false, trimValues: true });
  const parsed = parser.parse(xml.toString("utf8")) as {
    FlexStatementResponse?: {
      Status?: unknown;
      ReferenceCode?: unknown;
      Url?: unknown;
      url?: unknown;
      ErrorCode?: unknown;
    };
  };
  const response = parsed.FlexStatementResponse;
  if (!response || typeof response !== "object") return null;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value.trim() : undefined;
  return {
    status: text(response.Status),
    referenceCode: text(response.ReferenceCode),
    url: text(response.Url) ?? text(response.url),
    errorCode: text(response.ErrorCode),
  };
}

function trustedIbkrStatementUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["ndcdyn.interactivebrokers.com", "gdcdyn.interactivebrokers.com"].includes(url.hostname) ||
    url.pathname !== "/AccountManagement/FlexWebService/GetStatement"
  )
    throw new WorkerSourceError("provider_rejected");
  url.search = "";
  return url;
}

function transient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause as { code?: unknown } | undefined;
  return (
    /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/.test(error.message) ||
    (typeof cause?.code === "string" && /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)$/.test(cause.code))
  );
}

/** Reads an external response without allowing an unbounded body allocation. */
export async function readBoundedResponse(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const declared = response.headers.get("content-length");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (declared && /^\d+$/.test(declared) && Number(declared) > MAX)
      throw new WorkerSourceError("source_too_large");
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      total += chunk.length;
      if (total > MAX) {
        chunk.fill(0);
        throw new WorkerSourceError("source_too_large");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

/** Fetches exactly the specified Flex endpoint. Query contents are deliberately never logged. */
export async function fetchIbkrFlexXml(
  token: Buffer,
  queryId: Buffer,
  fetcher: FetchAdapter,
  wait: SleepAdapter = sleep,
): Promise<Buffer> {
  try {
    const sendUrl = new URL(`${IBKR_FLEX_URL}/SendRequest`);
    sendUrl.searchParams.set("t", token.toString("utf8"));
    sendUrl.searchParams.set("q", queryId.toString("utf8"));
    sendUrl.searchParams.set("v", "3");
    const sendBody = await fetchIbkrResponse(sendUrl, fetcher);
    let status: IbkrStatus | null;
    try {
      status = ibkrStatus(sendBody);
    } finally {
      sendBody.fill(0);
    }
    if (status?.status !== "Success" || !status.referenceCode || !status.url)
      throw new WorkerSourceError("provider_rejected");
    const statementUrl = trustedIbkrStatementUrl(status.url);
    statementUrl.searchParams.set("t", token.toString("utf8"));
    statementUrl.searchParams.set("q", status.referenceCode);
    statementUrl.searchParams.set("v", "3");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const body = await fetchIbkrResponse(statementUrl, fetcher);
      const statementStatus = ibkrStatus(body);
      if (!statementStatus) return body;
      body.fill(0);
      if (statementStatus.errorCode !== "1019" || attempt === 9)
        throw new WorkerSourceError("provider_rejected");
      await wait(1_000);
    }
    throw new WorkerSourceError("provider_rejected");
  } finally {
    token.fill(0);
    queryId.fill(0);
  }
}

export function importSchwabCsv(csv: Buffer, valuationCurrency: string): InvestmentSyncEnvelope {
  try {
    if (csv.length > MAX) throw new WorkerSourceError("source_too_large");
    return normalizeSchwabPositionsCsv(csv.toString("utf8"), valuationCurrency);
  } finally {
    csv.fill(0);
  }
}

type BoiRow = Record<string, string>;
function dateDaysBefore(target: string, date: string): number {
  return Math.floor(
    (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000,
  );
}

/** Selects public BOI observations without ever using numeric JS arithmetic. */
export function parseBoiSdmxCsv(
  csv: Buffer,
  required: Array<{ currency: string; date: string }>,
): Array<{ currency: string; date: string; rate: string }> {
  try {
    if (csv.length > MAX) throw new WorkerSourceError("source_too_large");
    const rows = parse(csv, { columns: true, skip_empty_lines: true, cast: false }) as BoiRow[];
    return required.map(({ currency, date }) => {
      if (currency === "ILS") return { currency, date, rate: "1" };
      const candidates = rows.filter(
        (row) =>
          (row.BASE_CURRENCY === currency || row.CURRENCY === currency) &&
          row.COUNTER_CURRENCY === "ILS" &&
          row.TIME_PERIOD <= date,
      );
      candidates.sort((a, b) => b.TIME_PERIOD.localeCompare(a.TIME_PERIOD));
      const row = candidates[0];
      if (!row || dateDaysBefore(date, row.TIME_PERIOD) > 7)
        throw new WorkerSourceError("missing_fx");
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(row.OBS_VALUE) || !/^[+-]?\d+$/.test(row.UNIT_MULT))
        throw new WorkerSourceError("invalid_fx");
      return {
        currency,
        date: row.TIME_PERIOD,
        rate: new Decimal(row.OBS_VALUE).div(new Decimal(10).pow(row.UNIT_MULT)).toString(),
      };
    });
  } finally {
    csv.fill(0);
  }
}

export async function fetchBoiRates(
  required: Array<{ currency: string; date: string }>,
  fetcher: FetchAdapter,
): Promise<Array<{ currency: string; date: string; rate: string }>> {
  const foreign = required.filter(({ currency }) => currency !== "ILS");
  if (foreign.length === 0)
    return required.map(({ currency, date }) => ({ currency, date, rate: "1" }));
  const dates = foreign.map(({ date }) => date).sort();
  const start = new Date(`${dates[0]}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 7);
  const url = new URL(BOI_SDMX_URL);
  url.searchParams.set("c[DATA_TYPE]", "OF00");
  url.searchParams.set(
    "c[BASE_CURRENCY]",
    [...new Set(foreign.map(({ currency }) => currency))].sort().join(","),
  );
  url.searchParams.set("c[COUNTER_CURRENCY]", "ILS");
  url.searchParams.set("startPeriod", start.toISOString().slice(0, 10));
  url.searchParams.set("endPeriod", dates.at(-1)!);
  url.searchParams.set("format", "csv");
  const response = await fetcher(url.toString(), { redirect: "error" });
  if (response.redirected) throw new WorkerSourceError("redirect_rejected");
  if (!response.ok) throw new WorkerSourceError("provider_rejected");
  const csv = await readBoundedResponse(response);
  return parseBoiSdmxCsv(csv, required);
}

export function normalizeIbkrPayload(xml: Buffer): InvestmentSyncEnvelope {
  try {
    if (xml.length > MAX) throw new WorkerSourceError("source_too_large");
    return normalizeIbkrFlexXml(xml.toString("utf8"));
  } finally {
    xml.fill(0);
  }
}

export function requiredBoiPairs(
  envelope: InvestmentSyncEnvelope,
): Array<{ currency: string; date: string }> {
  const pairs = new Set<string>();
  const calendarDate = (value: string): string => {
    if (!value.includes("T")) return value.slice(0, 10);
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value));
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const add = (currency: string, date: string) => {
    if (currency !== "ILS") pairs.add(`${currency}\u0000${calendarDate(date)}`);
  };
  for (const account of envelope.accounts) {
    add(account.brokerTotal.currency, account.brokerTotal.asOf);
    for (const position of account.positions)
      add(
        position.sourceValueCurrency ?? position.sourcePriceCurrency ?? position.currency,
        position.sourceAsOf ?? envelope.sourceAsOf.value,
      );
    for (const cash of account.cash) add(cash.currency, envelope.sourceAsOf.value);
  }
  return [...pairs].sort().map((pair) => {
    const [currency, date] = pair.split("\u0000");
    return { currency, date };
  });
}

/** The ordering seam used by source workers: BOI persistence completes before promotion. */
export async function completeSourceRefresh<T>(input: {
  envelope: InvestmentSyncEnvelope;
  cacheBoi: (pairs: Array<{ currency: string; date: string }>) => Promise<void>;
  promote: (envelope: InvestmentSyncEnvelope) => Promise<T>;
}): Promise<T> {
  await input.cacheBoi(requiredBoiPairs(input.envelope));
  return input.promote(input.envelope);
}

/** Refreshes public BOI data first; a recent authoritative cache is only an outage fallback. */
export async function refreshBoiWithFallback(
  required: Array<{ currency: string; date: string }>,
  refresh: (pairs: Array<{ currency: string; date: string }>) => Promise<void>,
  missing: (
    pairs: Array<{ currency: string; date: string }>,
  ) => Promise<Array<{ currency: string; date: string }>>,
): Promise<void> {
  if (required.length === 0) return;
  try {
    await refresh(required);
  } catch (error) {
    if ((await missing(required)).length > 0) throw error;
  }
}
