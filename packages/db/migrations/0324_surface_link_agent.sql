-- deploy-safe: dropping this index only relaxes a uniqueness rule (one active link per account); no running version reads the index, and the old code's confirm (delete the account's active links, then activate one) still works on the migrated database.
DROP INDEX "surface_links_one_per_account";--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_links_one_per_account_agent" ON "surface_links" USING btree ("user_id","surface",coalesce("agent_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "surface_links"."status" = 'active';
