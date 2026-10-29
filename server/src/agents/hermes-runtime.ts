import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  Middleware,
  type RunAgentInput,
  type RunFinishedEvent,
  type ToolCallStartEvent,
  type ToolCallResultEvent,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import { z } from "zod";
import type { RunAssertion } from "./callback-token";
import { logRunTiming, RunTimer } from "./run-timing";
import { currentRuntimeSurfaceTools } from "./runtime-tool-context";
import { createRuntimeToolRegistry, type RuntimeToolRun } from "./runtime-tools";
import type { HeadlessTool } from "../computer/headless-tools";
import { currentToolAbort } from "../confirmations/context";
import type { GrantedTool } from "../plugins/tools";
import { currentSteerSession } from "../thread-inbox";

export const hermesRuntimeTools = createRuntimeToolRegistry();

export type HermesRuntimeBinding = {
  /** Reachable by Hermes on the server; this URL never comes from a user message. */
  toolGatewayUrl: string;
  readRun: (assertion: unknown) => RunAssertion | null;
  loadSurfaceTools?: (scope: RunAssertion) => Promise<readonly HeadlessTool[]>;
};

export type HermesRunConfiguration = {
  botId: string;
  modelId: string;
  binding: HermesRuntimeBinding;
  signRun: (runId: string, threadId: string, previous?: unknown) => string;
  toolsFor: (input: RunAgentInput, signal: AbortSignal) => Promise<readonly GrantedTool[]>;
  prepare: (input: RunAgentInput, tools: readonly GrantedTool[]) => Promise<RunAgentInput>;
  /**
   * 这一轮的备用模型（同一个连接，按优先级）和输出上限（模型目录，见 copilot.ts resolveOutputLimit）。
   * 每一轮都问一次（管理员改了设置下一轮就生效）；没有就只发模型 id，Hermes 用它自己的默认。
   */
  modelControls?: (modelId: string) => Promise<HermesModelControls>;
  /** 宿主要附在 RUN_FINISHED metadata 上的内容（例如这一轮压缩了前文：historyCompaction）。 */
  finishedMetadata?: (runId: string) => Record<string, unknown> | undefined;
  /**
   * 宿主是否已经压缩了这次运行的前文（prepare 之后问）。是的话 model.contextCompression = false，
   * 适配器在这次运行里关掉 Hermes 自带的上下文压缩，免得二次压缩。
   */
  hostCompacted?: (runId: string) => boolean;
  log?: (line: Record<string, unknown>) => void;
};

export type HermesModelControls = { fallbacks?: readonly string[]; maxOutputTokens?: number };

/** 发给 Hermes 的备用模型最多几个（同 设置 → 模型 →「备用模型」的上限）。 */
export const HERMES_MAX_FALLBACKS = 8;

/** 线上传给桥接层的 model 字段：id + 去重后的备用模型 + 输出上限（都可省略）。 */
export function hermesWireModel(modelId: string, controls: HermesModelControls | undefined, hostCompacted = false) {
  const fallbacks = [...new Set((controls?.fallbacks ?? []).map((id) => id.trim()))]
    .filter((id) => id && id !== modelId && id.length <= 200 && ![...id].some((character) => /\s/u.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    .slice(0, HERMES_MAX_FALLBACKS);
  const limit = controls?.maxOutputTokens;
  return {
    id: modelId,
    ...(fallbacks.length ? { fallbacks } : {}),
    ...(typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000_000 ? { maxOutputTokens: limit } : {}),
    ...(hostCompacted ? { contextCompression: false } : {}),
  };
}

/**
 * Hermes 换了备用模型（适配器回报，桥接层放在 RUN_FINISHED metadata.modelFallback）：只认这一轮发出去的
 * 主模型 → 发出去的某个备用模型，其余一律丢弃。认下来的同内置路径一样记日志、进对话里那行淡色小字。
 */
export function acceptedHermesFallback(value: unknown, wire: { id: string; fallbacks?: readonly string[] }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { from, to, reason } = value as Record<string, unknown>;
  if (from !== wire.id || typeof to !== "string" || !wire.fallbacks?.includes(to)) return null;
  return { from, to, reason: reason === "quota" ? ("quota" as const) : ("unavailable" as const) };
}

function asGranted(tool: HeadlessTool): GrantedTool {
  return {
    name: tool.definition.name,
    description: tool.definition.description ?? "",
    ref: `host/${tool.definition.name}`,
    // Each original executor also parses its authoritative schema. This conversion provides
    // early validation without replacing the original tool's policy or implementation.
    parameters: z.fromJSONSchema(tool.definition.parameters),
    execute: async (args, context) => {
      const { currentConfirmToolCall } = await import("../confirmations/context");
      const callId = currentConfirmToolCall()?.toolCallId;
      if (!callId || !context?.signal) throw new Error("The host tool is missing its run context.");
      const result = await tool.execute(args, { toolCallId: callId, signal: context.signal });
      if (typeof result === "string") return result;
      const text = JSON.stringify(result);
      if (text === undefined) throw new Error("The host tool returned no result.");
      return text;
    },
  };
}

/** Capture real AG-UI calls before the separate HTTP tool request may spend a grant. */
class CaptureHermesRun extends Middleware {
  constructor(private readonly runTools: RuntimeToolRun, private readonly ownedNames: string[]) { super(); }
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const pending = new Map<string, string>();
      const answered = new Set<string>();
      let terminal = false;
      return this.runNextWithState(input, next).subscribe({
        next: ({ event, messages, state }) => {
          this.runTools.updateMessages(messages);
          this.runTools.updateState(state);
          if (event.type === EventType.TOOL_CALL_START) {
            const call = event as ToolCallStartEvent;
            pending.set(call.toolCallId, call.toolCallName);
          }
          if (event.type === EventType.TOOL_CALL_RESULT) answered.add((event as ToolCallResultEvent).toolCallId);
          if (event.type === EventType.RUN_FINISHED) {
            terminal = true;
            if ((event as RunFinishedEvent).outcome?.type !== "interrupt" && [...pending.keys()].some((id) => !answered.has(id))) {
              subscriber.next({ type: EventType.RUN_ERROR, code: "HERMES_MISSING_TOOL_RECEIPT", message: "Hermes ended before a host tool returned its execution receipt. The operation will not be repeated automatically." });
              return;
            }
          }
          if (event.type === EventType.RUN_ERROR) terminal = true;
          subscriber.next(event);
          if (event.type === EventType.RUN_STARTED)
            subscriber.next({ type: EventType.CUSTOM, name: "chisabot.backend-owned-tools", value: { names: this.ownedNames } });
        },
        error: (error) => subscriber.error(error),
        complete: () => {
          if (!terminal) subscriber.next({ type: EventType.RUN_ERROR, code: "HERMES_MISSING_TERMINAL", message: "Hermes disconnected before the run completed." });
          subscriber.complete();
        },
      });
    });
  }
}

