import { normalizeModelBaseUrl } from "../../../shared/model-base-url";
import { reasonWithoutStatement } from "../db/query-failure";
import {
  buildConnectionPoolKeys,
  type ModelConnectionPooledKeyRuntime,
  modelPoolId,
} from "../model-settings";
import { trustedEndpointFetch } from "../net/trusted-endpoint-fetch";
import {
  QuotaExceededError,
  type QuotaReservation,
  type RecordUsageInput,
} from "../quotas/service";
import type { ModelKeyPool, ModelPoolKey } from "./key-pool";

export type ModelProxyQuotaOptions = {
  userId: string;
  isAdmin?: boolean;
  admit: (input: {
    userId: string;
    isAdmin: boolean;
    model: string;
    requestChars?: number;
    maxOutputTokens?: number;
    now?: number;
  }) => Promise<QuotaReservation | null>;
  recordUsage: (input: RecordUsageInput) => Promise<void>;
};

export type ModelConnectionProxyOptions = {
  stickyKey?: string;
  keyPool?: ModelKeyPool;
  poolId?: string;
  quota?: ModelProxyQuotaOptions;
  estimatePromptChars?: (bodyText: string) => number;
  now?: () => number;
};

const RETRYABLE_KEY_STATUSES = new Set([429, 402, 401, 403]);
const MAX_JSON_USAGE_BUFFER_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

export function buildQuotaExceededResponse(
  error: QuotaExceededError,
): Response {
  return Response.json(
    {
      error: error.message,
      code: error.code,
      limitType: error.limitType,
      used: error.used,
      limit: error.limit,
      resetAtUtc: error.resetAtUtc,
    },
    { status: 429, headers: { "cache-control": "no-store" } },
  );
}

