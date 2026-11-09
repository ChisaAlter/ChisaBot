import type { RunAgentInput, Message } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import type { Database } from "../db/client";
import { AsyncLocalStorage } from "node:async_hooks";

export const BACKGROUND_CAPACITY = 2;
export const CAPACITY_WAIT_MESSAGE = "后台执行位已满，任务已保留并排队；你可以继续对话。";
export type ExecutionClass = { kind: "background" | "foreground"; initiator: AuditInitiator };
export type QueuedExecution = ExecutionClass & {
  input: RunAgentInput;
  persistedInputMessages?: Message[];
  continuationRunId?: string;
};
export type CapacityState = "waiting" | "admitted";
const feedback = new AsyncLocalStorage<(state: CapacityState) => void>();
export const reportCapacityState = (state: CapacityState) => feedback.getStore()?.(state);
/** Only execution-time accounting/feedback; PostgreSQL remains the capacity authority. */
export function withCapacityFeedback<T>(listener: (state: CapacityState) => void, work: () => T): T {
  const parent = feedback.getStore();
  return feedback.run(state => { parent?.(state); listener(state); }, work);
}
export function executionDeadline(ms: number, expire: () => void) {
  let remaining = ms, since = Date.now();
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resume = () => { if (timer || ended) return; since = Date.now(); timer = setTimeout(() => { ended = true; timer = undefined; expire(); }, remaining); };
  resume();
  return {
    state(state: CapacityState) {
      if (state === "admitted") resume();
      else if (timer) { clearTimeout(timer); timer = undefined; remaining = Math.max(0, remaining - (Date.now() - since)); }
    },
    cancel() { ended = true; clearTimeout(timer); timer = undefined; },
  };
}

/** Audit ownership, not client forwardedProps, decides whether a turn is autonomous. */
export function executionClass(initiator: AuditInitiator, delivery = false): ExecutionClass {
  return { kind: delivery || initiator.kind === "person" || (initiator.kind === "routine" && initiator.id.startsWith("im:")) ? "foreground" : "background", initiator };
}

type Sql = Pick<Database["$client"], "unsafe">;
/** Shared by thread admission and device-agent dispatch; held only during the atomic claim. */
export async function lockBackgroundAccount(tx: Sql, owner: string) {
  await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('chisabot-background-capacity'),hashtext($1))", [owner]);
}

