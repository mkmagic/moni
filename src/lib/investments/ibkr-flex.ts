import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { addDecimal, decimalText, isZero } from "./decimal";
import {
  asOf,
  checked,
  code,
  currencySchema,
  MAX_ACCOUNTS,
  MAX_CASH_ROWS,
  MAX_POSITION_ROWS,
  nonblankSchema,
  requireLimit,
  sourceText,
} from "./shared";
import { InvestmentNormalizationError, type InvestmentSyncEnvelope } from "./types";

type Attributes = Record<string, string>;

const attributesSchema = z.record(z.string(), z.string());
const accountSchema = z.object({ accountId: nonblankSchema, currency: currencySchema });
const positionSchema = z.object({
  accountId: nonblankSchema,
  conid: nonblankSchema,
  position: z.string(),
  currency: currencySchema,
  reportDate: nonblankSchema,
  positionValue: z.string().optional(),
  markPrice: z.string().optional(),
  assetCategory: z.string().optional(),
  subCategory: z.string().optional(),
  levelOfDetail: z.string().optional(),
  symbol: z.string().optional(),
  description: z.string().optional(),
  exchange: z.string().optional(),
});
const cashSchema = z.object({
  accountId: nonblankSchema,
  currency: currencySchema,
  endingCash: z.string(),
});
const totalSchema = z.object({
  accountId: nonblankSchema,
  reportDate: nonblankSchema,
  total: z.string(),
});

function rows(value: unknown): Attributes[] {
  if (!value) return [];
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.map((row) => {
    if (!row || typeof row !== "object")
      throw new InvestmentNormalizationError("unsupported_source_shape");
    return checked(
      attributesSchema,
      Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value === "string")),
    );
  });
}

/** Collects the record tags proven by the live POC without trusting optional wrapper names. */
function records(root: Record<string, unknown>, tag: string): Attributes[] {
  const found: Attributes[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === tag) {
        const candidates = Array.isArray(child) ? child : [child];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          const attributes = Object.fromEntries(
            Object.entries(candidate).filter(([, item]) => typeof item === "string"),
          );
          if (Object.keys(attributes).length > 0) found.push(checked(attributesSchema, attributes));
        }
      }
      visit(child);
    }
  };
  visit(root);
  return found;
}

const DIAGNOSTIC_TAGS = [
  "FlexStatement",
  "AccountInformation",
  "OpenPosition",
  "CashReportCurrency",
  "EquitySummaryByReportDateInBase",
] as const;

/**
 * Opt-in failure report (MONI_IBKR_DIAGNOSTIC=1) describing the provider's actual
 * structure: row counts, attribute names, and value *shapes* — never values.
 */
