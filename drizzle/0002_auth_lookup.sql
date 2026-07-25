-- Moni — pre-auth identity lookup policy (login support)
--
-- Hand-authored (drizzle-kit doesn't model policies), created via
-- `drizzle-kit generate --custom`. Applied by the normal
-- `drizzle-kit migrate` step as moni_owner — NO superuser required.
--
-- WHY THIS EXISTS
-- Login is a chicken-and-egg step under RLS: the server must read a user's
-- credential row *by email* before any user is authenticated, i.e. before
-- `app.user_id` is known. The `users_tenant_isolation` policy from 0001
-- (`FOR ALL USING id = current_setting('app.user_id')`) therefore returns
-- ZERO rows for the login lookup, because no `app.user_id` is set yet.
--
-- We resolve this by treating `users` as the identity/auth *anchor*, not as
-- tenant financial data. This policy lets the app role SELECT identity rows
-- so the login path can find a user by email. It is deliberately scoped:
--   * SELECT only — INSERT/UPDATE/DELETE stay locked to `id = app.user_id`
--     by the existing FOR ALL policy (permissive policies OR for SELECT, so
--     SELECT becomes allowed; writes are unaffected).
--   * `users` holds NO Tier-1 financial data — only email, base_currency,
--     the ENCRYPTED-and-useless `wrapped_data_key`, public KDF params, and
--     recovery-code hashes. Reading it does not expose amounts, balances,
--     descriptions, or any Tier-1 value.
--   * Every financial-data table (accounts, entries, account_balance_
--     snapshots, ...) keeps its own FORCE RLS keyed on `app.user_id`,
--     UNCHANGED. Cross-user isolation of *money* is untouched.
--
-- See docs/security/security-design-principles.md §9-10 (financial-data
-- isolation is the invariant; the identity table is an auth concern),
-- docs/design/domain-layer.md §2, and docs/design/data-model.md §2.

DROP POLICY IF EXISTS "users_app_select" ON "users";
--> statement-breakpoint
CREATE POLICY "users_app_select" ON "users"
  FOR SELECT
  TO moni_app
  USING (true);
