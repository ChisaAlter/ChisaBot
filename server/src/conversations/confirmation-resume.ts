import type { AbstractAgent } from "@ag-ui/client";
import { DshRuntimeAgent } from "../agents/dsh-runtime";
import { CHISABOT_WAITING_METADATA } from "../approvals/native-context";
import type { AuditInitiator } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { createConfirmations } from "../confirmations/service";
import type { Database } from "../db/client";
import { runAssertionValue } from "../legacy/protocol";
import type { LocalConversationBackend } from "../local-conversations";
import type { TurnRunner } from "../turns/types";
import {
  executionClass,
  executionDeadline,
  withCapacityFeedback,
} from "./capacity";
import { assertConversationAdmissionOpen } from "./maintenance";
import { createDshRunJournal } from "./run-journal";

/** Resume the saved effect once, then continue the conversation from its real receipt. */
export function createConfirmationResumer(options: {
  database: Database;
  backend: LocalConversationBackend;
  confirmations: ReturnType<typeof createConfirmations>;
  buildAgentFor(input: {
    ownerUserId: string;
    agentId: string;
    initiator: AuditInitiator;
  }): Promise<AbstractAgent>;
  runTurn: TurnRunner;
  /** Renew only a server-stored, durably approved delegation; live callbacks keep their expiry. */
  refreshRunAssertion?(
    signed: unknown,
    ownerUserId: string,
    agentId: string,
  ): string | null;
}) {
  const { database, backend } = options;
  const journal = createDshRunJournal(database);
  return async (ownerUserId: string, requestId: string) => {
    assertConversationAdmissionOpen();
    const decision = await options.confirmations.durableDecision(
      ownerUserId,
      requestId,
    );
    if (!decision) return;
    const { snapshot } = decision;
    const runId = `confirmation:${requestId}`;
    const [existing] = await database.$client.unsafe<{ status: string }[]>(
      "SELECT status FROM chisabot_local_runs WHERE thread_id=$1 AND run_id=$2",
      [snapshot.threadId, runId],
    );
    if (existing) {
      if (existing.status === "running")
        throw new Error("The confirmation continuation is still running.");
      return;
    }
    if (await journal.continuationRefusal(snapshot.threadId, snapshot.runId))
      return;
    if (backend.control.isActive(snapshot.threadId))
      throw new Error(
        "The conversation is still settling its previous execution.",
      );
    const forwarded =
      snapshot.forwardedProps &&
      typeof snapshot.forwardedProps === "object" &&
      !Array.isArray(snapshot.forwardedProps)
        ? (snapshot.forwardedProps as Record<string, unknown>)
        : {};
    const refreshed = options.refreshRunAssertion?.(
      runAssertionValue(forwarded),
      ownerUserId,
      decision.agentId,
    );
    if (refreshed)
      snapshot.forwardedProps = { ...forwarded, chisabotRun: refreshed };
    const agent = await options.buildAgentFor({
      ownerUserId,
      agentId: decision.agentId,
      initiator: snapshot.initiator ?? { kind: "person" },
    });
    if (!(agent instanceof DshRuntimeAgent))
      throw new Error(
        "The saved confirmation requires its DSH execution owner.",
      );
    const abort = new AbortController();
    const signal = abort.signal;
    const deadline = executionDeadline(5 * 60_000, () =>
      abort.abort(new Error("确认续执行达到执行时限。")),
    );
    try {
      await withCapacityFeedback(
        (state) => deadline.state(state),
        () =>
          backend.leases.acquire({
            threadId: snapshot.threadId,
            runId: snapshot.runId,
            userId: ownerUserId,
            agentId: decision.agentId,
            ttlSeconds: 120,
            background:
              executionClass(
                snapshot.initiator ?? { kind: "person" },
                Boolean(forwarded.chisabotWorkerDelivery),
              ).kind === "background",
            signal,
          }),
      );
    } catch (error) {
      deadline.cancel();
      throw error;
    }
    let checking = false;
    let renewAt = Date.now() + 30_000;
    const heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        const refusal = await journal.continuationRefusal(
          snapshot.threadId,
          snapshot.runId,
        );
        if (refusal) abort.abort(new Error(refusal));
        if (Date.now() >= renewAt) {
          await backend.leases.renew({
            threadId: snapshot.threadId,
            runId: snapshot.runId,
            ttlSeconds: 120,
          });
          renewAt = Date.now() + 30_000;
        }
      })()
        .catch((error) => abort.abort(error))
        .finally(() => {
          checking = false;
        });
    }, 1000);
    let result;
    try {
      assertConversationAdmissionOpen();
      if (await journal.continuationRefusal(snapshot.threadId, snapshot.runId))
        return;
      result = await agent.resumeConfirmation({ ...decision, signal });
    } catch (error) {
      // A new approval belongs to its own durable decision, not a retry of this one.
      if (error instanceof HeadlessToolSuspension) {
        if (error.waiting.kind === "operation_unknown") {
          await database.$client.begin(async (tx) => {
            await tx.unsafe(
              "UPDATE chisabot_dsh_runs SET status='waiting',updated_at=now() WHERE thread_id=$1 AND run_id=$2 AND NOT stop_requested",
              [snapshot.threadId, snapshot.runId],
            );
            const event = {
              type: "RUN_FINISHED",
              threadId: snapshot.threadId,
              runId: snapshot.runId,
              outcome: {
                type: "interrupt",
                interrupts: [
                  {
                    id: snapshot.toolCallId,
                    reason: "human_input",
                    message: error.message,
                    metadata: { [CHISABOT_WAITING_METADATA]: error.waiting },
                  },
                ],
              },
            };
            await tx.unsafe(
              `INSERT INTO chisabot_local_events(thread_id,run_id,event) SELECT $1,$2,$3::text::jsonb
              WHERE EXISTS(SELECT 1 FROM chisabot_dsh_runs WHERE thread_id=$1 AND run_id=$2 AND NOT stop_requested)`,
              [snapshot.threadId, snapshot.runId, JSON.stringify(event)],
            );
          });
        }
        return;
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      deadline.cancel();
      await backend.leases.release({
        threadId: snapshot.threadId,
        runId: snapshot.runId,
      });
    }
    if (await journal.continuationRefusal(snapshot.threadId, snapshot.runId))
      return;
    await options.runTurn({
      ownerUserId,
      agentId: decision.agentId,
      threadId: snapshot.threadId,
      routineId: runId,
      runId,
      initiator: snapshot.initiator ?? { kind: "person" },
      instruction: "",
      continuation: { snapshot, messageId: `${runId}:result`, result },
    });
  };
}
