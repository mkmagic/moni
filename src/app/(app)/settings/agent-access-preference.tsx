"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

/**
 * Master opt-in for agent (MCP) access (issue #113 Phase 5). Off is a kill
 * switch: while it is off no token can be minted and every existing token
 * fails closed on its next call. Per-user — enabling it only ever touches this
 * account's own data key.
 */
export function AgentAccessPreference({ initial }: { initial: boolean }) {
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
        body: JSON.stringify({ agentAccessEnabled: next }),
      });
      if (!res.ok) throw new Error();
      // Re-read the server component so the token panel appears/disappears.
      router.refresh();
    } catch {
      setEnabled(!next); // roll back
      setError("Could not save that — try again.");
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-6 px-6 pb-6 pt-6">
        <div className="flex max-w-2xl flex-col gap-1.5">
          <span id="agentAccessLabel" className="text-sm font-medium text-foreground">
            Agent access (MCP)
          </span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            Let an AI agent read this account&apos;s finances on your behalf through a token, even
            while you&apos;re away. Read-only — an agent can never move money, change data, or reach
            your bank logins. Turn this off to disable every token at once.
          </span>
          {error && <span className="text-xs text-negative">{error}</span>}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void onToggle(next)}
          aria-labelledby="agentAccessLabel"
          className="mt-0.5"
        />
      </div>
    </Card>
  );
}
