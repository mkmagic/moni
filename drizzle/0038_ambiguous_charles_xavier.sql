ALTER TABLE "mcp_oauth_grants" ALTER COLUMN "refresh_token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ALTER COLUMN "refresh_wrapped_dk" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_auth_codes" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "previous_refresh_token_hash" "bytea";--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "access_token_hash" "bytea";--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "access_wrapped_dk" "bytea";--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "access_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "resource" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_grants_access_token_hash_unique" ON "mcp_oauth_grants" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_grants_previous_refresh_token_hash_unique" ON "mcp_oauth_grants" USING btree ("previous_refresh_token_hash");