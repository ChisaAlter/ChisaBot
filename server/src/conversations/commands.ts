import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/client";
import type { Database } from "../db/client";

export type ConversationCommandRecord = {
  thread_id: string;
  command_id: string;
  run_id: string;
  execution_run_id: string | null;
  owner_user_id: string;
  bot_id: string;
  input: RunAgentInput;
  status: string;
};
/** The durable acceptance point shared by HTTP sends and recovery. */
export function createConversationCommands(database: Database) {
  const sql = database.$client;
  return {
    async ensure() {
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_conversation_commands(
        thread_id text NOT NULL, command_id text NOT NULL, run_id text NOT NULL,
        owner_user_id text NOT NULL, bot_id text NOT NULL, payload jsonb NOT NULL, input jsonb NOT NULL,
        status text NOT NULL DEFAULT 'accepted', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(thread_id,command_id), UNIQUE(thread_id,run_id)
      )`);
      await sql.unsafe(
        "ALTER TABLE chisabot_conversation_commands ADD COLUMN IF NOT EXISTS execution_run_id text",
      );
    },
    async accept(owner: string, botId: string, input: RunAgentInput) {
      const latest = input.messages.findLast(
        (message) => message.role === "user",
      );
      if (!latest) throw new Error("A user message is required.");
      const commandId = latest.id;
      const payload = JSON.stringify({
        message: latest,
        forwardedProps: input.forwardedProps ?? null,
      });
      const runId = randomUUID();
      // The saved run input is replayable admission data, never a model credential or tool grant.
      const saved = { ...input, runId, tools: [] };
      const inserted = await sql.unsafe<ConversationCommandRecord[]>(
        `INSERT INTO chisabot_conversation_commands(thread_id,command_id,run_id,owner_user_id,bot_id,payload,input)
        VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7::text::jsonb) ON CONFLICT(thread_id,command_id) DO NOTHING RETURNING *`,
        [
          input.threadId,
          commandId,
          runId,
          owner,
          botId,
          payload,
          JSON.stringify(saved),
        ],
      );
      if (inserted[0]) return { record: inserted[0], alreadyAccepted: false };
      const [existing] = await sql.unsafe<
        (ConversationCommandRecord & { matches: boolean })[]
      >(
        `SELECT *,payload=$4::text::jsonb AS matches FROM chisabot_conversation_commands
        WHERE thread_id=$1 AND command_id=$2 AND owner_user_id=$3 AND bot_id=$5`,
        [input.threadId, commandId, owner, payload, botId],
      );
      if (!existing?.matches)
        throw Object.assign(
          new Error(
            "This message id was already accepted with different content.",
          ),
          { status: 409 },
        );
      return { record: existing, alreadyAccepted: true };
    },
    async get(owner: string, threadId: string, commandId: string) {
      const [row] = await sql.unsafe<ConversationCommandRecord[]>(
        "SELECT * FROM chisabot_conversation_commands WHERE owner_user_id=$1 AND thread_id=$2 AND command_id=$3",
        [owner, threadId, commandId],
      );
      return row;
    },
    async pending() {
      return sql.unsafe<
        ConversationCommandRecord[]
      >(`SELECT c.* FROM chisabot_conversation_commands c WHERE status='accepted'
        OR (status='queued' AND EXISTS(SELECT 1 FROM chisabot_thread_inbox i WHERE i.thread_id=c.thread_id AND i.id=c.command_id AND i.status='queued')) ORDER BY created_at`);
    },
    async reconcile() {
      // A crash can follow the durable terminal event but precede command settlement. Finish
      // that bookkeeping from the stored run; never redispatch an already completed effect.
      await sql.unsafe(`UPDATE chisabot_conversation_commands c SET status=CASE
          WHEN r.status='finished' THEN 'settled' WHEN r.status='stopped' THEN 'stopped' ELSE 'failed' END,
          execution_run_id=coalesce(c.execution_run_id,c.run_id),updated_at=now()
        FROM chisabot_local_runs r WHERE r.thread_id=c.thread_id AND r.run_id=c.run_id
          AND c.status IN ('accepted','dispatched') AND r.status IN ('finished','stopped','error','interrupted')
          AND EXISTS(SELECT 1 FROM chisabot_local_events e WHERE e.thread_id=r.thread_id AND e.run_id=r.run_id
            AND e.event->>'type' IN ('RUN_FINISHED','RUN_ERROR'))
          AND NOT EXISTS(SELECT 1 FROM chisabot_dsh_runs d WHERE d.thread_id=r.thread_id AND d.run_id=r.run_id
            AND d.status IN ('admitting','observing','projecting'))`);
    },
    async join(threadId: string, runId: string, executionRunId: string) {
      await sql.unsafe(
        "UPDATE chisabot_conversation_commands SET status='queued',execution_run_id=$3,updated_at=now() WHERE thread_id=$1 AND run_id=$2 AND status IN ('accepted','queued')",
        [threadId, runId, executionRunId],
      );
    },
    async status(
      threadId: string,
      runId: string,
      status: "dispatched" | "settled" | "stopped" | "failed",
    ) {
      await sql.unsafe(
        "UPDATE chisabot_conversation_commands SET status=$3,execution_run_id=CASE WHEN $3='dispatched' THEN run_id ELSE coalesce(execution_run_id,run_id) END,updated_at=now() WHERE thread_id=$1 AND run_id=$2",
        [threadId, runId, status],
      );
    },
  };
}
export type ConversationCommands = ReturnType<
  typeof createConversationCommands
>;
