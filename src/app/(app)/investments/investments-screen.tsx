"use client";

import Decimal from "decimal.js";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileUp,
  Loader2,
  RefreshCw,
  TriangleAlert,
  WalletCards,
} from "lucide-react";
import {
  Area,
  Brush,
  Cell,
  ComposedChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import type { ConnectionView } from "@/domain/connections";
import type {
  PortfolioHistory,
  PortfolioHolding,
  PortfolioOverview,
  PortfolioPage,
  PortfolioSnapshotPage,
} from "@/domain/investments";
import { getConnectorDefinition } from "@/lib/connectors";
import {
  refreshQuotes,
  startConnectionSync,
  waitForSyncRun,
  type QuoteRefreshResult,
} from "@/lib/sync-client";
import { syncErrorMessage } from "@/lib/sync-error-message";
import { cn } from "@/lib/utils";
import { compositionCoordinates, weekEnding } from "./chart-data";

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "oklch(0.65 0.08 240)",
  "oklch(0.68 0.1 160)",
  "oklch(0.55 0.03 260)",
];
const RANGES = ["3M", "6M", "1Y", "3Y", "All"] as const;
type Range = (typeof RANGES)[number];
type GroupBy = "holding" | "account";

function money(value: string, currency = "ILS") {
  return new Intl.NumberFormat("en-IL", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "ILS" ? 0 : 2,
  }).format(Number(value));
}
function percent(value: string) {
  return `${new Decimal(value).toDecimalPlaces(1).toFixed()}%`;
}
function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}
function rangeDates(range: Range): { start: string; end: string } {
  const end = new Date();
  if (range === "All") return { start: "2000-01-01", end: isoDay(end) };
  const start = new Date(end);
  start.setMonth(start.getMonth() - ({ "3M": 3, "6M": 6, "1Y": 12, "3Y": 36 }[range] ?? 12));
  return { start: isoDay(start), end: isoDay(end) };
}
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok)
    throw new Error(
      ((await response.json().catch(() => ({}))) as { error?: string }).error ??
        "Could not load investments",
    );
  return response.json() as Promise<T>;
}
function qualityText(flags: string[]) {
  return flags.map((flag) => flag.replaceAll("_", " ")).join(" · ");
}
/** "etf" is an initialism, so title-casing it to "Etf" reads as a typo. */
function instrumentTypeLabel(kind: string | null | undefined) {
  if (!kind) return "—";
  if (kind === "etf") return "ETF";
  const words = kind.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function quoteUrl(symbol: string) {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
}

/**
 * A configured-but-absent Tiingo token answers 200 with refreshed:false, so
 * "the request succeeded" and "quotes were refreshed" are different facts. The
 * counts separate both from "ran, but nothing was eligible".
 */
function quoteNotice(result: QuoteRefreshResult): string {
  if (result.kind === "error")
    return " Quote refresh was unavailable; broker values remain included.";
  if (result.kind === "not_configured")
    return " Quote estimates are not configured; broker values remain included.";
  if (!result.attempted)
    return " No holdings were eligible for a quote estimate; broker values remain included.";
  return ` Quote estimates refreshed for ${result.updated} of ${result.attempted} holdings.`;
}

export function InvestmentsScreen({
  initialOverview,
  connections,
}: {
  initialOverview: PortfolioOverview;
  connections: ConnectionView[];
}) {
  const [overview, setOverview] = useState(initialOverview);
  const [rows, setRows] = useState<PortfolioPage | null>(null);
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // A set rather than a single id, so "Expand all" is expressible at all.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupBy>("holding");
  const [range, setRange] = useState<Range>("1Y");
  // Indices into the loaded history points; the chart's Brush owns this window.
  const [bounds, setBounds] = useState<{ start: number; end: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [week, setWeek] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PortfolioSnapshotPage | null>(null);

  const loadRows = async (cursor?: string) => {
    const page = await json<PortfolioPage>(
      `/api/investments/holdings?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    setRows((prior) => (cursor && prior ? { ...page, rows: [...prior.rows, ...page.rows] } : page));
  };
  useEffect(() => {
    // This hydrates the client-side drill-down after the server overview.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRows().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Could not load holdings"),
    );
  }, []);
  useEffect(() => {
    const dates = rangeDates(range);
    void json<PortfolioHistory>(
      `/api/investments/history?start=${dates.start}&end=${dates.end}&groupBy=${groupBy}`,
    )
      .then((next) => {
        setHistory(next);
        // A new range has different indices, so the old window is meaningless.
        setBounds(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load history"),
      );
  }, [range, groupBy]);
  useEffect(() => {
    if (!week) return;
    void json<PortfolioSnapshotPage>(`/api/investments/snapshots/${week}?limit=50`)
      .then(setSnapshot)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load snapshot"),
      );
  }, [week]);

  const hasData = overview.connections.length > 0;
  // Statement import is only reachable through a connection configured for it;
  // with none, the button leads to an empty dialog.
  const importConnections = connections.filter((item) => item.mode === "user_mediated_import");
  const allExpanded =
    overview.connections.length > 0 && overview.connections.every((view) => expanded.has(view.id));
  const rowsByConnection = useMemo(
    () =>
      new Map(
        overview.connections.map((connection) => [
          connection.id,
          rows?.rows.filter((row) => row.connectionId === connection.id) ?? [],
        ]),
      ),
    [overview.connections, rows],
  );
  const slices = useMemo(() => {
    const byId = new Map<
      string,
      {
        id: string;
        label: string;
        ilsValue: Decimal;
        native: Map<string, Decimal>;
        accounts: Set<string>;
      }
    >();
    for (const row of rows?.rows ?? []) {
      const id = row.kind === "cash" ? `cash:${row.currency}` : row.instrumentId!;
      const current = byId.get(id) ?? {
        id,
        label: row.label,
        ilsValue: new Decimal(0),
        native: new Map(),
        accounts: new Set(),
      };
      current.ilsValue = current.ilsValue.plus(row.ilsValue);
      current.native.set(
        row.currency,
        (current.native.get(row.currency) ?? new Decimal(0)).plus(row.nativeValue),
      );
      current.accounts.add(row.accountId);
      byId.set(id, current);
    }
    return [...byId.values()].map((slice) => ({
      ...slice,
      exact: slice.ilsValue.toFixed(),
      coordinate:
        overview.ilsValue === "0" ? 0 : slice.ilsValue.div(overview.ilsValue).mul(100).toNumber(),
    }));
  }, [rows, overview.ilsValue]);
  // The Brush windows the chart itself, so it always receives every point.
  const chart = useMemo(() => (history ? compositionCoordinates(history) : []), [history]);
  const keys = history
    ? [
        ...new Map(
          history.points.flatMap((point) => point.composition.map((item) => [item.id, item.label])),
        ).entries(),
      ]
    : [];

  async function refreshAll() {
    setBusy(true);
    setError(null);
    const files: string[] = [];
    const failures: string[] = [];
    for (const connection of connections.filter((item) =>
      overview.connections.some((view) => view.id === item.id),
    )) {
      const outcome = await startConnectionSync(connection);
      if (outcome.kind === "file_required") {
        files.push(
          connection.displayName ??
            getConnectorDefinition(connection.connectorId)?.label ??
            connection.connectorId,
        );
        continue;
      }
      if (outcome.kind === "locked") {
        failures.push(
          `${connection.displayName ?? "Connection"}: unlock with your passkey to refresh`,
        );
        continue;
      }
      if (outcome.kind === "error") {
        failures.push(`${connection.displayName ?? "Connection"}: ${outcome.message}`);
        continue;
      }
      const finished = await waitForSyncRun(outcome.syncRunId);
      if (finished.status === "failed")
        failures.push(
          `${connection.displayName ?? "Connection"}: ${syncErrorMessage(finished.error)}`,
        );
    }
    const refreshed = quoteNotice(await refreshQuotes());
    setNotice(
      `${files.length ? `${files.join(", ")} need a statement file.` : ""}${failures.join(" ")}${refreshed}`.trim(),
    );
    setBusy(false);
    const next = await json<PortfolioOverview>("/api/investments/overview").catch(() => null);
    if (next) setOverview(next);
    await loadRows().catch(() => undefined);
  }
  async function refreshConnection(connection: ConnectionView) {
    setBusy(true);
    setNotice(null);
    const outcome = await startConnectionSync(connection);
    if (outcome.kind === "file_required")
      setNotice("This source needs a statement file; it was not treated as a failed refresh.");
    else if (outcome.kind === "locked")
      setNotice("Unlock with your passkey, then retry this connection.");
    else if (outcome.kind === "error") setError(outcome.message);
    else {
      const done = await waitForSyncRun(outcome.syncRunId);
      if (done.status === "succeeded")
        // Holdings just moved, so the estimates layered on them are now the
        // stalest thing on screen.
        setNotice(`Connection updated.${quoteNotice(await refreshQuotes())}`);
      else setError(`${syncErrorMessage(done.error)} The last accepted snapshot remains included.`);
    }
    setBusy(false);
    const next = await json<PortfolioOverview>("/api/investments/overview").catch(() => null);
    if (next) setOverview(next);
    await loadRows().catch(() => undefined);
  }
  async function finishImport(message: string) {
    setImportOpen(false);
    setNotice(message);
    setError(null);
    try {
      const dates = rangeDates(range);
      const [nextOverview, nextHistory] = await Promise.all([
        json<PortfolioOverview>("/api/investments/overview"),
        json<PortfolioHistory>(
          `/api/investments/history?start=${dates.start}&end=${dates.end}&groupBy=${groupBy}`,
        ),
      ]);
      setOverview(nextOverview);
      setHistory(nextHistory);
      await loadRows();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reload investments");
    }
  }
  if (!hasData)
    return (
      <>
        <EmptyState onImport={() => setImportOpen(true)} />
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          connections={importConnections}
          onDone={(message) => void finishImport(message)}
        />
      </>
    );
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Investments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What you own now and how its value evolved.
        </p>
      </header>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <Card className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Freshness value={overview.metadata.freshness} />
            {overview.metadata.qualityFlags.length > 0 && (
              <Badge className="border-primary/30 text-primary">
                {qualityText(overview.metadata.qualityFlags)}
              </Badge>
            )}
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Current valuation
            </p>
            <p className="mt-2 text-4xl font-bold tracking-tight tabular-nums">
              {money(overview.ilsValue)}
            </p>
            {/* One figure per currency the user actually holds cash in. The
                ILS-converted grand total used to lead this line, which read as
                a third cash pile next to the USD and ILS ones it was the sum
                of. The portfolio total above already carries it. */}
            <p className="mt-2 text-sm text-muted-foreground">
              Cash{" "}
              {overview.cashByCurrency.length
                ? overview.cashByCurrency
                    .map((item) => money(item.nativeValue, item.currency))
                    .join(" · ")
                : money("0")}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Basis {overview.metadata.basis.replaceAll("_", " ")} · Source as of{" "}
            {overview.metadata.sourceAsOf ?? "unavailable"} · FX as of{" "}
            {overview.metadata.fxAsOf ?? "unavailable"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void refreshAll()} disabled={busy}>
              <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
              Refresh all
            </Button>
            {importConnections.length > 0 && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <FileUp className="h-4 w-4" />
                Import statement
              </Button>
            )}
          </div>
        </div>
        <Donut slices={slices} selected={selected} onSelect={setSelected} />
      </Card>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Accounts</h2>
          {overview.connections.length > 1 && (
            <Button
              variant="outline"
              className="h-8 px-3 text-xs"
              onClick={() =>
                setExpanded(
                  allExpanded ? new Set() : new Set(overview.connections.map((view) => view.id)),
                )
              }
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </Button>
          )}
        </div>
        {overview.connections.map((view) => (
          <ConnectionCard
            key={view.id}
            view={view}
            connection={connections.find((item) => item.id === view.id)}
            rows={rowsByConnection.get(view.id) ?? []}
            expanded={expanded.has(view.id)}
            selected={selected}
            onExpand={() =>
              setExpanded((prior) => {
                const next = new Set(prior);
                if (!next.delete(view.id)) next.add(view.id);
                return next;
              })
            }
            onRefresh={() => {
              const connection = connections.find((item) => item.id === view.id);
              if (connection) void refreshConnection(connection);
            }}
            onImport={() => setImportOpen(true)}
          />
        ))}
      </section>
      <History
        history={history}
        chart={chart}
        keys={keys}
        range={range}
        groupBy={groupBy}
        bounds={bounds}
        onRange={setRange}
        onGroup={setGroupBy}
        onBounds={setBounds}
        onWeek={setWeek}
      />
      {week && <Snapshot week={week} snapshot={snapshot} onClose={() => setWeek(null)} />}
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        connections={importConnections}
        onDone={(message) => void finishImport(message)}
      />
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-[var(--radius)] border px-4 py-3 text-sm",
        tone ? "border-negative/40 text-negative" : "border-primary/30 text-muted-foreground",
      )}
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      {children}
    </div>
  );
}
function Freshness({ value }: { value: string }) {
  return (
    <Badge
      className={
        value === "current" ? "border-positive/30 text-positive" : "border-primary/30 text-primary"
      }
    >
      {value.replaceAll("_", " ")}
    </Badge>
  );
}
function EmptyState({ onImport }: { onImport: () => void }) {
  return (
    <Card className="flex min-h-[440px] flex-col items-center justify-center gap-5 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <WalletCards className="h-6 w-6" />
      </div>
      <div>
        <h1 className="text-2xl font-semibold">Investments are optional</h1>
        <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
          Connect a brokerage when you want a consolidated view. Moni works normally without one.
        </p>
      </div>
      <div className="flex gap-3">
        <a
          href="/settings/connections/connect"
          className="inline-flex h-9 items-center rounded-[var(--radius)] bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          Connect brokerage
        </a>
        <Button variant="outline" onClick={onImport}>
          Import statement
        </Button>
      </div>
    </Card>
  );
}

function Donut({
  slices,
  selected,
  onSelect,
}: {
  slices: Array<{
    id: string;
    label: string;
    exact: string;
    coordinate: number;
    native: Map<string, Decimal>;
    accounts: Set<string>;
  }>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="relative h-72">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={slices}
            dataKey="coordinate"
            nameKey="label"
            innerRadius="58%"
            outerRadius="85%"
            paddingAngle={2}
            onClick={(event) => {
              const slice = (event as { payload?: (typeof slices)[number] }).payload;
              if (slice) onSelect(selected === slice.id ? null : slice.id);
            }}
          >
            {slices.map((slice, index) => (
              <Cell
                key={slice.id}
                fill={COLORS[index % COLORS.length]}
                opacity={selected && selected !== slice.id ? 0.25 : 1}
                className="cursor-pointer outline-none"
              />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              const slice = active
                ? (payload?.[0]?.payload as (typeof slices)[number] | undefined)
                : undefined;
              if (!slice) return null;
              return (
                <div className="rounded-[var(--radius)] border border-border bg-popover p-3 text-xs">
                  <p className="font-medium">{slice.label}</p>
                  <p className="mt-2 tabular-nums">{money(slice.exact)}</p>
                  <p className="mt-1 text-muted-foreground">
                    {percent(String(slice.coordinate))} of portfolio · {slice.accounts.size} account
                    {slice.accounts.size === 1 ? "" : "s"}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {[...slice.native]
                      .map(([currency, amount]) => money(amount.toFixed(), currency))
                      .join(" · ")}
                  </p>
                </div>
              );
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Holdings</span>
        <span className="mt-1 text-lg font-semibold tabular-nums">{slices.length}</span>
      </div>
    </div>
  );
}
function ConnectionCard({
  view,
  connection,
  rows,
  expanded,
  selected,
  onExpand,
  onRefresh,
  onImport,
}: {
  view: PortfolioOverview["connections"][number];
  connection?: ConnectionView;
  rows: PortfolioHolding[];
  expanded: boolean;
  selected: string | null;
  onExpand: () => void;
  onRefresh: () => void;
  onImport: () => void;
}) {
  const broker = connection?.connectorId === "ibkr_flex" ? "interactivebrokers" : "schwab";
  const definition = connection ? getConnectorDefinition(connection.connectorId) : undefined;
  const label = definition?.institutionLabel ?? definition?.label ?? "Connection";
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4 p-5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className="flex min-w-0 items-center gap-3 text-left"
        >
          <Image
            src={`/investments/${broker}.png`}
            alt=""
            width={36}
            height={36}
            unoptimized
            className="rounded-[var(--radius)] border border-border"
          />
          <div>
            <p className="font-medium">{view.name ?? label}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {view.mode === "credentialed_fetch" ? "Fetch on demand" : "Statement import"} ·{" "}
              {view.accountCount} account{view.accountCount === 1 ? "" : "s"} · {view.positionCount}{" "}
              positions · {view.cashCount} cash balance{view.cashCount === 1 ? "" : "s"}
            </p>
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="tabular-nums font-medium">{money(view.ilsValue)}</p>
            <Freshness value={view.freshness} />
          </div>
          <Button
            variant="outline"
            className="h-8 px-3 text-xs"
            onClick={view.mode === "credentialed_fetch" ? onRefresh : onImport}
          >
            {view.mode === "credentialed_fetch" ? "Refresh" : "Import file"}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border p-5">
          <HoldingTable rows={rows} selected={selected} />
        </div>
      )}
    </Card>
  );
}
function HoldingTable({ rows, selected }: { rows: PortfolioHolding[]; selected: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[940px] border-separate border-spacing-0 text-sm">
        <thead className="text-left text-xs font-medium text-muted-foreground">
          <tr>
            {[
              ["Holding", "left"],
              ["Type", "left"],
              ["Quantity", "right"],
              ["Price", "right"],
              ["Value", "right"],
              ["Value (ILS)", "right"],
              ["Allocation", "right"],
              ["Source", "left"],
              ["As of", "left"],
            ].map(([label, align]) => (
              <th
                key={label}
                className={cn(
                  "whitespace-nowrap border-b border-border px-3 pb-3 first:pl-0 last:pr-0",
                  align === "right" && "text-right",
                )}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn(
                selected &&
                  (row.instrumentId === selected || `cash:${row.currency}` === selected) &&
                  "bg-primary/5",
              )}
            >
              <td className="max-w-[260px] border-b border-border/60 px-3 py-4 pl-0">
                {row.symbol ? (
                  <a
                    href={quoteUrl(row.symbol)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
                  >
                    {row.symbol}
                  </a>
                ) : (
                  <span className="font-medium">{row.label}</span>
                )}
                {row.name && row.name !== row.symbol && (
                  <p className="truncate text-xs text-muted-foreground" title={row.name}>
                    {row.name}
                  </p>
                )}
                {row.instrumentKind === "generic" && (
                  <p className="text-xs text-muted-foreground">Broker value only</p>
                )}
              </td>
              <td className="whitespace-nowrap border-b border-border/60 px-3 py-4">
                {row.kind === "cash" ? "Cash" : instrumentTypeLabel(row.instrumentKind)}
              </td>
              <td className="whitespace-nowrap border-b border-border/60 px-3 py-4 text-right tabular-nums">
                {row.quantity ?? "—"}
              </td>
              <td className="whitespace-nowrap border-b border-border/60 px-3 py-4 text-right tabular-nums">
                {row.price ? money(row.price, row.currency) : "—"}
              </td>
              <td className="whitespace-nowrap border-b border-border/60 px-3 py-4 text-right tabular-nums">
                {money(row.nativeValue, row.currency)}
              </td>
              <td className="whitespace-nowrap border-b border-border/60 px-3 py-4 text-right tabular-nums">
                {row.qualityReasons.includes("incomplete_fx")
                  ? "Excluded (FX incomplete)"
                  : money(row.ilsValue)}
              </td>
              <td className="whitespace-nowrap border-b border-border/60 px-3 py-4 text-right tabular-nums">
                {percent(row.allocationPercentage)}
              </td>
              <td className="border-b border-border/60 px-3 py-4">
                <span className="whitespace-nowrap capitalize">
                  {row.basis.replaceAll("_", " ")}
                </span>
                {row.qualityReasons.length ? (
                  <p className="text-xs text-primary">{qualityText(row.qualityReasons)}</p>
                ) : null}
              </td>
              <td className="whitespace-nowrap border-b border-border/60 px-3 py-4 pr-0 tabular-nums">
                {row.sourceAsOf}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function History({
  history,
  chart,
  keys,
  range,
  groupBy,
  bounds,
  onRange,
  onGroup,
  onBounds,
  onWeek,
}: {
  history: PortfolioHistory | null;
  chart: ReturnType<typeof compositionCoordinates>;
  keys: Array<[string, string]>;
  range: Range;
  groupBy: GroupBy;
  bounds: { start: number; end: number } | null;
  onRange: (value: Range) => void;
  onGroup: (value: GroupBy) => void;
  onBounds: (value: { start: number; end: number }) => void;
  onWeek: (week: string) => void;
}) {
  const last = Math.max(0, chart.length - 1);
  const window = bounds ?? { start: 0, end: last };
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Historical composition</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Weekly broker-observed values. Current estimates are separate.
          </p>
        </div>
        {history?.valuationChange && (
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {history.valuationChange.label}
            </p>
            <p className="tabular-nums font-semibold">
              {money(history.valuationChange.amount)} ·{" "}
              {percent(history.valuationChange.percentage)}
            </p>
            <p className="text-xs text-muted-foreground">{history.valuationChange.disclosure}</p>
          </div>
        )}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {(["holding", "account"] as const).map((value) => (
          <Button
            key={value}
            variant={groupBy === value ? "primary" : "outline"}
            className="h-8 px-3 text-xs"
            onClick={() => onGroup(value)}
          >
            {value === "holding" ? "Holding" : "Account"}
          </Button>
        ))}
        <span className="w-2" />
        {RANGES.map((value) => (
          <Button
            key={value}
            variant={range === value ? "primary" : "outline"}
            className="h-8 px-3 text-xs"
            onClick={() => onRange(value)}
          >
            {value}
          </Button>
        ))}
      </div>
      {chart.length > 0 && (
        <p className="mt-4 text-xs text-muted-foreground">
          Showing {weekEnding(chart[window.start]?.week ?? chart[0].week)} to{" "}
          {weekEnding(chart[window.end]?.week ?? chart[last].week)} · drag the handles below the
          chart to narrow the window.
        </p>
      )}
      <div className="mt-4 h-96">
        {history ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chart}
              onClick={(event) => {
                const week = (
                  (event as unknown as { activePayload?: Array<{ payload?: { week?: string } }> })
                    .activePayload?.[0]?.payload as { week?: string } | undefined
                )?.week;
                if (week) onWeek(week);
              }}
            >
              <XAxis
                dataKey="week"
                axisLine={false}
                tickLine={false}
                minTickGap={38}
                // `week` is the week's start date, but every other surface — the
                // tooltip, the brush, the snapshot heading — names a week by the
                // day it ends. An unformatted axis reads six days off from them.
                tickFormatter={(value: string) => weekEnding(value)}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(value) => `${value}%`}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              />
              {keys.map(([id], index) => (
                <Area
                  key={id}
                  type="monotone"
                  dataKey={(point) => point.values[id] ?? 0}
                  stackId="composition"
                  stroke={COLORS[index % COLORS.length]}
                  fill={COLORS[index % COLORS.length]}
                  fillOpacity={0.35}
                />
              ))}
              <Tooltip
                content={({ active, payload }) => {
                  const point = active
                    ? (payload?.[0]?.payload as (typeof chart)[number] | undefined)
                    : undefined;
                  if (!point) return null;
                  return (
                    <div className="rounded-[var(--radius)] border border-border bg-popover p-3 text-xs">
                      <p className="font-medium">Week ending {weekEnding(point.week)}</p>
                      <p className="mt-1 tabular-nums">{money(point.total)}</p>
                      {keys.map(
                        ([id, label]) =>
                          point.exact[id] && (
                            <p key={id} className="mt-1 text-muted-foreground">
                              {label}:{" "}
                              <span className="tabular-nums">{money(point.exact[id])}</span>
                            </p>
                          ),
                      )}
                    </div>
                  );
                }}
              />
              <Brush
                dataKey="week"
                height={26}
                travellerWidth={10}
                startIndex={window.start}
                endIndex={window.end}
                stroke="var(--color-primary)"
                fill="var(--color-muted)"
                tickFormatter={(value: string) => weekEnding(value)}
                onChange={(next) => {
                  if (next.startIndex !== undefined && next.endIndex !== undefined)
                    onBounds({ start: next.startIndex, end: next.endIndex });
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading history…
          </div>
        )}
      </div>
    </Card>
  );
}
function Snapshot({
  week,
  snapshot,
  onClose,
}: {
  week: string;
  snapshot: PortfolioSnapshotPage | null;
  onClose: () => void;
}) {
  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">As of {weekEnding(week)}</h2>
          <p className="text-sm text-muted-foreground">
            Complete account, holding, cash, native value, ILS value, and carried-source detail.
          </p>
        </div>
        <Button variant="outline" className="h-8 px-3 text-xs" onClick={onClose}>
          Close
        </Button>
      </div>
      {snapshot ? (
        <HoldingTable rows={snapshot.rows} selected={null} />
      ) : (
        <p className="text-sm text-muted-foreground">Loading selected week…</p>
      )}
    </Card>
  );
}
function ImportDialog({
  open,
  onClose,
  connections,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  connections: ConnectionView[];
  onDone: (message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!file || !connectionId) {
      setError("Choose a statement file and its connection.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("The file is larger than 10 MiB.");
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    form.append("valuationCurrency", currency);
    try {
      const response = await fetch(`/api/connections/${connectionId}/sync`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        setError(
          ((await response.json().catch(() => ({}))) as { error?: string }).error ??
            "Could not import statement",
        );
        return;
      }
      const body = (await response.json()) as { syncRunId: string };
      // Parsing and promotion happen in a worker, so the run is only finished
      // once the poll says so — the dialog stays busy for all of it.
      const done = await waitForSyncRun(body.syncRunId);
      if (done.status !== "succeeded") {
        setError(`${syncErrorMessage(done.error)} The last accepted snapshot remains included.`);
        return;
      }
      onDone("Statement imported.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Import statement"
      description="A CSV statement exported from your broker; the file stays bounded in memory."
    >
      {busy ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Importing statement…</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            {"Reading the file, valuing every holding, and refreshing exchange rates."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="block text-sm">
            Connection
            <select
              className="mt-1 w-full rounded-[var(--radius)] border border-border bg-background p-2"
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.displayName ??
                    getConnectorDefinition(connection.connectorId)?.label ??
                    connection.connectorId}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Valuation currency
            <input
              className="mt-1 w-full rounded-[var(--radius)] border border-border bg-background p-2 uppercase"
              value={currency}
              maxLength={3}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            />
          </label>
          <label className="block text-sm">
            Statement file
            <input
              aria-label="Statement CSV"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-[var(--radius)] file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
            />
          </label>
          {!connections.length && (
            <p className="text-xs text-muted-foreground">
              Create a statement-import connection first.
            </p>
          )}
          {error && <p className="text-sm text-negative">{error}</p>}
          <Button disabled={!connections.length} onClick={() => void submit()}>
            Import statement
          </Button>
        </div>
      )}
    </Dialog>
  );
}
