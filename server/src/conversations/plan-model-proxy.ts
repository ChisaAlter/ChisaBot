import type { RunAgentInput } from "@ag-ui/client";
import {
  type PlanLanguageModel,
  PlanModel,
  type PlanModelConfig,
} from "../agents/plan-model";
import { reasonWithoutStatement } from "../db/query-failure";
import { QuotaExceededError, type QuotaReservation } from "../quotas/service";
import {
  buildQuotaExceededResponse,
  type ModelProxyQuotaOptions,
} from "./model-connection-proxy";

export type PlanModelProxyOptions = {
  quota?: ModelProxyQuotaOptions;
  estimatePromptChars?: (bodyText: string) => number;
  now?: () => number;
};

type StreamOptions = Parameters<PlanLanguageModel["doStream"]>[0];
type Prompt = StreamOptions["prompt"];
type FunctionTool = Extract<
  NonNullable<StreamOptions["tools"]>[number],
  { type: "function" }
>;

/** The OpenAI chat-completions request DSH sends, as far as the plan proxy reads it. */
type ChatTool = {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
};
type ChatPart = { type?: string; text?: string; image_url?: { url?: unknown } };
type ChatMessage = {
  role?: string;
  content?: string | ChatPart[] | null;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};

/** Translate only model traffic. DSH still owns the loop and ChisaBot owns all executors. */
export function createPlanModelProxy(
  config: PlanModelConfig,
  botId: string,
  input: RunAgentInput,
  toolNames: readonly string[],
  signal: AbortSignal,
  options?: PlanModelProxyOptions,
) {
  const model = new PlanModel(config, botId, input, new Set(toolNames), signal);
  const nowFn = options?.now ?? Date.now;
  return async (body: unknown, requestSignal: AbortSignal) => {
    const request = (body ?? {}) as {
      model?: unknown;
      messages?: unknown;
      tools?: unknown;
      max_tokens?: unknown;
      max_completion_tokens?: unknown;
    };
    if (!Array.isArray(request.messages) || !Array.isArray(request.tools ?? []))
      throw new Error("Invalid plan model request.");
    const allowed = new Set(toolNames);
    const tools = ((request.tools ?? []) as ChatTool[]).map(
      (tool): FunctionTool => {
        const name = tool.function?.name;
        if (tool.type !== "function" || !name || !allowed.has(name))
          throw new Error("The plan request contains an ungranted tool.");
        return {
          type: "function",
          name,
          description: tool.function?.description ?? "",
          inputSchema: tool.function?.parameters as FunctionTool["inputSchema"],
        };
      },
    );
    const messages = request.messages as ChatMessage[];
    const prompt: Prompt = messages.map((message): Prompt[number] => {
      if (message.role === "system" || message.role === "developer")
        return { role: "system", content: String(message.content ?? "") };
      if (message.role === "tool")
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: String(message.tool_call_id ?? ""),
              toolName: "",
              output: { type: "text", value: String(message.content ?? "") },
            },
          ],
        };
      if (message.role === "assistant")
        return {
          role: "assistant",
          content: [
            ...(typeof message.content === "string" && message.content
              ? [{ type: "text" as const, text: message.content }]
              : []),
            ...(message.tool_calls ?? []).map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.function.name,
              input: JSON.parse(call.function.arguments),
            })),
          ],
        };
      if (message.role !== "user")
        throw new Error("Unsupported plan message role.");
      const content = message.content;
      if (typeof content !== "string" && !Array.isArray(content))
        throw new Error("Unsupported plan message content.");
      return {
        role: "user",
        content:
          typeof content === "string"
            ? [{ type: "text", text: content }]
            : content.map((part) => {
                if (part.type === "text")
                  return {
                    type: "text" as const,
                    text: String(part.text ?? ""),
                  };
                const url = part.image_url?.url;
                if (part.type !== "image_url" || typeof url !== "string")
                  throw new Error("Unsupported plan attachment.");
                const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
                return {
                  type: "file" as const,
                  mediaType: match?.[1] ?? "image/*",
                  data: match ? (match[2] ?? "") : new URL(url),
                };
              }),
      };
    });
    const bodyText = JSON.stringify(body ?? {});
    const requestChars = options?.estimatePromptChars
      ? Math.max(0, options.estimatePromptChars(bodyText))
      : bodyText.length;
    const modelName =
      typeof request.model === "string" && request.model.trim()
        ? request.model.trim()
        : model.modelId;
    const declaredMaxOutput = [
      request.max_tokens,
      request.max_completion_tokens,
    ].find(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    );

    let reservation: QuotaReservation | null = null;
    if (options?.quota) {
      try {
        reservation = await options.quota.admit({
          userId: options.quota.userId,
          isAdmin: options.quota.isAdmin ?? false,
          model: modelName,
          requestChars,
          maxOutputTokens: declaredMaxOutput,
          now: nowFn(),
        });
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          return buildQuotaExceededResponse(error);
        }
        throw error;
      }
    }
    const releaseReservation = () => {
      const quota = options?.quota;
      if (!reservation || !quota) return;
      const released = reservation;
      reservation = null;
      Promise.resolve(
        quota.recordUsage({
          userId: quota.userId,
          model: released.model,
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          now: nowFn(),
          reservation: released,
        }),
      ).catch((error) => {
        console.warn(
          JSON.stringify({
            type: "quota-reservation-release-failed",
            userId: quota.userId,
            model: released.model,
            reason: reasonWithoutStatement(error),
          }),
        );
      });
    };

    const abort = new AbortController();
    let result: Awaited<ReturnType<PlanLanguageModel["doStream"]>>;
    try {
      result = await model.doStream({
        prompt,
        tools,
        abortSignal: AbortSignal.any([signal, requestSignal, abort.signal]),
      });
    } catch (error) {
      releaseReservation();
      throw error;
    }
    const reader = result.stream.getReader();
    const encoder = new TextEncoder();
    const id = crypto.randomUUID();
    const calls = new Map<string, number>();
    let outputChars = 0;
    let recorded = false;
    const recordOnce = (usage?: {
      inputTokens?: { total?: number; cacheRead?: number };
      outputTokens?: { total?: number };
    }) => {
      const quota = options?.quota;
      if (recorded || !quota) return;
      recorded = true;
      const rawIn = usage?.inputTokens?.total;
      const rawOut = usage?.outputTokens?.total;
      const rawCache = usage?.inputTokens?.cacheRead;
      const finalIn =
        typeof rawIn === "number" && Number.isFinite(rawIn) && rawIn >= 0
          ? Math.floor(rawIn)
          : Math.ceil(Math.max(0, requestChars) / 4);
      const finalOut =
        typeof rawOut === "number" && Number.isFinite(rawOut) && rawOut >= 0
          ? Math.floor(rawOut)
          : Math.ceil(Math.max(0, outputChars) / 4);
      const finalCache =
        typeof rawCache === "number" &&
        Number.isFinite(rawCache) &&
        rawCache >= 0
          ? Math.floor(rawCache)
          : 0;
      const settled = reservation;
      reservation = null;
      Promise.resolve(
        quota.recordUsage({
          userId: quota.userId,
          model: modelName,
          inputTokens: finalIn,
          outputTokens: finalOut,
          cacheReadTokens: finalCache,
          requests: 1,
          now: nowFn(),
          ...(settled ? { reservation: settled } : {}),
        }),
      ).catch((error) => {
        // 异步记账失败不阻塞计划模型流式响应，但必须可观测。
        console.warn(
          JSON.stringify({
            type: "quota-usage-record-failed",
            userId: quota.userId,
            model: modelName,
            reason: reasonWithoutStatement(error),
          }),
        );
      });
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (delta: unknown, finish_reason: string | null = null) =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model.modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            ),
          );
        try {
          while (true) {
            const { value: part, done } = await reader.read();
            if (done) break;
            if (part.type === "text-delta") {
              outputChars += part.delta.length;
              emit({ content: part.delta });
            } else if (part.type === "tool-input-start") {
              const index = calls.size;
              calls.set(part.id, index);
              outputChars += part.toolName.length;
              emit({
                tool_calls: [
                  {
                    index,
                    id: part.id,
                    type: "function",
                    function: { name: part.toolName, arguments: "" },
                  },
                ],
              });
            } else if (part.type === "tool-input-delta") {
              outputChars += part.delta.length;
              emit({
                tool_calls: [
                  {
                    index: calls.get(part.id),
                    function: { arguments: part.delta },
                  },
                ],
              });
            } else if (part.type === "error") throw part.error;
            else if (part.type === "finish") {
              recordOnce(part.usage);
              emit(
                {},
                part.finishReason.unified === "tool-calls"
                  ? "tool_calls"
                  : "stop",
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
          }
          throw new Error("The plan model ended without a completion receipt.");
        } catch (error) {
          recordOnce();
          controller.error(error);
        }
      },
      cancel() {
        recordOnce();
        abort.abort();
        return reader.cancel();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  };
}
