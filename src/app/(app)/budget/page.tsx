import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import {
  availableHistoryMonths,
  currentMonth,
  getBudgetMonth,
  monthEnd,
  monthStart,
  shiftMonth,
} from "@/domain/budget";
import { listCategories } from "@/domain/categorization";
import { getHouseholdOverview } from "@/domain/household-budget";
import { BudgetScreen, type SharedBudgetSummary } from "@/components/budget-screen";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Formatted here, on the server, with an explicit locale — a client
 * component that formatted it would hydrate differently than it rendered
 * (.agents/skills/ui-developer). */
const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
const AS_OF = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

interface BudgetPageProps {
  searchParams: Promise<{ month?: string }>;
}

export default async function BudgetPage({ searchParams }: BudgetPageProps) {
  const session = await requireSession();
  await requireOnboarded(session.userId);

  const { month: requested } = await searchParams;
  // The domain layer's own clock, not a UTC slice — on the 1st of a month
  // before ~02:00 Israel time the two disagree, and this page would default
  // to the previous month while calling it current.
  const thisMonth = currentMonth();
  // A malformed or future month is dropped rather than passed through — a
  // budget for a month that hasn't happened has nothing to report.
  const month =
    requested && MONTH.test(requested) && requested <= thisMonth ? requested : thisMonth;

  const [view, categories, historyMonths, overviews] = await Promise.all([
    getBudgetMonth(session, month),
    listCategories(session),
    availableHistoryMonths(session),
    // Empty when the user is in no household. Also republishes the caller's own
    // shared totals (the app-open trigger), same as the /household view.
    getHouseholdOverview(session.userId, session.dataKey, month),
  ]);

  return (
    <BudgetScreen
      view={view}
      monthLabel={MONTH_LABEL.format(new Date(`${monthStart(month)}T00:00:00Z`))}
      previousMonth={shiftMonth(month, -1)}
      nextMonth={month < thisMonth ? shiftMonth(month, 1) : null}
      monthFrom={monthStart(month)}
      monthTo={monthEnd(month)}
      isCurrentMonth={month === thisMonth}
      // Only an expense category can carry a ceiling, so the picker never
      // offers one that the domain layer would refuse.
      categories={categories.filter((category) => category.classification === "expense")}
      historyMonths={historyMonths}
      shared={buildSharedSummary(overviews, session.userId, session.baseCurrency)}
    />
  );
}

/**
 * Flattens the household overview into the read-only "Shared with your
 * household" section on the personal budget (comment #1: a shared category
 * shows your own spend, flagged shared, with the combined figure and your
 * share beside it). Editing happens on the /household view, not here. Returns
 * null when there are no shared categories.
 */
function buildSharedSummary(
  overviews: Awaited<ReturnType<typeof getHouseholdOverview>>,
  selfId: string,
  currency: string,
): SharedBudgetSummary | null {
  const money = (amount: string) => ({ amount, currency });
  const categories: SharedBudgetSummary["categories"] = [];
  let anyProvisional = false;
  let oldest: string | null = null;

  for (const ov of overviews) {
    // My share per category, read from the settlement's per-category breakdown.
    const myShare = new Map<string, string>();
    for (const p of ov.settlement.perCategory) {
      const mine = p.members.find((m) => m.memberId === selfId);
      if (mine) myShare.set(p.sharedCategoryId, mine.share);
    }

    if (ov.budget.provisional) anyProvisional = true;
    if (ov.budget.freshnessAsOf && (oldest === null || ov.budget.freshnessAsOf < oldest)) {
      oldest = ov.budget.freshnessAsOf;
    }

    for (const c of ov.budget.categories) {
      categories.push({
        sharedCategoryId: c.sharedCategoryId,
        name: c.name,
        myFigure: money(c.myFigure),
        combined: money(c.combined),
        ceiling: c.ceiling ? money(c.ceiling) : null,
        myShare: money(myShare.get(c.sharedCategoryId) ?? "0"),
        provisional: c.provisional,
      });
    }
  }

  if (categories.length === 0) return null;
  return {
    categories,
    provisional: anyProvisional,
    freshnessLabel: oldest ? AS_OF.format(new Date(oldest)) : null,
  };
}
