import type { AbstractAgent } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import type { LocalConversationBackend } from "../local-conversations";
import type { DshRunJournal } from "./run-journal";
import { reasonWithoutStatement } from "../db/query-failure";
import { conversationAdmissionClosed } from "./maintenance";

/** Recover execution owners first; queued sends may only start after their predecessors settle. */
export async function recoverConversations(options: {
  backend: LocalConversationBackend;
  journal: DshRunJournal;
  buildAgentFor(input: { ownerUserId: string; agentId: string; initiator: AuditInitiator }): Promise<AbstractAgent>;
}) {
  const { backend } = options;
  await backend.commands.reconcile();
  const pending = await options.journal.pending();
  const occupied = new Set(pending.map(record => record.thread_id));
  const start = async (record: { thread_id: string; run_id: string; owner_user_id: string; bot_id: string; input: import("@ag-ui/client").RunAgentInput }, initiator: AuditInitiator) => {
    if (backend.control.isActive(record.thread_id)) return;
    try {
      const agent = await options.buildAgentFor({ ownerUserId: record.owner_user_id, agentId: record.bot_id, initiator });
      backend.runner.run({ threadId: record.thread_id, agent, input: record.input, recover: true, join: false }).subscribe({
        error: error => console.warn(JSON.stringify({ type: "conversation-recovery-failed", runId: record.run_id, reason: reasonWithoutStatement(error) })),
      });
    } catch (error) { console.warn(JSON.stringify({ type: "conversation-recovery-pending", runId: record.run_id, reason: reasonWithoutStatement(error) })); }
  };
  for (const record of pending) await start(record, record.initiator);
  if (conversationAdmissionClosed()) return;
  for (const command of await backend.commands.pending()) {
    if (!occupied.has(command.thread_id)) await start(command, { kind: "person" });
  }
}
