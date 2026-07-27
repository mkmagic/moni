CREATE TYPE "public"."category_suggestion_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "category_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"category_id" uuid,
	"confidence" numeric,
	"model" text NOT NULL,
	"status" "category_suggestion_status" DEFAULT 'pending' NOT NULL,
	"reason_ct" "bytea",
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_suggestions_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "category_suggestions_owner_id_entry_id_unique" UNIQUE("owner_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "builtin_key" text;--> statement-breakpoint
ALTER TABLE "category_suggestions" ADD CONSTRAINT "category_suggestions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_suggestions" ADD CONSTRAINT "category_suggestions_owner_id_entry_id_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","entry_id") REFERENCES "public"."entries"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_suggestions" ADD CONSTRAINT "category_suggestions_owner_id_category_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_builtin_key_unique" UNIQUE("owner_id","builtin_key");