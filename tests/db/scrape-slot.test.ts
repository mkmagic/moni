// The box-wide bank-scrape slot (issue #82). A cluster-global Postgres advisory
// lock lets at most one scrape run at a time across ALL users — the guard that
// keeps two ~1.3–1.6 GB Chrome scrapes off the 4 GB host. These exercise the
// real lock against real Postgres: no users, no RLS, nothing mocked.
import { afterEach, describe, expect, it } from "vitest";
import { acquireScrapeSlot, type ScrapeSlot } from "@/lib/scrape-slot";

describe("lib/scrape-slot — acquireScrapeSlot", () => {
  const held: ScrapeSlot[] = [];
  afterEach(async () => {
    // Never leak the lock into another test: a held slot would wedge them all.
    await Promise.all(held.splice(0).map((slot) => slot.release()));
  });

  it("grants the slot when it is free, then refuses a second acquirer", async () => {
    const first = await acquireScrapeSlot();
    expect(first).not.toBeNull();
    held.push(first!);

    // A second request — a different pooled connection, i.e. another user's
    // sync on the same box — cannot take the lock while the first holds it.
    const second = await acquireScrapeSlot();
    expect(second).toBeNull();
  });

  it("frees the slot on release so the next scrape can take it", async () => {
    const first = await acquireScrapeSlot();
    expect(first).not.toBeNull();
    await first!.release();

    const second = await acquireScrapeSlot();
    expect(second).not.toBeNull();
    held.push(second!);
  });

  it("release is idempotent — extra calls do not throw or double-free", async () => {
    const slot = await acquireScrapeSlot();
    expect(slot).not.toBeNull();
    await slot!.release();
    await expect(slot!.release()).resolves.toBeUndefined();

    // The slot is free exactly once; a fresh acquirer still gets it.
    const next = await acquireScrapeSlot();
    expect(next).not.toBeNull();
    held.push(next!);
  });
});
