CREATE TYPE "public"."investment_lot_allocation_provenance" AS ENUM('broker_reported', 'user_selected', 'pending');--> statement-breakpoint
CREATE TABLE "investment_lot_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"sell_activity_evidence_id" uuid NOT NULL,
	"closed_tax_lot_id" uuid NOT NULL,
	"closed_quantity_ct" "bytea" NOT NULL,
	"proceeds_ct" "bytea" NOT NULL,
	"realized_cost_basis_ct" "bytea" NOT NULL,
	"locked_fx_rate_ct" "bytea",
	"locked_fx_convention" text NOT NULL,
	"locked_fx_observation_date" date,
	"locked_fx_provenance" "investment_fx_provenance" NOT NULL,
	"allocation_provenance" "investment_lot_allocation_provenance" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_lot_closures_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_lot_closures_owner_sell_lot_unique" UNIQUE("owner_id","sell_activity_evidence_id","closed_tax_lot_id")
);
--> statement-breakpoint
ALTER TABLE "investment_activity_evidence" ADD COLUMN "broker_open_date_time_ct" "bytea";--> statement-breakpoint
ALTER TABLE "investment_activity_evidence" ADD COLUMN "broker_lot_allocations_ct" "bytea";--> statement-breakpoint
ALTER TABLE "investment_lot_closures" ADD CONSTRAINT "investment_lot_closures_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lot_closures" ADD CONSTRAINT "investment_lot_closures_owner_id_sell_activity_evidence_id_investment_activity_evidence_owner_id_id_fk" FOREIGN KEY ("owner_id","sell_activity_evidence_id") REFERENCES "public"."investment_activity_evidence"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lot_closures" ADD CONSTRAINT "investment_lot_closures_owner_id_closed_tax_lot_id_investment_tax_lots_owner_id_id_fk" FOREIGN KEY ("owner_id","closed_tax_lot_id") REFERENCES "public"."investment_tax_lots"("owner_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TYPE "public"."investment_lot_allocation_provenance" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "investment_lot_closures" ADD CONSTRAINT "investment_lot_closures_fx_check" CHECK (
  ("locked_fx_provenance" = 'unresolved' AND "locked_fx_rate_ct" IS NULL AND "locked_fx_observation_date" IS NULL)
  OR ("locked_fx_provenance" = 'boi_derived' AND "locked_fx_rate_ct" IS NOT NULL AND "locked_fx_observation_date" IS NOT NULL)
  OR ("locked_fx_provenance" = 'user_entered' AND "locked_fx_rate_ct" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "investment_lot_closures" OWNER TO moni_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_lot_closures" TO moni_app;
--> statement-breakpoint
ALTER TABLE "investment_lot_closures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "investment_lot_closures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "investment_lot_closures_tenant_isolation" ON "investment_lot_closures"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_lot_closures_set_updated_at"
  BEFORE UPDATE ON "investment_lot_closures" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
