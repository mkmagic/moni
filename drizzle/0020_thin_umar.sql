CREATE TABLE "merchant_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"match_text_ct" "bytea" NOT NULL,
	"builtin_key" text,
	"confidence" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_lookups_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "smart_categorize" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_lookups" ADD CONSTRAINT "merchant_lookups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;