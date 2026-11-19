import {
  DEFAULT_SPEECH_TTS_SPEED,
  DEFAULT_SPEECH_TTS_VOICE,
  type SpeechTtsProvider,
} from "../../../shared/speech";
import { VOICE_SAMPLE_RATE } from "../../../shared/voice-call";
import type { SpeechTtsConfig } from "../audio/speech-service";
import { trustedEndpointFetch } from "../net/trusted-endpoint-fetch";

/** 每次通过 WS 下发的流式 PCM 块上限（24KB ≈ 500ms @ 24kHz PCM16LE）。 */
export const VOICE_TTS_CHUNK_BYTES = 24_000;
/** 单句最大合成音频字节上限（120 秒 @ 24kHz PCM16LE，防上游异常流导致 OOM）。 */
export const VOICE_TTS_MAX_SENTENCE_BYTES = VOICE_SAMPLE_RATE * 2 * 120;
/** 单句最大输入文本长度（对齐 OpenAI TTS 4096 字符限制）。 */
export const VOICE_TTS_MAX_TEXT_CHARS = 4_096;
const DEFAULT_TTS_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 8;

const ALLOWED_PCM_CONTENT_TYPES = new Set([
  "audio/pcm",
  "audio/x-pcm",
  "audio/raw",
  "application/octet-stream",
]);

export type VoiceTtsTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type VoiceStreamTtsErrorCode =
  | "not-configured"
  | "invalid-input"
  | "rate-limited"
  | "cancelled"
  | "upstream-timeout"
  | "upstream-failed";

export class VoiceStreamTtsError extends Error {
  constructor(
    readonly code: VoiceStreamTtsErrorCode,
    message: string,
    readonly status: 400 | 413 | 429 | 499 | 502 | 503 | 504,
  ) {
    super(message);
    this.name = "VoiceStreamTtsError";
  }
}

export type VoiceStreamTtsRequest = {
  text: string;
  voice?: string;
  speed?: number;
  signal?: AbortSignal;
};

export type VoiceStreamTts = {
  stream(input: VoiceStreamTtsRequest): AsyncGenerator<Buffer, void, void>;
  isReady(): Promise<boolean>;
  close(): void;
};

function defaultTransport(url: string, init: RequestInit): Promise<Response> {
  return trustedEndpointFetch("model-provider", url, init);
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function resolveFishTtsUrl(baseUrl: string): string {
  if (/\/v1$/i.test(baseUrl)) {
    return `${baseUrl}/tts`;
  }
  return `${baseUrl}/v1/tts`;
}

function isTtsConfigReady(config: SpeechTtsConfig | undefined): boolean {
  if (!config?.baseUrl?.trim()) return false;
  const provider: SpeechTtsProvider =
    config.provider === "fish" ? "fish" : "openai";
  return provider === "fish" || Boolean(config.model?.trim());
}

function mapUpstreamStatusError(status: number): VoiceStreamTtsError {
  if (status === 401 || status === 403) {
    return new VoiceStreamTtsError(
      "upstream-failed",
      "语音合成服务鉴权失败，请检查管理员配置。",
      502,
    );
  }
  if (status === 402) {
    return new VoiceStreamTtsError(
      "upstream-failed",
      "语音合成服务余额不足。",
      502,
    );
  }
  if (status === 429) {
    return new VoiceStreamTtsError(
      "rate-limited",
      "语音合成服务繁忙，请稍后再试。",
      429,
    );
  }
  return new VoiceStreamTtsError(
    "upstream-failed",
    `语音合成服务返回异常状态（HTTP ${status}）。`,
    502,
  );
}

function buildSynthesisPayload(
  text: string,
  config: SpeechTtsConfig,
  voiceOverride?: string,
  speedOverride?: number,
): { url: string; headers: Record<string, string>; body: string } {
  const provider: SpeechTtsProvider =
    config.provider === "fish" ? "fish" : "openai";
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const speed =
    typeof speedOverride === "number" &&
    Number.isFinite(speedOverride) &&
    speedOverride >= 0.25 &&
    speedOverride <= 4
      ? speedOverride
      : (config.speed ?? DEFAULT_SPEECH_TTS_SPEED);
  const resolvedVoice =
    voiceOverride?.trim() ||
    config.voice?.trim() ||
    (provider === "openai" ? DEFAULT_SPEECH_TTS_VOICE : "");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "audio/pcm, application/octet-stream",
    ...(config.apiKey?.trim()
      ? { authorization: `Bearer ${config.apiKey.trim()}` }
      : {}),
  };

  if (provider === "fish") {
    const model = config.model?.trim();
    if (model) {
      headers.model = model;
    }
    return {
      url: resolveFishTtsUrl(baseUrl),
      headers,
      body: JSON.stringify({
        text,
        format: "pcm",
        sample_rate: VOICE_SAMPLE_RATE,
        latency: "balanced",
        prosody: { speed },
        ...(resolvedVoice ? { reference_id: resolvedVoice } : {}),
      }),
    };
  }

  return {
    url: `${baseUrl}/audio/speech`,
    headers,
    body: JSON.stringify({
      model: config.model,
      input: text,
      voice: resolvedVoice || DEFAULT_SPEECH_TTS_VOICE,
      response_format: "pcm",
      speed,
    }),
  };
}

