ALTER TABLE "household_budget_ceilings" DROP CONSTRAINT "household_budget_ceilings_household_id_shared_category_id_shared_categories_household_id_id_fk";
--> statement-breakpoint
ALTER TABLE "household_invitations" DROP CONSTRAINT "household_invitations_household_id_households_id_fk";
--> statement-breakpoint
ALTER TABLE "household_invitations" DROP CONSTRAINT "household_invitations_invited_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "household_invitations" DROP CONSTRAINT "household_invitations_accepted_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "household_members" DROP CONSTRAINT "household_members_household_id_households_id_fk";
--> statement-breakpoint
ALTER TABLE "household_members" DROP CONSTRAINT "household_members_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "households" DROP CONSTRAINT "households_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "published_category_totals" DROP CONSTRAINT "published_category_totals_member_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "published_category_totals" DROP CONSTRAINT "published_category_totals_household_id_shared_category_id_shared_categories_household_id_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_categories" DROP CONSTRAINT "shared_categories_household_id_households_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_categories" DROP CONSTRAINT "shared_categories_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_category_maps" DROP CONSTRAINT "shared_category_maps_household_id_shared_category_id_shared_categories_household_id_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_category_maps" DROP CONSTRAINT "shared_category_maps_member_id_local_category_id_categories_owner_id_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_category_splits" DROP CONSTRAINT "shared_category_splits_member_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_category_splits" DROP CONSTRAINT "shared_category_splits_household_id_shared_category_id_shared_categories_household_id_id_fk";
--> statement-breakpoint
ALTER TABLE "household_budget_ceilings" ADD CONSTRAINT "household_budget_ceilings_household_id_shared_category_id_shared_categories_household_id_id_fk" FOREIGN KEY ("household_id","shared_category_id") REFERENCES "public"."shared_categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_category_totals" ADD CONSTRAINT "published_category_totals_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_category_totals" ADD CONSTRAINT "published_category_totals_household_id_shared_category_id_shared_categories_household_id_id_fk" FOREIGN KEY ("household_id","shared_category_id") REFERENCES "public"."shared_categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_categories" ADD CONSTRAINT "shared_categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_categories" ADD CONSTRAINT "shared_categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_category_maps" ADD CONSTRAINT "shared_category_maps_household_id_shared_category_id_shared_categories_household_id_id_fk" FOREIGN KEY ("household_id","shared_category_id") REFERENCES "public"."shared_categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_category_maps" ADD CONSTRAINT "shared_category_maps_member_id_local_category_id_categories_owner_id_id_fk" FOREIGN KEY ("member_id","local_category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_category_splits" ADD CONSTRAINT "shared_category_splits_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_category_splits" ADD CONSTRAINT "shared_category_splits_household_id_shared_category_id_shared_categories_household_id_id_fk" FOREIGN KEY ("household_id","shared_category_id") REFERENCES "public"."shared_categories"("household_id","id") ON DELETE cascade ON UPDATE no action;