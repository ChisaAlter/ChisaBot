import type { RunAgentInput } from "@ag-ui/client";
import {
  type PlanLanguageModel,
  PlanModel,
  type PlanModelConfig,
} from "../agents/plan-model";

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
) {
  const model = new PlanModel(config, botId, input, new Set(toolNames), signal);
  return async (body: unknown, requestSignal: AbortSignal) => {
    const request = (body ?? {}) as { messages?: unknown; tools?: unknown };
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
    const abort = new AbortController();
    const result = await model.doStream({
      prompt,
      tools,
      abortSignal: AbortSignal.any([signal, requestSignal, abort.signal]),
    });
    const reader = result.stream.getReader();
    const encoder = new TextEncoder();
    const id = crypto.randomUUID();
    const calls = new Map<string, number>();
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
            if (part.type === "text-delta") emit({ content: part.delta });
            else if (part.type === "tool-input-start") {
              const index = calls.size;
              calls.set(part.id, index);
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
            } else if (part.type === "tool-input-delta")
              emit({
                tool_calls: [
                  {
                    index: calls.get(part.id),
                    function: { arguments: part.delta },
                  },
                ],
              });
            else if (part.type === "error") throw part.error;
            else if (part.type === "finish") {
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
          controller.error(error);
        }
      },
      cancel() {
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
