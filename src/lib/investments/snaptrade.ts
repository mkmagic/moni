import { createHmac } from "node:crypto";

import Decimal from "decimal.js";
import { z } from "zod";

import { decimalText } from "./decimal";
import {
  normalizeInvestmentActivityEvidence,
  type InvestmentActivityEvidence,
  type InvestmentActivityType,
} from "./evidence";
import type { IbkrFlexActivityEvidenceSet } from "./ibkr-flex";
import { asOf, checked, code, currencySchema, nonblankSchema, requireLimit } from "./shared";
import { InvestmentNormalizationError, type InvestmentSyncEnvelope } from "./types";
import { readBoundedResponse, WorkerSourceError, type FetchAdapter } from "./workers";
import { logFetch, syncLog } from "@/lib/sync-log";

export const SNAPTRADE_API_ORIGIN = "https://api.snaptrade.com";
const ACCOUNTS_PATH = "/accounts";

// encodeURI leaves these unescaped; everything else becomes %XX of its UTF-8
// bytes. Done over bytes rather than a string so the consumer key never exists
// as a String (docs/security/security-design-principles.md, Tier-0 handling).
const UNESCAPED = new Set(
  [...`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'();/?:@&=+$,#`].map(
    (character) => character.charCodeAt(0),
  ),
);

