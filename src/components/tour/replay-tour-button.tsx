"use client";

import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTour } from "./tour-provider";

/** Starts the guided tour from Settings › Help. The tour's first stop lives on
 * the dashboard, so `startTour` routes there on its own — no navigation needed
 * here. */
export function ReplayTourButton() {
  const { startTour } = useTour();
  return (
    <Button type="button" onClick={startTour} className="gap-1.5 self-start">
      <Compass className="h-3.5 w-3.5" /> Replay the tour
    </Button>
  );
}