/** Existing DSH owners still count after API lease expiry. Human waits do not. */
export async function backgroundCount(tx: Sql, owner: string): Promise<number> {
  const [optional] = await tx.unsafe<{ devices: boolean; threads: boolean; dsh: boolean }[]>(`SELECT
    to_regclass('public.chisabot_local_agent_tasks') IS NOT NULL AS devices,
    to_regclass('public.chisabot_local_runs') IS NOT NULL AS threads,
    to_regclass('public.chisabot_dsh_runs') IS NOT NULL AS dsh`);
  const parts: string[] = [];
  if (optional?.threads) parts.push(`SELECT r.thread_id,r.run_id FROM chisabot_local_runs r JOIN chisabot_local_threads t ON t.id=r.thread_id
      WHERE t.owner_user_id=$1 AND r.execution->>'kind'='background'
      AND t.run_id=r.run_id AND t.lock_expires_at>now()`);
  if (optional?.dsh && optional.threads) parts.push(`SELECT d.thread_id,d.run_id FROM chisabot_dsh_runs d LEFT JOIN chisabot_local_runs r ON r.thread_id=d.thread_id AND r.run_id=d.run_id
      WHERE d.owner_user_id=$1 AND d.status IN ('admitting','observing','projecting')
      AND (r.execution->>'kind'='background' OR (r.execution IS NULL AND d.initiator->>'kind'<>'person'
        AND NOT(d.initiator->>'kind'='routine' AND coalesce(d.initiator->>'id','') LIKE 'im:%')))`);
  if (optional?.devices) parts.push("SELECT 'device-agent',id FROM chisabot_local_agent_tasks WHERE owner_user_id=$1 AND capacity_active");
  if (!parts.length) return 0;
  const [row] = await tx.unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM (${parts.join(" UNION ")}) occupied`, [owner]);
  return row?.count ?? 0;
}

export function createExecutionCapacity(database: Database) {
  const sql = database.$client;
  return {
    async queued() {
      return sql.unsafe<{ thread_id: string; run_id: string; owner_user_id: string; bot_id: string; execution: QueuedExecution }[]>(`SELECT r.thread_id,r.run_id,t.owner_user_id,t.agent_id AS bot_id,r.execution
        FROM chisabot_local_runs r JOIN chisabot_local_threads t ON t.id=r.thread_id WHERE r.status='capacity_wait' ORDER BY r.created_at`);
    },
    async enqueue(threadId: string, runId: string, execution: QueuedExecution) {
      const [row] = await sql.unsafe<{ status: string }[]>(`INSERT INTO chisabot_local_runs(thread_id,run_id,status,execution)
        VALUES($1,$2,'capacity_wait',$3::text::jsonb) ON CONFLICT(thread_id,run_id) DO UPDATE SET execution=chisabot_local_runs.execution
        WHERE chisabot_local_runs.status='capacity_wait' AND chisabot_local_runs.execution=$3::text::jsonb RETURNING status`, [threadId, runId, JSON.stringify(execution)]);
      if (!row) throw new Error("This execution was already admitted or stopped; it cannot be queued again.");
    },
    async claim(owner: string, threadId: string, runId: string, threadBusy = false): Promise<"claimed" | "waiting" | "stopped"> {
      return sql.begin(async tx => {
        await lockBackgroundAccount(tx, owner);
        const [run] = await tx.unsafe<{ status: string }[]>("SELECT status FROM chisabot_local_runs WHERE thread_id=$1 AND run_id=$2 FOR UPDATE", [threadId, runId]);
        if (run?.status !== "capacity_wait") return "stopped";
        if (threadBusy) return "waiting";
        if (await backgroundCount(tx, owner) >= BACKGROUND_CAPACITY) return "waiting";
        const claimed = await tx.unsafe(`UPDATE chisabot_local_threads SET run_id=$2,lock_expires_at=now()+interval '120 seconds',updated_at=now()
          WHERE id=$1 AND owner_user_id=$3 AND (run_id IS NULL OR lock_expires_at<=now())
          AND NOT EXISTS(SELECT 1 FROM chisabot_dsh_runs d WHERE d.thread_id=$1 AND d.status IN ('admitting','observing','projecting')) RETURNING id`, [threadId, runId, owner]);
        if (!claimed.length) return "waiting";
        await tx.unsafe("UPDATE chisabot_local_runs SET status='reserved' WHERE thread_id=$1 AND run_id=$2", [threadId, runId]);
        return "claimed";
      });
    },
    async releaseReservation(threadId: string, runId: string) {
      await sql.begin(async tx => {
        const rows = await tx.unsafe(`UPDATE chisabot_local_runs SET status='capacity_wait' WHERE thread_id=$1 AND run_id=$2 AND status='reserved'
          AND NOT EXISTS(SELECT 1 FROM chisabot_dsh_runs d WHERE d.thread_id=$1 AND d.run_id=$2) RETURNING run_id`, [threadId, runId]);
        if (rows.length) await tx.unsafe("UPDATE chisabot_local_threads SET run_id=NULL,lock_expires_at=NULL WHERE id=$1 AND run_id=$2", [threadId, runId]);
      });
    },
    async stop(threadId: string, runId?: string) {
      const rows = await sql.unsafe<{ run_id: string }[]>("UPDATE chisabot_local_runs SET status='stopped',finished_at=now() WHERE thread_id=$1 AND ($2::text IS NULL OR run_id=$2) AND status='capacity_wait' RETURNING run_id", [threadId, runId ?? null]);
      return rows.length > 0;
    },
  };
}
