import { requireSession } from "@/domain/auth";
import { getPortfolioOverview } from "@/domain/investments";
import { buildPerformanceView } from "./view";
import { PerformanceScreen } from "./performance-screen";
import type { PerformanceAccount } from "./types";

export default async function InvestmentPerformancePage() {
  const session = await requireSession();
  const [view, overview] = await Promise.all([
    buildPerformanceView(session),
    getPortfolioOverview(session),
  ]);
  const accounts: PerformanceAccount[] = overview.accounts.map((account) => ({
    id: account.id,
    name: account.name,
  }));
  return <PerformanceScreen initialView={view} accounts={accounts} />;
}
