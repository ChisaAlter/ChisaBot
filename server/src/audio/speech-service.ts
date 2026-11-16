import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { currentToolAbort, TOOL_STOPPED_ZH } from "../confirmations/context";
import { trustedEndpointFetch } from "../net/trusted-endpoint-fetch";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";

export const MAX_SPEECH_TTS_CHARS = 4_000;
export const MAX_SPEECH_ASR_BYTES = 10 * 1024 * 1024;
export const SPEECH_TIMEOUT_MS = 60_000;
export const DEFAULT_SPEECH_TTS_VOICE = "alloy";

const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;
const TTS_BODY_LIMIT_BYTES = 64 * 1024;

export const SPEECH_AUDIO_FORMATS = ["mp3", "wav", "opus", "aac"] as const;
export type SpeechAudioFormat = (typeof SPEECH_AUDIO_FORMATS)[number];

export type SpeechAsrConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export type SpeechTtsConfig = {
  baseUrl: string;
  model: string;
  voice?: string;
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

  if (!baseUrl && !model && !voice && !apiKey) {
    return undefined;
  }
  if (!baseUrl || !model) {
    throw new Error(
      "配置语音合成服务时必须同时提供 SPEECH_TTS_BASE_URL 和 SPEECH_TTS_MODEL。",
    );
  }
  return {
    baseUrl: parseHttpEndpointUrl(baseUrl, "SPEECH_TTS_BASE_URL"),
    model,
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
  tools(): GrantedTool[];
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
};

function isSupportedTtsFormat(value: string): value is SpeechAudioFormat {
  return (SPEECH_AUDIO_FORMATS as readonly string[]).includes(value);
}

/** 创建统一原生语音服务（ASR + TTS + 机器人朗读工具 + `/api/speech` 路由）。 */
export function createSpeechService(options: {
  getConfig: () => SpeechConfig | Promise<SpeechConfig>;
  transport?: SpeechTransport;
  publicOrigin?: string;
  timeoutMs?: number;
}): SpeechService {
  const transport = options.transport ?? defaultTransport;
  const timeoutMs = options.timeoutMs ?? SPEECH_TIMEOUT_MS;
  const publicOrigin = options.publicOrigin?.trim().replace(/\/+$/, "");

  async function resolveConfig(): Promise<SpeechConfig> {
    try {
      return await options.getConfig();
    } catch {
      throw new SpeechServiceError(
        "not-configured",
        "语音服务配置加载失败，请联系管理员检查配置。",
        503,
      );
    }
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

    const baseUrl = normalizeEndpointBase(config.asr.baseUrl);
    const form = new FormData();
    form.set("file", file);
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
    const config = await resolveConfig();
    if (!config.tts) {
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

    const format = input.format ?? "mp3";
    if (!isSupportedTtsFormat(format)) {
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
    const voice =
      input.voice?.trim() ||
      config.tts.voice?.trim() ||
      DEFAULT_SPEECH_TTS_VOICE;
    if (voice.length > 128) {
      throw new SpeechServiceError("invalid-input", "发音人名称过长。", 400);
    }

    const baseUrl = normalizeEndpointBase(config.tts.baseUrl);
    const reqSignal = createRequestSignal(input.signal, timeoutMs);
    if (reqSignal.signal.aborted) {
      reqSignal.dispose();
      throw new SpeechServiceError(
        "upstream-timeout",
        "语音合成请求已超时或被取消，请重试。",
        504,
      );
    }

    try {
      const response = await transport(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.tts.apiKey
            ? { authorization: `Bearer ${config.tts.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: config.tts.model,
          input: text,
          voice,
          response_format: format,
          ...(input.speed !== undefined ? { speed: input.speed } : {}),
        }),
        signal: reqSignal.signal,
        redirect: "error",
      });
      assertUpstreamOk(response, "TTS");

      const buffer = await response.arrayBuffer();
      if (reqSignal.signal.aborted) {
        throw new SpeechServiceError(
          "upstream-timeout",
          "语音合成请求已超时或被取消，请重试。",
          504,
        );
      }
      const audio = new Uint8Array(buffer);
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
        : TTS_CONTENT_TYPE_TABLE[format];

      return { audio, contentType, voice, format };
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
    }
  }

  function tools(): GrantedTool[] {
    return [
      {
        name: "speech_synthesize",
        ref: "audio/speech_synthesize",
        effect: "read",
        description:
          "将文字合成为语音音频。当用户要求朗读文本、配音或生成语音消息时调用，返回合成音频的格式、发音人和字节大小摘要。",
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
              ...(signal ? { signal } : {}),
            });
            return [
              "语音合成完成：",
              `- 格式：${result.format}（${result.contentType}）`,
              `- 发音人：${result.voice}`,
              `- 大小：${result.audio.byteLength} 字节`,
              ...(publicOrigin
                ? [`- 前端播放接口：${publicOrigin}/api/speech/tts`]
                : []),
            ].join("\n");
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

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);

    app.post(
      "/tts",
      async (context, next) => {
        const config = await resolveConfig().catch(() => null);
        if (!config?.tts) {
          return context.json(
            { error: "语音合成服务尚未配置，请联系管理员配置 TTS 服务。" },
            503,
          );
        }
        await next();
      },
      bodyLimit({
        maxSize: TTS_BODY_LIMIT_BYTES,
        onError: (context) =>
          context.json({ error: "请求体不能超过 64 KiB。" }, 413),
      }),
      async (context) => {
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
          return context.json(
            { error: "语音识别服务尚未配置，请联系管理员配置 ASR 服务。" },
            503,
          );
        }
        await next();
      },
      bodyLimit({
        maxSize: MAX_SPEECH_ASR_BYTES + MULTIPART_FRAMING_ALLOWANCE,
        onError: (context) =>
          context.json({ error: "音频文件不能超过 10 MiB。" }, 413),
      }),
      async (context) => {
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
    tools,
    routes,
  };
}
