import Decimal from "decimal.js";
import { parse } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import {
  normalizeIbkrFlexActivityXml,
  normalizeIbkrFlexXml,
  normalizeSchwabPositionsCsv,
  type IbkrFlexActivityEvidenceSet,
  type InvestmentSyncEnvelope,
} from ".";
import { errorLabel, logFetch, syncLog } from "@/lib/sync-log";

export const IBKR_FLEX_URL =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
export const BOI_SDMX_URL =
  "https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/";
const MAX = 10 * 1024 * 1024;
// Proven against a live Activity Flex Query by POC commit 77af35c. Keep the
// control flow, timing, endpoint, and retry codes aligned with that evidence.
const IBKR_INITIAL_REPORT_WAIT_MS = 20_000;
const IBKR_RETRY_WAIT_MS = 5_000;
const IBKR_MAX_REPORT_ATTEMPTS = 5;
const IBKR_RETRYABLE_REPORT_CODES = new Set([
  "1001",
  "1003",
  "1004",
  "1005",
  "1006",
  "1007",
  "1008",
  "1009",
  "1019",
  "1021",
]);

export type FetchAdapter = (input: string, init?: RequestInit) => Promise<Response>;
type SleepAdapter = (milliseconds: number) => Promise<void>;
export interface IbkrFlexDateWindow {
  from: string;
  to: string;
}

export const DEFAULT_IBKR_ACTIVITY_OVERLAP_DAYS = 30;
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
        headers: {
          Accept: "application/xml, text/xml, text/plain",
          "User-Agent": "Moni-IBKR-Flex-POC/0.1",
        },
        signal: AbortSignal.timeout(30_000),
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
  errorCode?: string;
}

