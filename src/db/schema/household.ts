import {
  pgTable,
  uuid,
  text,
  date,
  numeric,
  boolean,
  integer,
  timestamp,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./shared";
import { users } from "./identity";
import { categories } from "./classification";

/**
 * Household sharing — the "sharing layer on top" reserved in data-model.md §6.8
 * (issue #115). A NEW class of rows: **group-owned, not user-owned.** Where every
 * table elsewhere keys tenancy on `owner_id = app.user_id`, these key on
 * `household_id ∈ members(app.user_id)` — a member of the household, not one owner.
 *
 * The core invariant is untouched: **no jointly-owned ledger rows.** Every
 * transaction stays in exactly one person's private, RLS-protected, DK-encrypted
 * ledger. The only thing that crosses the isolation boundary is what a member
 * deliberately *publishes* into the household room, encrypted under the
 * **household group key** — a 32-byte key wrapped once per member under that
 * member's DK (households.ts's onboarding handshake), never seen by the DB.
 *
 * RLS shape (drizzle/0039):
 *   - `household_members` is the **leaf**: policy `owner_id = app.user_id`
 *     (own rows only). It must stay self-contained — a policy that let a member
 *     read co-members here would have to subquery `household_members` from its
 *     own policy, which Postgres rejects as infinite recursion.
 *   - Every satellite table below keys on the **non-recursive** predicate
 *     `household_id IN (SELECT household_id FROM household_members WHERE
 *     owner_id = app.user_id)` — a subquery over a *different* table, so no
 *     recursion. That is exactly "am I a member of this household?".
 *   - `published_category_totals` additionally gates WRITES to
 *     `member_id = app.user_id`: any member READS every member's published
 *     total, but only publishes their own.
 *   - `shared_category_maps` are member-private within the room
 *     (`member_id = app.user_id`): only the derived monthly total ever crosses,
 *     never which local categories a member folded in.
 *
 * Built for exactly 2 members; the schema generalizes to N (membership rows +
 * per-member published/split rows), with N-way settlement deferred (issue #115).
 */

/**
 * One household (e.g. a couple sharing certain budgets). The root of the
 * group-ownership graph — the analogue of `users` for the per-user graph.
 * `name` is a plaintext Tier-2 label (like `categories.name`); it carries no
 * financial value and is meant to be seen by every member.
 */
export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // ON DELETE CASCADE across the household subtree: deleting a user dissolves
  // the households they created and drops their memberships/contributions
  // everywhere else (issue #115 §7.6 — account deletion is the pragmatic
  // "leave/breakup" until the graceful lifecycle is built). Cascades run as the
  // system and so cross the member-private RLS boundary the deleting user
  // cannot reach directly.
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  ...timestamps,
});

/**
 * Membership — one row per (household, member). Carries the **group key wrapped
 * under that member's DK** (`wrapped_group_key`): unwrapping it needs the
 * member's live session DK, consistent with the whole key model. AAD binds to
 * this row's id / `wrapped_group_key` / version (like every wrap in the system).
 *
 * RLS leaf: `owner_id = app.user_id`. A member sees only their own membership
 * rows; co-member facts come from the group-readable satellite tables
 * (`shared_category_splits`, `published_category_totals`) and the globally
 * readable `users` identity anchor, never from a cross-member read here.
 */
export const householdMembers = pgTable(
  "household_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The 32-byte household group key, wrapped under this member's DK. Opaque
     * ciphertext; useless without the member's unlocked DK. */
    wrappedGroupKey: bytea("wrapped_group_key").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("household_members_household_id_id_unique").on(table.householdId, table.id),
    // A user joins a given household at most once.
    unique("household_members_household_owner_unique").on(table.householdId, table.ownerId),
  ],
);

/**
 * A pending invitation to join a household. The onboarding handshake
 * (households.ts): the group key can't be wrapped for the invitee directly —
 * their DK is RAM-only in *their* session — so the creator wraps it under a KEK
 * derived from a **one-time invite secret** (the same 32-byte-secret→KEK seam
 * `agent_tokens`/`webauthn-prf` use), stores that wrap here plus the secret's
 * SHA-256, and shows the secret to the invitee out-of-band exactly once. The
 * invitee redeems it *in their own session*: the server unwraps the group key
 * with the secret's KEK and re-wraps it under the invitee's DK into a fresh
 * `household_members` row.
 *
 * Neither stored column is usable without the secret (`token_hash` is one-way;
 * `wrapped_group_key` opens only under the secret's KEK) — the same reason the
 * pre-auth SELECT policy that finds a live invitation by hash is safe.
 */
export const householdInvitations = pgTable(
  "household_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Optional non-secret label for whom the invite is intended (identity-tier,
     * like `users.email`; never financial). */
    inviteeEmail: text("invitee_email"),
    /** SHA-256 of the one-time invite secret — the pre-auth lookup key. */
    tokenHash: bytea("token_hash").notNull(),
    /** Group key wrapped under a KEK derived from the invite secret. */
    wrappedGroupKey: bytea("wrapped_group_key").notNull(),
    /** The user who redeemed this invitation, set on accept. Together with
     * `households.created_by` this is the group-readable member ROSTER — the
     * way a member enumerates co-members without a cross-member read of the
     * own-rows-only `household_members` leaf. */
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("household_invitations_household_id_id_unique").on(table.householdId, table.id),
    uniqueIndex("household_invitations_token_hash_unique").on(table.tokenHash),
  ],
);

