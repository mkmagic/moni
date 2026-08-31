import Link from "next/link";
import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { currentMonth, monthRange, monthStart, shiftMonth } from "@/domain/budget";
import { listCategories } from "@/domain/categorization";
import { getHouseholdMonthlyTotals, getHouseholdOverview } from "@/domain/household-budget";
import { listSharedCategories } from "@/domain/shared-categories";
import { Card, CardContent } from "@/components/ui/card";
import {
  HouseholdScreen,
  type HouseholdView,
  type SharedCategoryConfig,
} from "@/components/household-screen";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
// Freshness/"as of" timestamps are formatted here, server-side with a pinned
// locale, and handed across as strings — a client component that formatted a
// date would hydrate differently than it rendered (.agents/skills/ui-developer).
const AS_OF = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const SHORT_MONTH = new Intl.DateTimeFormat("en-GB", { month: "short" });
/** Months shown in the monthly bar chart (this month + the five before it). */
const CHART_WINDOW = 6;

interface HouseholdPageProps {
  searchParams: Promise<{ month?: string }>;
}

export default async function HouseholdPage({ searchParams }: HouseholdPageProps) {
  const session = await requireSession();
  await requireOnboarded(session.userId);

  const { month: requested } = await searchParams;
  const thisMonth = currentMonth();
  const month =
    requested && MONTH.test(requested) && requested <= thisMonth ? requested : thisMonth;
  const currency = session.baseCurrency;

  // Reading the overview also republishes the caller's own totals (the app-open
  // trigger) so the partner sees the caller current.
  const overviews = await getHouseholdOverview(session.userId, session.dataKey, month);

  const monthPicker = {
    monthLabel: MONTH_LABEL.format(new Date(`${monthStart(month)}T00:00:00Z`)),
    previousMonth: shiftMonth(month, -1),
    nextMonth: month < thisMonth ? shiftMonth(month, 1) : null,
  };

  if (overviews.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <Header />
        <Card>
          <CardContent className="px-6 pb-6 pt-7">
            <p className="text-sm text-muted-foreground">
              {"You're not in a household yet. "}
              <Link
                href="/settings/household"
                className="text-primary underline-offset-2 hover:underline"
              >
                Create one or join with an invite code
              </Link>
              {" to share a live budget with someone else on this Moni."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Categories are per-user, so one read serves every household's mapping
  // picker. Only expense categories can carry (or feed) a budget line.
  const expenseCategories = (await listCategories(session)).filter(
    (c) => c.classification === "expense",
  );

  const selfId = session.userId;
  const money = (amount: string) => ({ amount, currency });

  const households: HouseholdView[] = [];
  for (const ov of overviews) {
    const config = await listSharedCategories(
      session.userId,
      session.dataKey,
      ov.householdId,
      month,
    );
    // Trailing-window combined spend for the monthly bar chart.
    const chartMonths = monthRange(shiftMonth(month, -(CHART_WINDOW - 1)), month);
    const monthlyTotals = await getHouseholdMonthlyTotals(
      session.userId,
      session.dataKey,
      ov.householdId,
      chartMonths,
    );
    const monthly = monthlyTotals.map((t) => ({
      label: SHORT_MONTH.format(new Date(`${monthStart(t.month)}T00:00:00Z`)),
      combined: t.combined,
      ceiling: t.ceiling,
    }));

    const configById = new Map<string, SharedCategoryConfig>(
      config.map((c) => [
        c.id,
        {
          isRecurring: c.isRecurring,
          myLocalCategoryIds: c.myLocalCategoryIds,
          splits: c.splits,
        },
      ]),
    );

    // Stable member ordering + labels: the caller is "You"; the single other is
    // "Partner" (households are built for two — a larger one numbers the rest).
    const memberIds = ov.settlement.members.map((m) => m.memberId);
    const others = memberIds.filter((id) => id !== selfId);
    const labelOf = (id: string): string => {
      if (id === selfId) return "You";
      if (others.length <= 1) return "Partner";
      return `Partner ${others.indexOf(id) + 1}`;
    };

    households.push({
      householdId: ov.householdId,
      name: ov.name,
      selfId,
      memberIds,
      provisional: ov.budget.provisional,
      freshnessLabel: ov.budget.freshnessAsOf
        ? AS_OF.format(new Date(ov.budget.freshnessAsOf))
        : null,
      categories: ov.budget.categories.map((c) => {
        const cfg = configById.get(c.sharedCategoryId);
        return {
          sharedCategoryId: c.sharedCategoryId,
          name: c.name,
          isRecurring: cfg?.isRecurring ?? false,
          combined: money(c.combined),
          myFigure: money(c.myFigure),
          ceiling: c.ceiling ? money(c.ceiling) : null,
          provisional: c.provisional,
          members: c.perMember.map((m) => ({
            memberId: m.memberId,
            label: labelOf(m.memberId),
            amount: money(m.amount),
            asOfLabel: m.asOf ? AS_OF.format(new Date(m.asOf)) : null,
            isLive: m.isLive,
            notReported: m.notReported,
          })),
          myLocalCategoryIds: cfg?.myLocalCategoryIds ?? [],
          splits: cfg?.splits ?? [],
        };
      }),
      settlement: {
        provisional: ov.settlement.provisional,
        members: ov.settlement.members.map((m) => ({
          memberId: m.memberId,
          label: labelOf(m.memberId),
          share: money(m.share),
          paid: money(m.paid),
          net: money(m.net),
        })),
        transfers: ov.settlement.transfers.map((t) => ({
          fromLabel: labelOf(t.from),
          toLabel: labelOf(t.to),
          fromIsSelf: t.from === selfId,
          amount: money(t.amount),
        })),
        perCategory: ov.settlement.perCategory.map((p) => ({
          sharedCategoryId: p.sharedCategoryId,
          name: p.name,
          combined: money(p.combined),
          members: p.members.map((m) => ({
            label: labelOf(m.memberId),
            share: money(m.share),
            paid: money(m.paid),
          })),
        })),
      },
      monthly,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Header />
      <HouseholdScreen
        households={households}
        expenseCategories={expenseCategories}
        currency={currency}
        month={month}
        {...monthPicker}
      />
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-foreground">Household</h1>
      <p className="text-sm text-muted-foreground">
        A shared live budget and who-owes-whom, summed from what each member publishes.
      </p>
    </div>
  );
}
