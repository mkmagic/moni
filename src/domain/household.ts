// Household sharing — onboarding, membership, and the group-key seam (issue
// #115). A household owns a single 32-byte **group key**, wrapped once per
// member under that member's DK. Every figure that crosses the isolation
// boundary (published totals, the household ceiling) is encrypted under this
// group key, never a user's DK — so a member can decrypt the shared room only
// while their own DK is unlocked, consistent with the whole key model.
//
// The group key is Tier-0: every group key this module unwraps is a `Buffer`
// the caller (or an internal `try/finally`) `fill(0)`-wipes after use. It never
// reaches the DB, disk, or logs.
//
// ONBOARDING HANDSHAKE. Wrapping the group key for an invitee directly is
// impossible: their DK is RAM-only in *their* session. So the creator wraps the
// group key under a KEK derived from a **one-time invite secret** — the same
// 32-byte-secret→KEK seam agent_tokens/webauthn-prf use — and shows the secret
// to the invitee out-of-band exactly once. The invitee redeems it in their own
// session: the server unwraps the group key with the secret's KEK and re-wraps
// it under the invitee's DK into a fresh household_members row.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { withUser, type UserTransaction } from "@/db/client";
import { households, householdMembers, householdInvitations, sharedCategories } from "@/db/schema";
import { wrapWithKek, unwrapWithKek } from "@/lib/auth/password";
import { deriveKekFromUnlockSecret, UNLOCK_SECRET_LENGTH } from "@/lib/auth/unlock-secret";
import { encryptField, decryptField, wipe, type AadContext } from "@/lib/crypto";

/** The household group key is a 32-byte AEAD key, same width as a DK. */
const GROUP_KEY_LENGTH = 32;

/** Invite-secret width — the KEK-seam input, reused from the unlock secret. */
const INVITE_SECRET_LENGTH = UNLOCK_SECRET_LENGTH;

/** Greppable prefix on the one-time invite string (leak scanners key on it);
 * the entropy is the 32 bytes after it. Stripped before decoding on redeem. */
const INVITE_PREFIX = "moni_hh_invite_";

/** Default invitation TTL — a handshake is meant to be redeemed promptly. */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** The AAD binding a member's wrapped group key to its household_members row. */
function memberWrapAad(memberRowId: string): AadContext {
  // Version 1 fixed: the wrap is written once when the member joins and never
  // re-wrapped in place (key rotation on breakup mints fresh rows) — so there
  // is no stale version to roll back to.
  return { rowId: memberRowId, column: "wrapped_group_key", version: 1 };
}

/** The AAD binding an invitation's wrapped group key to its invitation row. */
function inviteWrapAad(invitationId: string): AadContext {
  return { rowId: invitationId, column: "wrapped_group_key", version: 1 };
}

/** SHA-256 of the raw invite secret — what we store and look up by. */
function hashSecret(secret: Buffer): Buffer {
  return createHash("sha256").update(secret).digest();
}

/** Thrown when redeeming an invite that is unknown, expired, or already used. */
export class InvalidInvitationError extends Error {
  constructor() {
    super("invitation is invalid, expired, or already used");
    this.name = "InvalidInvitationError";
  }
}

/** Thrown when a user tries to join a household they are already in. */
export class AlreadyMemberError extends Error {
  constructor() {
    super("already a member of this household");
    this.name = "AlreadyMemberError";
  }
}

export interface HouseholdMembership {
  householdId: string;
  householdName: string;
  memberRowId: string;
}

/** A minted invitation — the secret appears here exactly once. */
export interface MintedInvitation {
  invitationId: string;
  householdId: string;
  /** The one-time invite secret. Show once; never persisted server-side. */
  secret: string;
  expiresAt: Date | null;
}

/**
 * Reads the caller's own membership row for `householdId` and unwraps the group
 * key from it with the caller's live DK. Runs inside an existing user-scoped
 * transaction. Returns a Tier-0 `Buffer` the CALLER must `fill(0)` after use,
 * or null if the caller is not a member.
 */
export async function loadGroupKey(
  tx: UserTransaction,
  householdId: string,
  dataKey: Buffer,
): Promise<Buffer | null> {
  const [row] = await tx
    .select({
      id: householdMembers.id,
      wrappedGroupKey: householdMembers.wrappedGroupKey,
      version: householdMembers.version,
    })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, householdId))
    .limit(1);
  if (!row) return null;
  // RLS already confines this to the caller's own membership row, so a returned
  // row is theirs — decrypt its wrap with their DK.
  return decryptField(dataKey, Buffer.from(row.wrappedGroupKey), memberWrapAad(row.id));
}

