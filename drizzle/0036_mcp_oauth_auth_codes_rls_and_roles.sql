-- Moni — grants + RLS + pre-auth lookup + updated_at trigger for mcp_oauth_auth_codes
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom`. Applied by the
-- normal `drizzle-kit migrate` step as moni_owner — no superuser required.
--
-- Structurally identical to drizzle/0034 (mcp_oauth_grants) and drizzle/0029
-- (agent_tokens): an auth code is a short-lived envelope carrying the DK from
-- the interactive /authorize step to the back-channel /token exchange, so it
-- takes the same RLS shape — tenant isolation for the owner-scoped write at
-- authorize time plus a pre-auth SELECT policy for the /token lookup that
-- resolves a presented code to its owner before app.user_id is known.
--
-- See: docs/design/mcp-and-api.md, docs/security/threat-model.md §5.6,
--      docs/security/security-design-principles.md §9-10.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE "mcp_oauth_auth_codes" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grant for moni_app (0001 §4's pattern).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_oauth_auth_codes" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security. Same `nullif(..., '')` GUC guard as drizzle/0034 —
--    the pre-auth SELECT policy (§4) means the tenant qual is evaluated on a
--    pooled connection whose app.user_id may have reverted to '' after a prior
--    withUser() commit, where a bare `''::uuid` cast would throw. `nullif`
--    turns '' and unset alike into NULL (zero rows), never an error.
-- ---------------------------------------------------------------------------
ALTER TABLE "mcp_oauth_auth_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_auth_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_oauth_auth_codes_tenant_isolation" ON "mcp_oauth_auth_codes";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_auth_codes_tenant_isolation" ON "mcp_oauth_auth_codes"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Pre-auth lookup policy (mirrors drizzle/0034's mcp_oauth_grants_app_select).
--
-- The /token authorization_code exchange must find the row *by code_hash*
-- before it knows which user owns it, i.e. before app.user_id is set. The
-- tenant-isolation policy above returns zero rows for that lookup. This
-- SELECT-only policy lets moni_app read a row so the OAuth layer can resolve it
-- to one owner_id, unwrap DK, then re-enter under withUser(owner_id) to mark
-- the code consumed and mint the grant.
--
-- Safe for the same reason: neither exposed secret column is usable without the
-- presented code secret. `code_hash` is a one-way hash; `wrapped_dk` is DK
-- ciphertext that only a KEK derived from the secret can open. Engages ONLY in
-- the pre-auth window (app.user_id unset); once scoped, tenant_isolation is the
-- only policy in force.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "mcp_oauth_auth_codes_app_select" ON "mcp_oauth_auth_codes";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_auth_codes_app_select" ON "mcp_oauth_auth_codes"
  FOR SELECT
  TO moni_app
  USING (nullif(current_setting('app.user_id', true), '') IS NULL);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. updated_at trigger (0001 §5/§7's pattern — reuses moni_set_updated_at()).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "mcp_oauth_auth_codes_set_updated_at"
  BEFORE UPDATE ON "mcp_oauth_auth_codes"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
