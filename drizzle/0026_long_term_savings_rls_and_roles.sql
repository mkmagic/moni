-- Moni — enum ownership, grants, RLS and updated_at triggers for the
-- long-term-savings tables (issue #76 §B/§D).
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom`. Applied by the
-- normal `drizzle-kit migrate` step as moni_owner.

-- ---------------------------------------------------------------------------
-- 1. Enum ownership -> moni_owner (0017's invariant, applied to the two enums
--    0025 created).
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."long_term_savings_product" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "public"."long_term_savings_liquidity" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE "long_term_savings_details" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshots" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshot_deposits" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshot_tracks" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Per-table grants for moni_app (0001 §4's pattern — ordinary user-owned
--    tables, so the same blanket grant as the rest).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "long_term_savings_details" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "long_term_savings_snapshots" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "long_term_savings_snapshot_deposits" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "long_term_savings_snapshot_tracks" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Row-Level Security (0001 §6's pattern). current_setting(..., true) is
--    the [missing_ok] form so an unset app.user_id fails closed (zero rows),
--    never open.
-- ---------------------------------------------------------------------------
ALTER TABLE "long_term_savings_details" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "long_term_savings_details" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "long_term_savings_details_tenant_isolation" ON "long_term_savings_details";
--> statement-breakpoint
CREATE POLICY "long_term_savings_details_tenant_isolation" ON "long_term_savings_details"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "long_term_savings_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "long_term_savings_snapshots_tenant_isolation" ON "long_term_savings_snapshots";
--> statement-breakpoint
CREATE POLICY "long_term_savings_snapshots_tenant_isolation" ON "long_term_savings_snapshots"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "long_term_savings_snapshot_deposits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshot_deposits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "long_term_savings_snapshot_deposits_tenant_isolation" ON "long_term_savings_snapshot_deposits";
--> statement-breakpoint
CREATE POLICY "long_term_savings_snapshot_deposits_tenant_isolation" ON "long_term_savings_snapshot_deposits"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "long_term_savings_snapshot_tracks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshot_tracks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "long_term_savings_snapshot_tracks_tenant_isolation" ON "long_term_savings_snapshot_tracks";
--> statement-breakpoint
CREATE POLICY "long_term_savings_snapshot_tracks_tenant_isolation" ON "long_term_savings_snapshot_tracks"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. updated_at triggers (0001 §5/§7's pattern — reuses the existing
--    moni_set_updated_at() function, not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "long_term_savings_details_set_updated_at"
  BEFORE UPDATE ON "long_term_savings_details"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "long_term_savings_snapshots_set_updated_at"
  BEFORE UPDATE ON "long_term_savings_snapshots"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "long_term_savings_snapshot_deposits_set_updated_at"
  BEFORE UPDATE ON "long_term_savings_snapshot_deposits"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "long_term_savings_snapshot_tracks_set_updated_at"
  BEFORE UPDATE ON "long_term_savings_snapshot_tracks"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
