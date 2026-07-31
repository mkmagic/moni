"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileUp,
  Landmark,
  RefreshCw,
  Sparkles,
  Upload,
  WalletCards,
} from "lucide-react";
import {
  Area,
  Brush,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
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
import { PrototypeSwitcher, type PrototypeVariant } from "@/components/prototype-switcher";
import { cn } from "@/lib/utils";

type DemoState = "Current" | "Empty" | "Onboarding" | "Stale" | "Partial" | "Error" | "Unsupported";
type Breakdown = "Holding" | "Account";
type HistoryRange = { start: number; end: number };

interface Holding {
  key: string;
  name: string;
  symbol: string;
  type: string;
  quantity: string | null;
  price: string | null;
  currency: string;
  nativeValue: string;
  ilsValue: string;
  allocation: string;
  source: "Market quote" | "Broker value";
  asOf: string;
  unsupported?: boolean;
}

interface InvestmentAccount {
  name: string;
  last4: string;
  currency: string;
  holdings: Holding[];
}

interface Brokerage {
  id: string;
  name: string;
  mode: "automatic" | "manual";
  value: string;
  cash: string;
  freshness: string;
  accounts: InvestmentAccount[];
}

interface Slice {
  key: string;
  name: string;
  symbol: string;
  ilsValue: string;
  nativeValue: string;
  currency: string;
  accounts: string;
}

interface HistoryPoint {
  date: string;
  vti: string;
  qqq: string;
  msft: string;
  vgk: string;
  fund: string;
  cashUsd: string;
  other: string;
  ibkr: string;
  schwab: string;
  vanguard: string;
  total: string;
  estimate?: boolean;
}

const states: DemoState[] = [
  "Current",
  "Empty",
  "Onboarding",
  "Stale",
  "Partial",
  "Error",
  "Unsupported",
];

const chartColors = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-3)",
  "oklch(0.72 0.1 210)",
  "oklch(0.7 0.08 125)",
  "oklch(0.55 0.03 260)",
];

const brokerLogoUrls: Record<string, string> = {
  ibkr: "https://www.google.com/s2/favicons?domain=interactivebrokers.com&sz=128",
  schwab: "https://www.google.com/s2/favicons?domain=schwab.com&sz=128",
  vanguard: "https://www.google.com/s2/favicons?domain=vanguard.com&sz=128",
};

function BrokerLogo({ brokerage }: { brokerage: Brokerage }) {
  return (
    <span
      role="img"
      aria-label={`${brokerage.name} logo`}
      className="h-9 w-9 shrink-0 rounded-[var(--radius)] border border-border bg-white bg-contain bg-center bg-no-repeat"
      style={{ backgroundImage: `url(${brokerLogoUrls[brokerage.id]})` }}
    />
  );
}

