"use client";

import { useEffect, useRef, useState } from "react";
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
  Menu,
  X,
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

/** The brand mark. `next/image`'s optimizer proxies through a mocked internal
 * request with no Host header, which src/proxy.ts's HTTPS-only gate rejects —
 * so this stays a plain <img>, in one place rather than three. */
function Logo({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/moni-icon.png" alt="" className={cn("w-auto", className)} />
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  pathname,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  pathname: string;
  /** Closes the mobile drawer once a destination is chosen. */
  onNavigate?: () => void;
}) {
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      onClick={onNavigate}
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

/** Everything below the logo — shared by the desktop rail and the mobile
 * drawer so the two can never drift apart. */
function RailNav({
  pathname,
  baseCurrency,
  onLogout,
  onNavigate,
}: {
  pathname: string;
  baseCurrency: string;
  onLogout: () => void;
  onNavigate?: () => void;
}) {
  return (
    <>
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} {...item} pathname={pathname} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="px-3 pb-2">
        <NavLink {...SETTINGS_ITEM} pathname={pathname} onNavigate={onNavigate} />
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
    </>
  );
}

export function Sidebar({ baseCurrency }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  async function onLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  // While the drawer is open: Escape closes it, the body doesn't scroll behind
  // it, focus moves into it, and focus returns to the opener when it closes.
  useEffect(() => {
    if (!open) return;
    // Capture the opener now; the cleanup runs after this render, by which
    // point the ref lint rule (rightly, in general) won't trust `.current`.
    const opener = openerRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      // Trap Tab within the dialog: the background isn't inert, so without this
      // a keyboard user could tab onto the obscured page while `aria-modal`
      // announces a modal. Cycle to the other end at each boundary, and pull
      // focus back if it has somehow escaped the panel.
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !panel.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      {/* Mobile top bar — the only way to reach nav below `md`, where the rail
          is hidden. Sticky so it survives a scrolling page. */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background px-4 py-3 md:hidden">
        <button
          ref={openerRef}
          type="button"
          aria-label="Open navigation"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Logo className="h-6" />
        <span className="text-base font-semibold text-foreground">Moni</span>
      </div>

      {/* Desktop rail — unchanged, just hidden below `md`. */}
      <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-background md:flex">
        <div className="flex flex-col gap-1 px-5 py-6">
          <div className="flex items-center gap-2.5">
            <Logo className="h-8" />
            <span className="text-base font-semibold text-foreground">Moni</span>
          </div>
          <p className="text-xs text-muted-foreground">Your finances, in one place</p>
        </div>
        <RailNav pathname={pathname} baseCurrency={baseCurrency} onLogout={onLogout} />
      </aside>

      {/* Mobile drawer — always mounted so it can slide, `inert` when closed so
          its links leave the tab order and the a11y tree. `md:hidden` keeps it
          out of the desktop layout entirely. */}
      <button
        type="button"
        aria-label="Close navigation"
        tabIndex={-1}
        onClick={() => setOpen(false)}
        aria-hidden={!open}
        className={cn(
          "fixed inset-0 z-40 bg-background/70 backdrop-blur-sm md:hidden motion-safe:transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        ref={panelRef}
        inert={!open}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          "fixed left-0 top-0 z-50 flex h-full w-64 flex-col border-r border-border bg-background md:hidden motion-safe:transition-transform",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Logo className="h-7" />
            <span className="text-base font-semibold text-foreground">Moni</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <RailNav
          pathname={pathname}
          baseCurrency={baseCurrency}
          onLogout={onLogout}
          onNavigate={() => setOpen(false)}
        />
      </aside>
    </>
  );
}
