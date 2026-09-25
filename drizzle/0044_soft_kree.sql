CREATE TYPE "public"."investment_activity_type" AS ENUM('buy', 'sell', 'dividend', 'interest', 'fee', 'tax', 'deposit', 'withdrawal', 'transfer', 'other');--> statement-breakpoint
CREATE TYPE "public"."investment_completeness" AS ENUM('complete', 'partial', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."investment_coverage_basis" AS ENUM('provider_declared', 'earliest_observed');--> statement-breakpoint
CREATE TYPE "public"."investment_evidence_provenance" AS ENUM('broker_reported', 'user_entered', 'imported');--> statement-breakpoint
CREATE TYPE "public"."investment_fx_provenance" AS ENUM('boi_derived', 'user_entered', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."investment_reconciliation_dimension" AS ENUM('position_quantity', 'cash_balance', 'coverage_start', 'unexplained_opening_quantity', 'unsupported_corporate_action', 'pending_activity');--> statement-breakpoint
CREATE TYPE "public"."investment_resolution_kind" AS ENUM('unresolved_disposal', 'identity_ambiguity', 'reconciliation_gap');--> statement-breakpoint
CREATE TYPE "public"."investment_resolution_status" AS ENUM('pending', 'resolved');--> statement-breakpoint
ALTER TYPE "public"."investment_activity_type" OWNER TO moni_owner;
ALTER TYPE "public"."investment_completeness" OWNER TO moni_owner;
ALTER TYPE "public"."investment_coverage_basis" OWNER TO moni_owner;
ALTER TYPE "public"."investment_evidence_provenance" OWNER TO moni_owner;
ALTER TYPE "public"."investment_fx_provenance" OWNER TO moni_owner;
ALTER TYPE "public"."investment_reconciliation_dimension" OWNER TO moni_owner;
ALTER TYPE "public"."investment_resolution_kind" OWNER TO moni_owner;
ALTER TYPE "public"."investment_resolution_status" OWNER TO moni_owner;
--> statement-breakpoint
CREATE TABLE "investment_activity_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid,
	"source" "investment_source" NOT NULL,
	"metric" text NOT NULL,
	"coverage_start" date,
	"coverage_basis" "investment_coverage_basis",
	"completeness" "investment_completeness" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_activity_coverage_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_activity_coverage_scope_unique" UNIQUE NULLS NOT DISTINCT("owner_id","account_id","instrument_id","metric")
);
--> statement-breakpoint
CREATE TABLE "investment_activity_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid,
	"revision_of_id" uuid,
	"source" "investment_source" NOT NULL,
	"activity_type" "investment_activity_type" NOT NULL,
	"provider_activity_id_ct" "bytea",
	"provider_execution_id_ct" "bytea",
	"provider_trade_id_ct" "bytea",
	"idempotency_key" "bytea" NOT NULL,
	"trade_date" date NOT NULL,
	"settlement_date" date,
	"quantity_ct" "bytea",
	"quantity_unit" text,
	"price_ct" "bytea",
	"gross_amount_ct" "bytea",
	"fee_amount_ct" "bytea",
	"tax_amount_ct" "bytea",
	"net_cash_amount_ct" "bytea",
	"currency" text,
	"raw_type_ct" "bytea" NOT NULL,
	"raw_code_ct" "bytea",
	"raw_description_ct" "bytea",
	"provenance" "investment_evidence_provenance" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_activity_evidence_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_activity_evidence_owner_source_key_unique" UNIQUE("owner_id","source","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "investment_corporate_action_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid,
	"source" "investment_source" NOT NULL,
	"provider_action_id_ct" "bytea",
	"idempotency_key" "bytea" NOT NULL,
	"action_date" date NOT NULL,
	"raw_type_ct" "bytea" NOT NULL,
	"raw_code_ct" "bytea",
	"raw_description_ct" "bytea",
	"quantity_ct" "bytea",
	"proceeds_ct" "bytea",
	"currency" text,
	"classification" text DEFAULT 'UNSUPPORTED_CORPORATE_ACTION' NOT NULL,
	"provenance" "investment_evidence_provenance" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_corporate_action_evidence_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_corporate_action_evidence_owner_source_key_unique" UNIQUE("owner_id","source","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "investment_disposal_resolution_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"activity_evidence_id" uuid,
	"reconciliation_quality_id" uuid,
	"kind" "investment_resolution_kind" NOT NULL,
	"status" "investment_resolution_status" DEFAULT 'pending' NOT NULL,
	"details_ct" "bytea",
	"policy_version" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_disposal_resolution_queue_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "investment_opening_lot_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"idempotency_key" "bytea" NOT NULL,
	"broker_lot_id_ct" "bytea",
	"trade_date" date NOT NULL,
	"settlement_date" date,
	"original_quantity_ct" "bytea" NOT NULL,
	"remaining_quantity_ct" "bytea" NOT NULL,
	"quantity_unit" text NOT NULL,
	"unit_cost_ct" "bytea",
	"total_cost_ct" "bytea" NOT NULL,
	"fees_ct" "bytea",
	"currency" text NOT NULL,
	"locked_fx_rate_ct" "bytea",
	"locked_fx_convention" text,
	"locked_fx_observation_date" date,
	"locked_fx_provenance" "investment_fx_provenance" NOT NULL,
	"provenance" "investment_evidence_provenance" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_opening_lot_evidence_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_opening_lot_evidence_owner_key_unique" UNIQUE("owner_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "investment_reconciliation_quality" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid,
	"snapshot_id" uuid,
	"dimension" "investment_reconciliation_dimension" NOT NULL,
	"expected_value_ct" "bytea",
	"observed_value_ct" "bytea",
	"currency" text,
	"completeness" "investment_completeness" NOT NULL,
	"status" "investment_resolution_status" DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_reconciliation_quality_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "investment_tax_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"acquisition_activity_id" uuid,
	"opening_lot_evidence_id" uuid,
	"derivation_key" "bytea" NOT NULL,
	"policy_version" text NOT NULL,
	"trade_date" date NOT NULL,
	"settlement_date" date,
	"original_quantity_ct" "bytea" NOT NULL,
	"remaining_quantity_ct" "bytea" NOT NULL,
	"quantity_unit" text NOT NULL,
	"cost_basis_ct" "bytea" NOT NULL,
	"cost_basis_currency" text NOT NULL,
	"locked_fx_rate_ct" "bytea",
	"locked_fx_convention" text,
	"locked_fx_observation_date" date,
	"locked_fx_provenance" "investment_fx_provenance" NOT NULL,
	"completeness" "investment_completeness" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_tax_lots_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_tax_lots_owner_policy_key_unique" UNIQUE("owner_id","policy_version","derivation_key")
);
--> statement-breakpoint
ALTER TABLE "investment_activity_coverage" ADD CONSTRAINT "investment_activity_coverage_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_activity_coverage" ADD CONSTRAINT "investment_activity_coverage_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_activity_coverage" ADD CONSTRAINT "investment_activity_coverage_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_activity_evidence" ADD CONSTRAINT "investment_activity_evidence_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_activity_evidence" ADD CONSTRAINT "investment_activity_evidence_owner_id_connection_id_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_activity_evidence" ADD CONSTRAINT "investment_activity_evidence_owner_id_sync_run_id_sync_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","sync_run_id") REFERENCES "public"."sync_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_activity_evidence" ADD CONSTRAINT "investment_activity_evidence_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_activity_evidence" ADD CONSTRAINT "investment_activity_evidence_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_activity_evidence" ADD CONSTRAINT "investment_activity_evidence_owner_id_revision_of_id_investment_activity_evidence_owner_id_id_fk" FOREIGN KEY ("owner_id","revision_of_id") REFERENCES "public"."investment_activity_evidence"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_corporate_action_evidence" ADD CONSTRAINT "investment_corporate_action_evidence_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_corporate_action_evidence" ADD CONSTRAINT "investment_corporate_action_evidence_owner_id_connection_id_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_corporate_action_evidence" ADD CONSTRAINT "investment_corporate_action_evidence_owner_id_sync_run_id_sync_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","sync_run_id") REFERENCES "public"."sync_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_corporate_action_evidence" ADD CONSTRAINT "investment_corporate_action_evidence_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_corporate_action_evidence" ADD CONSTRAINT "investment_corporate_action_evidence_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_disposal_resolution_queue" ADD CONSTRAINT "investment_disposal_resolution_queue_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_disposal_resolution_queue" ADD CONSTRAINT "investment_disposal_resolution_queue_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_disposal_resolution_queue" ADD CONSTRAINT "investment_disposal_resolution_queue_owner_id_activity_evidence_id_investment_activity_evidence_owner_id_id_fk" FOREIGN KEY ("owner_id","activity_evidence_id") REFERENCES "public"."investment_activity_evidence"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_disposal_resolution_queue" ADD CONSTRAINT "investment_disposal_resolution_queue_owner_id_reconciliation_quality_id_investment_reconciliation_quality_owner_id_id_fk" FOREIGN KEY ("owner_id","reconciliation_quality_id") REFERENCES "public"."investment_reconciliation_quality"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_opening_lot_evidence" ADD CONSTRAINT "investment_opening_lot_evidence_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_opening_lot_evidence" ADD CONSTRAINT "investment_opening_lot_evidence_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_opening_lot_evidence" ADD CONSTRAINT "investment_opening_lot_evidence_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_reconciliation_quality" ADD CONSTRAINT "investment_reconciliation_quality_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_reconciliation_quality" ADD CONSTRAINT "investment_reconciliation_quality_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_reconciliation_quality" ADD CONSTRAINT "investment_reconciliation_quality_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_reconciliation_quality" ADD CONSTRAINT "investment_reconciliation_quality_owner_id_snapshot_id_investment_snapshot_details_owner_id_id_fk" FOREIGN KEY ("owner_id","snapshot_id") REFERENCES "public"."investment_snapshot_details"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_tax_lots" ADD CONSTRAINT "investment_tax_lots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_tax_lots" ADD CONSTRAINT "investment_tax_lots_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_tax_lots" ADD CONSTRAINT "investment_tax_lots_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_tax_lots" ADD CONSTRAINT "investment_tax_lots_owner_id_acquisition_activity_id_investment_activity_evidence_owner_id_id_fk" FOREIGN KEY ("owner_id","acquisition_activity_id") REFERENCES "public"."investment_activity_evidence"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_tax_lots" ADD CONSTRAINT "investment_tax_lots_owner_id_opening_lot_evidence_id_investment_opening_lot_evidence_owner_id_id_fk" FOREIGN KEY ("owner_id","opening_lot_evidence_id") REFERENCES "public"."investment_opening_lot_evidence"("owner_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "investment_activity_evidence"
  ADD CONSTRAINT "investment_activity_evidence_quantity_unit_pair_check"
  CHECK (("quantity_ct" IS NULL) = ("quantity_unit" IS NULL));
