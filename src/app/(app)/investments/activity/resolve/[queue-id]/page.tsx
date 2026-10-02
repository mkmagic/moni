import { notFound } from "next/navigation";

import { requireSession } from "@/domain/auth";
import { readInvestmentResolutionItem } from "@/domain/investment-activity-resolution";
import { ResolutionScreen } from "./resolution-screen";

export default async function InvestmentResolutionPage({
  params,
}: {
  params: Promise<{ "queue-id": string }>;
}) {
  const session = await requireSession();
  const item = await readInvestmentResolutionItem(session, (await params)["queue-id"]);
  if (!item) notFound();
  return <ResolutionScreen item={item} />;
}
