import { Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { requireSession } from "@/domain/auth";
import { getOverview } from "@/domain/dashboard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Money } from "@/components/money";
import { Sparkline } from "@/components/sparkline";
import { StatCard } from "@/components/stat-card";
import { IncomeExpenseChart } from "@/components/income-expense-chart";

export default async function DashboardPage() {
  const session = await requireSession();
  const overview = await getOverview(session);

  const netWorthSeries = overview.months.map((m) => Number(m.net));
  const monthLabelFmt = new Intl.DateTimeFormat("en-US", { month: "short" });
  const monthLabels = overview.months.map((m) => {
    const [year, month] = m.month.split("-").map(Number);
    return monthLabelFmt.format(new Date(Date.UTC(year, month - 1, 1)));
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground">Here&apos;s your financial picture</p>
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