function createUsageTracker(input: {
  model: string;
  requestChars: number;
  quota: ModelProxyQuotaOptions;
  reservation: QuotaReservation | null;
  nowFn: () => number;
}) {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens = 0;
  let outputChars = 0;
  let rawTextChars = 0;
  let hasStructuredPayload = false;
  let sawSse = false;
  let lineBuffer = "";
  let jsonBuffer = "";
  let jsonOverflow = false;
  let settled = false;
  const decoder = new TextDecoder("utf-8");

  const inspectUsageObject = (usage: Record<string, unknown>) => {
    const inVal = pickFiniteNumber(usage.prompt_tokens, usage.input_tokens);
    if (inVal !== undefined) inputTokens = inVal;
    const outVal = pickFiniteNumber(
      usage.completion_tokens,
      usage.output_tokens,
    );
    if (outVal !== undefined) outputTokens = outVal;

    const promptDetails = isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : undefined;
    const inputDetails = isRecord(usage.input_tokens_details)
      ? usage.input_tokens_details
      : undefined;
    const cacheVal = pickFiniteNumber(
      promptDetails?.cached_tokens,
      inputDetails?.cached_tokens,
      usage.cache_read_input_tokens,
    );
    if (cacheVal !== undefined) cacheReadTokens = cacheVal;
  };

  const inspectChoices = (choices: unknown[]) => {
    for (const item of choices) {
      if (!isRecord(item)) continue;
      const container = isRecord(item.delta)
        ? item.delta
        : isRecord(item.message)
          ? item.message
          : null;
      if (!container) continue;
      if (typeof container.content === "string") {
        outputChars += container.content.length;
      }
      if (typeof container.reasoning_content === "string") {
        outputChars += container.reasoning_content.length;
      }
      if (Array.isArray(container.tool_calls)) {
        for (const call of container.tool_calls) {
          if (!isRecord(call) || !isRecord(call.function)) continue;
          if (typeof call.function.arguments === "string") {
            outputChars += call.function.arguments.length;
          }
        }
      }
    }
  };

  const inspectAnthropicContent = (content: unknown[]) => {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (typeof block.text === "string") outputChars += block.text.length;
      if (typeof block.thinking === "string") {
        outputChars += block.thinking.length;
      }
    }
  };

  const inspectPayload = (payload: unknown) => {
    if (!isRecord(payload)) return;
    hasStructuredPayload = true;

    if (isRecord(payload.usage)) {
      inspectUsageObject(payload.usage);
    }
    if (
      payload.type === "message_start" &&
      isRecord(payload.message) &&
      isRecord(payload.message.usage)
    ) {
      inspectUsageObject(payload.message.usage);
    }
    if (payload.type === "content_block_delta" && isRecord(payload.delta)) {
      if (typeof payload.delta.text === "string") {
        outputChars += payload.delta.text.length;
      }
      if (typeof payload.delta.thinking === "string") {
        outputChars += payload.delta.thinking.length;
      }
      if (typeof payload.delta.partial_json === "string") {
        outputChars += payload.delta.partial_json.length;
      }
    }
    if (Array.isArray(payload.choices)) {
      inspectChoices(payload.choices);
    }
    if (payload.type === "message" && Array.isArray(payload.content)) {
      inspectAnthropicContent(payload.content);
    }
  };

  const processLine = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("data:")) {
      sawSse = true;
      const body = trimmed.slice(5).trim();
      if (!body || body === "[DONE]") return;
      try {
        inspectPayload(JSON.parse(body));
      } catch {
        // 忽略非 JSON SSE 数据行，不影响流透传与后续汇总。
      }
    }
  };

  const appendText = (text: string) => {
    if (!text) return;
    rawTextChars += text.length;
    if (!sawSse && !jsonOverflow) {
      if (jsonBuffer.length + text.length <= MAX_JSON_USAGE_BUFFER_BYTES) {
        jsonBuffer += text;
      } else {
        jsonOverflow = true;
        jsonBuffer = "";
      }
    }
    lineBuffer += text;
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      processLine(line);
      newlineIndex = lineBuffer.indexOf("\n");
    }
  };

  return {
    feedBytes(chunk: Uint8Array) {
      appendText(decoder.decode(chunk, { stream: true }));
    },
    finalize() {
      if (settled) return;
      settled = true;
      appendText(decoder.decode());
      if (lineBuffer.trim()) {
        processLine(lineBuffer);
        lineBuffer = "";
      }
      if (!sawSse && !jsonOverflow && jsonBuffer.trim()) {
        try {
          inspectPayload(JSON.parse(jsonBuffer));
        } catch {
          // 非标准 JSON 响应体回退到按字符长度估算输出 tokens。
        }
      }
      const effectiveOutputChars = hasStructuredPayload
        ? outputChars
        : rawTextChars;
      const finalInputTokens =
        inputTokens ?? Math.ceil(Math.max(0, input.requestChars) / 4);
      const finalOutputTokens =
        outputTokens ?? Math.ceil(Math.max(0, effectiveOutputChars) / 4);
      Promise.resolve(
        input.quota.recordUsage({
          userId: input.quota.userId,
          model: input.model,
          inputTokens: finalInputTokens,
          outputTokens: finalOutputTokens,
          cacheReadTokens,
          requests: 1,
          now: input.nowFn(),
          ...(input.reservation ? { reservation: input.reservation } : {}),
        }),
      ).catch((error) => {
        // 流结束后异步记账失败不能打断已返回给调用方的流，但必须可观测。
        console.warn(
          JSON.stringify({
            type: "quota-usage-record-failed",
            userId: input.quota.userId,
            model: input.model,
            reason: reasonWithoutStatement(error),
          }),
        );
      });
    },
  };
}