/**
 * Creates a household, generates its group key, and enrolls the creator as the
 * first member with the key wrapped under their DK. `dataKey` is the creator's
 * live session DK — read, never wiped here. Returns the new household id.
 */
export async function createHousehold(
  userId: string,
  dataKey: Buffer,
  name: string,
): Promise<{ householdId: string }> {
  const householdId = randomUUID();
  const memberRowId = randomUUID();
  const groupKey = randomBytes(GROUP_KEY_LENGTH);
  try {
    const wrappedGroupKey = encryptField(dataKey, groupKey, memberWrapAad(memberRowId));
    await withUser(userId, async (tx) => {
      await tx.insert(households).values({ id: householdId, name, createdBy: userId });
      await tx.insert(householdMembers).values({
        id: memberRowId,
        householdId,
        ownerId: userId,
        wrappedGroupKey,
      });
    });
    return { householdId };
  } finally {
    wipe(groupKey);
  }
}

/**
 * Mints a one-time invitation to `householdId`. The caller must be a member: we
 * unwrap the group key from their own membership row (with their DK) and re-wrap
 * it under a KEK derived from a fresh invite secret, storing only the wrap + the
 * secret's hash. The returned secret is shown to the invitee exactly once.
 */
export async function inviteMember(
  userId: string,
  dataKey: Buffer,
  householdId: string,
  opts: { inviteeEmail?: string; ttlMs?: number | null } = {},
): Promise<MintedInvitation> {
  const invitationId = randomUUID();
  const secret = randomBytes(INVITE_SECRET_LENGTH);
  const expiresAt =
    opts.ttlMs === null ? null : new Date(Date.now() + (opts.ttlMs ?? DEFAULT_INVITE_TTL_MS));

  try {
    await withUser(userId, async (tx) => {
      const groupKey = await loadGroupKey(tx, householdId, dataKey);
      if (!groupKey) throw new InvalidInvitationError();
      try {
        const kek = deriveKekFromUnlockSecret(secret);
        let wrappedGroupKey: Buffer;
        try {
          wrappedGroupKey = wrapWithKek(kek, inviteWrapAad(invitationId), groupKey);
        } finally {
          wipe(kek);
        }
        await tx.insert(householdInvitations).values({
          id: invitationId,
          householdId,
          invitedBy: userId,
          inviteeEmail: opts.inviteeEmail ?? null,
          tokenHash: hashSecret(secret),
          wrappedGroupKey,
          expiresAt,
        });
      } finally {
        wipe(groupKey);
      }
    });

    const secretString = INVITE_PREFIX + secret.toString("base64url");
    return { invitationId, householdId, secret: secretString, expiresAt };
  } finally {
    wipe(secret);
  }
}

/**
 * Redeems an invitation in the invitee's own session: unwraps the group key
 * with the presented secret's KEK, re-wraps it under the invitee's DK, and
 * enrolls them as a member — marking the invitation consumed in the same
 * transaction. `dataKey` is the invitee's live session DK. Returns the joined
 * household id.
 */
