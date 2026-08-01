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

function list(root: Record<string, unknown>, parent: string, child: string): Attributes[] {
  const section = root[parent];
  if (!section || typeof section !== "object") return [];
  return rows((section as Record<string, unknown>)[child]);
}

function kind(value: string | undefined): "stock" | "etf" | "mutual_fund" | "generic" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "stock") return "stock";
  if (normalized === "etf") return "etf";
  if (normalized === "mutual fund") return "mutual_fund";
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
    const sourceAsOf = asOf(checked(z.object({ toDate: nonblankSchema }), statement[0]).toDate);
    if (!statements || Array.isArray(statements) || typeof statements !== "object")
      throw new InvestmentNormalizationError("unsupported_source_shape");
    const report = statements as Record<string, unknown>;
    const accountRows = list(report, "AccountInformation", "AccountInformation").map((row) =>
      checked(accountSchema, row),
    );
    requireLimit(accountRows.length, MAX_ACCOUNTS);
    if (!accountRows.length) throw new InvestmentNormalizationError("incomplete_coverage");
    const accountIds = new Set(accountRows.map((row) => row.accountId));
    if (accountIds.size !== accountRows.length)
      throw new InvestmentNormalizationError("identity_conflict");
    const positionRows = list(report, "OpenPositions", "OpenPosition").map((row) =>
      checked(positionSchema, row),
    );
    const cashRows = list(report, "CashReport", "CashReportCurrency").map((row) =>
      checked(cashSchema, row),
    );
    const totalRows = list(report, "EquitySummaryInBase", "EquitySummaryByReportDateInBase").map(
      (row) => checked(totalSchema, row),
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
        assetKind: kind(row.assetCategory),
        quantity,
        quantityUnit: "shares",
        currency: row.currency,
        sourcePrice: price,
        sourcePriceCurrency: price === undefined ? undefined : row.currency,
        sourceValue: value,
        sourceValueCurrency: value === undefined ? undefined : row.currency,
        sourceAsOf: row.reportDate,
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
    for (const row of totalRows) {
      if (!accountIds.has(row.accountId) || totals.has(row.accountId))
        throw new InvestmentNormalizationError("incomplete_coverage");
      totals.set(row.accountId, { amount: decimalText(row.total), asOf: row.reportDate });
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
    throw code(error);
  }
}
