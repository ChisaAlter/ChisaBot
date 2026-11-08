import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, foreignKey, index, integer, jsonb, pgTable,
  primaryKey, text, timestamp, unique, uniqueIndex,
} from "drizzle-orm/pg-core";

/** Product transcript and execution leases; DSH keeps its model history in its own Session log. */
export const localThreads = pgTable("openbot_local_threads", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  agentId: text("agent_id").notNull(),
  name: text("name"),
  archived: boolean("archived").notNull().default(false),
  messages: jsonb("messages").notNull().default([]),
  state: jsonb("state").notNull().default({}),
  runId: text("run_id"),
  lockExpiresAt: timestamp("lock_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  snapshotSequence: bigint("snapshot_sequence", { mode: "bigint" }),
}, table => [index("openbot_local_threads_owner_updated").on(table.ownerUserId, table.updatedAt.desc().nullsFirst())]);

export const localRuns = pgTable("openbot_local_runs", {
  threadId: text("thread_id").notNull(),
  runId: text("run_id").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, table => [
  primaryKey({ name: "openbot_local_runs_pkey", columns: [table.threadId, table.runId] }),
  foreignKey({ name: "openbot_local_runs_thread_id_fkey", columns: [table.threadId], foreignColumns: [localThreads.id] }).onDelete("cascade"),
]);

export const localEvents = pgTable("openbot_local_events", {
  sequence: bigserial("sequence", { mode: "bigint" }).primaryKey(),
  threadId: text("thread_id").notNull(),
  runId: text("run_id").notNull(),
  event: jsonb("event").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ name: "openbot_local_events_thread_id_fkey", columns: [table.threadId], foreignColumns: [localThreads.id] }).onDelete("cascade"),
  index("openbot_local_events_thread_sequence").on(table.threadId, table.sequence),
]);

export const runtimeBindings = pgTable("chisabot_runtime_bindings", {
  id: text("id").primaryKey(), threadId: text("thread_id").notNull(), revision: integer("revision").notNull(),
  ownerUserId: text("owner_user_id").notNull(), botId: text("bot_id").notNull(),
  runtimeId: text("runtime_id").notNull(), sessionId: text("session_id").notNull(),
  kernel: text("kernel").notNull().default("dsh"), active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique("chisabot_runtime_bindings_thread_id_revision_key").on(table.threadId, table.revision),
  unique("chisabot_runtime_bindings_runtime_id_session_id_key").on(table.runtimeId, table.sessionId),
  uniqueIndex("chisabot_runtime_binding_active").on(table.threadId).where(sql`${table.active}`),
]);

export const conversationCommands = pgTable("chisabot_conversation_commands", {
  threadId: text("thread_id").notNull(), commandId: text("command_id").notNull(), runId: text("run_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(), botId: text("bot_id").notNull(),
  payload: jsonb("payload").notNull(), input: jsonb("input").notNull(),
  status: text("status").notNull().default("accepted"), executionRunId: text("execution_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ name: "chisabot_conversation_commands_pkey", columns: [table.threadId, table.commandId] }),
  unique("chisabot_conversation_commands_thread_id_run_id_key").on(table.threadId, table.runId),
]);

export const dshRuns = pgTable("chisabot_dsh_runs", {
  threadId: text("thread_id").notNull(), runId: text("run_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(), botId: text("bot_id").notNull(),
  sessionId: text("session_id").notNull(), bindingRevision: integer("binding_revision").notNull(),
  generation: text("generation").notNull(), baseline: integer("baseline").notNull(),
  input: jsonb("input").notNull(), status: text("status").notNull(),
  stopRequested: boolean("stop_requested").notNull().default(false),
  initiator: jsonb("initiator").notNull().default({ kind: "person" }), requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ name: "chisabot_dsh_runs_pkey", columns: [table.threadId, table.runId] })]);

export const toolOperations = pgTable("chisabot_tool_operations", {
  id: text("id").primaryKey(), ownerUserId: text("owner_user_id").notNull(), bindingId: text("binding_id").notNull(),
  sessionId: text("session_id").notNull(), runId: text("run_id").notNull(), callId: text("call_id").notNull(),
  turnNumber: integer("turn_number").notNull(), stepNumber: integer("step_number").notNull(),
  toolName: text("tool_name").notNull(), args: jsonb("args").notNull(), status: text("status").notNull(),
  result: jsonb("result"), confirmationId: text("confirmation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [unique("chisabot_tool_operations_binding_id_session_id_turn_number__key")
  .on(table.bindingId, table.sessionId, table.turnNumber, table.stepNumber, table.callId)]);

export const conversationInteractions = pgTable("chisabot_conversation_interactions", {
  callId: text("call_id").primaryKey(), ownerUserId: text("owner_user_id").notNull(),
  threadId: text("thread_id").notNull(), runId: text("run_id").notNull(), toolName: text("tool_name").notNull(),
  args: jsonb("args").notNull(), continuation: jsonb("continuation").notNull(),
  status: text("status").notNull().default("pending"), answer: jsonb("answer"), answerInput: jsonb("answer_input"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
});

/** Existing confirmation cards retain their identifiers and gain a durable continuation. */
export const confirmRequests = pgTable("chisabot_confirm_requests", {
  id: text("id").primaryKey(), ownerUserId: text("owner_user_id").notNull(), agentId: text("agent_id").notNull(),
  threadId: text("thread_id"), toolCallId: text("tool_call_id"), category: text("category").notNull(),
  tool: text("tool").notNull(), title: text("title").notNull(), target: text("target"),
  details: jsonb("details").notNull().default([]), digest: text("digest").notNull().default(""),
  status: text("status").notNull().default("pending"), decidedVia: text("decided_via"), external: text("external"),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  decidedAt: timestamp("decided_at", { withTimezone: true }), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  continuation: jsonb("continuation"),
}, table => [
  index("chisabot_confirm_requests_thread").on(table.ownerUserId, table.threadId, table.createdAt),
  index("chisabot_confirm_requests_owner").on(table.ownerUserId, table.createdAt),
  index("chisabot_confirm_requests_external").on(table.external).where(sql`${table.external} IS NOT NULL`),
]);

export const legacyImports = pgTable("chisabot_legacy_imports", {
  threadId: text("thread_id").primaryKey(), ownerUserId: text("owner_user_id").notNull(), botId: text("bot_id").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(), source: jsonb("source").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [foreignKey({ name: "chisabot_legacy_imports_thread_id_fkey", columns: [table.threadId], foreignColumns: [localThreads.id] }).onDelete("cascade")]);
