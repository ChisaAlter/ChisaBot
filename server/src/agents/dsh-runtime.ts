import { readFile } from "node:fs/promises";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { z } from "zod";
import {
  type DshBindingInput,
  DshHostClient,
} from "../../../runtime/dsh/src/client.mjs";
import { filesFromToolResult } from "../../../shared/chat-files";
import { RENDER_UI_SHOWN } from "../../../shared/json-render/catalog";
import type { ResolvedReasoningEffort } from "../../../shared/model-routing";
import { CHISABOT_WAITING_METADATA } from "../approvals/native-context";
import type { ApprovalContinuation } from "../approvals/types";
import type { HeadlessTool } from "../computer/headless-tools";
import {
  currentConfirmToolCall,
  currentToolAbort,
} from "../confirmations/context";
import { readStepUsage } from "../context-usage";
import type { ConversationBindings } from "../conversations/bindings";
import { sharedDshClientPool } from "../conversations/dsh-client-pool";
import {
  DshEventProjection,
  type DshLiveFrame,
  type DshTurnReason,
  isSteerCutReason,
} from "../conversations/dsh-events";
import { inboxInstructions } from "../conversations/inbox-message";
import type { ModelKeyPool } from "../conversations/key-pool";
import {
  createModelConnectionProxy,
  type ModelProxyQuotaOptions,
} from "../conversations/model-connection-proxy";
import { createPlanModelProxy } from "../conversations/plan-model-proxy";
import type { DshRunJournal } from "../conversations/run-journal";
import { createEventLifecycles } from "../conversations/runner";
import type { createDshToolGateway } from "../conversations/tool-gateway";
import type { ToolImagePart } from "../conversations/tool-images";
import type { ModelConnectionPooledKeyRuntime } from "../model-settings";
import type { GrantedTool } from "../plugins/tools";
import {
  composeParentPromptWithWorkbench,
  type PromptWorkbenchStore,
} from "../prompts/workbench-store";
import type { UsageBreakdownService } from "../quotas/usage-breakdown";
import { currentSteerSession } from "../thread-inbox";
import type { AdaptiveRouter } from "./adaptive-router";
import type { RunAssertion } from "./callback-token";
import type { ModelObservationService } from "./model-observation";
import { PLAN_RUN_COMPLETED, type PlanModelConfig } from "./plan-model";
import { currentRuntimeSurfaceTools } from "./runtime-tool-context";

export type RuntimeToolBinding = {
  toolGatewayUrl: string;
  readRun: (assertion: unknown) => RunAssertion | null;
  loadSurfaceTools?: (scope: RunAssertion) => Promise<readonly HeadlessTool[]>;
};

export type DshRuntimeTarget = {
  id: string;
  ownerUserId: string;
  connectionFile: string;
};
export type DshRuntimeBinding = RuntimeToolBinding & {
  targetFor(actorId: string): Promise<DshRuntimeTarget>;
  bindings: ConversationBindings;
  gateway: ReturnType<typeof createDshToolGateway>;
  revisionFor?: (threadId: string) => Promise<number>;
  journal?: DshRunJournal;
};
export type DshRuntimeConfiguration = {
  botId: string;
  binding: DshRuntimeBinding;
  signRun: (input: RunAgentInput) => string;
  tools: readonly GrantedTool[];
  selectTools?: (
    input: RunAgentInput,
    signal: AbortSignal,
  ) => Promise<readonly GrantedTool[]>;
  prompt: (tools: readonly GrantedTool[]) => string;
  prepareInput?: (input: RunAgentInput) => Promise<RunAgentInput>;
  connection: {
    provider: "openai" | "anthropic";
    baseUrl: string;
    apiKey: string | null;
    useApiKey?: boolean;
    model: string;
    pooledKeys?: readonly ModelConnectionPooledKeyRuntime[];
  };
  keyPool?: ModelKeyPool;
  poolId?: string;
  quota?: Omit<ModelProxyQuotaOptions, "userId"> & { userId?: string };
  plan?: PlanModelConfig;
  describeImage?: (part: ToolImagePart) => Promise<string | null>;
  modelInfo: (model: string) => Promise<{
    maxOutputTokens?: number;
    contextWindow?: number;
    summaryThresholdTokens?: number;
    supportsImages?: boolean;
  }>;
  fallbacks: () => Promise<readonly string[]>;
  toolsFor?: (
    input: RunAgentInput,
    signal: AbortSignal,
  ) => Promise<readonly GrantedTool[]>;
  adaptiveRouter?: AdaptiveRouter;
  modelObserver?: Pick<ModelObservationService, "isEnabled" | "record">;
  usageBreakdown?: Pick<UsageBreakdownService, "record">;
  promptWorkbench?: PromptWorkbenchStore;
};

type Configuration = DshRuntimeConfiguration;

function dshUserContent(
  messages: readonly Message[],
): Parameters<DshHostClient["prompt"]>[0]["content"] {
  const content: Parameters<DshHostClient["prompt"]>[0]["content"] = [];
  for (const message of messages) {
    if (typeof message.content === "string")
      content.push({ type: "text", text: message.content });
    else
      for (const part of Array.isArray(message.content)
        ? message.content
        : []) {
        if (part.type === "text")
          content.push({ type: "text", text: part.text });
        else if (part.type === "image") {
          const source = part.source as unknown as Record<string, unknown>;
          const data =
            typeof source.data === "string"
              ? source.data
              : source.type === "data" && typeof source.value === "string"
                ? source.value
                : undefined;
          if (!data)
            throw new Error(
              "Image attachment was not resolved by the authorized host loader.",
            );
          const match = /^data:([^;]+);base64,(.*)$/s.exec(data);
          content.push({
            type: "image",
            mediaType: match?.[1] ?? String(source.mimeType ?? "image/png"),
            data: match?.[2] ?? data,
          });
        } else
          throw new Error(
            `The attachment type ${part.type} requires a host content projection before DSH admission.`,
          );
      }
  }
  return content;
}