function ibkrStatus(xml: Buffer): IbkrStatus | null {
  const parser = new XMLParser({ parseTagValue: false, trimValues: true });
  const parsed = parser.parse(xml.toString("utf8")) as {
    FlexStatementResponse?: {
      Status?: unknown;
      ReferenceCode?: unknown;
      ErrorCode?: unknown;
    };
  };
  const response = parsed.FlexStatementResponse;
  if (!response || typeof response !== "object") return null;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value.trim() : undefined;
  return {
    status: text(response.Status)?.toLowerCase(),
    referenceCode: text(response.ReferenceCode),
    errorCode: text(response.ErrorCode),
  };
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
  window?: IbkrFlexDateWindow,
): Promise<Buffer> {
  try {
    // IBKR's Flex API is GET-only, so the Tier-0 token and query id must be
    // materialized as interned (unwipeable) JS strings on the query string —
    // the same unavoidable, transient, worker-lifetime String exposure ADR 0009
    // accepts for the Tiingo token. Containment is the mitigation: these strings
    // and the assembled URL are never logged (only the endpoint is), fetch runs
    // with redirect:"error", and nothing here stringifies the full URL.
    const sendUrl = new URL(`${IBKR_FLEX_URL}/SendRequest`);
    sendUrl.searchParams.set("t", token.toString("ascii"));
    sendUrl.searchParams.set("q", queryId.toString("ascii"));
    sendUrl.searchParams.set("v", "3");
    if (window) {
      sendUrl.searchParams.set("fd", window.from.replaceAll("-", ""));
      sendUrl.searchParams.set("td", window.to.replaceAll("-", ""));
    }
    // The query id and token live in the URL, so only the endpoint is logged.
    const sendBody = await logFetch("ibkr.send.fetch", {}, () =>
      fetchIbkrResponse(sendUrl, fetcher),
    );
    let status: IbkrStatus | null;
    try {
      status = ibkrStatus(sendBody);
    } finally {
      sendBody.fill(0);
    }
    if (status?.status === "fail")
      throw new WorkerSourceError(`send_flex_${status.errorCode ?? "unknown"}`);
    if (status?.status !== "success" || !status.referenceCode)
      throw new WorkerSourceError("send_unexpected_response");
    if (!/^\d+$/.test(status.referenceCode))
      throw new WorkerSourceError("send_invalid_reference_code");
    const statementUrl = new URL(`${IBKR_FLEX_URL}/GetStatement`);
    statementUrl.searchParams.set("t", token.toString("ascii"));
    statementUrl.searchParams.set("q", status.referenceCode);
    statementUrl.searchParams.set("v", "3");
    syncLog("ibkr.send.accepted", { waitMs: IBKR_INITIAL_REPORT_WAIT_MS });
    await wait(IBKR_INITIAL_REPORT_WAIT_MS);
    for (let attempt = 1; attempt <= IBKR_MAX_REPORT_ATTEMPTS; attempt += 1) {
      const body = await logFetch("ibkr.statement.fetch", { attempt }, () =>
        fetchIbkrResponse(statementUrl, fetcher),
      );
      const statementStatus = ibkrStatus(body);
      // A body with no status envelope IS the report.
      if (!statementStatus) {
        syncLog("ibkr.statement.received", { attempt, bytes: body.length });
        return body;
      }
      syncLog("ibkr.statement.pending", {
        attempt,
        status: statementStatus.status,
        errorCode: statementStatus.errorCode,
      });
      body.fill(0);
      if (
        statementStatus.status === "fail" &&
        IBKR_RETRYABLE_REPORT_CODES.has(statementStatus.errorCode ?? "") &&
        attempt < IBKR_MAX_REPORT_ATTEMPTS
      ) {
        await wait(IBKR_RETRY_WAIT_MS);
        continue;
      }
      if (statementStatus.status === "fail")
        throw new WorkerSourceError(`retrieve_flex_${statementStatus.errorCode ?? "unknown"}`);
      throw new WorkerSourceError("retrieve_unexpected_response");
    }
    throw new WorkerSourceError("retrieve_attempts_exhausted");
  } finally {
    token.fill(0);
    queryId.fill(0);
  }
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function calendarDate(value: string): Date {
  if (!isoDatePattern.test(value)) throw new WorkerSourceError("invalid_date_range");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new WorkerSourceError("invalid_date_range");
  return date;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Splits an inclusive range into non-overlapping Flex windows of at most 365 days. */
export function splitIbkrFlexDateRange(from: string, to: string): IbkrFlexDateWindow[] {
  const first = calendarDate(from);
  const last = calendarDate(to);
  if (first > last) throw new WorkerSourceError("invalid_date_range");
  const windows: IbkrFlexDateWindow[] = [];
  for (let start = first; start <= last; start = addDays(start, 365)) {
    const candidateEnd = addDays(start, 364);
    windows.push({
      from: dateText(start),
      to: dateText(candidateEnd < last ? candidateEnd : last),
    });
  }
  return windows;
}

/** Applies the intentionally repeated tail used to pick up late and corrected activity. */
export function incrementalIbkrActivityRange(input: {
  initialFrom: string;
  syncedThrough?: string;
  to: string;
  overlapDays?: number;
}): IbkrFlexDateWindow {
  const initial = calendarDate(input.initialFrom);
  const end = calendarDate(input.to);
  const overlapDays = input.overlapDays ?? DEFAULT_IBKR_ACTIVITY_OVERLAP_DAYS;
  if (!Number.isSafeInteger(overlapDays) || overlapDays < 1)
    throw new WorkerSourceError("invalid_overlap_window");
  const start = input.syncedThrough
    ? new Date(
        Math.max(
          initial.getTime(),
          addDays(calendarDate(input.syncedThrough), -(overlapDays - 1)).getTime(),
        ),
      )
    : initial;
  if (start > end) throw new WorkerSourceError("invalid_date_range");
  return { from: dateText(start), to: dateText(end) };
}

/**
 * Fetches and parses every activity window before moving to the next one. Raw XML is wiped and
 * never appears in the returned value. The token and query id are caller-owned and wiped here.
 */
export async function fetchIbkrFlexActivityEvidence(input: {
  token: Buffer;
  queryId: Buffer;
  fingerprintKey: Uint8Array;
  from: string;
  to: string;
  syncedThrough?: string;
  overlapDays?: number;
  fetcher: FetchAdapter;
  wait?: SleepAdapter;
}): Promise<Array<{ window: IbkrFlexDateWindow; evidence: IbkrFlexActivityEvidenceSet }>> {
  try {
    const results: Array<{
      window: IbkrFlexDateWindow;
      evidence: IbkrFlexActivityEvidenceSet;
    }> = [];
    const range = incrementalIbkrActivityRange({
      initialFrom: input.from,
      syncedThrough: input.syncedThrough,
      to: input.to,
      overlapDays: input.overlapDays,
    });
    for (const window of splitIbkrFlexDateRange(range.from, range.to)) {
      const token = Buffer.from(input.token);
      const queryId = Buffer.from(input.queryId);
      const xml = await fetchIbkrFlexXml(token, queryId, input.fetcher, input.wait, window);
      try {
        results.push({
          window,
          evidence: normalizeIbkrFlexActivityXml(xml.toString("utf8"), input.fingerprintKey),
        });
      } finally {
        xml.fill(0);
      }
    }
    return results;
  } finally {
    input.token.fill(0);
    input.queryId.fill(0);
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
  options: { skipMissing?: boolean } = {},
): Array<{ currency: string; date: string; rate: string }> {
  try {
    if (csv.length > MAX) throw new WorkerSourceError("source_too_large");
    const rows = parse(csv, { columns: true, skip_empty_lines: true, cast: false }) as BoiRow[];
    return required.flatMap(({ currency, date }) => {
      if (currency === "ILS") return [{ currency, date, rate: "1" }];
      const candidates = rows.filter(
        (row) =>
          (row.BASE_CURRENCY === currency || row.CURRENCY === currency) &&
          row.COUNTER_CURRENCY === "ILS" &&
          row.TIME_PERIOD <= date,
      );
      candidates.sort((a, b) => b.TIME_PERIOD.localeCompare(a.TIME_PERIOD));
      const row = candidates[0];
      if (!row || dateDaysBefore(date, row.TIME_PERIOD) > 7) {
        // Opening lots may name dates or currencies BOI never published; one
        // such row must not cost every other row its rate.
        if (options.skipMissing) return [];
        throw new WorkerSourceError("missing_fx");
      }
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(row.OBS_VALUE) || !/^[+-]?\d+$/.test(row.UNIT_MULT))
        throw new WorkerSourceError("invalid_fx");
      return [
        {
          currency,
          date: row.TIME_PERIOD,
          rate: new Decimal(row.OBS_VALUE).div(new Decimal(10).pow(row.UNIT_MULT)).toString(),
        },
      ];
    });
  } finally {
    csv.fill(0);
  }
}

export async function fetchBoiRates(
  required: Array<{ currency: string; date: string }>,
  fetcher: FetchAdapter,
  options: { skipMissing?: boolean } = {},
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
  const response = await logFetch(
    "boi.sdmx.fetch",
    {
      startPeriod: url.searchParams.get("startPeriod"),
      endPeriod: url.searchParams.get("endPeriod"),
    },
    () => fetcher(url.toString(), { redirect: "error" }),
  );
  syncLog("boi.sdmx.status", { status: response.status });
  if (response.redirected) throw new WorkerSourceError("redirect_rejected");
  if (!response.ok) throw new WorkerSourceError("provider_rejected");
  const csv = await readBoundedResponse(response);
  return parseBoiSdmxCsv(csv, required, options);
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
  activityEvidence?: IbkrFlexActivityEvidenceSet,
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
  for (const activity of activityEvidence?.activities ?? []) {
    if (activity.currency) add(activity.currency, activity.tradeDate);
  }
  for (const lot of activityEvidence?.openLots ?? []) add(lot.currency, lot.tradeDate);
  return [...pairs].sort().map((pair) => {
    const [currency, date] = pair.split("\u0000");
    return { currency, date };
  });
}

/** The ordering seam used by source workers: BOI persistence completes before promotion. */
export async function completeSourceRefresh<T>(input: {
  envelope: InvestmentSyncEnvelope;
  activityEvidence?: IbkrFlexActivityEvidenceSet;
  cacheBoi: (pairs: Array<{ currency: string; date: string }>) => Promise<void>;
  promote: (envelope: InvestmentSyncEnvelope) => Promise<T>;
}): Promise<T> {
  await input.cacheBoi(requiredBoiPairs(input.envelope, input.activityEvidence));
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
    const gaps = await missing(required);
    // A BOI outage used to be completely silent whenever the cache happened
    // to cover the request, so nobody could tell that FX had gone stale.
    syncLog("boi.refresh.fallback", {
      error: errorLabel(error),
      required: required.length,
      missingFromCache: gaps.length,
      recovered: gaps.length === 0,
    });
    if (gaps.length > 0) throw error;
  }
}
