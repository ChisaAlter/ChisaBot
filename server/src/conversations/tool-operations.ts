import { randomUUID } from "node:crypto";
import type { Database } from "../db/client";

export type ToolOperationInput = {
  ownerUserId: string;
  bindingId: string;
  sessionId: string;
  runId: string;
  callId: string;
  turn: number;
  step: number;
  name: string;
  args: unknown;
};
export type ToolOperationResult = { content: string; error?: string };
export type ToolOperationClaim =
  | { kind: "claimed"; id: string }
  | { kind: "completed"; id: string; result: ToolOperationResult }
  | { kind: "pending"; id: string; state: string; confirmationId?: string }
  | { kind: "conflict" };

/** External effects have their own ledger; a missing receipt is never permission to rerun. */
export function createToolOperationStore(database: Database) {
  const sql = database.$client;
  return {
    async ensure() {
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_tool_operations (
        id text PRIMARY KEY, owner_user_id text NOT NULL, binding_id text NOT NULL,
        session_id text NOT NULL, run_id text NOT NULL, call_id text NOT NULL,
        turn_number integer NOT NULL, step_number integer NOT NULL,
        tool_name text NOT NULL, args jsonb NOT NULL, status text NOT NULL,
        result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(binding_id, session_id, turn_number, step_number, call_id)
      )`);
      await sql.unsafe(
        "ALTER TABLE chisabot_tool_operations ADD COLUMN IF NOT EXISTS confirmation_id text",
      );
    },
    async waitingForConfirmation(id: string, requestId: string) {
      const rows = await sql.unsafe(
        "UPDATE chisabot_tool_operations SET status='waiting_approval',confirmation_id=$2,updated_at=now() WHERE id=$1 AND status='dispatching' RETURNING id",
        [id, requestId],
      );
      if (!rows.length)
        throw new Error("This operation can no longer wait for confirmation.");
    },
    async resumeConfirmation(input: {
      ownerUserId: string;
      requestId: string;
      runId: string;
      toolCallId: string;
      name: string;
      args: unknown;
    }): Promise<ToolOperationClaim> {
      return sql.begin(async (tx) => {
        const [row] = await tx.unsafe<
          {
            id: string;
            status: string;
            result: ToolOperationResult | null;
            matches: boolean;
          }[]
        >(
          `SELECT id,status,result,(tool_name=$5 AND args=$6::text::jsonb) AS matches FROM chisabot_tool_operations
           WHERE owner_user_id=$1 AND confirmation_id=$2 AND run_id=$3 AND (session_id||':'||turn_number||':'||step_number||':'||call_id)=$4 FOR UPDATE`,
          [
            input.ownerUserId,
            input.requestId,
            input.runId,
            input.toolCallId,
            input.name,
            JSON.stringify(input.args),
          ],
        );
        if (!row?.matches) return { kind: "conflict" };
        if (row.status === "completed" && row.result)
          return { kind: "completed", id: row.id, result: row.result };
        if (row.status !== "waiting_approval")
          return { kind: "pending", id: row.id, state: row.status };
        await tx.unsafe(
          "UPDATE chisabot_tool_operations SET status='dispatching',updated_at=now() WHERE id=$1",
          [row.id],
        );
        return { kind: "claimed", id: row.id };
      });
    },
    async claim(input: ToolOperationInput): Promise<ToolOperationClaim> {
      const id = randomUUID();
      const encoded = JSON.stringify(input.args);
      if (encoded === undefined)
        throw new Error("Tool arguments must be JSON.");
      const inserted = await sql.unsafe<{ id: string }[]>(
        `INSERT INTO chisabot_tool_operations
        (id, owner_user_id, binding_id, session_id, run_id, call_id, turn_number, step_number, tool_name, args, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text::jsonb,'dispatching')
        ON CONFLICT(binding_id,session_id,turn_number,step_number,call_id) DO NOTHING RETURNING id`,
        [
          id,
          input.ownerUserId,
          input.bindingId,
          input.sessionId,
          input.runId,
          input.callId,
          input.turn,
          input.step,
          input.name,
          encoded,
        ],
      );
      if (inserted.length) return { kind: "claimed", id };
      const [existing] = await sql.unsafe<
        {
          id: string;
          status: string;
          confirmation_id: string | null;
          result: ToolOperationResult | null;
          matches: boolean;
        }[]
      >(
        `SELECT id,status,confirmation_id,result,(tool_name=$6 AND args=$7::text::jsonb AND owner_user_id=$8 AND run_id=$9) AS matches
         FROM chisabot_tool_operations WHERE binding_id=$1 AND session_id=$2 AND turn_number=$3 AND step_number=$4 AND call_id=$5`,
        [
          input.bindingId,
          input.sessionId,
          input.turn,
          input.step,
          input.callId,
          input.name,
          encoded,
          input.ownerUserId,
          input.runId,
        ],
      );
      if (!existing?.matches) return { kind: "conflict" };
      if (existing.status === "completed" && existing.result)
        return { kind: "completed", id: existing.id, result: existing.result };
      return {
        kind: "pending",
        id: existing.id,
        state: existing.status,
        ...(existing.confirmation_id
          ? { confirmationId: existing.confirmation_id }
          : {}),
      };
    },
    async markOutcomeUnknown(id: string) {
      await sql.unsafe(
        `UPDATE chisabot_tool_operations SET status='outcome_unknown',updated_at=now()
        WHERE id=$1 AND status='dispatching'`,
        [id],
      );
    },
    async settle(
      id: string,
      status: "completed" | "failed" | "waiting_approval" | "outcome_unknown",
      result: ToolOperationResult,
    ) {
      const rows = await sql.unsafe<{ id: string }[]>(
        `UPDATE chisabot_tool_operations SET status=$2,result=$3::text::jsonb,updated_at=now()
        WHERE id=$1 AND (status IN ('dispatching','waiting_approval') OR (status='outcome_unknown' AND $2='completed')) RETURNING id`,
        [id, status, JSON.stringify(result)],
      );
      if (!rows.length)
        throw new Error("The tool operation no longer accepts settlement.");
    },
  };
}
export type ToolOperationStore = ReturnType<typeof createToolOperationStore>;
