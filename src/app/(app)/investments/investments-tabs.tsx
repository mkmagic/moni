"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PieChart, TrendingUp, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/investments", label: "Overview", icon: PieChart },
  { href: "/investments/performance", label: "Performance", icon: TrendingUp },
  { href: "/investments/activity", label: "Activity & lots", icon: ListChecks },
] as const;

/** Route-based sub-navigation, matching budget-tabs.tsx: each destination stays
 * a server component reading through the domain layer, and every tab is
 * deep-linkable (a Partial figure's details link jumps straight to the queue). */
export function InvestmentsTabs() {
  const pathname = usePathname();

  return (
    // Scrolls sideways within itself on a narrow screen rather than pushing the
    // page into horizontal overflow; mirrors settings-tabs.tsx.
    <div className="overflow-x-auto">
      <div className="flex w-max min-w-full gap-1 border-b border-border">
        {TABS.map(({ href, label, icon: Icon }) => {
          // "/investments" must not light up while on a child route, so the
          // Overview tab matches exactly rather than by prefix.
          const active = href === "/investments" ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
