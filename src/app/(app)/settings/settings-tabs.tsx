"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { User, Plug, Sparkles, Users, LifeBuoy } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/settings/profile", label: "Profile", icon: User },
  { href: "/settings/connections", label: "Connections", icon: Plug },
  { href: "/settings/household", label: "Household", icon: Users },
  { href: "/settings/ai", label: "AI & MCP", icon: Sparkles },
  { href: "/settings/help", label: "Help", icon: LifeBuoy },
] as const;

/** Route-based tabs rather than client state: each tab stays a server
 * component that reads through the domain layer, and every tab is
 * deep-linkable (the login sync offer sends the user straight to
 * /settings/connections). */
export function SettingsTabs() {
  const pathname = usePathname();

  return (
    // Scrolls sideways within itself on a narrow screen rather than pushing the
    // page into horizontal overflow; `w-max min-w-full` keeps the underline
    // full-width at desktop. Mirrors transactions-tabs.tsx.
    <div className="overflow-x-auto">
      <div className="flex w-max min-w-full gap-1 border-b border-border">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
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
