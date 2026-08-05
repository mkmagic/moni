CREATE TYPE "public"."long_term_savings_liquidity" AS ENUM('locked_retirement', 'liquid_after', 'liquid');--> statement-breakpoint
CREATE TYPE "public"."long_term_savings_product" AS ENUM('pension', 'hishtalmut', 'gemel', 'gemel_investment', 'managers_insurance');--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE IF NOT EXISTS 'long_term_savings';--> statement-breakpoint
ALTER TYPE "public"."account_balance_snapshot_source" ADD VALUE IF NOT EXISTS 'long_term_savings';--> statement-breakpoint
CREATE TABLE "long_term_savings_details" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"product" "long_term_savings_product" NOT NULL,
	"liquidity" "long_term_savings_liquidity" NOT NULL,
	"liquid_from" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_term_savings_snapshot_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"employer_ct" "bytea",
	"deposit_date" date NOT NULL,
	"for_month" text NOT NULL,
	"salary_ct" "bytea",
	"employee_ct" "bytea" NOT NULL,
	"employer_contribution_ct" "bytea" NOT NULL,
	"severance_ct" "bytea" NOT NULL,
	"total_ct" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_term_savings_snapshot_deposits_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "long_term_savings_snapshot_deposits_owner_snapshot_row_unique" UNIQUE("owner_id","snapshot_id","row_index")
);
--> statement-breakpoint
CREATE TABLE "long_term_savings_snapshot_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"name_ct" "bytea" NOT NULL,
	"return_pct" numeric,
	"annual_cost_pct" numeric,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_term_savings_snapshot_tracks_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "long_term_savings_snapshot_tracks_owner_snapshot_row_unique" UNIQUE("owner_id","snapshot_id","row_index")
);
--> statement-breakpoint
CREATE TABLE "long_term_savings_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_balance_snapshot_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"stated_period_start" date NOT NULL,
	"stated_period_end" date NOT NULL,
	"quarter" integer,
	"fiscal_year" integer,
	"currency" text NOT NULL,
	"closing_balance_ct" "bytea" NOT NULL,
	"opening_balance_ct" "bytea" NOT NULL,
	"contributions_ct" "bytea" NOT NULL,
	"investment_result_ct" "bytea" NOT NULL,
	"fees_charged_ct" "bytea" NOT NULL,
	"insurance_disability_ct" "bytea" NOT NULL,
	"insurance_death_ct" "bytea" NOT NULL,
	"fee_rate_deposit" numeric,
	"fee_rate_savings" numeric,
	"fund_avg_fee_deposit" numeric,
	"fund_avg_fee_savings" numeric,
	"projection_retirement_age" integer,
	"projection_monthly_pension_ct" "bytea",
	"projection_survivor_pension_ct" "bytea",
	"projection_orphan_pension_ct" "bytea",
	"projection_dependent_parent_pension_ct" "bytea",
	"projection_disability_pension_ct" "bytea",
	"projection_contribution_waiver_ct" "bytea",
	"deposits_total_employee_ct" "bytea",
	"deposits_total_employer_ct" "bytea",
	"deposits_total_severance_ct" "bytea",
	"deposits_total_ct" "bytea",
	"balance_drift_ct" "bytea" NOT NULL,
	"check_results_ct" "bytea" NOT NULL,
	"parser_id" text NOT NULL,
	"parser_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_term_savings_snapshots_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "long_term_savings_snapshots_owner_account_as_of_unique" UNIQUE("owner_id","account_id","as_of"),
	CONSTRAINT "long_term_savings_snapshots_owner_balance_snapshot_unique" UNIQUE("owner_id","account_balance_snapshot_id")
);
--> statement-breakpoint
ALTER TABLE "long_term_savings_details" ADD CONSTRAINT "long_term_savings_details_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshot_deposits" ADD CONSTRAINT "long_term_savings_snapshot_deposits_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshot_deposits" ADD CONSTRAINT "long_term_savings_snapshot_deposits_owner_id_snapshot_id_long_term_savings_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","snapshot_id") REFERENCES "public"."long_term_savings_snapshots"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshot_tracks" ADD CONSTRAINT "long_term_savings_snapshot_tracks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshot_tracks" ADD CONSTRAINT "long_term_savings_snapshot_tracks_owner_id_snapshot_id_long_term_savings_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","snapshot_id") REFERENCES "public"."long_term_savings_snapshots"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshots" ADD CONSTRAINT "long_term_savings_snapshots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshots" ADD CONSTRAINT "long_term_savings_snapshots_owner_id_account_balance_snapshot_id_account_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","account_balance_snapshot_id") REFERENCES "public"."account_balance_snapshots"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshots" ADD CONSTRAINT "long_term_savings_snapshots_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshots" ADD CONSTRAINT "long_term_savings_snapshots_owner_id_connection_id_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_savings_snapshots" ADD CONSTRAINT "long_term_savings_snapshots_owner_id_sync_run_id_sync_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","sync_run_id") REFERENCES "public"."sync_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;