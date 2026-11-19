import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  CHAT_FILES_MARKER,
  type ChatFileView,
} from "../../../shared/chat-files";
import {
  DEFAULT_OPENAI_SPEECH_VOICES,
  DEFAULT_SPEECH_TTS_SPEED,
  DEFAULT_SPEECH_TTS_VOICE,
  MAX_SPEECH_TTS_CHARS,
  SPEECH_AUDIO_FORMATS,
  type SpeechAudioFormat,
  type SpeechSettingsView,
  type SpeechStatusView,
  type SpeechTestAsrResult,
  type SpeechTtsProvider,
  type SpeechVoiceItem,
} from "../../../shared/speech";
import type { AppVariables } from "../auth/guards";
import { currentToolAbort, TOOL_STOPPED_ZH } from "../confirmations/context";
import { trustedEndpointFetch } from "../net/trusted-endpoint-fetch";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import {
  type TranscodeToWavResult,
  transcodeTo16kMonoWav,
} from "./ffmpeg-transcode";
import {
  parseSpeechEndpointUrl,
  sameSpeechOrigin,
  type SpeechSettingsStore,
  SpeechSettingsValidationError,
} from "./speech-settings";

export {
  DEFAULT_SPEECH_TTS_VOICE,
  MAX_SPEECH_TTS_CHARS,
  SPEECH_AUDIO_FORMATS,
  type SpeechAudioFormat,
};

export const MAX_SPEECH_ASR_BYTES = 10 * 1024 * 1024;
export const MAX_SPEECH_TTS_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_CONCURRENT_TTS_PER_USER = 2;
export const SPEECH_TIMEOUT_MS = 60_000;

const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;
const TTS_BODY_LIMIT_BYTES = 64 * 1024;
const ADMIN_JSON_BODY_LIMIT_BYTES = 32 * 1024;
const FISH_CATALOG_TIMEOUT_MS = 15_000;
const FISH_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TEST_TTS_TEXT = "你好，这是 ChisaBot 语音合成测试。";

export type SpeechAsrConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export type SpeechTtsConfig = {
  provider?: SpeechTtsProvider;
  baseUrl: string;
  model: string;
  voice?: string;
  speed?: number;
  apiKey?: string;
};

export type SpeechConfig = {
  asr?: SpeechAsrConfig;
  tts?: SpeechTtsConfig;
};

export type SpeechTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type SpeechPersistAudio = (
  actorId: string,
  agentId: string,
  file: { name: string; mimeType: string; bytes: Buffer },
) => Promise<ChatFileView>;

export type SpeechToolContext = {
  actorId?: string;
  agentId?: string;
};

export type SpeechAdminGuard =
  | ((
      context: Context<{ Variables: AppVariables }>,
    ) => Response | undefined | Promise<Response | undefined>)
  | MiddlewareHandler<{ Variables: AppVariables }>;

export type SpeechTranscribeInput = {
  data: Uint8Array | ArrayBuffer | Blob;
  mimeType: string;
  fileName?: string;
  language?: string;
  signal?: AbortSignal;
};

export type SpeechTranscribeResult = {
  text: string;
};

export type SpeechSynthesizeInput = {
  text: string;
  voice?: string;
  format?: SpeechAudioFormat;
  speed?: number;
  signal?: AbortSignal;
  /** 用户级并发限流键；路由传 actor.id，工具传 actorId。 */
  actorKey?: string;
  /** 仅管理员试听接口使用的未保存临时配置覆盖。 */
  configOverride?: SpeechTtsConfig;
};

export type SpeechSynthesizeResult = {
  audio: Uint8Array;
  contentType: string;
  voice: string;
  format: SpeechAudioFormat;
};

export type SpeechErrorCode =
  | "not-configured"
  | "invalid-input"
  | "payload-too-large"
  | "unsupported-media-type"
  | "rate-limited"
  | "upstream-timeout"
  | "upstream-failed";

export type SpeechErrorStatus = 400 | 413 | 415 | 429 | 502 | 503 | 504;

/** 统一语音服务对外抛出的受控错误：不携带上游响应体或密钥，可直接返回给前端或模型。 */
export class SpeechServiceError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
    readonly status: SpeechErrorStatus,
  ) {
    super(message);
    this.name = "SpeechServiceError";
  }
}

type AsrFormatSpec = {
  mimeType: string;
  extension: "webm" | "mp4" | "wav" | "mp3" | "ogg";
};

const ASR_MIME_TABLE: Readonly<Record<string, AsrFormatSpec>> = {
  "audio/webm": { mimeType: "audio/webm", extension: "webm" },
  "video/webm": { mimeType: "audio/webm", extension: "webm" },
  "audio/mp4": { mimeType: "audio/mp4", extension: "mp4" },
  "video/mp4": { mimeType: "audio/mp4", extension: "mp4" },
  "audio/m4a": { mimeType: "audio/mp4", extension: "mp4" },
  "audio/x-m4a": { mimeType: "audio/mp4", extension: "mp4" },
  "audio/wav": { mimeType: "audio/wav", extension: "wav" },
  "audio/x-wav": { mimeType: "audio/wav", extension: "wav" },
  "audio/wave": { mimeType: "audio/wav", extension: "wav" },
  "audio/mpeg": { mimeType: "audio/mpeg", extension: "mp3" },
  "audio/mp3": { mimeType: "audio/mpeg", extension: "mp3" },
  "audio/ogg": { mimeType: "audio/ogg", extension: "ogg" },
  "audio/opus": { mimeType: "audio/ogg", extension: "ogg" },
  "application/ogg": { mimeType: "audio/ogg", extension: "ogg" },
};

const ASR_EXTENSION_TABLE: Readonly<Record<string, AsrFormatSpec>> = {
  webm: { mimeType: "audio/webm", extension: "webm" },
  mp4: { mimeType: "audio/mp4", extension: "mp4" },
  m4a: { mimeType: "audio/mp4", extension: "mp4" },
  wav: { mimeType: "audio/wav", extension: "wav" },
  mp3: { mimeType: "audio/mpeg", extension: "mp3" },
  ogg: { mimeType: "audio/ogg", extension: "ogg" },
};

const TTS_CONTENT_TYPE_TABLE: Readonly<Record<SpeechAudioFormat, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  aac: "audio/aac",
};

function defaultTransport(url: string, init: RequestInit): Promise<Response> {
  return trustedEndpointFetch("model-provider", url, init);
}

