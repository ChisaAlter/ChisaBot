import type { RunAgentInput } from "@ag-ui/core";
import type { ReactFrontendTool } from "@copilotkit/react-core/v2";
import { markApprovalPause } from "./stopped-turn";

type HandlerContext = Parameters<NonNullable<ReactFrontendTool["handler"]>>[1];
type Agent = NonNullable<HandlerContext["agent"]>;
const inputs = new WeakMap<Agent, RunAgentInput>();
type BackendOwnedRun = {
  runId: string;
  threadId: string;
  names: Set<string>;
  calls: Map<string, string>;
  stopped: boolean;
};
const backendRuns = new WeakMap<Agent, BackendOwnedRun>();

/** Only an ownership announcement and a real call in this run can suppress a frontend handler. */
export function backendOwnsFrontendCall(context: HandlerContext): boolean {
  const agent = context.agent;
  const run = agent ? backendRuns.get(agent) : undefined;
  return Boolean(
    run && agent && run.threadId === agent.threadId &&
    run.names.has(context.toolCall.function.name) &&
    run.calls.get(context.toolCall.id) === context.toolCall.function.name,
  );
}

/** Capture the SDK's real run input and backend call ownership before frontend dispatch. */
export function observeApprovalAgent(agent: Agent) {
  const reset = (input: RunAgentInput) => {
    inputs.set(agent, input);
    backendRuns.set(agent, {
      runId: input.runId,
      threadId: input.threadId,
      names: new Set(),
      calls: new Map(),
      stopped: false,
    });
  };
  const stopBackendFallback = (messages: ReadonlyArray<Readonly<RunAgentInput["messages"][number]>>) => {
    const run = backendRuns.get(agent);
    if (!run || run.stopped || run.threadId !== agent.threadId) return;
    const answered = new Set(messages.flatMap((message) => message.role === "tool" ? [message.toolCallId] : []));
    const pending = messages.some((message) =>
      message.role === "assistant" && message.toolCalls?.some((call) =>
        run.names.has(call.function.name) && run.calls.get(call.id) === call.function.name && !answered.has(call.id),
      ),
    );
    if (!pending) return;
    run.stopped = true;
    markApprovalPause();
    // Core intercepts abortRun for its complete tool-processing phase. Stop in an awaited terminal
    // event hook; the SDK does not await onRunFinalized, so that hook alone can race frontend dispatch.
    agent.abortRun();
  };
  const subscription = agent.subscribe({
    onRunInitialized: ({ input }) => reset(input),
    onRunStartedEvent: ({ input, event }) => {
      reset({ ...input, runId: event.runId, threadId: event.threadId });
    },
    onCustomEvent: ({ event }) => {
      if (event.name !== "chisabot.backend-owned-tools") return;
      const run = backendRuns.get(agent);
      const value: unknown = event.value;
      if (!run || !value || typeof value !== "object" || !("names" in value) || !Array.isArray(value.names)) return;
      for (const name of value.names)
        if (typeof name === "string" && name) run.names.add(name);
    },
    onToolCallStartEvent: ({ event }) => {
      backendRuns.get(agent)?.calls.set(event.toolCallId, event.toolCallName);
    },
    onRunFinishedEvent: ({ messages }) => stopBackendFallback(messages),
    onRunErrorEvent: ({ messages }) => stopBackendFallback(messages),
    onRunFailed: ({ messages }) => stopBackendFallback(messages),
    onRunFinalized: ({ messages }) => stopBackendFallback(messages),
  });
  return () => {
    subscription.unsubscribe();
    inputs.delete(agent);
    backendRuns.delete(agent);
  };
}

export function frontendApprovalSnapshot(context: HandlerContext) {
  const agent = context.agent;
  const input = agent ? inputs.get(agent) : undefined;
  if (!agent || !input || input.threadId !== agent.threadId)
    throw new Error("此操作需要在活跃会话中才能批准。");
  return {
    runId: input.runId,
    threadId: agent.threadId,
    toolCallId: context.toolCall.id,
    toolName: context.toolCall.function.name,
    args: JSON.parse(context.toolCall.function.arguments),
    messages: agent.messages,
    state: agent.state,
    context: input.context,
    forwardedProps: input.forwardedProps,
  };
}
