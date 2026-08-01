import { createHmac } from "node:crypto";

import { z } from "zod";

import { decimalText } from "./decimal";
import { asOf, checked, code, currencySchema, nonblankSchema, requireLimit } from "./shared";
import { InvestmentNormalizationError, type InvestmentSyncEnvelope } from "./types";
import { readBoundedResponse, WorkerSourceError, type FetchAdapter } from "./workers";

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
): Promise<unknown> {
  const query = `clientId=${encodeURIComponent(clientId)}&timestamp=${Math.round(Date.now() / 1000)}`;
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

export type SnaptradeAccountPayload = {
  account: z.infer<typeof accountSchema>;
  balances: z.infer<typeof balancesSchema>;
  positions: z.infer<typeof positionsSchema>;
};

/** One authenticated pass over every account the personal key can see. */
export async function fetchSnaptradeHoldings(
  clientId: Buffer,
  consumerKey: Buffer,
  fetcher: FetchAdapter,
): Promise<SnaptradeAccountPayload[]> {
  try {
    const id = clientId.toString("utf8");
    const accounts = checked(
      z.array(accountSchema),
      await get(ACCOUNTS_PATH, id, consumerKey, fetcher),
    );
    requireLimit(accounts.length, 100);
    if (!accounts.length) throw new InvestmentNormalizationError("incomplete_coverage");
    const payloads: SnaptradeAccountPayload[] = [];
    for (const account of accounts) {
      const base = `${ACCOUNTS_PATH}/${encodeURIComponent(account.id)}`;
      payloads.push({
        account,
        balances: checked(balancesSchema, await get(`${base}/balances`, id, consumerKey, fetcher)),
        positions: checked(
          positionsSchema,
          await get(`${base}/positions/all`, id, consumerKey, fetcher),
        ),
      });
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
        sourceAccountRef: account.institution_account_id ?? account.id,
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
