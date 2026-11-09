import type { Message } from "@ag-ui/client";
import type { Database } from "../db/client";
import { reportCapacityState } from "../conversations/capacity";

export type DurableTurn = {
  runId: string;
  status: "running" | "waiting" | "finished" | "failed";
  replyText: string;
  error?: string;
  messages?: Message[];
};

export class BackgroundTurnNeedsReview extends Error {
  constructor(message: string) { super(message); this.name = "BackgroundTurnNeedsReview"; }
}

/** Read an existing DSH execution for a background owner; never submit another model request. */
export async function readDurableTurn(database: Database, owner: string, threadId: string, runId?: string): Promise<DurableTurn | null> {
  const [queued] = await database.$client.unsafe<{ run_id: string; status: string }[]>(`SELECT r.run_id,r.status FROM chisabot_local_runs r
    JOIN chisabot_local_threads t ON t.id=r.thread_id WHERE t.owner_user_id=$1 AND r.thread_id=$2
    AND ($3::text IS NULL OR r.run_id=$3) AND r.execution IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM chisabot_dsh_runs d WHERE d.thread_id=r.thread_id AND d.run_id=r.run_id)
    ORDER BY r.created_at DESC LIMIT 1`, [owner, threadId, runId ?? null]);
  if (queued && ["capacity_wait", "reserved"].includes(queued.status)) {
    reportCapacityState(queued.status === "capacity_wait" ? "waiting" : "admitted");
    return { runId: queued.run_id, status: "running", replyText: "" };
  }
  if (queued?.status === "stopped") return { runId: queued.run_id, status: "failed", replyText: "", error: "任务已在等待执行位时停止，未调用模型。" };
  const [available] = await database.$client.unsafe<{ available: boolean }[]>("SELECT to_regclass('public.chisabot_dsh_runs') IS NOT NULL AS available");
  if (!available?.available) return null;
  const [row] = await database.$client.unsafe<{
    run_id: string; status: string; local_status: string; messages: Message[];
    terminal: { type?: string; message?: string; outcome?: { type?: string } } | null;
    initial_messages: Message[];
    projection_events: { messageId?: string; parentMessageId?: string; messages?: Message[] }[];
  }[]>(`SELECT d.run_id,d.status,r.status AS local_status,t.messages,d.input->'messages' AS initial_messages,
    (SELECT event FROM chisabot_local_events e WHERE e.thread_id=d.thread_id AND e.run_id=d.run_id
      AND event->>'type' IN ('RUN_ERROR','RUN_FINISHED') ORDER BY sequence DESC LIMIT 1) AS terminal,
    (SELECT coalesce(jsonb_agg(event),'[]'::jsonb) FROM chisabot_local_events e WHERE e.thread_id=d.thread_id AND e.run_id=d.run_id
      AND event->>'type' IN ('TEXT_MESSAGE_START','TOOL_CALL_START','TOOL_CALL_RESULT','ACTIVITY_SNAPSHOT','MESSAGES_SNAPSHOT')) AS projection_events
    FROM chisabot_dsh_runs d JOIN chisabot_local_threads t ON t.id=d.thread_id AND t.owner_user_id=d.owner_user_id
    LEFT JOIN chisabot_local_runs r ON r.thread_id=d.thread_id AND r.run_id=d.run_id
    WHERE d.owner_user_id=$1 AND d.thread_id=$2 AND ($3::text IS NULL OR d.run_id=$3)
    ORDER BY d.created_at DESC LIMIT 1`, [owner, threadId, runId ?? null]);
  if (!row) return null;
  reportCapacityState("admitted");
  if (["admitting", "observing", "projecting"].includes(row.status) || row.local_status === "running") return { runId: row.run_id, status: "running", replyText: "" };
  if (row.status === "waiting" || row.terminal?.outcome?.type === "interrupt") return { runId: row.run_id, status: "waiting", replyText: "" };
  if (row.local_status !== "finished" || row.terminal?.type !== "RUN_FINISHED") return { runId: row.run_id, status: "failed", replyText: "", error: row.terminal?.message ?? "原执行已中断，请核对已完成的操作后再继续。" };
  const initialIds = new Set((row.initial_messages ?? []).map(message => message.id));
  const outputIds = new Set<string>();
  for (const event of row.projection_events) {
    if (event.messageId) outputIds.add(event.messageId);
    if (event.parentMessageId) outputIds.add(event.parentMessageId);
    for (const message of event.messages ?? []) if (!initialIds.has(message.id)) outputIds.add(message.id);
  }
  const messages = row.messages.filter(message => outputIds.has(message.id));
  const replyText = messages.filter(message => message.role === "assistant")
    .map(message => typeof message.content === "string" ? message.content : "").filter(Boolean).join("\n\n");
  return { runId: row.run_id, status: "finished", replyText, messages };
}
