import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import {
  availableHistoryMonths,
  getBudgetMonth,
  monthEnd,
  monthStart,
  shiftMonth,
} from "@/domain/budget";
import { listCategories } from "@/domain/categorization";
import { BudgetScreen } from "@/components/budget-screen";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Formatted here, on the server, with an explicit locale — a client
 * component that formatted it would hydrate differently than it rendered
 * (.agents/skills/ui-developer). */
const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });

interface BudgetPageProps {
  searchParams: Promise<{ month?: string }>;
}

export default async function BudgetPage({ searchParams }: BudgetPageProps) {
  const session = await requireSession();
  await requireOnboarded(session.userId);

  const { month: requested } = await searchParams;
  // `new Date()` in a server component is fine; the same clock decides the
  // current month here and inside the domain layer.
  const currentMonth = new Date().toISOString().slice(0, 7);
  // A malformed or future month is dropped rather than passed through — a
  // budget for a month that hasn't happened has nothing to report.
  const month =
    requested && MONTH.test(requested) && requested <= currentMonth ? requested : currentMonth;

  const [view, categories, historyMonths] = await Promise.all([
    getBudgetMonth(session, month),
    listCategories(session),
    availableHistoryMonths(session),
  ]);

  return (
    <BudgetScreen
      view={view}
      monthLabel={MONTH_LABEL.format(new Date(`${monthStart(month)}T00:00:00Z`))}
      previousMonth={shiftMonth(month, -1)}
      nextMonth={month < currentMonth ? shiftMonth(month, 1) : null}
      monthFrom={monthStart(month)}
      monthTo={monthEnd(month)}
      isCurrentMonth={month === currentMonth}
      // Only an expense category can carry a ceiling, so the picker never
      // offers one that the domain layer would refuse.
      categories={categories.filter((category) => category.classification === "expense")}
      historyMonths={historyMonths}
    />
  );
}
