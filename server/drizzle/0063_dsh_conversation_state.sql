-- Formalize the runtime-owned conversation schema without replacing existing histories.
-- Additive ALTERs also upgrade databases that already ran an earlier runtime ensure().
CREATE TABLE IF NOT EXISTS "openbot_local_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text,
	"archived" boolean DEFAULT false NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" text,
	"lock_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_sequence" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chisabot_confirm_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text,
	"tool_call_id" text,
	"category" text NOT NULL,
	"tool" text NOT NULL,
	"title" text NOT NULL,
	"target" text,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_via" text,
	"external" text,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"continuation" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chisabot_conversation_commands" (
	"thread_id" text NOT NULL,
	"command_id" text NOT NULL,
	"run_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"execution_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chisabot_conversation_commands_pkey" PRIMARY KEY("thread_id","command_id"),
	CONSTRAINT "chisabot_conversation_commands_thread_id_run_id_key" UNIQUE("thread_id","run_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chisabot_conversation_interactions" (
	"call_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"continuation" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"answer_input" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chisabot_dsh_runs" (
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"session_id" text NOT NULL,
	"binding_revision" integer NOT NULL,
	"generation" text NOT NULL,
	"baseline" integer NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"initiator" jsonb DEFAULT '{"kind":"person"}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chisabot_dsh_runs_pkey" PRIMARY KEY("thread_id","run_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chisabot_legacy_imports" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"source" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chisabot_legacy_imports_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "openbot_local_threads"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "openbot_local_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openbot_local_events_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "openbot_local_threads"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "openbot_local_runs" (
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "openbot_local_runs_pkey" PRIMARY KEY("thread_id","run_id"),
	CONSTRAINT "openbot_local_runs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "openbot_local_threads"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chisabot_runtime_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"revision" integer NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"session_id" text NOT NULL,
	"kernel" text DEFAULT 'dsh' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chisabot_runtime_bindings_thread_id_revision_key" UNIQUE("thread_id","revision"),
	CONSTRAINT "chisabot_runtime_bindings_runtime_id_session_id_key" UNIQUE("runtime_id","session_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chisabot_tool_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"session_id" text NOT NULL,
	"run_id" text NOT NULL,
	"call_id" text NOT NULL,
	"turn_number" integer NOT NULL,
	"step_number" integer NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"confirmation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chisabot_tool_operations_binding_id_session_id_turn_number__key" UNIQUE("binding_id","session_id","turn_number","step_number","call_id")
);
--> statement-breakpoint
ALTER TABLE "openbot_local_threads" ADD COLUMN IF NOT EXISTS "snapshot_sequence" bigint;
--> statement-breakpoint
ALTER TABLE "chisabot_confirm_requests" ADD COLUMN IF NOT EXISTS "continuation" jsonb;
--> statement-breakpoint
ALTER TABLE "chisabot_conversation_commands" ADD COLUMN IF NOT EXISTS "execution_run_id" text;
--> statement-breakpoint
ALTER TABLE "chisabot_conversation_interactions" ADD COLUMN IF NOT EXISTS "answer_input" jsonb;
--> statement-breakpoint
ALTER TABLE "chisabot_tool_operations" ADD COLUMN IF NOT EXISTS "confirmation_id" text;
--> statement-breakpoint
ALTER TABLE "chisabot_dsh_runs" ADD COLUMN IF NOT EXISTS "initiator" jsonb NOT NULL DEFAULT '{"kind":"person"}'::jsonb;
--> statement-breakpoint
ALTER TABLE "chisabot_dsh_runs" ADD COLUMN IF NOT EXISTS "request_id" text;
--> statement-breakpoint
UPDATE "openbot_local_threads" t SET "snapshot_sequence"=(SELECT coalesce(max(sequence),0) FROM "openbot_local_events" e WHERE e.thread_id=t.id) WHERE t.snapshot_sequence IS NULL;
--> statement-breakpoint
UPDATE "chisabot_dsh_runs" SET "request_id"=coalesce(input->'resume'->0->>'interruptId', (SELECT m->>'id' FROM jsonb_array_elements(input->'messages') WITH ORDINALITY AS e(m,n) WHERE m->>'role'='user' ORDER BY n DESC LIMIT 1)) WHERE request_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chisabot_confirm_requests_thread" ON "chisabot_confirm_requests" USING btree ("owner_user_id","thread_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chisabot_confirm_requests_owner" ON "chisabot_confirm_requests" USING btree ("owner_user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chisabot_confirm_requests_external" ON "chisabot_confirm_requests" USING btree ("external") WHERE "chisabot_confirm_requests"."external" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "openbot_local_events_thread_sequence" ON "openbot_local_events" USING btree ("thread_id","sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "openbot_local_threads_owner_updated" ON "openbot_local_threads" USING btree ("owner_user_id","updated_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chisabot_runtime_binding_active" ON "chisabot_runtime_bindings" USING btree ("thread_id") WHERE "chisabot_runtime_bindings"."active";
