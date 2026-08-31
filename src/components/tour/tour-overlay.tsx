"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { X, ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TourStep } from "./steps";

/** Padding around the spotlit element, and the gap between it and the card. */
const SPOTLIGHT_PAD = 8;
const CARD_GAP = 12;
const CARD_WIDTH = 320;
const VIEWPORT_MARGIN = 12;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The tour's chrome: a click-blocking dim, a spotlight cut around the current
 * step's anchor, and the card of copy. Rendered only while the tour is active
 * (the provider mounts/unmounts it), so it holds no "is the tour open" state.
 *
 * Navigation lives here rather than in the provider because a stop's anchor
 * only exists once its route has painted: this effect drives `router.push` to
 * the step's route, then polls for the element before measuring it.
 */
export function TourOverlay({
  step,
  index,
  total,
  onNext,
  onPrev,
  onClose,
}: {
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ width: CARD_WIDTH, height: 200 });

  // Drive the route to this step's page. The overlay is remounted per step
  // (keyed on step.id in the provider), so `rect` starts null each step — no
  // manual clearing is needed when the route or anchor changes.
  const onRoute = pathname === step.route;
  useEffect(() => {
    if (!onRoute) router.push(step.route);
  }, [onRoute, step.route, router]);

  // Measure the anchor once we're on its route. The element may not have
  // painted yet (a server component streaming in after navigation), so poll a
  // few frames before giving up and letting the card center itself.
  const measure = useCallback(() => {
    if (!step.anchor) {
      setRect(null);
      return;
    }
    const el = document.querySelector(step.anchor);
    if (!el) return;
    const r = el.getBoundingClientRect();
    // A hidden element (e.g. the sidebar rail below `md`) measures 0×0 — treat
    // it as absent so the card centers instead of hugging the corner.
    if (r.width === 0 && r.height === 0) {
      setRect(null);
      return;
    }
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step.anchor]);

  useEffect(() => {
    if (!onRoute || !step.anchor) return;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      const el = document.querySelector(step.anchor as string);
      if (el) {
        (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
        // Let the smooth scroll settle before the first measure.
        window.setTimeout(measure, 220);
        return;
      }
      if (frames++ < 40) raf = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(raf);
  }, [onRoute, step.anchor, step.id, measure]);

  // Keep the spotlight glued to its element as the page scrolls or resizes.
  useEffect(() => {
    if (!rect) return;
    const update = () => measure();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [rect, measure]);

  // Measure the card so we can flip/clamp it within the viewport.
  useLayoutEffect(() => {
    if (cardRef.current) {
      const r = cardRef.current.getBoundingClientRect();
      setCardSize({ width: r.width, height: r.height });
    }
  }, [step.id, rect]);

  // Keyboard: Escape ends the tour, arrows page through it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onNext();
      else if (e.key === "ArrowLeft" && index > 0) onPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNext, onPrev, index]);

  // The overlay only ever renders after a client interaction (startTour), never
  // during SSR/hydration, so a render-time document check is a safe portal gate.
  if (typeof document === "undefined") return null;

  const cardPos = placeCard(rect, cardSize);
  const isLast = index === total - 1;

  const overlay = (
    <div
      className="fixed inset-0 z-[100]"
      role="dialog"
      aria-modal="true"
      aria-label="Product tour"
    >
      {/* Dim + click blocker. With an anchor the darkness comes from the
          spotlight's huge box-shadow, so this layer stays transparent; without
          one it carries the dim itself. */}
      <div className={cn("absolute inset-0", rect ? "bg-transparent" : "bg-foreground/50")} />

      {rect && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-[var(--radius)] ring-2 ring-primary transition-all duration-200"
          style={{
            top: rect.top - SPOTLIGHT_PAD,
            left: rect.left - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
            boxShadow: "0 0 0 9999px oklch(0.15 0 0 / 0.55)",
          }}
        />
      )}

      <div
        ref={cardRef}
        className="absolute flex w-[min(320px,calc(100vw-24px))] flex-col gap-3 rounded-[var(--radius)] border border-border bg-card p-5 shadow-lg"
        style={{ top: cardPos.top, left: cardPos.left }}
      >
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Step {index + 1} of {total}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Skip tour"
            className="-mr-1.5 -mt-1.5 rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <h2 className="text-base font-semibold text-foreground">{step.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
        </div>

        <div className="mt-1 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground transition hover:text-foreground"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button type="button" variant="outline" onClick={onPrev} className="gap-1.5">
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
            )}
            <Button type="button" onClick={onNext} className="gap-1.5">
              {isLast ? "Done" : "Next"}
              {!isLast && <ArrowRight className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

/**
 * Places the card beside the spotlight, choosing the side from where the anchor
 * sits so the card doesn't cover it: to the right of a left-rail item, above a
 * low element, below otherwise. Centers it when there's no anchor. Always
 * clamps to the viewport so the card is never partly off-screen.
 */
function placeCard(
  rect: Rect | null,
  size: { width: number; height: number },
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!rect) {
    return {
      top: Math.max(VIEWPORT_MARGIN, (vh - size.height) / 2),
      left: Math.max(VIEWPORT_MARGIN, (vw - size.width) / 2),
    };
  }

  const rectRight = rect.left + rect.width;
  let top: number;
  let left: number;
  if (rectRight < vw * 0.33 && rectRight + CARD_GAP + size.width < vw) {
    // A left-rail item (a sidebar nav link): sit to its right.
    top = rect.top;
    left = rectRight + CARD_GAP;
  } else if (rect.top > vh * 0.55) {
    // Low on the page: sit above so the card stays on-screen.
    top = rect.top - size.height - CARD_GAP;
    left = rect.left;
  } else {
    // Default: just below the element.
    top = rect.top + rect.height + CARD_GAP;
    left = rect.left;
  }

  const clamp = (v: number, max: number) => Math.max(VIEWPORT_MARGIN, Math.min(v, max));
  return {
    top: clamp(top, vh - size.height - VIEWPORT_MARGIN),
    left: clamp(left, vw - size.width - VIEWPORT_MARGIN),
  };
}
