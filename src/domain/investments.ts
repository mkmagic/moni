import { createHmac, timingSafeEqual } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, lte } from "drizzle-orm";
import { withUser, type UserTransaction } from "@/db/client";
import {
  accounts,
  connections,
  fxRates,
  instruments,
  investmentMarketQuotes,
  instrumentSourceMappings,
  investmentSnapshotCashBalances,
  investmentSnapshotDetails,
  investmentSnapshotPositions,
} from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import { institutionDisplayName } from "@/lib/connectors";
import { decText } from "./fields";
import {
  selectCurrentComponent,
  valueInvestmentSnapshot,
  type InvestmentValuation,
  type ValuationMetadata,
} from "./investment-valuation";

type Tx = UserTransaction;
type RowKind = "position" | "cash";

export interface PortfolioFilters {
  connectionId?: string;
  accountId?: string;
  instrumentKind?: "stock" | "etf" | "mutual_fund" | "generic";
  kind?: RowKind;
  freshness?: ValuationMetadata["freshness"];
  basis?: ValuationMetadata["basis"];
  limit?: number;
  cursor?: string;
}

export interface PortfolioPage {
  rows: PortfolioHolding[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PortfolioHolding {
  id: string;
  kind: RowKind;
  accountId: string;
  connectionId: string;
  instrumentId: string | null;
  instrumentKind: "stock" | "etf" | "mutual_fund" | "generic" | null;
  /** The ticker when the instrument resolved to one; drives the display label. */
  symbol: string | null;
  /** The instrument's long name, shown as secondary detail beside the symbol. */
  name: string | null;
  label: string;
  currency: string;
  quantity: string | null;
  price: string | null;
  nativeValue: string;
  ilsValue: string;
  sourceAsOf: string;
  fxAsOf: string | null;
  basis: ValuationMetadata["basis"];
  freshness: ValuationMetadata["freshness"];
  allocationPercentage: string;
  qualityReasons: ValuationMetadata["qualityFlags"];
}

export interface PortfolioOverview {
  valuationRevision: string;
  ilsValue: string;
  cashIlsValue: string;
  cashByCurrency: Array<{ currency: string; nativeValue: string; ilsValue: string }>;
  allocation: Array<{ id: string; label: string; ilsValue: string; percentage: string }>;
  connections: Array<{
    id: string;
    name: string | null;
    mode: "credentialed_fetch" | "user_mediated_import";
    accountCount: number;
    positionCount: number;
    cashCount: number;
    ilsValue: string;
    freshness: ValuationMetadata["freshness"];
  }>;
  accounts: Array<{
    id: string;
    name: string;
    connectionId: string;
    ilsValue: string;
    metadata: ValuationMetadata;
  }>;
  metadata: ValuationMetadata;
}

export interface PortfolioHistoryRange {
  start?: string;
  end?: string;
  from?: string;
  to?: string;
}
export type PortfolioHistoryGroupBy = "holding" | "account";
export interface PortfolioHistory {
  points: Array<{
    week: string;
    ilsValue: string;
    composition: Array<{ id: string; label: string; ilsValue: string }>;
  }>;
  valuationChange: {
    label: "Valuation change";
    disclosure: "Includes deposits and withdrawals";
    amount: string;
    percentage: string;
  } | null;
  estimatedNow: { ilsValue: string; metadata: ValuationMetadata } | null;
}

export interface PortfolioSnapshotPage extends PortfolioPage {
  week: string;
  valuationRevision: string;
}

type Structural = {
  details: (typeof investmentSnapshotDetails.$inferSelect)[];
  accounts: (typeof accounts.$inferSelect)[];
  connections: (typeof connections.$inferSelect)[];
  positions: (typeof investmentSnapshotPositions.$inferSelect)[];
  cash: (typeof investmentSnapshotCashBalances.$inferSelect)[];
  instruments: (typeof instruments.$inferSelect)[];
  quotes: (typeof investmentMarketQuotes.$inferSelect)[];
  mappings: (typeof instrumentSourceMappings.$inferSelect)[];
  fx: (typeof fxRates.$inferSelect)[];
};

function datePart(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function sunday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return datePart(d);
}
function iso(value: Date): string {
  return value.toISOString();
}
function limitOf(value: number | undefined): number {
  return Math.min(Math.max(value ?? 50, 1), 200);
}
function canonicalFilters(filters: PortfolioFilters): string {
  const rest = { ...filters };
  delete rest.cursor;
  delete rest.limit;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(rest)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
function sign(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}
function encodeCursor(key: Uint8Array, revision: string, filters: string, lastId: string): string {
  const value = Buffer.from(JSON.stringify({ revision, filters, lastId })).toString("base64url");
  return `${value}.${sign(key, value)}`;
}
function decodeCursor(key: Uint8Array, cursor: string, revision: string, filters: string): string {
  const [value, mac, ...extra] = cursor.split(".");
  const expected = value ? Buffer.from(sign(key, value)) : null;
  if (
    !value ||
    !mac ||
    extra.length ||
    !expected ||
    expected.length !== Buffer.byteLength(mac) ||
    !timingSafeEqual(expected, Buffer.from(mac))
  )
    throw new Error("invalid portfolio cursor");
  let parsed: { revision: string; filters: string; lastId: string };
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid portfolio cursor");
  }
  if (
    parsed.revision !== revision ||
    parsed.filters !== filters ||
    typeof parsed.lastId !== "string"
  )
    throw new Error("invalid portfolio cursor");
  return parsed.lastId;
}

async function structural(tx: Tx): Promise<Structural> {
  // A withUser transaction owns one pg client. Keep its queries sequential;
  // pg@8 only tolerated overlapping client.query calls and pg@9 removes them.
  const details = await tx.select().from(investmentSnapshotDetails);
  const accountRows = await tx.select().from(accounts);
  const connectionRows = await tx.select().from(connections);
  const positions = await tx.select().from(investmentSnapshotPositions);
  const cash = await tx.select().from(investmentSnapshotCashBalances);
  const instrumentRows = await tx.select().from(instruments);
  const quotes = await tx.select().from(investmentMarketQuotes);
  const mappings = await tx.select().from(instrumentSourceMappings);
  const fx = await tx.select().from(fxRates);
  return {
    details,
    accounts: accountRows,
    connections: connectionRows,
    positions,
    cash,
    instruments: instrumentRows,
    quotes,
    mappings,
    fx,
  };
}
function revision(rows: Structural): string {
  return createHmac("sha256", "portfolio-revision")
    .update(
      [...rows.details, ...rows.quotes, ...rows.accounts, ...rows.fx]
        .map((row) => `${row.id}:${iso(row.updatedAt)}`)
        .sort()
        .join("|"),
    )
    .digest("hex");
}
function latestByAccount(
  rows: Structural,
  now = new Date(),
): Map<string, Structural["details"][number]> {
  const result = new Map<string, Structural["details"][number]>();
  for (const row of rows.details) {
    const account = rows.accounts.find((candidate) => candidate.id === row.accountId);
    if (
      !account ||
      account.status !== "active" ||
      (account.archivedAt && account.archivedAt <= now)
    )
      continue;
    const present = result.get(row.accountId);
    if (!present || present.sourceAsOf < row.sourceAsOf) result.set(row.accountId, row);
  }
  return result;
}
async function rate(
  tx: Tx,
  currency: string,
  at: Date,
): Promise<{ rate: Decimal; date: string } | null> {
  if (currency === "ILS") return { rate: new Decimal(1), date: datePart(at) };
  const [row] = await tx
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.fromCurrency, currency),
        eq(fxRates.toCurrency, "ILS"),
        lte(fxRates.date, datePart(at)),
      ),
    )
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (
    !row ||
    row.source !== "boi" ||
    (new Date(`${datePart(at)}T00:00:00Z`).getTime() -
      new Date(`${row.date}T00:00:00Z`).getTime()) /
      86_400_000 >
      7
  )
    return null;
  return { rate: new Decimal(row.rate), date: row.date };
}
function freshness(source: Date, now = new Date()): ValuationMetadata["freshness"] {
  const today = new Date(`${datePart(now)}T00:00:00Z`);
  const current = new Date(today);
  current.setUTCDate(today.getUTCDate() - today.getUTCDay());
  return source >= new Date(current.getTime() - 7 * 86_400_000) ? "current" : "stale";
}
async function rowsForSnapshot(
  tx: Tx,
  key: Uint8Array,
  all: Structural,
  detail: Structural["details"][number],
  carried = false,
  estimateNow = false,
): Promise<PortfolioHolding[]> {
  const instrumentById = new Map(all.instruments.map((row) => [row.id, row]));
  const quality: ValuationMetadata["qualityFlags"] = [
    ...(detail.reconciliationState === "mismatch" ? ["reconciliation_mismatch" as const] : []),
    ...(carried ? ["carried_forward" as const] : []),
  ];
  const common = {
    accountId: detail.accountId,
    connectionId: detail.connectionId,
    sourceAsOf: datePart(detail.sourceAsOf),
    basis: "broker_source" as const,
    freshness: carried ? ("stale" as const) : freshness(detail.sourceAsOf),
    qualityReasons: quality,
    allocationPercentage: "0",
  };
  const positions = all.positions.filter((row) => row.snapshotId === detail.id);
  const cash = all.cash.filter((row) => row.snapshotId === detail.id);
  const result: PortfolioHolding[] = [];
  for (const row of positions) {
    let value =
      decText(key, row.sourceValueCt, row.id, "source_value_ct", row.version) ??
      new Decimal(decText(key, row.quantityCt, row.id, "quantity_ct", row.version)!)
        .mul(decText(key, row.sourcePriceCt, row.id, "source_price_ct", row.version) ?? "0")
        .toFixed();
    const sourceCurrency = row.sourceValueCurrency ?? row.sourcePriceCurrency ?? row.currency;
    const sourceDate = row.sourceAsOf ?? detail.sourceAsOf;
    const instrument = instrumentById.get(row.instrumentId);
    const symbol =
      decText(
        key,
        instrument?.canonicalSymbolCt,
        instrument?.id ?? row.id,
        "canonical_symbol_ct",
        instrument?.version ?? 1,
      ) ?? null;
    const name =
      decText(
        key,
        instrument?.canonicalNameCt,
        instrument?.id ?? row.id,
        "canonical_name_ct",
        instrument?.version ?? 1,
      ) ?? null;
    const quote = all.quotes.find(
      (candidate) => candidate.instrumentId === row.instrumentId && candidate.provider === "tiingo",
    );
    const mapping = all.mappings.find((candidate) => candidate.instrumentId === row.instrumentId);
    const exchange = mapping?.exchangeCt
      ? (decText(
          key,
          mapping.exchangeCt,
          mapping.id,
          "exchange_ct",
          mapping.version,
        )?.toUpperCase() ?? null)
      : null;
    const quotePrice = quote
      ? decText(key, quote.priceCt, quote.id, "price_ct", quote.version)!
      : null;
    const selected = selectCurrentComponent({
      estimateNow,
      now: new Date(),
      kind: instrument?.kind,
      positionCurrency: row.currency,
      mappingCurrency: mapping?.currency,
      exchange,
      quantity: decText(key, row.quantityCt, row.id, "quantity_ct", row.version)!,
      brokerValue: value,
      brokerCurrency: sourceCurrency,
      brokerDate: sourceDate,
      quote: quote
        ? {
            price: quotePrice!,
            currency: quote.currency,
            sourceDate: quote.sourceDate,
            qualityState: quote.qualityState,
            splitState: quote.splitState,
          }
        : undefined,
    });
    value = selected.value;
    const fx = await rate(tx, selected.currency, selected.date);
    result.push({
      id: row.id,
      kind: "position",
      instrumentId: row.instrumentId,
      instrumentKind: instrument?.kind ?? null,
      symbol,
      name,
      // The ticker is what identifies a holding at a glance; the long name is
      // secondary detail, so it only stands in when there is no symbol.
      label: symbol ?? name ?? "Unresolved instrument",
      currency: selected.currency,
      quantity: decText(key, row.quantityCt, row.id, "quantity_ct", row.version),
      price:
        selected.basis === "tiingo_estimate"
          ? quotePrice
          : decText(key, row.sourcePriceCt, row.id, "source_price_ct", row.version),
      nativeValue: value,
      ilsValue: fx ? new Decimal(value).mul(fx.rate).toFixed() : "0",
      fxAsOf: fx?.date ?? null,
      ...common,
      basis: selected.basis,
      sourceAsOf: datePart(selected.date),
      qualityReasons: fx
        ? [...quality, ...(selected.fallback ? ["quote_fallback" as const] : [])]
        : [...quality, ...(selected.fallback ? ["quote_fallback" as const] : []), "incomplete_fx"],
    });
  }
  for (const row of cash) {
    const value = decText(key, row.amountCt, row.id, "amount_ct", row.version)!;
    const fx = await rate(tx, row.currency, detail.sourceAsOf);
    result.push({
      id: row.id,
      kind: "cash",
      instrumentId: null,
      instrumentKind: null,
      symbol: null,
      name: null,
      label: `Cash (${row.currency})`,
      currency: row.currency,
      quantity: null,
      price: null,
      nativeValue: value,
      ilsValue: fx ? new Decimal(value).mul(fx.rate).toFixed() : "0",
      fxAsOf: fx?.date ?? null,
      ...common,
      qualityReasons: fx ? quality : [...quality, "incomplete_fx"],
    });
  }
  return result;
}
function allocation(rows: PortfolioHolding[]): PortfolioHolding[] {
  const total = rows.reduce((sum, row) => sum.plus(row.ilsValue), new Decimal(0));
  return rows.map((row) => ({
    ...row,
    allocationPercentage: total.isZero()
      ? "0"
      : new Decimal(row.ilsValue).div(total).mul(100).toFixed(),
  }));
}
function applies(row: PortfolioHolding, filters: PortfolioFilters): boolean {
  return (
    (!filters.connectionId || row.connectionId === filters.connectionId) &&
    (!filters.accountId || row.accountId === filters.accountId) &&
    (!filters.instrumentKind || row.instrumentKind === filters.instrumentKind) &&
    (!filters.kind || row.kind === filters.kind) &&
    (!filters.freshness || row.freshness === filters.freshness) &&
    (!filters.basis || row.basis === filters.basis)
  );
}
function page(
  key: Uint8Array,
  rows: PortfolioHolding[],
  filters: PortfolioFilters,
  rev: string,
): PortfolioPage {
  const sorted = rows.sort(
    (a, b) => new Decimal(b.ilsValue).cmp(a.ilsValue) || a.id.localeCompare(b.id),
  );
  const normalized = canonicalFilters(filters);
  const after = filters.cursor ? decodeCursor(key, filters.cursor, rev, normalized) : null;
  const start = after ? sorted.findIndex((row) => row.id === after) : -1;
  if (after && start < 0) throw new Error("invalid portfolio cursor");
  const selected = sorted.slice(start + 1, start + 1 + limitOf(filters.limit));
  const hasMore = start + 1 + selected.length < sorted.length;
  return {
    rows: selected,
    hasMore,
    nextCursor: hasMore ? encodeCursor(key, rev, normalized, selected.at(-1)!.id) : null,
  };
}

