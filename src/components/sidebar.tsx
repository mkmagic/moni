"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  ArrowLeftRight,
  Landmark,
  Settings,
  LogOut,
  PiggyBank,
  Target,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/budget", label: "Budget", icon: Target },
  { href: "/accounts", label: "Accounts", icon: Landmark },
  { href: "/investments", label: "Investments", icon: TrendingUp },
  { href: "/long-term-savings", label: "Long-term savings", icon: PiggyBank },
] as const;

// Sits at the bottom of the rail, above the account block — Connections now
// lives inside it rather than as a top-level destination.
const SETTINGS_ITEM = { href: "/settings", label: "Settings", icon: Settings } as const;

interface SidebarProps {
  baseCurrency: string;
}

function NavLink({
  href,
  label,
  icon: Icon,
  pathname,
}: {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  pathname: string;
}) {
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={cn(
        "relative flex items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-sm transition",
        active
          ? "bg-muted text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      )}
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}

export function Sidebar({ baseCurrency }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  async function onLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-background">
      <div className="flex flex-col gap-1 px-5 py-6">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image's optimizer proxies through a mocked internal request with no Host header, which src/proxy.ts's HTTPS-only gate rejects */}
          <img src="/moni-icon.png" alt="" className="h-8 w-auto" />
          <span className="text-base font-semibold text-foreground">Moni</span>
        </div>
        <p className="text-xs text-muted-foreground">Your finances, in one place</p>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} {...item} pathname={pathname} />
        ))}
      </nav>

      <div className="px-3 pb-2">
        <NavLink {...SETTINGS_ITEM} pathname={pathname} />
      </div>

      <div className="flex flex-col gap-3 border-t border-border px-4 py-4">
        <div className="flex items-center gap-2 rounded-[var(--radius)] border border-border px-3 py-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
            {baseCurrency.slice(0, 1)}
          </div>
          <span className="text-xs text-muted-foreground">Base currency {baseCurrency}</span>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          Log out
        </button>
      </div>
    </aside>
  );
}
