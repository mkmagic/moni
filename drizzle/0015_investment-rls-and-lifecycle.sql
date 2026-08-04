-- Custom SQL migration file, put your code below! --
-- Investment persistence needs the same ownership/RLS/updated_at wiring as
-- the existing user-owned tables. Drizzle does not model roles, policies,
-- triggers, CHECK constraints, or deferrable cross-table subtype rules.

-- Existing archived rows predate archived_at. Preserve their archival state
-- using the status row's current timestamp before making the two columns a
-- consistent lifecycle pair.
UPDATE "accounts" SET "archived_at" = "updated_at"
WHERE "status" = 'archived' AND "archived_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "connections"
  ADD CONSTRAINT "connections_disconnected_credentials_check"
  CHECK ("status" <> 'disconnected' OR "credentials_ct" IS NULL);
--> statement-breakpoint
ALTER TABLE "connections"
  ADD CONSTRAINT "connections_mode_credentials_check"
  CHECK (
    ("mode" = 'user_mediated_import' AND "credentials_ct" IS NULL)
    OR ("mode" = 'credentialed_fetch' AND ("status" = 'disconnected' OR "credentials_ct" IS NOT NULL))
  );
--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_archive_status_check"
  CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "account_balance_snapshots"
  ADD CONSTRAINT "account_balance_snapshots_balance_currency_pair_check"
  CHECK (("native_balance_ct" IS NULL) = ("currency" IS NULL));
--> statement-breakpoint
ALTER TABLE "sync_runs"
  ADD CONSTRAINT "sync_runs_investment_source_check"
  CHECK ("investment_source" IS NULL OR "investment_source" IN ('ibkr_flex', 'schwab_positions_csv'));
--> statement-breakpoint
ALTER TABLE "sync_runs"
  ADD CONSTRAINT "sync_runs_investment_counts_check"
  CHECK (
    ("declared_account_count" IS NULL OR "declared_account_count" >= 0)
    AND ("promoted_account_count" IS NULL OR "promoted_account_count" >= 0)
    AND ("promoted_position_count" IS NULL OR "promoted_position_count" >= 0)
    AND ("promoted_cash_balance_count" IS NULL OR "promoted_cash_balance_count" >= 0)
  );
--> statement-breakpoint
ALTER TABLE "investment_snapshot_details"
  ADD CONSTRAINT "investment_snapshot_details_week_start_sunday_check"
  CHECK (extract(dow FROM "week_start") = 0);
--> statement-breakpoint
ALTER TABLE "investment_snapshot_details"
  ADD CONSTRAINT "investment_snapshot_details_validation_version_check"
  CHECK ("validation_version" > 0 AND "version" > 0);
--> statement-breakpoint
ALTER TABLE "investment_snapshot_positions"
  ADD CONSTRAINT "investment_snapshot_positions_price_currency_pair_check"
  CHECK (("source_price_ct" IS NULL) = ("source_price_currency" IS NULL));
--> statement-breakpoint
ALTER TABLE "investment_snapshot_positions"
  ADD CONSTRAINT "investment_snapshot_positions_value_currency_pair_check"
  CHECK (("source_value_ct" IS NULL) = ("source_value_currency" IS NULL));
--> statement-breakpoint
ALTER TABLE "investment_snapshot_positions"
  ADD CONSTRAINT "investment_snapshot_positions_version_check"
  CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE "investment_snapshot_cash_balances"
  ADD CONSTRAINT "investment_snapshot_cash_balances_version_check"
  CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE "instrument_source_mappings"
  ADD CONSTRAINT "instrument_source_mappings_version_check"
  CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE "instruments"
  ADD CONSTRAINT "instruments_version_check"
  CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE "investment_market_quotes"
  ADD CONSTRAINT "investment_market_quotes_version_check"
  CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE "investment_source_evidence"
  ADD CONSTRAINT "investment_source_evidence_counts_check"
  CHECK (
    "validation_version" > 0
    AND "position_row_count" >= 0
    AND "cash_row_count" >= 0
    AND ("source_period_end" IS NULL OR "source_period_start" IS NULL OR "source_period_start" <= "source_period_end")
  );
--> statement-breakpoint