/**
 * Current ILS value of each investment account, keyed by account id.
 *
 * The Accounts page needs a number per card and nothing else, so this is
 * deliberately narrower than getPortfolioOverview: an investment account has no
 * `current_balance_ct` to read (its worth is derived from holdings), which is
 * why those cards used to say "Balance unavailable".
 */
export async function listInvestmentAccountValues(session: Session): Promise<Map<string, string>> {
  return withUser(session.userId, async (tx) => {
    const all = await structural(tx);
    const result = new Map<string, string>();
    for (const detail of latestByAccount(all).values()) {
      const value = await valueInvestmentSnapshot(tx, session.dataKey, detail.id, {
        estimateNow: true,
      });
      result.set(detail.accountId, value.ilsValue);
    }
    return result;
  });
}

export async function getPortfolioOverview(session: Session): Promise<PortfolioOverview> {
  return withUser(session.userId, async (tx) => {
    const all = await structural(tx);
    const active = latestByAccount(all);
    const values: Array<{
      detail: Structural["details"][number];
      value: InvestmentValuation;
    }> = [];
    const currentRows: PortfolioHolding[] = [];
    for (const detail of active.values()) {
      values.push({
        detail,
        value: await valueInvestmentSnapshot(tx, session.dataKey, detail.id, {
          estimateNow: true,
        }),
      });
      currentRows.push(...(await rowsForSnapshot(tx, session.dataKey, all, detail, false, true)));
    }
    const total = currentRows.reduce((sum, row) => sum.plus(row.ilsValue), new Decimal(0));
    const cashRows = currentRows.filter((row) => row.kind === "cash");
    const allocationRows = allocation(currentRows.filter((row) => row.kind === "position"));
    const allocations = new Map<string, { id: string; label: string; ilsValue: Decimal }>();
    for (const row of allocationRows) {
      const current = allocations.get(row.instrumentId!) ?? {
        id: row.instrumentId!,
        label: row.label,
        ilsValue: new Decimal(0),
      };
      current.ilsValue = current.ilsValue.plus(row.ilsValue);
      allocations.set(row.instrumentId!, current);
    }
    const accountById = new Map(all.accounts.map((row) => [row.id, row]));
    const connectionById = new Map(all.connections.map((row) => [row.id, row]));
    const accountViews = values.map(({ detail, value }) => ({
      id: detail.accountId,
      name:
        decText(
          session.dataKey,
          accountById.get(detail.accountId)!.nameCt,
          detail.accountId,
          "name_ct",
          accountById.get(detail.accountId)!.version,
        ) ?? "",
      connectionId: detail.connectionId,
      ilsValue: value.ilsValue,
      metadata: value.metadata,
    }));
    const connectionViews = [...new Set(accountViews.map((row) => row.connectionId))].map((id) => {
      const accountRows = accountViews.filter((row) => row.connectionId === id);
      const holdings = currentRows.filter((row) => row.connectionId === id);
      // Name the card after the brokerage the money is actually at, not the
      // pipe it arrives through — but only when the connection reaches exactly
      // one. An aggregator spanning two brokerages has no single institution,
      // so it falls back to naming the connector.
      const institutions = [
        ...new Set(
          accountRows
            .map((row) =>
              institutionDisplayName(
                accountById.get(row.id)?.institution,
                connectionById.get(id)?.connectorId,
              ),
            )
            .filter((value): value is string => !!value),
        ),
      ];
      return {
        id,
        name:
          connectionById.get(id)?.displayName ??
          (institutions.length === 1 ? institutions[0] : null),
        mode: connectionById.get(id)!.mode,
        accountCount: accountRows.length,
        positionCount: holdings.filter((row) => row.kind === "position").length,
        cashCount: holdings.filter((row) => row.kind === "cash").length,
        ilsValue: holdings.reduce((sum, row) => sum.plus(row.ilsValue), new Decimal(0)).toFixed(),
        freshness: (accountRows.some((row) => row.metadata.freshness === "stale")
          ? "stale"
          : accountRows.some((row) => row.metadata.freshness === "mixed_age")
            ? "mixed_age"
            : "current") as ValuationMetadata["freshness"],
      };
    });
    const flags = new Set<ValuationMetadata["qualityFlags"][number]>();
    values.forEach(({ value }) => value.metadata.qualityFlags.forEach((flag) => flags.add(flag)));
    return {
      valuationRevision: revision(all),
      ilsValue: total.toFixed(),
      cashIlsValue: cashRows.reduce((sum, row) => sum.plus(row.ilsValue), new Decimal(0)).toFixed(),
      cashByCurrency: [...new Set(cashRows.map((row) => row.currency))].map((currency) => ({
        currency,
        nativeValue: cashRows
          .filter((row) => row.currency === currency)
          .reduce((sum, row) => sum.plus(row.nativeValue), new Decimal(0))
          .toFixed(),
        ilsValue: cashRows
          .filter((row) => row.currency === currency)
          .reduce((sum, row) => sum.plus(row.ilsValue), new Decimal(0))
          .toFixed(),
      })),
      allocation: [...allocations.values()].map((row) => ({
        id: row.id,
        label: row.label,
        ilsValue: row.ilsValue.toFixed(),
        percentage: total.isZero() ? "0" : row.ilsValue.div(total).mul(100).toFixed(),
      })),
      connections: connectionViews,
      accounts: accountViews,
      metadata: {
        basis: values.every(({ value }) => value.metadata.basis === "broker_source")
          ? "broker_source"
          : values.every(({ value }) => value.metadata.basis === "tiingo_estimate")
            ? "tiingo_estimate"
            : "mixed",
        freshness:
          values.some(({ value }) => value.metadata.freshness === "mixed_age") ||
          (values.some(({ value }) => value.metadata.freshness === "current") &&
            values.some(({ value }) => value.metadata.freshness === "stale"))
            ? "mixed_age"
            : values.some(({ value }) => value.metadata.freshness === "stale")
              ? "stale"
              : "current",
        sourceAsOf:
          values
            .map(({ value }) => value.metadata.sourceAsOf)
            .filter((value): value is string => value !== null)
            .sort()
            .at(-1) ?? null,
        quoteAsOf:
          values
            .map(({ value }) => value.metadata.quoteAsOf)
            .filter((value): value is string => value !== null)
            .sort()
            .at(-1) ?? null,
        fxAsOf:
          values
            .map(({ value }) => value.metadata.fxAsOf)
            .filter((value): value is string => value !== null)
            .sort()
            .at(-1) ?? null,
        oldestComponentDate:
          values
            .map(({ value }) => value.metadata.oldestComponentDate)
            .filter((value): value is string => value !== null)
            .sort()[0] ?? null,
        affectedComponentCount: values.reduce(
          (sum, { value }) => sum + value.metadata.affectedComponentCount,
          0,
        ),
        qualityFlags: [...flags].sort(),
      },
    };
  });
}

