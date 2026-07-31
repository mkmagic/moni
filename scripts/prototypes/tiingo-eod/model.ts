// PROTOTYPE — throwaway evidence analyzer for the market-data amendment to #38.
//
// Question: can Tiingo's end-of-day contract classify VTI/VXUS as active USD
// ETFs and AAPL as an active USD stock, then return fresh closing prices as
// exact decimal text without making a broker snapshot or a JavaScript float
// the current-price authority?
//
// This module is deliberately pure. The terminal/network shell in index.ts
// supplies the current supported-ticker inventory and in-memory CSV responses.
import { inflateRawSync } from "node:zlib";

import Decimal from "decimal.js";

export interface SymbolSpec {
  ticker: string;
  assetType: "ETF" | "Stock";
  priceCurrency: string;
}

export interface QuoteEvidence {
  spec: SymbolSpec;
  csv: string;
}

export interface ContractCheck {
  name: string;
  status: "proven" | "unproven";
  evidence: string;
}

export interface QuoteInventory {
  symbolsRequested: number;
  symbolsCovered: number;
  quoteRows: number;
  newestQuoteDate?: string;
  oldestQuoteAgeDays?: number;
  checks: ContractCheck[];
}

interface CoverageRow {
  ticker: string;
  exchange: string;
  assetType: string;
  priceCurrency: string;
  startDate: string;
  endDate: string;
}

interface PriceRow {
  date: string;
  close: string;
}

const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_DEFLATE = 8;
const MAX_INVENTORY_BYTES = 20 * 1024 * 1024;

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("unterminated_csv_quote");
  fields.push(field);
  return fields;
}

