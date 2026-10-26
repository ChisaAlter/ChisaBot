import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AbstractAgent, EventType, HttpAgent, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/react-core/v2";
import { CopilotKitContext, CopilotKitCoreReact } from "@copilotkit/react-core/v2/context";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { of, type Observable } from "rxjs";
import { z } from "zod/v4";
import { backendOwnsFrontendCall, frontendApprovalSnapshot, observeApprovalAgent } from "../src/lib/copilot/approval-context";
import { useFrontendTool } from "../src/lib/copilot/approval-tools";
import { pausedForApproval } from "../src/lib/copilot/stopped-turn";

const NativeResponse = globalThis.Response;
const toolName = "computer_click";
const callId = "real-host-call";
const call = (id = callId, name = toolName) => ({
  id, type: "function" as const, function: { name, arguments: '{"ref":"button-1"}' },
});
const ownership = (names: unknown = [toolName]): BaseEvent => ({
  type: EventType.CUSTOM, name: "chisabot.backend-owned-tools", value: { names },
});
function toolEvents(id = callId, name = toolName): BaseEvent[] {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, parentMessageId: `assistant:${id}` },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: '{"ref":"button-1"}' },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ];
}
const started = (input: RunAgentInput): BaseEvent => ({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
const finished = (input: RunAgentInput): BaseEvent => ({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
function waiting(input: RunAgentInput): BaseEvent[] {
  return [
    { type: EventType.CUSTOM, name: "openbot.headless.waiting", value: { kind: "approval", requestId: "approval-1", toolCallId: callId } },
    { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: {
      type: "interrupt", interrupts: [{ id: callId, reason: "human_input", metadata: { openbotWaiting: { kind: "approval", requestId: "approval-1" } } }],
    } },
  ];
}
class FakeAgent extends AbstractAgent {
  runs = 0;
  aborts = 0;
  abortRun() { this.aborts++; super.abortRun(); }
  constructor(private readonly stream: (input: RunAgentInput, run: number) => BaseEvent[], messages: Message[] = []) {
    super({ agentId: "bot", threadId: "real-thread", initialMessages: [{ id: "user", role: "user", content: "Click once" }, ...messages] });
  }
  run(input: RunAgentInput): Observable<BaseEvent> { return of(...this.stream(input, ++this.runs)); }
}
function coreFor(agent: AbstractAgent, handler: () => Promise<unknown>, wildcard = false) {
  return new CopilotKitCore({ agents__unsafe_dev_only: { bot: agent }, tools: [{
    name: wildcard ? "*" : toolName, description: "Frontend action", parameters: z.object({ ref: z.string() }),
    followUp: false, handler,
  }] });
}
function context(agent: AbstractAgent, id = callId, name = toolName) {
  return { agent, toolCall: call(id, name) } as Parameters<typeof backendOwnsFrontendCall>[0];
}
const queries: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register());
afterEach(() => { cleanup(); for (const query of queries.splice(0)) query.clear(); });
afterAll(() => GlobalRegistrator.unregister());

describe("backend-owned tools through real CopilotKitCore", () => {
  test.each(["waiting", "error", "missing receipt"] as const)("%s never dispatches a frontend handler or appends a synthetic result", async (ending) => {
    let executions = 0;
    const terminal = (input: RunAgentInput): BaseEvent[] => ending === "waiting" ? waiting(input)
      : ending === "error" ? [{ type: EventType.RUN_ERROR, code: "ACP_MISSING_TOOL_RESULT", message: "Host action result is unavailable" }]
      : [finished(input)];
    const agent = new FakeAgent((input) => [started(input), ownership(), ...toolEvents(), ...terminal(input)]);
    const events: BaseEvent[] = [];
    const keepEvents = agent.subscribe({ onEvent: ({ event }) => { events.push(event); } });
    const stop = observeApprovalAgent(agent);
    const core = coreFor(agent, async () => { executions++; return "DUPLICATE"; });
    try {
      await core.runAgent({ agent });
      expect(executions).toBe(0);
      expect(agent.messages.filter((message) => message.role === "tool")).toEqual([]);
      expect(agent.messages.some((message) => message.role === "assistant" && message.toolCalls?.some((entry) => entry.id === callId))).toBe(true);
      expect(agent.runs).toBe(1);
      expect(agent.aborts).toBe(1);
      expect(backendOwnsFrontendCall(context(agent))).toBe(true);
      expect(pausedForApproval()).toBe(true);
      if (ending === "waiting") {
        expect(agent.pendingInterrupts).toMatchObject([{ id: callId, metadata: { openbotWaiting: { kind: "approval" } } }]);
        expect(events).toContainEqual(expect.objectContaining({ name: "openbot.headless.waiting" }));
      }
      if (ending === "error") expect(events).toContainEqual(expect.objectContaining({ type: EventType.RUN_ERROR, code: "ACP_MISSING_TOOL_RESULT" }));
    } finally { stop(); keepEvents.unsubscribe(); }
  });

  test("a real HttpAgent keeps an approval interrupt while stopping browser fallback", async () => {
    let requests = 0;
    let executions = 0;
    const agent = new HttpAgent({
      agentId: "bot", threadId: "real-thread", url: "http://fake.invalid/ag-ui",
      initialMessages: [{ id: "user", role: "user", content: "Click once" }],
      fetch: async (_url, init) => {
        requests++;
        const input = JSON.parse(String(init.body)) as RunAgentInput;
        const events = [started(input), ownership(), ...toolEvents(), ...waiting(input)];
        return new NativeResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const stop = observeApprovalAgent(agent);
    const core = coreFor(agent, async () => { executions++; return "DUPLICATE"; });
    try {
      await core.runAgent({ agent });
      expect(requests).toBe(1);
      expect(executions).toBe(0);
      expect(agent.messages.some((message) => message.role === "tool")).toBe(false);
      expect(agent.pendingInterrupts).toMatchObject([{ id: callId, metadata: { openbotWaiting: { kind: "approval" } } }]);
      expect(backendOwnsFrontendCall(context(agent))).toBe(true);
    } finally { stop(); }
  });

  test("also protects a wildcard handler registered directly in the SDK", async () => {
    let executions = 0;
    const agent = new FakeAgent((input) => [started(input), ownership(), ...toolEvents(), ...waiting(input)]);
    const stop = observeApprovalAgent(agent);
    const core = coreFor(agent, async () => { executions++; return "WILDCARD_DUPLICATE"; }, true);
    try {
      await core.runAgent({ agent });
      expect(executions).toBe(0);
      expect(agent.messages.some((message) => message.role === "tool")).toBe(false);
    } finally { stop(); }
  });

  test("normal host results are kept and already skip frontend execution", async () => {
    let executions = 0;
    const agent = new FakeAgent((input) => [started(input), ownership(), ...toolEvents(), {
      type: EventType.TOOL_CALL_RESULT, messageId: "host-receipt", toolCallId: callId, role: "tool", content: "HOST_RESULT",
    }, finished(input)]);
    const stop = observeApprovalAgent(agent);
    const core = coreFor(agent, async () => { executions++; return "DUPLICATE"; });
    try {
      await core.runAgent({ agent });
      expect(executions).toBe(0);
      expect(agent.aborts).toBe(0);
      expect(agent.messages.filter((message) => message.role === "tool")).toEqual([
        { id: "host-receipt", role: "tool", toolCallId: callId, content: "HOST_RESULT" },
      ]);
    } finally { stop(); }
  });

  test.each(["unannounced", "different name", "malformed names"] as const)("%s tools still execute as ordinary frontend tools", async (mode) => {
    let executions = 0;
    const announcement = mode === "unannounced" ? [] : [ownership(mode === "different name" ? ["other_tool"] : "computer_click")];
    const agent = new FakeAgent((input) => [started(input), ...announcement, ...toolEvents(), finished(input)]);
    const stop = observeApprovalAgent(agent);
    const core = coreFor(agent, async () => { executions++; return "FRONTEND_RESULT"; });
    try {
      await core.runAgent({ agent });
      expect(executions).toBe(1);
      expect(backendOwnsFrontendCall(context(agent))).toBe(false);
      expect(agent.messages.filter((message) => message.role === "tool")).toMatchObject([{ toolCallId: callId, content: "FRONTEND_RESULT" }]);
    } finally { stop(); }
  });

  test("ownership resets per run and never attaches to another call id, name or thread", async () => {
    let executions = 0;
    const agent = new FakeAgent((input, round) => round === 1
      ? [started(input), ownership(), ...toolEvents(), ...waiting(input)]
      : [started(input), ...toolEvents("frontend-call"), finished(input)]);
    const stop = observeApprovalAgent(agent);
    const core = coreFor(agent, async () => { executions++; return "FRONTEND_RESULT"; });
    try {
      await core.runAgent({ agent });
      expect(backendOwnsFrontendCall(context(agent))).toBe(true);
      expect(backendOwnsFrontendCall(context(agent, "forged-call"))).toBe(false);
      expect(backendOwnsFrontendCall(context(agent, callId, "other_tool"))).toBe(false);
      agent.threadId = "different-thread";
      expect(backendOwnsFrontendCall(context(agent))).toBe(false);
      agent.threadId = "real-thread";
      agent.pendingInterrupts = [];
      await core.runAgent({ agent });
      expect(agent.runs).toBe(2);
      expect(executions).toBe(1);
      expect(backendOwnsFrontendCall(context(agent))).toBe(false);
      expect(agent.messages.filter((message) => message.role === "tool")).toMatchObject([{ toolCallId: "frontend-call", content: "FRONTEND_RESULT" }]);
    } finally { stop(); }
  });

  test("historical assistant calls without a real start are not claimed by a names announcement", async () => {
    const agent = new FakeAgent((input) => [started(input), ownership(), finished(input)], [
      { id: "historical", role: "assistant", toolCalls: [call()] },
    ]);
    const stop = observeApprovalAgent(agent);
    const core = coreFor(agent, async () => "UNUSED");
    try {
      await core.runAgent({ agent });
      expect(backendOwnsFrontendCall(context(agent))).toBe(false);
      expect(agent.aborts).toBe(0);
    } finally { stop(); }
  });

  test("ownership follows the announced current call even if names arrive after TOOL_CALL_START", async () => {
    const agent = new FakeAgent((input) => [started(input), ...toolEvents(), ownership(), ...waiting(input)]);
    const stop = observeApprovalAgent(agent);
    let executions = 0;
    const core = coreFor(agent, async () => { executions++; return "DUPLICATE"; });
    try {
      await core.runAgent({ agent });
      expect(executions).toBe(0);
      expect(backendOwnsFrontendCall(context(agent))).toBe(true);
      const snapshot = frontendApprovalSnapshot(context(agent));
      expect(snapshot).toMatchObject({ runId: expect.any(String), threadId: "real-thread", toolCallId: callId, args: { ref: "button-1" } });
      stop();
      expect(backendOwnsFrontendCall(context(agent))).toBe(false);
    } finally { stop(); }
  });
});

function mountTool(core: CopilotKitCoreReact, name: string, handler: (args: Record<string, unknown>) => Promise<unknown>) {
  const query = new QueryClient();
  queries.push(query);
  function Tool() {
    useFrontendTool({ name, description: "Browser operation", parameters: z.object({ ref: z.string() }), followUp: false, handler });
    return null;
  }
  render(createElement(QueryClientProvider, { client: query },
    createElement(CopilotKitContext.Provider, { value: { copilotkit: core, executingToolCallIds: new Set<string>() } }, createElement(Tool)),
  ));
}

describe("approval wrapper with the real SDK hooks", () => {
  test("owned waiting calls never send approval or direct browser requests", async () => {
    const agent = new FakeAgent((input) => [started(input), ownership(), ...toolEvents(), ...waiting(input)]);
    const stop = observeApprovalAgent(agent);
    const core = new CopilotKitCoreReact({ agents__unsafe_dev_only: { bot: agent } });
    let executions = 0;
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No browser or approval request is allowed"));
    try {
      mountTool(core, toolName, async () => { executions++; return { clicked: true }; });
      await core.runAgent({ agent });
      expect(executions).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(agent.messages.some((message) => message.role === "tool")).toBe(false);
    } finally { fetch.mockRestore(); stop(); }
  });

  test("the outer ownership guard blocks a stale direct wrapper invocation before approval handling", async () => {
    const agent = new FakeAgent((input) => [started(input), ownership(), ...toolEvents(), ...waiting(input)]);
    const stop = observeApprovalAgent(agent);
    const core = new CopilotKitCoreReact({ agents__unsafe_dev_only: { bot: agent } });
    let executions = 0;
    const stopped = spyOn(core, "stopAgent");
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No request is allowed"));
    try {
      mountTool(core, toolName, async () => { executions++; return { clicked: true }; });
      await core.runAgent({ agent });
      const registered = core.getTool({ toolName, agentId: "bot" });
      const result = await registered?.handler?.({ ref: "button-1" }, context(agent));
      expect(result).toBeUndefined();
      expect(stopped).toHaveBeenCalledWith({ agent });
      expect(executions).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(agent.messages.some((message) => message.role === "tool")).toBe(false);
    } finally { fetch.mockRestore(); stopped.mockRestore(); stop(); }
  });

  test("an ordinary frontend read still executes and returns its real result", async () => {
    const name = "computer_read";
    const agent = new FakeAgent((input) => [started(input), ...toolEvents(callId, name), finished(input)]);
    const stop = observeApprovalAgent(agent);
    const core = new CopilotKitCoreReact({ agents__unsafe_dev_only: { bot: agent } });
    let executions = 0;
    try {
      mountTool(core, name, async () => { executions++; return { read: true }; });
      await core.runAgent({ agent });
      expect(executions).toBe(1);
      expect(agent.messages.filter((message) => message.role === "tool")).toMatchObject([{ toolCallId: callId, content: '{"read":true}' }]);
    } finally { stop(); }
  });
});
