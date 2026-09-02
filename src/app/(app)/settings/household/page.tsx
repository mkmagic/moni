import { requireSession } from "@/domain/auth";
import { householdSummaries } from "@/domain/household";
import { HouseholdSettingsPanel, type HouseholdRow } from "./household-settings-panel";

// The setup surface for household sharing (issue #115): create a household,
// invite a partner (one-time secret), or join one with an invite code. The
// combined budget and settlement live on their own top-level /household view;
// this tab is only the plumbing that gets two people into the same room.
export default async function HouseholdSettingsPage() {
  const session = await requireSession();
  // Roster + shared-line names are group-readable structural data — no data
  // key needed here (the encrypted figures are only read on the /household view).
  const summaries = await householdSummaries(session.userId);

  const households: HouseholdRow[] = summaries.map((h) => ({
    householdId: h.householdId,
    name: h.name,
    memberCount: h.memberCount,
    sharedCategoryNames: h.sharedCategoryNames,
  }));

  return (
    <div className="flex max-w-xl flex-col gap-8">
      <HouseholdSettingsPanel households={households} />
    </div>
  );
}
