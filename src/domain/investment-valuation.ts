import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, lte } from "drizzle-orm";
import type { UserTransaction } from "@/db/client";
import {
  accounts,
  fxRates,
  instrumentSourceMappings,
  instruments,
  investmentMarketQuotes,
  investmentSnapshotCashBalances,
  investmentSnapshotDetails,
  investmentSnapshotPositions,
} from "@/db/schema";
import { decText, encText } from "./fields";

export type ValuationBasis = "broker_source" | "tiingo_estimate" | "mixed";
export type ValuationFreshness = "current" | "stale" | "mixed_age";
export type ValuationQualityFlag =
  "carried_forward" | "quote_fallback" | "reconciliation_mismatch" | "incomplete_fx";

export interface ValuationMetadata {
  basis: ValuationBasis;
  freshness: ValuationFreshness;
  sourceAsOf: string | null;
  quoteAsOf: string | null;
  fxAsOf: string | null;
  oldestComponentDate: string | null;
  affectedComponentCount: number;
  qualityFlags: ValuationQualityFlag[];
}

export interface InvestmentValuation {
  ilsValue: string;
  nativeValue: string | null;
  currency: string | null;
  metadata: ValuationMetadata;
}

/** Shared internal quote-or-broker decision; it is deliberately pure and has no I/O. */
export function selectCurrentComponent(input: {
  estimateNow: boolean;
  now: Date;
  kind: string | undefined;
  positionCurrency: string;
  mappingCurrency: string | undefined;
  exchange: string | null;
  quantity: string;
  brokerValue: string;
  brokerCurrency: string;
  brokerDate: Date;
  quote?: {
    price: string;
    currency: string;
    sourceDate: string;
    qualityState: string;
    splitState: string;
  };
}): {
  value: string;
  currency: string;
  date: Date;
  basis: "broker_source" | "tiingo_estimate";
  quoteDate: string | null;
  fallback: boolean;
} {
  const quote = input.quote;
  const quoteDate = quote ? new Date(`${quote.sourceDate}T00:00:00Z`) : null;
  const eligible =
    input.estimateNow &&
    (input.kind === "stock" || input.kind === "etf") &&
    input.positionCurrency === "USD" &&
    input.mappingCurrency === "USD" &&
    (input.exchange === "NYSE" || input.exchange === "NASDAQ") &&
    quote?.currency === "USD" &&
    quote.qualityState === "accepted" &&
    (quote.splitState === "safe" ||
      (quote.splitState === "post_split" && quoteDate! <= input.brokerDate)) &&
    quoteDate &&
    withinSevenDays(quote.sourceDate, input.now) &&
    input.brokerDate.getTime() <= quoteDate.getTime() + DAY;
  if (eligible && quote && quoteDate)
    return {
      value: new Decimal(input.quantity).mul(quote.price).toFixed(),
      currency: "USD",
      date: quoteDate,
      basis: "tiingo_estimate",
      quoteDate: quote.sourceDate,
      fallback: false,
    };
  return {
    value: input.brokerValue,
    currency: input.brokerCurrency,
    date: input.brokerDate,
    basis: "broker_source",
    quoteDate: null,
    fallback: input.estimateNow,
  };
}

type Tx = UserTransaction;
const DAY = 86_400_000;

function israelDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateAtMidnight(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function currentBrokerWeek(now: Date, source: Date): boolean {
  const current = dateAtMidnight(israelDate(now));
  const observed = dateAtMidnight(israelDate(source));
  const currentSunday = new Date(current.getTime() - current.getUTCDay() * DAY);
  return observed.getTime() >= currentSunday.getTime() - 7 * DAY;
}

function withinSevenDays(date: string, now: Date): boolean {
  const age = (dateAtMidnight(israelDate(now)).getTime() - dateAtMidnight(date).getTime()) / DAY;
  return age >= 0 && age <= 7;
}

async function fx(
  tx: Tx,
  currency: string,
  asOf: Date,
): Promise<{ rate: Decimal; date: string } | null> {
  if (currency === "ILS") return { rate: new Decimal(1), date: israelDate(asOf) };
  const target = israelDate(asOf);
  const [row] = await tx
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.fromCurrency, currency),
        eq(fxRates.toCurrency, "ILS"),
        lte(fxRates.date, target),
      ),
    )
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (!row || row.source !== "boi" || !withinSevenDays(row.date, asOf)) return null;
  return { rate: new Decimal(row.rate), date: row.date };
}

function emptyMetadata(): ValuationMetadata {
  return {
    basis: "broker_source",
    freshness: "current",
    sourceAsOf: null,
    quoteAsOf: null,
    fxAsOf: null,
    oldestComponentDate: null,
    affectedComponentCount: 0,
    qualityFlags: [],
  };
}

