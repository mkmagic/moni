// The household onboarding handshake (issue #115): create → invite → accept,
// and the group-key seam underneath. Uses REAL per-user DKs from createUser()
// (the production key-custody path), so the one-time-invite-secret handshake is
// exercised exactly as a deployment would run it — no test-only branch.
//
// The load-bearing property proved here: after the handshake, BOTH members
// unwrap the *same* group key from their own DK-wrapped membership rows — a
// number one member encrypts under it, the other decrypts. That is the whole
// point of the shared room.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { withUser } from "@/db/client";
import { encryptField, decryptField, wipe } from "@/lib/crypto";
import { createUser } from "@/domain/registration";
import {
  AlreadyMemberError,
  InvalidInvitationError,
  acceptInvite,
  createHousehold,
  inviteMember,
  listMemberships,
  loadGroupKey,
} from "@/domain/household";
import { cleanupHouseholds, cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;

let userA: string;
let dkA: Buffer;
let userB: string;
let dkB: Buffer;
let userC: string;
let dkC: Buffer;
const householdIds: string[] = [];

async function mkUser(label: string): Promise<{ userId: string; dataKey: Buffer }> {
  return createUser(
    `${label}-${randomUUID()}@test.moni`,
    Buffer.from("pw-" + label),
    SIGNUP_TOKEN!,
  );
}

/** Loads a user's group key for a household, or null if they're not a member. */
async function groupKeyOf(
  userId: string,
  dataKey: Buffer,
  householdId: string,
): Promise<Buffer | null> {
  return withUser(userId, (tx) => loadGroupKey(tx, householdId, dataKey));
}

beforeAll(async () => {
  ({ userId: userA, dataKey: dkA } = await mkUser("onb-a"));
  ({ userId: userB, dataKey: dkB } = await mkUser("onb-b"));
  ({ userId: userC, dataKey: dkC } = await mkUser("onb-c"));
});

afterAll(async () => {
  await cleanupHouseholds(householdIds);
  await cleanupOwners([userA, userB, userC]);
});

describe("household onboarding handshake", () => {
  it("creates a household and enrolls the creator with a DK-wrapped group key", async () => {
    const { householdId } = await createHousehold(userA, dkA, "Our Home");
    householdIds.push(householdId);

    const memberships = await listMemberships(userA);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].householdId).toBe(householdId);
    expect(memberships[0].householdName).toBe("Our Home");

    const gk = await groupKeyOf(userA, dkA, householdId);
    expect(gk).not.toBeNull();
    expect(gk!.length).toBe(32);
    wipe(gk!);
  });

  it("invite → accept gives both members the SAME group key", async () => {
    const { householdId } = await createHousehold(userA, dkA, "Shared Life");
    householdIds.push(householdId);

    const invite = await inviteMember(userA, dkA, householdId, { inviteeEmail: "b@test.moni" });
    expect(invite.secret.startsWith("moni_hh_invite_")).toBe(true);

    const { householdId: joined } = await acceptInvite(userB, dkB, invite.secret);
    expect(joined).toBe(householdId);

    // B is now a member.
    const bMemberships = await listMemberships(userB);
    expect(bMemberships.map((m) => m.householdId)).toContain(householdId);

    // The crux: A and B unwrap identical group keys.
    const gkA = await groupKeyOf(userA, dkA, householdId);
    const gkB = await groupKeyOf(userB, dkB, householdId);
    expect(gkA).not.toBeNull();
    expect(gkB).not.toBeNull();
    expect(Buffer.compare(gkA!, gkB!)).toBe(0);

    // And a value A encrypts under the group key, B decrypts under theirs.
    const aad = { rowId: randomUUID(), column: "total_ct", version: 1 };
    const ciphertext = encryptField(gkA!, Buffer.from("1234.56"), aad);
    const plain = decryptField(gkB!, ciphertext, aad).toString("utf8");
    expect(plain).toBe("1234.56");

    wipe(gkA!);
    wipe(gkB!);
  });

  it("keeps the group key unreachable to a non-member", async () => {
    const { householdId } = await createHousehold(userA, dkA, "Private");
    householdIds.push(householdId);
    const gkC = await groupKeyOf(userC, dkC, householdId);
    expect(gkC).toBeNull();
  });
});

describe("household onboarding: invitation validation", () => {
  it("rejects a garbage / malformed secret", async () => {
    await expect(acceptInvite(userC, dkC, "not-an-invite")).rejects.toBeInstanceOf(
      InvalidInvitationError,
    );
    await expect(
      acceptInvite(userC, dkC, "moni_hh_invite_" + randomBytes(32).toString("base64url")),
    ).rejects.toBeInstanceOf(InvalidInvitationError);
  });

  it("rejects a second redemption of the same invite (single use)", async () => {
    const { householdId } = await createHousehold(userA, dkA, "Once Only");
    householdIds.push(householdId);
    const invite = await inviteMember(userA, dkA, householdId);
    await acceptInvite(userB, dkB, invite.secret);
    await expect(acceptInvite(userC, dkC, invite.secret)).rejects.toBeInstanceOf(
      InvalidInvitationError,
    );
  });

  it("rejects an expired invitation", async () => {
    const { householdId } = await createHousehold(userA, dkA, "Expired");
    householdIds.push(householdId);
    const invite = await inviteMember(userA, dkA, householdId, { ttlMs: -1 });
    await expect(acceptInvite(userB, dkB, invite.secret)).rejects.toBeInstanceOf(
      InvalidInvitationError,
    );
  });

  it("rejects joining a household the user is already in", async () => {
    const { householdId } = await createHousehold(userA, dkA, "Dup");
    householdIds.push(householdId);
    const invite = await inviteMember(userA, dkA, householdId);
    // A is already the creator/member — redeeming their own invite is a dup.
    await expect(acceptInvite(userA, dkA, invite.secret)).rejects.toBeInstanceOf(
      AlreadyMemberError,
    );
  });
});
