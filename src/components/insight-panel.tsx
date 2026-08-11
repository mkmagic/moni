import Link from "next/link";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Tone drives the row's icon colour, borrowed from the money signal:
 * `action` is the one amber accent (a thing to do), `warning` coral,
 * `good` teal, `neutral` blue. Amber stays single-per-view: only ever one
 * `action` row (docs/design/ui-and-feel.md §2).
 */
export type InsightTone = "action" | "warning" | "good" | "neutral";

export interface InsightItem {
  tone: InsightTone;
  icon: LucideIcon;
  /** The fact, already formatted — may hold `<Money>` / `<bdi>`. */
  content: ReactNode;
  /** An optional destination; renders a muted link on the right. */
  href?: string;
  linkLabel?: string;
}

interface InsightPanelProps {
  /** A quiet uppercase eyebrow: "Needs you today" / "All caught up". */
  heading: string;
  /** Coloured teal when nothing needs the user — a calm footer, not an alert. */
  calm?: boolean;
  items: InsightItem[];
  /**
   * The last-sync line, pre-formatted on the server (a client component must
   * not format a date — it hydrates differently than it renders). Shown as a
   * quiet footer; when sync is stale the caller promotes it into `items`
   * instead, so this stays absent then.
   */
  lastSync?: string;
}

const TONE_CHIP: Record<InsightTone, string> = {
  action: "bg-primary/15 text-primary",
  warning: "bg-negative/15 text-negative",
  good: "bg-positive/15 text-positive",
  neutral: "bg-transfer/15 text-transfer",
};

/**
 * The dashboard's summary panel: one card holding a short feed of the things
 * that changed or need action, each a quiet notification row rather than a
 * button. Server component — the rows are plain links, no client state.
 */
export function InsightPanel({ heading, calm = false, items, lastSync }: InsightPanelProps) {
  return (
    <Card className="flex flex-col gap-3 px-5 py-4">
      <p
        className={cn(
          "text-xs font-medium uppercase tracking-wide",
          calm ? "text-positive" : "text-muted-foreground",
        )}
      >
        {heading}
      </p>

      <div className="flex flex-col">
        {items.map((item, i) => {
          const Icon = item.icon;
          return (
            <div
              key={i}
              className={cn(
                "flex items-center gap-3 py-2.5",
                i < items.length - 1 && "border-b border-border",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius)]",
                  TONE_CHIP[item.tone],
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 text-sm text-foreground">{item.content}</span>
              {item.href && (
                <Link
                  href={item.href}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
                >
                  {item.linkLabel}
                  <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          );
        })}
      </div>

      {lastSync && (
        <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3" />
          <span>{lastSync}</span>
        </div>
      )}
    </Card>
  );
}
