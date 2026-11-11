import { setTimeout as delay } from "node:timers/promises";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";
import { redactFailureText } from "./redact.mjs";

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

/**
 * Model breaker (parity with the Hermes adapter, #466 / QA1102-06): a candidate that just failed
 * as unusable — down, timing out, rate limited, missing, rejecting requests — is skipped by every
 * later turn of this Host for a cooldown, so a dead primary does not cost each reply its full
 * timeout again. After the cooldown one turn probes it (half-open); success closes the breaker,
 * another failure reopens it for twice as long, up to the cap. A turn with no healthy candidate
 * still tries its primary rather than failing outright.
 */
const breakerCodes = new Set([
  "QUOTA",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "EMPTY_RESPONSE",
  "UNKNOWN_MODEL",
  "INVALID_REQUEST",
]);
const PROBE_STALE_MS = 300_000;
const seconds = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export class ModelBreakers {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.entries = new Map();
  }
  get baseMs() {
    return seconds("CHISABOT_MODEL_BREAKER_COOLDOWN_S", 60) * 1000;
  }
  get maxMs() {
    return seconds("CHISABOT_MODEL_BREAKER_MAX_COOLDOWN_S", 600) * 1000;
  }
  /** The open entry while it still gates this key, else undefined. */
  cooling(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.probing) {
      if (now - entry.probeStarted < PROBE_STALE_MS) return entry;
      entry.probing = false;
    }
    return entry.openUntil > now ? entry : undefined;
  }
  /** An expired breaker lets exactly one turn probe the model; others keep skipping it. */
  probe(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.probing) return;
    entry.probing = true;
    entry.probeStarted = this.now();
  }
  fail(key, reason) {
    const entry = this.entries.get(key) ?? {
      opens: 0,
      openUntil: 0,
      probing: false,
      probeStarted: 0,
    };
    entry.reason = reason;
    entry.probing = false;
    const now = this.now();
    if (entry.openUntil <= now) {
      entry.openUntil =
        now + Math.min(this.baseMs * 2 ** entry.opens, this.maxMs);
      entry.opens++;
    }
    this.entries.set(key, entry);
  }
  ok(key) {
    this.entries.delete(key);
  }
}

const breakerKey = (candidate) =>
  candidate.breakerKey ?? `${candidate.provider}\u0000${candidate.model}`;

export const isLocalPrivacyGateFailure = (failure) =>
  /\bprivacy-gate:/i.test(String(failure?.message ?? ""));

function stripPriorRejectedImages(messages) {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex <= 0) return messages;
  return messages.map((message, index) => {
    if (
      index >= lastUserIndex ||
      message?.role !== "user" ||
      !Array.isArray(message.content) ||
      !message.content.some((part) => part?.type === "image")
    ) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) =>
        part?.type === "image"
          ? {
              type: "text",
              text: "[上一轮图片未发送：网关本地隐私脱敏仅支持文字]",
            }
          : part,
      ),
    };
  });
}

function routeFailure(failure, choice, index) {
  // PiAi leaves HTTP 404/410 as PI_AI_ERROR. A stale-but-explicit model route is a
  // missing candidate, so another configured candidate may still answer this request.
  const missing =
    failure.code === "PI_AI_ERROR" &&
    /\b(?:404|410)\b|model.{0,80}(?:not found|does not exist|retired|deprecated)/i.test(
      failure.message,
    );
  // LlmFailure's other fields are structured (status, retry-after, request id, offload count);
  // the upstream text is masked and capped (QA510 P3): this object is what the session stores.
  return {
    ...failure,
    code: missing ? "UNKNOWN_MODEL" : failure.code,
    message: `${index ? "备用模型" : "主模型"}「${choice.model}」请求失败：${redactFailureText(failure.message)}`,
  };
}

/** Seconds for a user-facing sentence: one decimal under ten, whole above. */
const spokenSeconds = (ms) =>
  ms < 10_000 ? Math.round(ms / 100) / 10 : Math.round(ms / 1000);

/** First-output budget multiplier when a route has no fallback to switch to. */
export const SINGLE_MODEL_DEADLINE_FACTOR = 4;