export async function acceptInvite(
  userId: string,
  dataKey: Buffer,
  secretString: string,
): Promise<{ householdId: string }> {
  if (!secretString.startsWith(INVITE_PREFIX)) throw new InvalidInvitationError();
  let secret: Buffer;
  try {
    secret = Buffer.from(secretString.slice(INVITE_PREFIX.length), "base64url");
  } catch {
    throw new InvalidInvitationError();
  }
  if (secret.length !== INVITE_SECRET_LENGTH) {
    wipe(secret);
    throw new InvalidInvitationError();
  }

  try {
    const tokenHash = hashSecret(secret);
    return await withUser(userId, async (tx) => {
      const [inv] = await tx
        .select({
          id: householdInvitations.id,
          householdId: householdInvitations.householdId,
          wrappedGroupKey: householdInvitations.wrappedGroupKey,
          expiresAt: householdInvitations.expiresAt,
          consumedAt: householdInvitations.consumedAt,
        })
        .from(householdInvitations)
        .where(
          and(
            eq(householdInvitations.tokenHash, tokenHash),
            isNull(householdInvitations.consumedAt),
          ),
        )
        .limit(1);
      if (!inv) throw new InvalidInvitationError();
      if (inv.expiresAt !== null && inv.expiresAt.getTime() <= Date.now()) {
        throw new InvalidInvitationError();
      }

      const kek = deriveKekFromUnlockSecret(secret);
      let groupKey: Buffer;
      try {
        groupKey = unwrapWithKek(kek, inviteWrapAad(inv.id), Buffer.from(inv.wrappedGroupKey));
      } catch {
        // AEAD failure = tampered wrap; indistinguishable from a bad secret.
        throw new InvalidInvitationError();
      } finally {
        wipe(kek);
      }

      try {
        const memberRowId = randomUUID();
        const wrappedGroupKey = encryptField(dataKey, groupKey, memberWrapAad(memberRowId));
        try {
          await tx.insert(householdMembers).values({
            id: memberRowId,
            householdId: inv.householdId,
            ownerId: userId,
            wrappedGroupKey,
          });
        } catch (err) {
          if (isMembershipDuplicate(err)) throw new AlreadyMemberError();
          throw err;
        }
        // Now that the membership row exists in this transaction, the member
        // policy admits consuming the invitation. `accepted_by` records the
        // joiner — the group-readable half of the member roster.
        await tx
          .update(householdInvitations)
          .set({ consumedAt: new Date(), acceptedBy: userId })
          .where(eq(householdInvitations.id, inv.id));
        return { householdId: inv.householdId };
      } finally {
        wipe(groupKey);
      }
    });
  } finally {
    wipe(secret);
  }
}

/** The household_members unique-constraint violation (already a member). */
function isMembershipDuplicate(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown; constraint?: unknown } } | undefined)?.cause;
  return (
    cause?.code === "23505" && cause?.constraint === "household_members_household_owner_unique"
  );
}

/** Every household the user belongs to, with their own membership row id. */
export async function listMemberships(userId: string): Promise<HouseholdMembership[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        householdId: householdMembers.householdId,
        memberRowId: householdMembers.id,
        householdName: households.name,
      })
      .from(householdMembers)
      .innerJoin(households, eq(households.id, householdMembers.householdId));
    return rows;
  });
}

/**
 * The member roster for a household the caller belongs to — the creator plus
 * everyone who accepted an invitation. Assembled from the group-readable
 * `households.created_by` and `household_invitations.accepted_by`, NOT from a
 * cross-member read of the own-rows-only `household_members` leaf. Returns
 * distinct user ids (empty if the caller is not a member — RLS hides the rows).
 */
export async function listHouseholdMembers(userId: string, householdId: string): Promise<string[]> {
  return withUser(userId, (tx) => listHouseholdMemberIds(tx, householdId));
}

export interface HouseholdSummary {
  householdId: string;
  name: string;
  memberCount: number;
  /** Plaintext shared-category names — the shared budget lines (untrusted). */
  sharedCategoryNames: string[];
}

/**
 * A non-secret summary of every household the caller belongs to — for `whoami`
 * and the like. Needs no data key: household/shared-category names and the
 * member roster are all group-readable structural data.
 */
export async function householdSummaries(userId: string): Promise<HouseholdSummary[]> {
  return withUser(userId, async (tx) => {
    const mine = await tx
      .select({ householdId: householdMembers.householdId, name: households.name })
      .from(householdMembers)
      .innerJoin(households, eq(households.id, householdMembers.householdId));
    const out: HouseholdSummary[] = [];
    for (const h of mine) {
      const members = await listHouseholdMemberIds(tx, h.householdId);
      const scs = await tx
        .select({ name: sharedCategories.name })
        .from(sharedCategories)
        .where(eq(sharedCategories.householdId, h.householdId));
      out.push({
        householdId: h.householdId,
        name: h.name,
        memberCount: members.length,
        sharedCategoryNames: scs.map((s) => s.name),
      });
    }
    return out;
  });
}

/** As {@link listHouseholdMembers}, inside an existing user-scoped transaction. */
export async function listHouseholdMemberIds(
  tx: UserTransaction,
  householdId: string,
): Promise<string[]> {
  const [household] = await tx
    .select({ createdBy: households.createdBy })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  // RLS hides the household row from a non-member, so no creator = not a member.
  if (!household) return [];
  const accepted = await tx
    .select({ acceptedBy: householdInvitations.acceptedBy })
    .from(householdInvitations)
    .where(eq(householdInvitations.householdId, householdId));
  const ids = new Set<string>([household.createdBy]);
  for (const row of accepted) if (row.acceptedBy) ids.add(row.acceptedBy);
  return [...ids];
}
