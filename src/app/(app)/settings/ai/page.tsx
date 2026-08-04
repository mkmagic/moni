import { requireSession } from "@/domain/auth";
import { getProfile } from "@/domain/profile";
import { SmartCategorizePreference } from "../smart-categorize-preference";

export default async function AiSettingsPage() {
  const session = await requireSession();
  const profile = await getProfile(session.userId);

  return (
    <div className="flex max-w-xl flex-col gap-8">
      {profile ? (
        <SmartCategorizePreference initial={profile.smartCategorize} />
      ) : (
        <p className="text-sm text-muted-foreground">Profile unavailable.</p>
      )}
    </div>
  );
}
