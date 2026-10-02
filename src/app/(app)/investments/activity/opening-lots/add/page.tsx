import { requireSession } from "@/domain/auth";
import { readInvestmentResolutionItem } from "@/domain/investment-activity-resolution";
import { readOpeningLotFormOptions } from "@/domain/investment-opening-lots";
import { AddOpeningLotScreen } from "./add-opening-lot-screen";

export default async function AddOpeningLotPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const query = await searchParams;
  const queueId = typeof query.queueId === "string" ? query.queueId : null;
  const [options, origin] = await Promise.all([
    readOpeningLotFormOptions(session),
    queueId ? readInvestmentResolutionItem(session, queueId) : null,
  ]);
  return (
    <AddOpeningLotScreen
      options={options}
      origin={origin?.kind === "reconciliation_gap" ? origin : null}
      initialAccountId={
        origin?.accountId ?? (typeof query.accountId === "string" ? query.accountId : null)
      }
      initialInstrumentId={
        origin?.instrumentId ?? (typeof query.instrumentId === "string" ? query.instrumentId : null)
      }
    />
  );
}