/** A stable session/model route with run-scoped credentials and retry state. */
export class ChisaModelRouter extends LlmAdapter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.routes = new Map();
    this.breakers = new ModelBreakers();
    this.privacyBlockedSessions = new Set();
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
    const keys = candidates.map(breakerKey);
    const clean = candidates.map(
      ({ breakerKey: _key, ...candidate }) => candidate,
    );
    // Primary first while its breaker is closed; while it cools, the first healthy fallback.
    let index = 0;
    const skipped = [];
    const cooling = this.breakers.cooling(keys[0]);
    if (cooling) {
      const healthy = keys.findIndex(
        (key, position) => position > 0 && !this.breakers.cooling(key),
      );
      if (healthy > 0) {
        index = healthy;
        for (let position = 0; position < healthy; position++)
          skipped.push({ ...clean[position], code: "MODEL_COOLING" });
      }
    } else this.breakers.probe(keys[0]);
    this.routes.set(id, {
      runId,
      candidates: clean,
      keys,
      index,
      firstOutputMs: input.firstOutputMs ?? 0,
      contextWindow: input.contextWindow,
      skipped,
      retryStep: "",
      sameModelRetries: 0,
      firstOutputExpired: -1,
      waitedMs: 0,
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
    const router = this;
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
          const privacyBlocked = Boolean(
            (options.sessionId &&
              router.privacyBlockedSessions.has(options.sessionId)) ||
              session
                ?.snapshotEvents?.()
                .some((event) => event.type === "plugin:chisabot/privacy-gate"),
          );
          if (privacyBlocked && options.sessionId)
            router.privacyBlockedSessions.add(options.sessionId);
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
          // Every candidate has a first-output deadline, the last one too (QA509): with nothing
          // left to switch to, a silent model ends the turn with a clear error instead of hanging.
          // A route with a single model gets a longer budget, since no fallback is waiting.
          const multi = route.candidates.length > 1;
          const wait =
            route.firstOutputMs > 0
              ? multi
                ? route.firstOutputMs
                : route.firstOutputMs * SINGLE_MODEL_DEADLINE_FACTOR
              : 0;
          const last = route.index + 1 >= route.candidates.length;
          const position = route.index;
          let timer =
            wait > 0
              ? setTimeout(() => {
                  // Read by retry(): no output by the deadline goes straight to the next model.
                  route.firstOutputExpired = position;
                  route.waitedMs += wait;
                  abort.abort(new Error("MODEL_FIRST_OUTPUT_TIMEOUT"));
                }, wait)
              : undefined;
          try {
            // Native replay state belongs to the actual provider, never to a logical route.
            const sourceMessages = privacyBlocked
              ? stripPriorRejectedImages(options.messages)
              : options.messages;
            const messages = sourceMessages.map((message) =>
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
                route.waitedMs = 0;
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
                          // The real wait (QA510 P3): every deadline that expired in this step,
                          // e.g. 30 s on the primary plus 30 s on the backup, not just the last one.
                          message: last
                            ? `共等了约 ${spokenSeconds(route.waitedMs)} 秒仍没有任何输出${multi ? `（主模型和备用模型都没有回应，每个模型最多等 ${spokenSeconds(wait)} 秒）` : ""}。这一轮已结束，请稍后重试。`
                            : "Model produced no output within the configured fallback deadline.",
                        },
                        choice,
                        route.index,
                      ),
                    },
                  };
                } else {
                  if (chunk.reason?.kind !== "error")
                    router.breakers.ok(route.keys[position]);
                  else if (isLocalPrivacyGateFailure(chunk.reason.failure)) {
                    if (options.sessionId)
                      router.privacyBlockedSessions.add(options.sessionId);
                    if (session && !privacyBlocked) {
                      appendPluginRecord(
                        session,
                        "plugin:chisabot/privacy-gate",
                        {
                          routeId: id,
                          runId: route.runId,
                        },
                      );
                      await ctx.sessions.flush(session);
                    }
                  }
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
    route.lastFailure = {
      code: failure.code,
      message: redactFailureText(failure.message),
    };
    // A first-output deadline already waited the whole budget on this model: switch now.
    const deadline = route.firstOutputExpired === route.index;
    route.firstOutputExpired = -1;
    // Shared gateway local policy refusal (e.g. Magpie privacy-gate on image_url):
    // neither penalize the healthy model's breaker nor loop over backup models on the same gateway.
    if (isLocalPrivacyGateFailure(failure)) return false;
    // TIMEOUT never retries the same model (QA511 P2): a silent hang must end on the
    // first-output deadline, not burn another provider request timeout on the same candidate.
    if (
      !deadline &&
      ["SERVER", "TRANSPORT", "EMPTY_RESPONSE"].includes(failure.code) &&
      route.sameModelRetries < 1
    ) {
      route.sameModelRetries++;
      await delay(500, undefined, { signal });
      return true;
    }
    if (breakerCodes.has(failure.code))
      this.breakers.fail(route.keys[route.index], failure.code);
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