function reportStructure(source: string, failure: string): void {
  const shape = (value: string) =>
    value.replace(/\d/g, "9").replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").slice(0, 40);
  const lines = [`ibkr-flex diagnostic: ${failure}`];
  for (const tag of DIAGNOSTIC_TAGS) {
    const rows = [...source.matchAll(new RegExp(`<${tag}(\\s[^<>]*?)?/?>`, "g"))];
    const shapes = new Map<string, Set<string>>();
    for (const row of rows)
      for (const attribute of (row[1] ?? "").matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
        const seen = shapes.get(attribute[1]) ?? new Set<string>();
        seen.add(shape(attribute[2]));
        shapes.set(attribute[1], seen);
      }
    lines.push(`  ${tag}: ${rows.length} row(s)`);
    for (const [name, seen] of shapes)
      lines.push(`    ${name}=${[...seen].slice(0, 3).join(" | ")}`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

/** IBKR's default Flex date format is yyyyMMdd; ISO-8601 is only an optional query setting. */
function flexDate(value: string): string {
  const text = value.trim().split(";")[0];
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : text;
}

function kind(
  category: string | undefined,
  subCategory: string | undefined,
): "stock" | "etf" | "mutual_fund" | "generic" {
  // IBKR reports asset classes as codes (STK, FUND) and only distinguishes ETFs
  // in subCategory; the long-form names cover the direct-export variants.
  const normalized = category?.trim().toLowerCase();
  if (subCategory?.trim().toUpperCase() === "ETF") return "etf";
  if (normalized === "stk" || normalized === "stock") return "stock";
  if (normalized === "etf") return "etf";
  if (normalized === "fund" || normalized === "mutual fund") return "mutual_fund";
  return "generic";
}

export function normalizeIbkrFlexXml(source: string): InvestmentSyncEnvelope {
  try {
    sourceText(source);
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
    });
    const parsed = parser.parse(source) as {
      FlexQueryResponse?: { FlexStatements?: Record<string, unknown> };
    };
    const root = parsed.FlexQueryResponse?.FlexStatements;
    if (!root || typeof root !== "object")
      throw new InvestmentNormalizationError("unsupported_source_shape");
    const statements = (root as Record<string, unknown>).FlexStatement;
    const statement = rows(statements);
    if (statement.length !== 1) throw new InvestmentNormalizationError("incomplete_coverage");
    const sourceAsOf = asOf(
      flexDate(checked(z.object({ toDate: nonblankSchema }), statement[0]).toDate),
    );
    if (!statements || Array.isArray(statements) || typeof statements !== "object")
      throw new InvestmentNormalizationError("unsupported_source_shape");
    const report = statements as Record<string, unknown>;
    const accountRows = records(report, "AccountInformation").map((row) =>
      checked(accountSchema, row),
    );
    requireLimit(accountRows.length, MAX_ACCOUNTS);
    if (!accountRows.length) throw new InvestmentNormalizationError("incomplete_coverage");
    const accountIds = new Set(accountRows.map((row) => row.accountId));
    if (accountIds.size !== accountRows.length)
      throw new InvestmentNormalizationError("identity_conflict");
    const openPositions = records(report, "OpenPosition").map((row) =>
      checked(positionSchema, row),
    );
    // A query configured for lot detail repeats every holding; the SUMMARY rows
    // are the non-overlapping view of the same positions.
    const summaries = openPositions.filter((row) => row.levelOfDetail?.toUpperCase() === "SUMMARY");
    const positionRows = summaries.length ? summaries : openPositions;
    // BASE_SUMMARY rows restate the other rows converted to the base currency.
    const cashRows = records(report, "CashReportCurrency")
      .filter((row) => row.currency !== "BASE_SUMMARY")
      .map((row) => checked(cashSchema, row));
    const totalRows = records(report, "EquitySummaryByReportDateInBase").map((row) =>
      checked(totalSchema, row),
    );
    requireLimit(positionRows.length, MAX_POSITION_ROWS);
    requireLimit(cashRows.length, MAX_CASH_ROWS);
    const positionsByAccount = new Map<
      string,
      InvestmentSyncEnvelope["accounts"][number]["positions"]
    >();
    for (const row of positionRows) {
      if (!accountIds.has(row.accountId))
        throw new InvestmentNormalizationError("incomplete_coverage");
      const quantity = decimalText(row.position);
      const value = row.positionValue === undefined ? undefined : decimalText(row.positionValue);
      const price = row.markPrice === undefined ? undefined : decimalText(row.markPrice);
      if (!isZero(quantity) && value === undefined && price === undefined)
        throw new InvestmentNormalizationError("unvalued_position");
      const entry = {
        sourceSecurityId: row.conid,
        sourceSecurityIdKind: "conid",
        symbol: row.symbol?.trim() || undefined,
        name: row.description?.trim() || undefined,
        exchange: row.exchange?.trim() || undefined,
        assetKind: kind(row.assetCategory, row.subCategory),
        quantity,
        quantityUnit: "shares",
        currency: row.currency,
        sourcePrice: price,
        sourcePriceCurrency: price === undefined ? undefined : row.currency,
        sourceValue: value,
        sourceValueCurrency: value === undefined ? undefined : row.currency,
        sourceAsOf: flexDate(row.reportDate),
      };
      const entries = positionsByAccount.get(row.accountId) ?? [];
      const duplicate = entries.find((item) => item.sourceSecurityId === entry.sourceSecurityId);
      if (!duplicate) entries.push(entry);
      else if (
        duplicate.assetKind !== entry.assetKind ||
        duplicate.quantityUnit !== entry.quantityUnit ||
        duplicate.currency !== entry.currency ||
        duplicate.sourcePrice !== entry.sourcePrice ||
        duplicate.sourceValue !== entry.sourceValue ||
        duplicate.sourceAsOf !== entry.sourceAsOf
      )
        throw new InvestmentNormalizationError("identity_conflict");
      else duplicate.quantity = addDecimal(duplicate.quantity, entry.quantity);
      positionsByAccount.set(row.accountId, entries);
    }
    const cashByAccount = new Map<string, Map<string, string>>();
    for (const row of cashRows) {
      if (!accountIds.has(row.accountId))
        throw new InvestmentNormalizationError("incomplete_coverage");
      const accountCash = cashByAccount.get(row.accountId) ?? new Map<string, string>();
      accountCash.set(
        row.currency,
        addDecimal(accountCash.get(row.currency) ?? "0", decimalText(row.endingCash)),
      );
      cashByAccount.set(row.accountId, accountCash);
    }
    const totals = new Map<string, { amount: string; asOf: string }>();
    // A multi-day query period yields one NAV row per report date; the closing
    // row is the snapshot, and a repeated date must agree with itself.
    for (const row of totalRows) {
      if (!accountIds.has(row.accountId))
        throw new InvestmentNormalizationError("incomplete_coverage");
      const entry = { amount: decimalText(row.total), asOf: flexDate(row.reportDate) };
      const current = totals.get(row.accountId);
      if (current && current.asOf > entry.asOf) continue;
      if (current && current.asOf === entry.asOf && current.amount !== entry.amount)
        throw new InvestmentNormalizationError("identity_conflict");
      totals.set(row.accountId, entry);
    }
    const accounts = accountRows.map((account) => {
      const total = totals.get(account.accountId);
      if (!total) throw new InvestmentNormalizationError("incomplete_snapshot");
      const positions = positionsByAccount.get(account.accountId) ?? [];
      const cash = [...(cashByAccount.get(account.accountId) ?? new Map())].map(
        ([currency, amount]) => ({ currency, amount }),
      );
      if (!positions.length && !cash.length && !isZero(total.amount))
        throw new InvestmentNormalizationError("incomplete_snapshot");
      return {
        sourceAccountRef: account.accountId,
        baseCurrency: account.currency,
        positions,
        cash,
        brokerTotal: { amount: total.amount, currency: account.currency, asOf: total.asOf },
      };
    });
    return {
      source: "ibkr_flex",
      coverage: {
        kind: "configured_query_accounts",
        accountRefs: accountRows.map((account) => account.accountId),
      },
      sourceAsOf,
      accounts,
    };
  } catch (error) {
    const failure = code(error);
    if (process.env.MONI_IBKR_DIAGNOSTIC === "1") reportStructure(source, failure.code);
    throw failure;
  }
}