function encodeUriBytes(secret: Buffer): Buffer {
  const out: number[] = [];
  for (const byte of secret) {
    if (UNESCAPED.has(byte)) out.push(byte);
    else
      for (const char of `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
        out.push(char.charCodeAt(0));
  }
  return Buffer.from(out);
}

/**
 * SnapTrade signs `{content, path, query}` (keys sorted, content null on GET)
 * with HMAC-SHA256 under the URI-encoded consumer key. Replicated from
 * snaptrade-typescript-sdk@11.0.4 requestAfterHook rather than taking the SDK,
 * whose client requires the key as a String and returns money as `number`.
 */
export function signSnaptradeRequest(path: string, query: string, consumerKey: Buffer): string {
  const key = encodeUriBytes(consumerKey);
  try {
    return createHmac("sha256", key)
      .update(JSON.stringify({ content: null, path, query }))
      .digest("base64");
  } finally {
    key.fill(0);
  }
}

async function get(
  path: string,
  clientId: string,
  consumerKey: Buffer,
  fetcher: FetchAdapter,
  params = "",
): Promise<unknown> {
  // The signature covers the exact query string sent, so extra parameters are
  // part of it rather than appended after signing.
  const query = `clientId=${encodeURIComponent(clientId)}${params}&timestamp=${Math.round(Date.now() / 1000)}`;
  const url = new URL(`${path}?${query}`, SNAPTRADE_API_ORIGIN);
  if (url.origin !== SNAPTRADE_API_ORIGIN || !url.pathname.startsWith(ACCOUNTS_PATH))
    throw new WorkerSourceError("provider_rejected");
  const response = await fetcher(url.toString(), {
    redirect: "error",
    headers: {
      Accept: "application/json",
      Signature: signSnaptradeRequest(path, query, consumerKey),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.redirected) throw new WorkerSourceError("redirect_rejected");
  if (!response.ok) throw new WorkerSourceError("provider_rejected");
  const body = await readBoundedResponse(response);
  try {
    return parseJsonPreservingNumbers(body.toString("utf8"));
  } finally {
    body.fill(0);
  }
}

/**
 * SnapTrade sends money as bare JSON numbers, so JSON.parse would round it
 * through a float before any Decimal sees it. Quoting every numeric literal
 * first keeps the provider's own digits intact.
 */
export function parseJsonPreservingNumbers(text: string): unknown {
  let out = "";
  let inString = false;
  // Last non-whitespace character emitted outside a string. A number is in
  // value position only after one of : , [ — and the provider is free to put
  // whitespace in between, so endsWith() on the buffer would miss it.
  let previous = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        i += 1;
        out += text[i];
      } else if (char === '"') {
        inString = false;
        previous = '"';
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      previous = '"';
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (number && (previous === ":" || previous === "," || previous === "[")) {
      out += `"${number[0]}"`;
      i += number[0].length - 1;
      previous = "0";
      continue;
    }
    out += char;
    if (!/\s/.test(char)) previous = char;
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new InvestmentNormalizationError("unsupported_source_shape");
  }
}

const decimalString = z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/);

const accountSchema = z.object({
  id: nonblankSchema,
  institution_account_id: nonblankSchema.nullish(),
  institution_name: z.string().nullish(),
  sync_status: z.object({
    holdings: z.object({
      last_successful_sync: nonblankSchema,
      initial_sync_completed: z.boolean(),
    }),
  }),
  balance: z.object({ total: z.object({ amount: decimalString, currency: currencySchema }) }),
});

const balancesSchema = z.array(
  z.object({ currency: z.object({ code: currencySchema }), cash: decimalString.nullish() }),
);

const positionsSchema = z.object({
  results: z.array(
    z.object({
      instrument: z.object({
        kind: z.string().nullish(),
        symbol: nonblankSchema,
        description: z.string().nullish(),
        currency: currencySchema,
        exchange: z.string().nullish(),
        figi_instrument: z.object({ figi_code: nonblankSchema.nullish() }).nullish(),
      }),
      units: decimalString,
      price: decimalString.nullish(),
      currency: currencySchema.nullish(),
    }),
  ),
  data_freshness: z.object({ as_of: nonblankSchema }),
});

const activitySchema = z.object({
  id: nonblankSchema,
  external_reference_id: z.string().nullish(),
  type: nonblankSchema,
  description: z.string().nullish(),
  trade_date: nonblankSchema,
  settlement_date: z.string().nullish(),
  units: decimalString.nullish(),
  price: decimalString.nullish(),
  amount: decimalString.nullish(),
  fee: decimalString.nullish(),
  currency: z.object({ code: currencySchema }).nullish(),
  symbol: z
    .object({
      symbol: z.string().nullish(),
      figi_code: z.string().nullish(),
      figi_instrument: z.object({ figi_code: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

const activitiesPageSchema = z.object({ data: z.array(activitySchema) });

const ACTIVITY_PAGE_SIZE = 1000;
const MAX_ACTIVITY_ROWS = 100_000;

export type SnaptradeAccountPayload = {
  account: z.infer<typeof accountSchema>;
  balances: z.infer<typeof balancesSchema>;
  positions: z.infer<typeof positionsSchema>;
  /** The account's whole activity history; SnapTrade's default range is everything it has. */
  activities: Array<z.infer<typeof activitySchema>>;
};

/**
 * One authenticated pass over every account the personal key can see:
 * holdings for the snapshot, and the full activity history for lots and dividends.
 */
export async function fetchSnaptradeHoldings(
  clientId: Buffer,
  consumerKey: Buffer,
  fetcher: FetchAdapter,
): Promise<SnaptradeAccountPayload[]> {
  try {
    const id = clientId.toString("utf8");
    const accounts = checked(
      z.array(accountSchema),
      await logFetch("snaptrade.accounts.fetch", {}, () =>
        get(ACCOUNTS_PATH, id, consumerKey, fetcher),
      ),
    );
    requireLimit(accounts.length, 100);
    if (!accounts.length) throw new InvestmentNormalizationError("incomplete_coverage");
    const payloads: SnaptradeAccountPayload[] = [];
    for (const account of accounts) {
      const base = `${ACCOUNTS_PATH}/${encodeURIComponent(account.id)}`;
      const balances = checked(
        balancesSchema,
        await logFetch("snaptrade.balances.fetch", {}, () =>
          get(`${base}/balances`, id, consumerKey, fetcher),
        ),
      );
      const positions = checked(
        positionsSchema,
        await logFetch("snaptrade.positions.fetch", {}, () =>
          get(`${base}/positions/all`, id, consumerKey, fetcher),
        ),
      );
      const activities: SnaptradeAccountPayload["activities"] = [];
      for (let offset = 0; ; offset += ACTIVITY_PAGE_SIZE) {
        const page = checked(
          activitiesPageSchema,
          await logFetch("snaptrade.activities.fetch", { offset }, () =>
            get(
              `${base}/activities`,
              id,
              consumerKey,
              fetcher,
              `&offset=${offset}&limit=${ACTIVITY_PAGE_SIZE}`,
            ),
          ),
        );
        activities.push(...page.data);
        requireLimit(activities.length, MAX_ACTIVITY_ROWS);
        if (page.data.length < ACTIVITY_PAGE_SIZE) break;
      }
      syncLog("snaptrade.account", {
        institution: account.institution_name,
        positions: positions.results.length,
        activities: activities.length,
        asOf: positions.data_freshness.as_of,
        lastSync: account.sync_status.holdings.last_successful_sync,
      });
      payloads.push({ account, balances, positions, activities });
    }
    return payloads;
  } finally {
    clientId.fill(0);
    consumerKey.fill(0);
  }
}

/**
 * SnapTrade reports MIC codes; Tiingo eligibility (src/domain/investment-valuation.ts,
 * ADR 0009) is written against the venue names IBKR uses. ARCX and BATS are
 * mapped to NYSE deliberately: they are NYSE Arca and Cboe BZX, where most US
 * ETFs actually list, and a literal reading would leave the ADR's "USD ETFs"
 * clause with almost nothing to match. Reviewed and chosen by the owner.
 */
const EXCHANGE_BY_MIC: Record<string, string> = {
  XNYS: "NYSE",
  XNAS: "NASDAQ",
  ARCX: "NYSE",
  BATS: "NYSE",
};

function assetKind(kind: string | null | undefined): "stock" | "etf" | "mutual_fund" | "generic" {
  switch ((kind ?? "").toLowerCase()) {
    case "etf":
      return "etf";
    case "equity":
    case "stock":
      return "stock";
    case "mutual_fund":
    case "mutualfund":
      return "mutual_fund";
    default:
      return "generic";
  }
}

function accountRef(account: SnaptradeAccountPayload["account"]): string {
  return account.institution_account_id ?? account.id;
}

/**
 * SnapTrade carries no per-position market value, so sourceValue is left unset
 * and src/domain/investment-promotion.ts derives quantity x price and records
 * the basis as `quantity_times_price`.
 */
export function normalizeSnaptradeHoldings(
  payloads: SnaptradeAccountPayload[],
): InvestmentSyncEnvelope {
  try {
    if (!payloads.length) throw new InvestmentNormalizationError("incomplete_coverage");
    const accounts = payloads.map(({ account, balances, positions }) => {
      if (!account.sync_status.holdings.initial_sync_completed)
        throw new InvestmentNormalizationError("incomplete_snapshot");
      requireLimit(positions.results.length, 10_000);
      requireLimit(balances.length, 1_000);
      const positionAsOf = asOf(positions.data_freshness.as_of).value;
      const rows: InvestmentSyncEnvelope["accounts"][number]["positions"] = [];
      for (const row of positions.results) {
        const figi = row.instrument.figi_instrument?.figi_code;
        const entry = {
          sourceSecurityId: figi ?? row.instrument.symbol,
          // Provider-scoped only, exactly as the CSV and Flex sources treat theirs.
          sourceSecurityIdKind: figi ? "snaptrade_figi" : "snaptrade_symbol",
          symbol: row.instrument.symbol,
          name: row.instrument.description ?? undefined,
          exchange: row.instrument.exchange
            ? (EXCHANGE_BY_MIC[row.instrument.exchange] ?? row.instrument.exchange)
            : undefined,
          assetKind: assetKind(row.instrument.kind),
          quantity: decimalText(row.units),
          quantityUnit: "shares",
          currency: row.currency ?? row.instrument.currency,
          sourcePrice: row.price ? decimalText(row.price) : undefined,
          sourcePriceCurrency: row.currency ?? row.instrument.currency,
          sourceAsOf: positionAsOf,
        };
        if (rows.some((existing) => existing.sourceSecurityId === entry.sourceSecurityId))
          throw new InvestmentNormalizationError("identity_conflict");
        rows.push(entry);
      }
      return {
        sourceAccountRef: accountRef(account),
        institutionName: account.institution_name?.trim() || undefined,
        baseCurrency: account.balance.total.currency,
        positions: rows,
        cash: balances
          .filter((balance) => balance.cash != null)
          .map((balance) => ({
            currency: balance.currency.code,
            amount: decimalText(balance.cash!),
          })),
        brokerTotal: {
          amount: decimalText(account.balance.total.amount),
          currency: account.balance.total.currency,
          asOf: asOf(account.sync_status.holdings.last_successful_sync).value,
        },
      };
    });
    const earliest = accounts
      .map((account) => account.brokerTotal.asOf)
      .sort((left, right) => left.localeCompare(right))[0];
    return {
      source: "snaptrade",
      coverage: {
        kind: "configured_query_accounts",
        accountRefs: accounts.map((account) => account.sourceAccountRef),
      },
      sourceAsOf: asOf(earliest),
      accounts,
    };
  } catch (error) {
    throw code(error);
  }
}

function activityType(
  type: string,
  amount: string | undefined,
  units: string | undefined,
): InvestmentActivityType {
  switch (type.toUpperCase()) {
    case "BUY":
    // Dividend reinvestment buys shares; Schwab's DRIP shows up as plain BUY.
    case "REI":
      return "buy";
    case "SELL":
      return "sell";
    case "DIVIDEND":
    case "SUBSTITUTE_DIVIDEND":
      return "dividend";
    case "INTEREST":
      return "interest";
    case "FEE":
      return "fee";
    case "TAX":
      return "tax";
    case "CONTRIBUTION":
      return "deposit";
    case "WITHDRAWAL":
      return "withdrawal";
  }
  if (type.toUpperCase().includes("TRANSFER")) {
    // Shares moving in or out stay a transfer (no cost basis arrives with
    // them); a cash-only transfer such as a wire is funding, signed by amount.
    if (units !== undefined) return "transfer";
    if (amount !== undefined) return new Decimal(amount).isNegative() ? "withdrawal" : "deposit";
    return "transfer";
  }
  return "other";
}

/** A non-zero decimal as text, or undefined — SnapTrade sends 0.0 for "not applicable". */
function nonZero(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const text = decimalText(value);
  return new Decimal(text).isZero() ? undefined : text;
}

/**
 * Maps every account's activity history onto the provider-neutral evidence the
 * IBKR path already ingests. SnapTrade reports no lots, so opening lots stay
 * empty: positions older than its history window (Schwab's reaches back about
 * two years) show up as a reconciliation gap for the owner to fill with an
 * opening-lot import, never as an invented lot.
 *
 * `amount` is taken as the settled cash movement with any fee already inside
 * it, so a trade's gross is `amount` with the fee backed out. Schwab ETF
 * trades carry no fee, so this is unverified against a fee-bearing trade.
 */
export function normalizeSnaptradeActivity(
  payloads: SnaptradeAccountPayload[],
): IbkrFlexActivityEvidenceSet {
  try {
    const activities: InvestmentActivityEvidence[] = [];
    for (const { account, activities: rows } of payloads) {
      const sourceAccountRef = accountRef(account);
      for (const row of rows) {
        const units = nonZero(row.units);
        const amount = row.amount == null ? undefined : decimalText(row.amount);
        const fee = nonZero(row.fee);
        const type = activityType(row.type, amount, units);
        const figi = row.symbol?.figi_instrument?.figi_code ?? row.symbol?.figi_code ?? undefined;
        const symbol = row.symbol?.symbol?.trim() || undefined;
        // Cash rows (interest, wires) name Schwab's sweep placeholder, not a
        // security; only rows about shares, or a real FIGI, get an instrument.
        const security =
          figi || (symbol && (units !== undefined || type === "dividend"))
            ? {
                sourceSecurityId: figi ?? symbol,
                // Must match normalizeSnaptradeHoldings, or lots and the
                // snapshot land on two different instruments.
                sourceSecurityIdKind: figi ? "snaptrade_figi" : "snaptrade_symbol",
              }
            : {};
        const feeAmount = fee ? new Decimal(fee).abs().neg().toFixed() : undefined;
        const isTrade = type === "buy" || type === "sell";
        activities.push(
          normalizeInvestmentActivityEvidence({
            source: "snaptrade",
            sourceAccountRef,
            idempotencyKey: `${sourceAccountRef}:activity:${row.id}`,
            sourceActivityId: row.id,
            // Shared by the legs of one brokerage order (buy, fee, fx) — a
            // grouping key, not a unique one.
            sourceOrderId: row.external_reference_id?.trim() || undefined,
            ...security,
            activityType: type,
            tradeDate: row.trade_date.slice(0, 10),
            occurredAt: row.trade_date,
            settlementDate: row.settlement_date?.slice(0, 10) || undefined,
            quantity: units,
            quantityUnit: units ? "shares" : undefined,
            price: isTrade ? nonZero(row.price) : undefined,
            grossAmount:
              isTrade && amount !== undefined
                ? new Decimal(amount).minus(feeAmount ?? "0").toFixed()
                : type === "dividend"
                  ? amount
                  : undefined,
            feeAmount: type === "fee" ? amount : feeAmount,
            taxAmount: type === "tax" ? amount : undefined,
            netCashAmount: amount,
            currency: row.currency?.code,
            rawType: row.type,
            rawDescription: row.description?.trim() || undefined,
            provenance: "broker_reported",
          }),
        );
      }
    }
    return { activities, openLots: [], dividendAccruals: [], corporateActions: [] };
  } catch (error) {
    throw code(error);
  }
}
