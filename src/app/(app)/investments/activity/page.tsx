import { requireSession } from "@/domain/auth";
import { readInvestmentActivity } from "@/domain/investment-activity-resolution";
import { ActivityScreen } from "./activity-screen";

export default async function InvestmentActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const [view, query] = await Promise.all([readInvestmentActivity(session), searchParams]);
  const resolved = typeof query.resolved === "string" ? query.resolved : null;
  const imported = typeof query.imported === "string" ? query.imported : null;
  const highlightedAccountIds =
    typeof query.accounts === "string" ? query.accounts.split(",").filter(Boolean) : [];
  const added = query.added === "1";
  const notice = resolved
    ? "Sale allocation confirmed. The resolution is retained below for audit."
    : imported
      ? `${imported} opening lots imported. Reconciliation was re-checked synchronously.`
      : added
        ? "Opening lot added. Reconciliation was re-checked synchronously."
        : null;
  return (
    <ActivityScreen
      view={view}
      notice={notice}
      highlightedResolutionId={resolved}
      highlightedAccountIds={highlightedAccountIds}
    />
  );
}
