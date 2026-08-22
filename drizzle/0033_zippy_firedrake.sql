CREATE TABLE "mcp_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"refresh_token_hash" "bytea" NOT NULL,
	"refresh_wrapped_dk" "bytea" NOT NULL,
	"scope" text NOT NULL,
	"label" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_grants_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_grants_refresh_token_hash_unique" ON "mcp_oauth_grants" USING btree ("refresh_token_hash");