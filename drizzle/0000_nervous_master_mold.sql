CREATE TYPE "public"."account_classification" AS ENUM('asset', 'liability');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('checking', 'savings', 'credit_card', 'investment', 'loan', 'other_asset', 'other_liability');--> statement-breakpoint
CREATE TYPE "public"."category_classification" AS ENUM('income', 'expense', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."entry_field_change_source" AS ENUM('bank', 'rule', 'model', 'user');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."reconcile_state" AS ENUM('new', 'matched', 'promoted', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_staging_scraper_status" AS ENUM('pending', 'completed');--> statement-breakpoint
CREATE TYPE "public"."account_balance_snapshot_source" AS ENUM('scrape', 'manual');--> statement-breakpoint
CREATE TYPE "public"."entry_source" AS ENUM('scrape', 'manual', 'rule', 'model');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('posted', 'pending');--> statement-breakpoint
CREATE TYPE "public"."entry_transaction_kind" AS ENUM('standard', 'transfer', 'fee', 'refund');--> statement-breakpoint
CREATE TYPE "public"."entry_type" AS ENUM('transaction', 'trade');--> statement-breakpoint
CREATE TYPE "public"."fx_status" AS ENUM('locked', 'pending');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_type" "account_type" NOT NULL,
	"classification" "account_classification" NOT NULL,
	"connection_id" uuid,
	"name_ct" "bytea" NOT NULL,
	"institution" text,
	"account_number_last4_ct" "bytea",
	"currency" text NOT NULL,
	"current_balance_ct" "bytea",
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"locked_attributes" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "credit_card_details" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"statement_close_day" integer NOT NULL,
	"payment_due_day" integer NOT NULL,
	"credit_limit_ct" "bytea",
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"classification" "category_classification" NOT NULL,
	"color" text,
	"icon" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "entry_field_changelog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"source" "entry_field_change_source" NOT NULL,
	"value_ct" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name_ct" "bytea" NOT NULL,
	"logo_url" text,
	"website_url" text,
	"source" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "recurring_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"merchant_id" uuid,
	"category_id" uuid,
	"cadence" text NOT NULL,
	"expected_amount_ct" "bytea" NOT NULL,
	"next_expected_date" date,
	"is_subscription" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_series_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "rule_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"parent_id" uuid,
	"condition_type" text NOT NULL,
	"operator" text NOT NULL,
	"value_ct" "bytea",
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_conditions_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"resource_type" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"inflow_entry_id" uuid NOT NULL,
	"outflow_entry_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"credentials_ct" "bytea" NOT NULL,
	"status" "connection_status" NOT NULL,
	"last_sync_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" "sync_run_status" NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_runs_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "sync_staging" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"account_id" uuid,
	"raw_payload_ct" "bytea" NOT NULL,
	"import_key" text NOT NULL,
	"scraper_status" "sync_staging_scraper_status" NOT NULL,
	"reconcile_state" "reconcile_state" DEFAULT 'new' NOT NULL,
	"promoted_entry_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"native_balance_ct" "bytea" NOT NULL,
	"currency" text NOT NULL,
	"source" "account_balance_snapshot_source" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"base_currency" text DEFAULT 'ILS' NOT NULL,
	"wrapped_data_key" "bytea",
	"unlock_method_ref" jsonb,
	"recovery_code_hashes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"entry_type" "entry_type" NOT NULL,
	"date" date NOT NULL,
	"description_ct" "bytea" NOT NULL,
	"notes_ct" "bytea",
	"category_id" uuid,
	"merchant_id" uuid,
	"recurring_series_id" uuid,
	"status" "entry_status" NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"entered_amount_ct" "bytea" NOT NULL,
	"entered_currency" text NOT NULL,
	"account_amount_ct" "bytea" NOT NULL,
	"account_currency" text NOT NULL,
	"reporting_currency" text NOT NULL,
	"fx_rate" numeric,
	"fx_rate_date" date,
	"fx_source" text,
	"fx_status" "fx_status" NOT NULL,
	"import_key" text,
	"external_id" text,
	"source" "entry_source" NOT NULL,
	"locked_attributes" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "entry_transactions" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" "entry_transaction_kind" NOT NULL,
	"installment_number" integer,
	"total_installments" integer,
	"installment_total_amount_ct" "bytea",
	"installment_purchase_date" date,
	"installment_group_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"date" date NOT NULL,
	"rate" numeric NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_from_to_date_source_unique" UNIQUE("from_currency","to_currency","date","source")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_connection_id_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_details" ADD CONSTRAINT "credit_card_details_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_parent_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","parent_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_field_changelog" ADD CONSTRAINT "entry_field_changelog_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_field_changelog" ADD CONSTRAINT "entry_field_changelog_owner_id_entry_id_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","entry_id") REFERENCES "public"."entries"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_owner_id_merchant_id_merchants_owner_id_id_fk" FOREIGN KEY ("owner_id","merchant_id") REFERENCES "public"."merchants"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_owner_id_category_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_actions" ADD CONSTRAINT "rule_actions_owner_id_rule_id_rules_owner_id_id_fk" FOREIGN KEY ("owner_id","rule_id") REFERENCES "public"."rules"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_conditions" ADD CONSTRAINT "rule_conditions_owner_id_rule_id_rules_owner_id_id_fk" FOREIGN KEY ("owner_id","rule_id") REFERENCES "public"."rules"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_conditions" ADD CONSTRAINT "rule_conditions_owner_id_parent_id_rule_conditions_owner_id_id_fk" FOREIGN KEY ("owner_id","parent_id") REFERENCES "public"."rule_conditions"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_owner_id_inflow_entry_id_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","inflow_entry_id") REFERENCES "public"."entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_owner_id_outflow_entry_id_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","outflow_entry_id") REFERENCES "public"."entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_owner_id_connection_id_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_staging" ADD CONSTRAINT "sync_staging_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_staging" ADD CONSTRAINT "sync_staging_owner_id_sync_run_id_sync_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","sync_run_id") REFERENCES "public"."sync_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_staging" ADD CONSTRAINT "sync_staging_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_staging" ADD CONSTRAINT "sync_staging_owner_id_promoted_entry_id_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","promoted_entry_id") REFERENCES "public"."entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_owner_id_category_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_owner_id_merchant_id_merchants_owner_id_id_fk" FOREIGN KEY ("owner_id","merchant_id") REFERENCES "public"."merchants"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_owner_id_recurring_series_id_recurring_series_owner_id_id_fk" FOREIGN KEY ("owner_id","recurring_series_id") REFERENCES "public"."recurring_series"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_transactions" ADD CONSTRAINT "entry_transactions_owner_id_entry_id_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","entry_id") REFERENCES "public"."entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_owner_account_date_idx" ON "entries" USING btree ("owner_id","account_id","date");--> statement-breakpoint
CREATE INDEX "entries_owner_category_date_idx" ON "entries" USING btree ("owner_id","category_id","date");