import type { ContinuationView } from "../../../shared/confirmations";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { Database } from "../db/client";
import { publicErrorMessage } from "../public-error";
import {
  DEFAULT_MAX_ATTEMPTS,
  type WorkItem,
  type WorkQueue,
} from "../work/queue";
import { ConversationMaintenanceError } from "./maintenance";

export type ContinuationKind =
  | "conversation.confirmation-response"
  | "conversation.interaction-response";
export type ContinuationIdentity = {
  kind: ContinuationKind;
  key: string;
  threadId: string;
  runId: string;
};

/** A busy predecessor has not spent an execution attempt. */
export class ContinuationDeferred extends Error {}
export class ContinuationCancelled extends Error {}

export const isContinuationDeferred = (error: unknown) =>
  error instanceof ContinuationDeferred ||
  error instanceof ConversationMaintenanceError ||
  (error instanceof Error && error.message === "Thread already running");

export async function assertContinuationAvailable(
  database: Database,
  threadId: string,
) {
  const [busy] = await database.$client.unsafe(
    `SELECT id FROM chisabot_local_threads t WHERE id=$1 AND (
      (run_id IS NOT NULL AND lock_expires_at>now()) OR EXISTS (
        SELECT 1 FROM chisabot_dsh_runs d WHERE d.thread_id=t.id
        AND d.status IN ('admitting','observing','projecting')))`,
    [threadId],
  );
  if (busy) throw new ContinuationDeferred("前一轮仍在执行，已保留你的决定。");
}

/** The queue can hand off only to a persisted execution, never to a wire acknowledgement. */
export async function existingContinuation(
  database: Database,
  threadId: string,
  runId: string,
): Promise<"new" | "accepted" | "terminal"> {
  const [row] = await database.$client.unsafe<
    { status: string | null; durable: boolean; queued: boolean }[]
  >(
    `SELECT r.status, EXISTS(SELECT 1 FROM chisabot_dsh_runs d WHERE d.thread_id=$1 AND d.run_id=$2) AS durable,
      coalesce(r.status IN ('capacity_wait','reserved') AND r.execution->'input' IS NOT NULL,false) AS queued
      FROM (SELECT 1) seed LEFT JOIN chisabot_local_runs r ON r.thread_id=$1 AND r.run_id=$2`,
    [threadId, runId],
  );
  if (row?.durable || row?.queued) return "accepted";
  if (!row?.status) return "new";
  if (["finished", "stopped", "error", "interrupted"].includes(row.status))
    return "terminal";
  throw new ContinuationDeferred("续执行正在接纳，已保留你的决定。");
}

/** Existing queue and execution rows are the single source for the card's continuation state. */
type ContinuationStateRow = {
  key: string;
  attempts: number;
  finished: boolean;
  claimed: boolean;
  last_error: string | null;
  local_status: string | null;
  dsh_status: string | null;
  terminal_message: string | null;
};

export async function continuationViews(
  database: Database,
  identities: ContinuationIdentity[],
): Promise<Map<string, ContinuationView>> {
  if (!identities.length) return new Map();
  const rows = await database.$client.unsafe<ContinuationStateRow[]>(
    `SELECT w.key,w.attempts,w.finished_at IS NOT NULL AS finished,
      w.claimed_by IS NOT NULL AND w.lease_until>now() AS claimed,w.last_error,
      r.status AS local_status,d.status AS dsh_status,
      (SELECT e.event->>'message' FROM chisabot_local_events e WHERE e.thread_id=i."threadId" AND e.run_id=i."runId"
        AND e.event->>'type'='RUN_ERROR' ORDER BY e.sequence DESC LIMIT 1) AS terminal_message
      FROM jsonb_to_recordset($1::text::jsonb) AS i(kind text,key text,"threadId" text,"runId" text)
      JOIN work_items w ON w.kind=i.kind AND w.key=i.key
      LEFT JOIN chisabot_local_runs r ON r.thread_id=i."threadId" AND r.run_id=i."runId"
      LEFT JOIN chisabot_dsh_runs d ON d.thread_id=i."threadId" AND d.run_id=i."runId"`,
    [JSON.stringify(identities)],
  );
  return new Map(rows.map((row) => [row.key, continuationState(row)]));
}

export async function continuationView(
  database: Database,
  identity: ContinuationIdentity,
) {
  return (await continuationViews(database, [identity])).get(identity.key);
}