function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content)
    ? message.content
        .filter((x) => x.type === "text")
        .map((x) => ("text" in x ? String(x.text) : ""))
        .join("\n")
    : "";
}

function emptyReplyAfterDelivery(
  reason: DshTurnReason | undefined,
  messages: Message[],
  original: readonly Message[],
): boolean {
  if (reason?.kind !== "error" || reason.error?.code !== "EMPTY_RESPONSE")
    return false;
  const originalIds = new Set(original.map((message) => message.id));
  const renderedCalls = new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls
            ?.filter((call) => call.function.name === "render_ui")
            .map((call) => call.id) ?? [])
        : [],
    ),
  );
  // A file already delivered after this request is the reply. An older file or a delivery
  // before a later steering message cannot turn that later unanswered request into success.
  return messages
    .slice(messages.findLastIndex((message) => message.role === "user") + 1)
    .some(
      (message) =>
        message.role === "tool" &&
        !originalIds.has(message.id) &&
        (filesFromToolResult(message.content).length > 0 ||
          (renderedCalls.has(message.toolCallId) &&
            typeof message.content === "string" &&
            message.content.startsWith(RENDER_UI_SHOWN))),
    );
}

function migrationContext(
  messages: readonly Message[],
  contextWindow: number,
): string | undefined {
  if (!messages.length) return undefined;
  // The complete original transcript remains in PostgreSQL. The runtime receives an explicitly
  // bounded continuation, with binary attachment contents represented by their historical names.
  const limit = Math.max(4000, Math.floor(contextWindow));
  const retained: unknown[] = [];
  let size = 0;
  for (const message of [...messages].reverse()) {
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map(
                (part: { type: string; text?: string; filename?: string }) =>
                  part.type === "text"
                    ? part.text
                    : `[历史附件 ${part.filename ?? part.type}]`,
              )
              .join("\n")
          : "";
    const entry = {
      id: message.id,
      role: message.role,
      content:
        content.length > 8000
          ? `${content.slice(0, 6000)}\n[长内容节选；完整原文保留在旧对话]\n${content.slice(-1000)}`
          : content,
      ...(message.role === "assistant" && message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.function.name,
              args: call.function.arguments.slice(0, 2000),
            })),
          }
        : {}),
      ...(message.role === "tool" ? { toolCallId: message.toolCallId } : {}),
    };
    const length = JSON.stringify(entry).length;
    if (size + length > limit) break;
    retained.unshift(entry);
    size += length;
  }
  return JSON.stringify({
    kind: "legacy-continuation",
    omittedMessages: messages.length - retained.length,
    note: "这是已发生的历史；只继续新的请求，不重新执行历史工具。",
    messages: retained,
  });
}

const SETTLEMENT_EVENT_TYPES = new Set([
  "assistant/message",
  "assistant/attempt",
  "tool/call",
  "tool/result",
  "turn/end",
  "user/message",
  "plugin:chisabot/waiting",
  "plugin:chisabot/loop-stop",
]);

/** Transitional AG-UI adapter: the existing clients consume events; DSH owns persistent execution. */
export class DshRuntimeAgent extends AbstractAgent {
  readonly acknowledgesStop = true;
  executionSettled = false;
  private active?: {
    abort: AbortController;
    client?: DshHostClient;
    endpoint?: string;
    sessionId?: string;
    runId: string;
    input?: RunAgentInput;
    toolAbort: AbortController;
    stopping?: Promise<unknown>;
  };
  constructor(private readonly configuration: Configuration) {
    super({ agentId: configuration.botId });
  }

  private async toolsForRun(
    input: RunAgentInput,
    signal: AbortSignal,
    contributed: readonly HeadlessTool[] = [],
    select = false,
  ) {
    const scope = this.configuration.binding.readRun(
      this.configuration.signRun(input),
    );
    if (
      !scope ||
      scope.botId !== this.configuration.botId ||
      scope.threadId !== input.threadId ||
      scope.runId !== input.runId
    )
      throw new Error("DSH tool scope could not be authenticated.");
    const surfaces =
      (await this.configuration.binding.loadSurfaceTools?.(scope)) ?? [];
    const granted =
      select && this.configuration.selectTools
        ? await this.configuration.selectTools(input, signal)
        : this.configuration.tools;
    const tools = new Map(granted.map((x) => [x.name, x]));
    for (const tool of (await this.configuration.toolsFor?.(input, signal)) ??
      [])
      tools.set(tool.name, tool);
    for (const surface of [...surfaces, ...contributed]) {
      if (surface.hidden || tools.has(surface.definition.name)) continue;
      tools.set(surface.definition.name, {
        name: surface.definition.name,
        description: surface.definition.description ?? "",
        ref: `host/${surface.definition.name}`,
        parameters: z.fromJSONSchema(surface.definition.parameters),
        execute: async (args, context) => {
          const toolCallId = currentConfirmToolCall()?.toolCallId;
          if (!context?.signal || !toolCallId)
            throw new Error("Host tool execution lost its call context.");
          const value = await surface.execute(args, {
            toolCallId,
            signal: context.signal,
          });
          return typeof value === "string" ? value : JSON.stringify(value);
        },
      });
    }
    return tools;
  }

