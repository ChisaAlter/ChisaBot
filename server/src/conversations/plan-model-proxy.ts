import { PlanModel, type PlanModelConfig, type PlanLanguageModel } from "../agents/plan-model";
import type { RunAgentInput } from "@ag-ui/client";

type Prompt = Parameters<PlanLanguageModel["doStream"]>[0]["prompt"];

/** Translate only model traffic. DSH still owns the loop and ChisaBot owns all executors. */
export function createPlanModelProxy(config: PlanModelConfig, botId: string, input: RunAgentInput, toolNames: readonly string[], signal: AbortSignal) {
  const model = new PlanModel(config, botId, input, new Set(toolNames), signal);
  return async (body: any, requestSignal: AbortSignal) => {
    if (!Array.isArray(body.messages) || !Array.isArray(body.tools ?? [])) throw new Error("Invalid plan model request.");
    const allowed = new Set(toolNames);
    const tools = (body.tools ?? []).map((tool: any) => {
      if (tool.type !== "function" || !allowed.has(tool.function?.name)) throw new Error("The plan request contains an ungranted tool.");
      return { type: "function" as const, name: tool.function.name, description: tool.function.description ?? "", inputSchema: tool.function.parameters };
    });
    const prompt: Prompt = body.messages.map((message: any) => {
      if (message.role === "system" || message.role === "developer") return { role: "system", content: String(message.content ?? "") };
      if (message.role === "tool") return { role: "tool", content: [{ type: "tool-result", toolCallId: message.tool_call_id, toolName: "", output: { type: "text", value: String(message.content ?? "") } }] };
      if (message.role === "assistant") return { role: "assistant", content: [
        ...(typeof message.content === "string" && message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call: any) => ({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input: JSON.parse(call.function.arguments) })),
      ] };
      if (message.role !== "user") throw new Error("Unsupported plan message role.");
      return { role: "user", content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map((part: any) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type !== "image_url" || typeof part.image_url?.url !== "string") throw new Error("Unsupported plan attachment.");
        const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
        return { type: "file", mediaType: match?.[1] ?? "image/*", data: match ? match[2] : new URL(part.image_url.url) };
      }) };
    });
    const abort = new AbortController();
    const result = await model.doStream({ prompt, tools, abortSignal: AbortSignal.any([signal, requestSignal, abort.signal]) });
    const reader = result.stream.getReader();
    const encoder = new TextEncoder();
    const id = crypto.randomUUID();
    const calls = new Map<string, number>();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (delta: unknown, finish_reason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model.modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
        try {
          while (true) {
            const { value: part, done } = await reader.read();
            if (done) break;
            if (part.type === "text-delta") emit({ content: part.delta });
            else if (part.type === "tool-input-start") {
              const index = calls.size; calls.set(part.id, index);
              emit({ tool_calls: [{ index, id: part.id, type: "function", function: { name: part.toolName, arguments: "" } }] });
            } else if (part.type === "tool-input-delta") emit({ tool_calls: [{ index: calls.get(part.id), function: { arguments: part.delta } }] });
            else if (part.type === "error") throw part.error;
            else if (part.type === "finish") {
              emit({}, part.finishReason.unified === "tool-calls" ? "tool_calls" : "stop");
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close(); return;
            }
          }
          throw new Error("The plan model ended without a completion receipt.");
        } catch (error) { controller.error(error); }
      },
      cancel() { abort.abort(); return reader.cancel(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  };
}
