import { describe, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/client";
import { Hono } from "hono";
import { z } from "zod";
import {
  createRuntimeToolRegistry,
  createRuntimeToolsRoutes,
  type RuntimeToolRegistration,
} from "../src/agents/runtime-tools";
import { currentApprovalContext } from "../src/approvals/types";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import {
  currentConfirmActor,
  currentConfirmToolCall,
  currentConfirmTurn,
  currentToolAbort,
  withConfirmActor,
  withConfirmToolCall,
  withConfirmTurn,
  withToolAbort,
} from "../src/confirmations/context";
import type { GrantedTool } from "../src/plugins/tools";

const name = "mcp__vendor__write";
const args = { value: "actual" };
function assistant(callId = "call-1", toolName = name, argumentsJson = JSON.stringify(args)): Message {
  return {
    id: `assistant:${callId}`,
    role: "assistant",
    toolCalls: [{ id: callId, type: "function", function: { name: toolName, arguments: argumentsJson } }],
  };
}
function input(messages: Message[] = [assistant()]): RunAgentInput {
  return {
    runId: "real-run",
    threadId: "real-thread",
    messages: [{ id: "user", role: "user", content: "Write actual" }, ...messages],
    tools: [],
    state: { initial: true },
    context: [{ description: "Real run context", value: "canonical" }],
    forwardedProps: { openbotRun: "signed-real-run" },
  };
}
function tool(overrides: Partial<GrantedTool> = {}): GrantedTool {
  return {
    name,
    ref: "vendor/write",
    description: "Write the supplied value",
    parameters: z.object({ value: z.string().min(1) }).strict(),
    execute: async () => "written",
    ...overrides,
  };
}
function fixture(overrides: Partial<RuntimeToolRegistration> = {}) {
  const registry = createRuntimeToolRegistry();
  const run = registry.register({
    input: input(),
    scope: { actorId: "real-actor", botId: "real-bot" },
    tools: [tool()],
    ...overrides,
  });
  const app = new Hono().route("/api/internal/runtime-tools", createRuntimeToolsRoutes(registry));
  const request = (path: string, body?: unknown, capability: string | null = run.capability) => app.request(
    `/api/internal/runtime-tools${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(capability === null ? {} : { Authorization: `Bearer ${capability}` }),
      },
      body: JSON.stringify(body ?? {}),
    },
  );
  return { registry, run, app, request };
}

async function tick() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("runtime tool run", () => {
  test("mints opaque per-run capabilities and lists only assembled tools with input schemas", async () => {
    const registry = createRuntimeToolRegistry();
    const options = { input: input(), scope: { actorId: "real-actor", botId: "real-bot" }, tools: [tool()] };
    const first = registry.register(options);
    const second = registry.register(options);
    try {
      expect(first.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.capability).not.toBe(first.capability);
      expect(first.capability).not.toContain("real-");
      expect(registry.get(first.capability)).toBe(first);
      expect(registry.get("unknown")).toBeUndefined();
      expect(first.list()).toMatchObject([{
        name,
        description: "Write the supplied value",
        inputSchema: { type: "object", properties: { value: { type: "string", minLength: 1 } }, required: ["value"] },
      }]);
      const exported = first.list();
      exported[0]!.name = "forged";
      expect(first.list()[0]!.name).toBe(name);
      options.scope.actorId = "forged";
      options.input.runId = "forged";
      expect(first.scope).toEqual({ actorId: "real-actor", botId: "real-bot" });
      expect(first.snapshot.runId).toBe("real-run");
    } finally { first.close(); second.close(); }
  });

  test("executes assembled handlers in actual isolated ALS contexts across awaits", async () => {
    let observed: {
      turn: ReturnType<typeof currentConfirmTurn>;
      call: ReturnType<typeof currentConfirmToolCall>;
      actor: ReturnType<typeof currentConfirmActor>;
      signal: ReturnType<typeof currentToolAbort>;
      approval: ReturnType<typeof currentApprovalContext>;
    } | undefined;
    const outerSignal = new AbortController().signal;
    const latest = [...input().messages, { id: "steer", role: "user" as const, content: "Latest instruction" }];
    const f = fixture({
      initiator: { kind: "routine", id: "schedule:real" },
      tools: [tool({ execute: async (received, context) => {
        await Promise.resolve();
        observed = {
          turn: currentConfirmTurn(), call: currentConfirmToolCall(), actor: currentConfirmActor(),
          signal: currentToolAbort(), approval: currentApprovalContext(),
        };
        expect(received).toEqual(args);
        expect(context?.signal).toBe(observed.signal);
        expect(observed.turn?.stopped()).toBe(false);
        return "wrapped handler result";
      } })],
    });
    f.run.updateMessages(latest);
    f.run.updateState({ latest: "provider-state" });
    try {
      await withConfirmTurn({ runId: "wrong", threadId: "wrong", stopped: () => true }, () =>
        withConfirmToolCall("wrong-call", "wrong-tool", () => withToolAbort(outerSignal, () =>
          withConfirmActor({ kind: "deployment" }, async () => {
            expect(await f.run.execute("call-1", name, args)).toBe("wrapped handler result");
            expect(currentConfirmTurn()?.runId).toBe("wrong");
            expect(currentConfirmToolCall()?.toolCallId).toBe("wrong-call");
            expect(currentToolAbort()).toBe(outerSignal);
          }),
        )),
      );
      expect(observed?.turn).toMatchObject({ runId: "real-run", threadId: "real-thread" });
      expect(observed?.call).toEqual({ toolCallId: "call-1", toolName: name });
      expect(observed?.actor).toEqual({ initiator: { kind: "routine", id: "schedule:real" } });
      expect(observed?.approval).toEqual({
        runId: "real-run", threadId: "real-thread", toolCallId: "call-1", toolName: name, args,
        messages: latest, state: { latest: "provider-state" }, context: input().context,
        forwardedProps: input().forwardedProps, initiator: { kind: "routine", id: "schedule:real" },
      });
      expect(currentApprovalContext()).toBeUndefined();
      expect(currentConfirmTurn()).toBeUndefined();
      expect(f.run.snapshot.messages.some((message) => message.role === "tool")).toBe(false);
    } finally { f.run.close(); }
  });

  test("tool initiator retains precedence over registration initiator", async () => {
    const f = fixture({
      initiator: { kind: "routine", id: "parent" },
      tools: [tool({ initiator: { kind: "handoff", id: "real-handoff" }, execute: async () => {
        expect(currentConfirmActor()?.initiator).toEqual({ kind: "handoff", id: "real-handoff" });
        expect(currentApprovalContext()?.initiator).toEqual({ kind: "handoff", id: "real-handoff" });
        return "ok";
      } })],
    });
    try { expect(await f.run.execute("call-1", name, args)).toBe("ok"); }
    finally { f.run.close(); }
  });

  test("dedupes nested canonical arguments to the identical pending and completed Promise", async () => {
    let executions = 0;
    const result = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const original = { nested: { b: 2, a: 1 }, list: [1, { z: true, a: null }] };
    const expected = structuredClone(original);
    const equivalent = { list: [1, { a: null, z: true }], nested: { a: 1, b: 2 } };
    const f = fixture({
      input: input([assistant("call-1", name, JSON.stringify(original))]),
      tools: [tool({ parameters: z.object({}).catchall(z.unknown()), execute: async (received) => {
        executions++;
        expect(received).toEqual(expected);
        started.resolve();
        return result.promise;
      } })],
    });
    try {
      const first = f.run.execute("call-1", name, original);
      expect(f.run.execute("call-1", name, equivalent)).toBe(first);
      original.nested.a = 999;
      await started.promise;
      expect(executions).toBe(1);
      result.resolve("once");
      expect(await first).toBe("once");
      expect(f.run.execute("call-1", name, equivalent)).toBe(first);
      expect(await f.run.execute("call-1", name, equivalent)).toBe("once");
      expect(executions).toBe(1);
    } finally { f.run.close(); }
  });

  test("dedupes rejected executions without replacing their error", async () => {
    const failure = new Error("vendor failure");
    let executions = 0;
    const f = fixture({ tools: [tool({ execute: async () => { executions++; throw failure; } })] });
    try {
      const first = f.run.execute("call-1", name, args);
      expect(await first.catch((error) => error)).toBe(failure);
      expect(f.run.execute("call-1", name, args)).toBe(first);
      expect(await first.catch((error) => error)).toBe(failure);
      expect(executions).toBe(1);
    } finally { f.run.close(); }
  });

  test("rejects reused call ids with changed name or arguments", async () => {
    let executions = 0;
    const f = fixture({ tools: [tool({ execute: async () => { executions++; return "once"; } }), tool({ name: "other" })] });
    try {
      const first = f.run.execute("call-1", name, args);
      await expect(f.run.execute("call-1", "other", args)).rejects.toMatchObject({ code: "call_conflict" });
      await expect(f.run.execute("call-1", name, { value: "different" })).rejects.toMatchObject({ code: "call_conflict" });
      expect(await first).toBe("once");
      expect(executions).toBe(1);
    } finally { f.run.close(); }
  });

  test("call ids are independent across runs", async () => {
    let executions = 0;
    const shared = tool({ execute: async () => String(++executions) });
    const registry = createRuntimeToolRegistry();
    const options = { input: input(), scope: { actorId: "actor", botId: "bot" }, tools: [shared] };
    const first = registry.register(options);
    const second = registry.register({ ...options, input: { ...input(), runId: "second-run" } });
    try {
      expect(await first.execute("call-1", name, args)).toBe("1");
      expect(await second.execute("call-1", name, args)).toBe("2");
    } finally { first.close(); second.close(); }
  });

  test("unknown tools and schema errors never reach the assembled handler", async () => {
    let executions = 0;
    const f = fixture({ tools: [tool({ execute: async () => { executions++; return "wrong"; } })] });
    try {
      await expect(f.run.execute("call-1", "ungranted", args)).rejects.toMatchObject({ code: "unknown_tool" });
      for (const invalid of [{}, { value: 42 }, { value: "" }, { value: "actual", unexpected: true }]) {
        await expect(f.run.execute(`invalid-${JSON.stringify(invalid)}`, name, invalid)).rejects.toMatchObject({ code: "invalid_arguments" });
      }
      await expect(f.run.execute("", name, args)).rejects.toMatchObject({ code: "invalid_call" });
      await expect(f.run.execute("bad-json", name, { value: undefined })).rejects.toMatchObject({ code: "invalid_arguments" });
      expect(executions).toBe(0);
      // An unknown tool did not reserve this call id.
      expect(await f.run.execute("call-1", name, args)).toBe("wrong");
      expect(executions).toBe(1);
    } finally { f.run.close(); }
  });

  test("waits for captured messages and complete arguments when callbacks arrive first", async () => {
    let executions = 0;
    const f = fixture({ input: input([]), tools: [tool({ execute: async () => { executions++; return "captured"; } })] });
    try {
      const result = f.run.execute("call-1", name, args);
      await tick();
      expect(executions).toBe(0);
      expect(f.run.snapshot.messages).toEqual(input([]).messages);
      f.run.updateMessages(input([assistant("call-1", name, '{"value":')]).messages);
      await tick();
      expect(executions).toBe(0);
      f.run.updateMessages(input([assistant()]).messages);
      expect(await result).toBe("captured");
      expect(executions).toBe(1);
    } finally { f.run.close(); }
  });

  test("handles differently ordered callback and capture updates by matching real call ids", async () => {
    const executed: string[] = [];
    const f = fixture({ input: input([]), tools: [tool({ execute: async () => {
      executed.push(currentConfirmToolCall()!.toolCallId); return "ok";
    } })] });
    try {
      const first = f.run.execute("call-1", name, args);
      const second = f.run.execute("call-2", name, args);
      await tick();
      f.run.updateMessages(input([assistant("call-2")]).messages);
      expect(await second).toBe("ok");
      expect(executed).toEqual(["call-2"]);
      f.run.updateMessages(input([assistant("call-2"), assistant("call-1")]).messages);
      expect(await first).toBe("ok");
      expect(executed).toEqual(["call-2", "call-1"]);
    } finally { f.run.close(); }
  });

  test.each([
    ["wrong name", [assistant("call-1", "other")]],
    ["wrong arguments", [assistant("call-1", name, '{"value":"other"}')]],
    ["duplicate id", [assistant(), assistant()]],
    ["already answered", [assistant(), { id: "answer", role: "tool", toolCallId: "call-1", content: "already executed" }]],
  ] as [string, Message[]][]) ("rejects captured call conflicts: %s", async (_label, messages) => {
    let executions = 0;
    const f = fixture({ input: input(messages), tools: [tool({ execute: async () => { executions++; return "wrong"; } })] });
    try {
      await expect(f.run.execute("call-1", name, args)).rejects.toMatchObject({ code: "call_conflict" });
      expect(executions).toBe(0);
    } finally { f.run.close(); }
  });

  test("missing captures time out without inventing calls or tool results", async () => {
    let executions = 0;
    const f = fixture({ input: input([]), callCaptureTimeoutMs: 10, tools: [tool({ execute: async () => { executions++; return "wrong"; } })] });
    try {
      await expect(f.run.execute("call-1", name, args)).rejects.toMatchObject({ code: "call_capture_timeout" });
      expect(f.run.snapshot.messages).toEqual(input([]).messages);
      expect(executions).toBe(0);
    } finally { f.run.close(); }
  });

  test.each(["close", "abort"] as const)("%s wakes capture waiters, revokes capability and prevents new calls", async (action) => {
    let executions = 0;
    const controller = new AbortController();
    const f = fixture({ input: input([]), signal: controller.signal, tools: [tool({ execute: async () => { executions++; return "wrong"; } })] });
    const pending = f.run.execute("call-1", name, args);
    const rejected = pending.catch((error) => error);
    await tick();
    if (action === "close") f.run.close(); else controller.abort("user stopped");
    expect(await rejected).toMatchObject({ code: action === "close" ? "run_closed" : "run_aborted" });
    expect(f.registry.get(f.run.capability)).toBeUndefined();
    await expect(f.run.execute("call-2", name, args)).rejects.toMatchObject({ code: action === "close" ? "run_closed" : "run_aborted" });
    expect(executions).toBe(0);
    f.run.close();
  });

  test.each(["close", "abort"] as const)("%s reaches the running handler through explicit and ALS signals", async (action) => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let runningSignal: AbortSignal | undefined;
    let stopped: (() => boolean) | undefined;
    const f = fixture({ signal: controller.signal, tools: [tool({ execute: async (_args, context) => {
      runningSignal = context?.signal;
      expect(currentToolAbort()).toBe(runningSignal);
      stopped = currentConfirmTurn()?.stopped;
      started.resolve();
      await new Promise<void>((resolve) => runningSignal!.addEventListener("abort", () => resolve(), { once: true }));
      expect(currentToolAbort()?.aborted).toBe(true);
      return "aborted";
    } })] });
    const result = f.run.execute("call-1", name, args);
    await started.promise;
    expect(stopped?.()).toBe(false);
    if (action === "close") f.run.close(); else controller.abort("real reason");
    expect(runningSignal?.aborted).toBe(true);
    expect(stopped?.()).toBe(true);
    if (action === "abort") expect(runningSignal?.reason).toBe("real reason");
    expect(await result).toBe("aborted");
    f.run.close();
  });

  test("an already aborted run and immediate close never start a handler", async () => {
    let executions = 0;
    const controller = new AbortController();
    controller.abort();
    const f = fixture({ signal: controller.signal, tools: [tool({ execute: async () => { executions++; return "wrong"; } })] });
    expect(f.registry.get(f.run.capability)).toBeUndefined();
    await expect(f.run.execute("call-1", name, args)).rejects.toMatchObject({ code: "run_aborted" });
    const active = fixture({ tools: [tool({ execute: async () => { executions++; return "wrong"; } })] });
    const pending = active.run.execute("call-1", name, args);
    active.run.close();
    await expect(pending).rejects.toMatchObject({ code: "run_closed" });
    expect(executions).toBe(0);
  });

  test("retains suspension error, waiting metadata and real continuation; latches the run", async () => {
    let executions = 0;
    const suspension = new HeadlessToolSuspension("Waiting for your approval", { kind: "approval", requestId: "real-request", custom: { safe: true } });
    const f = fixture({ tools: [tool({ execute: async () => { executions++; throw suspension; } })] });
    try {
      const pending = f.run.execute("uncaptured", name, args);
      const pendingFailure = pending.catch((error) => error);
      await tick();
      const first = f.run.execute("call-1", name, args);
      expect(await first.catch((error) => error)).toBe(suspension);
      expect(f.run.execute("call-1", name, args)).toBe(first);
      expect(await pendingFailure).toBe(suspension);
      expect(await f.run.execute("call-3", name, args).catch((error) => error)).toBe(suspension);
      expect(executions).toBe(1);
      expect(suspension.waiting).toMatchObject({ kind: "approval", requestId: "real-request", custom: { safe: true }, continuation: {
        runId: "real-run", threadId: "real-thread", toolCallId: "call-1", toolName: name,
        args, messages: input().messages, state: input().state, context: input().context, forwardedProps: input().forwardedProps,
      } });
      expect(f.run.snapshot.messages.some((message) => message.role === "tool")).toBe(false);
    } finally { f.run.close(); }
  });

  test("preserves existing suspension continuation metadata", async () => {
    const existing = { already: "provided" };
    const suspension = new HeadlessToolSuspension("Wait", { kind: "handoff", continuation: existing });
    const f = fixture({ tools: [tool({ execute: async () => { throw suspension; } })] });
    try {
      expect(await f.run.execute("call-1", name, args).catch((error) => error)).toBe(suspension);
      expect(suspension.waiting.continuation).toBe(existing);
    } finally { f.run.close(); }
  });

  test("claims mid-turn steerSession messages after tool execution and appends notice to result", async () => {
    const injected: Array<{ ids: string[]; afterToolCallIds: string[] }> = [];
    const midTurnMsg = { id: "mid-1", role: "user" as const, content: "另外顺便帮我查一下明天的天气" };
    let queue = [midTurnMsg];
    const f = fixture({
      steerSession: {
        claim: () => {
          const taken = queue;
          queue = [];
          return taken;
        },
        onInjected: (messages, afterToolCallIds) => {
          injected.push({ ids: messages.map((m) => m.id), afterToolCallIds });
        },
      },
    });
    try {
      const res = await f.run.execute("call-1", name, args);
      expect(typeof res).toBe("string");
      expect(String(res)).toContain("written");
      expect(String(res)).toContain("另外顺便帮我查一下明天的天气");
      expect(String(res)).toContain("新的独立需求");
      expect(injected).toEqual([{ ids: ["mid-1"], afterToolCallIds: ["call-1"] }]);
    } finally {
      f.run.close();
    }
  });
});

describe("runtime tool HTTP helper", () => {
  test("lists and calls with bearer capability; forged body identity cannot alter server scope", async () => {
    let executions = 0;
    const scoped = { actorId: "real-actor", botId: "real-bot" };
    const f = fixture({ scope: scoped, tools: [tool({ execute: async () => {
      executions++;
      expect(currentConfirmTurn()).toMatchObject({ runId: "real-run", threadId: "real-thread" });
      expect(currentConfirmToolCall()).toEqual({ toolCallId: "call-1", toolName: name });
      expect(currentApprovalContext()?.forwardedProps).toEqual({ openbotRun: "signed-real-run" });
      return `${scoped.actorId}/${scoped.botId}`;
    } })] });
    try {
      const listed = await f.request("/tools/list", { actorId: "evil", botId: "evil" });
      expect(listed.status).toBe(200);
      expect(listed.headers.get("Cache-Control")).toBe("no-store");
      expect((await listed.json()).tools[0].name).toBe(name);
      const response = await f.request("/tools/call", {
        callId: "call-1", name, args, actorId: "evil", botId: "evil", runId: "evil", threadId: "evil",
        scope: { actorId: "evil", botId: "evil" }, messages: [], state: { evil: true }, forwardedProps: { evil: true },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: "real-actor/real-bot" });
      expect(f.run.scope).toEqual(scoped);
      expect(executions).toBe(1);
    } finally { f.run.close(); }
  });

  test("rejects missing or unknown bearer capabilities even if the body contains a valid token", async () => {
    let executions = 0;
    const f = fixture({ tools: [tool({ execute: async () => { executions++; return "wrong"; } })] });
    try {
      for (const capability of [null, "invalid"]) {
        const response = await f.request("/tools/call", { capability: f.run.capability, callId: "call-1", name, args }, capability);
        expect(response.status).toBe(401);
        expect((await response.json()).error.code).toBe("invalid_capability");
      }
      f.run.close();
      expect((await f.request("/tools/list")).status).toBe(401);
      expect(executions).toBe(0);
    } finally { f.run.close(); }
  });

  test("returns distinct unknown, schema and conflict errors and rejects malformed bodies", async () => {
    const f = fixture();
    try {
      expect((await f.request("/tools/call", { callId: "unknown", name: "unknown", args })).status).toBe(404);
      const invalid = await f.request("/tools/call", { callId: "invalid", name, args: { value: 42 } });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.code).toBe("invalid_arguments");
      expect((await f.request("/tools/call", { callId: "call-1", name, args })).status).toBe(200);
      const conflict = await f.request("/tools/call", { callId: "call-1", name, args: { value: "different" } });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).error.code).toBe("call_conflict");
      expect((await f.request("/tools/call", { callId: 123, name, args })).status).toBe(400);
      expect((await f.request("/tools/call", [])).status).toBe(400);
      const malformed = await f.app.request("/api/internal/runtime-tools/tools/call", { method: "POST", headers: { Authorization: `Bearer ${f.run.capability}` }, body: "{" });
      expect(malformed.status).toBe(400);
    } finally { f.run.close(); }
  });

  test("returns original waiting metadata as 409 and blocks subsequent calls", async () => {
    let executions = 0;
    const suspension = new HeadlessToolSuspension("Approve the real action", { kind: "approval", requestId: "request-id", extra: "kept" });
    const f = fixture({ tools: [tool({ execute: async () => { executions++; throw suspension; } })] });
    try {
      const first = await f.request("/tools/call", { callId: "call-1", name, args });
      expect(first.status).toBe(409);
      const body = await first.json();
      expect(body).toEqual({ error: { code: "tool_suspended", message: suspension.message }, waiting: suspension.waiting });
      expect(body).not.toHaveProperty("result");
      expect(body.waiting.continuation.messages.some((message: Message) => message.role === "tool")).toBe(false);
      const blocked = await f.request("/tools/call", { callId: "call-2", name, args });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual(body);
      expect(executions).toBe(1);
    } finally { f.run.close(); }
  });
});
