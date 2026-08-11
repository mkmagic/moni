import type { ReactNode } from "react";
import {
  TrendingUp,
  TrendingDown,
  Inbox,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { requireSession } from "@/domain/auth";
import { getOverview, type Trend } from "@/domain/dashboard";
import { getProfile } from "@/domain/profile";
import { requireOnboarded } from "@/domain/onboarding";
import { listConnections } from "@/domain/connections";
import { DashboardSync } from "./dashboard-sync";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/money";
import { Sparkline } from "@/components/sparkline";
import { InsightPanel, type InsightItem } from "@/components/insight-panel";
import { ThisMonthCard } from "@/components/this-month-card";
import { NeedsReviewCard } from "@/components/needs-review-card";
import { listCategories, suggestCategories } from "@/domain/categorization";
import { listEntries } from "@/domain/transactions";
import { getBudgetSummary, type OverBudgetCategory } from "@/domain/budget";
import { cn } from "@/lib/utils";

/** Time-of-day greeting from the SERVER's clock. This is a self-hosted,
 * single-household app, so the server and the household share a timezone —
 * computing it here keeps the header a server component with no hydration
 * flicker. Revisit if Moni ever runs somewhere its users don't live. */
function timeOfDay(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** A sync older than this is nagged about rather than noted quietly. */
const STALE_SYNC_DAYS = 7;

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

function lastSyncLabel(days: number): string {
  if (days <= 0) return "Last synced today";
  if (days === 1) return "Last synced yesterday";
  return `Last synced ${days} days ago`;
}

/** The spending-trend row, shared by both day states. Down is good (teal), up
 * is coral — the comparison is like-for-like (see `Overview.expenseTrend`). */
function spendingItem(trend: Trend): InsightItem {
  const down = trend.direction === "down";
  return {
    tone: down ? "good" : "warning",
    icon: down ? TrendingDown : TrendingUp,
    content: (
      <>
        Spending {down ? "down" : "up"}{" "}
        <span className="font-medium tabular-nums">{trend.pct}%</span> vs the same point last month
      </>
    ),
  };
}

/** "2 categories over budget — Groceries, Dining" — names the worst offenders
 * inline rather than only counting them. */
function overBudgetContent(over: OverBudgetCategory[], count: number): ReactNode {
  const shown = over.slice(0, 2);
  return (
    <>
      <span className="font-medium tabular-nums">{count}</span> categor{count === 1 ? "y" : "ies"}{" "}
      over budget
      {shown.length > 0 && (
        <>
          {" — "}
          {shown.map((c, i) => (
            <span key={c.categoryId ?? "residual"}>
              {i > 0 && ", "}
              <bdi>{c.categoryName}</bdi>
            </span>
          ))}
          {over.length > shown.length && ", …"}
        </>
      )}
    </>
  );
}

export default async function DashboardPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const [overview, profile, needsReview, categories, connections, budget] = await Promise.all([
    getOverview(session),
    getProfile(session.userId),
    listEntries(session, { uncategorized: true, limit: 50 }),
    listCategories(session),
    listConnections(session.userId),
    getBudgetSummary(session),
  ]);

  // The queue is already only uncategorized entries, so every row here is a
  // suggestion candidate.
  const suggestions = await suggestCategories(
    session,
    needsReview.map((e) => ({ id: e.id, matchText: e.matchText })),
  );

  const name = profile?.displayName?.trim();
  // One template literal, not adjacent JSX text nodes — Turbopack trims the
  // space between an expression and neighbouring text on the same line
  // (.agents/skills/ui-developer/SKILL.md, 2026-07-26).
  const greeting = name
    ? `${timeOfDay(new Date().getHours())}, ${name}, here's your financial picture`
    : `${timeOfDay(new Date().getHours())}, here's your financial picture`;

  const netWorthSeries = overview.netWorthHistory.map((point) => Number(point.amount));
  const monthLabelFmt = new Intl.DateTimeFormat("en-US", { month: "short" });
  const monthLongFmt = new Intl.DateTimeFormat("en-US", { month: "long" });
  const netWorthLabels = overview.netWorthHistory.map((point) => {
    const [year, month] = point.month.split("-").map(Number);
    return monthLabelFmt.format(new Date(Date.UTC(year, month - 1, 1)));
  });
  const [curYear, curMonth] = overview.currentMonth.split("-").map(Number);
  const monthLabel = monthLongFmt.format(new Date(Date.UTC(curYear, curMonth - 1, 1)));

  // --- Last sync -------------------------------------------------------------
  // The dashboard is only as current as its STALEST source: a bank synced today
  // beside a week-old or never-synced connection still leaves it missing that
  // source's data. So freshness is judged per connection and the stale ones are
  // surfaced — never hidden behind the freshest sync.
  let syncMeta: string | undefined;
  let syncItem: InsightItem | undefined;
  if (connections.length > 0) {
    const staleCount = connections.filter(
      (c) => c.lastSyncAt == null || daysSince(c.lastSyncAt) >= STALE_SYNC_DAYS,
    ).length;
    const freshestTime = connections
      .map((c) => c.lastSyncAt)
      .filter((d): d is Date => d != null)
      .reduce((max, d) => Math.max(max, d.getTime()), 0);

    if (staleCount > 0) {
      syncItem = {
        tone: "warning",
        icon: RefreshCw,
        content:
          staleCount === 1 ? (
            "A connection is out of date"
          ) : (
            <>
              <span className="font-medium tabular-nums">{staleCount}</span> connections are out of
              date
            </>
          ),
        href: "/settings/connections",
        linkLabel: "Sync",
      };
    } else {
      // Every connection is fresh, so the most recent sync represents them all.
      syncMeta = lastSyncLabel(daysSince(new Date(freshestTime)));
    }
  }

  // --- Insight items ---------------------------------------------------------
  const busyItems: InsightItem[] = [];
  if (needsReview.length > 0) {
    busyItems.push({
      tone: "action",
      icon: Inbox,
      // No link — the "Needs categorizing" card sits directly below.
      content: (
        <>
          <span className="font-medium tabular-nums">{needsReview.length}</span> transaction
          {needsReview.length === 1 ? "" : "s"} to categorize
        </>
      ),
    });
  }
  if (budget.overBudgetCount > 0) {
    busyItems.push({
      tone: "warning",
      icon: AlertTriangle,
      content: overBudgetContent(budget.overCategories, budget.overBudgetCount),
      href: "/budget",
      linkLabel: "Budget",
    });
  }
  if (overview.expenseTrend) busyItems.push(spendingItem(overview.expenseTrend));
  if (syncItem) busyItems.push(syncItem);

  const clearItems: InsightItem[] = [
    { tone: "good", icon: CheckCircle2, content: "Everything's categorized" },
    { tone: "good", icon: CheckCircle2, content: "No categories over budget" },
  ];
  if (overview.expenseTrend) clearItems.push(spendingItem(overview.expenseTrend));
  if (overview.netWorthTrend) {
    const up = overview.netWorthTrend.direction === "up";
    clearItems.push({
      tone: up ? "good" : "neutral",
      icon: up ? TrendingUp : TrendingDown,
      content: (
        <>
          Net worth {up ? "up" : "down"}{" "}
          <span className="font-medium tabular-nums">{overview.netWorthTrend.pct}%</span> over six
          months
        </>
      ),
    });
  }
  if (syncItem) clearItems.push(syncItem);

  // --- Net worth hero + the month's figures, grouped -------------------------
  const health = (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="flex flex-col justify-between gap-6 px-6 pb-6 pt-7">
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Total Net Worth
            </span>
            {overview.netWorthTrend && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-sm tabular-nums",
                  overview.netWorthTrend.direction === "up" ? "text-positive" : "text-negative",
                )}
              >
                {overview.netWorthTrend.direction === "up" ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                {overview.netWorthTrend.pct}% · 6mo
              </span>
            )}
          </div>
          <Money value={overview.netWorth} className="text-4xl font-bold text-foreground" />
          <p className="text-sm text-muted-foreground">
            Assets <Money value={overview.assetsTotal} />
          </p>
        </div>
        <Sparkline
          data={netWorthSeries}
          labels={netWorthLabels}
          currency={overview.netWorth.currency}
          color="var(--color-chart-1)"
          height={64}
        />
      </Card>

      <ThisMonthCard
        monthLabel={monthLabel}
        income={overview.monthlyIncome}
        expenses={overview.monthlyExpenses}
        expenseTrend={overview.expenseTrend}
        budget={budget}
        months={overview.months}
      />
    </div>
  );

  const reviewCard = needsReview.length > 0 && (
    <NeedsReviewCard
      entries={needsReview}
      categories={categories}
      suggestions={suggestions}
      smartCategorizeEnabled={Boolean(profile?.smartCategorize)}
    />
  );

  // The top of the dashboard adapts: when there's something to act on, the
  // summary panel and the review queue lead and net worth follows; on a clear
  // day net worth and the graphs lead and the summary drops to a calm footer.
  const hasWork = needsReview.length > 0 || budget.overBudgetCount > 0;

  return (
    <div className="flex flex-col gap-6">
      <DashboardSync
        connectionIds={connections.map((c) => c.id)}
        importConnections={connections.filter((c) => c.mode === "user_mediated_import")}
        showReminder={session.promptSyncOnLogin}
        title="Overview"
        greeting={greeting}
      />

      {hasWork ? (
        <>
          <InsightPanel heading="Needs you today" items={busyItems} lastSync={syncMeta} />
          {reviewCard}
          {health}
        </>
      ) : (
        <>
          {health}
          <InsightPanel heading="All caught up" calm items={clearItems} lastSync={syncMeta} />
        </>
      )}
    </div>
  );
}
