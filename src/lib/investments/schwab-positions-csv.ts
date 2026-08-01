import { parse } from "csv-parse/sync";

import { addDecimal, decimalText, isZero } from "./decimal";
import { asOf, code, currencySchema, requireLimit, sourceText } from "./shared";
import { InvestmentNormalizationError, type InvestmentSyncEnvelope } from "./types";

type Row = string[];

function header(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[®™*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function field(columns: string[], name: string): number {
  return columns.findIndex((column) => column === name);
}

function displayDecimal(value: string): string {
  const text = value.trim();
  if (!/^(?:\(\$?[\d,]+(?:\.\d+)?\)|[+-]?\$?[\d,]+(?:\.\d+)?)$/.test(text))
    throw new InvestmentNormalizationError("invalid_decimal");
  return decimalText(`${text.startsWith("(") ? "-" : ""}${text.replace(/[()$,]/g, "")}`);
}

function cell(row: Row, index: number): string {
  return index < 0 ? "" : (row[index] ?? "").trim();
}

function currency(value: string): string {
  const parsed = currencySchema.safeParse(value);
  if (!parsed.success) throw new InvestmentNormalizationError("unsupported_source_shape");
  return parsed.data;
}

function sourceTime(preamble: string): string {
  const match =
    /^Positions for account Individual (.+) as of (\d{1,2}):(\d{2}) (AM|PM) ET, (\d{4})\/(\d{2})\/(\d{2})$/.exec(
      preamble.trim(),
    );
  if (!match) throw new InvestmentNormalizationError("incomplete_snapshot");
  const hour =
    match[4] === "PM"
      ? ({
          "1": "13",
          "2": "14",
          "3": "15",
          "4": "16",
          "5": "17",
          "6": "18",
          "7": "19",
          "8": "20",
          "9": "21",
          "10": "22",
          "11": "23",
          "12": "12",
        }[match[2]] ?? "")
      : match[2] === "12"
        ? "00"
        : match[2].padStart(2, "0");
  return `${match[5]}-${match[6]}-${match[7]}T${hour}:${match[3]}:00-04:00`;
}

export function normalizeSchwabPositionsCsv(
  source: string,
  confirmedCurrency: string,
): InvestmentSyncEnvelope {
  try {
    sourceText(source);
    const rows = parse(source, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: false,
    }) as Row[];
    const headerIndex = rows.findIndex(
      (row) =>
        row.map(header).includes("symbol") &&
        row.map(header).includes("qty (quantity)") &&
        row.map(header).includes("mkt val (market value)"),
    );
    if (headerIndex < 1) throw new InvestmentNormalizationError("unsupported_source_shape");
    const preamble = rows.slice(0, headerIndex).flat().join(",");
    const account = /^Positions for account Individual (.+) as of /.exec(preamble)?.[1];
    if (!account) throw new InvestmentNormalizationError("incomplete_coverage");
    const sourceAsOfValue = sourceTime(preamble);
    const baseCurrency = currency(confirmedCurrency);
    const columns = rows[headerIndex].map(header);
    const symbolIndex = field(columns, "symbol");
    const descriptionIndex = field(columns, "description");
    const quantityIndex = field(columns, "qty (quantity)");
    const priceIndex = field(columns, "price");
    const valueIndex = field(columns, "mkt val (market value)");
    const typeIndex = field(columns, "asset type");
    if ([symbolIndex, quantityIndex, priceIndex, valueIndex, typeIndex].some((index) => index < 0))
      throw new InvestmentNormalizationError("unsupported_source_shape");
    const body = rows.slice(headerIndex + 1);
    if (body.some((row) => row.length !== columns.length)) {
      throw new InvestmentNormalizationError("unsupported_source_shape");
    }
    const totalRows = body.filter((row) => cell(row, symbolIndex) === "Positions Total");
    if (totalRows.length !== 1) throw new InvestmentNormalizationError("incomplete_snapshot");
    const holdings = body.filter((row) => cell(row, symbolIndex) !== "Positions Total");
    const cashRows = holdings.filter((row) => cell(row, typeIndex) === "Cash and Money Market");
    const positionRows = holdings.filter((row) => !cashRows.includes(row));
    if (holdings.length !== positionRows.length + cashRows.length)
      throw new InvestmentNormalizationError("unsupported_source_shape");
    requireLimit(positionRows.length, 10_000);
    requireLimit(cashRows.length, 1_000);
    const positions: InvestmentSyncEnvelope["accounts"][number]["positions"] = [];
    for (const row of positionRows) {
      const sourceSecurityId = cell(row, symbolIndex);
      const assetType = cell(row, typeIndex).toLowerCase();
      if (!sourceSecurityId || assetType !== "etfs & closed end funds")
        throw new InvestmentNormalizationError("unsupported_source_shape");
      const quantity = displayDecimal(cell(row, quantityIndex));
      const sourcePrice = displayDecimal(cell(row, priceIndex));
      const sourceValue = displayDecimal(cell(row, valueIndex));
      if (!isZero(quantity) && !sourceValue)
        throw new InvestmentNormalizationError("unvalued_position");
      const entry = {
        sourceSecurityId,
        // Provider-scoped only; Task 4 must not use this for cross-provider merging.
        sourceSecurityIdKind: "schwab_symbol",
        symbol: cell(row, symbolIndex) || undefined,
        name: cell(row, descriptionIndex) || undefined,
        assetKind: "etf" as const,
        quantity,
        quantityUnit: "shares",
        currency: baseCurrency,
        sourcePrice,
        sourcePriceCurrency: baseCurrency,
        sourceValue,
        sourceValueCurrency: baseCurrency,
        sourceAsOf: sourceAsOfValue,
      };
      const duplicate = positions.find(
        (position) => position.sourceSecurityId === entry.sourceSecurityId,
      );
      if (!duplicate) positions.push(entry);
      else if (
        duplicate.assetKind !== entry.assetKind ||
        duplicate.currency !== entry.currency ||
        duplicate.sourcePrice !== entry.sourcePrice ||
        duplicate.sourceValue !== entry.sourceValue ||
        duplicate.sourceAsOf !== entry.sourceAsOf
      )
        throw new InvestmentNormalizationError("identity_conflict");
      else duplicate.quantity = addDecimal(duplicate.quantity, entry.quantity);
    }
    const cash = new Map<string, string>();
    for (const row of cashRows)
      cash.set(
        baseCurrency,
        addDecimal(cash.get(baseCurrency) ?? "0", displayDecimal(cell(row, valueIndex))),
      );
    const total = displayDecimal(cell(totalRows[0], valueIndex));
    if (!positions.length && !cash.size && !isZero(total))
      throw new InvestmentNormalizationError("incomplete_snapshot");
    return {
      source: "schwab_positions_csv",
      coverage: { kind: "bound_single_account", accountRefs: [account] },
      sourceAsOf: asOf(sourceAsOfValue),
      accounts: [
        {
          sourceAccountRef: account,
          baseCurrency,
          positions,
          cash: [...cash].map(([currency, amount]) => ({ currency, amount })),
          brokerTotal: { amount: total, currency: baseCurrency, asOf: sourceAsOfValue },
        },
      ],
    };
  } catch (error) {
    throw code(error);
  }
}