/**
 * Internal, RLS-scoped valuation seam. It deliberately receives a transaction
 * and never imports a provider adapter or fetch implementation.
 */
export async function valueInvestmentSnapshot(
  tx: Tx,
  dataKey: Uint8Array,
  snapshotId: string,
  options: { estimateNow?: boolean; now?: Date } = {},
): Promise<InvestmentValuation> {
  const now = options.now ?? new Date();
  const [detail] = await tx
    .select()
    .from(investmentSnapshotDetails)
    .where(eq(investmentSnapshotDetails.id, snapshotId))
    .limit(1);
  if (!detail) throw new Error("investment snapshot not found");
  const [positions, cash, quoteRows, mappingRows] = await Promise.all([
    tx
      .select()
      .from(investmentSnapshotPositions)
      .where(eq(investmentSnapshotPositions.snapshotId, detail.id)),
    tx
      .select()
      .from(investmentSnapshotCashBalances)
      .where(eq(investmentSnapshotCashBalances.snapshotId, detail.id)),
    tx.select().from(investmentMarketQuotes),
    tx.select().from(instrumentSourceMappings),
  ]);
  const quoteByInstrument = new Map(
    quoteRows.filter((row) => row.provider === "tiingo").map((row) => [row.instrumentId, row]),
  );
  const mappingsByInstrument = new Map<string, (typeof mappingRows)[number]>();
  for (const mapping of mappingRows)
    if (!mappingsByInstrument.has(mapping.instrumentId))
      mappingsByInstrument.set(mapping.instrumentId, mapping);
  const instrumentRows = await tx.select().from(instruments);
  const instrumentsById = new Map(instrumentRows.map((row) => [row.id, row]));
  let ils = new Decimal(0);
  const nativeByCurrency = new Map<string, Decimal>();
  let anyTiingo = false;
  let anyBroker = false;
  let fallback = 0;
  let incompleteFx = 0;
  const sourceDates: string[] = [];
  const quoteDates: string[] = [];
  const fxDates: string[] = [];
  const qualities = new Set<ValuationQualityFlag>();
  if (detail.reconciliationState === "mismatch") qualities.add("reconciliation_mismatch");

  for (const position of positions) {
    const quantity = decText(
      dataKey,
      position.quantityCt,
      position.id,
      "quantity_ct",
      position.version,
    )!;
    const sourceValue = decText(
      dataKey,
      position.sourceValueCt,
      position.id,
      "source_value_ct",
      position.version,
    );
    const sourcePrice = decText(
      dataKey,
      position.sourcePriceCt,
      position.id,
      "source_price_ct",
      position.version,
    );
    const sourceDate = position.sourceAsOf ?? detail.sourceAsOf;
    const sourceCurrency =
      position.sourceValueCurrency ?? position.sourcePriceCurrency ?? position.currency;
    let value =
      sourceValue ?? (sourcePrice ? new Decimal(quantity).mul(sourcePrice).toFixed() : "0");
    const quote = quoteByInstrument.get(position.instrumentId);
    const mapping = mappingsByInstrument.get(position.instrumentId);
    const instrument = instrumentsById.get(position.instrumentId);
    const exchange = mapping?.exchangeCt
      ? (decText(
          dataKey,
          mapping.exchangeCt,
          mapping.id,
          "exchange_ct",
          mapping.version,
        )?.toUpperCase() ?? null)
      : null;
    const selected = selectCurrentComponent({
      estimateNow: !!options.estimateNow,
      now,
      kind: instrument?.kind,
      positionCurrency: position.currency,
      mappingCurrency: mapping?.currency,
      exchange,
      quantity,
      brokerValue: value,
      brokerCurrency: sourceCurrency,
      brokerDate: sourceDate,
      quote: quote
        ? {
            price: decText(dataKey, quote.priceCt, quote.id, "price_ct", quote.version)!,
            currency: quote.currency,
            sourceDate: quote.sourceDate,
            qualityState: quote.qualityState,
            splitState: quote.splitState,
          }
        : undefined,
    });
    value = selected.value;
    const currency = selected.currency;
    const usedTiingo = selected.basis === "tiingo_estimate";
    if (usedTiingo) {
      quoteDates.push(selected.quoteDate!);
      anyTiingo = true;
    } else if (selected.fallback) {
      fallback += 1;
      qualities.add("quote_fallback");
    }
    if (!usedTiingo) anyBroker = true;
    nativeByCurrency.set(currency, (nativeByCurrency.get(currency) ?? new Decimal(0)).plus(value));
    const rate = await fx(tx, currency, selected.date);
    if (!rate) {
      incompleteFx += 1;
      qualities.add("incomplete_fx");
      continue;
    }
    ils = ils.plus(new Decimal(value).mul(rate.rate));
    sourceDates.push(israelDate(sourceDate));
    fxDates.push(rate.date);
  }
  for (const row of cash) {
    const amount = decText(dataKey, row.amountCt, row.id, "amount_ct", row.version)!;
    nativeByCurrency.set(
      row.currency,
      (nativeByCurrency.get(row.currency) ?? new Decimal(0)).plus(amount),
    );
    const rate = await fx(tx, row.currency, detail.sourceAsOf);
    if (!rate) {
      incompleteFx += 1;
      qualities.add("incomplete_fx");
      continue;
    }
    ils = ils.plus(new Decimal(amount).mul(rate.rate));
    sourceDates.push(israelDate(detail.sourceAsOf));
    fxDates.push(rate.date);
  }
  const allDates = [...sourceDates, ...quoteDates, ...fxDates].sort();
  const sourceAsOf = sourceDates.sort().at(-1) ?? null;
  const quoteAsOf = quoteDates.sort().at(-1) ?? null;
  const fxAsOf = fxDates.sort().at(-1) ?? null;
  const native = nativeByCurrency.size === 1 ? [...nativeByCurrency.entries()][0] : null;
  return {
    ilsValue: ils.toFixed(),
    nativeValue: native?.[1].toFixed() ?? null,
    currency: native?.[0] ?? null,
    metadata: {
      basis: anyTiingo ? (anyBroker ? "mixed" : "tiingo_estimate") : "broker_source",
      freshness: currentBrokerWeek(now, detail.sourceAsOf)
        ? quoteDates.length && sourceDates.length && sourceAsOf !== quoteAsOf
          ? "mixed_age"
          : "current"
        : "stale",
      sourceAsOf,
      quoteAsOf,
      fxAsOf,
      oldestComponentDate: allDates[0] ?? null,
      affectedComponentCount:
        fallback + incompleteFx + (detail.reconciliationState === "mismatch" ? 1 : 0),
      qualityFlags: [...qualities].sort(),
    },
  };
}