const brokerages: Brokerage[] = [
  {
    id: "ibkr",
    name: "Interactive Brokers",
    mode: "automatic",
    value: "1058000",
    cash: "49300",
    freshness: "Observed today, 16:42",
    accounts: [
      {
        name: "Individual Brokerage",
        last4: "1842",
        currency: "USD",
        holdings: [
          {
            key: "vti",
            name: "Vanguard Total Stock Market ETF",
            symbol: "VTI",
            type: "ETF",
            quantity: "612.4500",
            price: "287.14",
            currency: "USD",
            nativeValue: "175868.09",
            ilsValue: "646516",
            allocation: "61.1%",
            source: "Market quote",
            asOf: "Today 16:40",
          },
          {
            key: "qqq",
            name: "Invesco QQQ Trust",
            symbol: "QQQ",
            type: "ETF",
            quantity: "168.2000",
            price: "529.82",
            currency: "USD",
            nativeValue: "89115.72",
            ilsValue: "327725",
            allocation: "31.0%",
            source: "Market quote",
            asOf: "Today 16:40",
          },
          {
            key: "cash-usd",
            name: "Cash · USD",
            symbol: "USD",
            type: "Cash",
            quantity: null,
            price: null,
            currency: "USD",
            nativeValue: "13399.46",
            ilsValue: "49300",
            allocation: "4.7%",
            source: "Broker value",
            asOf: "Today 16:42",
          },
          {
            key: "generic-note",
            name: "Autocallable Index Note",
            symbol: "XS2049",
            type: "Unsupported",
            quantity: "10",
            price: "950.00",
            currency: "USD",
            nativeValue: "9500.00",
            ilsValue: "34900",
            allocation: "3.3%",
            source: "Broker value",
            asOf: "Today 16:42",
            unsupported: true,
          },
        ],
      },
    ],
  },
  {
    id: "schwab",
    name: "Charles Schwab",
    mode: "manual",
    value: "624700",
    cash: "16800",
    freshness: "Statement dated 25 Jul 2026",
    accounts: [
      {
        name: "Joint Brokerage",
        last4: "6631",
        currency: "USD",
        holdings: [
          {
            key: "vti",
            name: "Vanguard Total Stock Market ETF",
            symbol: "VTI",
            type: "ETF",
            quantity: "222.0000",
            price: "287.14",
            currency: "USD",
            nativeValue: "63745.08",
            ilsValue: "234390",
            allocation: "37.5%",
            source: "Market quote",
            asOf: "Today 16:40",
          },
          {
            key: "msft",
            name: "Microsoft Corp.",
            symbol: "MSFT",
            type: "Stock",
            quantity: "124.0000",
            price: "513.21",
            currency: "USD",
            nativeValue: "63638.04",
            ilsValue: "233996",
            allocation: "37.5%",
            source: "Market quote",
            asOf: "Today 16:40",
          },
          {
            key: "vgk",
            name: "Vanguard FTSE Europe ETF",
            symbol: "VGK",
            type: "ETF",
            quantity: "512.0000",
            price: "74.12",
            currency: "USD",
            nativeValue: "37949.44",
            ilsValue: "139514",
            allocation: "22.3%",
            source: "Broker value",
            asOf: "25 Jul 2026",
          },
          {
            key: "cash-usd",
            name: "Cash · USD",
            symbol: "USD",
            type: "Cash",
            quantity: null,
            price: null,
            currency: "USD",
            nativeValue: "4569.10",
            ilsValue: "16800",
            allocation: "2.7%",
            source: "Broker value",
            asOf: "25 Jul 2026",
          },
        ],
      },
    ],
  },
  {
    id: "vanguard",
    name: "Vanguard",
    mode: "manual",
    value: "382400",
    cash: "28600",
    freshness: "Statement dated 28 Jul 2026",
    accounts: [
      {
        name: "Traditional IRA",
        last4: "0927",
        currency: "USD",
        holdings: [
          {
            key: "fund",
            name: "Vanguard Wellington Fund Investor Shares",
            symbol: "VWELX",
            type: "Mutual fund",
            quantity: "1024.7000",
            price: "93.85",
            currency: "USD",
            nativeValue: "96236.10",
            ilsValue: "353800",
            allocation: "92.5%",
            source: "Broker value",
            asOf: "28 Jul 2026",
          },
          {
            key: "cash-usd",
            name: "Cash · USD",
            symbol: "USD",
            type: "Cash",
            quantity: null,
            price: null,
            currency: "USD",
            nativeValue: "7782.31",
            ilsValue: "28600",
            allocation: "7.5%",
            source: "Broker value",
            asOf: "28 Jul 2026",
          },
        ],
      },
    ],
  },
];

const slices: Slice[] = [
  {
    key: "vti",
    name: "Vanguard Total Stock Market ETF",
    symbol: "VTI",
    ilsValue: "880906",
    nativeValue: "239613.17",
    currency: "USD",
    accounts: "2 accounts",
  },
  {
    key: "fund",
    name: "Vanguard Wellington Fund Investor Shares",
    symbol: "VWELX",
    ilsValue: "353800",
    nativeValue: "96236.10",
    currency: "USD",
    accounts: "1 account",
  },
  {
    key: "qqq",
    name: "Invesco QQQ Trust",
    symbol: "QQQ",
    ilsValue: "327725",
    nativeValue: "89115.72",
    currency: "USD",
    accounts: "1 account",
  },
  {
    key: "msft",
    name: "Microsoft Corp.",
    symbol: "MSFT",
    ilsValue: "233996",
    nativeValue: "63638.04",
    currency: "USD",
    accounts: "1 account",
  },
  {
    key: "vgk",
    name: "Vanguard FTSE Europe ETF",
    symbol: "VGK",
    ilsValue: "139514",
    nativeValue: "37949.44",
    currency: "USD",
    accounts: "1 account",
  },
  {
    key: "cash-usd",
    name: "Cash · USD",
    symbol: "USD",
    ilsValue: "94700",
    nativeValue: "25750.87",
    currency: "USD",
    accounts: "3 accounts",
  },
  {
    key: "generic-note",
    name: "Autocallable Index Note",
    symbol: "XS2049",
    ilsValue: "34900",
    nativeValue: "9500.00",
    currency: "USD",
    accounts: "1 account",
  },
];