function parseCsv(csv: string): Array<Record<string, string>> {
  const lines = csv
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    if (values.length !== headers.length) throw new Error("csv_column_count_mismatch");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

export function extractSupportedTickerCsv(zip: Buffer): string {
  if (zip.byteLength < 30 || zip.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error("unsupported_zip_shape");
  }

  const compressionMethod = zip.readUInt16LE(8);
  const compressedSize = zip.readUInt32LE(18);
  const uncompressedSize = zip.readUInt32LE(22);
  const fileNameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const dataStart = 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + compressedSize;

  if (
    compressionMethod !== ZIP_DEFLATE ||
    uncompressedSize === 0 ||
    uncompressedSize > MAX_INVENTORY_BYTES ||
    dataEnd > zip.byteLength
  ) {
    throw new Error("unsupported_zip_shape");
  }

  const csv = inflateRawSync(zip.subarray(dataStart, dataEnd), {
    maxOutputLength: MAX_INVENTORY_BYTES,
  });
  try {
    if (csv.byteLength !== uncompressedSize) throw new Error("zip_size_mismatch");
    return new TextDecoder("utf-8", { fatal: true }).decode(csv);
  } finally {
    csv.fill(0);
  }
}

function coverageByTicker(csv: string, requested: ReadonlySet<string>): Map<string, CoverageRow> {
  const rows = new Map<string, CoverageRow>();
  const lines = csv.split(/\r?\n/);
  const headers = parseCsvLine(lines[0] ?? "");
  const expectedHeaders = [
    "ticker",
    "exchange",
    "assetType",
    "priceCurrency",
    "startDate",
    "endDate",
  ];
  if (headers.join("\u0001") !== expectedHeaders.join("\u0001")) {
    throw new Error("coverage_header_mismatch");
  }

  for (const line of lines.slice(1)) {
    if (!line) continue;
    const values = parseCsvLine(line);
    const ticker = values[0];
    if (!requested.has(ticker)) continue;
    if (values.length !== expectedHeaders.length) throw new Error("coverage_column_count_mismatch");
    rows.set(ticker, {
      ticker,
      exchange: values[1],
      assetType: values[2],
      priceCurrency: values[3],
      startDate: values[4],
      endDate: values[5],
    });
  }
  return rows;
}

function parsePriceRow(csv: string): PriceRow | undefined {
  const rows = parseCsv(csv);
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  return { date: row.date ?? "", close: row.close ?? "" };
}

function isExactPositiveDecimal(value: string): boolean {
  if (!DECIMAL_TEXT.test(value)) return false;
  try {
    return new Decimal(value).isPositive() && new Decimal(value).isFinite();
  } catch {
    return false;
  }
}

function isoDate(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(value);
  return match?.[1];
}

function ageInCalendarDays(date: string, now: Date): number | undefined {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return undefined;
  const timestamp = Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const age = Math.floor((today - timestamp) / 86_400_000);
  return age >= 0 ? age : undefined;
}

function check(name: string, proven: boolean, evidence: string): ContractCheck {
  return { name, status: proven ? "proven" : "unproven", evidence };
}

export function analyzeTiingoEvidence(
  coverageCsv: string,
  quotes: QuoteEvidence[],
  now: Date = new Date(),
): QuoteInventory {
  const requested = new Set(quotes.map(({ spec }) => spec.ticker));
  const coverage = coverageByTicker(coverageCsv, requested);
  const priceRows = quotes.map(({ csv }) => parsePriceRow(csv));
  const quoteDates = priceRows.map((row) => (row ? isoDate(row.date) : undefined));
  const quoteAges = quoteDates.map((date) => (date ? ageInCalendarDays(date, now) : undefined));

  const allCovered = quotes.every(({ spec }) => coverage.has(spec.ticker));
  const correctKinds = quotes.every(
    ({ spec }) => coverage.get(spec.ticker)?.assetType === spec.assetType,
  );
  const explicitCurrencies = quotes.every(
    ({ spec }) => coverage.get(spec.ticker)?.priceCurrency === spec.priceCurrency,
  );
  const activeCoverage = quotes.every(({ spec }) => {
    const endDate = coverage.get(spec.ticker)?.endDate;
    const age = endDate ? ageInCalendarDays(endDate, now) : undefined;
    return age !== undefined && age <= 7;
  });
  const exactCloses = priceRows.every((row) => row && isExactPositiveDecimal(row.close));
  const datedQuotes = quoteDates.every((date) => date !== undefined);
  const freshQuotes = quoteAges.every((age) => age !== undefined && age <= 7);
  const concreteAges = quoteAges.filter((age): age is number => age !== undefined);
  const concreteDates = quoteDates.filter((date): date is string => date !== undefined).sort();

  const checks: ContractCheck[] = [
    check(
      "requested symbol coverage",
      allCovered,
      `${coverage.size} of ${requested.size} requested symbol(s) appear in Tiingo's current inventory`,
    ),
    check(
      "asset classification",
      correctKinds,
      "every requested symbol has the expected ETF/Stock classification",
    ),
    check(
      "active coverage",
      activeCoverage,
      "every inventory end date is no more than seven calendar days old",
    ),
    check(
      "explicit quote currency",
      explicitCurrencies,
      "every requested symbol has the expected explicit price currency",
    ),
    check(
      "one latest quote per symbol",
      priceRows.every((row) => row !== undefined),
      `${priceRows.filter((row) => row !== undefined).length} latest quote row(s) parsed`,
    ),
    check(
      "exact closing prices",
      exactCloses,
      "every closing price arrived as positive decimal text and parsed without a JS number",
    ),
    check("authoritative quote dates", datedQuotes, "every quote carries an ISO source date"),
    check(
      "usable quote freshness",
      freshQuotes,
      "every quote date is no more than seven calendar days old",
    ),
  ];

  return {
    symbolsRequested: requested.size,
    symbolsCovered: coverage.size,
    quoteRows: priceRows.filter((row) => row !== undefined).length,
    newestQuoteDate: concreteDates.at(-1),
    oldestQuoteAgeDays: concreteAges.length > 0 ? Math.max(...concreteAges) : undefined,
    checks,
  };
}
