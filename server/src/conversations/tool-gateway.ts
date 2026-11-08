import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RunAgentInput, Message } from "@ag-ui/client";
import { Hono } from "hono";
import { z } from "zod";
import type { RuntimeToolIdentity } from "../../../shared/conversations";
import { withApprovalContext, type ApprovalContinuation } from "../approvals/types";
import type { AuditInitiator } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import { withConfirmActor, withConfirmToolCall, withConfirmTurn, withToolAbort, withDurableConfirmation } from "../confirmations/context";
import type { GrantedTool } from "../plugins/tools";
import type { ToolOperationStore, ToolOperationResult } from "./tool-operations";
import type { SteerSession } from "../thread-inbox";
import type { DshRunJournal } from "./run-journal";
import { assertConversationAdmissionOpen, ConversationMaintenanceError } from "./maintenance";
import type { DshHostClient } from "../../../runtime/dsh/src/client.mjs";

const Call = z.object({
  binding: z.object({ sessionId: z.string(), runId: z.string(), threadId: z.string(), botId: z.string(), actorId: z.string(), revision: z.number().int(), generation: z.string() }),
  callId: z.string().min(1), name: z.string().min(1), args: z.unknown(),
  turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(),
  throughSeq: z.number().int().nonnegative(),
});

function unknownEffect(operationId: string, continuation: ApprovalContinuation): HeadlessToolSuspension {
  const message = "这一步可能已经执行，但结果尚待核对。执行已暂停，请先核对实际结果，再决定下一步。";
  return new HeadlessToolSuspension(message, { kind: "operation_unknown", requestId: operationId, message, continuation });
}

export type DshToolRegistration = {
  bindingId: string;
  identity: RuntimeToolIdentity;
  input: RunAgentInput;
  tools: readonly GrantedTool[];
  signal: AbortSignal;
  initiator?: AuditInitiator;
  steering?: SteerSession;
  prepareSteering?: (messages: Message[]) => Promise<{ messages: { id: string; content: Parameters<DshHostClient["prompt"]>[0]["content"] }[]; instructions: string[] }>;
  continuationMessages: (throughSeq: number) => Promise<Message[]>;
  modelProxy?: (body: unknown, signal: AbortSignal) => Promise<Response>;
};