/** Internal worker seam: target discovery is RLS-scoped and never performs network I/O. */
export async function listTiingoQuoteTargets(
  tx: Tx,
  dataKey: Uint8Array,
): Promise<TiingoQuoteTarget[]> {
  const [details, accountRows, positions, mappingRows, instrumentRows] = await Promise.all([
    tx.select().from(investmentSnapshotDetails),
    tx.select().from(accounts),
    tx.select().from(investmentSnapshotPositions),
    tx.select().from(instrumentSourceMappings),
    tx.select().from(instruments),
  ]);
  const active = new Set(
    accountRows
      .filter((row) => row.archivedAt === null && row.status === "active")
      .map((row) => row.id),
  );
  const latest = new Map<string, (typeof details)[number]>();
  for (const detail of details)
    if (
      active.has(detail.accountId) &&
      (!latest.get(detail.accountId) ||
        latest.get(detail.accountId)!.sourceAsOf < detail.sourceAsOf)
    )
      latest.set(detail.accountId, detail);
  const snapshots = new Set([...latest.values()].map((detail) => detail.id));
  const instrumentById = new Map(instrumentRows.map((row) => [row.id, row]));
  const result = new Map<string, TiingoQuoteTarget>();
  for (const position of [...positions].sort((a, b) =>
    a.instrumentId.localeCompare(b.instrumentId),
  )) {
    if (!snapshots.has(position.snapshotId) || position.currency !== "USD") continue;
    const instrument = instrumentById.get(position.instrumentId);
    if (!instrument || (instrument.kind !== "stock" && instrument.kind !== "etf")) continue;
    const mapping = mappingRows
      .filter(
        (row) =>
          row.instrumentId === position.instrumentId &&
          row.provider !== "tiingo" &&
          row.currency === "USD" &&
          row.providerSymbolCt &&
          row.exchangeCt,
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!mapping) continue;
    const exchange = decText(
      dataKey,
      mapping.exchangeCt,
      mapping.id,
      "exchange_ct",
      mapping.version,
    )?.toUpperCase();
    const symbol = decText(
      dataKey,
      mapping.providerSymbolCt,
      mapping.id,
      "provider_symbol_ct",
      mapping.version,
    );
    if ((exchange !== "NYSE" && exchange !== "NASDAQ") || !symbol) continue;
    if (!result.has(instrument.id))
      result.set(instrument.id, { instrumentId: instrument.id, mappingId: mapping.id, symbol });
  }
  return [...result.values()];
}

