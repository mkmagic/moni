import { requireSession } from "@/domain/auth";
import { listConnections } from "@/domain/connections";
import { getPortfolioOverview } from "@/domain/investments";
import { readInvestmentActivity } from "@/domain/investment-activity-resolution";
import { InvestmentsScreen } from "./investments-screen";

export default async function InvestmentsPage() {
  const session = await requireSession();
  const [overview, connections, activity] = await Promise.all([
    getPortfolioOverview(session),
    listConnections(session.userId),
    readInvestmentActivity(session),
  ]);

  return (
    <InvestmentsScreen
      initialOverview={overview}
      connections={connections}
      activityAttention={activity.pendingCount > 0 ? activity.counts : null}
    />
  );
}
