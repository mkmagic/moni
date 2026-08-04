-- Moni — grants + RLS + updated_at trigger for category_suggestions
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom` (empty-file +
-- journal-entry boilerplate only; all SQL below is hand-written). Applied by
-- the normal `drizzle-kit migrate` step as moni_owner — no superuser
-- required, mirroring drizzle/0004_user_unlock_methods_rls_and_roles.sql for
-- this one new table (0006_burly_karma.sql created it).
--
-- See: docs/security/security-design-principles.md §9-10,
--      docs/security/threat-model.md §5-§6, docs/design/domain-layer.md §2.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TYPE "category_suggestion_status" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "category_suggestions" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grant for moni_app (0001 §4's pattern — an ordinary user-owned
--    table, so it gets the same blanket grant as the rest).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "category_suggestions" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security (0001 §6's pattern). current_setting(..., true) is
--    the [missing_ok] form so an unset app.user_id fails closed (zero rows),
--    never open.
-- ---------------------------------------------------------------------------
ALTER TABLE "category_suggestions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "category_suggestions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "category_suggestions_tenant_isolation" ON "category_suggestions";
--> statement-breakpoint
CREATE POLICY "category_suggestions_tenant_isolation" ON "category_suggestions"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger (0001 §5/§7's pattern — reuses the existing
--    moni_set_updated_at() function, not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "category_suggestions_set_updated_at"
  BEFORE UPDATE ON "category_suggestions"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
