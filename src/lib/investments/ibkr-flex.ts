import { createHmac } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { addDecimal, decimalText, isZero } from "./decimal";
import {
  normalizeInvestmentActivityEvidence,
  normalizeOpenLotEvidence,
  type InvestmentActivityEvidence,
  type OpenLotEvidence,
} from "./evidence";
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
  // IBKR names the venue `listingExchange` on OpenPosition; `exchange` is a
  // trade-level attribute that these rows do not carry. Reading only
  // `exchange` left every IBKR mapping with a null venue, which silently
  // disqualified the holding from a Tiingo quote forever
  // (src/domain/investment-valuation.ts, listTiingoQuoteTargets).
  listingExchange: z.string().optional(),
  exchange: z.string().optional(),
});

/**
 * IBKR reports the venue a security actually lists on, so a US ETF commonly
 * says ARCA or BATS. Tiingo eligibility is written against NYSE/NASDAQ, and
 * these are the same venues src/lib/investments/snaptrade.ts already folds in
 * from their MIC codes — ARCA is NYSE Arca and BATS is Cboe BZX.
 */
const IBKR_EXCHANGE_ALIASES: Record<string, string> = {
  ARCA: "NYSE",
  NYSEARCA: "NYSE",
  AMEX: "NYSE",
  BATS: "NYSE",
  BATSEX: "NYSE",
  NMS: "NASDAQ",
  ISLAND: "NASDAQ",
};

function venue(row: { listingExchange?: string; exchange?: string }): string | undefined {
  const raw = (row.listingExchange ?? row.exchange)?.trim();
  if (!raw) return undefined;
  return IBKR_EXCHANGE_ALIASES[raw.toUpperCase()] ?? raw;
}
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
        exchange: venue(row),
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

export interface IbkrDividendAccrualEvidence {
  source: "ibkr_flex";
  sourceAccountRef: string;
  idempotencyKey: string;
  sourceSecurityId: string;
  sourceSecurityIdKind: "conid";
  payDate: string;
  grossAmount?: string;
  withholdingTaxAmount?: string;
  feeAmount?: string;
  netAmount?: string;
  currency: string;
  rawCode?: string;
  linkedCashActivityId?: string;
}

export interface IbkrCorporateActionEvidence {
  source: "ibkr_flex";
  sourceAccountRef: string;
  idempotencyKey: string;
  sourceActionId?: string;
  sourceSecurityId?: string;
  sourceSecurityIdKind?: "conid";
  actionDate: string;
  rawType: string;
  rawCode?: string;
  rawDescription?: string;
  quantity?: string;
  proceeds?: string;
  currency?: string;
  classification: "UNSUPPORTED_CORPORATE_ACTION";
  provenance: "broker_reported";
}

export interface IbkrFlexActivityEvidenceSet {
  activities: InvestmentActivityEvidence[];
  openLots: OpenLotEvidence[];
  dividendAccruals: IbkrDividendAccrualEvidence[];
  corporateActions: IbkrCorporateActionEvidence[];
}

function attribute(row: Attributes, name: string): string | undefined {
  return row[name]?.trim() || undefined;
}

function activityReport(source: string): Record<string, unknown> {
  sourceText(source);
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  }).parse(source) as { FlexQueryResponse?: { FlexStatements?: Record<string, unknown> } };
  const statements = parsed.FlexQueryResponse?.FlexStatements?.FlexStatement;
  if (!statements || Array.isArray(statements) || typeof statements !== "object")
    throw new InvestmentNormalizationError("unsupported_source_shape");
  return statements as Record<string, unknown>;
}

function flexDateTime(date: string, time?: string): string {
  const normalizedDate = flexDate(date);
  if (!time) return normalizedDate;
  const text = time.trim().split(";")[0];
  const compact = /^(\d{2})(\d{2})(\d{2})$/.exec(text);
  return compact
    ? `${normalizedDate}T${compact[1]}:${compact[2]}:${compact[3]}`
    : `${normalizedDate}T${text}`;
}

function fingerprint(key: Uint8Array, kind: string, parts: Array<string | undefined>): string {
  if (key.byteLength === 0) throw new InvestmentNormalizationError("unsupported_source_shape");
  return `ibkr:${kind}:fp:${createHmac("sha256", key)
    .update(JSON.stringify(parts.map((part) => part ?? "")))
    .digest("base64url")}`;
}

function cashActivityType(type: string): InvestmentActivityEvidence["activityType"] {
  const normalized = type.toLowerCase();
  // The provider-neutral contract calls contributions `deposit` and keeps
  // substitute dividends under `dividend`; rawType preserves both distinctions.
  if (normalized.includes("dividend") || normalized.includes("payment in lieu")) return "dividend";
  if (normalized.includes("withholding") || normalized === "tax") return "tax";
  if (normalized.includes("fee") || normalized.includes("commission")) return "fee";
  if (normalized.includes("deposit") || normalized.includes("contribution")) return "deposit";
  if (normalized.includes("withdraw")) return "withdrawal";
  if (normalized.includes("interest")) return "interest";
  return "other";
}

