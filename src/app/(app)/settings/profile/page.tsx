import { requireSession } from "@/domain/auth";
import { getProfile } from "@/domain/profile";
import { Card } from "@/components/ui/card";
import { ProfileForm } from "../profile-form";
import { DeleteAccount } from "../delete-account";

export default async function ProfileSettingsPage() {
  const session = await requireSession();
  const profile = await getProfile(session.userId);

  return (
    <div className="flex max-w-xl flex-col gap-8">
      <Card>
        <div className="px-6 pb-7 pt-7">
          {profile ? (
            <ProfileForm email={profile.email} displayName={profile.displayName} />
          ) : (
            <p className="text-sm text-muted-foreground">Profile unavailable.</p>
          )}
        </div>
      </Card>

      {/* Last on the tab, in its own card — a destructive control should not
          sit inside the form you use to change your name. */}
      <Card>
        <DeleteAccount />
      </Card>
    </div>
  );
}
