/**
 * The shape of one headless turn (no browser open): IM replies, panel refreshes, workers, workflows,
 * schedules, approvals resumes. Moved here from the removed upstream `routines/` module (slimming P4c);
 * the field name `routineId` is kept — it is what the audit trail names as having started the turn.
 */
import type { Message } from "@ag-ui/client";
import type { ApprovalContinuation } from "../approvals/types";
import type { AuditInitiator } from "../audit";

/** Everything a headless turn needs, injectable so tests never dial a model. */
export type TurnRunner = (input: {
  ownerUserId: string; // the actor the run asserts — grants and connections resolve to them
  routineId: string; // what the trail names as having started this turn, rather than the owner
  agentId: string;
  threadId: string; // the owner's thread for the routine's channel
  instruction: string; // the user message of this turn
  initiator?: AuditInitiator;
  signal?: AbortSignal;
  continuation?: {
    snapshot: ApprovalContinuation;
    result: { content: string; error?: string };
    messageId: string;
  };
  userMessage?: Message;
  /** Durable inbound delivery id; reused by lock, runner and emitted events. */
  runId?: string;
  /** How deep in a Bot-to-Bot chain this turn is. Absent is a person's own turn, depth zero. */
  depth?: number;
  /** The reply so far, each time more of it arrives, for a surface that shows a turn in progress. */
  onText?: (text: string) => void;
  /** Called only when durable execution/recovery has accepted this turn. */
  onAdmitted?: () => void;
  /**
   * forwardedProps for this run (工作流的面板步骤带 panelAuthoring 会话，handoffForActor 据此给面板工具)。
   * A continuation's own snapshot wins.
   */
  forwardedProps?: Record<string, unknown>;
}) => Promise<{ replyText: string; components?: DrawnComponent[] }>;

/** A display component the Bot drew in a turn and the server allowed, with the props it drew. */
export type DrawnComponent = { name: string; args: Record<string, unknown> };
