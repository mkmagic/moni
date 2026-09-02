// src/domain/profile.ts — markTourSeen records that a user has met the guided
// tour. It must set tour_seen_at on the first call, keep the ORIGINAL timestamp
// on every later call (the isNull guard — a replay must never move it), and,
// like every domain write, touch only the caller's own row under RLS.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createUser } from "@/domain/registration";
import { getProfile, markTourSeen } from "@/domain/profile";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

describe("domain/profile markTourSeen", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  async function user(label: string): Promise<string> {
    const email = `${label}-${randomUUID()}@test.moni`;
    const { userId } = await createUser(email, Buffer.from(PASSWORD, "utf8"), SIGNUP_TOKEN!);
    createdUserIds.push(userId);
    return userId;
  }

  it("starts null and is set on the first call", async () => {
    const userId = await user("tour-set");
    expect((await getProfile(userId))?.tourSeenAt).toBeNull();

    await markTourSeen(userId);

    const seenAt = (await getProfile(userId))?.tourSeenAt;
    expect(seenAt).toBeInstanceOf(Date);
  });

  it("keeps the original timestamp on later calls (a replay never moves it)", async () => {
    const userId = await user("tour-idempotent");
    await markTourSeen(userId);
    const first = (await getProfile(userId))?.tourSeenAt;
    expect(first).toBeInstanceOf(Date);

    // A distinguishable amount of wall-clock later, so a second write would show.
    await new Promise((r) => setTimeout(r, 25));
    await markTourSeen(userId);
    const second = (await getProfile(userId))?.tourSeenAt;

    expect(second!.getTime()).toBe(first!.getTime());
  });

  it("marks only the caller's own row (RLS-scoped)", async () => {
    const [a, b] = [await user("tour-rls-a"), await user("tour-rls-b")];
    await markTourSeen(a);

    expect((await getProfile(a))?.tourSeenAt).toBeInstanceOf(Date);
    expect((await getProfile(b))?.tourSeenAt).toBeNull();
  });
});
