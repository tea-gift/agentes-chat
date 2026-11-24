ALTER TABLE "machine_device_codes" ADD COLUMN "target_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_device_codes" ADD COLUMN "issued_via" text DEFAULT 'device' NOT NULL;