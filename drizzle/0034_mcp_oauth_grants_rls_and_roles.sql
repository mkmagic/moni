-- Moni — grants + RLS + pre-auth lookup + updated_at trigger for mcp_oauth_grants
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom`. Applied by the
-- normal `drizzle-kit migrate` step as moni_owner — no superuser required.
--
-- Structurally identical to drizzle/0029 (agent_tokens): an OAuth grant is the
-- same crown-jewel envelope at a longer lifetime, so it takes the same RLS
-- shape — tenant isolation for owner-scoped reads/writes plus a pre-auth SELECT
-- policy for the /token refresh lookup that resolves a presented refresh secret
-- to its owner before app.user_id is known.
--
-- See: docs/design/mcp-and-api.md, docs/security/threat-model.md §5.6,
--      docs/security/security-design-principles.md §9-10.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE "mcp_oauth_grants" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grant for moni_app (0001 §4's pattern — an ordinary user-owned
--    table, so it gets the same blanket grant as the rest).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_oauth_grants" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security. Follows 0001 §6, with the SAME deliberate difference
--    from the standard form as drizzle/0029: the GUC is wrapped in
--    `nullif(..., '')` before the ::uuid cast.
--
--    Why: this table needs a pre-auth SELECT policy (§4 below), and unlike
--    `users_app_select`'s bare `USING(true)`, that policy does not constant-
--    fold the tenant qual away. So on a POOLED connection whose app.user_id
--    has reverted to '' after a prior withUser() commit (documented in
--    rls-isolation.test.ts), the standard `''::uuid` cast would THROW while
--    evaluating this qual — breaking the unscoped refresh lookup. `nullif`
--    turns both '' and unset into NULL, so `owner_id = NULL` yields NULL
--    (zero rows) instead of an error. Still fail-closed: an unset/empty GUC
--    sees nothing here; only the pre-auth SELECT policy admits the lookup.
-- ---------------------------------------------------------------------------
ALTER TABLE "mcp_oauth_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_oauth_grants_tenant_isolation" ON "mcp_oauth_grants";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_grants_tenant_isolation" ON "mcp_oauth_grants"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Pre-auth lookup policy (mirrors drizzle/0029's agent_tokens_app_select,
--    itself modeled on drizzle/0002's users_app_select).
--
-- The /token refresh grant is a chicken-and-egg step under RLS: the server
-- must find the row *by refresh_token_hash* before it knows which user owns
-- it, i.e. before app.user_id is set. The stateless access-token path likewise
-- reads a grant row (to check `revoked_at`) in the unscoped pre-auth window.
-- The tenant-isolation policy above returns zero rows for those lookups. This
-- SELECT-only policy lets moni_app read a row so the OAuth layer can resolve
-- it to one owner_id, then re-enter under `withUser(owner_id)` for everything
-- else.
--
-- Safe for the same reason agent_tokens_app_select is: neither exposed secret
-- column is usable without the presented token secret. `refresh_token_hash` is
-- a one-way hash; `refresh_wrapped_dk` is DK ciphertext that only a KEK derived
-- from the secret can open. Reading the row cross-user yields nothing
-- exploitable — no Tier-1 amount, balance, or description.
--
-- Scoped to the pre-auth window ONLY: this policy engages only when
-- app.user_id is unset (the lookup uses the unscoped pool, before any user is
-- resolved). The moment a request runs inside withUser() — as listGrants()/
-- revokeGrant() would — app.user_id is set, this policy yields nothing, and
-- the tenant_isolation policy above is the only one in force, so a user's own
-- grant list stays scoped to them. (Permissive policies OR for SELECT, which
-- is exactly why a bare USING(true) here would leak every owner's row to every
-- scoped read — it must be gated on the unset GUC.) Writes (INSERT/UPDATE/
-- DELETE) stay locked to owner_id = app.user_id by the FOR ALL policy above,
-- unaffected.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "mcp_oauth_grants_app_select" ON "mcp_oauth_grants";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_grants_app_select" ON "mcp_oauth_grants"
  FOR SELECT
  TO moni_app
  USING (nullif(current_setting('app.user_id', true), '') IS NULL);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. updated_at trigger (0001 §5/§7's pattern — reuses the existing
--    moni_set_updated_at() function, not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "mcp_oauth_grants_set_updated_at"
  BEFORE UPDATE ON "mcp_oauth_grants"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
