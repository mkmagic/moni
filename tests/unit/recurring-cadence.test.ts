// src/lib/recurring/cadence.ts — how often a merchant charges, read from the
// gaps between its transaction dates and nothing else (docs/adr/0006-*).
// Pinned here because the alternative to getting this right is inventing a
// cadence a payee doesn't have, which CONTEXT.md rules out explicitly.
import { describe, expect, it } from "vitest";
import { deriveCadence, isStopped, poolPayees, pooledCadence } from "@/lib/recurring/cadence";

describe("deriveCadence", () => {
  it("is unknown with no dates — there is no gap to read", () => {
    expect(deriveCadence([])).toBe("unknown");
  });

  it("is unknown with a single date, however recurring the payee really is", () => {
    expect(deriveCadence(["2026-01-15"])).toBe("unknown");
  });

  it("reads a clean monthly series", () => {
    expect(deriveCadence(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"])).toBe("monthly");
  });

  it("reads monthly through month-length jitter — 28, 31 and 30-day gaps are all one month", () => {
    // Jan 31 -> Feb 28 -> Mar 31 -> Apr 30: gaps of 28, 31, 30 days.
    expect(deriveCadence(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])).toBe("monthly");
  });

  it("reads bi-monthly", () => {
    // Gaps of 59 and 61 days.
    expect(deriveCadence(["2026-01-01", "2026-03-01", "2026-05-01"])).toBe("bi-monthly");
  });

  it("reads quarterly", () => {
    expect(deriveCadence(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"])).toBe(
      "quarterly",
    );
  });

  it("reads yearly", () => {
    expect(deriveCadence(["2024-03-01", "2025-03-01", "2026-03-01"])).toBe("yearly");
  });

  it("stays monthly across one missed month — a skipped charge is not a different cadence", () => {
    // Gaps of 31, 59, 30: the 59 is the gap that swallowed March.
    expect(deriveCadence(["2026-01-15", "2026-02-15", "2026-04-15", "2026-05-15"])).toBe("monthly");
  });

  it("calls genuinely unstable spacing irregular rather than picking the nearest band", () => {
    // Gaps of 15, 41 and 191 days — nothing repeats.
    expect(deriveCadence(["2026-01-05", "2026-01-20", "2026-03-02", "2026-09-09"])).toBe(
      "irregular",
    );
  });

  it("is irregular when one plausible gap is outvoted by chaos, not rescued by it", () => {
    // Gaps of 30 and 200: half the evidence says monthly, which is not enough.
    expect(deriveCadence(["2026-01-01", "2026-01-31", "2026-08-19"])).toBe("irregular");
  });

  it("reads a cadence from a single gap — a guess, but the only one available at two dates", () => {
    expect(deriveCadence(["2026-01-15", "2026-02-15"])).toBe("monthly");
  });

  it("does not depend on the caller sorting the dates", () => {
    expect(deriveCadence(["2026-03-15", "2026-01-15", "2026-04-15", "2026-02-15"])).toBe("monthly");
  });
});

describe("isStopped", () => {
  const monthly = ["2026-05-01", "2026-06-01", "2026-07-01"];

  it("keeps a monthly payee live through one missed month", () => {
    // 61 days: August's charge is missing, September's isn't due-late yet.
    expect(isStopped("monthly", monthly, "2026-08-31")).toBe(false);
  });

  it("stops a monthly payee once two payments are missed", () => {
    expect(isStopped("monthly", monthly, "2026-09-08")).toBe(true);
  });

  it("stops a yearly payee after one missed renewal, not two", () => {
    const yearly = ["2024-03-01", "2025-03-01"];
    expect(isStopped("yearly", yearly, "2026-03-20")).toBe(false);
    expect(isStopped("yearly", yearly, "2026-04-10")).toBe(true);
  });

  it("judges a single payment as monthly — the Harel case", () => {
    expect(isStopped("unknown", ["2026-08-01"], "2026-09-30")).toBe(false);
    expect(isStopped("unknown", ["2026-08-01"], "2026-11-20")).toBe(true);
  });

  it("judges an irregular payee against twice its own longest gap", () => {
    // Longest gap 50 days -> allowed 100.
    const dates = ["2026-01-01", "2026-01-20", "2026-03-11"];
    expect(isStopped("irregular", dates, "2026-06-15")).toBe(false);
    expect(isStopped("irregular", dates, "2026-06-25")).toBe(true);
  });
});

describe("pooledCadence", () => {
  it("reads two sources of one monthly purchase as one monthly bill", () => {
    // Pharmacy Aug, Sep, Oct; reimbursed over Bit in Nov.
    expect(pooledCadence(["2026-08-03", "2026-09-02", "2026-10-04", "2026-11-03"])).toBe("monthly");
  });

  it("refuses payments that land inside one period — concurrent payees, not one bill", () => {
    expect(pooledCadence(["2026-08-03", "2026-08-15", "2026-09-03", "2026-09-15"])).toBeNull();
  });
});

describe("poolPayees", () => {
  it("pools alternating sources and leaves concurrent subscriptions alone", () => {
    const groups = poolPayees([
      { id: "anthropic", dates: ["2026-07-10", "2026-08-10", "2026-09-10", "2026-10-10"] },
      { id: "pharmacy", dates: ["2026-07-01", "2026-08-01", "2026-10-01"] },
      { id: "bit", dates: ["2026-09-01", "2026-11-01"] },
    ]);
    expect(groups).toContainEqual(["pharmacy", "bit"]);
    expect(groups).toContainEqual(["anthropic"]);
  });

  it("pools a provider switch — one payee ends as the next begins", () => {
    expect(
      poolPayees([
        { id: "kamatera", dates: ["2026-11-05"] },
        { id: "digitalocean", dates: ["2026-10-05"] },
      ]),
    ).toEqual([["digitalocean", "kamatera"]]);
  });
});
