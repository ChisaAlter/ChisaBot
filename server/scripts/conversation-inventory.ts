import postgres from "postgres";

// Read-only cutover inventory. Counts and state names only: no people, message bodies or credentials.
const tables = [
  "users", "agents", "channels", "channel_agents", "intelligence_channel_mappings",
  "openbot_local_threads", "openbot_local_runs", "openbot_local_events",
  "attachments", "chisabot_chat_files", "chisabot_chat_shots", "skills", "personal_memories",
  "approval_requests", "chisabot_confirm_requests", "chisabot_thread_inbox",
  "chisabot_workers", "chisabot_local_agent_tasks", "chisabot_schedules", "chisabot_schedule_runs",
  "workflow_runs", "responsibility_runs", "chisabot_task_center_tasks", "delivery_outbox", "work_items",
  "chisabot_runtime_bindings", "chisabot_dsh_runs", "chisabot_conversation_commands",
  "chisabot_tool_operations", "chisabot_conversation_interactions",
] as const;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const database = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const inventory = await database.begin("isolation level repeatable read read only", async sql => {
    const entries: Record<string, unknown> = {};
    for (const table of tables) {
      const columns = await sql<{ column_name: string; data_type: string }[]>`
        select column_name, data_type from information_schema.columns
        where table_schema='public' and table_name=${table}`;
      if (!columns.length) { entries[table] = { exists: false }; continue; }
      const [total] = await sql`select count(*)::text as count from ${sql(table)}`;
      const status = columns.find(column => column.column_name === "status" && column.data_type === "text");
      const states = status ? await sql`select status, count(*)::text as count from ${sql(table)} group by status order by status` : undefined;
      entries[table] = { count: total!.count, ...(states ? { states } : {}) };
    }
    if ((entries.openbot_local_threads as { exists?: boolean }).exists !== false) {
      const [history] = await sql`select count(*) filter(where lock_expires_at > now())::text as active_leases,
        coalesce(sum(case when jsonb_typeof(messages)='array' then jsonb_array_length(messages) else 0 end),0)::text as messages,
        count(*) filter(where jsonb_typeof(messages) is distinct from 'array')::text as invalid_snapshots
        from openbot_local_threads`;
      entries.history = history;
    }
    return entries;
  });
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), tables: inventory }, null, 2));
} finally { await database.end({ timeout: 5 }); }