function continuationState(row: ContinuationStateRow): ContinuationView {
  if (["admitting", "observing", "projecting"].includes(row.dsh_status ?? ""))
    return { state: "running" };
  if (row.local_status === "capacity_wait") return { state: "queued" };
  if (["running", "reserved"].includes(row.local_status ?? ""))
    return { state: "running" };
  if (row.dsh_status === "waiting" || row.local_status === "finished")
    return { state: "completed" };
  if (
    ["stopped", "error", "interrupted"].includes(row.local_status ?? "") ||
    row.dsh_status === "interrupted"
  )
    return {
      state: "failed",
      error: publicErrorMessage(
        new Error(
          row.terminal_message ?? "续执行已停止，请在对话中核对结果后继续。",
        ),
      ),
      retryable: false,
    };
  if (row.finished)
    return row.last_error
      ? {
          state: "failed",
          error: publicErrorMessage(new Error(row.last_error)),
          retryable: false,
        }
      : { state: "completed" };
  if (row.attempts >= DEFAULT_MAX_ATTEMPTS && !row.claimed)
    return {
      state: "failed",
      error: publicErrorMessage(
        new Error(row.last_error ?? "续执行未能开始，请稍后继续处理。"),
      ),
      retryable: !row.local_status && !row.dsh_status,
    };
  return { state: row.claimed ? "running" : "queued" };
}

/** An explicit retry reopens only an exhausted, never-admitted continuation. */
export async function retryContinuation(
  database: Database,
  identity: ContinuationIdentity,
): Promise<boolean> {
  return database.$client.begin(async (tx) => {
    const rows = await tx.unsafe(
      `UPDATE work_items w SET attempts=0,last_error=NULL,claimed_by=NULL,lease_until=NULL,run_at=now(),updated_at=now()
      WHERE kind=$1 AND key=$2 AND finished_at IS NULL AND attempts>=$5
      AND (lease_until IS NULL OR lease_until<=now())
      AND NOT EXISTS(SELECT 1 FROM chisabot_local_runs WHERE thread_id=$3 AND run_id=$4)
      AND NOT EXISTS(SELECT 1 FROM chisabot_dsh_runs WHERE thread_id=$3 AND run_id=$4) RETURNING key`,
      [
        identity.kind,
        identity.key,
        identity.threadId,
        identity.runId,
        DEFAULT_MAX_ATTEMPTS,
      ],
    );
    if (rows.length)
      await tx.unsafe("SELECT pg_notify('chisabot_work_offered',$1)", [
        identity.kind,
      ]);
    return rows.length > 0;
  });
}

/** Once admitted, the existing runner/recovery owns completion; the next answer need not wait. */
export async function dispatchContinuationWork(
  database: Database,
  queue: WorkQueue,
  item: WorkItem,
  owner: string,
  start: (onAdmitted: () => void) => Promise<unknown>,
) {
  let admitted = false;
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const completed = Promise.resolve().then(() =>
    start(() => {
      admitted = true;
      accept();
    }),
  );
  // This observer remains attached after handoff; it does not launch another execution.
  void completed.catch((error) => {
    if (admitted && !(error instanceof HeadlessToolSuspension))
      console.warn(
        JSON.stringify({
          type: "continuation-execution-failed",
          kind: item.kind,
          key: item.key,
          reason: publicErrorMessage(error),
        }),
      );
  });
  try {
    await Promise.race([completed, accepted]);
    await finish(null);
  } catch (error) {
    if (error instanceof ContinuationCancelled)
      await finish(publicErrorMessage(error));
    else if (isContinuationDeferred(error))
      await database.$client.unsafe(
        `UPDATE work_items SET claimed_by=NULL,lease_until=NULL,run_at=now()+interval '2 seconds',
          attempts=GREATEST(0,attempts-1),last_error=NULL,updated_at=now()
          WHERE kind=$1 AND key=$2 AND claimed_by=$3 AND finished_at IS NULL`,
        [item.kind, item.key, owner],
      );
    else
      await queue.release({
        kind: item.kind,
        key: item.key,
        owner,
        delayMs: 5000,
        reason: publicErrorMessage(error),
      });
  }
  async function finish(error: string | null) {
    await database.$client.unsafe(
      `UPDATE work_items SET finished_at=now(),claimed_by=NULL,lease_until=NULL,last_error=$4,updated_at=now()
      WHERE kind=$1 AND key=$2 AND claimed_by=$3 AND finished_at IS NULL`,
      [item.kind, item.key, owner, error],
    );
  }
}