function buildHistory(): HistoryPoint[] {
  const points = Array.from({ length: 52 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 7, 2 + index * 7)).toISOString().slice(0, 10);
    const vti = 520000n + BigInt(index) * 6900n;
    const qqq = 245000n + BigInt(index) * 1700n;
    const msft = 185000n + BigInt(index) * 950n;
    const vgk = 113000n + BigInt(index) * 510n;
    const fund = 306000n + BigInt(index) * 920n;
    const cashUsd = 90000n + BigInt(index) * 90n;
    const other = 29500n + BigInt(index) * 105n;
    const ibkr = (vti * 7n) / 10n + qqq + cashUsd / 2n + other;
    const schwab = (vti * 3n) / 10n + msft + vgk + cashUsd / 4n;
    const vanguard = fund + cashUsd / 4n;
    return {
      date,
      vti: vti.toString(),
      qqq: qqq.toString(),
      msft: msft.toString(),
      vgk: vgk.toString(),
      fund: fund.toString(),
      cashUsd: cashUsd.toString(),
      other: other.toString(),
      ibkr: ibkr.toString(),
      schwab: schwab.toString(),
      vanguard: vanguard.toString(),
      total: (ibkr + schwab + vanguard).toString(),
    };
  });
  const last = points.at(-1)!;
  const grow = (value: string) => ((BigInt(value) * 1017n) / 1000n).toString();
  const estimated = { ...last, date: "2026-07-31", estimate: true };
  for (const key of [
    "vti",
    "qqq",
    "msft",
    "vgk",
    "fund",
    "cashUsd",
    "other",
    "ibkr",
    "schwab",
    "vanguard",
    "total",
  ] as const) {
    estimated[key] = grow(last[key]);
  }
  return [...points, estimated];
}

const history = buildHistory();

function formatMoney(value: string, currency = "ILS") {
  return new Intl.NumberFormat("en-IL", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "ILS" ? 0 : 2,
  }).format(Number(value));
}