function cashLinkKey(row: Attributes): string {
  return [
    attribute(row, "accountId"),
    attribute(row, "conid"),
    attribute(row, "currency"),
    flexDate(attribute(row, "dateTime") ?? ""),
  ].join("|");
}

/**
 * Normalizes activity evidence independently of the existing snapshot path.
 * The fingerprint key is caller-owned and is never copied, stringified, or wiped here.
 */
export function normalizeIbkrFlexActivityXml(
  source: string,
  fingerprintKey: Uint8Array,
): IbkrFlexActivityEvidenceSet {
  try {
    const report = activityReport(source);
    const activities: InvestmentActivityEvidence[] = [];

    for (const row of records(report, "Trade")) {
      if (attribute(row, "levelOfDetail")?.toUpperCase() !== "EXECUTION") continue;
      const buySell = attribute(row, "buySell")?.toUpperCase();
      if (buySell !== "BUY" && buySell !== "SELL") continue;
      const accountId = checked(nonblankSchema, attribute(row, "accountId"));
      const executionId = attribute(row, "ibExecID");
      const tradeId = attribute(row, "tradeID");
      if (!executionId && !tradeId) throw new InvestmentNormalizationError("incomplete_coverage");
      const tradeDate = flexDate(checked(nonblankSchema, attribute(row, "tradeDate")));
      activities.push(
        normalizeInvestmentActivityEvidence({
          source: "ibkr_flex",
          sourceAccountRef: accountId,
          idempotencyKey: executionId
            ? `${accountId}:exec:${executionId}`
            : `${accountId}:trade:${tradeId}`,
          sourceActivityId: attribute(row, "transactionID"),
          sourceExecutionId: executionId,
          sourceTradeId: tradeId,
          sourceOrderId: attribute(row, "ibOrderID"),
          sourceRevisionOfId: attribute(row, "origTradeID") ?? attribute(row, "originalTradeID"),
          brokerOpenDateTime: attribute(row, "openDateTime"),
          sourceSecurityId: attribute(row, "conid"),
          sourceSecurityIdKind: attribute(row, "conid") ? "conid" : undefined,
          activityType: buySell.toLowerCase(),
          tradeDate,
          occurredAt: flexDateTime(tradeDate, attribute(row, "tradeTime")),
          settlementDate: attribute(row, "settleDateTarget")
            ? flexDate(attribute(row, "settleDateTarget")!)
            : undefined,
          quantity: attribute(row, "quantity"),
          quantityUnit: attribute(row, "quantity") ? "shares" : undefined,
          price: attribute(row, "tradePrice"),
          grossAmount: attribute(row, "proceeds"),
          feeAmount: attribute(row, "ibCommission"),
          taxAmount: attribute(row, "tax") ?? attribute(row, "taxes"),
          netCashAmount: attribute(row, "netCash"),
          currency: attribute(row, "currency"),
          rawType: attribute(row, "tradeType") ?? "Trade",
          rawCode: attribute(row, "code"),
          rawDescription: attribute(row, "notes"),
          provenance: "broker_reported",
        }),
      );
    }

    const openLots = records(report, "OpenPosition")
      .filter((row) => attribute(row, "levelOfDetail")?.toUpperCase() === "LOT")
      .map((row) => {
        const accountId = checked(nonblankSchema, attribute(row, "accountId"));
        const conid = checked(nonblankSchema, attribute(row, "conid"));
        const opened = checked(nonblankSchema, attribute(row, "openDateTime"));
        const quantity = checked(nonblankSchema, attribute(row, "position"));
        const totalCost = checked(nonblankSchema, attribute(row, "costBasisMoney"));
        const sourceLotId = attribute(row, "originatingTransactionID");
        const idempotencyKey = sourceLotId
          ? `${accountId}:lot:${sourceLotId}`
          : fingerprint(fingerprintKey, "lot", [
              accountId,
              conid,
              opened,
              attribute(row, "side"),
              quantity,
              attribute(row, "costBasisPrice"),
              totalCost,
            ]);
        return normalizeOpenLotEvidence({
          source: "ibkr_flex",
          sourceAccountRef: accountId,
          idempotencyKey,
          sourceLotId: sourceLotId ?? idempotencyKey,
          sourceSecurityId: conid,
          sourceSecurityIdKind: "conid",
          tradeDate: flexDate(opened),
          originalQuantity: quantity,
          remainingQuantity: quantity,
          quantityUnit: "shares",
          unitCost: attribute(row, "costBasisPrice"),
          totalCost,
          currency: attribute(row, "currency"),
          provenance: "broker_reported",
        });
      });

    const cashRows = records(report, "CashTransaction");
    const cashActivityIds = new Map<string, string[]>();
    for (const row of cashRows) {
      const accountId = checked(nonblankSchema, attribute(row, "accountId"));
      const type = checked(nonblankSchema, attribute(row, "type"));
      const dateTime = checked(nonblankSchema, attribute(row, "dateTime"));
      const tradeId = attribute(row, "tradeID");
      const activityId = tradeId
        ? `${accountId}:cash:${tradeId}`
        : fingerprint(fingerprintKey, "cash", [
            accountId,
            dateTime,
            type,
            attribute(row, "conid"),
            attribute(row, "currency"),
            attribute(row, "amount"),
            attribute(row, "description"),
            attribute(row, "code"),
          ]);
      const activityType = cashActivityType(type);
      activities.push(
        normalizeInvestmentActivityEvidence({
          source: "ibkr_flex",
          sourceAccountRef: accountId,
          idempotencyKey: activityId,
          sourceActivityId: activityId,
          sourceTradeId: tradeId,
          sourceSecurityId: attribute(row, "conid"),
          sourceSecurityIdKind: attribute(row, "conid") ? "conid" : undefined,
          activityType,
          tradeDate: flexDate(dateTime),
          occurredAt: flexDateTime(dateTime),
          grossAmount: activityType === "dividend" ? attribute(row, "amount") : undefined,
          taxAmount: activityType === "tax" ? attribute(row, "amount") : undefined,
          feeAmount: activityType === "fee" ? attribute(row, "amount") : undefined,
          netCashAmount: attribute(row, "amount"),
          currency: attribute(row, "currency"),
          rawType: type,
          rawCode: attribute(row, "code"),
          rawDescription: attribute(row, "description"),
          provenance: "broker_reported",
        }),
      );
      if (activityType === "dividend") {
        const key = cashLinkKey(row);
        cashActivityIds.set(key, [...(cashActivityIds.get(key) ?? []), activityId]);
      }
    }

    const usedCashActivityIds = new Set<string>();
    const dividendAccruals = records(report, "ChangeInDividendAccrual").map((row) => {
      const accountId = checked(nonblankSchema, attribute(row, "accountId"));
      const conid = checked(nonblankSchema, attribute(row, "conid"));
      const currency = checked(currencySchema, attribute(row, "currency"));
      const payDate = flexDate(checked(nonblankSchema, attribute(row, "payDate")));
      const key = [accountId, conid, currency, payDate].join("|");
      const linkedCashActivityId = cashActivityIds
        .get(key)
        ?.find((candidate) => !usedCashActivityIds.has(candidate));
      if (linkedCashActivityId) usedCashActivityIds.add(linkedCashActivityId);
      return {
        source: "ibkr_flex" as const,
        sourceAccountRef: accountId,
        idempotencyKey: fingerprint(fingerprintKey, "accrual", [
          accountId,
          conid,
          currency,
          attribute(row, "exDate"),
          payDate,
          attribute(row, "quantity"),
          attribute(row, "grossAmount"),
          attribute(row, "tax"),
          attribute(row, "netAmount"),
          attribute(row, "code"),
        ]),
        sourceSecurityId: conid,
        sourceSecurityIdKind: "conid" as const,
        payDate,
        grossAmount: attribute(row, "grossAmount")
          ? decimalText(attribute(row, "grossAmount")!)
          : undefined,
        withholdingTaxAmount: attribute(row, "tax")
          ? decimalText(attribute(row, "tax")!)
          : undefined,
        feeAmount: attribute(row, "fee") ? decimalText(attribute(row, "fee")!) : undefined,
        netAmount: attribute(row, "netAmount")
          ? decimalText(attribute(row, "netAmount")!)
          : undefined,
        currency,
        rawCode: attribute(row, "code"),
        linkedCashActivityId,
      };
    });

    const corporateActions = records(report, "CorporateAction").map((row) => {
      const accountId = checked(nonblankSchema, attribute(row, "accountId"));
      const dateTime = checked(nonblankSchema, attribute(row, "dateTime"));
      const actionId = attribute(row, "transactionID");
      return {
        source: "ibkr_flex" as const,
        sourceAccountRef: accountId,
        idempotencyKey: actionId
          ? `${accountId}:corp:${actionId}`
          : fingerprint(fingerprintKey, "corp", [
              accountId,
              dateTime,
              attribute(row, "type"),
              attribute(row, "code"),
              attribute(row, "conid"),
              attribute(row, "quantity"),
              attribute(row, "proceeds") ?? attribute(row, "value"),
              attribute(row, "description"),
            ]),
        sourceActionId: actionId,
        sourceSecurityId: attribute(row, "conid"),
        sourceSecurityIdKind: attribute(row, "conid") ? ("conid" as const) : undefined,
        actionDate: flexDate(dateTime),
        rawType: attribute(row, "type") ?? "CorporateAction",
        rawCode: attribute(row, "code"),
        rawDescription: attribute(row, "description"),
        quantity: attribute(row, "quantity") ? decimalText(attribute(row, "quantity")!) : undefined,
        proceeds: attribute(row, "proceeds")
          ? decimalText(attribute(row, "proceeds")!)
          : attribute(row, "value")
            ? decimalText(attribute(row, "value")!)
            : undefined,
        currency: attribute(row, "currency"),
        classification: "UNSUPPORTED_CORPORATE_ACTION" as const,
        provenance: "broker_reported" as const,
      };
    });

    return { activities, openLots, dividendAccruals, corporateActions };
  } catch (error) {
    throw code(error);
  }
}
