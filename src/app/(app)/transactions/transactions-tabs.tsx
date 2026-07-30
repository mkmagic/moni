"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Receipt, Filter, Tags, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/transactions", label: "Transactions", icon: Receipt },
  { href: "/transactions/recurring", label: "Recurring", icon: Repeat },
  { href: "/transactions/categories", label: "Categories", icon: Tags },
  { href: "/transactions/rules", label: "Rules", icon: Filter },
] as const;

/** Route-based tabs, matching settings-tabs.tsx: each tab stays a server
 * component reading through the domain layer, and both are deep-linkable. */
export function TransactionsTabs() {
  const pathname = usePathname();

  return (
    <div className="flex gap-1 border-b border-border">
      {TABS.map(({ href, label, icon: Icon }) => {
        // "/transactions" must not light up while on "/transactions/rules",
        // so the parent tab matches exactly rather than by prefix.
        const active = href === "/transactions" ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition",
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
  );
}