/**
 * 独立流式 PCM16 TTS 合成器（不改动 `server/src/audio/speech-service.ts`）：
 * - 支持 OpenAI 兼容（`/audio/speech`）与 Fish Audio（`/v1/tts`）；
 * - 统一走 `trustedEndpointFetch("model-provider")` 严禁重定向；
 * - 边收 `ReadableStream` 边按 2 字节采样边界切 ≤24KB 块输出；
 * - 单句最大时长/字节封顶防 OOM，随时响应 `AbortSignal` 秒级取消。
 */
export function createVoiceStreamTts(options: {
  resolveConfig: () =>
    | Promise<SpeechTtsConfig | undefined>
    | SpeechTtsConfig
    | undefined;
  transport?: VoiceTtsTransport;
  timeoutMs?: number;
  maxSentenceBytes?: number;
  maxConcurrent?: number;
  chunkBytes?: number;
}): VoiceStreamTts {
  const transport = options.transport ?? defaultTransport;
  const timeoutMs = Math.max(
    1_000,
    options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS,
  );
  const maxSentenceBytes = Math.max(
    VOICE_TTS_CHUNK_BYTES,
    options.maxSentenceBytes ?? VOICE_TTS_MAX_SENTENCE_BYTES,
  );
  const maxConcurrent = Math.max(
    1,
    options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
  );
  const chunkBytes = Math.max(
    2,
    (options.chunkBytes ?? VOICE_TTS_CHUNK_BYTES) -
      ((options.chunkBytes ?? VOICE_TTS_CHUNK_BYTES) % 2),
  );

  const activeControllers = new Set<AbortController>();
  let closed = false;

  async function isReady(): Promise<boolean> {
    try {
      const cfg = await options.resolveConfig();
      return isTtsConfigReady(cfg);
    } catch {
      return false;
    }
  }

  async function* stream(
    input: VoiceStreamTtsRequest,
  ): AsyncGenerator<Buffer, void, void> {
    if (closed) {
      throw new VoiceStreamTtsError(
        "not-configured",
        "语音服务正在关闭。",
        503,
      );
    }
    const text = input.text.trim();
    if (!text) {
      throw new VoiceStreamTtsError("invalid-input", "合成文本不能为空。", 400);
    }
    if (text.length > VOICE_TTS_MAX_TEXT_CHARS) {
      throw new VoiceStreamTtsError(
        "invalid-input",
        `单句语音合成不能超过 ${VOICE_TTS_MAX_TEXT_CHARS} 个字符。`,
        413,
      );
    }
    const config = await options.resolveConfig();
    if (!config || !isTtsConfigReady(config)) {
      throw new VoiceStreamTtsError(
        "not-configured",
        "语音合成服务尚未配置，请联系管理员配置 TTS。",
        503,
      );
    }
    if (activeControllers.size >= maxConcurrent) {
      throw new VoiceStreamTtsError(
        "rate-limited",
        "当前语音合成并发已满，请稍后再试。",
        429,
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Voice TTS timed out", "TimeoutError"));
    }, timeoutMs);
    timer.unref?.();

    const onExternalAbort = () => {
      controller.abort(
        input.signal?.reason ??
          new DOMException("Voice TTS cancelled", "AbortError"),
      );
    };
    if (input.signal?.aborted) {
      onExternalAbort();
    } else {
      input.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    activeControllers.add(controller);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      if (controller.signal.aborted) {
        throw new VoiceStreamTtsError(
          timedOut ? "upstream-timeout" : "cancelled",
          timedOut ? "语音合成请求超时。" : "语音合成已取消。",
          timedOut ? 504 : 499,
        );
      }

      const payload = buildSynthesisPayload(
        text,
        config,
        input.voice,
        input.speed,
      );
      response = await transport(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: payload.body,
        redirect: "error",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw mapUpstreamStatusError(response.status);
      }

      const contentType = (response.headers.get("content-type") ?? "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType && !ALLOWED_PCM_CONTENT_TYPES.has(contentType)) {
        throw new VoiceStreamTtsError(
          "upstream-failed",
          "语音合成服务未返回 PCM 音频流。",
          502,
        );
      }
      if (!response.body) {
        throw new VoiceStreamTtsError(
          "upstream-failed",
          "语音合成服务返回了空音频流。",
          502,
        );
      }

      reader = response.body.getReader();
      let remainder: Buffer = Buffer.alloc(0);
      let totalBytes = 0;

      while (true) {
        if (controller.signal.aborted) {
          throw new VoiceStreamTtsError(
            timedOut ? "upstream-timeout" : "cancelled",
            timedOut ? "语音合成请求超时。" : "语音合成已取消。",
            timedOut ? 504 : 499,
          );
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        totalBytes += value.byteLength;
        if (totalBytes > maxSentenceBytes) {
          throw new VoiceStreamTtsError(
            "upstream-failed",
            "单句语音合成音频超出时长上限。",
            502,
          );
        }

        const chunkBuf = Buffer.from(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        const combined =
          remainder.byteLength > 0
            ? Buffer.concat([remainder, chunkBuf])
            : chunkBuf;
        const alignedEnd = combined.byteLength - (combined.byteLength % 2);

        for (let offset = 0; offset < alignedEnd; offset += chunkBytes) {
          if (controller.signal.aborted) {
            throw new VoiceStreamTtsError(
              timedOut ? "upstream-timeout" : "cancelled",
              timedOut ? "语音合成请求超时。" : "语音合成已取消。",
              timedOut ? 504 : 499,
            );
          }
          yield Buffer.from(
            combined.subarray(
              offset,
              Math.min(alignedEnd, offset + chunkBytes),
            ),
          );
        }

        remainder =
          alignedEnd === combined.byteLength
            ? Buffer.alloc(0)
            : Buffer.from(combined.subarray(alignedEnd));
      }

      if (totalBytes === 0 || remainder.byteLength !== 0) {
        throw new VoiceStreamTtsError(
          "upstream-failed",
          "语音合成返回的 PCM 音频不完整。",
          502,
        );
      }
    } catch (error) {
      if (error instanceof VoiceStreamTtsError) {
        throw error;
      }
      if (timedOut) {
        throw new VoiceStreamTtsError(
          "upstream-timeout",
          "语音合成请求超时。",
          504,
        );
      }
      if (controller.signal.aborted) {
        throw new VoiceStreamTtsError("cancelled", "语音合成已取消。", 499);
      }
      throw new VoiceStreamTtsError(
        "upstream-failed",
        "无法连接语音合成服务，请稍后重试。",
        502,
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onExternalAbort);
      activeControllers.delete(controller);
      if (reader) {
        await reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          // 忽略已释放锁异常
        }
      } else if (response?.body) {
        await response.body.cancel().catch(() => {});
      }
    }
  }

  function close(): void {
    closed = true;
    for (const controller of activeControllers) {
      controller.abort(
        new DOMException("Voice TTS shutting down", "AbortError"),
      );
    }
    activeControllers.clear();
  }

  return { stream, isReady, close };
}
