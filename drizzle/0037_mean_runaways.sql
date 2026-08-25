ALTER TABLE "agent_access_log" ALTER COLUMN "token_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_access_log" ADD COLUMN "oauth_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_access_log" ADD CONSTRAINT "agent_access_log_oauth_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("oauth_grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_access_log_oauth_grant_id_created_at_idx" ON "agent_access_log" USING btree ("oauth_grant_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_access_log" ADD CONSTRAINT "agent_access_log_one_credential_check" CHECK (num_nonnulls("agent_access_log"."token_id", "agent_access_log"."oauth_grant_id") = 1);