import type { RunAgentInput } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import type { Database } from "../db/client";

export type DshRunRecord = {
  thread_id: string;
  run_id: string;
  owner_user_id: string;
  bot_id: string;
  session_id: string;
  binding_revision: number;
  generation: string;
  baseline: number;
  input: RunAgentInput;
  status: string;
  stop_requested: boolean;
  initiator: AuditInitiator;
  request_id: string;
};
export function createDshRunJournal(database: Database) {
  const sql = database.$client;
  return {
    async ensure() {
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_dsh_runs (
        thread_id text NOT NULL, run_id text NOT NULL, owner_user_id text NOT NULL, bot_id text NOT NULL,
        session_id text NOT NULL, binding_revision integer NOT NULL, generation text NOT NULL, baseline integer NOT NULL,
        input jsonb NOT NULL, status text NOT NULL, stop_requested boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(thread_id,run_id)
      )`);
      await sql.unsafe(
        'ALTER TABLE chisabot_dsh_runs ADD COLUMN IF NOT EXISTS initiator jsonb NOT NULL DEFAULT \'{"kind":"person"}\'::jsonb, ADD COLUMN IF NOT EXISTS request_id text',
      );
      await sql.unsafe(
        "UPDATE chisabot_dsh_runs SET request_id=coalesce(input->'resume'->0->>'interruptId', (SELECT m->>'id' FROM jsonb_array_elements(input->'messages') WITH ORDINALITY AS e(m,n) WHERE m->>'role'='user' ORDER BY n DESC LIMIT 1)) WHERE request_id IS NULL",
      );
    },
    async get(
      threadId: string,
      runId: string,
    ): Promise<DshRunRecord | undefined> {
      const [row] = await sql.unsafe<DshRunRecord[]>(
        "SELECT * FROM chisabot_dsh_runs WHERE thread_id=$1 AND run_id=$2",
        [threadId, runId],
      );
      return row;
    },
    async accept(record: Omit<DshRunRecord, "status" | "stop_requested">) {
      const rows = await sql.unsafe(
        `INSERT INTO chisabot_dsh_runs(thread_id,run_id,owner_user_id,bot_id,session_id,binding_revision,generation,baseline,input,initiator,request_id,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb,$10::text::jsonb,$11,'admitting')
        ON CONFLICT(thread_id,run_id) DO UPDATE SET baseline=excluded.baseline,input=excluded.input,request_id=excluded.request_id,status='admitting',updated_at=now()
        WHERE chisabot_dsh_runs.status='projecting' AND NOT chisabot_dsh_runs.stop_requested
          AND chisabot_dsh_runs.generation=excluded.generation AND chisabot_dsh_runs.session_id=excluded.session_id
        RETURNING run_id`,
        [
          record.thread_id,
          record.run_id,
          record.owner_user_id,
          record.bot_id,
          record.session_id,
          record.binding_revision,
          record.generation,
          record.baseline,
          JSON.stringify(record.input),
          JSON.stringify(record.initiator),
          record.request_id,
        ],
      );
      if (!rows.length)
        throw new Error(
          "This run has an unfinished or stopped segment; it cannot accept another input.",
        );
    },
    async status(
      threadId: string,
      runId: string,
      status:
        | "observing"
        | "projecting"
        | "waiting"
        | "settled"
        | "interrupted",
    ) {
      await sql.unsafe(
        "UPDATE chisabot_dsh_runs SET status=$3,updated_at=now() WHERE thread_id=$1 AND run_id=$2",
        [threadId, runId, status],
      );
    },
    async pending() {
      return sql.unsafe<DshRunRecord[]>(
        "SELECT * FROM chisabot_dsh_runs WHERE status IN ('admitting','observing','projecting') ORDER BY created_at",
      );
    },
    async stop(threadId: string, runId?: string) {
      const rows = await sql.unsafe(
        "UPDATE chisabot_dsh_runs SET stop_requested=true,status=CASE WHEN status='waiting' THEN 'settled' ELSE status END,updated_at=now() WHERE thread_id=$1 AND ($2::text IS NULL OR run_id=$2) AND status IN ('admitting','observing','projecting','waiting') RETURNING run_id",
        [threadId, runId ?? null],
      );
      return rows.length > 0;
    },
    async continuationRefusal(threadId: string, runId: string) {
      const [run] = await sql.unsafe<{ stopped: boolean; current: boolean }[]>(
        `SELECT d.stop_requested AS stopped,
        EXISTS(SELECT 1 FROM chisabot_runtime_bindings b WHERE b.thread_id=d.thread_id AND b.active AND b.revision=d.binding_revision AND b.session_id=d.session_id) AS current
        FROM chisabot_dsh_runs d WHERE d.thread_id=$1 AND d.run_id=$2`,
        [threadId, runId],
      );
      return run?.stopped
        ? "这一轮已被停止，未执行之后到达的批准。"
        : run && !run.current
          ? "这段对话已被编辑，旧版本的批准不能继续执行。"
          : null;
    },
  };
}
export type DshRunJournal = ReturnType<typeof createDshRunJournal>;
