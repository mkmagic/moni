CREATE TABLE "budget_ceilings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"category_id" uuid,
	"amount_ct" "bytea",
	"effective_from" date NOT NULL,
	"rollover" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_ceilings_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "budget_ceilings_owner_category_effective_unique" UNIQUE NULLS NOT DISTINCT("owner_id","category_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "budget_incomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"amount_ct" "bytea" NOT NULL,
	"effective_from" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_incomes_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "budget_incomes_owner_effective_unique" UNIQUE("owner_id","effective_from")
);
--> statement-breakpoint
ALTER TABLE "budget_ceilings" ADD CONSTRAINT "budget_ceilings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_ceilings" ADD CONSTRAINT "budget_ceilings_owner_id_category_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incomes" ADD CONSTRAINT "budget_incomes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;