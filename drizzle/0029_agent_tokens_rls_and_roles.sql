-- Moni — grants + RLS + pre-auth lookup + updated_at trigger for agent_tokens
--
-- Hand-authored (drizzle-kit's schema diffing doesn't model roles/policies/
-- triggers), created via `drizzle-kit generate --custom`. Applied by the
-- normal `drizzle-kit migrate` step as moni_owner — no superuser required.
--
-- See: docs/design/mcp-and-api.md §4/§7, docs/security/threat-model.md §5.6,
--      docs/security/security-design-principles.md §9-10.

-- ---------------------------------------------------------------------------
-- 1. Table ownership -> moni_owner (0001 §3's pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_tokens" OWNER TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Per-table grant for moni_app (0001 §4's pattern — an ordinary user-owned
--    table, so it gets the same blanket grant as the rest).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_tokens" TO moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security. Follows 0001 §6, but with ONE deliberate difference
--    from the standard form: the GUC is wrapped in `nullif(..., '')` before
--    the ::uuid cast.
--
--    Why: this table needs a pre-auth SELECT policy (§4 below), and unlike
--    `users_app_select`'s bare `USING(true)`, that policy does not constant-
--    fold the tenant qual away. So on a POOLED connection whose app.user_id
--    has reverted to '' after a prior withUser() commit (documented in
--    rls-isolation.test.ts), the standard `''::uuid` cast would THROW while
--    evaluating this qual — breaking the unscoped verify lookup. `nullif`
--    turns both '' and unset into NULL, so `owner_id = NULL` yields NULL
--    (zero rows) instead of an error. Still fail-closed: an unset/empty GUC
--    sees nothing here; only the pre-auth SELECT policy admits the lookup.
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_tokens_tenant_isolation" ON "agent_tokens";
--> statement-breakpoint
CREATE POLICY "agent_tokens_tenant_isolation" ON "agent_tokens"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Pre-auth lookup policy (mirrors drizzle/0002's users_app_select).
--
-- Verifying a presented agent token is a chicken-and-egg step under RLS: the
-- server must find the row *by token_hash* before it knows which user owns it,
-- i.e. before app.user_id is set. The tenant-isolation policy above returns
-- zero rows for that lookup. This SELECT-only policy lets moni_app read a row
-- by hash so verify can resolve token -> one owner_id, then re-enter under
-- `withUser(owner_id)` for everything else.
--
-- Safe for the same reason users_app_select is: neither exposed column is
-- usable without the token secret. `token_hash` is a one-way hash; `wrapped_dk`
-- is DK ciphertext that only a KEK derived from the secret can open. Reading
-- the row cross-user yields nothing exploitable — no Tier-1 amount, balance,
-- or description.
--
-- Scoped to the pre-auth window ONLY: this policy engages only when
-- app.user_id is unset (the verify path uses the unscoped pool, before any
-- user is resolved). The moment a request runs inside withUser() — as
-- listTokens()/revokeToken() do — app.user_id is set, this policy yields
-- nothing, and the tenant_isolation policy above is the only one in force,
-- so a user's own token list stays scoped to them. (Permissive policies OR
-- for SELECT, which is exactly why a bare USING(true) here would leak every
-- owner's row to every scoped read — it must be gated on the unset GUC.)
-- Writes (INSERT/UPDATE/DELETE) stay locked to owner_id = app.user_id by the
-- FOR ALL policy above, unaffected.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "agent_tokens_app_select" ON "agent_tokens";
--> statement-breakpoint
CREATE POLICY "agent_tokens_app_select" ON "agent_tokens"
  FOR SELECT
  TO moni_app
  USING (nullif(current_setting('app.user_id', true), '') IS NULL);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. updated_at trigger (0001 §5/§7's pattern — reuses the existing
--    moni_set_updated_at() function, not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "agent_tokens_set_updated_at"
  BEFORE UPDATE ON "agent_tokens"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
