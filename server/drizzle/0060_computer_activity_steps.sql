CREATE TABLE "computer_activity_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"computer_id" text NOT NULL,
	"thread_id" text,
	"run_id" text,
	"tool_call_id" text,
	"actor_user_id" text,
	"actor_kind" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "computer_activity_steps_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"refusal_reason" text,
	"subject" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" text,
	"output_truncated" boolean DEFAULT false NOT NULL,
	"has_frame" boolean DEFAULT false NOT NULL,
	"turn_prompt" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "computer_activity_steps_call_uq" ON "computer_activity_steps" USING btree ("computer_id","tool_call_id") WHERE "computer_activity_steps"."tool_call_id" is not null;--> statement-breakpoint
CREATE INDEX "computer_activity_steps_thread_idx" ON "computer_activity_steps" USING btree ("thread_id","started_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "computer_activity_steps_computer_idx" ON "computer_activity_steps" USING btree ("computer_id","started_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "computer_activity_steps_running_idx" ON "computer_activity_steps" USING btree ("status") WHERE "computer_activity_steps"."status" = 'running';--> statement-breakpoint
CREATE INDEX "computer_activity_steps_started_idx" ON "computer_activity_steps" USING btree ("started_at");