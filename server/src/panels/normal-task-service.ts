import { and, eq } from "drizzle-orm";
import { PanelError } from "../../../shared/panels/types";
import { isContinuationDeferred } from "../conversations/continuation-work";
import type { Database } from "../db/client";
import { panelTaskRequests } from "../db/schema/panels";
import type { TurnRunner } from "../turns/types";
import type { FrozenPanelTask } from "./broker";
export type NormalPanelTaskResult = {
  status: "running" | "waiting" | "unknown" | "succeeded" | "failed";
  replyText?: string;
};
/** Claim before dispatch. Approval continuations resume the saved conversation, never the original instruction. */
export function createNormalPanelTaskService(options: {
  database: Database;
  run: TurnRunner;
  read(request: FrozenPanelTask): Promise<NormalPanelTaskResult>;
  stop(input: { threadId: string; runId: string }): Promise<unknown>;
  createConversation(
    request: FrozenPanelTask,
  ): Promise<{ channelId: string; threadId: string }>;
  isWaiting(error: unknown): boolean;
}) {
  const db = options.database,
    active = new Map<string, AbortController>();
  async function turn(
    id: string,
    input: Parameters<TurnRunner>[0],
    runner: TurnRunner,
  ) {
    const abort = new AbortController();
    const forward = () => abort.abort();
    input.signal?.addEventListener("abort", forward, { once: true });
    if (input.signal?.aborted) abort.abort();
    active.set(id, abort);
    try {
      const [current] = await db
        .select({
          status: panelTaskRequests.status,
          runId: panelTaskRequests.runId,
        })
        .from(panelTaskRequests)
        .where(eq(panelTaskRequests.id, id));
      if (current?.status !== "running" || current.runId !== input.runId)
        abort.abort();
      if (abort.signal.aborted) throw new PanelError("task_cancelled", 409);
      const result = await runner({ ...input, signal: abort.signal });
      await db
        .update(panelTaskRequests)
        .set({ status: "succeeded" })
        .where(
          and(
            eq(panelTaskRequests.id, id),
            eq(panelTaskRequests.runId, input.runId!),
            eq(panelTaskRequests.status, "running"),
          ),
        );
      return result;
    } catch (error) {
      await db
        .update(panelTaskRequests)
        .set({
          status:
            options.isWaiting(error) || isContinuationDeferred(error)
              ? "waiting"
              : "failed",
        })
        .where(
          and(
            eq(panelTaskRequests.id, id),
            eq(panelTaskRequests.runId, input.runId!),
            eq(panelTaskRequests.status, "running"),
          ),
        );
      throw error;
    } finally {
      if (active.get(id) === abort) active.delete(id);
      input.signal?.removeEventListener("abort", forward);
    }
  }
  return {
    async start(request: FrozenPanelTask) {
      const runId = `panel-run:${request.id}`,
        args = request.args;
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        typeof args.instruction !== "string"
      )
        throw new PanelError("invalid_adapter_input", 400);
      const claimed = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(panelTaskRequests)
          .where(eq(panelTaskRequests.id, request.id))
          .for("update");
        if (
          !row ||
          row.actorId !== request.actorId ||
          row.botId !== request.botId
        )
          throw new PanelError("task_binding_refused", 403);
        if (row.runId) {
          if (row.runId !== runId) throw new PanelError("task_status_conflict");
          return false;
        }
        if (row.status !== "confirmed")
          throw new PanelError("task_status_conflict");
        await tx
          .update(panelTaskRequests)
          .set({ runId, status: "running" })
          .where(eq(panelTaskRequests.id, row.id));
        return true;
      });
      if (!claimed) return { runId };
      void (async () => {
        try {
          const conversation = await options.createConversation(request);
          const updated = await db
            .update(panelTaskRequests)
            .set(conversation)
            .where(
              and(
                eq(panelTaskRequests.id, request.id),
                eq(panelTaskRequests.status, "running"),
                eq(panelTaskRequests.runId, runId),
              ),
            )
            .returning({ id: panelTaskRequests.id });
          if (!updated.length) return;
          await turn(
            request.id,
            {
              ownerUserId: request.actorId,
              agentId: request.botId,
              routineId: request.id,
              threadId: conversation.threadId,
              runId,
              instruction: args.instruction as string,
              initiator: { kind: "person" },
            },
            options.run,
          );
        } catch (error) {
          if (!options.isWaiting(error))
            await db
              .update(panelTaskRequests)
              .set({ status: "failed" })
              .where(
                and(
                  eq(panelTaskRequests.id, request.id),
                  eq(panelTaskRequests.status, "running"),
                  eq(panelTaskRequests.runId, runId),
                ),
              );
        }
      })().catch(() => {});
      return { runId };
    },
    async runContinuation(
      input: Parameters<TurnRunner>[0],
      runner: TurnRunner,
    ): ReturnType<TurnRunner> {
      const [task] = await db
        .select()
        .from(panelTaskRequests)
        .where(
          and(
            eq(panelTaskRequests.threadId, input.threadId),
            eq(panelTaskRequests.actorId, input.ownerUserId),
            eq(panelTaskRequests.botId, input.agentId),
          ),
        );
      if (!task) return runner(input);
      if (task.status === "running" || task.status === "unknown") {
        const recovered = await options.read({
          ...task,
          args: task.args.value,
          adapter: "bot",
          action: "task",
        });
        if (recovered.status === "waiting")
          await db
            .update(panelTaskRequests)
            .set({ status: "waiting" })
            .where(
              and(
                eq(panelTaskRequests.id, task.id),
                eq(panelTaskRequests.status, task.status),
                eq(panelTaskRequests.runId, task.runId!),
              ),
            );
      }
      const runId = input.runId ?? crypto.randomUUID();
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(panelTaskRequests)
          .where(eq(panelTaskRequests.id, task.id))
          .for("update");
        if (
          current?.status !== "waiting" ||
          (input.continuation &&
            input.continuation.snapshot.runId !== current.runId)
        )
          throw new PanelError("task_resume_refused", 409);
        await tx
          .update(panelTaskRequests)
          .set({ status: "running", runId })
          .where(eq(panelTaskRequests.id, task.id));
      });
      try {
        return await turn(task.id, { ...input, runId }, runner);
      } catch (error) {
        if (isContinuationDeferred(error))
          await db
            .update(panelTaskRequests)
            .set({ status: "waiting", runId: task.runId })
            .where(
              and(
                eq(panelTaskRequests.id, task.id),
                eq(panelTaskRequests.runId, runId),
                eq(panelTaskRequests.status, "waiting"),
              ),
            );
        throw error;
      }
    },
    async query(request: FrozenPanelTask): Promise<NormalPanelTaskResult> {
      return options.read(request);
    },
    async cancel(request: FrozenPanelTask) {
      active.get(request.id)?.abort();
      const [row] = await db
        .select({
          runId: panelTaskRequests.runId,
          threadId: panelTaskRequests.threadId,
        })
        .from(panelTaskRequests)
        .where(
          and(
            eq(panelTaskRequests.id, request.id),
            eq(panelTaskRequests.actorId, request.actorId),
            eq(panelTaskRequests.botId, request.botId),
          ),
        );
      if (row?.runId && row.threadId)
        await options.stop({ threadId: row.threadId, runId: row.runId });
    },
  };
}