/**
 * A shared budget line the household tracks together (e.g. "Groceries"). A
 * first-class household object — NOT a reference to any member's local
 * `categories` row, because those are per-user (distinct uuids, distinct
 * plaintext names): A's "Groceries" ≠ B's "Groceries". Each member maps one or
 * more of *their own* local categories onto this line (`shared_category_maps`);
 * their published number is "my total across the local categories I mapped".
 *
 * `name` is plaintext and deliberately crosses to every member (the shared line
 * label). `is_recurring` places it Fixed-vs-Everyday, defaulting to Everyday.
 */
export const sharedCategories = pgTable(
  "shared_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isRecurring: boolean("is_recurring").notNull().default(false),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [unique("shared_categories_household_id_id_unique").on(table.householdId, table.id)],
);

/**
 * The split ratio for a shared category, one row per member. Group-readable and
 * settable by either member (you configure the whole split, including the other
 * member's weight). `weight` is a plaintext exact-decimal ratio (like 0.5) — a
 * configuration value, not a monetary amount, so it is not Tier-1; RLS still
 * confines it to the household. Weights across a category's members sum to 1
 * (enforced in the domain layer).
 */
export const sharedCategorySplits = pgTable(
  "shared_category_splits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").notNull(),
    sharedCategoryId: uuid("shared_category_id").notNull(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Exact-decimal split weight in [0, 1]; Postgres NUMERIC → string → decimal.js. */
    weight: numeric("weight").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("shared_category_splits_member_unique").on(
      table.householdId,
      table.sharedCategoryId,
      table.memberId,
    ),
    foreignKey({
      columns: [table.householdId, table.sharedCategoryId],
      foreignColumns: [sharedCategories.householdId, sharedCategories.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Maps one member's local `categories` row onto a shared category. A member may
 * fold several of their own local categories into one shared line (e.g.
 * `Groceries` + `Supermarket`). The composite FK `(member_id, local_category_id)
 * → categories(owner_id, id)` makes "map someone else's category" impossible at
 * the database. **Member-private within the room** under RLS: only the member's
 * own maps are visible to them — nothing about which local categories a member
 * folded in ever crosses to the other member; only the derived total does.
 */
export const sharedCategoryMaps = pgTable(
  "shared_category_maps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").notNull(),
    sharedCategoryId: uuid("shared_category_id").notNull(),
    memberId: uuid("member_id").notNull(),
    localCategoryId: uuid("local_category_id").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("shared_category_maps_unique").on(
      table.householdId,
      table.sharedCategoryId,
      table.memberId,
      table.localCategoryId,
    ),
    foreignKey({
      columns: [table.householdId, table.sharedCategoryId],
      foreignColumns: [sharedCategories.householdId, sharedCategories.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.memberId, table.localCategoryId],
      foreignColumns: [categories.ownerId, categories.id],
    }).onDelete("cascade"),
  ],
);

/**
 * The **household** ceiling for a shared category — group-owned, effective-dated
 * with exactly the shape and reasoning of per-user `budget_ceilings`, but
 * encrypted under the **group key** and set by either member. A shared
 * category's budget is this household ceiling; a personal ceiling on any local
 * category mapped to it is suppressed while shared (one ceiling per branch).
 *
 * `amount_ct` NULL ends the line from its month forward (same as
 * `budget_ceilings`). AAD binds this row's id / `amount_ct` / version, opened
 * with the group key.
 */
export const householdBudgetCeilings = pgTable(
  "household_budget_ceilings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").notNull(),
    sharedCategoryId: uuid("shared_category_id").notNull(),
    /** Tier-1, encrypted under the group key. NULL ends the line. */
    amountCt: bytea("amount_ct"),
    effectiveFrom: date("effective_from").notNull(),
    rollover: boolean("rollover").notNull().default(false),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("household_budget_ceilings_effective_unique").on(
      table.householdId,
      table.sharedCategoryId,
      table.effectiveFrom,
    ),
    foreignKey({
      columns: [table.householdId, table.sharedCategoryId],
      foreignColumns: [sharedCategories.householdId, sharedCategories.id],
    }).onDelete("cascade"),
  ],
);

/**
 * A member's published running total for one shared category in one month —
 * the single number that crosses the boundary (Option A, issue #115). It is a
 * recompute-and-overwrite, never an encrypted read-modify-write, so it has no
 * lost-update race — which is why it escapes the no-persisted-rollups ban
 * (data-model.md §6.2). Encrypted under the group key; `version` + `published_at`
 * give it a monotonic identity.
 *
 * RLS: any household member READS every member's row (that is how the combined
 * figure is assembled); a member WRITES only rows where `member_id = app.user_id`.
 * Only the derived monthly total is here — never raw rows, descriptions, or
 * merchants.
 */
export const publishedCategoryTotals = pgTable(
  "published_category_totals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").notNull(),
    sharedCategoryId: uuid("shared_category_id").notNull(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** First day of the budget month this total covers, "YYYY-MM-01". */
    month: date("month").notNull(),
    /** Tier-1: the member's exact-decimal monthly total, encrypted under the
     * group key. AAD binds this row's id / `total_ct` / version. */
    totalCt: bytea("total_ct").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("published_category_totals_unique").on(
      table.householdId,
      table.sharedCategoryId,
      table.memberId,
      table.month,
    ),
    foreignKey({
      columns: [table.householdId, table.sharedCategoryId],
      foreignColumns: [sharedCategories.householdId, sharedCategories.id],
    }).onDelete("cascade"),
  ],
);
