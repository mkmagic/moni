-- Moni — grants + RLS + updated_at trigger for user_unlock_methods
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom` (empty-file +
-- journal-entry boilerplate only; all SQL below is hand-written). Applied by
-- the normal `drizzle-kit migrate` step as moni_owner — no superuser
-- required, mirroring drizzle/0001_rls_and_roles.sql's §3-§7 exactly for
-- this one new table (0003_polite_thunderball.sql created it, owned by
-- whichever role ran that migration).
--
-- See: docs/security/security-design-principles.md §9-10,
--      docs/security/threat-model.md §5-§6, docs/design/domain-layer.md §2.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TYPE "unlock_method_type" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "user_unlock_methods" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grant for moni_app (0001 §4's pattern — this table holds
--    Tier-0 wrapped keys, not global reference data, so it gets the full
--    blanket grant like every other user-owned table).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_unlock_methods" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security (0001 §6's pattern). current_setting(..., true) is
--    the [missing_ok] form so an unset app.user_id fails closed (zero rows),
--    never open.
-- ---------------------------------------------------------------------------
ALTER TABLE "user_unlock_methods" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_unlock_methods" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "user_unlock_methods_tenant_isolation" ON "user_unlock_methods";
--> statement-breakpoint
CREATE POLICY "user_unlock_methods_tenant_isolation" ON "user_unlock_methods"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger (0001 §5/§7's pattern — reuses the existing
--    moni_set_updated_at() function, not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "user_unlock_methods_set_updated_at"
  BEFORE UPDATE ON "user_unlock_methods"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