function parseHttpEndpointUrl(raw: string, varName: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${varName} 必须是合法的 HTTP(S) URL。`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    throw new Error(
      `${varName} 必须是 HTTP(S) URL，且不能包含用户名密码、查询参数或片段。`,
    );
  }
  return url.href.replace(/\/+$/, "");
}

function stripControlChars(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      out += input.charAt(i);
    }
  }
  return out;
}

function resolveAsrConfigFromEnv(
  env: Record<string, string | undefined>,
): SpeechAsrConfig | undefined {
  const speechBaseUrl = env.SPEECH_ASR_BASE_URL?.trim();
  const speechModel = env.SPEECH_ASR_MODEL?.trim();
  const speechApiKey = env.SPEECH_ASR_API_KEY?.trim();

  if (speechBaseUrl || speechModel || speechApiKey) {
    if (!speechBaseUrl || !speechModel) {
      throw new Error(
        "配置 SPEECH_ASR_* 时必须同时提供 SPEECH_ASR_BASE_URL 和 SPEECH_ASR_MODEL。",
      );
    }
    return {
      baseUrl: parseHttpEndpointUrl(speechBaseUrl, "SPEECH_ASR_BASE_URL"),
      model: speechModel,
      ...(speechApiKey ? { apiKey: speechApiKey } : {}),
    };
  }

  const provider = env.TRANSCRIPTION_PROVIDER?.trim();
  const fallbackBaseUrl = env.TRANSCRIPTION_BASE_URL?.trim();
  const fallbackModel = env.TRANSCRIPTION_MODEL?.trim();
  const fallbackApiKey = env.TRANSCRIPTION_API_KEY?.trim();

  if (!provider && !fallbackBaseUrl && !fallbackModel && !fallbackApiKey) {
    return undefined;
  }
  if (provider && provider !== "openai-compatible") {
    throw new Error(
      "兜底语音识别配置 TRANSCRIPTION_PROVIDER 仅支持 openai-compatible。",
    );
  }
  if (!fallbackBaseUrl || !fallbackModel) {
    throw new Error(
      "复用 TRANSCRIPTION_* 作为 ASR 时必须同时提供 TRANSCRIPTION_BASE_URL 和 TRANSCRIPTION_MODEL。",
    );
  }
  return {
    baseUrl: parseHttpEndpointUrl(fallbackBaseUrl, "TRANSCRIPTION_BASE_URL"),
    model: fallbackModel,
    ...(fallbackApiKey ? { apiKey: fallbackApiKey } : {}),
  };
}

function resolveTtsConfigFromEnv(
  env: Record<string, string | undefined>,
): SpeechTtsConfig | undefined {
  const baseUrl = env.SPEECH_TTS_BASE_URL?.trim();
  const model = env.SPEECH_TTS_MODEL?.trim();
  const voice = env.SPEECH_TTS_VOICE?.trim();
  const apiKey = env.SPEECH_TTS_API_KEY?.trim();
  const rawProvider = env.SPEECH_TTS_PROVIDER?.trim().toLowerCase();

  if (!baseUrl && !model && !voice && !apiKey && !rawProvider) {
    return undefined;
  }
  if (rawProvider && rawProvider !== "openai" && rawProvider !== "fish") {
    throw new Error("SPEECH_TTS_PROVIDER 仅支持 openai 或 fish。");
  }
  const provider: SpeechTtsProvider | undefined =
    rawProvider === "fish"
      ? "fish"
      : rawProvider === "openai"
        ? "openai"
        : undefined;
  if (!baseUrl || (provider !== "fish" && !model)) {
    throw new Error(
      "配置语音合成服务时必须同时提供 SPEECH_TTS_BASE_URL 和 SPEECH_TTS_MODEL。",
    );
  }
  return {
    ...(provider ? { provider } : {}),
    baseUrl: parseHttpEndpointUrl(baseUrl, "SPEECH_TTS_BASE_URL"),
    model: model ?? "",
    ...(voice ? { voice } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** 从环境变量映射解析统一语音配置：优先读取 SPEECH_*，ASR 兼容兜底复用 TRANSCRIPTION_*。 */
export function speechConfigFromEnv(
  env: Record<string, string | undefined>,
): SpeechConfig {
  const asr = resolveAsrConfigFromEnv(env);
  const tts = resolveTtsConfigFromEnv(env);
  return {
    ...(asr ? { asr } : {}),
    ...(tts ? { tts } : {}),
  };
}

function resolveAsrFormat(
  mimeType: string,
  fileName?: string,
): AsrFormatSpec | undefined {
  const baseMime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (baseMime && baseMime !== "application/octet-stream") {
    return Object.hasOwn(ASR_MIME_TABLE, baseMime)
      ? ASR_MIME_TABLE[baseMime]
      : undefined;
  }
  const trimmedName = fileName?.trim() ?? "";
  const dotIndex = trimmedName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === trimmedName.length - 1) return undefined;
  const ext = trimmedName.slice(dotIndex + 1).toLowerCase();
  return Object.hasOwn(ASR_EXTENSION_TABLE, ext)
    ? ASR_EXTENSION_TABLE[ext]
    : undefined;
}

function toAudioFile(
  data: Uint8Array | ArrayBuffer | Blob,
  format: AsrFormatSpec,
  fileName?: string,
): { file: File; byteLength: number } {
  const cleanName = fileName
    ?.trim()
    .replace(/[/\\]/g, "_")
    .replace(/[^\w.-]/g, "_");
  const resolvedName = cleanName?.toLowerCase().endsWith(`.${format.extension}`)
    ? cleanName
    : `audio.${format.extension}`;

  if (data instanceof Blob) {
    return {
      file: new File([data], resolvedName, { type: format.mimeType }),
      byteLength: data.size,
    };
  }
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  return {
    file: new File([bytes], resolvedName, { type: format.mimeType }),
    byteLength: bytes.byteLength,
  };
}

function createRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
      return { signal: controller.signal, dispose: () => {} };
    }
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  // 使用可清理的显式定时器替代孤立 AbortSignal.timeout，防止在无其他活动句柄时测试进程挂起。
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function normalizeEndpointBase(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new SpeechServiceError(
      "not-configured",
      "语音服务端点地址无效，请联系管理员检查配置。",
      503,
    );
  }
  try {
    return parseHttpEndpointUrl(trimmed, "SPEECH_BASE_URL");
  } catch {
    throw new SpeechServiceError(
      "not-configured",
      "语音服务端点地址配置无效，请联系管理员检查配置。",
      503,
    );
  }
}

function assertUpstreamOk(response: Response, kind: "ASR" | "TTS"): void {
  if (response.ok) return;
  // 主动丢弃错误响应体且绝不读取文本，避免把上游调试信息或密钥带入异常与日志。
  void response.body?.cancel().catch(() => {});
  const label = kind === "ASR" ? "语音识别服务" : "语音合成服务";
  if (response.status === 429) {
    throw new SpeechServiceError(
      "rate-limited",
      `${label}当前繁忙（请求过于频繁），请稍后重试。`,
      429,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new SpeechServiceError(
      "upstream-failed",
      `${label}鉴权失败，请联系管理员检查服务配置。`,
      502,
    );
  }
  throw new SpeechServiceError(
    "upstream-failed",
    `${label}暂时无法处理该请求，请稍后重试。`,
    502,
  );
}

/** 限长流式读取响应体，超过上限立即中止读取防止大响应 OOM。 */
async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  if (rawLength) {
    const declared = Number(rawLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new SpeechServiceError("payload-too-large", tooLargeMessage, 413);
    }
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new SpeechServiceError("payload-too-large", tooLargeMessage, 413);
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new SpeechServiceError(
          "upstream-timeout",
          "语音合成请求已超时或被取消，请重试。",
          504,
        );
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SpeechServiceError("payload-too-large", tooLargeMessage, 413);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 忽略释放锁时的状态异常
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/** 生成 0.1 秒 8kHz 单声道静音 WAV，用于 ASR 管理台连通性探活。 */
function buildSilentProbeWav(): Uint8Array {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = 800; // 100ms
  const dataBytes = numSamples * numChannels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  view.setUint16(32, numChannels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

function formatAudioStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function keyHintOf(secret: string | undefined): string {
  const trimmed = secret?.trim() ?? "";
  return trimmed.length >= 8 ? trimmed.slice(-4) : "";
}

function resolveFishTtsUrl(baseUrl: string): string {
  if (/\/v1$/i.test(baseUrl)) {
    return `${baseUrl}/tts`;
  }
  return `${baseUrl}/v1/tts`;
}

function resolveFishCatalogUrl(baseUrl: string, query: string): string {
  const stripped = baseUrl.replace(/\/v1$/i, "");
  const url = new URL(`${stripped}/model`);
  const params = new URLSearchParams({
    page_size: "50",
    page_number: "1",
    self: "false",
  });
  if (query) {
    params.set("title", query);
  }
  url.search = params.toString();
  return url.toString();
}

function filterVoiceItems(
  voices: readonly SpeechVoiceItem[],
  rawQuery?: string,
): SpeechVoiceItem[] {
  const q = stripControlChars(rawQuery ?? "")
    .trim()
    .toLowerCase();
  if (!q) return [...voices];
  return voices.filter((item) => {
    const haystack = [
      item.id,
      item.name,
      item.provider,
      item.language ?? "",
      item.gender ?? "",
      item.previewText ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

const ttsBodySchema = z.object({
  text: z
    .string({ error: "合成文本必须是字符串。" })
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, "合成文本不能为空。")
        .max(
          MAX_SPEECH_TTS_CHARS,
          `合成文本不能超过 ${MAX_SPEECH_TTS_CHARS} 个字符。`,
        ),
    ),
  voice: z
    .string({ error: "发音人必须是字符串。" })
    .transform((value) => value.trim())
    .pipe(z.string().min(1, "发音人不能为空。").max(128, "发音人名称过长。"))
    .optional(),
  format: z
    .enum(SPEECH_AUDIO_FORMATS, {
      error: "不支持的音频格式，仅支持 mp3、wav、opus、aac。",
    })
    .optional(),
  speed: z
    .number({ error: "语速必须是数字。" })
    .finite("语速必须是有效数字。")
    .min(0.25, "语速不能低于 0.25。")
    .max(4, "语速不能高于 4.0。")
    .optional(),
});

const testTtsBodySchema = z
  .object({
    text: z
      .string({ error: "试听文本必须是字符串。" })
      .trim()
      .max(
        MAX_SPEECH_TTS_CHARS,
        `试听文本不能超过 ${MAX_SPEECH_TTS_CHARS} 个字符。`,
      )
      .optional(),
    provider: z.enum(["openai", "fish"]).optional(),
    baseUrl: z.string().trim().max(300).optional(),
    model: z.string().trim().max(160).optional(),
    voice: z.string().trim().max(128).optional(),
    format: z.enum(SPEECH_AUDIO_FORMATS).optional(),
    speed: z
      .number()
      .finite("语速必须是有效数字。")
      .min(0.25, "语速不能低于 0.25。")
      .max(4, "语速不能高于 4.0。")
      .optional(),
    apiKey: z.string().max(4000).optional(),
  })
  .strict();

const testAsrBodySchema = z
  .object({
    baseUrl: z.string().trim().max(300).optional(),
    model: z.string().trim().max(160).optional(),
    apiKey: z.string().max(4000).optional(),
  })
  .strict();

const speechToolParameters = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "合成文本不能为空。")
      .max(
        MAX_SPEECH_TTS_CHARS,
        `合成文本不能超过 ${MAX_SPEECH_TTS_CHARS} 个字符。`,
      )
      .describe("需要合成为语音的文本内容，最多 4,000 个字符"),
    voice: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe("可选发音人名称，省略时使用服务端默认发音人"),
    format: z
      .enum(SPEECH_AUDIO_FORMATS)
      .optional()
      .describe("输出音频格式：mp3、wav、opus 或 aac，默认 mp3"),
    speed: z
      .number()
      .finite()
      .min(0.25)
      .max(4)
      .optional()
      .describe("语速倍率（0.25–4.0），默认 1.0"),
  })
  .strict();

export type SpeechService = {
  transcribeAudio(
    input: SpeechTranscribeInput,
  ): Promise<SpeechTranscribeResult>;
  synthesizeSpeech(
    input: SpeechSynthesizeInput,
  ): Promise<SpeechSynthesizeResult>;
  isTtsReady(): Promise<boolean>;
  statusView(): Promise<SpeechStatusView>;
  listVoices(query?: string): Promise<SpeechVoiceItem[]>;
  tools(toolContext?: SpeechToolContext): GrantedTool[];
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
    requireAdmin?: SpeechAdminGuard,
  ): Hono<{ Variables: AppVariables }>;
};

function isSupportedTtsFormat(value: string): value is SpeechAudioFormat {
  return (SPEECH_AUDIO_FORMATS as readonly string[]).includes(value);
}

function isTtsConfigReady(tts: SpeechTtsConfig | undefined): boolean {
  if (!tts?.baseUrl?.trim()) return false;
  const provider: SpeechTtsProvider =
    tts.provider === "fish" ? "fish" : "openai";
  return provider === "fish" || Boolean(tts.model?.trim());
}

function toAdminMiddleware(
  guard?: SpeechAdminGuard,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!guard) {
      if (context.var.actor.role !== "admin") {
        return context.json({ error: "Administrator access required." }, 403);
      }
      await next();
      return;
    }
    if (guard.length >= 2) {
      return (guard as MiddlewareHandler<{ Variables: AppVariables }>)(
        context,
        next,
      );
    }
    const denied = await (
      guard as (
        c: Context<{ Variables: AppVariables }>,
      ) => Response | undefined | Promise<Response | undefined>
    )(context);
    if (denied) return denied;
    await next();
  };
}

/** 创建统一原生语音服务（ASR + TTS + 机器人朗读工具 + `/api/speech` 路由）。 */
export function createSpeechService(options: {
  getConfig: () => SpeechConfig | Promise<SpeechConfig>;
  settingsStore?: SpeechSettingsStore;
  persistAudio?: SpeechPersistAudio;
  transport?: SpeechTransport;
  /** 可选覆盖音频规整转码器（默认走 FFmpeg 16kHz 单声道 WAV 安全转码）。 */
  transcodeAudio?: (
    bytes: Uint8Array,
    opts?: { timeoutMs?: number },
  ) => Promise<TranscodeToWavResult>;
  publicOrigin?: string;
  timeoutMs?: number;
  maxTtsAudioBytes?: number;
  maxConcurrentTtsPerUser?: number;
}): SpeechService {
  const transport = options.transport ?? defaultTransport;
  const transcodeAudio = options.transcodeAudio ?? transcodeTo16kMonoWav;
  const timeoutMs = options.timeoutMs ?? SPEECH_TIMEOUT_MS;
  const maxTtsAudioBytes =
    options.maxTtsAudioBytes ?? MAX_SPEECH_TTS_AUDIO_BYTES;
  const maxConcurrentTtsPerUser =
    options.maxConcurrentTtsPerUser ?? MAX_CONCURRENT_TTS_PER_USER;
  const publicOrigin = options.publicOrigin?.trim().replace(/\/+$/, "");
  const activeTtsByUser = new Map<string, number>();

  async function resolveConfig(): Promise<SpeechConfig> {
    try {
      if (options.settingsStore) {
        return await options.settingsStore.resolveConfig();
      }
      return await options.getConfig();
    } catch {
      throw new SpeechServiceError(
        "not-configured",
        "语音服务配置加载失败，请联系管理员检查配置。",
        503,
      );
    }
  }

  async function isTtsReady(): Promise<boolean> {
    const config = await resolveConfig().catch(() => ({}) as SpeechConfig);
    return isTtsConfigReady(config.tts);
  }

  async function statusView(): Promise<SpeechStatusView> {
    const config = await resolveConfig().catch(() => ({}) as SpeechConfig);
    const provider: SpeechTtsProvider =
      config.tts?.provider === "fish" ? "fish" : "openai";
    const defaultVoice =
      config.tts?.voice?.trim() ||
      (provider === "openai" ? DEFAULT_SPEECH_TTS_VOICE : "");
    return {
      asrReady: Boolean(
        config.asr?.baseUrl?.trim() && config.asr?.model?.trim(),
      ),
      ttsReady: isTtsConfigReady(config.tts),
      defaultVoice,
      provider,
    };
  }

  async function fetchFishVoices(
    tts: SpeechTtsConfig,
    query: string,
  ): Promise<SpeechVoiceItem[]> {
    let url: string;
    try {
      const base = normalizeEndpointBase(tts.baseUrl);
      url = resolveFishCatalogUrl(base, query);
    } catch {
      return [];
    }

    const reqSignal = createRequestSignal(undefined, FISH_CATALOG_TIMEOUT_MS);
    try {
      const response = await transport(url, {
        method: "GET",
        headers: tts.apiKey ? { authorization: `Bearer ${tts.apiKey}` } : {},
        redirect: "error",
        signal: reqSignal.signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return [];
      }
      const bytes = await readBoundedBytes(
        response,
        FISH_CATALOG_MAX_BYTES,
        reqSignal.signal,
        "音色列表响应过大。",
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("items" in parsed) ||
        !Array.isArray(parsed.items)
      ) {
        return [];
      }
      const out: SpeechVoiceItem[] = [];
      for (const rawItem of parsed.items.slice(0, 50)) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        if (item.visibility === "private" || item.dmca_taken_down === true) {
          continue;
        }
        const id = typeof item._id === "string" ? item._id.trim() : "";
        const title = typeof item.title === "string" ? item.title.trim() : "";
        if (!id || id.length > 200 || !title) continue;
        const languages = Array.isArray(item.languages)
          ? item.languages.filter(
              (lang): lang is string =>
                typeof lang === "string" && lang.trim().length > 0,
            )
          : [];
        const description =
          typeof item.description === "string"
            ? item.description.trim().slice(0, 120)
            : "";
        out.push({
          id,
          name: title.slice(0, 200),
          provider: "fish",
          ...(languages[0] ? { language: languages[0] } : {}),
          ...(description ? { previewText: description } : {}),
        });
      }
      return out;
    } catch {
      return [];
    } finally {
      reqSignal.dispose();
    }
  }

  async function listVoices(query?: string): Promise<SpeechVoiceItem[]> {
    const cleanQuery = stripControlChars(query ?? "")
      .trim()
      .slice(0, 100);
    const config = await resolveConfig().catch(() => ({}) as SpeechConfig);
    const fishVoices =
      config.tts?.provider === "fish" && config.tts.baseUrl?.trim()
        ? await fetchFishVoices(config.tts, cleanQuery)
        : [];
    const merged: SpeechVoiceItem[] = [];
    const seen = new Set<string>();
    for (const item of [...fishVoices, ...DEFAULT_OPENAI_SPEECH_VOICES]) {
      const key = `${item.provider}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return filterVoiceItems(merged, cleanQuery);
  }

  async function transcribeAudio(
    input: SpeechTranscribeInput,
  ): Promise<SpeechTranscribeResult> {
    const config = await resolveConfig();
    if (!config.asr) {
      throw new SpeechServiceError(
        "not-configured",
        "语音识别服务尚未配置，请联系管理员配置 ASR 服务。",
        503,
      );
    }

    const format = resolveAsrFormat(input.mimeType, input.fileName);
    if (!format) {
      throw new SpeechServiceError(
        "unsupported-media-type",
        "不支持的音频格式，仅支持 webm、mp4、wav、mp3、ogg。",
        415,
      );
    }

    const { file, byteLength } = toAudioFile(
      input.data,
      format,
      input.fileName,
    );
    if (byteLength === 0) {
      throw new SpeechServiceError("invalid-input", "音频内容不能为空。", 400);
    }
    if (byteLength > MAX_SPEECH_ASR_BYTES) {
      throw new SpeechServiceError(
        "payload-too-large",
        "音频文件不能超过 10 MiB。",
        413,
      );
    }

    let uploadFile = file;
    if (format.extension !== "wav") {
      try {
        const rawBytes = new Uint8Array(await file.arrayBuffer());
        const normalized = await transcodeAudio(rawBytes, {
          timeoutMs: Math.min(timeoutMs, 15_000),
        });
        if (
          normalized.transcoded &&
          normalized.bytes.byteLength > 0 &&
          normalized.bytes.byteLength <= MAX_SPEECH_ASR_BYTES
        ) {
          const baseName = file.name.replace(/\.[^.]+$/, "") || "audio";
          uploadFile = new File(
            [new Uint8Array(normalized.bytes)],
            `${baseName}.wav`,
            { type: "audio/wav" },
          );
        }
      } catch {
        // 转码异常时静默保留原始字节，确保语音识别主链路不被阻塞。
      }
    }

    const baseUrl = normalizeEndpointBase(config.asr.baseUrl);
    const form = new FormData();
    form.set("file", uploadFile);
    form.set("model", config.asr.model);
    const language = input.language?.trim();
    if (language) {
      form.set("language", language);
    }

    const reqSignal = createRequestSignal(input.signal, timeoutMs);
    if (reqSignal.signal.aborted) {
      reqSignal.dispose();
      throw new SpeechServiceError(
        "upstream-timeout",
        "语音识别请求已超时或被取消，请重试。",
        504,
      );
    }

    try {
      const response = await transport(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: config.asr.apiKey
          ? { authorization: `Bearer ${config.asr.apiKey}` }
          : {},
        body: form,
        signal: reqSignal.signal,
        // 禁止重定向，避免把音频数据和上游密钥转发到未配置的第三方地址。
        redirect: "error",
      });
      assertUpstreamOk(response, "ASR");
      const payload: unknown = await response.json().catch(() => null);
      if (
        !payload ||
        typeof payload !== "object" ||
        !("text" in payload) ||
        typeof payload.text !== "string"
      ) {
        throw new SpeechServiceError(
          "upstream-failed",
          "语音识别服务返回格式异常，请稍后重试。",
          502,
        );
      }
      return { text: payload.text.trim() };
    } catch (error) {
      if (error instanceof SpeechServiceError) throw error;
      if (reqSignal.signal.aborted) {
        throw new SpeechServiceError(
          "upstream-timeout",
          "语音识别请求已超时或被取消，请重试。",
          504,
        );
      }
      throw new SpeechServiceError(
        "upstream-failed",
        "无法连接语音识别服务，请稍后重试。",
        502,
      );
    } finally {
      reqSignal.dispose();
    }
  }

  async function synthesizeSpeech(
    input: SpeechSynthesizeInput,
  ): Promise<SpeechSynthesizeResult> {
    const ttsConfig = input.configOverride ?? (await resolveConfig()).tts;
    if (!ttsConfig || !isTtsConfigReady(ttsConfig)) {
      throw new SpeechServiceError(
        "not-configured",
        "语音合成服务尚未配置，请联系管理员配置 TTS 服务。",
        503,
      );
    }

    const text = input.text.trim();
    if (!text) {
      throw new SpeechServiceError("invalid-input", "合成文本不能为空。", 400);
    }
    if (text.length > MAX_SPEECH_TTS_CHARS) {
      throw new SpeechServiceError(
        "invalid-input",
        `合成文本不能超过 ${MAX_SPEECH_TTS_CHARS} 个字符。`,
        400,
      );
    }

    const requestedFormat = input.format ?? "mp3";
    if (!isSupportedTtsFormat(requestedFormat)) {
      throw new SpeechServiceError(
        "invalid-input",
        "不支持的音频输出格式，仅支持 mp3、wav、opus、aac。",
        400,
      );
    }

    if (
      input.speed !== undefined &&
      (!Number.isFinite(input.speed) || input.speed < 0.25 || input.speed > 4)
    ) {
      throw new SpeechServiceError(
        "invalid-input",
        "语速倍率必须在 0.25 到 4.0 之间。",
        400,
      );
    }

    if (input.voice !== undefined && !input.voice.trim()) {
      throw new SpeechServiceError(
        "invalid-input",
        "发音人名称不能为空。",
        400,
      );
    }

    const provider: SpeechTtsProvider =
      ttsConfig.provider === "fish" ? "fish" : "openai";
    const resolvedVoice =
      input.voice?.trim() ||
      ttsConfig.voice?.trim() ||
      (provider === "openai" ? DEFAULT_SPEECH_TTS_VOICE : "");
    if (resolvedVoice.length > 128) {
      throw new SpeechServiceError("invalid-input", "发音人名称过长。", 400);
    }

    const effectiveSpeed = input.speed ?? ttsConfig.speed;
    const baseUrl = normalizeEndpointBase(ttsConfig.baseUrl);
    const actorKey = input.actorKey?.trim() || "__anonymous__";
    const inflight = activeTtsByUser.get(actorKey) ?? 0;
    if (inflight >= maxConcurrentTtsPerUser) {
      throw new SpeechServiceError(
        "rate-limited",
        `当前同时进行的语音合成请求过多（单用户最多 ${maxConcurrentTtsPerUser} 路并发），请稍后重试。`,
        429,
      );
    }
    activeTtsByUser.set(actorKey, inflight + 1);

    const reqSignal = createRequestSignal(input.signal, timeoutMs);
    if (reqSignal.signal.aborted) {
      reqSignal.dispose();
      const remaining = (activeTtsByUser.get(actorKey) ?? 1) - 1;
      if (remaining <= 0) activeTtsByUser.delete(actorKey);
      else activeTtsByUser.set(actorKey, remaining);
      throw new SpeechServiceError(
        "upstream-timeout",
        "语音合成请求已超时或被取消，请重试。",
        504,
      );
    }

    try {
      let endpointUrl: string;
      let headers: Record<string, string>;
      let body: string;
      let outputFormat: SpeechAudioFormat = requestedFormat;

      if (provider === "fish") {
        // Fish Audio 支持 mp3/wav/opus，aac 降级为 mp3 以确保浏览器原生可播放。
        outputFormat = requestedFormat === "aac" ? "mp3" : requestedFormat;
        endpointUrl = resolveFishTtsUrl(baseUrl);
        headers = {
          "content-type": "application/json",
          accept: "audio/*, application/octet-stream",
          ...(ttsConfig.apiKey
            ? { authorization: `Bearer ${ttsConfig.apiKey}` }
            : {}),
          ...(ttsConfig.model.trim() ? { model: ttsConfig.model.trim() } : {}),
        };
        body = JSON.stringify({
          text,
          format: outputFormat,
          ...(effectiveSpeed !== undefined
            ? { prosody: { speed: effectiveSpeed } }
            : {}),
          ...(resolvedVoice ? { reference_id: resolvedVoice } : {}),
        });
      } else {
        endpointUrl = `${baseUrl}/audio/speech`;
        headers = {
          "content-type": "application/json",
          ...(ttsConfig.apiKey
            ? { authorization: `Bearer ${ttsConfig.apiKey}` }
            : {}),
        };
        body = JSON.stringify({
          model: ttsConfig.model,
          input: text,
          voice: resolvedVoice,
          response_format: outputFormat,
          ...(effectiveSpeed !== undefined ? { speed: effectiveSpeed } : {}),
        });
      }

      const response = await transport(endpointUrl, {
        method: "POST",
        headers,
        body,
        signal: reqSignal.signal,
        redirect: "error",
      });
      assertUpstreamOk(response, "TTS");

      const audio = await readBoundedBytes(
        response,
        maxTtsAudioBytes,
        reqSignal.signal,
        "语音合成返回的音频超过 25 MiB 大小限制。",
      );
      if (reqSignal.signal.aborted) {
        throw new SpeechServiceError(
          "upstream-timeout",
          "语音合成请求已超时或被取消，请重试。",
          504,
        );
      }
      if (audio.byteLength === 0) {
        throw new SpeechServiceError(
          "upstream-failed",
          "语音合成服务返回了空音频，请稍后重试。",
          502,
        );
      }

      const rawContentType =
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() ?? "";
      const contentType = rawContentType.startsWith("audio/")
        ? rawContentType
        : TTS_CONTENT_TYPE_TABLE[outputFormat];

      return {
        audio,
        contentType,
        voice: resolvedVoice || "default",
        format: outputFormat,
      };
    } catch (error) {
      if (error instanceof SpeechServiceError) throw error;
      if (reqSignal.signal.aborted) {
        throw new SpeechServiceError(
          "upstream-timeout",
          "语音合成请求已超时或被取消，请重试。",
          504,
        );
      }
      throw new SpeechServiceError(
        "upstream-failed",
        "无法连接语音合成服务，请稍后重试。",
        502,
      );
    } finally {
      reqSignal.dispose();
      const remaining = (activeTtsByUser.get(actorKey) ?? 1) - 1;
      if (remaining <= 0) {
        activeTtsByUser.delete(actorKey);
      } else {
        activeTtsByUser.set(actorKey, remaining);
      }
    }
  }

  async function probeAsr(
    asrConfig: SpeechAsrConfig,
    callerSignal?: AbortSignal,
  ): Promise<SpeechTestAsrResult> {
    const startedAt = Date.now();
    const baseUrl = normalizeEndpointBase(asrConfig.baseUrl);
    const wav = buildSilentProbeWav();
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(wav)], "probe.wav", { type: "audio/wav" }),
    );
    form.set("model", asrConfig.model);

    const reqSignal = createRequestSignal(
      callerSignal,
      Math.min(timeoutMs, 15_000),
    );
    try {
      const response = await transport(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: asrConfig.apiKey
          ? { authorization: `Bearer ${asrConfig.apiKey}` }
          : {},
        body: form,
        signal: reqSignal.signal,
        redirect: "error",
      });
      const latencyMs = Date.now() - startedAt;
      if (response.ok) {
        void response.body?.cancel().catch(() => {});
        return { ok: true, message: "语音识别服务连接正常。", latencyMs };
      }
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          message: "语音识别服务鉴权失败，请检查 API 密钥。",
          latencyMs,
        };
      }
      if (response.status === 404) {
        return {
          ok: false,
          message: "语音识别端点或模型不存在，请检查接口地址与模型名。",
          latencyMs,
        };
      }
      if (response.status === 429) {
        return {
          ok: false,
          message: "语音识别服务当前繁忙（限流），请稍后重试。",
          latencyMs,
        };
      }
      if (response.status === 400) {
        return {
          ok: false,
          message:
            "语音识别服务已响应（HTTP 400），请确认模型名称支持语音转写。",
          latencyMs,
        };
      }
      return {
        ok: false,
        message: `语音识别服务返回异常状态（HTTP ${response.status}），请检查服务状态。`,
        latencyMs,
      };
    } catch {
      const latencyMs = Date.now() - startedAt;
      if (reqSignal.signal.aborted) {
        return {
          ok: false,
          message: "连接语音识别服务超时，请检查接口地址与网络连通性。",
          latencyMs,
        };
      }
      return {
        ok: false,
        message: "无法连接语音识别服务，请检查接口地址与网络。",
        latencyMs,
      };
    } finally {
      reqSignal.dispose();
    }
  }

  function tools(toolContext?: SpeechToolContext): GrantedTool[] {
    return [
      {
        name: "speech_synthesize",
        ref: "audio/speech_synthesize",
        effect: "read",
        description:
          "将文字合成为语音音频。当用户要求朗读文本、配音或生成语音消息时调用；若具备聊天文件存储能力会自动落盘并在对话中生成可播放音频卡片。",
        parameters: speechToolParameters,
        execute: async (args, ctx) => {
          const signal = ctx?.signal ?? currentToolAbort();
          if (signal?.aborted) return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
          const parsed = speechToolParameters.safeParse(args);
          if (!parsed.success) {
            return `${REFUSAL_MARKER} speech_synthesize 参数错误：${parsed.error.issues[0]?.message ?? "请检查输入参数。"}`;
          }
          try {
            const result = await synthesizeSpeech({
              text: parsed.data.text,
              ...(parsed.data.voice ? { voice: parsed.data.voice } : {}),
              ...(parsed.data.format ? { format: parsed.data.format } : {}),
              ...(parsed.data.speed !== undefined
                ? { speed: parsed.data.speed }
                : {}),
              ...(toolContext?.actorId
                ? { actorKey: toolContext.actorId }
                : {}),
              ...(signal ? { signal } : {}),
            });

            let savedFile: ChatFileView | null = null;
            if (
              options.persistAudio &&
              toolContext?.actorId &&
              toolContext?.agentId
            ) {
              const fileName = `speech-${formatAudioStamp()}.${result.format}`;
              try {
                savedFile = await options.persistAudio(
                  toolContext.actorId,
                  toolContext.agentId,
                  {
                    name: fileName,
                    mimeType: result.contentType,
                    bytes: Buffer.from(result.audio),
                  },
                );
              } catch {
                savedFile = null;
              }
            }

            const summaryLines = [
              "语音合成完成：",
              `- 格式：${result.format}（${result.contentType}）`,
              `- 发音人：${result.voice}`,
              `- 大小：${result.audio.byteLength} 字节`,
              ...(savedFile
                ? [`- 音频文件：${savedFile.name}`]
                : publicOrigin
                  ? [`- 前端播放接口：${publicOrigin}/api/speech/tts`]
                  : []),
            ];

            if (savedFile) {
              return `${summaryLines.join("\n")}\n${CHAT_FILES_MARKER}${JSON.stringify([savedFile])}`;
            }
            return summaryLines.join("\n");
          } catch (error) {
            if (signal?.aborted) return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
            const message =
              error instanceof SpeechServiceError
                ? error.message
                : "语音合成失败，请稍后重试。";
            return `${REFUSAL_MARKER} ${message}`;
          }
        },
      },
    ];
  }

  function routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
    requireAdmin?: SpeechAdminGuard,
  ) {
    const app = new Hono<{ Variables: AppVariables }>();
    const adminOnly = toAdminMiddleware(requireAdmin);
    const adminBodyLimit = bodyLimit({
      maxSize: ADMIN_JSON_BODY_LIMIT_BYTES,
      onError: (context) => {
        context.header("Cache-Control", "no-store");
        return context.json({ error: "请求体不能超过 32 KiB。" }, 413);
      },
    });

    app.use("*", requireUser);
    app.use("*", async (context, next) => {
      await next();
      if (!context.res.headers.has("cache-control")) {
        context.header("Cache-Control", "no-store");
      }
    });

    app.get("/status", async (context) => {
      context.header("Cache-Control", "no-store");
      return context.json(await statusView());
    });

    app.get("/voices", async (context) => {
      const q = context.req.query("q") ?? "";
      context.header("Cache-Control", "no-store");
      return context.json({ voices: await listVoices(q) });
    });

    app.get("/settings", adminOnly, async (context) => {
      context.header("Cache-Control", "no-store");
      if (options.settingsStore) {
        return context.json(await options.settingsStore.view());
      }
      const config = await resolveConfig().catch(() => ({}) as SpeechConfig);
      const provider: SpeechTtsProvider =
        config.tts?.provider === "fish" ? "fish" : "openai";
      const fallbackView: SpeechSettingsView = {
        asr: {
          enabled: Boolean(config.asr),
          baseUrl: config.asr?.baseUrl ?? "",
          model: config.asr?.model ?? "",
        },
        tts: {
          enabled: Boolean(config.tts),
          provider,
          baseUrl: config.tts?.baseUrl ?? "",
          model: config.tts?.model ?? "",
          voice:
            config.tts?.voice ??
            (provider === "openai" ? DEFAULT_SPEECH_TTS_VOICE : ""),
          speed: config.tts?.speed ?? DEFAULT_SPEECH_TTS_SPEED,
        },
        asrKeySource: config.asr?.apiKey ? "environment" : "none",
        asrKeyHint: keyHintOf(config.asr?.apiKey),
        ttsKeySource: config.tts?.apiKey ? "environment" : "none",
        ttsKeyHint: keyHintOf(config.tts?.apiKey),
        updatedAt: null,
      };
      return context.json(fallbackView);
    });

    app.put("/settings", adminOnly, adminBodyLimit, async (context) => {
      context.header("Cache-Control", "no-store");
      if (!options.settingsStore) {
        return context.json(
          { error: "当前部署未启用可持久化语音设置存储。" },
          503,
        );
      }
      const rawBody: unknown = await context.req.json().catch(() => null);
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return context.json({ error: "请提供合法的 JSON 请求体。" }, 400);
      }
      try {
        const saved = await options.settingsStore.save(
          context.var.actor.id,
          rawBody,
        );
        return context.json(saved);
      } catch (error) {
        if (error instanceof SpeechSettingsValidationError) {
          return context.json({ error: error.message }, 400);
        }
        return context.json(
          { error: "保存语音服务设置失败，请稍后重试。" },
          503,
        );
      }
    });

    app.post("/test-tts", adminOnly, adminBodyLimit, async (context) => {
      context.header("Cache-Control", "no-store");
      const rawBody: unknown = await context.req.json().catch(() => ({}));
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return context.json({ error: "请提供合法的 JSON 请求体。" }, 400);
      }
      const parsed = testTtsBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return context.json(
          {
            error: parsed.error.issues[0]?.message ?? "语音试听参数无效。",
          },
          400,
        );
      }

      const data = parsed.data;
      let ttsOverride: SpeechTtsConfig | null = null;
      try {
        if (options.settingsStore) {
          ttsOverride = await options.settingsStore.resolveForTestTts({
            ...(data.provider ? { provider: data.provider } : {}),
            ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
            ...(data.model !== undefined ? { model: data.model } : {}),
            ...(data.voice !== undefined ? { voice: data.voice } : {}),
            ...(data.speed !== undefined ? { speed: data.speed } : {}),
            ...(data.apiKey !== undefined ? { apiKey: data.apiKey } : {}),
          });
        } else {
          const current = (
            await resolveConfig().catch((): SpeechConfig => ({}))
          ).tts;
          const provider = data.provider ?? current?.provider ?? "openai";
          const rawBaseUrl = data.baseUrl || current?.baseUrl || "";
          const model = data.model ?? current?.model ?? "";
          if (rawBaseUrl && (provider === "fish" || model)) {
            const baseUrl = parseSpeechEndpointUrl(rawBaseUrl, "TTS 接口地址");
            const canReuseCurrentKey =
              sameSpeechOrigin(baseUrl, current?.baseUrl) &&
              provider === (current?.provider ?? "openai");
            const apiKey =
              data.apiKey?.trim() ||
              (canReuseCurrentKey ? current?.apiKey : undefined);
            const voice = data.voice ?? current?.voice;
            const speed = data.speed ?? current?.speed;
            ttsOverride = {
              provider,
              baseUrl,
              model,
              ...(voice ? { voice } : {}),
              ...(speed !== undefined ? { speed } : {}),
              ...(apiKey ? { apiKey } : {}),
            };
          }
        }
      } catch (error) {
        if (error instanceof SpeechSettingsValidationError) {
          return context.json({ error: error.message }, 400);
        }
        return context.json({ error: "无法解析语音合成配置。" }, 400);
      }

      if (!ttsOverride) {
        return context.json(
          { error: "请先填写 TTS 接口地址与模型名称后再试听。" },
          400,
        );
      }

      try {
        const result = await synthesizeSpeech({
          text: data.text?.trim() || DEFAULT_TEST_TTS_TEXT,
          ...(data.voice?.trim() ? { voice: data.voice.trim() } : {}),
          format: data.format ?? "mp3",
          ...(data.speed !== undefined ? { speed: data.speed } : {}),
          actorKey: context.var.actor.id,
          configOverride: ttsOverride,
          signal: context.req.raw.signal,
        });
        return new Response(new Uint8Array(result.audio), {
          status: 200,
          headers: {
            "content-type": result.contentType,
            "cache-control": "no-store",
            "content-length": String(result.audio.byteLength),
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        if (error instanceof SpeechServiceError) {
          return context.json({ error: error.message }, error.status);
        }
        return context.json({ error: "语音合成试听失败，请稍后重试。" }, 502);
      }
    });

    app.post("/test-asr", adminOnly, adminBodyLimit, async (context) => {
      context.header("Cache-Control", "no-store");
      const rawBody: unknown = await context.req.json().catch(() => ({}));
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return context.json({ error: "请提供合法的 JSON 请求体。" }, 400);
      }
      const parsed = testAsrBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return context.json(
          {
            error: parsed.error.issues[0]?.message ?? "ASR 测试参数无效。",
          },
          400,
        );
      }
      const data = parsed.data;
      let asrConfig: SpeechAsrConfig | null = null;
      try {
        if (options.settingsStore) {
          asrConfig = await options.settingsStore.resolveForTestAsr({
            ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
            ...(data.model !== undefined ? { model: data.model } : {}),
            ...(data.apiKey !== undefined ? { apiKey: data.apiKey } : {}),
          });
        } else {
          const current = (
            await resolveConfig().catch((): SpeechConfig => ({}))
          ).asr;
          const rawBaseUrl = data.baseUrl || current?.baseUrl || "";
          const model = data.model ?? current?.model ?? "";
          if (rawBaseUrl && model) {
            const baseUrl = parseSpeechEndpointUrl(rawBaseUrl, "ASR 接口地址");
            const canReuseCurrentKey = sameSpeechOrigin(
              baseUrl,
              current?.baseUrl,
            );
            const apiKey =
              data.apiKey?.trim() ||
              (canReuseCurrentKey ? current?.apiKey : undefined);
            asrConfig = {
              baseUrl,
              model,
              ...(apiKey ? { apiKey } : {}),
            };
          }
        }
      } catch (error) {
        if (error instanceof SpeechSettingsValidationError) {
          return context.json({ error: error.message }, 400);
        }
        return context.json({ error: "无法解析语音识别配置。" }, 400);
      }

      if (!asrConfig) {
        return context.json(
          { ok: false, message: "请先填写 ASR 接口地址和模型名称。" },
          200,
        );
      }

      const result = await probeAsr(asrConfig, context.req.raw.signal);
      return context.json(result);
    });

    app.post(
      "/tts",
      async (context, next) => {
        const config = await resolveConfig().catch(() => null);
        if (!config?.tts || !isTtsConfigReady(config.tts)) {
          context.header("Cache-Control", "no-store");
          return context.json(
            { error: "语音合成服务尚未配置，请联系管理员配置 TTS 服务。" },
            503,
          );
        }
        await next();
      },
      bodyLimit({
        maxSize: TTS_BODY_LIMIT_BYTES,
        onError: (context) => {
          context.header("Cache-Control", "no-store");
          return context.json({ error: "请求体不能超过 64 KiB。" }, 413);
        },
      }),
      async (context) => {
        context.header("Cache-Control", "no-store");
        const rawBody: unknown = await context.req.json().catch(() => null);
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
          return context.json({ error: "请提供合法的 JSON 请求体。" }, 400);
        }
        const parsed = ttsBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return context.json(
            {
              error:
                parsed.error.issues[0]?.message ?? "语音合成请求参数无效。",
            },
            400,
          );
        }
        try {
          const result = await synthesizeSpeech({
            text: parsed.data.text,
            ...(parsed.data.voice ? { voice: parsed.data.voice } : {}),
            ...(parsed.data.format ? { format: parsed.data.format } : {}),
            ...(parsed.data.speed !== undefined
              ? { speed: parsed.data.speed }
              : {}),
            actorKey: context.var.actor.id,
            signal: context.req.raw.signal,
          });
          return new Response(new Uint8Array(result.audio), {
            status: 200,
            headers: {
              "content-type": result.contentType,
              "cache-control": "no-store",
              "content-length": String(result.audio.byteLength),
              "x-content-type-options": "nosniff",
            },
          });
        } catch (error) {
          if (error instanceof SpeechServiceError) {
            return context.json({ error: error.message }, error.status);
          }
          return context.json(
            { error: "语音合成服务暂时不可用，请稍后重试。" },
            502,
          );
        }
      },
    );

    app.post(
      "/asr",
      async (context, next) => {
        const config = await resolveConfig().catch(() => null);
        if (!config?.asr) {
          context.header("Cache-Control", "no-store");
          return context.json(
            { error: "语音识别服务尚未配置，请联系管理员配置 ASR 服务。" },
            503,
          );
        }
        await next();
      },
      bodyLimit({
        maxSize: MAX_SPEECH_ASR_BYTES + MULTIPART_FRAMING_ALLOWANCE,
        onError: (context) => {
          context.header("Cache-Control", "no-store");
          return context.json({ error: "音频文件不能超过 10 MiB。" }, 413);
        },
      }),
      async (context) => {
        context.header("Cache-Control", "no-store");
        const form = await context.req.raw.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File) || file.size === 0) {
          return context.json({ error: "请上传有效的音频文件。" }, 400);
        }
        const rawLanguage = form?.get("language");
        const language =
          typeof rawLanguage === "string" && rawLanguage.trim()
            ? rawLanguage.trim()
            : undefined;
        if (language && language.length > 32) {
          return context.json({ error: "语言代码过长。" }, 400);
        }
        try {
          const result = await transcribeAudio({
            data: file,
            mimeType: file.type,
            fileName: file.name,
            ...(language ? { language } : {}),
            signal: context.req.raw.signal,
          });
          context.header("Cache-Control", "no-store");
          return context.json({ text: result.text });
        } catch (error) {
          if (error instanceof SpeechServiceError) {
            return context.json({ error: error.message }, error.status);
          }
          return context.json(
            { error: "语音识别服务暂时不可用，请稍后重试。" },
            502,
          );
        }
      },
    );

    return app;
  }

  return {
    transcribeAudio,
    synthesizeSpeech,
    isTtsReady,
    statusView,
    listVoices,
    tools,
    routes,
  };
}
