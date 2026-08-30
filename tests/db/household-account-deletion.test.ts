// Account deletion vs. a live two-member household (issue #115 §7.6). Deleting
// a member's account is the pragmatic "leave / breakup" until the graceful
// lifecycle is built: ON DELETE CASCADE tears down the household subtree,
// including the co-member rows the deleting session's own RLS cannot reach.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { deleteAccount } from "@/domain/account-deletion";
import { acceptInvite, createHousehold, inviteMember } from "@/domain/household";
import { elevatedDb, cleanupHouseholds, cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
const createdUserIds: string[] = [];
const householdIds: string[] = [];

afterAll(async () => {
  await cleanupHouseholds(householdIds);
  await cleanupOwners(createdUserIds);
});

async function mkUser(label: string, password: string) {
  const u = await createUser(
    `${label}-${randomUUID()}@test.moni`,
    Buffer.from(password),
    SIGNUP_TOKEN!,
  );
  createdUserIds.push(u.userId);
  return u;
}

async function membershipCount(householdId: string): Promise<number> {
  const rows = await elevatedDb
    .select({ id: schema.householdMembers.id })
    .from(schema.householdMembers)
    .where(eq(schema.householdMembers.householdId, householdId));
  return rows.length;
}

describe("account deletion dissolves a shared household", () => {
  it("cascades the whole household (incl. the co-member's row) when the creator leaves", async () => {
    const creator = await mkUser("del-creator", "pw-creator");
    const partner = await mkUser("del-partner", "pw-partner");
    const { householdId } = await createHousehold(creator.userId, creator.dataKey, "Home");
    householdIds.push(householdId);
    const invite = await inviteMember(creator.userId, creator.dataKey, householdId);
    await acceptInvite(partner.userId, partner.dataKey, invite.secret);
    expect(await membershipCount(householdId)).toBe(2);

    const result = await deleteAccount(creator.userId, Buffer.from("pw-creator"));
    expect(result).toBe("deleted");

    // The household and BOTH memberships are gone — the co-member's row was
    // removed by the cascade, which the creator's own RLS could never touch.
    expect(await membershipCount(householdId)).toBe(0);
    const households = await elevatedDb
      .select({ id: schema.households.id })
      .from(schema.households)
      .where(eq(schema.households.id, householdId));
    expect(households).toHaveLength(0);
  });

  it("leaves the household intact (minus their rows) when a non-creator leaves", async () => {
    const creator = await mkUser("del2-creator", "pw-creator");
    const partner = await mkUser("del2-partner", "pw-partner");
    const { householdId } = await createHousehold(creator.userId, creator.dataKey, "Home2");
    householdIds.push(householdId);
    const invite = await inviteMember(creator.userId, creator.dataKey, householdId);
    await acceptInvite(partner.userId, partner.dataKey, invite.secret);
    expect(await membershipCount(householdId)).toBe(2);

    expect(await deleteAccount(partner.userId, Buffer.from("pw-partner"))).toBe("deleted");

    // The household survives for the creator; only the partner's membership went.
    expect(await membershipCount(householdId)).toBe(1);
    const households = await elevatedDb
      .select({ id: schema.households.id })
      .from(schema.households)
      .where(eq(schema.households.id, householdId));
    expect(households).toHaveLength(1);
  });
});
