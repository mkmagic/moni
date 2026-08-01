import { requireSession } from "@/domain/auth";
import { listConnections } from "@/domain/connections";
import { getPortfolioOverview } from "@/domain/investments";
import { InvestmentsScreen } from "./investments-screen";

export default async function InvestmentsPage() {
  const session = await requireSession();
  const [overview, connections] = await Promise.all([
    getPortfolioOverview(session),
    listConnections(session.userId),
  ]);

  return <InvestmentsScreen initialOverview={overview} connections={connections} />;
}
