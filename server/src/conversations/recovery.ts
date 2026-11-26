import type { AbstractAgent } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import { reasonWithoutStatement } from "../db/query-failure";
import type { LocalConversationBackend } from "../local-conversations";
import { isGroupChatProps } from "../memory/tools";
import { executionClass } from "./capacity";
import { conversationAdmissionClosedAsync } from "./maintenance";
import type { DshRunJournal } from "./run-journal";

/**
 * 恢复接管连续失败的计数（进程态，重启后从零再来）。
 * 连接不上执行内核的回合每轮 sweep 都会重试；没有上限的话 pending 行会
 * 永远占着观察位、把部署排空卡死。
 */
const recoveryFailures = new Map<string, number>();

/** 15s 一轮的 sweep 连续失败约 5 分钟后按 interrupted 收尾。 */
const RECOVERY_FAILURE_LIMIT = 20;

type PendingRunRecord = {
  thread_id: string;
  run_id: string;
  owner_user_id: string;
  bot_id: string;
  input: import("@ag-ui/client").RunAgentInput;
};

/** Recover execution owners first; queued sends may only start after their predecessors settle. */
export async function recoverConversations(options: {
  backend: LocalConversationBackend;
  journal: DshRunJournal;
  /** run 被按 interrupted 收尾时，把还在 dispatching 的操作落 outcome_unknown。 */
  settleInterrupted?: (record: PendingRunRecord) => Promise<void>;
  buildAgentFor(input: {
    ownerUserId: string;
    agentId: string;
    initiator: AuditInitiator;
    /** 恢复群聊回合时保持私密记忆隔离。 */
    isGroupChat?: boolean;
  }): Promise<AbstractAgent>;
}) {
  const { backend } = options;
  await backend.commands.reconcile();
  const pending = await options.journal.pending();
  const occupied = new Set(pending.map((record) => record.thread_id));
  const pendingIds = new Set(pending.map((record) => record.run_id));
  for (const runId of recoveryFailures.keys())
    if (!pendingIds.has(runId)) recoveryFailures.delete(runId);
  const fail = async (
    record: PendingRunRecord,
    type: string,
    error: unknown,
  ) => {
    console.warn(
      JSON.stringify({
        type,
        runId: record.run_id,
        reason: reasonWithoutStatement(error),
      }),
    );
    const count = (recoveryFailures.get(record.run_id) ?? 0) + 1;
    if (count < RECOVERY_FAILURE_LIMIT) {
      recoveryFailures.set(record.run_id, count);
      return;
    }
    recoveryFailures.delete(record.run_id);
    await options.journal
      .status(record.thread_id, record.run_id, "interrupted")
      .catch(() => {});
    await options.settleInterrupted?.(record).catch(() => {});
    if (!backend.control.isActive(record.thread_id)) {
      await backend.client
        .releaseOrphanedLock(record.thread_id, record.run_id)
        .catch(() => {});
      await backend.client
        .closeInterruptedRun(record.thread_id, record.run_id)
        .catch(() => {});
    }
  };
  const start = async (record: PendingRunRecord, initiator: AuditInitiator) => {
    if (backend.control.isActive(record.thread_id)) return;
    try {
      const agent = await options.buildAgentFor({
        ownerUserId: record.owner_user_id,
        agentId: record.bot_id,
        initiator,
        ...(isGroupChatProps(record.input?.forwardedProps)
          ? { isGroupChat: true }
          : {}),
      });
      backend.runner
        .run({
          threadId: record.thread_id,
          agent,
          input: record.input,
          recover: true,
          join: false,
          execution: executionClass(initiator),
        })
        .subscribe({
          error: (error) =>
            void fail(record, "conversation-recovery-failed", error),
        });
    } catch (error) {
      await fail(record, "conversation-recovery-pending", error);
    }
  };
  for (const record of pending) await start(record, record.initiator);
  if (await conversationAdmissionClosedAsync({ ttlMs: 0 })) return;
  for (const record of await backend.capacity.queued()) {
    if (occupied.has(record.thread_id)) continue;
    const saved = record.execution;
    try {
      const agent = await options.buildAgentFor({
        ownerUserId: record.owner_user_id,
        agentId: record.bot_id,
        initiator: saved.initiator,
        ...(isGroupChatProps(saved.input?.forwardedProps)
          ? { isGroupChat: true }
          : {}),
      });
      backend.runner
        .run({
          threadId: record.thread_id,
          agent,
          input: saved.input,
          execution: saved,
          persistedInputMessages: saved.persistedInputMessages,
          continuationRunId: saved.continuationRunId,
          join: false,
        })
        .subscribe({
          error: (error) =>
            console.warn(
              JSON.stringify({
                type: "capacity-recovery-pending",
                runId: record.run_id,
                reason: reasonWithoutStatement(error),
              }),
            ),
        });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "capacity-recovery-pending",
          runId: record.run_id,
          reason: reasonWithoutStatement(error),
        }),
      );
    }
  }
  for (const command of await backend.commands.pending()) {
    if (!occupied.has(command.thread_id))
      await start(command, { kind: "person" });
  }
}