/** Hermes owns the loop; every tool it can execute retains the host's executor and policy. */
export class HermesRuntimeAgent extends AbstractAgent {
  private active?: { controller: AbortController; remote: AbstractAgent };
  constructor(
    private readonly transport: AbstractAgent,
    private readonly configuration: HermesRunConfiguration,
  ) {
    super({ agentId: transport.agentId, description: transport.description });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      const hostAbort = currentToolAbort();
      const steerSession = currentSteerSession();
      const remote = this.transport.clone();
      const active = { controller, remote };
      this.active = active;
      const contributed = [...currentRuntimeSurfaceTools()];
      // 分段计时（run-timing.ts）：只记毫秒数，不记内容。
      const timer = new RunTimer(input.runId);
      let runTools: RuntimeToolRun | undefined;
      let subscription: Subscription | undefined;
      const cancelled = () => {
        subscription?.unsubscribe();
        runTools?.close();
        remote.abortRun();
        if (!subscriber.closed) {
          subscriber.next({ type: EventType.RUN_ERROR, code: "HERMES_RUN_CANCELLED", message: "This run was stopped." });
          subscriber.complete();
        }
      };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      const stop = () => controller.abort(hostAbort?.reason);
      hostAbort?.addEventListener("abort", stop, { once: true });
      if (hostAbort?.aborted) stop();
      const work = async () => {
        controller.signal.throwIfAborted();
        const assertion = this.configuration.signRun(input.runId, input.threadId, input.forwardedProps?.openbotRun);
        const scope = this.configuration.binding.readRun(assertion);
        if (!scope || scope.botId !== this.configuration.botId || scope.runId !== input.runId || scope.threadId !== input.threadId)
          throw new Error("The Hermes run could not be bound to its authenticated actor, Bot and conversation.");
        const [granted, surfaces] = await Promise.all([
          this.configuration.toolsFor(input, controller.signal),
          this.configuration.binding.loadSurfaceTools?.(scope) ?? [],
        ]);
        controller.signal.throwIfAborted();
        const tools = new Map(granted.map((tool) => [tool.name, tool]));
        // The middleware contribution is the exact executor already assembled for a background turn.
        const allSurfaces = new Map([...surfaces, ...contributed].map((tool) => [tool.definition.name, tool]));
        for (const surface of allSurfaces.values()) {
          if (!surface.hidden && !tools.has(surface.definition.name)) tools.set(surface.definition.name, asGranted(surface));
        }
        const assembled = [...tools.values()];
        timer.mark("assembled");
        const [prepared, controls] = await Promise.all([
          this.configuration.prepare(input, assembled),
          this.configuration.modelControls?.(this.configuration.modelId).catch(() => undefined),
        ]);
        const wireModel = hermesWireModel(this.configuration.modelId, controls, this.configuration.hostCompacted?.(input.runId) === true);
        controller.signal.throwIfAborted();
        // A client cannot grant a tool by supplying its schema. Only host-bound executors are offered.
        prepared.tools = assembled.map((tool) => ({ name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: "input" }) }));
        const { chisabotHermes: _untrustedHermes, ...hostProps } = prepared.forwardedProps ?? {};
        prepared.forwardedProps = {
          ...hostProps,
          openbotRun: assertion,
          openbotBotId: scope.botId,
          openbotDeploymentTools: assembled.map((tool) => tool.name),
        };
        runTools = hermesRuntimeTools.register({
          input: prepared,
          tools: assembled,
          scope,
          signal: controller.signal,
          initiator: scope.initiator,
          ...(steerSession ? { steerSession } : {}),
        });
        const wire: RunAgentInput = {
          ...prepared,
          forwardedProps: {
            ...prepared.forwardedProps,
            chisabotHermes: {
              version: 1,
              scope: { actorId: scope.actorId, botId: scope.botId, threadId: input.threadId, runId: input.runId },
              model: wireModel,
              toolGateway: { url: this.configuration.binding.toolGatewayUrl, capability: runTools.capability },
            },
          },
        };
        // Headless middleware observes the ownership marker after RUN_STARTED and never
        // compensates a missing receipt by executing a Hermes-owned call itself.
        timer.mark("sent");
        subscription = new CaptureHermesRun(runTools, assembled.map((tool) => tool.name)).run(wire, new SeededTransport(remote, wire)).subscribe({
          next: (event) => {
            timer.observe(event);
            if (event.type === EventType.RUN_FINISHED) logRunTiming(timer.finish("finished"));
            else if (event.type === EventType.RUN_ERROR) logRunTiming(timer.finish("error"));
            subscriber.next(event.type === EventType.RUN_FINISHED ? this.finished(event as RunFinishedEvent, input.runId, wireModel) : event);
          },
          error: (error) => {
            logRunTiming(timer.finish("error"));
            subscriber.error(error);
          },
          complete: () => {
            logRunTiming(timer.finish("closed"));
            subscriber.complete();
          },
        });
      };
      work().catch((error: unknown) => {
        logRunTiming(timer.finish(controller.signal.aborted ? "cancelled" : "error"));
        if (!subscriber.closed) {
          subscriber.next({ type: EventType.RUN_ERROR, code: controller.signal.aborted ? "HERMES_RUN_CANCELLED" : "HERMES_HOST_BINDING_ERROR", message: controller.signal.aborted ? "This run was stopped." : error instanceof Error ? error.message : "Hermes host binding failed." });
          subscriber.complete();
        }
      });
      return () => {
        logRunTiming(timer.finish(controller.signal.aborted ? "cancelled" : "closed"));
        hostAbort?.removeEventListener("abort", stop);
        controller.signal.removeEventListener("abort", cancelled);
        controller.abort();
        runTools?.close();
        subscription?.unsubscribe();
        remote.abortRun();
        if (this.active === active) this.active = undefined;
      };
    });
  }

  /** RUN_FINISHED 的 metadata：核对过的 modelFallback + 宿主自己的（historyCompaction 等）。 */
  private finished(event: RunFinishedEvent, runId: string, wire: { id: string; fallbacks?: readonly string[] }): BaseEvent {
    const { modelFallback: reported, ...rest } = ((event as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
    const metadata: Record<string, unknown> = { ...rest };
    const fallback = acceptedHermesFallback(reported, wire);
    if (fallback) {
      metadata.modelFallback = fallback;
      (this.configuration.log ?? ((line) => console.log(JSON.stringify(line))))({ type: "model-fallback", event: "used", model: fallback.from, fallback: fallback.to, reason: fallback.reason, kernel: "hermes" });
    }
    try {
      Object.assign(metadata, this.configuration.finishedMetadata?.(runId) ?? {});
    } catch {
      // 附加信息失败不影响回答。
    }
    const { metadata: _old, ...base } = event as RunFinishedEvent & { metadata?: unknown };
    return (Object.keys(metadata).length ? { ...base, metadata } : base) as BaseEvent;
  }

  clone(): HermesRuntimeAgent {
    const clone = super.clone() as HermesRuntimeAgent;
    // AbstractAgent.clone copies base fields only.
    (clone as unknown as { transport: AbstractAgent }).transport = this.transport.clone();
    (clone as unknown as { configuration: HermesRunConfiguration }).configuration = this.configuration;
    clone.active = undefined;
    return clone;
  }
  abortRun(): void {
    this.active?.controller.abort();
    this.active?.remote.abortRun();
    super.abortRun();
  }
}

class SeededTransport extends AbstractAgent {
  constructor(private readonly transport: AbstractAgent, input: RunAgentInput) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run(input: RunAgentInput) { return this.transport.run(input); }
}
