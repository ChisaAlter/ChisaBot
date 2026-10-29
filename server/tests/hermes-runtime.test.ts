import { describe, expect, test } from "bun:test";
import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { z } from "zod";
import { acceptedHermesFallback, HermesRuntimeAgent, type HermesRunConfiguration, hermesRuntimeTools, hermesWireModel } from "../src/agents/hermes-runtime";
import { createRuntimeToolsRoutes } from "../src/agents/runtime-tools";
import { currentApprovalContext } from "../src/approvals/types";
import { HeadlessToolsMiddleware, type HeadlessTool } from "../src/computer/headless-tools";
import { currentConfirmToolCall, currentToolAbort, withToolAbort } from "../src/confirmations/context";
import type { GrantedTool } from "../src/plugins/tools";

const encoder = new TextEncoder();
function fixture(options: { missingResult?: boolean; scopeMismatch?: boolean; tool?: GrantedTool; surfaces?: HeadlessTool[]; finished?: Record<string, unknown>; extra?: Partial<HermesRunConfiguration> } = {}) {
  const requests: RunAgentInput[] = [];
  let executions = 0;
  let approval: ReturnType<typeof currentApprovalContext>;
  let confirmation: ReturnType<typeof currentConfirmToolCall>;
  let signal: AbortSignal | undefined;
  let capability: string | undefined;
  const api = createRuntimeToolsRoutes(hermesRuntimeTools);
  const definition: GrantedTool = options.tool ?? {
    name: "web_search", ref: "web/search", description: "Search public sources", parameters: z.object({ query: z.string() }),
    execute: async () => {
      executions++;
      approval = currentApprovalContext();
      confirmation = currentConfirmToolCall();
      signal = currentToolAbort();
      return "official source found";
    },
  };
  const transport = new HttpAgent({
    agentId: "bot", url: "https://hermes.test/ag-ui",
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init.body)) as RunAgentInput;
      requests.push(input);
      const wire = input.forwardedProps.chisabotHermes as { toolGateway: { capability: string } };
      capability = wire.toolGateway.capability;
      return new Response(new ReadableStream({
        start(controller) {
          const send = (event: BaseEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          void (async () => {
            send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
            send({ type: "STATE_SNAPSHOT", snapshot: { real: "state" } });
            send({ type: "TOOL_CALL_START", toolCallId: "real-provider-call", toolCallName: definition.name, parentMessageId: "real-provider-message" });
            send({ type: "TOOL_CALL_ARGS", toolCallId: "real-provider-call", delta: '{"query":"ima official integration"}' });
            send({ type: "TOOL_CALL_END", toolCallId: "real-provider-call" });
            if (!options.missingResult) {
              // The request intentionally races the event consumer: the registry must wait for capture.
              const response = await api.request("/tools/call", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${capability}` }, body: JSON.stringify({ callId: "real-provider-call", name: definition.name, args: { query: "ima official integration" }, actorId: "forged" }) });
              const result = await response.json() as { result?: string };
              if (response.status !== 200) throw new Error(JSON.stringify(result));
              send({ type: "TOOL_CALL_RESULT", toolCallId: "real-provider-call", messageId: "receipt", role: "tool", content: result.result! });
            }
            send({ type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" });
            send({ type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "Found the official documentation." });
            send({ type: "TEXT_MESSAGE_END", messageId: "answer" });
            send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, ...(options.finished ? { metadata: options.finished } : {}) } as BaseEvent);
            controller.close();
          })().catch((error) => controller.error(error));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const agent = new HermesRuntimeAgent(transport, {
    botId: "bot", modelId: "codex/gpt-6-luna",
    binding: {
      toolGatewayUrl: "http://host/api/internal/runtime-tools",
      readRun: () => ({ actorId: "owner", botId: options.scopeMismatch ? "other-bot" : "bot", threadId: "thread", runId: "run", initiator: { kind: "person" } }),
      loadSurfaceTools: async () => options.surfaces ?? [],
    },
    signRun: () => "server-signed-run",
    toolsFor: async () => [definition],
    prepare: async (input) => ({ ...input, messages: [{ id: "system", role: "system", content: "You are 星灵. Updated user memory." }, ...input.messages] }),
    ...options.extra,
  });
  agent.threadId = "thread";
  agent.messages = [{ id: "user", role: "user", content: "Find how to integrate ima" }];
  return { agent, requests, executions: () => executions, approval: () => approval, confirmation: () => confirmation, signal: () => signal, capability: () => capability };
}

describe("Hermes host runtime", () => {
  test("cloned runs invoke the actual host executor with canonical context and a revocable capability", async () => {
    const f = fixture();
    const clone = f.agent.clone();
    clone.threadId = "thread";
    clone.messages = [...f.agent.messages];
    await clone.runAgent({ runId: "run", tools: [{ name: "forged_shell", description: "Client supplied", parameters: { type: "object" } }], forwardedProps: { chisabotHermes: { scope: { actorId: "forged" } } } });
    expect(f.executions()).toBe(1);
    expect(f.requests[0]?.tools.map((tool) => tool.name)).toEqual(["web_search"]);
    expect(f.requests[0]?.forwardedProps.chisabotHermes).toMatchObject({ version: 1, scope: { actorId: "owner", botId: "bot", threadId: "thread", runId: "run" }, model: { id: "codex/gpt-6-luna" } });
    expect(f.approval()).toMatchObject({ runId: "run", threadId: "thread", toolCallId: "real-provider-call", toolName: "web_search", state: { real: "state" } });
    expect(f.approval()?.forwardedProps).not.toHaveProperty("chisabotHermes");
    expect(f.confirmation()).toEqual({ toolCallId: "real-provider-call", toolName: "web_search" });
    expect(f.signal()).toBeInstanceOf(AbortSignal);
    expect(hermesRuntimeTools.get(f.capability()!)).toBeUndefined();
    expect(clone.messages.at(-1)).toMatchObject({ content: "Found the official documentation." });
  });

  test("does not let Headless compensate an executed backend call whose receipt is missing", async () => {
    const f = fixture({ missingResult: true });
    let duplicate = 0;
    f.agent.use(new HeadlessToolsMiddleware([{ definition: { name: "web_search", description: "surface copy", parameters: { type: "object" } }, execute: async () => { duplicate++; return "duplicate"; } }]));
    const events: BaseEvent[] = [];
    await f.agent.runAgent({ runId: "run" }, { onEvent: ({ event }) => { events.push(event); } });
    expect(duplicate).toBe(0);
    expect(f.executions()).toBe(0);
    expect(events.some((event) => event.type === "RUN_ERROR" && event.code === "HERMES_MISSING_TOOL_RECEIPT")).toBe(true);
    expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(false);
  });

  test.each(["host abort", "agent abort"] as const)("%s closes capture, revokes the gateway and aborts HTTP before late events", async (mode) => {
    const host = new AbortController();
    const connected = Promise.withResolvers<void>();
    const seen: BaseEvent[] = [];
    let transportSignal: AbortSignal | undefined;
    let streamCancelled = false;
    let capability = "";
    let emitLate: (() => void) | undefined;
    const transport = new HttpAgent({ agentId: "bot", url: "https://fake.test/ag-ui", fetch: async (_url, init) => {
      const input = JSON.parse(String(init.body)) as RunAgentInput;
      capability = (input.forwardedProps.chisabotHermes as { toolGateway: { capability: string } }).toolGateway.capability;
      transportSignal = init.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(controller) {
          const send = (event: BaseEvent) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch {} };
          send({ type: "RUN_STARTED", threadId: "thread", runId: "run" });
          emitLate = () => {
            send({ type: "TEXT_MESSAGE_START", messageId: "late", role: "assistant" });
            send({ type: "TEXT_MESSAGE_CONTENT", messageId: "late", delta: "late data must stay isolated" });
            send({ type: "TEXT_MESSAGE_END", messageId: "late" });
            send({ type: "RUN_FINISHED", threadId: "thread", runId: "run" });
            try { controller.close(); } catch {}
          };
        },
        cancel() { streamCancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    } });
    const agent = new HermesRuntimeAgent(transport, {
      botId: "bot", modelId: "test-model",
      binding: { toolGatewayUrl: "http://fake.test/tools", readRun: () => ({ actorId: "owner", botId: "bot", threadId: "thread", runId: "run" }) },
      signRun: () => "signed-run", toolsFor: async () => [], prepare: async (input) => input,
    });
    agent.threadId = "thread";
    agent.messages = [{ id: "u", role: "user", content: "hold the connection" }];
    const work = withToolAbort(host.signal, () => agent.runAgent({ runId: "run" }, { onEvent: ({ event }) => {
      seen.push(event);
      if (event.type === "RUN_STARTED") connected.resolve();
    } }));
    await connected.promise;
    expect(hermesRuntimeTools.get(capability)).toBeDefined();
    if (mode === "host abort") host.abort("host stopped"); else agent.abortRun();
    await work;
    expect(transportSignal?.aborted).toBe(true);
    expect(hermesRuntimeTools.get(capability)).toBeUndefined();
    expect(seen.some((event) => event.type === "RUN_ERROR" && event.code === "HERMES_RUN_CANCELLED")).toBe(true);
    const count = seen.length;
    emitLate?.();
    await Bun.sleep(10);
    expect(seen).toHaveLength(count);
    expect(seen.some((event) => event.type === "RUN_FINISHED")).toBe(false);
    expect(streamCancelled || transportSignal?.aborted).toBe(true);
  });

  test("each turn carries its backup models, output cap and host-compaction flag; a Hermes switch is checked, logged and kept on RUN_FINISHED", async () => {
    const logs: Record<string, unknown>[] = [];
    const f = fixture({
      finished: { modelFallback: { from: "codex/gpt-6-luna", to: "codex/backup", reason: "quota" } },
      extra: {
        modelControls: async () => ({ fallbacks: ["codex/backup", "codex/gpt-6-luna", "codex/backup", "bad id", "codex/other"], maxOutputTokens: 32_000 }),
        finishedMetadata: (runId) => (runId === "run" ? { historyCompaction: { mode: "trim", summarizedTurns: 0, beforeTokens: 900, afterTokens: 500 } } : undefined),
        hostCompacted: (runId) => runId === "run",
        log: (line) => logs.push(line),
      },
    });
    const events: BaseEvent[] = [];
    await f.agent.runAgent({ runId: "run" }, { onEvent: ({ event }) => { events.push(event); } });
    expect(f.requests[0]?.forwardedProps.chisabotHermes.model).toEqual({
      id: "codex/gpt-6-luna",
      fallbacks: ["codex/backup", "codex/other"],
      maxOutputTokens: 32_000,
      contextCompression: false,
    });
    const finished = events.find((event) => event.type === "RUN_FINISHED") as BaseEvent & { metadata?: Record<string, unknown> };
    expect(finished.metadata).toEqual({
      modelFallback: { from: "codex/gpt-6-luna", to: "codex/backup", reason: "quota" },
      historyCompaction: { mode: "trim", summarizedTurns: 0, beforeTokens: 900, afterTokens: 500 },
    });
    expect(logs).toEqual([{ type: "model-fallback", event: "used", model: "codex/gpt-6-luna", fallback: "codex/backup", reason: "quota", kernel: "hermes" }]);
  });

  test("a switch to a model the host never offered is dropped; no controls means the bare model id", async () => {
    const logs: Record<string, unknown>[] = [];
    const f = fixture({ finished: { modelFallback: { from: "codex/gpt-6-luna", to: "attacker/model", reason: "quota" } }, extra: { log: (line) => logs.push(line) } });
    const events: BaseEvent[] = [];
    await f.agent.runAgent({ runId: "run" }, { onEvent: ({ event }) => { events.push(event); } });
    expect(f.requests[0]?.forwardedProps.chisabotHermes.model).toEqual({ id: "codex/gpt-6-luna" });
    expect(events.find((event) => event.type === "RUN_FINISHED")).not.toHaveProperty("metadata");
    expect(logs).toEqual([]);
    expect(hermesWireModel("m", { fallbacks: [], maxOutputTokens: 0 })).toEqual({ id: "m" });
    expect(hermesWireModel("m", { fallbacks: Array.from({ length: 12 }, (_, i) => `b${i}`) }).fallbacks).toHaveLength(8);
    expect(acceptedHermesFallback({ from: "m", to: "b", reason: "overloaded" }, { id: "m", fallbacks: ["b"] })).toEqual({ from: "m", to: "b", reason: "unavailable" });
    expect(acceptedHermesFallback({ from: "x", to: "b" }, { id: "m", fallbacks: ["b"] })).toBeNull();
  });

  test("an already aborted host signal never opens the transport", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort("stopped before start");
    const seen: BaseEvent[] = [];
    await withToolAbort(controller.signal, () => f.agent.runAgent({ runId: "run" }, { onEvent: ({ event }) => { seen.push(event); } }));
    expect(f.requests).toHaveLength(0);
    expect(seen.filter((event) => event.type === "RUN_ERROR")).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "HERMES_RUN_CANCELLED" });
  });

  test("rejects an assertion that resolves to a different Bot without contacting Hermes", async () => {
    const f = fixture({ scopeMismatch: true });
    const events: BaseEvent[] = [];
    await f.agent.runAgent({ runId: "run" }, { onEvent: ({ event }) => { events.push(event); } });
    expect(f.requests).toHaveLength(0);
    expect(events.some((event) => event.type === "RUN_ERROR" && event.code === "HERMES_HOST_BINDING_ERROR")).toBe(true);
  });
});
