import { randomUUID } from "node:crypto";
import {
  mintRunAssertion,
  readApprovedRunAssertion,
  type RunAssertion,
} from "./callback-token";
import type { HandoffWork } from "./handoff-runner";

/** Called only for a saved action whose owner's durable approval has been verified. */
export function refreshApprovedHandoffRun(
  signed: unknown,
  ownerUserId: string,
  botId: string,
  encryptionKey: string,
): string | null {
  const run = readApprovedRunAssertion(signed, encryptionKey);
  if (!run?.handoff) return null;
  if (run.actorId !== ownerUserId || run.botId !== botId)
    throw new Error(
      "The approved handoff does not belong to this Bot and owner.",
    );
  return mintRunAssertion(run, encryptionKey);
}

/** Bind the leased delegation to its actual execution without changing its source authority. */
export function bindHandoffExecution(
  previous: RunAssertion,
  execution: Pick<RunAssertion, "botId" | "actorId" | "runId" | "threadId">,
  encryptionKey: string,
): string {
  if (
    !previous.handoff ||
    previous.botId !== execution.botId ||
    previous.actorId !== execution.actorId
  )
    throw new Error(
      "The delegated run identity does not match this Bot and owner.",
    );
  const sourceThreadId = previous.handoff.sourceThreadId ?? previous.threadId;
  if (!sourceThreadId || !execution.threadId)
    throw new Error(
      "The delegated run is missing its source or execution conversation.",
    );
  return mintRunAssertion(
    {
      ...previous,
      ...execution,
      handoff: {
        ...previous.handoff,
        sourceThreadId,
        executionRunId: previous.handoff.executionRunId ?? previous.runId,
      },
    },
    encryptionKey,
  );
}

/** Coordination still belongs to the conversation that requested the delegated work. */
export function coordinationSourceRun(run: RunAssertion): RunAssertion {
  return run.handoff?.sourceThreadId
    ? { ...run, threadId: run.handoff.sourceThreadId }
    : run;
}

/**
 * The signed run identity for a queued handoff delivery.
 *
 * Kept outside index.ts so tests can exercise the same production boundary without booting the
 * server. The queue already carries the original run context; this function is the single place that
 * turns that queued context into the assertion the addressed Bot receives.
 */
export function handoffDeliveryRunAssertion(
  work: HandoffWork,
  runId: string,
  claim?: RunAssertion["handoff"],
): RunAssertion {
  return {
    botId: work.toBotId,
    actorId: work.actorId,
    runId,
    threadId: work.threadId,
    depth: work.depth,
    ...(work.initiator ? { initiator: work.initiator } : {}),
    ...(claim ? { handoff: claim } : {}),
  };
}

export function signHandoffDeliveryRun(
  work: HandoffWork,
  encryptionKey: string,
  runId: string = work.execution?.runId ?? randomUUID(),
  claim?: RunAssertion["handoff"],
): string {
  return mintRunAssertion(
    handoffDeliveryRunAssertion(work, runId, claim),
    encryptionKey,
  );
}
