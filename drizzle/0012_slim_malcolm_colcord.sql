ALTER TABLE "user_unlock_methods" ALTER COLUMN "wrapped_data_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_unlock_methods" ALTER COLUMN "wrapped_credential_key" DROP NOT NULL;