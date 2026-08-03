"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

export function SmartCategorizePreference({ initial }: { initial: boolean }) {
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
        body: JSON.stringify({ smartCategorize: next }),
      });
      if (!res.ok) throw new Error();
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
          <span id="smartCategorizeLabel" className="text-sm font-medium text-foreground">
            Smart Categorize with AI
          </span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            Send unrecognized merchant names to an AI model to suggest categories. Merchant names
            only — never amounts, dates, or accounts.
          </span>
          {error && <span className="text-xs text-negative">{error}</span>}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void onToggle(next)}
          aria-labelledby="smartCategorizeLabel"
          className="mt-0.5"
        />
      </div>
    </Card>
  );
}