-- The parent has nullable balance columns only so an investment snapshot can
-- use the detail subtype. Constraint triggers are deferred so promotion can
-- create/replace the parent and detail in one transaction in either order.
CREATE OR REPLACE FUNCTION moni_validate_investment_snapshot_subtype_row(
  snapshot_owner uuid,
  snapshot_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_account_id uuid;
  snapshot_source account_balance_snapshot_source;
  snapshot_balance bytea;
  snapshot_currency text;
  account_type_value account_type;
  account_classification_value account_classification;
  account_current_balance bytea;
BEGIN
  SELECT "account_id", "source", "native_balance_ct", "currency"
    INTO snapshot_account_id, snapshot_source, snapshot_balance, snapshot_currency
    FROM "account_balance_snapshots"
    WHERE "owner_id" = snapshot_owner AND "id" = snapshot_id;

  -- A cascading permanent delete can remove the parent before this deferred
  -- trigger runs. There is then nothing left to validate.
  IF NOT FOUND THEN RETURN; END IF;

  IF snapshot_source = 'investment' THEN
    IF snapshot_balance IS NOT NULL OR snapshot_currency IS NOT NULL THEN
      RAISE EXCEPTION 'investment snapshots require null balance and currency';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "investment_snapshot_details"
      WHERE "owner_id" = snapshot_owner
        AND "account_balance_snapshot_id" = snapshot_id
        AND "account_id" = snapshot_account_id
    ) THEN
      RAISE EXCEPTION 'investment snapshot requires one matching detail row';
    END IF;
    SELECT "account_type", "classification", "current_balance_ct"
      INTO account_type_value, account_classification_value, account_current_balance
      FROM "accounts"
      WHERE "owner_id" = snapshot_owner AND "id" = snapshot_account_id;
    IF NOT FOUND OR account_type_value <> 'investment' OR account_classification_value <> 'asset'
      OR account_current_balance IS NOT NULL THEN
      RAISE EXCEPTION 'investment detail requires an asset investment account without a cached balance';
    END IF;
  ELSE
    IF snapshot_balance IS NULL OR snapshot_currency IS NULL THEN
      RAISE EXCEPTION 'ordinary snapshots require balance and currency';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "investment_snapshot_details"
      WHERE "owner_id" = snapshot_owner AND "account_balance_snapshot_id" = snapshot_id
    ) THEN
      RAISE EXCEPTION 'ordinary snapshot cannot have an investment detail';
    END IF;
  END IF;

  RETURN;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION moni_validate_investment_snapshot_subtype()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_row record;
