-- Moni — grants + RLS + updated_at triggers for the household sharing layer
-- (issue #115). Hand-authored (drizzle-kit doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom`; applied by the
-- normal `drizzle-kit migrate` step as moni_owner.
--
-- This introduces a NEW RLS class: **group-owned, not user-owned.** Instead of
-- `owner_id = app.user_id`, the tenant predicate is "am I a member of this
-- household?". The per-user policies from 0001 are UNCHANGED — sharing is
-- strictly additive (docs/design/data-model.md §6.8, docs/design/domain-layer.md).
--
-- RECURSION NOTE (load-bearing): a policy that subqueries its OWN table is
-- rejected by Postgres as "infinite recursion detected in policy". So
-- `household_members` is the LEAF — its policy is the self-contained
-- `owner_id = app.user_id`. Every satellite table keys on the non-recursive
-- subquery over that leaf (a *different* table), which is exactly the
-- membership test. `nullif(current_setting('app.user_id', true), '')::uuid` is
-- used throughout (not the bare `::uuid` cast) so a pooled connection whose GUC
-- has reverted to '' after a prior withUser() commit yields NULL → zero rows,
-- never a cast error — the same reason drizzle/0029 adopted it.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE "households" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "household_members" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "household_invitations" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "shared_categories" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "shared_category_splits" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "shared_category_maps" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "household_budget_ceilings" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "published_category_totals" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grants for moni_app (0001 §4's blanket grant).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "households" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "household_members" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "household_invitations" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "shared_categories" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "shared_category_splits" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "shared_category_maps" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "household_budget_ceilings" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "published_category_totals" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security.
-- ---------------------------------------------------------------------------

-- households: a member sees / edits their household. Creating one is the sole
-- moment there is no membership yet, so INSERT is admitted by `created_by =
-- app.user_id` (the creator writes their own household row, then their own
-- household_members row in the same transaction).
ALTER TABLE "households" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "households" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "households_member" ON "households";
--> statement-breakpoint
CREATE POLICY "households_member" ON "households"
  USING ("id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ))
  WITH CHECK (
    "created_by" = nullif(current_setting('app.user_id', true), '')::uuid
    OR "id" IN (
      SELECT hm."household_id" FROM "household_members" hm
      WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

-- household_members: the LEAF. Own rows only — self-contained, no subquery on
-- itself (that would recurse). Co-member facts come from the group-readable
-- satellites + the globally readable `users` anchor, never from here.
ALTER TABLE "household_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "household_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "household_members_own" ON "household_members";
--> statement-breakpoint
CREATE POLICY "household_members_own" ON "household_members"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

-- household_invitations: members manage invitations for their household. The
-- invitee (not yet a member) redeems one by looking it up by hash — admitted by
-- the pre-auth-style SELECT policy, scoped to LIVE (unconsumed) invitations.
-- The row is cryptographically useless without the one-time secret (token_hash
-- is one-way; wrapped_group_key opens only under the secret's KEK), the same
-- safety argument as drizzle/0002's users_app_select. Consuming the invitation
-- happens after the invitee has inserted their own membership row in the same
-- transaction, so the member policy's USING then admits the UPDATE.
ALTER TABLE "household_invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "household_invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "household_invitations_member" ON "household_invitations";
--> statement-breakpoint
CREATE POLICY "household_invitations_member" ON "household_invitations"
  USING ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ))
  WITH CHECK ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ));
--> statement-breakpoint
DROP POLICY IF EXISTS "household_invitations_redeem_select" ON "household_invitations";
--> statement-breakpoint
CREATE POLICY "household_invitations_redeem_select" ON "household_invitations"
  FOR SELECT
  TO moni_app
  USING ("consumed_at" IS NULL);
--> statement-breakpoint

-- shared_categories: any member of the household reads/edits the shared lines.
ALTER TABLE "shared_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shared_categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shared_categories_member" ON "shared_categories";
--> statement-breakpoint
CREATE POLICY "shared_categories_member" ON "shared_categories"
  USING ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ))
  WITH CHECK ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ));
--> statement-breakpoint

-- shared_category_splits: group-readable, settable by either member (you set
-- the whole split, including the other member's weight).
ALTER TABLE "shared_category_splits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shared_category_splits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shared_category_splits_member" ON "shared_category_splits";
--> statement-breakpoint
CREATE POLICY "shared_category_splits_member" ON "shared_category_splits"
  USING ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ))
  WITH CHECK ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ));
--> statement-breakpoint

-- shared_category_maps: MEMBER-PRIVATE within the room. Only your own maps are
-- visible/writable (member_id = app.user_id) — which local categories a member
-- folded in never crosses to the other member; only the derived total does.
ALTER TABLE "shared_category_maps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shared_category_maps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shared_category_maps_own" ON "shared_category_maps";
--> statement-breakpoint
CREATE POLICY "shared_category_maps_own" ON "shared_category_maps"
  USING (
    "member_id" = nullif(current_setting('app.user_id', true), '')::uuid
    AND "household_id" IN (
      SELECT hm."household_id" FROM "household_members" hm
      WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "member_id" = nullif(current_setting('app.user_id', true), '')::uuid
    AND "household_id" IN (
      SELECT hm."household_id" FROM "household_members" hm
      WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

-- household_budget_ceilings: group-owned ceiling, set by either member.
ALTER TABLE "household_budget_ceilings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "household_budget_ceilings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "household_budget_ceilings_member" ON "household_budget_ceilings";
--> statement-breakpoint
CREATE POLICY "household_budget_ceilings_member" ON "household_budget_ceilings"
  USING ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ))
  WITH CHECK ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ));
--> statement-breakpoint

-- published_category_totals: any member READS every member's total (that is how
-- the combined figure is assembled); a member WRITES only their own rows
-- (member_id = app.user_id). Two policies: a broad SELECT + a self-only FOR ALL.
ALTER TABLE "published_category_totals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "published_category_totals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "published_category_totals_read" ON "published_category_totals";
--> statement-breakpoint
CREATE POLICY "published_category_totals_read" ON "published_category_totals"
  FOR SELECT
  USING ("household_id" IN (
    SELECT hm."household_id" FROM "household_members" hm
    WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
  ));
--> statement-breakpoint
DROP POLICY IF EXISTS "published_category_totals_write_own" ON "published_category_totals";
--> statement-breakpoint
CREATE POLICY "published_category_totals_write_own" ON "published_category_totals"
  USING (
    "member_id" = nullif(current_setting('app.user_id', true), '')::uuid
    AND "household_id" IN (
      SELECT hm."household_id" FROM "household_members" hm
      WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "member_id" = nullif(current_setting('app.user_id', true), '')::uuid
    AND "household_id" IN (
      SELECT hm."household_id" FROM "household_members" hm
      WHERE hm."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. updated_at triggers (0001 §5/§7's pattern — reuses moni_set_updated_at()).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "households_set_updated_at"
  BEFORE UPDATE ON "households"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "household_members_set_updated_at"
  BEFORE UPDATE ON "household_members"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "household_invitations_set_updated_at"
  BEFORE UPDATE ON "household_invitations"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "shared_categories_set_updated_at"
  BEFORE UPDATE ON "shared_categories"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "shared_category_splits_set_updated_at"
  BEFORE UPDATE ON "shared_category_splits"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "shared_category_maps_set_updated_at"
  BEFORE UPDATE ON "shared_category_maps"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "household_budget_ceilings_set_updated_at"
  BEFORE UPDATE ON "household_budget_ceilings"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "published_category_totals_set_updated_at"
  BEFORE UPDATE ON "published_category_totals"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
