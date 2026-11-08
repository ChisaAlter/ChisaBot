CREATE TABLE IF NOT EXISTS "chisabot_personal_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"connection_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"thread_id" text,
	"run_id" text,
	"agent_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"receipt" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chisabot_personal_deliveries" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chisabot_personal_deliveries" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chisabot_personal_deliveries_pending" ON "chisabot_personal_deliveries" USING btree ("kind") WHERE "chisabot_personal_deliveries"."state" IN ('queued','sending');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chisabot_personal_deliveries_owner" ON "chisabot_personal_deliveries" USING btree ("owner_user_id","created_at");
--> statement-breakpoint
-- Personal sources is a legacy ensure-owned table. Fresh installs create it at service startup.
ALTER TABLE IF EXISTS "chisabot_personal_sources" ADD COLUMN IF NOT EXISTS "calendar_timezone" text NOT NULL DEFAULT 'Asia/Shanghai';