BEGIN
  IF TG_TABLE_NAME = 'accounts' THEN
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    FOR snapshot_row IN
      SELECT "owner_id", "id" FROM "account_balance_snapshots"
      WHERE "owner_id" = NEW.owner_id AND "account_id" = NEW.id AND "source" = 'investment'
    LOOP
      PERFORM moni_validate_investment_snapshot_subtype_row(snapshot_row.owner_id, snapshot_row.id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'account_balance_snapshots' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM moni_validate_investment_snapshot_subtype_row(OLD.owner_id, OLD.id);
    ELSE
      PERFORM moni_validate_investment_snapshot_subtype_row(NEW.owner_id, NEW.id);
      IF TG_OP = 'UPDATE' AND (OLD.owner_id, OLD.id) IS DISTINCT FROM (NEW.owner_id, NEW.id) THEN
        PERFORM moni_validate_investment_snapshot_subtype_row(OLD.owner_id, OLD.id);
      END IF;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM moni_validate_investment_snapshot_subtype_row(OLD.owner_id, OLD.account_balance_snapshot_id);
  ELSE
    -- Reparenting must leave both the former and new parent valid at commit.
    PERFORM moni_validate_investment_snapshot_subtype_row(NEW.owner_id, NEW.account_balance_snapshot_id);
    IF TG_OP = 'UPDATE' AND (OLD.owner_id, OLD.account_balance_snapshot_id) IS DISTINCT FROM (NEW.owner_id, NEW.account_balance_snapshot_id) THEN
      PERFORM moni_validate_investment_snapshot_subtype_row(OLD.owner_id, OLD.account_balance_snapshot_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "account_balance_snapshots_investment_subtype_check"
  AFTER INSERT OR UPDATE OR DELETE ON "account_balance_snapshots"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION moni_validate_investment_snapshot_subtype();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "investment_snapshot_details_parent_subtype_check"
  AFTER INSERT OR UPDATE OR DELETE ON "investment_snapshot_details"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION moni_validate_investment_snapshot_subtype();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "accounts_investment_subtype_check"
  AFTER UPDATE OF "account_type", "classification", "current_balance_ct" ON "accounts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION moni_validate_investment_snapshot_subtype();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION moni_validate_investment_quote_provider_row(
  quote_owner uuid,
  quote_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  quote_provider investment_provider;
  mapping_provider investment_provider;
BEGIN
  SELECT q."provider", m."provider"
    INTO quote_provider, mapping_provider
    FROM "investment_market_quotes" q
    JOIN "instrument_source_mappings" m
      ON m."owner_id" = q."owner_id"
      AND m."id" = q."instrument_source_mapping_id"
      AND m."instrument_id" = q."instrument_id"
    WHERE q."owner_id" = quote_owner AND q."id" = quote_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF quote_provider <> mapping_provider THEN
    RAISE EXCEPTION 'investment quote provider must match its source mapping';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION moni_validate_investment_quote_provider()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  quote_row record;
BEGIN
  IF TG_TABLE_NAME = 'investment_market_quotes' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM moni_validate_investment_quote_provider_row(NEW.owner_id, NEW.id);
    END IF;
    IF TG_OP = 'UPDATE' THEN
      PERFORM moni_validate_investment_quote_provider_row(OLD.owner_id, OLD.id);
    END IF;
  ELSIF TG_OP <> 'DELETE' THEN
    FOR quote_row IN
      SELECT "owner_id", "id" FROM "investment_market_quotes"
      WHERE "owner_id" = NEW.owner_id AND "instrument_source_mapping_id" = NEW.id
    LOOP
      PERFORM moni_validate_investment_quote_provider_row(quote_row.owner_id, quote_row.id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "investment_market_quotes_provider_check"
  AFTER INSERT OR UPDATE OR DELETE ON "investment_market_quotes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION moni_validate_investment_quote_provider();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "instrument_source_mappings_quote_provider_check"
  AFTER UPDATE OF "provider" OR DELETE ON "instrument_source_mappings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION moni_validate_investment_quote_provider();

-- A fresh bootstrap can apply 0014 as the Docker superuser before the
-- operator switches DATABASE_URL_MIGRATE to moni_owner. Transfer the enum
-- objects too, otherwise later ALTER TYPE migrations would fail even though
-- all of the tables have the intended owner.
ALTER TYPE "connection_mode" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "broker_valuation_basis" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "instrument_kind" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "investment_provider" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "investment_source" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "investment_quote_quality_state" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "investment_quote_split_state" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "investment_reconciliation_state" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "source_as_of_precision" OWNER TO moni_owner;
--> statement-breakpoint

ALTER TABLE "instruments" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "instrument_source_mappings" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "investment_snapshot_details" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "investment_snapshot_positions" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "investment_snapshot_cash_balances" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "investment_source_evidence" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "investment_market_quotes" OWNER TO moni_owner;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "instruments" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "instrument_source_mappings" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_snapshot_details" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_snapshot_positions" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_snapshot_cash_balances" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_source_evidence" TO moni_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_market_quotes" TO moni_app;
--> statement-breakpoint

ALTER TABLE "instruments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "instruments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "instruments_tenant_isolation" ON "instruments"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "instrument_source_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "instrument_source_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "instrument_source_mappings_tenant_isolation" ON "instrument_source_mappings"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "investment_snapshot_details" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_snapshot_details" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_snapshot_details_tenant_isolation" ON "investment_snapshot_details"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "investment_snapshot_positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_snapshot_positions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_snapshot_positions_tenant_isolation" ON "investment_snapshot_positions"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "investment_snapshot_cash_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_snapshot_cash_balances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_snapshot_cash_balances_tenant_isolation" ON "investment_snapshot_cash_balances"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "investment_source_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_source_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_source_evidence_tenant_isolation" ON "investment_source_evidence"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "investment_market_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_market_quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_market_quotes_tenant_isolation" ON "investment_market_quotes"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

CREATE OR REPLACE TRIGGER "instruments_set_updated_at"
  BEFORE UPDATE ON "instruments" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "instrument_source_mappings_set_updated_at"
  BEFORE UPDATE ON "instrument_source_mappings" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_snapshot_details_set_updated_at"
  BEFORE UPDATE ON "investment_snapshot_details" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_snapshot_positions_set_updated_at"
  BEFORE UPDATE ON "investment_snapshot_positions" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_snapshot_cash_balances_set_updated_at"
  BEFORE UPDATE ON "investment_snapshot_cash_balances" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_source_evidence_set_updated_at"
  BEFORE UPDATE ON "investment_source_evidence" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_market_quotes_set_updated_at"
  BEFORE UPDATE ON "investment_market_quotes" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
