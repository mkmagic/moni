import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { currentMonth, getBudgetHistory } from "@/domain/budget";
import { BudgetHistory } from "@/components/budget-history";

export default async function BudgetHistoryPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);

  const view = await getBudgetHistory(session);

  return <BudgetHistory view={view} effectiveFrom={currentMonth()} />;
}
