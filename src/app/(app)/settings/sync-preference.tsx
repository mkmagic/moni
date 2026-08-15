"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

/** Lives on the Connections tab, not Profile — it governs when Moni offers to
 * refresh these connections, so it belongs next to them. Saves on toggle: a
 * single boolean doesn't warrant its own Save button.
 *
 * The setting is a REMINDER, not automation: Moni cannot use a stored bank
 * login without the user's password, so it can only ever offer. The column is
 * still called `auto_sync_on_login` (renaming it is a migration for no
 * user-visible gain) — CONTEXT.md records that the concept is "sync
 * reminder". */
export function SyncPreference({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function onToggle(next: boolean) {
    setEnabled(next);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoSyncOnLogin: next }),
      });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setEnabled(!next); // roll back to what the server still believes
      setError("Could not save that — try again.");
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-6 px-6 pb-6 pt-6">
        {/* Capped at a readable measure — the card is full-width, and an
            unconstrained paragraph ran ~1350px across on a wide viewport. */}
        <div className="flex max-w-2xl flex-col gap-1.5">
          <span id="autoSyncLabel" className="text-sm font-medium text-foreground">
            Remind me to sync when my data is out of date
          </span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {
              "When a connection hasn't been refreshed in over 8 hours, the dashboard offers to sync it. You'll still confirm with your password — that's what unlocks your stored bank logins, and it never happens without you. You can sync any time from the dashboard, whether this is on or off."
            }
          </span>
          {error && <span className="text-xs text-negative">{error}</span>}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void onToggle(next)}
          aria-labelledby="autoSyncLabel"
          className="mt-0.5"
        />
      </div>
    </Card>
  );
}