export async function listPortfolioHoldings(
  session: Session,
  filters: PortfolioFilters = {},
): Promise<PortfolioPage> {
  return withUser(session.userId, async (tx) => {
    const all = await structural(tx);
    const rows: PortfolioHolding[] = [];
    for (const detail of latestByAccount(all).values())
      rows.push(...(await rowsForSnapshot(tx, session.dataKey, all, detail, false, true)));
    return page(
      session.dataKey,
      allocation(rows.filter((row) => applies(row, filters))),
      filters,
      revision(all),
    );
  });
}

export async function getPortfolioHistory(
  session: Session,
  range: PortfolioHistoryRange,
  groupBy: PortfolioHistoryGroupBy,
): Promise<PortfolioHistory> {
  return withUser(session.userId, async (tx) => {
    const all = await structural(tx);
    const from = sunday(
      range.start ?? range.from ?? datePart(new Date(Date.now() - 12 * 7 * 86_400_000)),
    );
    const to = sunday(range.end ?? range.to ?? datePart(new Date()));
    const weeks: string[] = [];
    for (
      let day = new Date(`${from}T00:00:00Z`);
      datePart(day) <= to;
      day.setUTCDate(day.getUTCDate() + 7)
    )
      weeks.push(datePart(day));
    const investmentAccounts = all.accounts.filter(
      (account) => account.accountType === "investment",
    );
    const points = [];
    for (const week of weeks) {
      const weekEnd = new Date(`${week}T00:00:00Z`);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      const used: Array<{ detail: Structural["details"][number]; carried: boolean }> = [];
      for (const account of investmentAccounts) {
        if (account.archivedAt && account.archivedAt <= weekEnd) continue;
        const candidates = all.details.filter(
          (detail) => detail.accountId === account.id && detail.weekStart <= week,
        );
        const detail = candidates.sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0];
        if (detail) used.push({ detail, carried: detail.weekStart !== week });
      }
      const components: PortfolioHolding[] = [];
      for (const { detail, carried } of used)
        components.push(...(await rowsForSnapshot(tx, session.dataKey, all, detail, carried)));
      const grouped = new Map<string, { id: string; label: string; ils: Decimal }>();
      for (const row of components) {
        const id =
          groupBy === "account" ? row.accountId : (row.instrumentId ?? `cash:${row.currency}`);
        const current = grouped.get(id) ?? {
          id,
          label:
            groupBy === "account"
              ? (decText(
                  session.dataKey,
                  all.accounts.find((account) => account.id === row.accountId)!.nameCt,
                  row.accountId,
                  "name_ct",
                  all.accounts.find((account) => account.id === row.accountId)!.version,
                ) ?? "Account")
              : row.label,
          ils: new Decimal(0),
        };
        current.ils = current.ils.plus(row.ilsValue);
        grouped.set(id, current);
      }
      points.push({
        week,
        ilsValue: [...grouped.values()]
          .reduce((sum, value) => sum.plus(value.ils), new Decimal(0))
          .toFixed(),
        composition: [...grouped.values()].map((value) => ({
          id: value.id,
          label: value.label,
          ilsValue: value.ils.toFixed(),
        })),
      });
    }
    if (groupBy === "holding") {
      const average = new Map<string, Decimal>();
      for (const point of points)
        for (const item of point.composition)
          average.set(item.id, (average.get(item.id) ?? new Decimal(0)).plus(item.ilsValue));
      const top = new Set(
        [...average.entries()]
          .sort((a, b) => b[1].cmp(a[1]) || a[0].localeCompare(b[0]))
          .slice(0, 7)
          .map(([id]) => id),
      );
      for (const point of points) {
        const other = point.composition
          .filter((item) => !top.has(item.id))
          .reduce((sum, item) => sum.plus(item.ilsValue), new Decimal(0));
        point.composition = point.composition.filter((item) => top.has(item.id));
        if (!other.isZero())
          point.composition.push({ id: "other", label: "Other", ilsValue: other.toFixed() });
      }
    }
    const first = points[0];
    const last = points.at(-1);
    const change = first && last ? new Decimal(last.ilsValue).minus(first.ilsValue) : null;
    const percentage =
      change && !new Decimal(first!.ilsValue).isZero()
        ? change.div(first!.ilsValue).mul(100).toFixed()
        : "0";
    const latest = latestByAccount(all);
    const estimate: InvestmentValuation[] = [];
    for (const detail of latest.values())
      estimate.push(
        await valueInvestmentSnapshot(tx, session.dataKey, detail.id, { estimateNow: true }),
      );
    return {
      points,
      valuationChange: change
        ? {
            label: "Valuation change",
            disclosure: "Includes deposits and withdrawals",
            amount: change.toFixed(),
            percentage,
          }
        : null,
      estimatedNow: estimate.length
        ? {
            ilsValue: estimate
              .reduce((sum, value) => sum.plus(value.ilsValue), new Decimal(0))
              .toFixed(),
            metadata: estimate[0].metadata,
          }
        : null,
    };
  });
}

export async function getPortfolioSnapshot(
  session: Session,
  week: string,
  pageInput: Pick<PortfolioFilters, "limit" | "cursor"> = {},
): Promise<PortfolioSnapshotPage> {
  return withUser(session.userId, async (tx) => {
    const all = await structural(tx);
    const chosen = sunday(week);
    const rows: PortfolioHolding[] = [];
    const eligibleAccounts = all.accounts.filter(
      (account) =>
        account.accountType === "investment" &&
        (!account.archivedAt ||
          account.archivedAt >
            new Date(new Date(`${chosen}T00:00:00Z`).getTime() + 7 * 86_400_000)),
    );
    for (const account of eligibleAccounts) {
      const details = all.details
        .filter((detail) => detail.accountId === account.id && detail.weekStart <= chosen)
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
      if (details[0])
        rows.push(
          ...(await rowsForSnapshot(
            tx,
            session.dataKey,
            all,
            details[0],
            details[0].weekStart !== chosen,
          )),
        );
    }
    const result = page(
      session.dataKey,
      allocation(rows),
      { ...pageInput, connectionId: `week:${chosen}` },
      revision(all),
    );
    return { ...result, week: chosen, valuationRevision: revision(all) };
  });
}
