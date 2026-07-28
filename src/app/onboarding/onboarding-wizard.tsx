"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConnectFlow } from "@/components/connect-flow";

/** Connect one or more institutions (each synced as it's added), then the
 * sync-reminder question. The connection loop lives in ConnectFlow, shared
 * with Settings -> Add connection. */
export function OnboardingWizard({ today }: { today: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"connect" | "reminder">("connect");

  if (phase === "connect") {
    return (
      <Card>
        <div className="p-6">
          <ConnectFlow
            today={today}
            allowAddAnother
            doneLabel="Continue"
            onDone={() => setPhase("reminder")}
            pickIntro={
              <div>
                <h2 className="text-base font-semibold text-foreground">Connect an account</h2>
                <p className="text-sm text-muted-foreground">
                  Pick where your money lives. You can add as many as you like.
                </p>
              </div>
            }
          />
        </div>
      </Card>
    );
  }

  return <SyncReminderStep onFinish={() => router.push("/dashboard")} />;
}

/**
 * The last onboarding step: opt into the sync reminder. Pre-selected on —
 * it only ever produces an OFFER to sync (never a silent one, and never a use
 * of a stored bank login without the password), so the cost of a default-on
 * is one dismissible card after a long absence.
 */
function SyncReminderStep({ onFinish }: { onFinish: () => void }) {
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoSyncOnLogin: enabled }),
      });
      if (!res.ok) throw new Error();
      onFinish();
    } catch {
      setError("Could not save that — try again.");
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h2 className="text-base font-semibold text-foreground">One last thing</h2>
          <p className="text-sm text-muted-foreground">
            You can change this whenever you like, under Settings.
          </p>
        </div>
        <div className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-1.5">
            <span id="onboardingSyncReminder" className="text-sm font-medium text-foreground">
              Remind me to sync when I sign in
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {
                "After you've been away a while, Moni offers to refresh every connection. You'll still confirm with your password — that's what unlocks your stored bank logins, and it never happens without you."
              }
            </span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-labelledby="onboardingSyncReminder"
            className="mt-0.5"
          />
        </div>
        {error && <p className="text-xs text-negative">{error}</p>}
        <Button type="button" onClick={() => void finish()} disabled={saving} className="self-end">
          {saving ? "Saving…" : "Go to dashboard"}
        </Button>
      </div>
    </Card>
  );
}
