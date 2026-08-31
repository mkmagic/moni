"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { TOUR_STEPS } from "./steps";
import { TourOverlay } from "./tour-overlay";

interface TourContextValue {
  /** Begins the tour from its first stop, wherever the user currently is. */
  startTour: () => void;
  active: boolean;
}

const TourContext = createContext<TourContextValue | null>(null);

/** Read the tour controls. Must be called under `<TourProvider>`. */
export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within <TourProvider>");
  return ctx;
}

/**
 * Holds the guided tour's run state and hands `startTour` to any descendant
 * (the dashboard's first-run prompt and the Settings › Help replay button).
 * Mounted once in the (app) layout so a tour survives the route changes it
 * drives — a per-page provider would unmount mid-tour.
 *
 * `index === null` means inactive; the overlay is only mounted while a tour is
 * running, so it never dims a page it isn't showing.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState<number | null>(null);

  const startTour = useCallback(() => setIndex(0), []);
  const close = useCallback(() => setIndex(null), []);
  const next = useCallback(
    () => setIndex((i) => (i === null ? null : i + 1 >= TOUR_STEPS.length ? null : i + 1)),
    [],
  );
  const prev = useCallback(() => setIndex((i) => (i === null || i === 0 ? i : i - 1)), []);

  const value = useMemo<TourContextValue>(
    () => ({ startTour, active: index !== null }),
    [startTour, index],
  );

  return (
    <TourContext.Provider value={value}>
      {children}
      {index !== null && (
        <TourOverlay
          key={TOUR_STEPS[index].id}
          step={TOUR_STEPS[index]}
          index={index}
          total={TOUR_STEPS.length}
          onNext={next}
          onPrev={prev}
          onClose={close}
        />
      )}
    </TourContext.Provider>
  );
}
