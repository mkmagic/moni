"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Money } from "@/components/money";
import type { Money as MoneyValue } from "@/lib/money";
import { cn } from "@/lib/utils";

interface NetWorthAmountProps {
  value: MoneyValue;
  /** Applied to the figure so masked and revealed states share one size. */
  className?: string;
}

/**
 * The net-worth hero figure, hidden by default and revealed on demand — like a
 * password field. Kept client-side so the toggle is instant and never round-
 * trips: the value is already in the DOM, so this is a display convenience for
 * over-the-shoulder privacy, not a security boundary.
 */
export function NetWorthAmount({ value, className }: NetWorthAmountProps) {
  const [visible, setVisible] = useState(false);
  const toggle = () => setVisible((v) => !v);

  return (
    <div className="flex items-center gap-2">
      {visible ? (
        <Money value={value} className={className} />
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-label="Show net worth"
          className={cn(
            "tracking-widest text-muted-foreground",
            "rounded transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring",
            className,
          )}
        >
          <span aria-hidden>••••••</span>
        </button>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-label={visible ? "Hide net worth" : "Show net worth"}
        aria-pressed={visible}
        className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {visible ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
}
