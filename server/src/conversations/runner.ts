import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import type { Observable } from "rxjs";
import type { ExecutionClass } from "./capacity";

export type AgentRunnerRunRequest = {
  threadId: string;
  agent: AbstractAgent;
  input: RunAgentInput;
  persistedInputMessages?: Message[];
  continuationRunId?: string;
  recover?: boolean;
  join?: boolean;
  execution?: ExecutionClass;
  capacityReserved?: boolean;
  /** The full input now has a durable recovery owner, independently of stream delivery. */
  onAdmitted?: () => void;
};
export type AgentRunnerConnectRequest = {
  threadId: string;
  agentId?: string;
  commandId?: string;
  runId?: string;
  /**
   * 浏览器 sync 合并式接入时手里最近几条消息的 id：快照从其中最早一条服务器也有的开始发，
   * 不再每次都发最近 400 条。一条都对不上时照旧发封顶快照。
   */
  snapshotAfter?: readonly string[];
};
export type AgentRunnerStopRequest = { threadId: string; runId?: string };
export interface ConversationRunner {
  readonly ownsThreadLease?: boolean;
  run(request: AgentRunnerRunRequest): Observable<BaseEvent>;
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent>;
  isRunning(request: { threadId: string }): Promise<boolean>;
  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined>;
}

/** Restore only open protocol lifecycles at a message-snapshot watermark. */
export function createEventLifecycles() {
  const active = new Map<string, BaseEvent>();
  const text: [string, string] = ["text", "messageId"];
  const reasoning: [string, string] = ["reasoning", "messageId"];
  const reasoningMessage: [string, string] = ["reasoning-message", "messageId"];
  const tool: [string, string] = ["tool", "toolCallId"];
  const step: [string, string] = ["step", "stepName"];
  const subagent: [string, string] = ["subagent", "subagentRunId"];
  const starts: Record<string, [string, string]> = {
    TEXT_MESSAGE_START: text,
    REASONING_START: reasoning,
    REASONING_MESSAGE_START: reasoningMessage,
    TOOL_CALL_START: tool,
    STEP_STARTED: step,
    SUBAGENT_STARTED: subagent,
  };
  const ends: Record<string, [string, string]> = {
    TEXT_MESSAGE_END: text,
    REASONING_END: reasoning,
    REASONING_MESSAGE_END: reasoningMessage,
    TOOL_CALL_END: tool,
    STEP_FINISHED: step,
    SUBAGENT_FINISHED: subagent,
    SUBAGENT_ERROR: subagent,
  };
  return {
    eventTypes: [...Object.keys(starts), ...Object.keys(ends)],
    accept(event: BaseEvent): boolean {
      const e = event as BaseEvent & Record<string, unknown>;
      const pair = starts[e.type] ?? ends[e.type];
      if (!pair) return true;
      const key = JSON.stringify([pair[0], e[pair[1]], e.subagentRunId]);
      if (starts[e.type]) {
        if (active.has(key)) return false;
        active.set(key, event);
        return true;
      }
      return active.delete(key);
    },
    openings() {
      return [...active.values()];
    },
    closeStreams() {
      const closing: BaseEvent[] = [];
      const types: Record<string, string> = {
        TEXT_MESSAGE_START: "TEXT_MESSAGE_END",
        REASONING_START: "REASONING_END",
        REASONING_MESSAGE_START: "REASONING_MESSAGE_END",
        TOOL_CALL_START: "TOOL_CALL_END",
        STEP_STARTED: "STEP_FINISHED",
      };
      for (const event of [...active.values()].reverse()) {
        const e = event as BaseEvent & Record<string, unknown>;
        const identity = starts[event.type];
        if (types[event.type] && identity)
          closing.push({
            type: types[event.type],
            [identity[1]]: e[identity[1]],
            ...(e.subagentRunId ? { subagentRunId: e.subagentRunId } : {}),
          } as BaseEvent);
      }
      return closing;
    },
  };
}

/** Close only lifecycles actually opened by the compatibility stream. */
export function createRunEventFinalizer() {
  const text = new Set<string>(),
    reasoning = new Set<string>(),
    thinking = new Set<string>(),
    tools = new Map<string, boolean>();
  const subagents = new Set<string>();
  let identity: { threadId: string; runId: string } | undefined;
  let terminal = false;
  return {
    observe(event: BaseEvent) {
      // Each field is read only under the event type that carries it.
      const e = event as BaseEvent & {
        threadId: string;
        runId: string;
        messageId: string;
        toolCallId: string;
        subagentId: string;
      };
      switch (e.type) {
        case "RUN_STARTED":
          identity = { threadId: e.threadId, runId: e.runId };
          break;
        case "RUN_FINISHED":
        case "RUN_ERROR":
          terminal = true;
          break;
        case "TEXT_MESSAGE_START":
          text.add(e.messageId);
          break;
        case "TEXT_MESSAGE_END":
          text.delete(e.messageId);
          break;
        case "REASONING_START":
          thinking.add(e.messageId);
          break;
        case "REASONING_END":
          thinking.delete(e.messageId);
          break;
        case "REASONING_MESSAGE_START":
          reasoning.add(e.messageId);
          break;
        case "REASONING_MESSAGE_END":
          reasoning.delete(e.messageId);
          break;
        case "TOOL_CALL_START":
          tools.set(e.toolCallId, false);
          break;
        case "TOOL_CALL_END":
          if (tools.has(e.toolCallId)) tools.set(e.toolCallId, true);
          break;
        case "TOOL_CALL_RESULT":
          tools.delete(e.toolCallId);
          break;
        case "SUBAGENT_STARTED":
          subagents.add(e.subagentId);
          break;
        case "SUBAGENT_FINISHED":
        case "SUBAGENT_ERROR":
          subagents.delete(e.subagentId);
          break;
      }
    },
    finalize(
      options: {
        stopRequested?: boolean;
        interruptionMessage?: string;
        protocolVersion?: string;
      } = {},
    ): BaseEvent[] {
      if (terminal || !identity) return [];
      terminal = true;
      const events: Record<string, unknown>[] = [];
      const message =
        options.interruptionMessage ??
        (options.stopRequested
          ? "This run was stopped."
          : "The connection ended before the run finished.");
      for (const messageId of text)
        events.push({ type: "TEXT_MESSAGE_END", messageId });
      for (const messageId of reasoning)
        events.push({ type: "REASONING_MESSAGE_END", messageId });
      for (const messageId of thinking)
        events.push({ type: "REASONING_END", messageId });
      for (const [toolCallId, ended] of tools) {
        if (!ended) events.push({ type: "TOOL_CALL_END", toolCallId });
        events.push({
          type: "TOOL_CALL_RESULT",
          toolCallId,
          messageId: `${toolCallId}:interrupted`,
          role: "tool",
          content: JSON.stringify({
            status: options.stopRequested ? "stopped" : "interrupted",
            message,
          }),
        });
      }
      if (options.stopRequested) {
        for (const subagentId of subagents)
          events.push({ type: "SUBAGENT_ERROR", subagentId, message });
        events.push({
          type: "RUN_FINISHED",
          ...identity,
          ...(options.protocolVersion
            ? { outcome: { type: "cancelled" } }
            : {}),
        });
      } else
        events.push({ type: "RUN_ERROR", code: "RUN_INTERRUPTED", message });
      return events as BaseEvent[];
    },
  };
}
