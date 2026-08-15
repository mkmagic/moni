import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { getRecurringView } from "@/domain/recurring";
import { RecurringList } from "@/components/recurring-list";
import { isRecurringRange } from "@/lib/recurring/range";

export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const session = await requireSession();
  await requireOnboarded(session.userId);

  const { range } = await searchParams;
  const view = await getRecurringView(session, {
    range: isRecurringRange(range) ? range : "6m",
  });

  return (
    <RecurringList
      income={view.income}
      expenses={view.expenses}
      incomeSummary={view.incomeSummary}
      expensesSummary={view.expensesSummary}
      range={view.range}
    />
  );
}
