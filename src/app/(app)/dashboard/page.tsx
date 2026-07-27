import { Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { requireSession } from "@/domain/auth";
import { getOverview } from "@/domain/dashboard";
import { getProfile } from "@/domain/profile";
import { requireOnboarded } from "@/domain/onboarding";
import { SyncPrompt } from "./sync-prompt";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Money } from "@/components/money";
import { Sparkline } from "@/components/sparkline";
import { StatCard } from "@/components/stat-card";
import { IncomeExpenseChart } from "@/components/income-expense-chart";
import { NeedsReviewCard } from "@/components/needs-review-card";
import { listCategories } from "@/domain/categorization";
import { listEntries } from "@/domain/transactions";

/** Time-of-day greeting from the SERVER's clock. This is a self-hosted,
 * single-household app, so the server and the household share a timezone —
 * computing it here keeps the header a server component with no hydration
 * flicker. Revisit if Moni ever runs somewhere its users don't live. */
function timeOfDay(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const [overview, profile, needsReview, categories] = await Promise.all([
    getOverview(session),
    getProfile(session.userId),
    listEntries(session, { uncategorized: true, limit: 50 }),
    listCategories(session),
  ]);

  const name = profile?.displayName?.trim();
  // One template literal, not adjacent JSX text nodes — Turbopack trims the
  // space between an expression and neighbouring text on the same line
  // (.agents/skills/ui-developer/SKILL.md, 2026-07-26).
  const greeting = name
    ? `${timeOfDay(new Date().getHours())}, ${name}, here's your financial picture`
    : `${timeOfDay(new Date().getHours())}, here's your financial picture`;

  const netWorthSeries = overview.months.map((m) => Number(m.net));
  const monthLabelFmt = new Intl.DateTimeFormat("en-US", { month: "short" });
  const monthLabels = overview.months.map((m) => {
    const [year, month] = m.month.split("-").map(Number);
    return monthLabelFmt.format(new Date(Date.UTC(year, month - 1, 1)));
  });

  return (
    <div className="flex flex-col gap-6">
      <SyncPrompt show={session.promptSyncOnLogin} />

      <div>
        <h1 className="text-2xl font-semibold text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground">{greeting}</p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-6 px-6 pb-6 pt-7 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Total Net Worth
            </span>
            <Money value={overview.netWorth} className="text-4xl font-bold text-foreground" />
            <p className="text-sm text-muted-foreground">
              Assets <Money value={overview.assetsTotal} />
            </p>
          </div>
          <div className="w-full md:w-64">
            <Sparkline
              data={netWorthSeries}
              labels={monthLabels}
              currency={overview.netWorth.currency}
              color="var(--color-chart-1)"
              height={64}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Net Worth"
          value={overview.netWorth}
          icon={Wallet}
          href="/accounts"
          labels={monthLabels}
          series={overview.months.map((m) => m.net)}
        />
        <StatCard
          label="Monthly Income"
          value={overview.monthlyIncome}
          icon={TrendingUp}
          href="/transactions"
          accent="positive"
          labels={monthLabels}
          series={overview.months.map((m) => m.income)}
        />
        <StatCard
          label="Monthly Expenses"
          value={overview.monthlyExpenses}
          icon={TrendingDown}
          href="/transactions"
          accent="negative"
          labels={monthLabels}
          series={overview.months.map((m) => m.expenses)}
        />
      </div>

      <NeedsReviewCard entries={needsReview} categories={categories} />

      <Card>
        <CardHeader>
          <CardTitle>Income vs. Expenses</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <IncomeExpenseChart months={overview.months} />
        </CardContent>
      </Card>
    </div>
  );
}
