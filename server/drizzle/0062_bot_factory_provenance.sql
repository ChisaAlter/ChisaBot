ALTER TABLE "agent_profiles" ADD COLUMN "created_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "created_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_profiles_created_by_idx" ON "agent_profiles" USING btree ("created_by_agent_id");