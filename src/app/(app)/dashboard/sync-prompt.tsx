"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Shown when the user opted into "automatically sync on login" and their
 * previous sign-in was more than 8 hours ago.
 *
 * It OFFERS a sync rather than running one. That is the whole security point:
 * a silent refresh would need the credential key unwrapped at login, which
 * would collapse the two RAM windows into one and break the plan's "login
 * unwraps DK only" rule (docs plan §B). Accepting sends the user to Settings,
 * where Sync all goes through the normal 423 -> password -> arm path.
 *
 * This also makes the feature indifferent to how the user unlocked: nothing
 * here reads a password or a key, so a future WebAuthn-PRF login reaches the
 * same offer unchanged.
 */
export function SyncPrompt({ show }: { show: boolean }) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);

  if (!show || dismissed) return null;

  async function close(navigate: boolean) {
    setDismissed(true);
    // Clears the flag on the server session too, so it doesn't come back on
    // the next navigation.
    await fetch("/api/sync-prompt/dismiss", { method: "POST" }).catch(() => undefined);
    if (navigate) router.push("/settings/connections");
  }

  return (
    <Card className="border-primary/40">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div>
          <p className="text-sm font-medium text-foreground">
            {"It's been a while since you last signed in"}
          </p>
          <p className="text-xs text-muted-foreground">
            Refresh your connections to pull in any new transactions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => void close(true)} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Sync now
          </Button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => void close(false)}
            className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </Card>
  );
}
