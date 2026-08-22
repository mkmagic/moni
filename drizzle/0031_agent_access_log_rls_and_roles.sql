-- Moni — grants + RLS + updated_at trigger for agent_access_log
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom`. Applied by the
-- normal `drizzle-kit migrate` step as moni_owner.
--
-- Unlike agent_tokens (0029) this table needs NO pre-auth SELECT policy: every
-- read (the rate-cap count) and write (the audit row) happens inside
-- withUser(), so app.user_id is always set by the time it is touched. The
-- standard tenant-isolation form (0001 §6) is the whole story, and the bare
-- ::uuid cast is safe because there is no permissive pre-auth policy forcing
-- the tenant qual to evaluate against an empty GUC.
--
-- See: docs/design/mcp-and-api.md §7, docs/security/threat-model.md §9.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_access_log" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grant for moni_app (0001 §4's pattern — an ordinary user-owned
--    table, so it gets the same blanket grant as the rest).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_access_log" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security (0001 §6's pattern). current_setting(..., true) is
--    the [missing_ok] form so an unset app.user_id fails closed (zero rows),
--    never open.
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_access_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_access_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_access_log_tenant_isolation" ON "agent_access_log";
--> statement-breakpoint
CREATE POLICY "agent_access_log_tenant_isolation" ON "agent_access_log"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger (0001 §5/§7's pattern — reuses the existing
--    moni_set_updated_at() function, not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "agent_access_log_set_updated_at"
  BEFORE UPDATE ON "agent_access_log"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
