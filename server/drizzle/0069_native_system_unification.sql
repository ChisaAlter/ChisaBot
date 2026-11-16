CREATE TABLE "chisabot_usage_ledger" (
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chisabot_usage_ledger_pkey" PRIMARY KEY("user_id","day","model")
);
--> statement-breakpoint
CREATE TABLE "chisabot_user_quotas" (
	"user_id" text PRIMARY KEY NOT NULL,
	"daily_token_limit" bigint,
	"monthly_token_limit" bigint,
	"daily_request_limit" integer,
	"bypass_admin" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chisabot_local_threads" ADD COLUMN "thread_kind" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "chisabot_local_threads" ADD COLUMN "parent_thread_id" text;--> statement-breakpoint
ALTER TABLE "chisabot_local_threads" ADD COLUMN "anchor_message_id" text;--> statement-breakpoint
ALTER TABLE "chisabot_im_outbox" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "step_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "resume_token_hash" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "resume_reason" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "resume_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chisabot_usage_ledger_day_idx" ON "chisabot_usage_ledger" USING btree ("day");--> statement-breakpoint
CREATE INDEX "chisabot_local_threads_parent_idx" ON "chisabot_local_threads" USING btree ("owner_user_id","parent_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_resume_token_idx" ON "workflow_runs" USING btree ("resume_token_hash");