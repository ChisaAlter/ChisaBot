import { randomUUID } from "node:crypto";
import type { Message, RunAgentInput } from "@ag-ui/client";
import type {
  ToolOutcomeResolution,
  UnknownToolOperation,
} from "../../../shared/conversations";
import { detailsFromArgs } from "../confirmations/classify";
import type { Database } from "../db/client";
import { publicErrorMessage, redactPublicText } from "../public-error";
import type { ConversationCommandRecord } from "./commands";

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
export type ToolOperationResult = {
  content: string;
  error?: string;
  reconciliation?: ToolOutcomeResolution;
};
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
        if (
          (row.status === "completed" || row.status === "failed") &&
          row.result
        )
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
      if (
        (existing.status === "completed" || existing.status === "failed") &&
        existing.result
      )
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
    async listUnknown(
      owner: string,
      threadId: string,
    ): Promise<UnknownToolOperation[]> {
      const rows = await sql.unsafe<
        {
          id: string;
          tool_name: string;
          result: ToolOperationResult | null;
          created_at: Date;
          can_continue: boolean;
          args: unknown;
        }[]
      >(
        `SELECT o.id,o.tool_name,o.result,o.created_at,o.args,
          (d.status='waiting' AND NOT d.stop_requested AND b.active AND b.revision=d.binding_revision
            AND t.run_id IS NULL
            AND (SELECT r.run_id FROM chisabot_local_runs r WHERE r.thread_id=b.thread_id ORDER BY r.created_at DESC,r.run_id DESC LIMIT 1)=d.run_id
            AND NOT EXISTS(SELECT 1 FROM chisabot_tool_operations other WHERE other.binding_id=o.binding_id AND other.run_id=o.run_id AND other.status='outcome_unknown' AND other.id<>o.id)) AS can_continue
         FROM chisabot_tool_operations o
         JOIN chisabot_runtime_bindings b ON b.id=o.binding_id AND b.owner_user_id=o.owner_user_id
         JOIN chisabot_dsh_runs d ON d.thread_id=b.thread_id AND d.run_id=o.run_id AND d.owner_user_id=o.owner_user_id
         JOIN chisabot_local_threads t ON t.id=b.thread_id AND t.owner_user_id=o.owner_user_id
         WHERE o.owner_user_id=$1 AND b.thread_id=$2 AND o.status='outcome_unknown'
         ORDER BY o.created_at,o.id`,
        [owner, threadId],
      );
      return rows.map((row) => ({
        id: row.id,
        toolName: row.tool_name,
        error: row.result?.error
          ? publicErrorMessage(new Error(row.result.error))
          : null,
        createdAt: new Date(row.created_at).toISOString(),
        canContinue: row.can_continue,
        details: detailsFromArgs(row.args).map(({ label, value }) => ({
          label,
          value: redactPublicText(value),
        })),
      }));
    },
    /** The human's observation and its follow-up command commit together; no tool is executed here. */
    async resolveOutcome(
      owner: string,
      threadId: string,
      id: string,
      resolution: ToolOutcomeResolution,
    ) {
      return sql.begin(async (tx) => {
        const [operation] = await tx.unsafe<
          {
            id: string;
            tool_name: string;
            status: string;
            result: ToolOperationResult | null;
            run_id: string;
            bot_id: string;
            messages: Message[];
            state: unknown;
            can_continue: boolean;
          }[]
        >(
          `SELECT o.id,o.tool_name,o.status,o.result,o.run_id,d.bot_id,t.messages,t.state,
            (d.status='waiting' AND NOT d.stop_requested AND b.active AND b.revision=d.binding_revision
              AND t.run_id IS NULL
              AND (SELECT r.run_id FROM chisabot_local_runs r WHERE r.thread_id=b.thread_id ORDER BY r.created_at DESC,r.run_id DESC LIMIT 1)=d.run_id
              AND NOT EXISTS(SELECT 1 FROM chisabot_tool_operations other WHERE other.binding_id=o.binding_id AND other.run_id=o.run_id AND other.status='outcome_unknown' AND other.id<>o.id)) AS can_continue
           FROM chisabot_tool_operations o
           JOIN chisabot_runtime_bindings b ON b.id=o.binding_id AND b.owner_user_id=o.owner_user_id
           JOIN chisabot_dsh_runs d ON d.thread_id=b.thread_id AND d.run_id=o.run_id AND d.owner_user_id=o.owner_user_id
           JOIN chisabot_local_threads t ON t.id=b.thread_id AND t.owner_user_id=o.owner_user_id
           WHERE o.id=$1 AND o.owner_user_id=$2 AND b.thread_id=$3 FOR UPDATE OF o,t,d`,
          [id, owner, threadId],
        );
        if (!operation)
          throw Object.assign(new Error("找不到这项待核对操作。"), {
            status: 404,
          });
        const commandId = `tool-outcome:${id}`;
        const saved = operation.result?.reconciliation;
        if (saved) {
          if (
            saved.outcome !== resolution.outcome ||
            saved.note !== resolution.note ||
            saved.continue !== resolution.continue
          )
            throw Object.assign(
              new Error("这项操作已经记录了另一份核对结果，请刷新对话。"),
              { status: 409 },
            );
          const [record] = await tx.unsafe<ConversationCommandRecord[]>(
            "SELECT * FROM chisabot_conversation_commands WHERE owner_user_id=$1 AND thread_id=$2 AND command_id=$3",
            [owner, threadId, commandId],
          );
          return { record, alreadyAccepted: true };
        }
        if (operation.status !== "outcome_unknown")
          throw Object.assign(new Error("这项操作已不需要核对，请刷新对话。"), {
            status: 409,
          });
        if (resolution.continue && !operation.can_continue)
          throw Object.assign(
            new Error(
              "原任务已停止、对话已变更或正在执行。请刷新后只记录核对结果。",
            ),
            { status: 409 },
          );
        const outcomeText = {
          completed: "操作已经完成",
          not_executed: "操作没有执行",
          failed: "操作未完成，已核对实际产生的影响",
        }[resolution.outcome];
        const content = `用户核对「${operation.tool_name}」的实际结果：${outcomeText}。\n${resolution.note}`;
        const result: ToolOperationResult = {
          content,
          reconciliation: resolution,
        };
        await tx.unsafe(
          "UPDATE chisabot_tool_operations SET status=$2,result=$3::text::jsonb,updated_at=now() WHERE id=$1",
          [
            id,
            resolution.outcome === "completed" ? "completed" : "failed",
            JSON.stringify(result),
          ],
        );
        if (!resolution.continue)
          return { record: undefined, alreadyAccepted: false };

        const message: Message = {
          id: commandId,
          role: "user",
          content: `${content}\n请根据这个核对结果继续本次任务。不要重新执行刚核对的操作；若确实需要重试，先向我确认。`,
        };
        const input: RunAgentInput = {
          threadId,
          runId: randomUUID(),
          messages: [...operation.messages, message],
          tools: [],
          context: [],
          state: operation.state,
          forwardedProps: {},
        };
        const [record] = await tx.unsafe<ConversationCommandRecord[]>(
          `INSERT INTO chisabot_conversation_commands(thread_id,command_id,run_id,owner_user_id,bot_id,payload,input)
           VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7::text::jsonb) RETURNING *`,
          [
            threadId,
            commandId,
            input.runId,
            owner,
            operation.bot_id,
            JSON.stringify({ message, forwardedProps: {} }),
            JSON.stringify(input),
          ],
        );
        await tx.unsafe(
          "UPDATE chisabot_dsh_runs SET status='settled',updated_at=now() WHERE thread_id=$1 AND run_id=$2 AND status='waiting'",
          [threadId, operation.run_id],
        );
        return { record, alreadyAccepted: false };
      });
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
