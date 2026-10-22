import { randomBytes } from "node:crypto";
import type { Message, RunAgentInput } from "@ag-ui/client";
import { Hono } from "hono";
import { z } from "zod";
import {
  type ApprovalContinuation,
  withApprovalContext,
} from "../approvals/types";
import type { AuditInitiator } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import {
  withConfirmActor,
  withConfirmToolCall,
  withConfirmTurn,
  withToolAbort,
} from "../confirmations/context";
import type { GrantedTool } from "../plugins/tools";

export type RuntimeToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type RuntimeToolScope = Readonly<{ actorId: string; botId: string }>;
export type RuntimeToolRegistration = {
  input: RunAgentInput;
  tools: readonly GrantedTool[];
  scope: RuntimeToolScope;
  signal?: AbortSignal;
  initiator?: AuditInitiator;
  /** Defaults to 3 seconds, capped at 5 seconds. */
  callCaptureTimeoutMs?: number;
};
export type RuntimeToolRun = {
  readonly capability: string;
  readonly scope: RuntimeToolScope;
  readonly snapshot: RunAgentInput;
  list(): RuntimeToolDefinition[];
  execute(callId: string, name: string, args: unknown): Promise<string>;
  updateMessages(messages: Message[]): void;
  updateState(state: unknown): void;
  close(): void;
};

type RuntimeToolErrorCode =
  | "invalid_call"
  | "invalid_arguments"
  | "unknown_tool"
  | "call_conflict"
  | "call_capture_timeout"
  | "run_closed"
  | "run_aborted";

export class RuntimeToolError extends Error {
  constructor(
    readonly code: RuntimeToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeToolError";
  }
}

/** Only JSON values participate in call identity; object key order does not. */
function canonical(value: unknown, parents = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (
      !parents.has(value) &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      (Array.isArray(value) || prototype === Object.prototype || prototype === null)
    ) {
      parents.add(value);
      try {
        if (Array.isArray(value))
          return `[${Array.from(value, (entry) => canonical(entry, parents)).join(",")}]`;
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(object[key], parents)}`)
          .join(",")}}`;
      } finally {
        parents.delete(value);
      }
    }
  }
  throw new RuntimeToolError("invalid_arguments", "Tool arguments must be JSON values.");
}

/** False means absent or still streaming; an existing conflicting call is never replaced. */
function capturedCall(
  messages: Message[],
  callId: string,
  name: string,
  args: string,
): boolean {
  const calls = messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).filter((call) => call.id === callId)
      : [],
  );
  if (
    calls.length > 1 ||
    messages.some((message) => message.role === "tool" && message.toolCallId === callId)
  )
    throw new RuntimeToolError("call_conflict", "The tool call is ambiguous or already answered.");
  const call = calls[0];
  if (!call) return false;
  if (call.function.name !== name)
    throw new RuntimeToolError("call_conflict", "The tool name does not match the captured call.");
  let captured: unknown;
  try {
    captured = JSON.parse(call.function.arguments);
  } catch {
    return false;
  }
  if (canonical(captured) !== args)
    throw new RuntimeToolError("call_conflict", "The arguments do not match the captured call.");
  return true;
}