--> statement-breakpoint
ALTER TABLE "investment_corporate_action_evidence"
  ADD CONSTRAINT "investment_corporate_action_evidence_v1_classification_check"
  CHECK ("classification" = 'UNSUPPORTED_CORPORATE_ACTION');
--> statement-breakpoint
ALTER TABLE "investment_opening_lot_evidence"
  ADD CONSTRAINT "investment_opening_lot_evidence_fx_check"
  CHECK (
    ("locked_fx_provenance" = 'unresolved' AND "locked_fx_rate_ct" IS NULL
      AND "locked_fx_convention" IS NULL AND "locked_fx_observation_date" IS NULL)
    OR ("locked_fx_provenance" = 'boi_derived' AND "locked_fx_rate_ct" IS NOT NULL
      AND "locked_fx_convention" IS NOT NULL AND "locked_fx_observation_date" IS NOT NULL)
    OR ("locked_fx_provenance" = 'user_entered' AND "locked_fx_rate_ct" IS NOT NULL
      AND "locked_fx_convention" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "investment_tax_lots"
  ADD CONSTRAINT "investment_tax_lots_evidence_source_check"
  CHECK (num_nonnulls("acquisition_activity_id", "opening_lot_evidence_id") = 1);
--> statement-breakpoint
ALTER TABLE "investment_tax_lots"
  ADD CONSTRAINT "investment_tax_lots_fx_check"
  CHECK (
    ("locked_fx_provenance" = 'unresolved' AND "locked_fx_rate_ct" IS NULL
      AND "locked_fx_convention" IS NULL AND "locked_fx_observation_date" IS NULL)
    OR ("locked_fx_provenance" = 'boi_derived' AND "locked_fx_rate_ct" IS NOT NULL
      AND "locked_fx_convention" IS NOT NULL AND "locked_fx_observation_date" IS NOT NULL)
    OR ("locked_fx_provenance" = 'user_entered' AND "locked_fx_rate_ct" IS NOT NULL
      AND "locked_fx_convention" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "investment_reconciliation_quality"
  ADD CONSTRAINT "investment_reconciliation_quality_resolution_check"
  CHECK (("status" = 'resolved') = ("resolved_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "investment_disposal_resolution_queue"
  ADD CONSTRAINT "investment_disposal_resolution_queue_target_check"
  CHECK (
    ("kind" IN ('unresolved_disposal', 'identity_ambiguity')
      AND "activity_evidence_id" IS NOT NULL AND "reconciliation_quality_id" IS NULL)
    OR ("kind" = 'reconciliation_gap'
      AND "activity_evidence_id" IS NULL AND "reconciliation_quality_id" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "investment_disposal_resolution_queue"
  ADD CONSTRAINT "investment_disposal_resolution_queue_resolution_check"
  CHECK (("status" = 'resolved') = ("resolved_at" IS NOT NULL));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_activity_evidence" TO moni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_opening_lot_evidence" TO moni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_corporate_action_evidence" TO moni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_activity_coverage" TO moni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_tax_lots" TO moni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_reconciliation_quality" TO moni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_disposal_resolution_queue" TO moni_app;
--> statement-breakpoint

ALTER TABLE "investment_activity_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_activity_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_activity_evidence_tenant_isolation" ON "investment_activity_evidence"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "investment_opening_lot_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_opening_lot_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_opening_lot_evidence_tenant_isolation" ON "investment_opening_lot_evidence"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "investment_corporate_action_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_corporate_action_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_corporate_action_evidence_tenant_isolation" ON "investment_corporate_action_evidence"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "investment_activity_coverage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_activity_coverage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_activity_coverage_tenant_isolation" ON "investment_activity_coverage"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "investment_tax_lots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_tax_lots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_tax_lots_tenant_isolation" ON "investment_tax_lots"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "investment_reconciliation_quality" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_reconciliation_quality" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_reconciliation_quality_tenant_isolation" ON "investment_reconciliation_quality"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "investment_disposal_resolution_queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investment_disposal_resolution_queue" FORCE ROW LEVEL SECURITY;
CREATE POLICY "investment_disposal_resolution_queue_tenant_isolation" ON "investment_disposal_resolution_queue"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

CREATE OR REPLACE TRIGGER "investment_activity_evidence_set_updated_at"
  BEFORE UPDATE ON "investment_activity_evidence" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_opening_lot_evidence_set_updated_at"
  BEFORE UPDATE ON "investment_opening_lot_evidence" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_corporate_action_evidence_set_updated_at"
  BEFORE UPDATE ON "investment_corporate_action_evidence" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_activity_coverage_set_updated_at"
  BEFORE UPDATE ON "investment_activity_coverage" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_tax_lots_set_updated_at"
  BEFORE UPDATE ON "investment_tax_lots" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_reconciliation_quality_set_updated_at"
  BEFORE UPDATE ON "investment_reconciliation_quality" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_disposal_resolution_queue_set_updated_at"
  BEFORE UPDATE ON "investment_disposal_resolution_queue" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