  async resumeConfirmation(input: {
    ownerUserId: string;
    requestId: string;
    approved: boolean;
    snapshot: ApprovalContinuation;
    signal: AbortSignal;
  }) {
    const saved: RunAgentInput = {
      ...input.snapshot,
      forwardedProps: input.snapshot.forwardedProps ?? {},
      tools: [],
    };
    const scope = this.configuration.binding.readRun(
      this.configuration.signRun(saved),
    );
    if (scope?.actorId !== input.ownerUserId)
      throw new Error("This confirmation belongs to another account.");
    const tools = await this.toolsForRun(saved, input.signal);
    return this.configuration.binding.gateway.resumeConfirmation({
      ...input,
      tools: [...tools.values()],
    });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.executionSettled = false;
    return new Observable((subscriber) => {
      const active = {
        abort: new AbortController(),
        toolAbort: new AbortController(),
        runId: input.runId,
        input,
      } as NonNullable<DshRuntimeAgent["active"]>;
      this.active = active;
      const outerSignal = currentToolAbort();
      const contributed = [...currentRuntimeSurfaceTools()];
      const steering = currentSteerSession();
      const onAbort = () => {
        void this.stopActive(active)?.catch(() => {});
      };
      outerSignal?.addEventListener("abort", onAbort, { once: true });
      if (outerSignal?.aborted) onAbort();
      let capability: { capability: string; close(): void } | undefined;
      let followAbort: AbortController | undefined;
      const emit = (event: BaseEvent) => {
        if (!subscriber.closed) subscriber.next(event);
      };
      const work = async () => {
        const scope = this.configuration.binding.readRun(
          this.configuration.signRun(input),
        );
        if (
          !scope ||
          scope.botId !== this.configuration.botId ||
          scope.threadId !== input.threadId ||
          scope.runId !== input.runId
        )
          throw new Error("DSH run identity could not be authenticated.");
        const target = await this.configuration.binding.targetFor(
          scope.actorId,
        );
        if (target.ownerUserId !== scope.actorId)
          throw new Error("DSH runtime owner does not match the request.");
        const endpoint = JSON.parse(
          await readFile(target.connectionFile, "utf8"),
        ) as { endpoint: string };
        let client = await sharedDshClientPool.acquire(endpoint.endpoint);
        active.client = client;
        active.endpoint = endpoint.endpoint;
        const health = client.lastHealth ?? (await client.health());
        if (health.ownerUserId !== scope.actorId || health.protocol !== 1)
          throw new Error("DSH owner or plugin protocol does not match.");
        const resolved =
          input.resume?.filter((x) => x.status === "resolved") ?? [];
        const requestId = resolved.length
          ? `${input.runId}:resume:${resolved.map((item) => item.interruptId).join(",")}`
          : input.messages.findLast((message) => message.role === "user")?.id;
        if (!requestId) throw new Error("DSH requires a new user input.");
        const previousRun = await this.configuration.binding.journal?.get(
          input.threadId,
          input.runId,
        );
        const recovered =
          previousRun?.request_id === requestId ? previousRun : undefined;
        if (
          previousRun &&
          (previousRun.owner_user_id !== scope.actorId ||
            previousRun.bot_id !== scope.botId)
        )
          throw new Error("The saved run belongs to a different actor or Bot.");
        if (previousRun && !recovered && previousRun.status !== "projecting")
          throw new Error("The previous execution segment has not settled.");
        if (previousRun?.stop_requested) active.abort.abort();
        if (recovered && recovered.generation !== health.generation) {
          // Read the old durable execution before reporting the restart. No prompt or tool is
          // reissued: an API process may have missed its last committed output.
          const replay = new DshEventProjection(
            recovered.session_id,
            emit,
            recovered.input.messages,
          );
          const baseline = await client.eventsAfter(
            recovered.session_id,
            -1,
            recovered.baseline,
          );
          replay.baseline(baseline.records, baseline.cursor);
          emit({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          emit({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: replay.snapshot(),
          } as BaseEvent);
          for (const record of (
            await client.eventsAfter(recovered.session_id, replay.cursor)
          ).records)
            replay.durable(record.event);
          this.executionSettled = true;
          await this.configuration.binding.journal?.status(
            input.threadId,
            input.runId,
            "interrupted",
          );
          await this.configuration.binding.gateway.abandonRun(input.runId);
          throw new Error(
            "执行内核已重启，已恢复保存的输出。已完成的操作保留；未确认的操作需要核对后再继续。",
          );
        }
        const revision =
          (await this.configuration.binding.revisionFor?.(input.threadId)) ?? 1;
        if (recovered && recovered.binding_revision !== revision) {
          await this.configuration.binding.journal?.status(
            input.threadId,
            input.runId,
            "interrupted",
          );
          await this.configuration.binding.gateway.abandonRun(input.runId);
          throw new Error("这段对话已被编辑，旧版本的执行不能写入当前对话。");
        }
        const binding = await this.configuration.binding.bindings.getOrCreate({
          threadId: input.threadId,
          ownerUserId: scope.actorId,
          botId: scope.botId,
          runtimeId: target.id,
          revision,
        });
        active.sessionId = binding.sessionId;
        const tools = await this.toolsForRun(
          input,
          active.toolAbort.signal,
          contributed,
          !recovered,
        );
        const rawPreparedInput = this.configuration.prepareInput
          ? await this.configuration.prepareInput(input)
          : input;
        const messageHasImages = (message: Message | undefined) =>
          Boolean(
            message &&
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "image"),
          );
        const latestUserInPrepared = rawPreparedInput.messages.findLast(
          (message) => message.role === "user",
        );
        const latestNeedsImages = messageHasImages(latestUserInPrepared);
        const anyNeedsImages = rawPreparedInput.messages.some((message) =>
          messageHasImages(message),
        );
        let routedModel = this.configuration.connection.model;
        let routedEffort: ResolvedReasoningEffort = "default";
        if (this.configuration.adaptiveRouter && !this.configuration.plan) {
          const forwarded = input.forwardedProps as
            | { isSummarizationSession?: unknown }
            | undefined;
          const decision = await this.configuration.adaptiveRouter
            .decideRoute({
              messages: rawPreparedInput.messages,
              fallbackModel: this.configuration.connection.model,
              providerKind: this.configuration.connection.provider,
              ownerUserId: scope.actorId,
              isSummarizationSession:
                forwarded?.isSummarizationSession === true,
              signal: active.toolAbort.signal,
            })
            .catch(() => null);
          if (decision) {
            routedModel = decision.model || routedModel;
            routedEffort = decision.effort;
          }
        }
        const requestedModels = this.configuration.plan
          ? [this.configuration.plan.provider]
          : [
              routedModel,
              this.configuration.connection.model,
              ...(await this.configuration.fallbacks()),
            ].filter((id, at, all) => all.indexOf(id) === at);
        const catalog = await Promise.all(
          requestedModels.map(async (id) => {
            const info = this.configuration.plan
              ? {
                  contextWindow: 128_000,
                  maxOutputTokens: 16_000,
                  summaryThresholdTokens: undefined,
                  supportsImages: true,
                }
              : await this.configuration.modelInfo(id);
            const resolvedContextWindow = info.contextWindow ?? 128_000;
            const resolvedSummaryThreshold =
              typeof info.summaryThresholdTokens === "number" &&
              Number.isFinite(info.summaryThresholdTokens) &&
              info.summaryThresholdTokens > 0 &&
              info.summaryThresholdTokens < resolvedContextWindow
                ? info.summaryThresholdTokens
                : undefined;
            return {
              id,
              contextWindow: resolvedContextWindow,
              ...(resolvedSummaryThreshold !== undefined
                ? { summaryThresholdTokens: resolvedSummaryThreshold }
                : {}),
              maxTokens: info.maxOutputTokens ?? 32_000,
              input: info.supportsImages ? ["text", "image"] : ["text"],
            };
          }),
        );
        const imageCapable = catalog.filter((model) =>
          model.input.includes("image"),
        );
        if (latestNeedsImages && !imageCapable.length)
          throw new Error(
            "当前主模型和备用模型都不能读取这段对话中的图片，请选择支持图片的模型。",
          );
        const definitions =
          anyNeedsImages && imageCapable.length ? imageCapable : catalog;
        const stripHistoricalImages = anyNeedsImages && !imageCapable.length;
        const preparedInput = stripHistoricalImages
          ? {
              ...rawPreparedInput,
              messages: rawPreparedInput.messages.map((message) =>
                message.id !== latestUserInPrepared?.id &&
                Array.isArray(message.content) &&
                message.content.some((part) => part.type === "image")
                  ? ({
                      ...message,
                      content: message.content.map((part) =>
                        part.type === "image"
                          ? {
                              type: "text",
                              text: "[历史图片附件：当前模型不支持读取图片]",
                            }
                          : part,
                      ),
                    } as Message)
                  : message,
              ),
            }
          : rawPreparedInput;
        const models = definitions.map((model) => model.id);
        const contextWindow = Math.min(
          ...definitions.map((model) => model.contextWindow),
        );
        const summaryThresholds = definitions
          .map((model) => model.summaryThresholdTokens)
          .filter(
            (value): value is number =>
              typeof value === "number" &&
              Number.isFinite(value) &&
              value > 0 &&
              value < contextWindow,
          );
        const migrationBudget = summaryThresholds.length
          ? Math.min(contextWindow, ...summaryThresholds)
          : contextWindow;
        const [primary, ...fallbacks] = definitions.map((model, index) => ({
          provider: "configured",
          model: model.id,
          maxTokens: Math.min(model.maxTokens, Math.floor(contextWindow / 4)),
          ...(index === 0 && routedEffort !== "default"
            ? { reasoningEffort: routedEffort }
            : {}),
        }));
        if (!primary) throw new Error("没有可用的模型。");
        const primarySupportsImages = Boolean(
          this.configuration.plan || definitions[0]?.input.includes("image"),
        );
        const identity = {
          sessionId: binding.sessionId,
          runId: input.runId,
          threadId: input.threadId,
          botId: scope.botId,
          actorId: scope.actorId,
          revision: binding.revision,
          generation: health.generation,
        };
        let projection!: DshEventProjection;
        const connection = this.configuration.connection;
        const quotaOptions: ModelProxyQuotaOptions | undefined = this
          .configuration.quota
          ? {
              ...this.configuration.quota,
              userId: this.configuration.quota.userId ?? scope.actorId,
            }
          : undefined;
        const modelProxy = this.configuration.plan
          ? createPlanModelProxy(
              this.configuration.plan,
              scope.botId,
              input,
              [...tools.keys()],
              active.toolAbort.signal,
              quotaOptions ? { quota: quotaOptions } : undefined,
            )
          : createModelConnectionProxy(
              connection,
              models,
              [...tools.keys()],
              active.toolAbort.signal,
              {
                stickyKey:
                  input.threadId || identity.sessionId || scope.actorId,
                ...(this.configuration.keyPool
                  ? { keyPool: this.configuration.keyPool }
                  : {}),
                ...(this.configuration.poolId
                  ? { poolId: this.configuration.poolId }
                  : {}),
                ...(quotaOptions ? { quota: quotaOptions } : {}),
                ...(routedEffort !== "default"
                  ? { reasoningEffort: routedEffort }
                  : {}),
                ...(this.configuration.modelObserver
                  ? { observer: this.configuration.modelObserver }
                  : {}),
                ...(this.configuration.usageBreakdown
                  ? {
                      ownerUserId: scope.actorId,
                      usageKind: "chat" as const,
                      onUsageBreakdown: (event) =>
                        this.configuration.usageBreakdown?.record(event),
                    }
                  : {}),
              },
            );
        capability = this.configuration.binding.gateway.register({
          bindingId: binding.bindingId,
          identity,
          input,
          tools: [...tools.values()],
          signal: active.toolAbort.signal,
          supportsImages: primarySupportsImages,
          ...(this.configuration.describeImage
            ? { describeImage: this.configuration.describeImage }
            : {}),
          steering,
          prepareSteering: async (messages) => {
            const prepared = this.configuration.prepareInput
              ? await this.configuration.prepareInput({ ...input, messages })
              : { ...input, messages };
            return {
              messages: prepared.messages.map((message) => ({
                id: message.id,
                content: dshUserContent([message]),
              })),
              instructions: inboxInstructions(messages),
            };
          },
          modelProxy,
          continuationMessages: async (throughSeq) => {
            if (!projection) throw new Error("The DSH observer is not ready.");
            const missing = await client.eventsAfter(
              binding.sessionId,
              projection.cursor,
              throughSeq,
              active.toolAbort.signal,
            );
            for (const record of missing.records)
              projection.durable(record.event);
            return projection.snapshot();
          },
          ...(scope.initiator ? { initiator: scope.initiator } : {}),
        });
        const users = preparedInput.messages.filter((x) => x.role === "user");
        const latest = users.at(-1);
        if (!latest) throw new Error("DSH requires a new user input.");
        const lastAssistant = preparedInput.messages.findLastIndex(
          (message) => message.role === "assistant",
        );
        const inputs = preparedInput.messages
          .slice(lastAssistant + 1)
          .filter((message) => message.role === "user");
        const at = preparedInput.messages.indexOf(inputs[0] ?? latest);
        const previous = preparedInput.messages
          .slice(0, at)
          .filter((x) => x.role !== "system");
        const baseAssembledPrompt = this.configuration.prompt([
          ...tools.values(),
        ]);
        const systemMessagesText = preparedInput.messages
          .filter((message) => message.role === "system")
          .map(textOf);
        const inboxText = inboxInstructions(preparedInput.messages);
        let effectiveBasePrompt = baseAssembledPrompt;
        if (this.configuration.promptWorkbench) {
          const turnPrompt = await this.configuration.promptWorkbench
            .snapshot()
            .catch(() => null);
          if (turnPrompt) {
            const dynamicNames = new Set(
              contributed.map((surface) => surface.definition.name),
            );
            effectiveBasePrompt = composeParentPromptWithWorkbench({
              turnPrompt,
              baseAssembledPrompt,
              systemMessagesText,
              inboxText,
              tools: [...tools.values()],
              dynamicToolNames: dynamicNames,
            });
          }
        }
        const request: DshBindingInput = {
          ...identity,
          prompt: [
            effectiveBasePrompt,
            ...systemMessagesText,
            ...inboxText,
          ].join("\n\n"),
          initialContext: migrationContext(previous, migrationBudget),
          toolCapability: capability.capability,
          steering: Boolean(steering),
          model: {
            primary,
            fallbacks,
            // Silence is not failure. The user decides when to stop waiting.
            firstOutputMs: 0,
            contextWindow,
          },
          connection: {
            api:
              connection.provider === "anthropic" && !this.configuration.plan
                ? "anthropic-messages"
                : "openai-completions",
            // Anthropic's SDK appends /v1/messages; OpenAI's SDK appends /chat/completions.
            baseURL: `${this.configuration.binding.toolGatewayUrl.replace(/\/$/, "")}/model${connection.provider === "anthropic" && !this.configuration.plan ? "" : "/v1"}`,
            apiKey: capability.capability,
            modelProxy: true,
            target: {
              provider:
                this.configuration.plan?.provider ?? connection.provider,
              baseUrl: this.configuration.plan
                ? `${this.configuration.plan.endpoint.origin}${this.configuration.plan.endpoint.pathname}`
                : connection.baseUrl,
            },
            models: definitions,
          },
          tools: [...tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: z.toJSONSchema(tool.parameters, { io: "input" }),
          })),
        };
        if (active.abort.signal.aborted && !recovered)
          throw new Error("This run was stopped before admission.");
        const owned = health.sessions.find(
          (session) =>
            session.sessionId === binding.sessionId &&
            session.runId === input.runId,
        );
        if (recovered && owned)
          await client.reattach({
            ...identity,
            toolCapability: capability.capability,
            steering: Boolean(steering),
          });
        else await client.bind(request);
        const page = await client.eventsAfter(
          binding.sessionId,
          -1,
          recovered?.baseline,
        );
        let replaying = Boolean(recovered);
        const recoveredLifecycles = createEventLifecycles();
        projection = new DshEventProjection(
          binding.sessionId,
          (event) => {
            if (replaying) recoveredLifecycles.accept(event);
            else emit(event);
          },
          recovered?.input.messages ?? input.messages,
          new Set([requestId]),
        );
        projection.baseline(page.records, page.cursor);
        if (!recovered)
          await this.configuration.binding.journal?.accept({
            thread_id: input.threadId,
            run_id: input.runId,
            owner_user_id: scope.actorId,
            bot_id: scope.botId,
            session_id: binding.sessionId,
            binding_revision: binding.revision,
            generation: health.generation,
            baseline: page.cursor,
            input,
            initiator: scope.initiator ?? { kind: "person" },
            request_id: requestId,
          });
        emit({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        emit({
          type: EventType.CUSTOM,
          name: "chisabot.backend-owned-tools",
          value: { names: [...tools.keys()] },
        } as BaseEvent);
        const follow = new AbortController();
        followAbort = follow;
        let openedResolve!: () => void;
        let openedReject!: (error: unknown) => void;
        const opened = new Promise<void>((resolve, reject) => {
          openedResolve = resolve;
          openedReject = reject;
        });
        let streamError: unknown;
        let projectionFailures = 0;
        let reconnecting: Promise<void> | undefined;
        let awaitingCatchup = false;
        const reconnect = () =>
          (reconnecting ??= (async () => {
            if (!awaitingCatchup) {
              awaitingCatchup = true;
              emit({
                type: EventType.CUSTOM,
                name: "chisabot.connection",
                value: { status: "reconnecting" },
              } as BaseEvent);
            }
            let delay = 250;
            const reconnectStartedAt = Date.now();
            while (!follow.signal.aborted) {
              /*
               * 恢复接管的回合等不到完成事件就是死信：宿主机 5 分钟都不可达
               * 时按 interrupted 收尾，否则观察位会永远占着、排空被卡死。
               * 前台回合不受此限——它的执行主人可以随时手动停止。
               */
              if (recovered && Date.now() - reconnectStartedAt > 5 * 60_000) {
                this.executionSettled = true;
                await this.configuration.binding.journal?.status(
                  input.threadId,
                  input.runId,
                  "interrupted",
                );
                await this.configuration.binding.gateway.abandonRun(
                  input.runId,
                );
                throw new Error(
                  "执行内核持续不可达，本轮按未完成收尾。已完成的操作保留；未确认的操作需要核对后再继续。",
                );
              }
              try {
                // The launch token may change when the Host restarts; never reuse its old cookie.
                const address = JSON.parse(
                  await readFile(target.connectionFile, "utf8"),
                ) as { endpoint: string };
                const next = await DshHostClient.connect(address.endpoint);
                const current = await next.health();
                if (
                  current.generation !== health.generation ||
                  current.ownerUserId !== scope.actorId
                ) {
                  await sharedDshClientPool.invalidate(next);
                  // The old generation can no longer execute this run. Settle its observation
                  // just as the startup-recovery path does; pending approval/effect rows stay
                  // intact and are resumed only by their durable decision.
                  if (current.ownerUserId === scope.actorId) {
                    this.executionSettled = true;
                    await this.configuration.binding.journal?.status(
                      input.threadId,
                      input.runId,
                      "interrupted",
                    );
                    await this.configuration.binding.gateway.abandonRun(
                      input.runId,
                    );
                  }
                  throw new Error(
                    "DSH_HOST_RESTARTED: 运行内核已重启，这一轮需要恢复核对。",
                  );
                }
                const old = client;
                client = active.client = next;
                active.endpoint = address.endpoint;
                await sharedDshClientPool.invalidate(old);
                return;
              } catch (error) {
                if (
                  error instanceof Error &&
                  error.message.startsWith("DSH_HOST_RESTARTED:")
                )
                  throw error;
                await new Promise<void>((resolve) =>
                  setTimeout(resolve, delay),
                );
                delay = Math.min(delay * 2, 5000);
              }
            }
          })().finally(() => {
            reconnecting = undefined;
          }));
        const observing = (async () => {
          while (!follow.signal.aborted) {
            try {
              const followedClient = client;
              for await (const frame of followedClient.follow(
                binding.sessionId,
                follow.signal,
              )) {
                if (frame.type === "snapshot") {
                  if (frame.cursor > projection.cursor) {
                    const missing = await followedClient.eventsAfter(
                      binding.sessionId,
                      projection.cursor,
                      frame.cursor,
                      follow.signal,
                    );
                    for (const record of missing.records)
                      projection.durable(record.event);
                  }
                  projection.restoreLive(frame.assistantStream);
                  if (replaying) {
                    emit({
                      type: EventType.MESSAGES_SNAPSHOT,
                      messages: projection.snapshot(),
                    } as BaseEvent);
                    for (const opening of recoveredLifecycles.openings())
                      emit(opening);
                    replaying = false;
                  }
                  // A live transport alone is not a recovered transcript. Announce recovery
                  // only after this connection's persisted prefix and live snapshot are applied.
                  if (awaitingCatchup && followedClient === client) {
                    awaitingCatchup = false;
                    emit({
                      type: EventType.CUSTOM,
                      name: "chisabot.connection",
                      value: { status: "online" },
                    } as BaseEvent);
                  }
                  openedResolve();
                } else if (frame.type === "event") {
                  // Session event notifications precede persistence's bounded flush. Project
                  // contiguous non-settlement events immediately, while checkpointing settlements.
                  if (frame.event.seq > projection.cursor) {
                    if (
                      frame.event.seq === projection.cursor + 1 &&
                      !SETTLEMENT_EVENT_TYPES.has(frame.event.type)
                    ) {
                      projection.durable(frame.event);
                    } else {
                      const missing = await followedClient.eventsAfter(
                        binding.sessionId,
                        projection.cursor,
                        frame.event.seq,
                        follow.signal,
                      );
                      for (const record of missing.records)
                        projection.durable(record.event);
                    }
                  }
                } else projection.live(frame.frame as DshLiveFrame);
              }
              if (!follow.signal.aborted)
                throw new Error("DSH observation disconnected.");
            } catch (error) {
              if (follow.signal.aborted) return;
              if (
                error instanceof Error &&
                /DSH.*(gap|chunk|stream|settlement|prefix|baseline)|settled DSH/i.test(
                  error.message,
                )
              ) {
                projectionFailures++;
                if (projectionFailures >= 3) {
                  streamError = new Error(
                    "DSH 输出协议无法恢复，已停止这一轮。已完成的操作保留，请查看运行记录。",
                  );
                  await this.stopActive(active);
                  openedReject(streamError);
                  return;
                }
              }
              try {
                await reconnect();
              } catch (failure) {
                streamError = failure;
                openedReject(failure);
                return;
              }
            }
          }
        })();
        await opened;
        const admittedUserIds = new Set<string>();
        for (const record of page.records) {
          if (record.event.type !== "user/message") continue;
          const rpcId = (
            record.event.data as
              | { source?: { kind?: unknown; rpcId?: unknown } }
              | undefined
          )?.source?.rpcId;
          if (typeof rpcId === "string" && rpcId) admittedUserIds.add(rpcId);
        }
        const pendingInputs = inputs.filter(
          (message) => !admittedUserIds.has(message.id),
        );
        const content = dshUserContent(
          pendingInputs.length ? pendingInputs : [latest],
        );
        if (resolved.length)
          content.splice(0, content.length, {
            type: "text",
            text: `ChisaBot 已恢复并完成以下获授权操作。请根据这些真实回执继续，勿重复执行：\n${JSON.stringify(resolved.map((x) => ({ toolCallId: x.interruptId, result: x.payload })))}`,
          });
        const receipt = await client.receipt(
          binding.sessionId,
          input.runId,
          requestId,
        );
        if (!receipt.accepted && !recovered?.stop_requested)
          await client.prompt({
            sessionId: binding.sessionId,
            requestId,
            mode: "queue",
            content,
          });
        if (recovered?.stop_requested) active.abort.abort();
        await this.configuration.binding.journal?.status(
          input.threadId,
          input.runId,
          "observing",
        );
        let waitAfterSeq = page.cursor;
        for (;;) {
          let result: { reason: string };
          do {
            if (
              (
                await this.configuration.binding.journal?.get(
                  input.threadId,
                  input.runId,
                )
              )?.stop_requested
            )
              active.abort.abort();
            if (streamError) throw streamError;
            try {
              if (active.abort.signal.aborted) await this.stopActive(active);
              result = await client.wait(binding.sessionId, {
                timeoutMs: 10_000,
                afterSeq: waitAfterSeq,
              });
            } catch {
              if (streamError) throw streamError;
              await reconnect();
              result = { reason: "timeout" };
            }
            if (result.reason === "timeout" && recovered) {
              /*
               * 进程重启接管的回合只有在内核里还留着在途执行时才值得继续等。
               * 会话已空闲（prompt 随旧进程消失，也没有等待中的决议）意味着
               * 永远等不到完成事件——drain 会被卡死。按 interrupted 收尾，
               * 并把仍停在 dispatching 的操作统一落 outcome_unknown。
               */
              let alive = true;
              try {
                const status = await client.health();
                const session = status.sessions.find(
                  (x) => x.sessionId === binding.sessionId,
                );
                alive = Boolean(
                  session && (session.state !== "idle" || session.waiting),
                );
              } catch {
                // 探活失败按存活处理；下一次 wait 超时会重新检查。
              }
              if (!alive) {
                this.executionSettled = true;
                await this.configuration.binding.journal?.status(
                  input.threadId,
                  input.runId,
                  "interrupted",
                );
                await this.configuration.binding.gateway.abandonRun(
                  input.runId,
                );
                throw new Error(
                  "执行内核中已没有这一轮的在途执行，本轮按未完成收尾。已完成的操作保留；未确认的操作需要核对后再继续。",
                );
              }
            }
          } while (result.reason === "timeout");
          if (active.abort.signal.aborted)
            await this.configuration.binding.gateway.whenIdle(
              input.threadId,
              input.runId,
            );
          const settled = await client.eventsAfter(
            binding.sessionId,
            projection.cursor,
          );
          for (const record of settled.records)
            if (record.event.seq > projection.cursor)
              projection.durable(record.event);
          if (
            !active.abort.signal.aborted &&
            isSteerCutReason(projection.lastReason)
          ) {
            const steerCheck = await client.health();
            const activeSession = steerCheck.sessions.find(
              (x) => x.sessionId === binding.sessionId,
            );
            if (
              activeSession &&
              !activeSession.stopped &&
              activeSession.state !== "idle" &&
              !activeSession.waiting
            ) {
              waitAfterSeq = projection.cursor;
              continue;
            }
          }
          break;
        }
        this.executionSettled = true;
        follow.abort();
        await observing;
        if (streamError) throw streamError;
        const status = await client.health();
        const waiting = status.sessions.find(
          (x) => x.sessionId === binding.sessionId,
        )?.waiting;
        await this.configuration.binding.journal?.status(
          input.threadId,
          input.runId,
          waiting ? "waiting" : "projecting",
        );
        if (waiting) {
          emit({
            type: EventType.CUSTOM,
            name: "chisabot.headless.waiting",
            value: waiting,
          } as BaseEvent);
          const continuation = waiting.continuation as
            | { toolCallId?: string }
            | undefined;
          emit({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id:
                    continuation?.toolCallId ??
                    String(waiting.requestId ?? "approval"),
                  reason: "human_input",
                  message: String(waiting.message ?? "等待你的决定。"),
                  metadata: { [CHISABOT_WAITING_METADATA]: waiting },
                },
              ],
            },
          } as BaseEvent);
        } else if (
          active.abort.signal.aborted ||
          (projection.lastReason?.kind === "aborted" &&
            !isSteerCutReason(projection.lastReason))
        )
          emit({
            type: EventType.RUN_ERROR,
            code: "DSH_RUN_CANCELLED",
            message: "用户已停止这一轮。",
          } as BaseEvent);
        else if (
          (projection.lastReason?.kind === "error" ||
            projection.lastReason?.kind === "interrupted") &&
          !emptyReplyAfterDelivery(
            projection.lastReason,
            projection.snapshot(),
            input.messages,
          )
        )
          throw new Error(
            projection.lastReason.error?.message ??
              "DSH execution was interrupted.",
          );
        else
          emit({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            metadata: {
              ...(projection.model &&
              projection.model.model !== this.configuration.connection.model
                ? {
                    modelFallback: {
                      from: this.configuration.connection.model,
                      to: projection.model.model,
                      reason: "unavailable",
                    },
                  }
                : {}),
              ...(projection.usage ? { usage: projection.usage } : {}),
              ...(readStepUsage(projection.usage)
                ? {
                    contextUsage: {
                      ...readStepUsage(projection.usage),
                      model:
                        projection.model?.model ??
                        this.configuration.connection.model,
                    },
                  }
                : {}),
            },
          } as BaseEvent);
      };
      void work()
        .catch(async (error) => {
          // Leave an unreachable execution pending for reconciliation. A verified idle execution
          // can be closed; reporting its error must not make recovery automatically submit it again.
          if (active.client && active.sessionId) {
            try {
              const health = await active.client.health(
                AbortSignal.timeout(5000),
              );
              const owned = health.sessions.find(
                (session) =>
                  session.sessionId === active.sessionId &&
                  session.runId === active.runId,
              );
              if (owned?.state === "idle") {
                this.executionSettled = true;
                await this.configuration.binding.journal?.status(
                  input.threadId,
                  input.runId,
                  "interrupted",
                );
                await this.configuration.binding.gateway.abandonRun(
                  input.runId,
                );
              }
            } catch {
              /* The durable pending run remains the recovery owner's responsibility. */
            }
          }
          emit({
            type: EventType.RUN_ERROR,
            code: "DSH_RUNTIME_ERROR",
            message:
              error instanceof Error ? error.message : "DSH execution failed.",
          } as BaseEvent);
        })
        .finally(async () => {
          followAbort?.abort();
          capability?.close();
          active.toolAbort.abort(
            this.executionSettled ? PLAN_RUN_COMPLETED : undefined,
          );
          outerSignal?.removeEventListener("abort", onAbort);
          if (this.executionSettled && active.client && active.sessionId) {
            try {
              await active.client.release(
                active.sessionId,
                active.runId,
                AbortSignal.timeout(10_000),
              );
            } catch {
              /* An active or unreachable Host retains its execution; recovery reconciles it. */
            }
          }
          if (active.client) {
            if (
              this.executionSettled &&
              !active.abort.signal.aborted &&
              active.endpoint &&
              active.client.isConnected
            ) {
              sharedDshClientPool.release(active.endpoint, active.client);
            } else {
              await sharedDshClientPool.invalidate(active.client);
            }
          }
          if (this.active === active) this.active = undefined;
          subscriber.complete();
        });
      // A lost observer is not a Stop command: the execution continues and is persisted by its runner.
      return () => {};
    });
  }

  private stopActive(active: NonNullable<DshRuntimeAgent["active"]>) {
    active.abort.abort();
    active.toolAbort.abort();
    if (active.client && active.sessionId)
      active.stopping ??= active.client
        .stop(active.sessionId, active.runId)
        .catch((error) => {
          active.stopping = undefined;
          throw error;
        });
    return active.stopping;
  }
  async pushMidTurn(input: {
    id: string;
    message: Message;
    mode: "steer" | "queue";
  }): Promise<{ delivered: boolean; action?: "cut" | "next-step" | "queued" }> {
    const active = this.active;
    if (
      !active?.client ||
      !active.sessionId ||
      !active.input ||
      active.abort.signal.aborted
    )
      return { delivered: false };
    try {
      const prepared = this.configuration.prepareInput
        ? await this.configuration.prepareInput({
            ...active.input,
            messages: [input.message],
          })
        : { ...active.input, messages: [input.message] };
      const content = dshUserContent(prepared.messages);
      if (!content.length) return { delivered: false };
      const instructions = inboxInstructions([input.message]);
      if (input.mode === "steer") {
        const result = await active.client.steer({
          sessionId: active.sessionId,
          runId: active.runId,
          requestId: input.id,
          content,
          ...(instructions.length ? { instructions } : {}),
        });
        return { delivered: true, action: result.action };
      }
      await active.client.prompt({
        sessionId: active.sessionId,
        requestId: input.id,
        mode: "queue",
        content,
      });
      return { delivered: true, action: "queued" };
    } catch {
      return { delivered: false };
    }
  }

  async updateMidTurnQueue(input: {
    itemId: string;
    action:
      | { kind: "steer" }
      | { kind: "remove" }
      | { kind: "edit"; text: string };
  }): Promise<{ updated: boolean; action?: "cut" | "next-step" | "queued" }> {
    const active = this.active;
    if (!active?.client || !active.sessionId || active.abort.signal.aborted)
      return { updated: false };
    try {
      const result = await active.client.updateQueuedItem({
        sessionId: active.sessionId,
        runId: active.runId,
        itemId: input.itemId,
        action:
          input.action.kind === "edit"
            ? {
                kind: "edit",
                content: [{ type: "text", text: input.action.text }],
              }
            : input.action,
      });
      return {
        updated: result.accepted,
        ...(result.action ? { action: result.action } : {}),
      };
    } catch {
      return { updated: false };
    }
  }

  override abortRun() {
    if (this.active) void this.stopActive(this.active)?.catch(() => {});
  }
  override clone(): DshRuntimeAgent {
    return new DshRuntimeAgent(this.configuration);
  }
}
