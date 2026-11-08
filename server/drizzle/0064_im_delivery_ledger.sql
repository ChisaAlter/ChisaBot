CREATE TABLE IF NOT EXISTS "chisabot_im_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"inbound" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chisabot_im_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"inbound" jsonb NOT NULL,
	"text" text NOT NULL,
	"chunks" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"receipt" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chisabot_im_inbox_pending" ON "chisabot_im_inbox" USING btree ("connection_id") WHERE "chisabot_im_inbox"."state"='pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chisabot_im_outbox_pending" ON "chisabot_im_outbox" USING btree ("connection_id") WHERE "chisabot_im_outbox"."state" IN ('queued','sending');
