import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  streamText,
  stepCountIs,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { Observable } from "rxjs";
import type { z } from "zod";

/** Compatibility for existing builtin bindings. New DSH bindings own their own loop. */
export type ClassicAgentConfiguration =
  | {
      model: LanguageModel;
      prompt?: string;
      apiKey?: string;
      maxSteps?: number;
      tools?: {
        name: string;
        description: string;
        parameters: z.ZodType;
        execute: (
          args: unknown,
          context?: { toolCallId: string; abortSignal?: AbortSignal },
        ) => Promise<unknown>;
      }[];
    }
  | {
      type: "custom";
      factory: () => AsyncIterable<BaseEvent>;
    };

const contentResult = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);
const resultOutput = (value: unknown) =>
  typeof value === "string"
    ? { type: "text" as const, value }
    : { type: "json" as const, value: value as never };

/** Product history stays AG-UI; only the provider boundary converts it to AI SDK messages. */
function modelMessages(input: RunAgentInput, prompt?: string): ModelMessage[] {
  const names = new Map<string, string>();
  for (const message of input.messages)
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? [])
        names.set(call.id, call.function.name);
    }
  const messages: ModelMessage[] = [];
  const system = [
    prompt,
    ...input.context.map(
      (context) => `${context.description}:\n${context.value}`,
    ),
  ];
  if (input.state && Object.keys(input.state).length)
    system.push(`Application state:\n${JSON.stringify(input.state)}`);
  if (system.some(Boolean))
    messages.push({
      role: "system",
      content: system.filter(Boolean).join("\n\n"),
    });
  const answered = new Set<string>();
  for (const message of input.messages) {
    if (message.role === "user") {
      if (typeof message.content === "string")
        messages.push({ role: "user", content: message.content });
      else {
        const content: Exclude<
          Extract<ModelMessage, { role: "user" }>["content"],
          string
        > = [];
        for (const part of message.content) {
          if (part.type === "text")
            content.push({ type: "text", text: part.text });
          else if ("source" in part) {
            const source = part.source;
            if (source.type === "file")
              throw new Error(
                "The attachment must be loaded before model execution.",
              );
            const data =
              source.type === "url" ? new URL(source.value) : source.value;
            if (part.type === "image")
              content.push({
                type: "image",
                image: data,
                mediaType: source.mimeType,
              });
            else
              content.push({
                type: "file",
                data,
                mediaType: source.mimeType ?? "application/octet-stream",
              });
          }
        }
        messages.push({ role: "user", content });
      }
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [
          ...(message.content
            ? [{ type: "text" as const, text: message.content }]
            : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.function.name,
            input: JSON.parse(call.function.arguments || "{}"),
          })),
        ],
      });
    } else if (message.role === "tool") {
      answered.add(message.toolCallId);
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: names.get(message.toolCallId) ?? "unknown",
            output: resultOutput(message.content),
          },
        ],
      });
    }
  }
  for (const entry of input.resume ?? [])
    if (!answered.has(entry.interruptId)) {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: entry.interruptId,
            toolName: names.get(entry.interruptId) ?? "unknown",
            output: resultOutput(
              entry.status === "cancelled"
                ? { status: "cancelled" }
                : (entry.payload ?? { status: "resolved" }),
            ),
          },
        ],
      });
    }
  return messages;
}

function configuredModel(
  config: Extract<ClassicAgentConfiguration, { model: unknown }>,
): LanguageModel {
  if (typeof config.model !== "string") return config.model;
  const slash = config.model.indexOf("/");
  const provider = config.model.slice(0, slash),
    model = config.model.slice(slash + 1);
  if (provider === "openai")
    return createOpenAI({ apiKey: config.apiKey })(model);
  if (provider === "anthropic")
    return createAnthropic({ apiKey: config.apiKey })(model);
  throw new Error(`Unsupported builtin model provider: ${provider}`);
}

