/**
 * One model call for a few words. Not a Bot and not a turn: a title is not said to anybody and is
 * not part of the conversation it names, so there is no runtime work and no thread to hold.
 */
import { PlanModel } from "../agents/plan-model";
import type {
  RuntimeModel,
  RuntimeModelResolver,
} from "../conversation-runtime";
import { runtimeModelEndpoint } from "../routing/model";

/** Rules, not an example: a model copies an example's subject as readily as its shape. */
const INSTRUCTION = [
  "You name conversations, like a title in a sidebar.",
  "Answer with three to six words naming what the conversation is about.",
  "No quotation marks, no trailing period, no prefix such as 'Conversation about'.",
  "Name the subject itself, not the fact that somebody asked about it.",
].join(" ");

export type TitlerOptions = {
  /** The model to ask, from the tenant package. */
  model: string;
  /** Resolved per call, so a rotated credential is picked up without a restart. */
  resolveApiKey: () => Promise<string | null>;
  /** One coherent connection snapshot for this call, including settings saved after startup. */
  resolveConnection?: RuntimeModelResolver;
  environment?: Record<string, string | undefined>;
  /** Injectable so a test drives this without a network. */
  fetchImpl?: typeof fetch;
  /** How long one call may take before it is given up on. */
  timeoutMs?: number;
};

/** No key resolves to null and is not retried; a provider error throws, so the queue retries it. */
export function createChannelTitler(options: TitlerOptions) {
  const call = options.fetchImpl ?? fetch;

  return async (excerpt: string): Promise<string | null> => {
    const connection = await options.resolveConnection?.();
    const model: RuntimeModel = connection?.model ?? {
      provider: "openai",
      defaultModel: options.model,
    };
    if (model.plan) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 20_000,
      );
      try {
        const result = await new PlanModel(
          model.plan,
          "channel-title",
          { threadId: crypto.randomUUID() },
          new Set(),
          controller.signal,
        ).doGenerate({
          prompt: [
            { role: "system", content: INSTRUCTION },
            { role: "user", content: [{ type: "text", text: excerpt }] },
          ],
          maxOutputTokens: 512,
          abortSignal: controller.signal,
        });
        const text = result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("")
          .trim();
        return text || null;
      } catch {
        throw new Error(
          "The configured plan could not name this conversation.",
        );
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
    const apiKey = connection
      ? connection.apiKey
      : await options.resolveApiKey();
    if (!apiKey && model.useApiKey !== false) return null;
    const anthropic = model.provider === "anthropic";

    const response = await call(
      runtimeModelEndpoint(model, options.environment ?? process.env),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(anthropic
            ? {
                "anthropic-version": "2023-06-01",
                ...(model.useApiKey === false
                  ? {}
                  : { "x-api-key": apiKey ?? "" }),
              }
            : model.useApiKey === false
              ? {}
              : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({
          model: model.defaultModel,
          ...(anthropic
            ? {
                system: INSTRUCTION,
                messages: [{ role: "user", content: excerpt }],
                max_tokens: 512,
              }
            : {
                messages: [
                  { role: "system", content: INSTRUCTION },
                  { role: "user", content: excerpt },
                ],
                // Reasoning tokens come out of this budget, so a cap sized for the answer alone 400s.
                max_completion_tokens: 512,
              }),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        redirect: "error",
      },
    ).catch(() => {
      throw new Error("The conversation title model could not be reached.");
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `The model refused to name a conversation (${response.status}).`,
      );
    }

    const body = (await response.json().catch(() => {
      throw new Error("The conversation title model returned invalid JSON.");
    })) as {
      choices?: { message?: { content?: unknown } }[];
      content?: { type?: string; text?: unknown }[];
    };
    const content = anthropic
      ? body.content
          ?.filter(
            (part) => part.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("")
      : body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const answer = content.trim();
    return answer.length > 0 ? answer : null;
  };
}
