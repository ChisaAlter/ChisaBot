/** Read-only operational signals from the existing ledgers; never retry or change an effect. */
type Query = (statement: string, parameters: string[]) => PromiseLike<Record<string, unknown>[]>;

export type AssistantSignals = {
  ok: boolean;
  state: "clear_in_sample" | "needs_attention" | "unavailable";
  taskFailureStreak: number;
  scheduleFailureStreak: number;
  failureThreshold: 3;
  failureWindowHours: 24;
  unknown: { personalDeliveriesAtLeast: number; toolOperationsAtLeast: number };
  coverage: {
    scope: "owner_recent_sample";
    unknownCounts: "lower_bound";
    tasks: number;
    personalDeliveries: number;
    conversations: number;
    toolOperations: number;
    taskLimit: 100;
    deliveryLimit: 100;
    conversationLimit: 20;
    operationsPerSession: 64;
    imOutbox: "not_sampled";
  };
};

function streak(rows: Record<string, unknown>[]) {
  const firstSuccess = rows.findIndex(row => row.status !== "failed");
  return firstSuccess < 0 ? rows.length : firstSuccess;
}

/** Each sample uses an existing owner/time or binding/session index, with no ledger-wide count. */
export async function readAssistantSignals(query: Query, ownerUserId: string): Promise<AssistantSignals> {
  const [tasks, schedules, deliveries, operations] = await Promise.all([
    query(`WITH recent AS MATERIALIZED (
      SELECT status,finished_at,id FROM chisabot_task_center_tasks
      WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 100
    ) SELECT status FROM recent WHERE status IN ('failed','succeeded')
      AND finished_at>=now()-interval '24 hours' ORDER BY finished_at DESC,id DESC LIMIT 3`, [ownerUserId]),
    query(`SELECT status FROM chisabot_schedule_runs WHERE owner_user_id=$1
      AND status IN ('failed','ok') AND finished_at>=now()-interval '24 hours'
      ORDER BY finished_at DESC LIMIT 3`, [ownerUserId]),
    query(`SELECT state FROM chisabot_personal_deliveries WHERE owner_user_id=$1
      ORDER BY created_at DESC LIMIT 100`, [ownerUserId]),
    query(`WITH recent_threads AS MATERIALIZED (
      SELECT id FROM openbot_local_threads WHERE owner_user_id=$1 ORDER BY updated_at DESC LIMIT 20
    ), recent_bindings AS MATERIALIZED (
      SELECT b.id,b.session_id FROM recent_threads t CROSS JOIN LATERAL (
        SELECT id,session_id FROM chisabot_runtime_bindings
        WHERE thread_id=t.id AND owner_user_id=$1 ORDER BY revision DESC LIMIT 1
      ) b
    ) SELECT b.id AS binding,op.status FROM recent_bindings b LEFT JOIN LATERAL (
      SELECT status FROM chisabot_tool_operations WHERE binding_id=b.id AND session_id=b.session_id
        AND owner_user_id=$1 ORDER BY turn_number DESC,step_number DESC,call_id DESC LIMIT 64
    ) op ON true`, [ownerUserId]),
  ]);
  const taskFailureStreak = streak(tasks);
  const scheduleFailureStreak = streak(schedules);
  const unknown = {
    personalDeliveriesAtLeast: deliveries.filter(row => row.state === "outcome_unknown").length,
    toolOperationsAtLeast: operations.filter(row => row.status === "outcome_unknown").length,
  };
  const ok = taskFailureStreak < 3 && scheduleFailureStreak < 3
    && unknown.personalDeliveriesAtLeast === 0 && unknown.toolOperationsAtLeast === 0;
  return {
    ok, state: ok ? "clear_in_sample" : "needs_attention",
    taskFailureStreak, scheduleFailureStreak, failureThreshold: 3, failureWindowHours: 24, unknown,
    coverage: { scope: "owner_recent_sample", unknownCounts: "lower_bound",
      tasks: tasks.length, personalDeliveries: deliveries.length,
      conversations: new Set(operations.map(row => row.binding)).size,
      toolOperations: operations.filter(row => row.status !== null).length,
      taskLimit: 100, deliveryLimit: 100, conversationLimit: 20, operationsPerSession: 64,
      imOutbox: "not_sampled",
    },
  };
}
