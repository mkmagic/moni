-- Moni — grants + RLS + updated_at triggers for budget_ceilings and
-- budget_incomes (issue #69 part B).
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom`. Applied by
-- the normal `drizzle-kit migrate` step as moni_owner.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE "budget_ceilings" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "budget_incomes" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grants for moni_app (0001 §4's pattern — ordinary user-owned
--    tables, so the same blanket grant as the rest).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_ceilings" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_incomes" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security (0001 §6's pattern). current_setting(..., true) is
--    the [missing_ok] form so an unset app.user_id fails closed (zero rows),
--    never open.
-- ---------------------------------------------------------------------------
ALTER TABLE "budget_ceilings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "budget_ceilings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "budget_ceilings_tenant_isolation" ON "budget_ceilings";
--> statement-breakpoint
CREATE POLICY "budget_ceilings_tenant_isolation" ON "budget_ceilings"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "budget_incomes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "budget_incomes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "budget_incomes_tenant_isolation" ON "budget_incomes";
--> statement-breakpoint
CREATE POLICY "budget_incomes_tenant_isolation" ON "budget_incomes"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. updated_at triggers (0001 §5/§7's pattern — reuses the existing
--    moni_set_updated_at() function, not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "budget_ceilings_set_updated_at"
  BEFORE UPDATE ON "budget_ceilings"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "budget_incomes_set_updated_at"
  BEFORE UPDATE ON "budget_incomes"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
