import { sql as query } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  currentApprovalContext,
  parseApprovalContinuation,
} from "../approvals/types";
import type { AppVariables } from "../auth/guards";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { Database } from "../db/client";
import type { TurnRunner } from "../turns/types";
import {
  assertContinuationAvailable,
  ContinuationCancelled,
  continuationView,
  existingContinuation,
  retryContinuation,
} from "./continuation-work";
import {
  assertConversationAdmissionOpen,
  ConversationMaintenanceError,
} from "./maintenance";
import { createDshRunJournal } from "./run-journal";

export function createConversationInteractions(
  database: Database,
  options: {
    saveSkill?: (input: {
      actor: { id: string; role?: string };
      values: unknown;
      proposed: unknown;
      transaction: Pick<Database, "insert" | "delete">;
      afterCommit: (notify: () => void) => void;
    }) => Promise<string>;
  } = {},
) {
  const sql = database.$client;
  type Row = {
    call_id: string;
    thread_id: string;
    owner_user_id: string;
    status: string;
    answer: unknown;
    tool_name: string;
    args: unknown;
    run_id: string;
  };
  return {
    async ensure() {
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_conversation_interactions (
        call_id text PRIMARY KEY, owner_user_id text NOT NULL, thread_id text NOT NULL, run_id text NOT NULL,
        tool_name text NOT NULL, args jsonb NOT NULL, continuation jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
        answer jsonb, created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
      )`);
      await sql.unsafe(
        "ALTER TABLE chisabot_conversation_interactions ADD COLUMN IF NOT EXISTS answer_input jsonb",
      );
    },
    async ask(ownerUserId: string, signal: AbortSignal): Promise<unknown> {
      const continuation = currentApprovalContext();
      if (!continuation)
        throw new Error("An interaction requires its conversation context.");
      await sql.unsafe(
        `INSERT INTO chisabot_conversation_interactions(call_id,owner_user_id,thread_id,run_id,tool_name,args,continuation)
        VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7::text::jsonb) ON CONFLICT(call_id) DO NOTHING`,
        [
          continuation.toolCallId,
          ownerUserId,
          continuation.threadId,
          continuation.runId,
          continuation.toolName,
          JSON.stringify(continuation.args),
          JSON.stringify(continuation),
        ],
      );
      signal.throwIfAborted();
      const [row] = await sql.unsafe<Row[]>(
        "SELECT * FROM chisabot_conversation_interactions WHERE call_id=$1 AND owner_user_id=$2",
        [continuation.toolCallId, ownerUserId],
      );
      if (!row || row.status === "cancelled")
        throw new Error("这张卡片已停止等待。");
      if (row.status === "answered") return row.answer;
      throw new HeadlessToolSuspension("等待你回答卡片。", {
        kind: "conversation_interaction",
        requestId: continuation.toolCallId,
        continuation,
      });
    },
    async cancel(threadId: string, runId?: string) {
      await sql.unsafe(
        "UPDATE chisabot_conversation_interactions SET status='cancelled' WHERE thread_id=$1 AND ($2::text IS NULL OR run_id=$2) AND status='pending'",
        [threadId, runId ?? null],
      );
    },
    async resume(callId: string, runTurn: TurnRunner, onAdmitted?: () => void) {
      assertConversationAdmissionOpen();
      const [row] = await sql.unsafe<
        (Row & { continuation: unknown; agent_id: string })[]
      >(
        `SELECT i.*,t.agent_id FROM chisabot_conversation_interactions i
        JOIN chisabot_local_threads t ON t.id=i.thread_id AND t.owner_user_id=i.owner_user_id WHERE i.call_id=$1 AND i.status='answered'`,
        [callId],
      );
      if (!row) return;
      const runId = `interaction:${callId}`;
      const existing = await existingContinuation(
        database,
        row.thread_id,
        runId,
      );
      if (existing !== "new") {
        if (existing === "accepted") onAdmitted?.();
        return;
      }
      const snapshot = parseApprovalContinuation(row.continuation);
      const refusal = await createDshRunJournal(database).continuationRefusal(
        snapshot.threadId,
        snapshot.runId,
      );
      if (refusal) {
        if (onAdmitted) throw new ContinuationCancelled(refusal);
        return;
      }
      await assertContinuationAvailable(database, row.thread_id);
      const content =
        typeof row.answer === "string"
          ? row.answer
          : JSON.stringify(row.answer);
      await runTurn({
        ownerUserId: row.owner_user_id,
        agentId: row.agent_id,
        threadId: row.thread_id,
        routineId: runId,
        runId,
        instruction: "",
        initiator: snapshot.initiator ?? { kind: "person" },
        continuation: {
          snapshot,
          messageId: `${runId}:answer`,
          result: { content },
        },
        ...(onAdmitted ? { onAdmitted } : {}),
      });
    },
    routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
      const routes = new Hono<{ Variables: AppVariables }>();
      routes.use("*", requireUser);
      routes.get("/:callId", async (context) => {
        const [row] = await sql.unsafe<Row[]>(
          "SELECT call_id,thread_id,owner_user_id,status,answer FROM chisabot_conversation_interactions WHERE call_id=$1 AND owner_user_id=$2",
          [context.req.param("callId"), context.var.actor.id],
        );
        return row
          ? context.json({
              status: row.status,
              answer: row.answer,
              ...(row.status === "answered"
                ? {
                    continuation: await continuationView(database, {
                      kind: "conversation.interaction-response",
                      key: row.call_id,
                      threadId: row.thread_id,
                      runId: `interaction:${row.call_id}`,
                    }),
                  }
                : {}),
            })
          : context.json({ status: "unavailable" });
      });
      routes.post("/:callId/retry", async (context) => {
        const [row] = await sql.unsafe<Row[]>(
          "SELECT * FROM chisabot_conversation_interactions WHERE call_id=$1 AND owner_user_id=$2 AND status='answered'",
          [context.req.param("callId"), context.var.actor.id],
        );
        if (!row) return context.json({ error: "找不到已回答的卡片。" }, 404);
        const refusal = await createDshRunJournal(database).continuationRefusal(
          row.thread_id,
          row.run_id,
        );
        if (refusal) return context.json({ error: refusal }, 409);
        const retried = await retryContinuation(database, {
          kind: "conversation.interaction-response",
          key: row.call_id,
          threadId: row.thread_id,
          runId: `interaction:${row.call_id}`,
        });
        return retried
          ? context.json({ accepted: true })
          : context.json(
              { error: "这次续执行已开始或仍在排队，请在对话中查看结果。" },
              409,
            );
      });
      routes.post("/:callId", async (context) => {
        const body = z
          .object({ answer: z.unknown() })
          .safeParse(await context.req.json());
        if (
          !body.success ||
          body.data.answer === undefined ||
          JSON.stringify(body.data.answer).length > 200_000
        )
          return context.json({ error: "Invalid answer." }, 400);
        if (
          typeof body.data.answer === "object" &&
          body.data.answer !== null &&
          "kind" in body.data.answer &&
          body.data.answer.kind === "save-skill"
        ) {
          const saveSkill = options.saveSkill;
          if (!saveSkill)
            return context.json({ error: "技能保存暂不可用。" }, 503);
          const answer = body.data.answer as { values?: unknown };
          try {
            assertConversationAdmissionOpen();
            const committed: (() => void)[] = [];
            await database.transaction(async (transaction) => {
              const [row] = await transaction.execute<
                Row & { same: boolean }
              >(query`SELECT *,answer_input=${JSON.stringify(body.data.answer)}::text::jsonb AS same
                FROM chisabot_conversation_interactions WHERE call_id=${context.req.param("callId")} AND owner_user_id=${context.var.actor.id} FOR UPDATE`);
              if (row?.status === "answered" && row.same) return;
              if (row?.status !== "pending" || row.tool_name !== "save_skill")
                throw new Error("这张卡片已被处理或停止。");
              const [stale] =
                await transaction.execute(query`SELECT d.run_id FROM chisabot_dsh_runs d WHERE d.thread_id=${row.thread_id} AND d.run_id=${row.run_id}
                AND (d.stop_requested OR NOT EXISTS(SELECT 1 FROM chisabot_runtime_bindings b WHERE b.thread_id=d.thread_id AND b.active AND b.revision=d.binding_revision))`);
              if (stale) throw new Error("这一轮已停止或被编辑，技能未保存。");
              assertConversationAdmissionOpen();
              const result = await saveSkill({
                actor: context.var.actor,
                values: answer.values,
                proposed: row.args,
                transaction,
                afterCommit: (notify) => committed.push(notify),
              });
              await transaction.execute(query`UPDATE chisabot_conversation_interactions SET status='answered',answer=${JSON.stringify(result)}::text::jsonb,
                answer_input=${JSON.stringify(body.data.answer)}::text::jsonb,answered_at=now() WHERE call_id=${row.call_id}`);
              await transaction.execute(
                query`INSERT INTO work_items(kind,key,payload) VALUES('conversation.interaction-response',${row.call_id},${JSON.stringify({ callId: row.call_id })}::text::jsonb) ON CONFLICT DO NOTHING`,
              );
            });
            for (const notify of committed) notify();
            return context.json({ accepted: true });
          } catch (error) {
            return context.json(
              {
                error: error instanceof Error ? error.message : "技能未保存。",
              },
              error instanceof ConversationMaintenanceError ? 503 : 409,
            );
          }
        }
        const rows = await sql.begin(async (tx) => {
          const rows = await tx.unsafe(
            `UPDATE chisabot_conversation_interactions i SET status='answered',answer=$3::text::jsonb,answered_at=now()
            WHERE i.call_id=$1 AND i.owner_user_id=$2 AND i.status='pending'
              AND NOT EXISTS(SELECT 1 FROM chisabot_dsh_runs d WHERE d.thread_id=i.thread_id AND d.run_id=i.run_id
                AND (d.stop_requested OR NOT EXISTS(SELECT 1 FROM chisabot_runtime_bindings b WHERE b.thread_id=d.thread_id
                  AND b.active AND b.revision=d.binding_revision AND b.session_id=d.session_id)))
            RETURNING call_id`,
            [
              context.req.param("callId"),
              context.var.actor.id,
              JSON.stringify(body.data.answer),
            ],
          );
          if (rows.length)
            await tx.unsafe(
              "INSERT INTO work_items(kind,key,payload) VALUES ('conversation.interaction-response',$1,$2::text::jsonb) ON CONFLICT DO NOTHING",
              [
                context.req.param("callId"),
                JSON.stringify({ callId: context.req.param("callId") }),
              ],
            );
          return rows;
        });
        if (!rows.length) {
          const [same] = await sql.unsafe(
            "SELECT call_id FROM chisabot_conversation_interactions WHERE call_id=$1 AND owner_user_id=$2 AND status='answered' AND answer=$3::text::jsonb",
            [
              context.req.param("callId"),
              context.var.actor.id,
              JSON.stringify(body.data.answer),
            ],
          );
          if (!same)
            return context.json({ error: "这张卡片已被处理或停止。" }, 409);
        }
        return context.json({ accepted: true });
      });
      return routes;
    },
  };
}
