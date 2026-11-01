import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { HermesRuntimeAgent, hermesRuntimeTools } from "../../server/src/agents/hermes-runtime";
import { createRuntimeToolsRoutes } from "../../server/src/agents/runtime-tools";
import { createAcpBridge } from "./bridge.mjs";

// The callback integration uses the server's exact dependency versions (root also has Zod v3).
const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { HttpAgent } = serverRequire("@ag-ui/client");
const { z } = serverRequire("zod");

// All child processes are this local fake. No Hermes install, model, credentials or remote server.
const fakeAcp = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
const running: ReturnType<typeof createAcpBridge>[] = [];
const directories: string[] = [];
const callbackServers: Bun.Server<undefined>[] = [];
function temp() {
  const path = mkdtempSync(join(tmpdir(), "chisabot-acp-"));
  directories.push(path);
  return path;
}
function bridge(config: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const directory = temp();
  const recordFile = join(directory, "fake.jsonl");
  const created = createAcpBridge({
    command: [process.execPath, fakeAcp, JSON.stringify({ ...config, recordFile })],
    cwd: process.cwd(), port: 0, approval: "allow",
    turnTimeoutMs: 3_000, initTimeoutMs: 2_000, cancelGraceMs: 80,
    ...overrides,
  });
  running.push(created);
  return {
    ...created,
    url: `http://127.0.0.1:${created.server.port}`,
    records: () => existsSync(recordFile) ? readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
  };
}
async function events(response: Response) {
  return (await response.text()).split("\n\n").map((chunk) => chunk.trim()).filter(Boolean)
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
}
async function post(created: ReturnType<typeof bridge>, input: any) {
  return events(await fetch(`${created.url}/ag-ui`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
}
function generic(text = "你好，ACP", runId = "run-1", threadId = "thread-1") {
  return { threadId, runId, messages: [{ id: `u-${runId}`, role: "user", content: text }] };
}
function host(text = "你好，Hermes", runId = "run-1", scope: Record<string, string> = {}) {
  const identity = { actorId: "actor-1", botId: "bot-1", threadId: "thread-1", runId, ...scope };
  return {
    threadId: identity.threadId, runId: identity.runId,
    messages: [{ id: `u-${runId}`, role: "user", content: text }] as any[],
    tools: [{ name: "canonical_echo", description: "echo a value", parameters: { type: "object", properties: { command: { type: "string" } } } }],
    forwardedProps: { chisabotHermes: { version: 1, scope: identity, toolGateway: { url: "http://127.0.0.1:9/tools", capability: "private-capability" }, model: { id: "test-model" } } },
  };
}
const prompts = (created: ReturnType<typeof bridge>) => created.records().filter((item) => item.type === "prompt");
const sessions = (created: ReturnType<typeof bridge>) => created.records().filter((item) => item.type === "session_new");
async function until(check: () => boolean, label = "condition", timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}
async function health(created: ReturnType<typeof bridge>) { return (await fetch(`${created.url}/health`)).json(); }

afterEach(async () => {
  await Promise.all(running.splice(0).map((created) => created.close()));
  for (const server of callbackServers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ACP AG-UI bridge host contract", () => {
  test("maps text, reasoning, canonical tool names, permission and one complete input snapshot", async () => {
    const created = bridge({ reasoning: true });
    const result = await post(created, generic());
    expect(result[0]).toEqual({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" });
    expect(result.some((event) => event.type === "REASONING_MESSAGE_CONTENT" && event.delta === "思考中")).toBe(true);
    expect(result.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "收到：你好，ACP")).toBe(true);
    expect(result.find((event) => event.type === "TOOL_CALL_START").toolCallName).toBe("canonical_echo");
    const args = result.filter((event) => event.type === "TOOL_CALL_ARGS");
    expect(args).toHaveLength(1);
    expect(JSON.parse(args[0].delta)).toEqual({ command: "echo hi", nested: { ready: true } });
    expect(result.findIndex((event) => event === args[0])).toBeLessThan(result.findIndex((event) => event.type === "TOOL_CALL_END"));
    expect(result.find((event) => event.type === "TOOL_CALL_RESULT").content).toBe("hi");
    expect(created.records().find((item) => item.type === "permission").outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-1" } });
    expect(result.at(-1)).toEqual({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" });
  });

  test("complete host input is captured before the real HTTP callback may execute", async () => {
    const created = bridge({ callback: true });
    const routes = createRuntimeToolsRoutes(hermesRuntimeTools);
    const callbackFailures: string[] = [];
    const callback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      const response = await routes.fetch(request);
      if (response.status !== 200) callbackFailures.push(await response.clone().text());
      return response;
    } });
    callbackServers.push(callback);
    const seen: any[] = [];
    let executions = 0;
    const agent = new HermesRuntimeAgent(new HttpAgent({ agentId: "bot-1", url: `${created.url}/ag-ui` }), {
      botId: "bot-1", modelId: "test-model",
      binding: {
        toolGatewayUrl: `http://127.0.0.1:${callback.port}`,
        readRun: () => ({ actorId: "actor-1", botId: "bot-1", runId: "run-1", threadId: "thread-1" }),
      },
      signRun: () => "signed-run",
      toolsFor: async () => [{
        name: "canonical_echo", ref: "local/echo", description: "echo", parameters: z.object({ command: z.string() }),
        execute: async (args) => {
          executions += 1;
          expect(args).toEqual({ command: "echo hi" });
          return "host callback executed";
        },
      }],
      prepare: async (input) => input,
    });
    agent.threadId = "thread-1";
    agent.messages = [{ id: "u", role: "user", content: "execute actual callback" }];
    await agent.runAgent({ runId: "run-1" }, { onEvent: ({ event }) => { seen.push(event); } });
    expect(callbackFailures).toEqual([]);
    expect(created.records().filter((item) => item.type === "callback")).toMatchObject([{ status: 200 }]);
    expect(seen.filter((event) => event.type === "RUN_ERROR")).toEqual([]);
    expect(executions).toBe(1);
    expect(seen.at(-1).type).toBe("RUN_FINISHED");
    expect(seen.find((event) => event.type === "TOOL_CALL_RESULT").content).toBe("host callback executed");
    expect(created.records().find((item) => item.type === "callback").status).toBe(200);
    expect(seen.filter((event) => event.type === "TOOL_CALL_ARGS")).toHaveLength(1);
    expect(seen.findIndex((event) => event.type === "TOOL_CALL_END")).toBeLessThan(seen.findIndex((event) => event.type === "TOOL_CALL_RESULT"));
  });

  test("a snapshot cannot change published complete host input", async () => {
    const created = bridge({ completeHostInput: true, inputConflict: true });
    const result = await post(created, host());
    expect(result.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "ACP_TOOL_INPUT_CONFLICT" });
    const args = result.filter((event) => event.type === "TOOL_CALL_ARGS");
    expect(args).toHaveLength(1);
    expect(JSON.parse(args[0].delta)).toEqual({ command: "echo hi" });
    expect(result.some((event) => event.type === "RUN_FINISHED")).toBe(false);
  });

  test("separates actor/bot identities while serializing concurrent first turns into one session", async () => {
    const created = bridge({ sessionDelayMs: 50, noTools: true });
    const first = host("one", "run-1");
    const second = host("two", "run-2");
    const [one, two] = await Promise.all([post(created, first), post(created, second)]);
    expect(one.at(-1).type).toBe("RUN_FINISHED");
    expect(two.at(-1).type).toBe("RUN_FINISHED");
    expect(sessions(created)).toHaveLength(1);
    await post(created, host("other actor", "run-1", { actorId: "actor-2" }));
    await post(created, host("other bot", "run-1", { botId: "bot-2" }));
    expect(sessions(created)).toHaveLength(3);
    expect(new Set(prompts(created).map((item) => item.sessionId)).size).toBe(3);
    const records = created.records();
    const firstEnd = records.findIndex((item) => item.type === "prompt_end" && item.text === "one");
    const secondStart = records.findIndex((item) => item.type === "prompt" && item.text === "two");
    expect(secondStart).toBeGreaterThan(firstEnd);
    await until(() => true);
    expect((await health(created)).queuedScopes).toBe(0);
  });

  test("sends dynamic system, full tool/image history, schemas and model in metadata on every turn", async () => {
    const created = bridge({ noTools: true });
    const first = host("first", "run-1");
    first.messages.unshift({ id: "s", role: "system", content: "memory version 1" });
    await post(created, first);
    const next = host("unused", "run-2");
    const priorAssistant = { id: "a", role: "assistant", content: null, toolCalls: [{ id: "history-call", type: "function", function: { name: "canonical_echo", arguments: '{"command":"hi"}' } }] };
    const image = { type: "image_url", image_url: { url: "https://example.invalid/image.png", detail: "high" } };
    next.messages = [
      { id: "s", role: "system", content: "memory version 2" },
      first.messages.at(-1), priorAssistant,
      { id: "t", role: "tool", toolCallId: "history-call", content: "actual result" },
      { id: "old-image", role: "user", content: [{ type: "text", text: "old photo" }, image] },
      { id: "a2", role: "assistant", content: "seen" },
      { id: "u2", role: "user", content: [{ type: "text", text: "current photo" }, image] },
    ];
    await post(created, next);
    const [one, two] = prompts(created);
    expect(one.params._meta.chisabot.systemPrompt).toBe("memory version 1");
    const metadata = two.params._meta.chisabot;
    expect(metadata.systemPrompt).toBe("memory version 2");
    expect(metadata.scope).toEqual(next.forwardedProps.chisabotHermes.scope);
    expect(metadata.model).toEqual({ id: "test-model" });
    expect(metadata.tools).toEqual([{ name: "canonical_echo", description: "echo a value", inputSchema: next.tools[0].parameters }]);
    expect(metadata.history).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: null, tool_calls: priorAssistant.toolCalls },
      { role: "tool", content: "actual result", tool_call_id: "history-call" },
      { role: "user", content: [{ type: "text", text: "old photo" }, image] },
      { role: "assistant", content: "seen" },
    ]);
    expect(metadata.currentMessage).toEqual({ role: "user", content: [{ type: "text", text: "current photo" }, image] });
    expect(two.params.prompt).toEqual([{ type: "text", text: "current photo" }, { type: "resource_link", uri: image.image_url.url, name: "user image", mimeType: "image/*" }]);
    expect(JSON.stringify(two.params.prompt)).not.toContain("memory version");
    expect(JSON.stringify(two.params.prompt)).not.toContain("private-capability");
    expect(sessions(created)).toHaveLength(1);
  });

  test("tool-result continuation never resends an old user prompt and retains all non-system history", async () => {
    const created = bridge({ noTools: true });
    const input = host("old user");
    input.messages = [
      { id: "s", role: "system", content: "fresh memory" },
      ...input.messages,
      { id: "a", role: "assistant", content: "", tool_calls: [{ id: "real-old-call", type: "function", function: { name: "canonical_echo", arguments: "{}" } }] },
      { id: "t", role: "tool", tool_call_id: "real-old-call", content: "new result" },
    ];
    const result = await post(created, input);
    expect(result.at(-1).type).toBe("RUN_FINISHED");
    const params = prompts(created)[0].params;
    expect(params._meta.chisabot.continuation).toBe(true);
    expect(params._meta.chisabot.currentMessage).toBeUndefined();
    expect(params._meta.chisabot.history).toHaveLength(3);
    expect(params._meta.chisabot.history.at(-1)).toEqual({ role: "tool", tool_call_id: "real-old-call", content: "new result" });
    expect(params.prompt[0].text).toContain("Continue the assistant turn");
    expect(params.prompt[0].text).not.toContain("old user");
  });

  test("same input in progress and after completion replays identical SSE without another prompt", async () => {
    const created = bridge({ promptDelayMs: 100 });
    const input = host();
    const first = post(created, input);
    await until(() => prompts(created).length === 1, "first prompt");
    const duplicate = structuredClone(input);
    duplicate.forwardedProps.chisabotHermes.toolGateway.capability = "rotated-capability";
    const second = post(created, duplicate);
    const [one, two] = await Promise.all([first, second]);
    const three = await post(created, input);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
    expect(prompts(created)).toHaveLength(1);
  });

  test("conflicting inputs cannot reprompt but an extended history segment can", async () => {
    const created = bridge({ noTools: true });
    const input = host("initial");
    await post(created, input);
    const conflict = structuredClone(input);
    conflict.messages[0].content = "mutated";
    expect((await post(created, conflict)).at(-1)).toMatchObject({ type: "RUN_ERROR", code: "ACP_RUN_CONFLICT" });
    const memoryOnly = structuredClone(input);
    memoryOnly.messages.unshift({ id: "s", role: "system", content: "regenerated memory" });
    expect((await post(created, memoryOnly)).at(-1).code).toBe("ACP_RUN_CONFLICT");
    const extension = structuredClone(memoryOnly);
    extension.messages.push({ id: "a", role: "assistant", content: "answer" }, { id: "next", role: "user", content: "new segment" });
    expect((await post(created, extension)).at(-1).type).toBe("RUN_FINISHED");
    expect(prompts(created)).toHaveLength(2);
    expect(prompts(created)[1].params._meta.chisabot.systemPrompt).toBe("regenerated memory");
  });

  test("generic ACP retains seed compatibility but refuses host tools and unadvertised adapters", async () => {
    const created = bridge({ noTools: true, hostTools: false });
    const input = generic("hello");
    input.messages.unshift({ id: "s", role: "system", content: "generic identity" });
    await post(created, input);
    await post(created, { ...input, runId: "run-2" });
    expect(prompts(created)[0].params.prompt[0].text).toContain("generic identity");
    expect(prompts(created)[1].params.prompt).toEqual([{ type: "text", text: "hello" }]);
    expect((await post(created, host())).at(-1).code).toBe("ACP_HOST_TOOLS_UNSUPPORTED");
    expect((await post(created, { ...generic("tool", "tool-run"), tools: [{ name: "test" }] })).at(-1).code).toBe("ACP_HOST_CONTEXT_REQUIRED");
    expect(prompts(created)).toHaveLength(2);
  });

  test("required host mode rejects missing, malformed or mismatched contexts before spawning", async () => {
    const statePath = join(temp(), "state.json");
    const created = bridge({}, { requireHostContext: true, statePath });
    expect((await post(created, generic())).at(-1).code).toBe("ACP_HOST_CONTEXT_REQUIRED");
    const mismatched = host();
    mismatched.threadId = "wrong-thread";
    expect((await post(created, mismatched)).at(-1).code).toBe("ACP_INVALID_HOST_CONTEXT");
    const malformed = host();
    malformed.forwardedProps.chisabotHermes.model.id = "";
    expect((await post(created, malformed)).at(-1).code).toBe("ACP_INVALID_HOST_CONTEXT");
    const noState = bridge({}, { requireHostContext: true });
    expect((await post(noState, host())).at(-1).code).toBe("ACP_STATE_REQUIRED");
    expect(created.records()).toHaveLength(0);
    expect(noState.records()).toHaveLength(0);
  });

  test("backup models and output cap reach the adapter; a Hermes model switch is reported once, validated", async () => {
    const created = bridge({ noTools: true, modelControls: { fallback: true, maxOutputTokens: true }, modelFallback: { from: "test-model", to: "backup-model", reason: "quota", extra: "dropped" } });
    expect((await health(created)).modelControls).toBeNull();
    const input = host();
    (input.forwardedProps.chisabotHermes as { model: unknown }).model = { id: "test-model", fallbacks: ["backup-model", "other-model"], maxOutputTokens: 32000, contextCompression: false };
    const result = await post(created, input);
    expect(prompts(created)[0].params._meta.chisabot.model).toEqual({ id: "test-model", fallbacks: ["backup-model", "other-model"], maxOutputTokens: 32000, contextCompression: false });
    expect(result.at(-1)).toEqual({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1", metadata: { modelFallback: { from: "test-model", to: "backup-model", reason: "quota" } } });
    expect((await health(created)).modelControls).toEqual({ fallback: true, maxOutputTokens: true });
    for (const model of [{ id: "m", fallbacks: "backup" }, { id: "m", fallbacks: ["has space"] }, { id: "m", fallbacks: Array.from({ length: 9 }, (_, i) => `m${i}`) }, { id: "m", maxOutputTokens: 0 }, { id: "m", maxOutputTokens: 1.5 }, { id: "m", contextCompression: "off" }]) {
      const bad = host("x", "bad-run");
      (bad.forwardedProps.chisabotHermes as { model: unknown }).model = model;
      expect((await post(created, bad)).at(-1).code).toBe("ACP_INVALID_HOST_CONTEXT");
    }
    const leaked = host("x", "leak-run");
    (leaked.forwardedProps.chisabotHermes as { model: unknown }).model = { id: "test-model", fallbacks: ["private-capability"] };
    expect((await post(created, leaked)).at(-1).code).toBe("ACP_INVALID_HOST_CONTEXT");
  });

  test("an adapter that detected no model controls reports them as unsupported, and malformed switches are dropped", async () => {
    const created = bridge({ noTools: true, modelFallback: { from: "test-model", to: "test-model" } });
    const result = await post(created, host());
    expect(result.at(-1)).toEqual({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" });
    expect((await health(created)).modelControls).toEqual({ fallback: false, maxOutputTokens: false });
  });

  test("transport capabilities cannot enter prompts or gateway URLs", async () => {
    const created = bridge();
    const leaked = host();
    leaked.messages.unshift({ role: "system", content: "private-capability" });
    expect((await post(created, leaked)).at(-1).code).toBe("ACP_INVALID_HOST_CONTEXT");
    const query = host();
    query.forwardedProps.chisabotHermes.toolGateway.url += "?capability=secret";
    expect((await post(created, query)).at(-1).code).toBe("ACP_INVALID_HOST_CONTEXT");
    expect(created.records()).toHaveLength(0);
  });

  test("queued abort skips only the queued turn and cannot cancel the active turn", async () => {
    const created = bridge({ noTools: true, turns: { active: { delayMs: 100 } } });
    const active = post(created, host("active", "active-run"));
    await until(() => prompts(created).length === 1, "active prompt");
    const controller = new AbortController();
    const queuedInput = host("queued", "queued-run");
    const skipped = events(created.run(queuedInput, controller.signal));
    controller.abort();
    await skipped;
    const result = await active;
    expect(result.at(-1).type).toBe("RUN_FINISHED");
    const replay = await post(created, queuedInput);
    expect(replay.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "ACP_CANCELLED" });
    expect(prompts(created)).toHaveLength(1);
    expect(created.records().filter((item) => item.type === "cancel")).toHaveLength(0);
    expect((await health(created)).queuedScopes).toBe(0);
  });

  test("active abort retains its queue lock until RPC settles, then uses a fresh session", async () => {
    const created = bridge({ noTools: true, cancelDelayMs: 70, turns: { slow: { delayMs: 500 } } }, { cancelGraceMs: 200 });
    const controller = new AbortController();
    const firstInput = host("slow", "abort-run");
    const first = events(created.run(firstInput, controller.signal));
    await until(() => prompts(created).length === 1, "slow prompt");
    controller.abort();
    await first;
    const next = post(created, host("next", "next-run"));
    await until(() => created.records().some((item) => item.type === "cancel"), "cancel notification");
    expect(prompts(created)).toHaveLength(1);
    const result = await next;
    expect(result.at(-1).type).toBe("RUN_FINISHED");
    const records = created.records();
    expect(records.findIndex((item) => item.type === "prompt" && item.text === "next")).toBeGreaterThan(records.findIndex((item) => item.type === "prompt_end" && item.text === "slow"));
    expect(sessions(created)).toHaveLength(2);
    expect((await post(created, firstInput)).at(-1).code).toBe("ACP_CANCELLED");
  });

  test("aborting one SSE duplicate keeps a run alive for its remaining subscriber", async () => {
    const created = bridge({ noTools: true, promptDelayMs: 100 });
    const input = host();
    const controller = new AbortController();
    const first = events(created.run(input, controller.signal));
    await until(() => prompts(created).length === 1, "active prompt");
    const second = events(created.run(input));
    controller.abort();
    await first;
    expect((await second).at(-1).type).toBe("RUN_FINISHED");
    expect(created.records().some((item) => item.type === "cancel")).toBe(false);
  });

  test("uncooperative cancellation retires the process and excludes late old-generation updates", async () => {
    const created = bridge({ noTools: true, ignoreCancel: true, staleAfterCancelMs: 100, turns: { old: { delayMs: 300 } } }, { cancelGraceMs: 30 });
    const controller = new AbortController();
    const first = events(created.run(host("old", "old-run"), controller.signal));
    await until(() => prompts(created).length === 1, "old prompt");
    controller.abort();
    await first;
    const result = await post(created, host("new", "new-run"));
    expect(result.at(-1).type).toBe("RUN_FINISHED");
    expect(JSON.stringify(result)).not.toContain("STALE_OLD_UPDATE");
    expect(created.records().filter((item) => item.type === "spawn")).toHaveLength(2);
    expect(new Set(prompts(created).map((item) => item.pid)).size).toBe(2);
  });

  test("turnTimeout spans session/new and prompt, sends cancel, and does not release early", async () => {
    const created = bridge({ sessionDelayMs: 150, noTools: true, ignoreCancel: true, turns: { slow: { delayMs: 5_000 } } }, { token: "timeout-ready", turnTimeoutMs: 500, cancelGraceMs: 30 });
    expect((await fetch(`${created.url}/ready`, { method: "POST", headers: { authorization: "Bearer timeout-ready" } })).status).toBe(200);
    const first = await events(created.run(host("slow", "timeout-run")));
    expect(first.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "ACP_TURN_TIMEOUT" });
    const records = created.records();
    const slowPrompt = prompts(created).find((item) => item.text === "slow");
    const start = records.find((item) => item.type === "session_new" && item.sessionId === slowPrompt.sessionId).at;
    const cancel = records.find((item) => item.type === "cancel");
    expect(cancel.at - start).toBeLessThan(550);
    expect(cancel.at - start).toBeGreaterThan(350);
    expect(cancel.sessionId).toBe(slowPrompt.sessionId);
    const next = await events(created.run(host("next", "after-timeout")));
    expect(next.at(-1).type).toBe("RUN_FINISHED");
    expect(created.records().filter((item) => item.type === "spawn")).toHaveLength(2);
  });

  test("a session/new timeout cancels when its session arrives and never sends prompt", async () => {
    const created = bridge({ sessionDelayMs: 500, noTools: true }, { token: "timeout-ready", turnTimeoutMs: 350, cancelGraceMs: 300 });
    expect((await fetch(`${created.url}/ready`, { method: "POST", headers: { authorization: "Bearer timeout-ready" } })).status).toBe(200);
    const result = await events(created.run(host()));
    expect(result.at(-1).code).toBe("ACP_TURN_TIMEOUT");
    expect(prompts(created)).toHaveLength(0);
    await until(() => created.records().some((item) => item.type === "cancel"), "late session cancellation");
    expect(created.records().filter((item) => item.type === "cancel")).toHaveLength(1);
  });

  test("session/prompt really runs beyond 60 seconds when the configured deadline allows it", async () => {
    const created = bridge({ noTools: true, promptDelayMs: 60_100 }, { turnTimeoutMs: 70_000 });
    const result = await post(created, host());
    expect(result.at(-1).type).toBe("RUN_FINISHED");
    const records = created.records();
    expect(records.find((item) => item.type === "prompt_end").at - records.find((item) => item.type === "prompt").at).toBeGreaterThan(60_000);
    expect(records.some((item) => item.type === "cancel")).toBe(false);
  }, 75_000);

  test("process exit is unhealthy and the next independent request initializes a new child", async () => {
    const created = bridge({ noTools: true, exitOnceFile: join(temp(), "once") });
    const input = host("exit", "exit-run");
    expect((await post(created, input)).at(-1).code).toBe("ACP_PROCESS_EXIT");
    expect(await health(created)).toMatchObject({ ok: false, healthy: false, initialized: false });
    expect((await post(created, input)).at(-1).code).toBe("ACP_PROCESS_EXIT");
    expect(prompts(created)).toHaveLength(1);
    expect((await post(created, host("restart", "restart-run"))).at(-1).type).toBe("RUN_FINISHED");
    expect(created.records().filter((item) => item.type === "initialize")).toHaveLength(2);
    expect(await health(created)).toMatchObject({ ok: true, healthy: true, initialized: true });
  });

  test("spawn ENOENT never yields a green health result", async () => {
    const created = bridge({}, { command: [join(temp(), "does-not-exist.exe")] });
    const result = await post(created, host());
    expect(result.at(-1).code).toBe("ACP_SPAWN_ERROR");
    expect(await health(created)).toMatchObject({ ok: false, healthy: false, initialized: false });
    expect((await post(created, host("another", "other-run"))).at(-1).code).toBe("ACP_SPAWN_ERROR");
    expect((await health(created)).generation).toBe(2);
  });

  test.each(["cancelled", "refusal", "max_tokens", "max_turn_requests"])("stopReason %s is an error", async (stopReason) => {
    const created = bridge({ stopReason });
    const result = await post(created, host());
    expect(result.at(-1).type).toBe("RUN_ERROR");
    expect(result.some((event) => event.type === "RUN_FINISHED")).toBe(false);
  });

  test("missing real tool IDs and missing results cannot finish or trigger Headless fallback", async () => {
    const missingId = bridge({ missingToolId: true });
    const invalid = await post(missingId, host());
    expect(invalid.at(-1).code).toBe("ACP_INVALID_TOOL_CALL");
    expect(invalid.some((event) => event.type === "RUN_FINISHED")).toBe(false);
    const missingResult = bridge({ missingToolResult: true });
    const result = await post(missingResult, host());
    expect(result.at(-1).code).toBe("ACP_MISSING_TOOL_RESULT");
    expect(result.some((event) => event.type === "RUN_FINISHED")).toBe(false);
  });

  test("nullable ACP schema defaults are missing results, while rawOutput remains exact", async () => {
    const missing = bridge({ nullToolResult: true });
    const absent = await post(missing, host());
    expect(absent.at(-1).code).toBe("ACP_MISSING_TOOL_RESULT");
    expect(absent.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(false);
    const output = '{"result":"exact original result"}';
    const exact = bridge({ rawOutput: output });
    const result = await post(exact, host());
    expect(result.find((event) => event.type === "TOOL_CALL_RESULT").content).toBe(output);
    expect(result.at(-1).type).toBe("RUN_FINISHED");
  });

  test("waiting metadata maps to CUSTOM and interrupt with the actual tool call ID", async () => {
    const created = bridge({ waiting: { note: "confirm please", capability: "do-not-persist" } });
    const result = await post(created, host());
    const waiting = result.find((event) => event.type === "CUSTOM" && event.name === "openbot.headless.waiting");
    const start = result.find((event) => event.type === "TOOL_CALL_START");
    expect(waiting.value).toMatchObject({ kind: "approval", toolCallId: start.toolCallId, reason: "human_input", capability: "[REDACTED]" });
    expect(result.at(-1)).toMatchObject({
      type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: start.toolCallId, toolCallId: start.toolCallId, reason: "human_input", payload: waiting.value }] },
    });
    expect(result.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(false);
    expect(result.some((event) => event.type === "RUN_ERROR")).toBe(false);
  });

  test("completed durable SSE replays after restart without storing or emitting capabilities", async () => {
    const directory = temp();
    const statePath = join(directory, "state.json");
    const first = bridge({ noTools: true, echoCapability: true }, { statePath, requireHostContext: true, token: "bridge-private-token" });
    const input = host();
    const original = await events(first.run(input));
    const rawState = readFileSync(statePath, "utf8");
    expect(rawState).not.toContain("private-capability");
    expect(rawState).not.toContain("bridge-private-token");
    expect(JSON.stringify(original)).not.toContain("private-capability");
    expect(rawState).not.toContain("toolGateway");
    await first.close();
    running.splice(running.findIndex((item) => item.server === first.server), 1);
    const second = bridge({}, { statePath, requireHostContext: true });
    expect(await post(second, input)).toEqual(original);
    expect(second.records()).toHaveLength(0);
    const next = host("next", "new-run");
    next.messages = [...input.messages, { id: "a", role: "assistant", content: "known answer" }, ...next.messages];
    expect((await post(second, next)).at(-1).type).toBe("RUN_FINISHED");
    expect(prompts(second)[0].params._meta.chisabot.history).toEqual([{ role: "user", content: "你好，Hermes" }, { role: "assistant", content: "known answer" }]);
  });

  test("a ledger record started before restart is unknown and must never reprompt", async () => {
    const directory = temp();
    const statePath = join(directory, "state.json");
    const created = bridge({ noTools: true }, { statePath, requireHostContext: true });
    const input = host();
    await post(created, input);
    await created.close();
    running.splice(running.findIndex((item) => item.server === created.server), 1);
    const ledger = JSON.parse(readFileSync(statePath, "utf8"));
    ledger.runs[0].status = "started";
    ledger.runs[0].events = [];
    writeFileSync(statePath, JSON.stringify(ledger));
    const recovered = bridge({}, { statePath, requireHostContext: true });
    expect((await post(recovered, input)).at(-1).code).toBe("ACP_RUN_UNKNOWN");
    const extension = structuredClone(input);
    extension.messages.push({ id: "a", role: "assistant", content: "guess" }, { id: "next", role: "user", content: "again" });
    expect((await post(recovered, extension)).at(-1).code).toBe("ACP_RUN_UNKNOWN");
    expect(recovered.records()).toHaveLength(0);
  });

  test("failed atomic ledger writes block prompt and report unhealthy state", async () => {
    const directory = temp();
    const blockingFile = join(directory, "not-a-directory");
    writeFileSync(blockingFile, "block");
    // A regular file cannot be the ledger's parent directory.
    const invalidStatePath = join(blockingFile, "state.json");
    const blocked = bridge({ noTools: true }, { statePath: invalidStatePath, requireHostContext: true });
    const result = await post(blocked, host());
    expect(result.at(-1).code).toBe("ACP_STATE_ERROR");
    expect(prompts(blocked)).toHaveLength(0);
    expect(await health(blocked)).toMatchObject({ ok: false, stateHealthy: false });
    expect((await post(blocked, host("second", "second-run"))).at(-1).code).toBe("ACP_STATE_ERROR");
    expect(prompts(blocked)).toHaveLength(0);
  });

  test("health is honest before initialize and never returns command, gateway or token", async () => {
    const created = bridge({ noTools: true }, { token: "health-private-token" });
    expect(await health(created)).toMatchObject({ ok: false, healthy: false, initialized: false, sessions: 0, queuedScopes: 0 });
    await events(created.run(host()));
    const state = await health(created);
    expect(state).toMatchObject({ ok: true, healthy: true, initialized: true, sessions: 1, queuedScopes: 0 });
    expect(state.command).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("private");
    const refused = await fetch(`${created.url}/ag-ui`, { method: "POST", body: JSON.stringify(host()) });
    expect(refused.status).toBe(401);
  });

  test("authenticated readiness initializes without opening a session or prompting", async () => {
    const created = bridge({}, { token: "ready-token", requireHostContext: true, statePath: join(temp(), "state.json") });
    expect((await health(created)).ok).toBe(false);
    expect((await fetch(`${created.url}/ready`, { method: "POST" })).status).toBe(401);
    expect(created.records()).toHaveLength(0);
    const ready = await fetch(`${created.url}/ready`, { method: "POST", headers: { authorization: "Bearer ready-token" } });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, healthy: true, initialized: true, hostTools: true, sessions: 0, runRecords: 0 });
    expect(prompts(created)).toHaveLength(0);
    expect(sessions(created)).toHaveLength(0);
    await fetch(`${created.url}/ready`, { method: "POST", headers: { authorization: "Bearer ready-token" } });
    expect(created.records().filter((item) => item.type === "initialize")).toHaveLength(1);
    expect((await health(created)).ok).toBe(true);
    const unguarded = bridge();
    expect((await fetch(`${unguarded.url}/ready`, { method: "POST" })).status).toBe(401);
  });

  test("readiness failure stays unhealthy and the next readiness request can restart", async () => {
    const created = bridge({}, { token: "ready-token", command: [join(temp(), "not-found.exe")] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ready = await fetch(`${created.url}/ready`, { method: "POST", headers: { authorization: "Bearer ready-token" } });
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ ok: false, healthy: false, initialized: false, generation: attempt + 1 });
    }
  });

  test("empty input and corrupt durable state fail closed", async () => {
    const created = bridge();
    expect((await post(created, { threadId: "t", runId: "r", messages: [] })).at(-1).code).toBe("ACP_EMPTY_PROMPT");
    const statePath = join(temp(), "bad.json");
    writeFileSync(statePath, "not json");
    expect(() => createAcpBridge({ statePath, port: 0 })).toThrow("refusing unsafe recovery");
  });
});
