CREATE TYPE "public"."connection_mode" AS ENUM('credentialed_fetch', 'user_mediated_import');--> statement-breakpoint
CREATE TYPE "public"."broker_valuation_basis" AS ENUM('market_value', 'quantity_times_price');--> statement-breakpoint
CREATE TYPE "public"."instrument_kind" AS ENUM('stock', 'etf', 'mutual_fund', 'generic');--> statement-breakpoint
CREATE TYPE "public"."investment_provider" AS ENUM('ibkr_flex', 'schwab_positions_csv', 'tiingo');--> statement-breakpoint
CREATE TYPE "public"."investment_source" AS ENUM('ibkr_flex', 'schwab_positions_csv');--> statement-breakpoint
CREATE TYPE "public"."investment_quote_quality_state" AS ENUM('accepted', 'stale');--> statement-breakpoint
CREATE TYPE "public"."investment_quote_split_state" AS ENUM('safe', 'post_split', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."investment_reconciliation_state" AS ENUM('matched', 'mismatch');--> statement-breakpoint
CREATE TYPE "public"."source_as_of_precision" AS ENUM('date', 'timestamp');--> statement-breakpoint
ALTER TYPE "public"."account_balance_snapshot_source" ADD VALUE 'investment';--> statement-breakpoint
CREATE TABLE "instrument_source_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"provider" "investment_provider" NOT NULL,
	"identifier_kind" text NOT NULL,
	"provider_identifier_ct" "bytea" NOT NULL,
	"provider_symbol_ct" "bytea",
	"provider_name_ct" "bytea",
	"exchange_ct" "bytea",
	"currency" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_source_mappings_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "instrument_source_mappings_owner_id_id_instrument_id_unique" UNIQUE("owner_id","id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" "instrument_kind" NOT NULL,
	"canonical_name_ct" "bytea",
	"canonical_symbol_ct" "bytea",
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "investment_market_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"instrument_source_mapping_id" uuid NOT NULL,
	"provider" "investment_provider" NOT NULL,
	"provider_symbol_ct" "bytea" NOT NULL,
	"price_ct" "bytea" NOT NULL,
	"currency" text NOT NULL,
	"source_date" date NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"split_state" "investment_quote_split_state" NOT NULL,
	"quality_state" "investment_quote_quality_state" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_market_quotes_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_market_quotes_owner_instrument_provider_unique" UNIQUE("owner_id","instrument_id","provider")
);
--> statement-breakpoint
CREATE TABLE "investment_snapshot_cash_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount_ct" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_snapshot_cash_balances_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_snapshot_cash_balances_owner_snapshot_currency_unique" UNIQUE("owner_id","snapshot_id","currency")
);
--> statement-breakpoint
CREATE TABLE "investment_snapshot_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_balance_snapshot_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"source" "investment_source" NOT NULL,
	"source_as_of" timestamp with time zone NOT NULL,
	"source_as_of_precision" "source_as_of_precision" NOT NULL,
	"broker_total_ct" "bytea" NOT NULL,
	"broker_total_currency" text NOT NULL,
	"reconciliation_state" "investment_reconciliation_state" NOT NULL,
	"validation_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_snapshot_details_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_snapshot_details_owner_id_snapshot_unique" UNIQUE("owner_id","account_balance_snapshot_id"),
	CONSTRAINT "investment_snapshot_details_owner_id_account_week_unique" UNIQUE("owner_id","account_id","week_start")
);
--> statement-breakpoint
CREATE TABLE "investment_snapshot_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"quantity_ct" "bytea" NOT NULL,
	"quantity_unit" text NOT NULL,
	"currency" text NOT NULL,
	"source_price_ct" "bytea",
	"source_price_currency" text,
	"source_value_ct" "bytea",
	"source_value_currency" text,
	"source_as_of" timestamp with time zone,
	"broker_valuation_basis" "broker_valuation_basis" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_snapshot_positions_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_snapshot_positions_owner_snapshot_instrument_unique" UNIQUE("owner_id","snapshot_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "investment_source_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source" "investment_source" NOT NULL,
	"source_period_start" timestamp with time zone,
	"source_period_end" timestamp with time zone,
	"source_as_of" timestamp with time zone NOT NULL,
	"source_as_of_precision" "source_as_of_precision" NOT NULL,
	"validation_version" integer NOT NULL,
	"position_row_count" integer NOT NULL,
	"cash_row_count" integer NOT NULL,
	"quality_codes" text[] NOT NULL,
	"normalized_fingerprint" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_source_evidence_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_source_evidence_owner_sync_account_unique" UNIQUE("owner_id","sync_run_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "credentials_ct" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ALTER COLUMN "native_balance_ct" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "mode" "connection_mode" DEFAULT 'credentialed_fetch' NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "investment_source" text;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "declared_account_count" integer;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "promoted_account_count" integer;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "promoted_position_count" integer;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "promoted_cash_balance_count" integer;--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_owner_id_id_unique" UNIQUE("owner_id","id");--> statement-breakpoint
ALTER TABLE "instrument_source_mappings" ADD CONSTRAINT "instrument_source_mappings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_source_mappings" ADD CONSTRAINT "instrument_source_mappings_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_market_quotes" ADD CONSTRAINT "investment_market_quotes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_market_quotes" ADD CONSTRAINT "investment_market_quotes_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_market_quotes" ADD CONSTRAINT "investment_market_quotes_owner_id_instrument_source_mapping_id_instrument_id_instrument_source_mappings_owner_id_id_instrument_id_fk" FOREIGN KEY ("owner_id","instrument_source_mapping_id","instrument_id") REFERENCES "public"."instrument_source_mappings"("owner_id","id","instrument_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_cash_balances" ADD CONSTRAINT "investment_snapshot_cash_balances_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_cash_balances" ADD CONSTRAINT "investment_snapshot_cash_balances_owner_id_snapshot_id_investment_snapshot_details_owner_id_id_fk" FOREIGN KEY ("owner_id","snapshot_id") REFERENCES "public"."investment_snapshot_details"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_details" ADD CONSTRAINT "investment_snapshot_details_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_details" ADD CONSTRAINT "investment_snapshot_details_owner_id_account_balance_snapshot_id_account_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","account_balance_snapshot_id") REFERENCES "public"."account_balance_snapshots"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_details" ADD CONSTRAINT "investment_snapshot_details_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_details" ADD CONSTRAINT "investment_snapshot_details_owner_id_connection_id_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_details" ADD CONSTRAINT "investment_snapshot_details_owner_id_sync_run_id_sync_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","sync_run_id") REFERENCES "public"."sync_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_positions" ADD CONSTRAINT "investment_snapshot_positions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_positions" ADD CONSTRAINT "investment_snapshot_positions_owner_id_snapshot_id_investment_snapshot_details_owner_id_id_fk" FOREIGN KEY ("owner_id","snapshot_id") REFERENCES "public"."investment_snapshot_details"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_snapshot_positions" ADD CONSTRAINT "investment_snapshot_positions_owner_id_instrument_id_instruments_owner_id_id_fk" FOREIGN KEY ("owner_id","instrument_id") REFERENCES "public"."instruments"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_source_evidence" ADD CONSTRAINT "investment_source_evidence_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_source_evidence" ADD CONSTRAINT "investment_source_evidence_owner_id_connection_id_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_source_evidence" ADD CONSTRAINT "investment_source_evidence_owner_id_sync_run_id_sync_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","sync_run_id") REFERENCES "public"."sync_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_source_evidence" ADD CONSTRAINT "investment_source_evidence_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
