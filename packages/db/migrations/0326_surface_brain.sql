-- deploy-safe: dropping this check only widens the allowed delivery kinds (adds 'brain_request'); no running version inserts that kind, and the old code's reads and writes still work on the migrated database.
ALTER TABLE "surface_deliveries" DROP CONSTRAINT "surface_deliveries_kind";--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "brain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_links_one_brain_per_account_agent" ON "surface_links" USING btree ("user_id","surface",coalesce("agent_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "surface_links"."status" = 'active' and "surface_links"."brain" = true;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_kind" CHECK ("surface_deliveries"."kind" in ('reply', 'linked', 'brain_request'));