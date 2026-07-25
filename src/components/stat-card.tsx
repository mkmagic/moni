import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Money } from "@/components/money";
import { Sparkline } from "@/components/sparkline";
import { cn } from "@/lib/utils";
import type { Money as MoneyValue } from "@/lib/money";

interface StatCardProps {
  label: string;
  value: MoneyValue;
  icon: LucideIcon;
  /** Where the card links to (net worth -> accounts, income/expenses -> transactions). */
  href: string;
  series?: string[];
  /** Per-point labels for the sparkline hover tooltip (e.g. month names). */
  labels?: string[];
  accent?: "positive" | "negative" | "default";
}

const ACCENT_TEXT: Record<NonNullable<StatCardProps["accent"]>, string> = {
  positive: "text-positive",
  negative: "text-negative",
  default: "text-foreground",
};

const ACCENT_CHART: Record<NonNullable<StatCardProps["accent"]>, string> = {
  positive: "var(--color-chart-2)",
  negative: "var(--color-chart-3)",
  default: "var(--color-chart-1)",
};

export function StatCard({
  label,
  value,
  icon: Icon,
  href,
  series,
  labels,
  accent = "default",
}: StatCardProps) {
  // Chart-edge conversion only — the domain layer still returned exact decimal strings.
  const numericSeries = series?.map((s) => Number(s));

  return (
    <Link href={href} className="card-link">
      {/* `card-glow`/`card-glow-top` styles live in globals.css — a documented
          hover-glow exception for clickable cards (ui-and-feel.md §6). */}
      <Card className="card-glow relative overflow-hidden">
        <span
          aria-hidden
          className="card-glow-top pointer-events-none absolute inset-x-0 top-0 h-px"
        />
        <CardContent className="flex flex-col gap-4 px-5 pb-5 pt-6">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </span>
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-[var(--radius)] bg-muted",
                ACCENT_TEXT[accent],
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </div>
          </div>
          <Money value={value} className={cn("text-2xl font-bold", ACCENT_TEXT[accent])} />
          {numericSeries && numericSeries.length > 1 && (
            <Sparkline
              data={numericSeries}
              labels={labels}
              currency={value.currency}
              color={ACCENT_CHART[accent]}
            />
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
