"use client";

import { useEffect, useState } from "react";
import { Compass, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTour } from "./tour-provider";

/** POSTs the seen flag; failure is non-fatal — the worst case is the prompt
 * greets them once more on the next visit, never a blocked screen. */
function markSeen() {
  void fetch("/api/profile/tour-seen", { method: "POST" }).catch(() => undefined);
}

/**
 * The one-time invitation to the guided tour, shown on the dashboard to a user
 * who has never seen it (`seen` comes from `users.tour_seen_at`). Either choice
 * marks the tour seen, so it never returns on its own — a "No thanks" then
 * points them at where to replay it, since that's the one thing they'd need to
 * find later.
 *
 * A corner card, not a modal: a brand-new user's very first act shouldn't be
 * dismissing a dialog to reach their own dashboard.
 */
export function TourFirstRun({ seen }: { seen: boolean }) {
  const { startTour } = useTour();
  const [phase, setPhase] = useState<"prompt" | "declined" | "gone">(seen ? "gone" : "prompt");

  // Auto-retire the "you can replay it later" pointer after a few seconds.
  useEffect(() => {
    if (phase !== "declined") return;
    const t = window.setTimeout(() => setPhase("gone"), 7000);
    return () => window.clearTimeout(t);
  }, [phase]);

  if (phase === "gone") return null;

  if (phase === "declined") {
    return (
      <Corner onClose={() => setPhase("gone")}>
        <p className="text-sm text-muted-foreground">
          No problem. You can replay the tour anytime from{" "}
          <span className="font-medium text-foreground">Settings › Help</span>.
        </p>
      </Corner>
    );
  }

  return (
    <Corner onClose={() => setPhase("gone")}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-primary/15 text-primary">
          <Compass className="h-5 w-5" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-foreground">Take a quick tour?</p>
          <p className="text-sm text-muted-foreground">
            A one-minute walk through what Moni can do and where to find it.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            markSeen();
            setPhase("declined");
          }}
        >
          No thanks
        </Button>
        <Button
          type="button"
          onClick={() => {
            markSeen();
            setPhase("gone");
            startTour();
          }}
        >
          Start tour
        </Button>
      </div>
    </Corner>
  );
}

/** The shared bottom-right container: a small card that floats above the page
 * on desktop and sits inline-safe on a phone. */
function Corner({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[min(340px,calc(100vw-32px))] flex-col gap-4 rounded-[var(--radius)] border border-border bg-card p-5 shadow-lg">
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="absolute right-2 top-2 rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}
