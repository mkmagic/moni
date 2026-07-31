// PROTOTYPE — throwaway evidence collector for issue #39.
//
// Question: can Schwab's original Positions CSV plus an explicit account-
// currency confirmation satisfy Moni's complete investment snapshot contract,
// reconcile exactly, and provide safe inputs for later symbol resolution?
//
// This module is deliberately pure. Monetary cells remain decimal text until
// Decimal parses them; they never pass through a JavaScript number.
import Decimal from "decimal.js";

export interface ContractCheck {
  name: string;
  status: "proven" | "unproven";
  evidence: string;
}

export interface SchwabCsvInventory {
  bytes: number;
  headerRow: number;
  preambleRows: number;
  bodyRows: number;
  positionRows: number;
  cashRows: number;
  totalRows: number;
  fields: string[];
  snapshotChecks: ContractCheck[];
  identityChecks: ContractCheck[];
}

type CsvRow = string[];

function parseCsv(source: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("unterminated_csv_field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[®™*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findHeaderRow(rows: CsvRow[]): number {
  const expected = ["symbol", "description", "quantity", "price", "market value"];
  let bestIndex = -1;
  let bestScore = -1;

  for (const [index, row] of rows.slice(0, 20).entries()) {
    const headers = row.map(normalizeHeader);
    const matches = expected.filter((name) =>
      headers.some((header) => header === name || header.includes(`(${name})`)),
    ).length;
    const score = matches * 100 + headers.filter(Boolean).length;
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  return bestScore >= 500 ? bestIndex : -1;
}

function findColumn(headers: string[], candidates: string[]): number {
  const exact = headers.findIndex((header) => candidates.includes(header));
  if (exact >= 0) return exact;
  return headers.findIndex((header) =>
    candidates.some((candidate) => header.includes(`(${candidate})`)),
  );
}

function cell(row: CsvRow, index: number): string {
  return index >= 0 ? (row[index] ?? "") : "";
}

function parseExactDecimal(value: string): Decimal | null {
  const trimmed = value.trim();
  if (!trimmed || /^(?:--|n\/a)$/i.test(trimmed)) return null;

  const parenthesized = /^\(.*\)$/.test(trimmed);
  const unsigned = trimmed
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .replace(/[,$\s]/g, "")
    .replace(/^\+/, "");
  const normalized = parenthesized ? `-${unsigned}` : unsigned;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return null;

  try {
    const decimal = new Decimal(normalized);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function exactSumEquals(values: string[], expected: string): boolean {
  const parsedValues = values.map(parseExactDecimal);
  const parsedExpected = parseExactDecimal(expected);
  if (parsedExpected === null || parsedValues.some((value) => value === null)) return false;

  return parsedValues
    .reduce<Decimal>((sum, value) => sum.plus(value as Decimal), new Decimal(0))
    .equals(parsedExpected);
}

function check(name: string, proven: boolean, evidence: string): ContractCheck {
  return { name, status: proven ? "proven" : "unproven", evidence };
}

export function analyzeSchwabPositionsCsv(
  source: string,
  bytes: number,
  confirmedCurrency: string,
): SchwabCsvInventory {
  const rows = parseCsv(source);
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) throw new Error("positions_header_not_found");

  const rawFields = rows[headerIndex].map((value) => value.replace(/^\uFEFF/, "").trim());
  const fields = rawFields.filter(Boolean);
  const headers = rawFields.map(normalizeHeader);
  const preamble = rows.slice(0, headerIndex).flat().join(" ");
  const body = rows
    .slice(headerIndex + 1)
    .filter((row) => row.some((value) => value.trim().length > 0));

  const symbolIndex = findColumn(headers, ["symbol"]);
  const quantityIndex = findColumn(headers, ["quantity"]);
  const priceIndex = findColumn(headers, ["price", "last price"]);
  const marketValueIndex = findColumn(headers, ["market value", "position dollar value"]);
  const assetTypeIndex = findColumn(headers, ["asset type", "security type", "investment type"]);
  const durableIdIndexes = [
    findColumn(headers, ["cusip"]),
    findColumn(headers, ["isin"]),
    findColumn(headers, ["figi"]),
    findColumn(headers, ["security id", "instrument id"]),
  ].filter((index) => index >= 0);

  const cashPattern = /(?:cash|money market|sweep)/i;
  const totalPattern = /\btotal\b/i;
  const rowText = body.map((row) => row.join(" "));
  const symbolLabels = body.map((row) => cell(row, symbolIndex).trim());
  const cashRows = body.filter((_, index) => cashPattern.test(rowText[index]));
  const totalRows = body.filter((_, index) => totalPattern.test(symbolLabels[index]));
  const positionRows = body.filter((row, index) => {
    if (cashPattern.test(rowText[index]) || totalPattern.test(symbolLabels[index])) return false;
    return cell(row, symbolIndex).trim().length > 0;
  });
  const classifiedRows = new Set([...cashRows, ...totalRows, ...positionRows]).size;

  const accountIdentityPresent =
    /account/i.test(preamble) && /(?:\*{2,}|\.{2,}|x{2,}|\d{3,})/i.test(preamble);
  const sourceTimestampPresent =
    /as of/i.test(preamble) &&
    /(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})/.test(preamble) &&
    /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(preamble) &&
    /\b(?:ET|EST|EDT|UTC|GMT)\b/i.test(preamble);
  const currencyConfirmed = /^[A-Z]{3}$/.test(confirmedCurrency);
  const symbolsPresent =
    positionRows.length > 0 &&
    symbolIndex >= 0 &&
    positionRows.every((row) => cell(row, symbolIndex).trim().length > 0);
  const assetTypesPresent =
    positionRows.length > 0 &&
    assetTypeIndex >= 0 &&
    positionRows.every((row) => cell(row, assetTypeIndex).trim().length > 0);
  const durableIdsPresent =
    durableIdIndexes.length > 0 &&
    positionRows.every((row) =>
      durableIdIndexes.some((index) => cell(row, index).trim().length > 0),
    );
  const exactQuantities =
    positionRows.length > 0 &&
    quantityIndex >= 0 &&
    positionRows.every((row) => parseExactDecimal(cell(row, quantityIndex)) !== null);
  const exactPrices =
    positionRows.length > 0 &&
    priceIndex >= 0 &&
    positionRows.every((row) => parseExactDecimal(cell(row, priceIndex)) !== null);
  const exactMarketValues =
    positionRows.length > 0 &&
    marketValueIndex >= 0 &&
    positionRows.every((row) => parseExactDecimal(cell(row, marketValueIndex)) !== null);
  const exactCash =
    cashRows.length > 0 &&
    marketValueIndex >= 0 &&
    cashRows.every((row) => parseExactDecimal(cell(row, marketValueIndex)) !== null);
  const exactTotal =
    totalRows.length === 1 &&
    marketValueIndex >= 0 &&
    parseExactDecimal(cell(totalRows[0], marketValueIndex)) !== null;
  const exactReconciliation =
    exactTotal &&
    exactSumEquals(
      [...positionRows, ...cashRows].map((row) => cell(row, marketValueIndex)),
      cell(totalRows[0], marketValueIndex),
    );

  const snapshotChecks: ContractCheck[] = [
    check("Schwab Positions CSV", fields.length > 0, "recognized header row and CSV structure"),
    check(
      "complete row classification",
      classifiedRows === body.length,
      "every body row is a position, cash, or total row",
    ),
    check(
      "account identity",
      accountIdentityPresent,
      "preamble contains a masked account identity",
    ),
    check(
      "authoritative source timestamp",
      sourceTimestampPresent,
      "preamble carries an as-of date, time, and timezone",
    ),
    check(
      "confirmed valuation currency",
      currencyConfirmed,
      "operator supplied one ISO 4217 account currency for this snapshot",
    ),
    check(
      "position rows",
      positionRows.length > 0,
      `${positionRows.length} position record(s) observed`,
    ),
    check("symbol", symbolsPresent, "every position has a provider symbol"),
    check("instrument kind", assetTypesPresent, "every position has Asset Type"),
    check("exact position quantity", exactQuantities, "every position quantity is decimal text"),
    check("exact source price", exactPrices, "every position price is decimal text"),
    check(
      "exact source market value",
      exactMarketValues,
      "every position market value is decimal text",
    ),
    check("cash snapshot", exactCash, `${cashRows.length} cash record(s) with an exact value`),
    check("broker account total", exactTotal, "one total row has an exact value"),
    check(
      "exact reconciliation",
      exactReconciliation,
      "position market values plus cash equal the broker total exactly",
    ),
  ];

  const identityChecks: ContractCheck[] = [
    check(
      "provider-scoped holding identity",
      symbolsPresent,
      "Schwab account plus symbol can identify an imported source holding",
    ),
    check(
      "symbol match candidate",
      symbolsPresent && assetTypesPresent && currencyConfirmed,
      "symbol plus asset type plus confirmed currency can propose a cross-source match",
    ),
    check(
      "durable cross-source identity",
      durableIdsPresent,
      "every position requires CUSIP, ISIN, FIGI, security ID, or resolver evidence before automatic merge",
    ),
  ];

  return {
    bytes,
    headerRow: headerIndex + 1,
    preambleRows: headerIndex,
    bodyRows: body.length,
    positionRows: positionRows.length,
    cashRows: cashRows.length,
    totalRows: totalRows.length,
    fields,
    snapshotChecks,
    identityChecks,
  };
}