/** Only the authenticated runtime owning this run can spend its captured executor set. */
export function createDshToolGateway(operations: ToolOperationStore, journal?: DshRunJournal) {
  const runs = new Map<string, DshToolRegistration>();
  const live = new Map<string, { call: string; runId: string; threadId: string; result: Promise<ToolOperationResult> }>();
  const steering = new Map<string, Promise<unknown>>();
  const suspendConfirmation = (operationId: string, continuation: ApprovalContinuation) => async (requestId: string): Promise<never> => {
    await operations.waitingForConfirmation(operationId, requestId);
    throw new HeadlessToolSuspension("等待你确认这一步。", { kind: "confirmation", requestId, continuation });
  };

  function register(registration: DshToolRegistration) {
    const capability = randomBytes(32).toString("base64url");
    const owned = { ...registration, identity: Object.freeze({ ...registration.identity }), tools: [...registration.tools] };
    const close = () => { runs.delete(capability); for (const key of steering.keys()) if (key.startsWith(`${capability}:`)) steering.delete(key); registration.signal.removeEventListener("abort", close); };
    runs.set(capability, owned);
    registration.signal.addEventListener("abort", close, { once: true });
    if (registration.signal.aborted) close();
    return { capability, close };
  }

  async function invoke(run: DshToolRegistration, input: z.infer<typeof Call>): Promise<ToolOperationResult> {
    run.signal.throwIfAborted();
    const refusal = await journal?.continuationRefusal(run.identity.threadId, run.identity.runId);
    if (refusal) throw new Error(refusal);
    const tool = run.tools.find(tool => tool.name === input.name);
    if (!tool) throw new Error("This tool was not granted to the run.");
    const parsed = await tool.parameters.safeParseAsync(input.args);
    if (!parsed.success) throw new Error("Tool arguments do not match the granted schema.");
    const initiator = tool.initiator ?? run.initiator;
    const turn = { threadId: run.identity.threadId, runId: run.identity.runId, stopped: () => run.signal.aborted };
    const toolCallId = `${run.identity.sessionId}:${input.turn}:${input.step}:${input.callId}`;
    const messages = await run.continuationMessages(input.throughSeq);
    if (!messages.some(message => message.role === "assistant" && message.toolCalls?.some(call => {
      if (call.id !== toolCallId || call.function.name !== input.name) return false;
      try { return isDeepStrictEqual(JSON.parse(call.function.arguments), input.args); }
      catch { return false; }
    }))) {
      throw new Error("The committed conversation does not contain this tool call.");
    }
    run.signal.throwIfAborted();
    const continuation = {
      ...run.input, state: run.input.state ?? {}, context: run.input.context ?? [], forwardedProps: run.input.forwardedProps ?? {},
      messages, toolCallId, toolName: input.name, args: input.args,
      ...(initiator ? { initiator } : {}),
    };
    const claim = await operations.claim({ ownerUserId: run.identity.actorId, bindingId: run.bindingId, sessionId: run.identity.sessionId,
      runId: run.identity.runId, callId: input.callId, turn: input.turn, step: input.step, name: input.name, args: input.args });
    if (claim.kind === "completed") return claim.result;
    if (claim.kind === "conflict") throw new Error("A different operation already owns this tool-call identity.");
    if (claim.kind === "pending") {
      if (claim.state === "dispatching") await operations.markOutcomeUnknown(claim.id);
      if (claim.state === "dispatching" || claim.state === "outcome_unknown") throw unknownEffect(claim.id, continuation);
      throw new Error(`Tool outcome requires reconciliation (${claim.state === "dispatching" ? "outcome_unknown" : claim.state}); it was not executed again.`);
    }
    try {
      run.signal.throwIfAborted();
      const content = await withConfirmTurn(turn, () => withConfirmToolCall(toolCallId, input.name, () =>
        withConfirmActor(initiator, () => withToolAbort(run.signal, () => withApprovalContext(continuation,
          () => withDurableConfirmation({ suspend: suspendConfirmation(claim.id, continuation) }, () => tool.execute(parsed.data, { signal: run.signal })))))));
      const result = { content };
      await operations.settle(claim.id, "completed", result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed.";
      if (error instanceof HeadlessToolSuspension) {
        error.waiting.continuation ??= continuation;
        await operations.settle(claim.id, "waiting_approval", { content: "Waiting for a decision.", error: message });
        throw error;
      }
      // A thrown executor may already have changed an external system. Preserve that uncertainty.
      await operations.settle(claim.id, "outcome_unknown", { content: "The tool outcome must be checked before retrying.", error: message });
      throw unknownEffect(claim.id, continuation);
    }
  }

  const routes = new Hono();
  routes.on("POST", ["/model/v1/chat/completions", "/model/v1/messages"], async context => {
    const token = /^Bearer\s+(\S+)$/i.exec(context.req.header("authorization") ?? "")?.[1]
      ?? context.req.header("x-api-key");
    const run = token ? runs.get(token) : undefined;
    if (!run?.modelProxy) return context.json({ error: "The model capability is no longer active." }, 401);
    const refusal = await journal?.continuationRefusal(run.identity.threadId, run.identity.runId);
    if (refusal) return context.json({ error: refusal }, 409);
    return run.modelProxy(await context.req.json(), context.req.raw.signal);
  });
  routes.post("/steer", async context => {
    const token = /^Bearer\s+(\S+)$/i.exec(context.req.header("authorization") ?? "")?.[1];
    const run = token ? runs.get(token) : undefined;
    if (!run) return context.json({ error: "The runtime capability is no longer active." }, 401);
    const input = await context.req.json();
    if (!input.binding || Object.entries(run.identity).some(([key, value]) => input.binding[key] !== value)) return context.json({ error: "Run identity mismatch." }, 403);
    if (!Number.isSafeInteger(input.turn) || !Number.isSafeInteger(input.step)) return context.json({ error: "Step identity required." }, 400);
    if ((await journal?.get(run.identity.threadId, run.identity.runId))?.stop_requested) return context.json({ stopped: true, messages: [] });
    const key = `${token}:${input.turn}:${input.step}`;
    let pending = steering.get(key);
    if (!pending) {
      pending = (async () => {
        run.signal.throwIfAborted();
        const messages = await run.steering?.claim() ?? [];
        const anchors = Array.isArray(input.anchors) ? input.anchors.filter((value: unknown) => typeof value === "string") : [];
        const prepared = messages.length && run.prepareSteering ? await run.prepareSteering(messages) : { messages, instructions: [] };
        if (messages.length) run.steering?.onInjected(messages, anchors);
        return prepared;
      })();
      steering.set(key, pending);
    }
    return context.json(await pending);
  });
  routes.post("/execute", async context => {
    context.header("Cache-Control", "no-store");
    const token = /^Bearer\s+(\S+)$/i.exec(context.req.header("authorization") ?? "")?.[1];
    const run = token ? runs.get(token) : undefined;
    if (!run) return context.json({ error: "The runtime capability is no longer active." }, 401);
    const decoded = Call.safeParse(await context.req.json().catch(() => null));
    if (!decoded.success) return context.json({ error: "Invalid tool invocation." }, 400);
    const input = decoded.data;
    if (Object.entries(run.identity).some(([key, value]) => input.binding[key as keyof RuntimeToolIdentity] !== value)) {
      return context.json({ error: "Tool invocation belongs to another runtime or run." }, 403);
    }
    const identity = JSON.stringify([run.bindingId, input.binding.sessionId, input.turn, input.step, input.callId]);
    // JSON is parsed from the trusted runtime's immutable execution snapshot; the SQL ledger also
    // compares jsonb structurally, including after a server restart.
    const call = JSON.stringify([input.name, input.args]);
    const existing = live.get(identity);
    if (existing && (existing.call !== call || existing.runId !== run.identity.runId)) return context.json({ error: "Tool call identity conflict." }, 409);
    const promise = existing?.result ?? invoke(run, input);
    if (!existing) {
      live.set(identity, { call, runId: run.identity.runId, threadId: run.identity.threadId, result: promise });
      void promise.finally(() => live.delete(identity)).catch(() => {});
    }
    try { return context.json(await promise); }
    catch (error) {
      if (error instanceof HeadlessToolSuspension) return context.json({ waiting: error.waiting }, 202);
      return context.json({ error: error instanceof Error ? error.message : "Tool execution failed." }, 409);
    }
  });
  return { register, routes,
    async resumeConfirmation(input: { ownerUserId: string; requestId: string; approved: boolean; snapshot: ApprovalContinuation; tools: readonly GrantedTool[]; signal: AbortSignal }) {
      const { snapshot, signal } = input;
      const refusal = await journal?.continuationRefusal(snapshot.threadId, snapshot.runId);
      if (refusal) return { content: refusal };
      const tool = input.tools.find(item => item.name === snapshot.toolName);
      if (!tool) return { content: "这项工具的权限已被撤销，未执行已批准的操作。" };
      const args = await tool.parameters.parseAsync(snapshot.args);
      signal.throwIfAborted();
      assertConversationAdmissionOpen();
      const claim = await operations.resumeConfirmation({ ownerUserId: input.ownerUserId, requestId: input.requestId, runId: snapshot.runId, toolCallId: snapshot.toolCallId, name: snapshot.toolName, args: snapshot.args });
      if (claim.kind === "completed") return claim.result;
      if (claim.kind !== "claimed") {
        if (claim.kind === "pending" && claim.state === "dispatching") await operations.markOutcomeUnknown(claim.id);
        if (claim.kind === "pending" && ["dispatching", "outcome_unknown"].includes(claim.state)) throw unknownEffect(claim.id, snapshot);
        throw new Error("这项操作的结果尚待核对，未再次执行。");
      }
      try {
        const content = !input.approved ? "用户取消了这一步，操作没有执行。" : await withConfirmTurn({ threadId: snapshot.threadId, runId: snapshot.runId, stopped: () => signal.aborted }, () =>
          withConfirmToolCall(snapshot.toolCallId, snapshot.toolName, () => withConfirmActor(snapshot.initiator, () => withToolAbort(signal, () => withApprovalContext(snapshot, () =>
            withDurableConfirmation({ approvedRequestId: input.requestId, suspend: suspendConfirmation(claim.id, snapshot) }, async () => {
              const stopped = await journal?.continuationRefusal(snapshot.threadId, snapshot.runId);
              if (stopped) return stopped;
              signal.throwIfAborted();
              assertConversationAdmissionOpen();
              return tool.execute(args, { signal });
            }))))));
        const result = { content };
        await operations.settle(claim.id, "completed", result);
        return result;
      } catch (error) {
        const deferred = error instanceof HeadlessToolSuspension || error instanceof ConversationMaintenanceError;
        await operations.settle(claim.id, deferred ? "waiting_approval" : "outcome_unknown", { content: deferred ? "Waiting for a decision." : "操作结果尚待核对。", error: error instanceof Error ? error.message : "unknown" });
        if (!deferred) throw unknownEffect(claim.id, snapshot);
        throw error;
      }
    },
    async whenIdle(threadId: string, runId: string) {
      await Promise.allSettled([...live.values()].filter(call => call.threadId === threadId && call.runId === runId).map(call => call.result));
    },
  };
}
