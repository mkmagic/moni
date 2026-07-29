-- Moni — grants + RLS + updated_at trigger for category_rejections
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom` (empty-file +
-- journal-entry boilerplate only; all SQL below is hand-written). Applied by
-- the normal `drizzle-kit migrate` step as moni_owner — no superuser
-- required, mirroring drizzle/0004_user_unlock_methods_rls_and_roles.sql for
-- this one new table (0009_category_rejections.sql created it).
--
-- Replaces the equivalent block for `category_suggestions`, which
-- 0008_drop_category_suggestions.sql dropped along with its policies and
-- trigger (DROP TABLE ... CASCADE takes both). Suggestions are derived on
-- render rather than stored now; a rejection is the only thing that persists
-- (docs/adr/0002-suggestions-are-derived-rejections-are-stored.md).
--
-- See: docs/security/security-design-principles.md §9-10,
--      docs/security/threat-model.md §5-§6, docs/design/domain-layer.md §2.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE "category_rejections" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grant for moni_app (0001 §4's pattern — an ordinary user-owned
--    table, so it gets the same blanket grant as the rest).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "category_rejections" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security (0001 §6's pattern). current_setting(..., true) is
--    the [missing_ok] form so an unset app.user_id fails closed (zero rows),
--    never open.
-- ---------------------------------------------------------------------------
ALTER TABLE "category_rejections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "category_rejections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "category_rejections_tenant_isolation" ON "category_rejections";
--> statement-breakpoint
CREATE POLICY "category_rejections_tenant_isolation" ON "category_rejections"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger (0001 §5/§7's pattern — reuses the existing
--    moni_set_updated_at() function, not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "category_rejections_set_updated_at"
  BEFORE UPDATE ON "category_rejections"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
