import { requireSession } from "@/domain/auth";
import { getProfile } from "@/domain/profile";
import { Card } from "@/components/ui/card";
import { ProfileForm } from "../profile-form";

export default async function ProfileSettingsPage() {
  const session = await requireSession();
  const profile = await getProfile(session.userId);

  return (
    <Card className="max-w-xl">
      <div className="px-6 pb-7 pt-7">
        {profile ? (
          <ProfileForm email={profile.email} displayName={profile.displayName} />
        ) : (
          <p className="text-sm text-muted-foreground">Profile unavailable.</p>
        )}
      </div>
    </Card>
  );
}