function shortMoney(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function StatusBadge({ state }: { state: DemoState }) {
  if (state === "Current")
    return <Badge className="border-positive/30 text-positive">Current</Badge>;
  if (state === "Unsupported") return <Badge>1 unsupported instrument</Badge>;
  return <Badge className="border-primary/30 text-primary">Partly stale</Badge>;
}

function PrototypeStateBar({
  state,
  onChange,
}: {
  state: DemoState;
  onChange: (state: DemoState) => void;
}) {
  if (process.env.NODE_ENV === "production") return null;
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-primary/40 bg-primary/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
        <Sparkles className="h-3.5 w-3.5" /> Prototype state
      </div>
      <div className="flex flex-wrap gap-1.5">
        {states.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onChange(item)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition",
              state === item
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyPortfolio({ onStart }: { onStart: () => void }) {
  return (
    <Card className="flex min-h-[520px] flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <WalletCards className="h-6 w-6" />
      </div>
      <div className="max-w-lg space-y-2">
        <h1 className="text-2xl font-semibold">Investments are optional</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Connect a brokerage when you want a consolidated view. Moni works normally without one.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <Button onClick={onStart}>
          <Landmark className="h-4 w-4" /> Connect brokerage
        </Button>
        <Button variant="outline" onClick={onStart}>
          <FileUp className="h-4 w-4" /> Import statement
        </Button>
      </div>
    </Card>
  );
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const [source, setSource] = useState<"ibkr" | "statement" | null>(null);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Badge>Optional setup</Badge>
        <h1 className="mt-3 text-2xl font-semibold">Add an investment source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start with one source. You can add another brokerage later.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <button
          type="button"
          onClick={() => setSource("ibkr")}
          className={cn(
            "rounded-[var(--radius)] border bg-card p-6 text-left transition hover:border-primary/50",
            source === "ibkr" ? "border-primary" : "border-border",
          )}
        >
          <RefreshCw className="mb-5 h-5 w-5 text-primary" />
          <h2 className="font-medium">Interactive Brokers Flex</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Fetch positions from a read-only Flex Query whenever you ask Moni to refresh.
          </p>
        </button>
        <button
          type="button"
          onClick={() => setSource("statement")}
          className={cn(
            "rounded-[var(--radius)] border bg-card p-6 text-left transition hover:border-primary/50",
            source === "statement" ? "border-primary" : "border-border",
          )}
        >
          <Upload className="mb-5 h-5 w-5 text-primary" />
          <h2 className="font-medium">Brokerage statement</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Import a supported positions CSV and confirm its account and valuation currency.
          </p>
        </button>
      </div>
      {source && (
        <Card className="p-6">
          <h2 className="font-medium">
            {source === "ibkr" ? "Enter Flex Query details" : "Choose a positions file"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Prototype only — credentials and files never leave this screen.
          </p>
          <div className="mt-5 flex gap-3">
            <Button onClick={onDone}>
              {source === "ibkr" ? "Connect and fetch" : "Choose file"}
            </Button>
            <Button variant="ghost" onClick={() => setSource(null)}>
              Back
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Donut({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const focus = hovered ?? selected;
  const total = slices.reduce((sum, slice) => sum + BigInt(slice.ilsValue), 0n).toString();
  return (
    <div className="relative h-72 min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={slices}
            dataKey={(slice: Slice) => Number(slice.ilsValue)}
            nameKey="symbol"
            innerRadius="58%"
            outerRadius="86%"
            paddingAngle={2}
            onMouseLeave={() => setHovered(null)}
            onClick={(sector) => {
              const slice = (sector as { payload?: Slice }).payload;
              if (slice) onSelect(selected === slice.key ? null : slice.key);
            }}
            onMouseEnter={(sector) => {
              const slice = (sector as { payload?: Slice }).payload;
              if (slice) setHovered(slice.key);
            }}
          >
            {slices.map((slice, index) => (
              <Cell
                key={slice.key}
                fill={chartColors[index]}
                opacity={focus && focus !== slice.key ? 0.22 : 1}
                className="cursor-pointer outline-none"
              />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              const slice = active ? (payload?.[0]?.payload as Slice | undefined) : undefined;
              if (!slice) return null;
              return (
                <div className="max-w-64 rounded-[var(--radius)] border border-border bg-popover p-3 text-xs">
                  <div className="font-medium text-foreground">{slice.name}</div>
                  <div className="mt-2 tabular-nums text-foreground">
                    {formatMoney(slice.ilsValue)}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {formatMoney(slice.nativeValue, slice.currency)} · {slice.accounts}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {((Number(slice.ilsValue) / Number(total)) * 100).toFixed(1)}% of portfolio
                  </div>
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

function Hero({
  state,
  selected,
  onSelect,
  mode = "balanced",
}: {
  state: DemoState;
  selected: string | null;
  onSelect: (key: string | null) => void;
  mode?: "balanced" | "spotlight" | "dense";
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  function refreshAll() {
    setRefreshing(true);
    setNotice(null);
    window.setTimeout(() => {
      setRefreshing(false);
      setNotice("IBKR updated · Schwab and Vanguard need new statement files");
    }, 700);
  }
  const figures = (
    <div className={cn("space-y-5", mode === "spotlight" && "self-center")}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge state={state} />
        <span className="text-xs text-muted-foreground">
          <Clock3 className="mr-1 inline h-3.5 w-3.5" />
          Estimated 31 Jul, 16:40
        </span>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Portfolio valuation
        </p>
        <p
          className={cn(
            "mt-2 font-bold tracking-tight tabular-nums",
            mode === "spotlight" ? "text-5xl" : mode === "dense" ? "text-3xl" : "text-4xl",
          )}
        >
          {formatMoney("2065100")}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Cash {formatMoney("94700")} · {formatMoney("25750.87", "USD")} native
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={refreshAll} disabled={refreshing}>
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing" : "Refresh all"}
        </Button>
        <Button variant="outline">
          <FileUp className="h-4 w-4" />
          Import statement
        </Button>
      </div>
      {notice && <p className="text-xs text-primary">{notice}</p>}
      {state !== "Current" && (
        <p className="max-w-md text-xs text-muted-foreground">
          Last known values remain included. Some observations need attention.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        3 positions use broker values instead of fresh market quotes.
      </p>
    </div>
  );
  if (mode === "dense")
    return (
      <Card className="grid gap-5 p-5 md:grid-cols-[1fr_300px]">
        {figures}
        <Donut selected={selected} onSelect={onSelect} />
      </Card>
    );
  return (
    <Card
      className={cn(
        "grid gap-7 p-6 md:grid-cols-[minmax(0,1fr)_minmax(300px,0.85fr)]",
        mode === "spotlight" && "border-primary/20 p-8",
      )}
    >
      {figures}
      <Donut selected={selected} onSelect={onSelect} />
    </Card>
  );
}

function HoldingTable({
  account,
  selected,
  state,
}: {
  account: InvestmentAccount;
  selected: string | null;
  state: DemoState;
}) {
  const holdings =
    state === "Unsupported"
      ? account.holdings
      : account.holdings.filter((holding) => !holding.unsupported);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[940px] text-left text-xs">
        <thead className="border-y border-border text-muted-foreground">
          <tr>
            {[
              "Holding",
              "Type",
              "Quantity",
              "Price",
              "Native value",
              "ILS value",
              "Allocation",
              "Valuation",
              "As of",
            ].map((label) => (
              <th
                key={label}
                className={cn(
                  "px-3 py-2 font-medium",
                  ["Quantity", "Price", "Native value", "ILS value", "Allocation"].includes(
                    label,
                  ) && "text-right",
                )}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding) => (
            <tr
              key={`${account.last4}-${holding.key}`}
              className={cn(
                "border-b border-border/70 transition",
                selected === holding.key && "bg-primary/10",
              )}
            >
              <td className="px-3 py-3">
                <div className="font-medium text-foreground">{holding.symbol}</div>
                <div className="mt-0.5 max-w-52 truncate text-muted-foreground">{holding.name}</div>
              </td>
              <td className="px-3 py-3">
                {holding.unsupported ? (
                  <Badge className="border-negative/30 text-negative">Unsupported</Badge>
                ) : (
                  holding.type
                )}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">{holding.quantity ?? "—"}</td>
              <td className="px-3 py-3 text-right tabular-nums">
                {holding.price ? formatMoney(holding.price, holding.currency) : "—"}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">
                {formatMoney(holding.nativeValue, holding.currency)}
              </td>
              <td className="px-3 py-3 text-right font-medium tabular-nums">
                {formatMoney(holding.ilsValue)}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">{holding.allocation}</td>
              <td className="px-3 py-3">
                <span
                  className={
                    holding.source === "Broker value" ? "text-primary" : "text-muted-foreground"
                  }
                >
                  {holding.source}
                </span>
              </td>
              <td className="px-3 py-3 text-muted-foreground">{holding.asOf}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BrokerageCards({
  state,
  selected,
  grid = false,
}: {
  state: DemoState;
  selected: string | null;
  grid?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const allExpanded = expanded.size === brokerages.length;
  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold">Brokerages</h2>
          <p className="text-sm text-muted-foreground">
            Last successful holdings remain visible when a refresh fails.
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={() =>
            setExpanded(
              allExpanded ? new Set() : new Set(brokerages.map((brokerage) => brokerage.id)),
            )
          }
        >
          {allExpanded ? "Collapse all" : "Expand all"}
        </Button>
      </div>
      <div className={cn("space-y-3", grid && "grid gap-3 space-y-0 xl:grid-cols-2")}>
        {brokerages.map((brokerage, index) => {
          const open = expanded.has(brokerage.id);
          const stale = (state === "Stale" || state === "Partial") && index > 0;
          const failed = state === "Error" && brokerage.id === "schwab";
          const positionCount = brokerage.accounts.reduce(
            (sum, account) =>
              sum +
              account.holdings.filter((h) => !h.unsupported || state === "Unsupported").length,
            0,
          );
          return (
            <Card
              key={brokerage.id}
              className={cn(grid && open && "xl:col-span-2", failed && "border-negative/40")}
            >
              <button
                type="button"
                onClick={() => toggle(brokerage.id)}
                className="flex w-full items-center gap-4 p-5 text-left"
              >
                <BrokerLogo brokerage={brokerage} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{brokerage.name}</span>
                    <Badge>
                      {brokerage.mode === "automatic" ? "Automatic fetch" : "Manual statement"}
                    </Badge>
                    {stale && <Badge className="text-primary">Stale</Badge>}
                    {failed && <Badge className="text-negative">Refresh failed</Badge>}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {brokerage.accounts.length} account · {positionCount} positions ·{" "}
                    {brokerage.freshness}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-semibold tabular-nums">
                    {formatMoney(brokerage.value)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Cash {formatMoney(brokerage.cash)}
                  </span>
                </span>
                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {failed && (
                <div className="mx-5 mb-4 flex items-center justify-between rounded-[var(--radius)] border border-negative/30 bg-negative/5 p-3 text-xs">
                  <span className="text-negative">
                    <AlertTriangle className="mr-2 inline h-4 w-4" />
                    CSV columns did not match. Showing the 25 Jul snapshot.
                  </span>
                  <Button variant="outline" className="py-1">
                    Try again
                  </Button>
                </div>
              )}
              {open && (
                <div className="border-t border-border p-5">
                  {brokerage.accounts.map((account) => (
                    <div key={account.last4} className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-medium">
                            {account.name} · •••• {account.last4}
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            Native currency {account.currency}
                          </p>
                        </div>
                        <Button variant="outline" className="py-1">
                          <RefreshCw className="h-3.5 w-3.5" />
                          {brokerage.mode === "automatic" ? "Refresh" : "Import file"}
                        </Button>
                      </div>
                      <HoldingTable account={account} selected={selected} state={state} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function AsOfDialog({ point, onClose }: { point: HistoryPoint | null; onClose: () => void }) {
  const rows = point
    ? [
        ["VTI", point.vti, "USD", "Two brokerage accounts"],
        ["VWELX", point.fund, "USD", "Vanguard"],
        ["QQQ", point.qqq, "USD", "Interactive Brokers"],
        ["MSFT", point.msft, "USD", "Charles Schwab"],
        ["VGK", point.vgk, "USD", "Charles Schwab"],
        ["Cash · USD", point.cashUsd, "USD", "Three brokerage accounts"],
        ["Other", point.other, "USD", "Interactive Brokers"],
      ]
    : [];
  return (
    <Dialog
      open={point !== null}
      onClose={onClose}
      title={`As of ${point?.date ?? ""}`}
      description="Complete account snapshot; the current page remains unchanged."
      className="max-w-3xl"
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Portfolio valuation</span>
        <span className="text-lg font-semibold tabular-nums">
          {point ? formatMoney(point.total) : ""}
        </span>
      </div>
      <div className="overflow-hidden rounded-[var(--radius)] border border-border">
        {rows.map(([name, value, currency, account]) => (
          <div
            key={name}
            className="grid grid-cols-[1fr_auto] gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div>
              <p className="text-sm font-medium">{name}</p>
              <p className="text-xs text-muted-foreground">
                {account} · native {currency}
              </p>
            </div>
            <p className="text-sm tabular-nums">{formatMoney(value)}</p>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function HistoricalChart({
  compact = false,
  range,
  onRangeChange,
}: {
  compact?: boolean;
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
}) {
  const [breakdown, setBreakdown] = useState<Breakdown>("Holding");
  const [snapshot, setSnapshot] = useState<HistoryPoint | null>(null);
  const chartData = useMemo(
    () =>
      history.map((point, index) => ({
        raw: point,
        date: point.date,
        vti: Number(point.vti),
        qqq: Number(point.qqq),
        msft: Number(point.msft),
        vgk: Number(point.vgk),
        fund: Number(point.fund),
        cashUsd: Number(point.cashUsd),
        other: Number(point.other),
        ibkr: Number(point.ibkr),
        schwab: Number(point.schwab),
        vanguard: Number(point.vanguard),
        snapshotTotal: point.estimate ? undefined : Number(point.total),
        estimatedTotal: index >= history.length - 2 ? Number(point.total) : undefined,
      })),
    [],
  );
  const start = history[range.start];
  const end = history[range.end];
  const delta = BigInt(end.total) - BigInt(start.total);
  const tenths = BigInt(start.total) === 0n ? 0n : (delta * 1000n) / BigInt(start.total);
  const percent = `${tenths < 0n ? "-" : "+"}${(tenths < 0n ? -tenths : tenths) / 10n}.${(tenths < 0n ? -tenths : tenths) % 10n}%`;
  function preset(weeks: number | "all") {
    onRangeChange({
      start: weeks === "all" ? 0 : Math.max(0, history.length - 1 - weeks),
      end: history.length - 1,
    });
  }
  const holdingSeries = [
    ["vti", "VTI"],
    ["fund", "VWELX"],
    ["qqq", "QQQ"],
    ["msft", "MSFT"],
    ["vgk", "VGK"],
    ["cashUsd", "Cash · USD"],
    ["other", "Other"],
  ] as const;
  const accountSeries = [
    ["ibkr", "Interactive Brokers"],
    ["schwab", "Charles Schwab"],
    ["vanguard", "Vanguard"],
  ] as const;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">How your portfolio evolved</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Weekly broker observations; click a point for the complete snapshot.
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Valuation change</p>
          <p
            className={cn(
              "font-semibold tabular-nums",
              delta >= 0n ? "text-positive" : "text-negative",
            )}
          >
            {delta >= 0n ? "+" : ""}
            {formatMoney(delta.toString())} · {percent}
          </p>
          <p className="text-xs text-muted-foreground">Includes deposits and withdrawals</p>
        </div>
      </div>
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap justify-between gap-3">
          <div className="flex rounded-[var(--radius)] border border-border p-1">
            {(["Holding", "Account"] as Breakdown[]).map((item) => (
              <button
                type="button"
                key={item}
                onClick={() => setBreakdown(item)}
                className={cn(
                  "rounded px-3 py-1 text-xs",
                  breakdown === item ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {[
              ["3M", 13],
              ["6M", 26],
              ["1Y", 52],
              ["3Y", 156],
              ["All", "all"],
            ].map(([label, weeks]) => (
              <button
                type="button"
                key={label}
                onClick={() => preset(weeks as number | "all")}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className={compact ? "h-72" : "h-96"}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              onClick={(event) => {
                const payload = (
                  event as { activePayload?: Array<{ payload?: { raw?: HistoryPoint } }> }
                ).activePayload?.[0]?.payload?.raw;
                if (payload) setSnapshot(payload);
              }}
            >
              <defs>
                {chartColors.map((color, index) => (
                  <linearGradient
                    key={color}
                    id={`investment-fill-${index}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={color} stopOpacity={0.7} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.12} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                minTickGap={38}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                width={54}
                tickFormatter={shortMoney}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              />
              <Tooltip
                formatter={(value) => formatMoney(String(value))}
                contentStyle={{
                  background: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                }}
              />
              {(breakdown === "Holding" ? holdingSeries : accountSeries).map(
                ([key, label], index) => (
                  <Area
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={label}
                    stackId="portfolio"
                    stroke={chartColors[index]}
                    fill={`url(#investment-fill-${index})`}
                    strokeWidth={1.3}
                  />
                ),
              )}
              <Line
                type="monotone"
                dataKey="snapshotTotal"
                name="Broker snapshot total"
                stroke="var(--color-foreground)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="estimatedTotal"
                name="Estimated now"
                stroke="var(--color-foreground)"
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
                activeDot={{ r: 5 }}
              />
              <Brush
                dataKey="date"
                height={24}
                travellerWidth={10}
                startIndex={range.start}
                endIndex={range.end}
                stroke="var(--color-primary)"
                fill="var(--color-muted)"
                onChange={(next) => {
                  if (next.startIndex !== undefined && next.endIndex !== undefined)
                    onRangeChange({ start: next.startIndex, end: next.endIndex });
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>Solid: broker snapshots</span>
          <span className="border-b border-dashed border-foreground pb-0.5">
            Dotted: Estimated now
          </span>
        </div>
      </Card>
      <AsOfDialog point={snapshot} onClose={() => setSnapshot(null)} />
    </section>
  );
}

function VariantA({
  state,
  selected,
  onSelect,
  range,
  onRangeChange,
}: {
  state: DemoState;
  selected: string | null;
  onSelect: (key: string | null) => void;
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
}) {
  return (
    <div className="space-y-7">
      <header>
        <h1 className="text-2xl font-semibold">Investments</h1>
        <p className="text-sm text-muted-foreground">What you own now, and how its value evolved</p>
      </header>
      <Hero state={state} selected={selected} onSelect={onSelect} />
      <BrokerageCards state={state} selected={selected} />
      <HistoricalChart range={range} onRangeChange={onRangeChange} />
    </div>
  );
}
function VariantB({
  state,
  selected,
  onSelect,
  range,
  onRangeChange,
}: {
  state: DemoState;
  selected: string | null;
  onSelect: (key: string | null) => void;
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
}) {
  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-primary">Consolidated portfolio</p>
          <h1 className="mt-2 text-3xl font-semibold">Investments</h1>
        </div>
        <p className="max-w-sm text-right text-sm text-muted-foreground">
          Current estimates remain visibly separate from durable broker observations.
        </p>
      </header>
      <Hero mode="spotlight" state={state} selected={selected} onSelect={onSelect} />
      <BrokerageCards grid state={state} selected={selected} />
      <HistoricalChart range={range} onRangeChange={onRangeChange} />
    </div>
  );
}
function VariantC({
  state,
  selected,
  onSelect,
  range,
  onRangeChange,
}: {
  state: DemoState;
  selected: string | null;
  onSelect: (key: string | null) => void;
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
}) {
  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Investments ledger</h1>
          <p className="text-xs text-muted-foreground">
            Dense current-state review with historical evidence
          </p>
        </div>
        <Badge>Prototype C</Badge>
      </header>
      <Hero mode="dense" state={state} selected={selected} onSelect={onSelect} />
      <BrokerageCards state={state} selected={selected} />
      <HistoricalChart compact range={range} onRangeChange={onRangeChange} />
    </div>
  );
}

export function InvestmentsPrototype({ variant }: { variant: PrototypeVariant }) {
  const [state, setState] = useState<DemoState>("Current");
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<HistoryRange>({ start: 0, end: history.length - 1 });
  let content: ReactNode;
  if (state === "Empty") content = <EmptyPortfolio onStart={() => setState("Onboarding")} />;
  else if (state === "Onboarding") content = <Onboarding onDone={() => setState("Current")} />;
  else if (variant === "B")
    content = (
      <VariantB
        state={state}
        selected={selected}
        onSelect={setSelected}
        range={range}
        onRangeChange={setRange}
      />
    );
  else if (variant === "C")
    content = (
      <VariantC
        state={state}
        selected={selected}
        onSelect={setSelected}
        range={range}
        onRangeChange={setRange}
      />
    );
  else
    content = (
      <VariantA
        state={state}
        selected={selected}
        onSelect={setSelected}
        range={range}
        onRangeChange={setRange}
      />
    );
  return (
    <div className="space-y-6 pb-20">
      <PrototypeStateBar state={state} onChange={setState} />
      {state === "Unsupported" && (
        <div className="rounded-[var(--radius)] border border-primary/30 bg-primary/5 p-4 text-sm">
          <strong>Generic instrument fallback:</strong> one structured note has a broker valuation
          but no specialized analytics. It remains in totals and snapshots.
        </div>
      )}
      {content}
      <PrototypeSwitcher current={variant} />
    </div>
  );
}