/** AI SDK executes granted tools; this adapter only translates the stream into the shared wire contract. */
export class ClassicRuntimeAgent extends AbstractAgent {
  private abortController?: AbortController;
  constructor(readonly config: ClassicAgentConfiguration) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const controller = new AbortController();
      this.abortController = controller;
      const emit = (event: Record<string, unknown>) => {
        if (!observer.closed) observer.next(event as BaseEvent);
      };
      let textId: string | undefined, reasoningId: string | undefined;
      const calls = new Map<
        string,
        { started: boolean; args: boolean; ended: boolean }
      >();
      const closeText = () => {
        if (textId) emit({ type: "TEXT_MESSAGE_END", messageId: textId });
        textId = undefined;
      };
      const closeReasoning = () => {
        if (reasoningId) {
          emit({ type: "REASONING_MESSAGE_END", messageId: reasoningId });
          emit({ type: "REASONING_END", messageId: reasoningId });
        }
        reasoningId = undefined;
      };
      const startCall = (id: string, name: string) => {
        let state = calls.get(id);
        if (!state) {
          state = { started: true, args: false, ended: false };
          calls.set(id, state);
          emit({
            type: "TOOL_CALL_START",
            toolCallId: id,
            toolCallName: name,
            parentMessageId: textId ?? crypto.randomUUID(),
          });
        }
        return state;
      };
      const work = async () => {
        emit({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        });
        if ("factory" in this.config) {
          for await (const event of this.config.factory())
            emit(event as unknown as Record<string, unknown>);
          emit({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          });
          return;
        }
        const tools: ToolSet = Object.fromEntries(
          input.tools.map((tool) => [
            tool.name,
            {
              description: tool.description,
              inputSchema: jsonSchema(tool.parameters),
            },
          ]),
        );
        for (const tool of this.config.tools ?? [])
          tools[tool.name] = {
            description: tool.description,
            inputSchema: tool.parameters as never,
            execute: (args, context) => tool.execute(args, context),
          };
        const messages = modelMessages(input, this.config.prompt);
        const system =
          messages[0]?.role === "system"
            ? (messages.shift() as Extract<ModelMessage, { role: "system" }>)
                .content
            : undefined;
        const stream = streamText({
          model: configuredModel(this.config),
          messages,
          system,
          tools,
          stopWhen: stepCountIs(this.config.maxSteps ?? 1),
          abortSignal: controller.signal,
        });
        for await (const part of stream.fullStream) {
          if (observer.closed) return;
          switch (part.type) {
            case "text-start":
              closeReasoning();
              closeText();
              textId = crypto.randomUUID();
              emit({
                type: "TEXT_MESSAGE_START",
                messageId: textId,
                role: "assistant",
              });
              break;
            case "text-delta":
              if (!textId) {
                textId = crypto.randomUUID();
                emit({
                  type: "TEXT_MESSAGE_START",
                  messageId: textId,
                  role: "assistant",
                });
              }
              emit({
                type: "TEXT_MESSAGE_CONTENT",
                messageId: textId,
                delta: part.text,
              });
              break;
            case "text-end":
              closeText();
              break;
            case "reasoning-start":
              closeText();
              closeReasoning();
              reasoningId = crypto.randomUUID();
              emit({ type: "REASONING_START", messageId: reasoningId });
              emit({
                type: "REASONING_MESSAGE_START",
                messageId: reasoningId,
                role: "reasoning",
              });
              break;
            case "reasoning-delta":
              emit({
                type: "REASONING_MESSAGE_CONTENT",
                messageId: reasoningId,
                delta: part.text,
              });
              break;
            case "reasoning-end":
              closeReasoning();
              break;
            case "tool-input-start":
              closeReasoning();
              startCall(part.id, part.toolName);
              break;
            case "tool-input-delta": {
              const state = calls.get(part.id);
              if (state) state.args = true;
              emit({
                type: "TOOL_CALL_ARGS",
                toolCallId: part.id,
                delta: part.delta,
              });
              break;
            }
            case "tool-call": {
              const state = startCall(part.toolCallId, part.toolName);
              if (!state.args)
                emit({
                  type: "TOOL_CALL_ARGS",
                  toolCallId: part.toolCallId,
                  delta: JSON.stringify(part.input),
                });
              if (!state.ended)
                emit({ type: "TOOL_CALL_END", toolCallId: part.toolCallId });
              state.ended = true;
              break;
            }
            case "tool-result":
              emit({
                type: "TOOL_CALL_RESULT",
                toolCallId: part.toolCallId,
                messageId: crypto.randomUUID(),
                role: "tool",
                content: contentResult(part.output),
              });
              break;
            case "tool-error":
              emit({
                type: "TOOL_CALL_RESULT",
                toolCallId: part.toolCallId,
                messageId: crypto.randomUUID(),
                role: "tool",
                content: contentResult({
                  error:
                    part.error instanceof Error
                      ? part.error.message
                      : String(part.error),
                }),
              });
              break;
            case "error":
              throw part.error;
            case "abort":
              controller.signal.throwIfAborted();
              throw new Error("The model execution was interrupted.");
            case "finish":
              closeReasoning();
              closeText();
              emit({
                type: "RUN_FINISHED",
                threadId: input.threadId,
                runId: input.runId,
                metadata: {
                  finishReason: part.finishReason,
                  usage: part.totalUsage,
                },
              });
              return;
          }
        }
        controller.signal.throwIfAborted();
        throw new Error("The model stream ended without a finish event.");
      };
      void work()
        .catch((error) => {
          closeReasoning();
          closeText();
          emit({
            type: "RUN_ERROR",
            message: error instanceof Error ? error.message : String(error),
          });
          observer.error(error);
        })
        .finally(() => {
          if (this.abortController === controller)
            this.abortController = undefined;
          observer.complete();
        });
      return () => controller.abort();
    });
  }

  override abortRun() {
    this.abortController?.abort();
    super.abortRun();
  }
  override clone() {
    return new ClassicRuntimeAgent(this.config);
  }
}
