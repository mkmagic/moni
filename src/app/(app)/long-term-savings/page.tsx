import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { listConnections } from "@/domain/connections";
import { listLongTermSavingsAccounts } from "@/domain/long-term-savings";
import { LongTermSavingsScreen } from "./long-term-savings-screen";

export default async function LongTermSavingsPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const [accounts, connections] = await Promise.all([
    listLongTermSavingsAccounts(session),
    listConnections(session.userId),
  ]);

  return <LongTermSavingsScreen accounts={accounts} connections={connections} />;
}
