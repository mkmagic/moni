// The guided-tour itinerary (src/components/tour/steps.tsx). A stop that
// duplicates an id would collide on its React key and progress counter, and a
// stop whose route or copy is empty is a bug the type system doesn't catch —
// pure data, so it's checked directly. AGENTS.md §7 makes adding a stop per
// major feature mandatory; these invariants keep the array well-formed as it
// grows.
import { describe, expect, it } from "vitest";
import { TOUR_STEPS } from "@/components/tour/steps";

describe("TOUR_STEPS", () => {
  it("has unique ids", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every stop a route and a title", () => {
    for (const step of TOUR_STEPS) {
      expect(step.route.startsWith("/")).toBe(true);
      expect(step.title.trim().length).toBeGreaterThan(0);
    }
  });

  it("only ever anchors via a data-tour selector", () => {
    for (const step of TOUR_STEPS) {
      if (step.anchor !== undefined) {
        expect(step.anchor).toMatch(/^\[data-tour="[^"]+"\]$/);
      }
    }
  });

  it("starts and ends on the dashboard", () => {
    expect(TOUR_STEPS[0].route).toBe("/dashboard");
    expect(TOUR_STEPS[TOUR_STEPS.length - 1].route).toBe("/dashboard");
  });
});
