import Decimal from "decimal.js";
import { parse } from "csv-parse/sync";
import { normalizeIbkrFlexXml, normalizeSchwabPositionsCsv, type InvestmentSyncEnvelope } from ".";

export const IBKR_FLEX_URL =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
export const BOI_SDMX_URL =
  "https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/";
const MAX = 10 * 1024 * 1024;

export type FetchAdapter = (input: string, init?: RequestInit) => Promise<Response>;
export class WorkerSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
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
): Promise<Buffer> {
  let last: unknown;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const url = new URL(IBKR_FLEX_URL);
        url.searchParams.set("t", token.toString("utf8"));
        url.searchParams.set("q", queryId.toString("utf8"));
        const response = await fetcher(url.toString(), { redirect: "error" });
        if (response.redirected) throw new WorkerSourceError("redirect_rejected");
        if (!response.ok) throw new WorkerSourceError("provider_rejected");
        return await readBoundedResponse(response);
      } catch (error) {
        last = error;
        if (error instanceof WorkerSourceError || !transient(error) || attempt === 2) throw error;
      }
    }
    throw last;
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
  const response = await fetcher(`${BOI_SDMX_URL}?format=csv`, { redirect: "error" });
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
