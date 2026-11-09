import { setTimeout as delay } from "node:timers/promises";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";

const fallbackCodes = new Set([
  "QUOTA",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "EMPTY_RESPONSE",
  "UNKNOWN_MODEL",
  "NO_ADAPTER",
  // HTTP 400 (the Hermes adapter's "400 retry"): this candidate rejected the request as built,
  // so the next configured candidate gets the same tools and prompt; never the same model again.
  "INVALID_REQUEST",
]);

function routeFailure(failure, choice, index) {
  // PiAi leaves HTTP 404/410 as PI_AI_ERROR. A stale-but-explicit model route is a
  // missing candidate, so another configured candidate may still answer this request.
  const missing =
    failure.code === "PI_AI_ERROR" &&
    /\b(?:404|410)\b|model.{0,80}(?:not found|does not exist|retired|deprecated)/i.test(
      failure.message,
    );
  return {
    ...failure,
    code: missing ? "UNKNOWN_MODEL" : failure.code,
    message: `${index ? "备用模型" : "主模型"}「${choice.model}」请求失败：${failure.message}`,
  };
}

/** A stable session/model route with run-scoped credentials and retry state. */
export class ChisaModelRouter extends LlmAdapter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.routes = new Map();
  }

  bind(id, input, runId) {
    const candidates = [input.primary, ...(input.fallbacks ?? [])];
    if (
      !candidates.length ||
      candidates.some(
        (x) => !x.provider || !x.model || x.provider === "chisabot",
      )
    ) {
      throw new Error("Model routes require a concrete provider and model.");
    }
    this.routes.set(id, {
      runId,
      candidates,
      index: 0,
      firstOutputMs: input.firstOutputMs ?? 0,
      contextWindow: input.contextWindow,
      skipped: [],
      retryStep: "",
      sameModelRetries: 0,
    });
  }

  route(id) {
    const route = this.routes.get(id);
    if (!route)
      throw new LlmError(
        "The conversation model route has not been bound by ChisaBot.",
        "UNKNOWN_MODEL",
      );
    return route;
  }

  providerInfo() {
    return { id: "chisabot", name: "ChisaBot managed model route" };
  }

  async resolveModel(provider, id, signal) {
    return (await this.prepareCall(provider, id, signal)).model;
  }

  metadata(provider, id, prepared) {
    const contextWindow = this.route(id).contextWindow;
    return {
      provider,
      id,
      name: id,
      ...(prepared.context
        ? {
            context: {
              ...prepared.context,
              ...(contextWindow
                ? {
                    contextWindow: Math.min(
                      contextWindow,
                      prepared.context.contextWindow,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(prepared.inputModalities
        ? { inputModalities: prepared.inputModalities }
        : {}),
      ...(prepared.config.maxTokens
        ? { defaultMaxTokens: prepared.config.maxTokens }
        : {}),
      ...(prepared.config.reasoningEffort
        ? {
            reasoning: {
              efforts: [
                {
                  id: prepared.config.reasoningEffort,
                  name: prepared.config.reasoningEffort,
                },
              ],
              defaultEffort: prepared.config.reasoningEffort,
            },
          }
        : {}),
    };
  }

  async prepareCall(provider, id, signal) {
    const route = this.route(id);
    let prepared;
    while (!prepared) {
      const choice = route.candidates[route.index];
      try {
        prepared = await this.ctx.llm.prepareCall(choice, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (
          !fallbackCodes.has(error.code) ||
          route.index + 1 >= route.candidates.length
        ) {
          if (!(error instanceof LlmError)) throw error;
          const failure = routeFailure(error.failure, choice, route.index);
          throw new LlmError(failure.message, failure.code, {
            ...error.failure,
            cause: error,
          });
        }
        route.skipped.push({ ...choice, code: error.code });
        route.index++;
      }
    }
    const choice = route.candidates[route.index];
    const ctx = this.ctx;
    return {
      model: this.metadata(provider, id, prepared),
      stream: (options) =>
        (async function* () {
          // Auxiliary compaction has its own bounded output budget. Prepare that concrete
          // call with its budget instead of overwriting the immutable provider envelope.
          const dispatch =
            options.purpose === "compaction" &&
            options.maxTokens !== undefined &&
            options.maxTokens !== prepared.config.maxTokens
              ? await ctx.llm.prepareCall(
                  { ...choice, maxTokens: options.maxTokens },
                  options.signal,
                )
              : prepared;
          const session =
            options.sessionId && ctx.sessions.get(options.sessionId);
          if (session) {
            appendPluginRecord(session, "plugin:chisabot/model-route", {
              routeId: id,
              runId: route.runId,
              provider: choice.provider,
              model: choice.model,
              candidate: route.index,
              skipped: route.skipped.splice(0),
              ...(route.lastFailure ? { reason: route.lastFailure } : {}),
            });
            await ctx.sessions.flush(session);
          }
          const abort = new AbortController();
          const relay = () => abort.abort(options.signal.reason);
          options.signal?.addEventListener("abort", relay, { once: true });
          if (options.signal?.aborted) relay();
          const wait = route.candidates.length > 1 ? route.firstOutputMs : 0;
          let timer =
            wait > 0
              ? setTimeout(
                  () => abort.abort(new Error("MODEL_FIRST_OUTPUT_TIMEOUT")),
                  wait,
                )
              : undefined;
          try {
            // Native replay state belongs to the actual provider, never to a logical route.
            const messages = options.messages.map((message) =>
              message.role === "assistant" && message.source?.replayState
                ? {
                    ...message,
                    source: {
                      kind: "model",
                      provider: message.source.provider,
                      model: message.source.model,
                    },
                  }
                : message,
            );
            for await (const chunk of dispatch.stream({
              ...options,
              ...dispatch.config,
              messages,
              signal: abort.signal,
            })) {
              if (
                chunk.type === "text-delta" ||
                chunk.type === "reasoning-delta" ||
                chunk.type === "tool-call-delta"
              ) {
                clearTimeout(timer);
                timer = undefined;
              }
              if (chunk.type === "finish") {
                if (abort.signal.aborted && !options.signal?.aborted) {
                  yield {
                    type: "finish",
                    reason: {
                      kind: "error",
                      failure: routeFailure(
                        {
                          code: "TIMEOUT",
                          message:
                            "Model produced no output within the configured fallback deadline.",
                        },
                        choice,
                        route.index,
                      ),
                    },
                  };
                } else {
                  const { replayState: _privateReplay, ...safe } = chunk;
                  yield safe.reason.kind === "error"
                    ? {
                        ...safe,
                        reason: {
                          ...safe.reason,
                          failure: routeFailure(
                            safe.reason.failure,
                            choice,
                            route.index,
                          ),
                        },
                      }
                    : safe;
                }
              } else yield chunk;
            }
          } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", relay);
          }
        })(),
    };
  }

  async retry(agent, { failure, turn, step, signal }) {
    const model = agent.model.current();
    if (model?.provider !== "chisabot") return false;
    const route = this.route(model.model);
    const position = `${turn}:${step}:${route.index}`;
    if (route.retryStep !== position) {
      route.retryStep = position;
      route.sameModelRetries = 0;
    }
    route.lastFailure = { code: failure.code, message: failure.message };
    if (
      ["SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"].includes(
        failure.code,
      ) &&
      route.sameModelRetries < 1
    ) {
      route.sameModelRetries++;
      await delay(500, undefined, { signal });
      return true;
    }
    if (
      !fallbackCodes.has(failure.code) ||
      route.index + 1 >= route.candidates.length
    )
      return false;
    route.index++;
    return true;
  }

  stream() {
    throw new Error("ChisaBot routes require prepared dispatch.");
  }
}