/** The only Tiingo quote write path. One current quote replaces the prior provider quote. */
export async function replaceTiingoQuote(
  tx: Tx,
  dataKey: Uint8Array,
  input: TiingoQuoteTarget & {
    price: string;
    sourceDate: string;
    fetchedAt: Date;
    splitState: "safe" | "post_split" | "unknown";
    qualityState: "accepted" | "stale";
  },
): Promise<void> {
  const [sourceMapping] = await tx
    .select()
    .from(instrumentSourceMappings)
    .where(eq(instrumentSourceMappings.id, input.mappingId))
    .limit(1);
  const [instrument] = await tx
    .select()
    .from(instruments)
    .where(eq(instruments.id, input.instrumentId))
    .limit(1);
  if (
    !sourceMapping ||
    !instrument ||
    sourceMapping.instrumentId !== input.instrumentId ||
    sourceMapping.ownerId !== instrument.ownerId ||
    sourceMapping.currency !== "USD" ||
    sourceMapping.provider === "tiingo"
  )
    throw new Error("Tiingo source mapping not found");
  let [tiingoMapping] = await tx
    .select()
    .from(instrumentSourceMappings)
    .where(
      and(
        eq(instrumentSourceMappings.instrumentId, input.instrumentId),
        eq(instrumentSourceMappings.provider, "tiingo"),
      ),
    )
    .limit(1);
  if (!tiingoMapping) {
    const id = randomUUID();
    const exchange = sourceMapping.exchangeCt
      ? decText(
          dataKey,
          sourceMapping.exchangeCt,
          sourceMapping.id,
          "exchange_ct",
          sourceMapping.version,
        )
      : null;
    await tx.insert(instrumentSourceMappings).values({
      id,
      ownerId: sourceMapping.ownerId,
      instrumentId: input.instrumentId,
      provider: "tiingo",
      identifierKind: "tiingo_symbol",
      providerIdentifierCt: encText(dataKey, input.symbol, id, "provider_identifier_ct", 1),
      providerSymbolCt: encText(dataKey, input.symbol, id, "provider_symbol_ct", 1),
      providerNameCt: null,
      exchangeCt: exchange ? encText(dataKey, exchange, id, "exchange_ct", 1) : null,
      currency: "USD",
      version: 1,
    });
    [tiingoMapping] = await tx
      .select()
      .from(instrumentSourceMappings)
      .where(eq(instrumentSourceMappings.id, id))
      .limit(1);
  }
  const [existing] = await tx
    .select()
    .from(investmentMarketQuotes)
    .where(
      and(
        eq(investmentMarketQuotes.instrumentId, input.instrumentId),
        eq(investmentMarketQuotes.provider, "tiingo"),
      ),
    )
    .limit(1);
  const id = existing?.id ?? randomUUID();
  const values = {
    instrumentSourceMappingId: tiingoMapping!.id,
    providerSymbolCt: encText(dataKey, input.symbol, id, "provider_symbol_ct", 1),
    priceCt: encText(dataKey, input.price, id, "price_ct", 1),
    currency: "USD",
    sourceDate: input.sourceDate,
    fetchedAt: input.fetchedAt,
    splitState: input.splitState,
    qualityState: input.qualityState,
  };
  if (existing)
    await tx.update(investmentMarketQuotes).set(values).where(eq(investmentMarketQuotes.id, id));
  else
    await tx.insert(investmentMarketQuotes).values({
      id,
      ownerId: (
        await tx
          .select({ ownerId: instruments.ownerId })
          .from(instruments)
          .where(eq(instruments.id, input.instrumentId))
          .limit(1)
      )[0]!.ownerId,
      instrumentId: input.instrumentId,
      provider: "tiingo",
      version: 1,
      ...values,
    });
}

export function tiingoWorkerConfiguration(
  env: { MONI_TIINGO_MULTI_USER_AUTHORIZED?: string; MONI_TIINGO_TOKEN?: string } = process.env as {
    MONI_TIINGO_MULTI_USER_AUTHORIZED?: string;
    MONI_TIINGO_TOKEN?: string;
  },
): Buffer | null {
  if (env.MONI_TIINGO_MULTI_USER_AUTHORIZED !== "true" || !env.MONI_TIINGO_TOKEN) return null;
  return Buffer.from(env.MONI_TIINGO_TOKEN, "utf8");
}

export interface TiingoQuoteTarget {
  instrumentId: string;
  mappingId: string;
  symbol: string;
}

export { emptyMetadata };
