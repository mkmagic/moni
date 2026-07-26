CREATE TYPE "public"."unlock_method_type" AS ENUM('password-argon2id', 'webauthn-prf', 'recovery-code');--> statement-breakpoint
CREATE TABLE "user_unlock_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"type" "unlock_method_type" NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"wrapped_credential_key" "bytea" NOT NULL,
	"unlock_ref" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_unlock_methods_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "external_account_ref_ct" "bytea";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "user_unlock_methods" ADD CONSTRAINT "user_unlock_methods_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_unlock_methods_one_password_per_owner" ON "user_unlock_methods" USING btree ("owner_id") WHERE "user_unlock_methods"."type" = 'password-argon2id';--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "wrapped_data_key";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "unlock_method_ref";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "recovery_code_hashes";