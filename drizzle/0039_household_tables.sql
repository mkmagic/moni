CREATE TABLE "household_budget_ceilings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"shared_category_id" uuid NOT NULL,
	"amount_ct" "bytea",
	"effective_from" date NOT NULL,
	"rollover" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_budget_ceilings_effective_unique" UNIQUE("household_id","shared_category_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "household_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"invitee_email" text,
	"token_hash" "bytea" NOT NULL,
	"wrapped_group_key" "bytea" NOT NULL,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_invitations_household_id_id_unique" UNIQUE("household_id","id")
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"wrapped_group_key" "bytea" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_household_id_id_unique" UNIQUE("household_id","id"),
	CONSTRAINT "household_members_household_owner_unique" UNIQUE("household_id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_category_totals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"shared_category_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"month" date NOT NULL,
	"total_ct" "bytea" NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_category_totals_unique" UNIQUE("household_id","shared_category_id","member_id","month")
);
--> statement-breakpoint
CREATE TABLE "shared_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_categories_household_id_id_unique" UNIQUE("household_id","id")
);
--> statement-breakpoint
CREATE TABLE "shared_category_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"shared_category_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"local_category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_category_maps_unique" UNIQUE("household_id","shared_category_id","member_id","local_category_id")
);
--> statement-breakpoint
CREATE TABLE "shared_category_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"shared_category_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"weight" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_category_splits_member_unique" UNIQUE("household_id","shared_category_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "household_budget_ceilings" ADD CONSTRAINT "household_budget_ceilings_household_id_shared_category_id_shared_categories_household_id_id_fk" FOREIGN KEY ("household_id","shared_category_id") REFERENCES "public"."shared_categories"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_category_totals" ADD CONSTRAINT "published_category_totals_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_category_totals" ADD CONSTRAINT "published_category_totals_household_id_shared_category_id_shared_categories_household_id_id_fk" FOREIGN KEY ("household_id","shared_category_id") REFERENCES "public"."shared_categories"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_categories" ADD CONSTRAINT "shared_categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_categories" ADD CONSTRAINT "shared_categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_category_maps" ADD CONSTRAINT "shared_category_maps_household_id_shared_category_id_shared_categories_household_id_id_fk" FOREIGN KEY ("household_id","shared_category_id") REFERENCES "public"."shared_categories"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_category_maps" ADD CONSTRAINT "shared_category_maps_member_id_local_category_id_categories_owner_id_id_fk" FOREIGN KEY ("member_id","local_category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_category_splits" ADD CONSTRAINT "shared_category_splits_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_category_splits" ADD CONSTRAINT "shared_category_splits_household_id_shared_category_id_shared_categories_household_id_id_fk" FOREIGN KEY ("household_id","shared_category_id") REFERENCES "public"."shared_categories"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "household_invitations_token_hash_unique" ON "household_invitations" USING btree ("token_hash");