/** A capability owns one assembled tool set and one run. It contains no caller-supplied identity. */
export function createRuntimeToolRegistry() {
  const runs = new Map<string, RuntimeToolRun>();

  function register(options: RuntimeToolRegistration): RuntimeToolRun {
    if (
      ![options.scope.actorId, options.scope.botId, options.input.runId, options.input.threadId]
        .every((value) => typeof value === "string" && value.trim())
    )
      throw new RuntimeToolError("invalid_call", "A run, thread, actor and Bot are required.");
    const timeout = options.callCaptureTimeoutMs ?? 3_000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new RuntimeToolError("invalid_call", "The call capture timeout must be positive.");
    const tools = new Map<string, GrantedTool>();
    for (const tool of options.tools) {
      if (!tool.name.trim() || tools.has(tool.name))
        throw new RuntimeToolError("invalid_call", "Runtime tool names must be nonempty and unique.");
      tools.set(tool.name, { ...tool });
    }
    const definitions = [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.parameters, { io: "input" }) as Record<string, unknown>,
    }));
    const scope = Object.freeze({ actorId: options.scope.actorId, botId: options.scope.botId });
    const initiator = options.initiator ? structuredClone(options.initiator) : undefined;
    const capability = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    const updates = new Set<() => void>();
    const calls = new Map<string, { name: string; args: string; promise: Promise<string> }>();
    let snapshot = structuredClone(options.input);
    let ended: "run_closed" | "run_aborted" | undefined;
    let suspended: HeadlessToolSuspension | undefined;
    const turn = {
      runId: snapshot.runId,
      threadId: snapshot.threadId,
      stopped: () => controller.signal.aborted,
    };
    const assertActive = () => {
      if (ended)
        throw new RuntimeToolError(ended, ended === "run_closed"
          ? "The runtime tool run is closed."
          : "The runtime tool run was aborted.");
    };
    const end = (code: "run_closed" | "run_aborted", reason?: unknown) => {
      if (ended) return;
      ended = code;
      runs.delete(capability);
      options.signal?.removeEventListener("abort", onAbort);
      controller.abort(reason);
    };
    const onAbort = () => end("run_aborted", options.signal?.reason);

    const assertExecutable = () => {
      assertActive();
      if (suspended) throw suspended;
    };
    const waitForCapture = (callId: string, name: string, args: string) => {
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          updates.delete(check);
          controller.signal.removeEventListener("abort", check);
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          try {
            assertExecutable();
            if (capturedCall(snapshot.messages, callId, name, args)) finish();
          } catch (error) {
            finish(error);
          }
        };
        const timer = setTimeout(() => finish(new RuntimeToolError(
          "call_capture_timeout", "The assistant tool call was not captured before the timeout.",
        )), Math.min(timeout, 5_000));
        updates.add(check);
        controller.signal.addEventListener("abort", check, { once: true });
        check();
      });
    };

    const invoke = async (tool: GrantedTool, callId: string, name: string, argsJson: string) => {
      assertExecutable();
      const args: unknown = JSON.parse(argsJson);
      const parsed = await tool.parameters.safeParseAsync(args);
      if (!parsed.success)
        throw new RuntimeToolError("invalid_arguments", "Tool arguments do not match the tool schema.");
      await waitForCapture(callId, name, argsJson);
      assertExecutable();
      const input = structuredClone(snapshot);
      if (!capturedCall(input.messages, callId, name, argsJson))
        throw new RuntimeToolError("call_conflict", "The captured assistant tool call is unavailable.");
      const actor = tool.initiator ?? initiator;
      const continuation: ApprovalContinuation = {
        runId: input.runId,
        threadId: input.threadId,
        toolCallId: callId,
        toolName: name,
        args,
        messages: input.messages,
        state: input.state,
        context: input.context,
        forwardedProps: input.forwardedProps,
        ...(actor ? { initiator: actor } : {}),
      };
      return withConfirmTurn(turn, () => withConfirmToolCall(callId, name, () =>
        withToolAbort(controller.signal, () => withConfirmActor(actor, () =>
          withApprovalContext(continuation, async () => {
            try {
              // Validation must not rewrite the model's call: tools may already parse or be wrapped
              // by confirmations, and approval reentry compares against the original arguments.
              return await tool.execute(args, { signal: controller.signal });
            } catch (error) {
              if (error instanceof HeadlessToolSuspension) {
                error.waiting.continuation ??= continuation;
                suspended ??= error;
                for (const update of [...updates]) update();
              }
              throw error;
            }
          }),
        )),
      ));
    };

    const run: RuntimeToolRun = {
      capability,
      scope,
      get snapshot() { return structuredClone(snapshot); },
      list() { assertActive(); return structuredClone(definitions); },
      // Deliberately not async: a replay returns the identical Promise, including rejected results.
      execute(callId, name, args) {
        try {
          if (![callId, name].every((value) => typeof value === "string" && value.trim()))
            throw new RuntimeToolError("invalid_call", "A tool call id and name are required.");
          const argsJson = canonical(args);
          const previous = calls.get(callId);
          if (previous) {
            if (previous.name !== name || previous.args !== argsJson)
              throw new RuntimeToolError("call_conflict", "The tool call id was already used for a different call.");
            return previous.promise;
          }
          assertExecutable();
          const tool = tools.get(name);
          if (!tool)
            throw new RuntimeToolError("unknown_tool", "The tool is not available in this run.");
          const promise = Promise.resolve().then(() => invoke(tool, callId, name, argsJson));
          calls.set(callId, { name, args: argsJson, promise });
          return promise;
        } catch (error) {
          return Promise.reject(error);
        }
      },
      updateMessages(messages) {
        assertActive();
        snapshot = { ...snapshot, messages: structuredClone(messages) };
        for (const update of [...updates]) update();
      },
      updateState(state) {
        assertActive();
        snapshot = { ...snapshot, state: structuredClone(state) };
      },
      close() { end("run_closed"); },
    };
    runs.set(capability, run);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    return run;
  }

  return { register, get: (capability: string) => runs.get(capability) };
}
export type RuntimeToolRegistry = ReturnType<typeof createRuntimeToolRegistry>;

/** Mount at /api/internal/runtime-tools. The host bridge can translate this JSON API to MCP. */
export function createRuntimeToolsRoutes(registry: RuntimeToolRegistry) {
  const routes = new Hono<{ Variables: { runtimeToolRun: RuntimeToolRun } }>();
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const capability = /^Bearer\s+(\S+)$/i.exec(context.req.header("authorization") ?? "")?.[1];
    const run = capability ? registry.get(capability) : undefined;
    if (!run) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: { code: "invalid_capability", message: "A valid runtime capability is required." } }, 401);
    }
    context.set("runtimeToolRun", run);
    await next();
  });
  routes.onError((error, context) => {
    if (error instanceof HeadlessToolSuspension)
      return context.json({ error: { code: "tool_suspended", message: error.message }, waiting: error.waiting }, 409);
    if (error instanceof RuntimeToolError) {
      const status = error.code === "unknown_tool" ? 404
        : error.code === "run_closed" || error.code === "run_aborted" ? 410
        : error.code === "call_conflict" || error.code === "call_capture_timeout" ? 409 : 400;
      return context.json({ error: { code: error.code, message: error.message } }, status);
    }
    return context.json({ error: { code: "tool_failed", message: error.message } }, 500);
  });
  routes.get("/tools/list", (context) => context.json({ tools: context.var.runtimeToolRun.list() }));
  routes.post("/tools/list", (context) => context.json({ tools: context.var.runtimeToolRun.list() }));
  routes.post("/tools/call", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new RuntimeToolError("invalid_call", "A JSON tool call is required.");
    // Only these three fields are read. Identity and continuation are held by the registered run.
    const { callId, name, args = {} } = body as Record<string, unknown>;
    const result = await context.var.runtimeToolRun.execute(callId as string, name as string, args);
    return context.json({ result });
  });
  return routes;
}
