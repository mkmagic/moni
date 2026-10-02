CREATE TABLE "investment_opening_cash_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount_ct" "bytea" NOT NULL,
	"provenance" "investment_evidence_provenance" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_opening_cash_evidence_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "investment_opening_cash_evidence_account_currency_unique" UNIQUE("owner_id","account_id","currency")
);
--> statement-breakpoint
ALTER TABLE "investment_opening_cash_evidence" ADD CONSTRAINT "investment_opening_cash_evidence_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_opening_cash_evidence" ADD CONSTRAINT "investment_opening_cash_evidence_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_opening_cash_evidence" OWNER TO moni_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "investment_opening_cash_evidence" TO moni_app;
--> statement-breakpoint
ALTER TABLE "investment_opening_cash_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "investment_opening_cash_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "investment_opening_cash_evidence_tenant_isolation" ON "investment_opening_cash_evidence"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "investment_opening_cash_evidence_set_updated_at"
  BEFORE UPDATE ON "investment_opening_cash_evidence" FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