/** The Host spends its run capability; only configured credentials reach the model endpoint. */
export function createModelConnectionProxy(
  connection: {
    provider: "openai" | "anthropic";
    baseUrl: string;
    apiKey?: string | null;
    useApiKey?: boolean;
    pooledKeys?: readonly ModelConnectionPooledKeyRuntime[];
  },
  modelIds: readonly string[],
  toolNames: readonly string[],
  runSignal: AbortSignal,
  options?: ModelConnectionProxyOptions,
) {
  const anthropic = connection.provider === "anthropic";
  const endpoint = `${normalizeModelBaseUrl(connection.provider, connection.baseUrl)}/${anthropic ? "messages" : "chat/completions"}`;
  const models = new Set(modelIds);
  const tools = new Set(toolNames);
  const nowFn = options?.now ?? Date.now;
  const poolCandidates: ModelPoolKey[] = buildConnectionPoolKeys({
    apiKey: connection.apiKey ?? null,
    useApiKey: connection.useApiKey !== false,
    ...(connection.pooledKeys
      ? { pooledKeys: [...connection.pooledKeys] }
      : {}),
  });
  const poolId = options?.poolId ?? modelPoolId(connection);
  const useKeyPool = Boolean(
    options?.keyPool &&
      connection.useApiKey !== false &&
      (connection.pooledKeys?.length ?? 0) > 0,
  );

  return async (
    body: unknown,
    requestSignal: AbortSignal,
  ): Promise<Response> => {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json(
        { error: "Model request is required." },
        { status: 400 },
      );
    const request = body as {
      model?: unknown;
      tools?: unknown;
      max_tokens?: unknown;
      max_completion_tokens?: unknown;
    };
    if (typeof request.model !== "string" || !models.has(request.model))
      return Response.json(
        { error: "This model was not selected for the run." },
        { status: 403 },
      );
    if (
      request.tools !== undefined &&
      (!Array.isArray(request.tools) ||
        request.tools.some((tool) => {
          const name = anthropic ? tool?.name : tool?.function?.name;
          return typeof name !== "string" || !tools.has(name);
        }))
    )
      return Response.json(
        { error: "The model request contains an ungranted tool." },
        { status: 403 },
      );
    if (connection.useApiKey !== false && poolCandidates.length === 0)
      return Response.json(
        { error: "The configured model API key is missing." },
        { status: 401 },
      );

    const combinedSignal = AbortSignal.any([runSignal, requestSignal]);
    combinedSignal.throwIfAborted();

    const bodyText = JSON.stringify(body);
    const requestChars = options?.estimatePromptChars
      ? Math.max(0, options.estimatePromptChars(bodyText))
      : bodyText.length;
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
          model: request.model,
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

    const stickyKey = options?.stickyKey ?? "default";

    const sendWithKey = (key?: string) =>
      trustedEndpointFetch("model-provider", endpoint, {
        method: "POST",
        redirect: "error",
        signal: combinedSignal,
        headers: {
          "content-type": "application/json",
          ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
          ...(key
            ? anthropic
              ? { "x-api-key": key }
              : { authorization: `Bearer ${key}` }
            : {}),
        },
        body: bodyText,
      });

    let response: Response | null = null;
    try {
      if (useKeyPool && options?.keyPool) {
        const pool = options.keyPool;
        pool.setPool(poolId, poolCandidates);

        const exhaustedResponse = () => {
          const now = nowFn();
          const check = pool.selectKey(poolId, stickyKey, now);
          const retryAfterSeconds =
            check.nextAvailableAt !== null
              ? Math.max(1, Math.ceil((check.nextAvailableAt - now) / 1000))
              : 60;
          return Response.json(
            {
              error:
                "当前所有模型 API Key 均处于冷却中，请稍后重试或切换备选模型。",
              code: "key_pool_exhausted",
              retryAfterSeconds,
            },
            {
              status: 429,
              headers: {
                "cache-control": "no-store",
                "retry-after": String(retryAfterSeconds),
              },
            },
          );
        };

        for (let attempt = 0; attempt < poolCandidates.length; attempt++) {
          const selection = pool.selectKey(poolId, stickyKey, nowFn());
          if (!selection.key) {
            return exhaustedResponse();
          }
          const candidateResponse = await sendWithKey(selection.key.apiKey);
          if (RETRYABLE_KEY_STATUSES.has(candidateResponse.status)) {
            await candidateResponse.body?.cancel().catch(() => {});
            pool.reportResult(
              poolId,
              selection.key.id,
              candidateResponse.status,
              candidateResponse.headers,
              nowFn(),
            );
            continue;
          }
          if (candidateResponse.ok) {
            pool.reportResult(
              poolId,
              selection.key.id,
              candidateResponse.status,
              candidateResponse.headers,
              nowFn(),
            );
          }
          response = candidateResponse;
          break;
        }

        if (!response) {
          return exhaustedResponse();
        }
      } else {
        const key =
          connection.useApiKey === false
            ? undefined
            : (connection.apiKey ?? poolCandidates[0]?.apiKey);
        response = await sendWithKey(key);
      }
    } catch (error) {
      releaseReservation();
      throw error;
    }

    const headers = new Headers({ "cache-control": "no-store" });
    for (const name of ["content-type", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }

    if (!options?.quota || !response.ok) {
      releaseReservation();
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const tracker = createUsageTracker({
      model: request.model,
      requestChars,
      quota: options.quota,
      reservation,
      nowFn,
    });
    reservation = null;

    if (!response.body) {
      tracker.finalize();
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        tracker.feedBytes(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        tracker.finalize();
      },
    });
    void response.body
      .pipeTo(writable)
      .catch(() => {})
      .finally(() => {
        tracker.finalize();
      });

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
