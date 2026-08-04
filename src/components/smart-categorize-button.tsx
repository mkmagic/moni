"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SmartCategorizeButtonProps {
  /** Distinct uncategorized match texts needing lookup. */
  count: number;
}

export function SmartCategorizeButton({ count }: SmartCategorizeButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/smart-categorize", {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to smart categorize");
      }
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        disabled={loading || count === 0}
        onClick={() => void onClick()}
        className="gap-1.5 px-3 py-1.5 text-xs font-medium"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5 text-primary" />
        )}
        {count > 0 ? `Smart Categorize (${count})` : "Smart Categorize"}
      </Button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
