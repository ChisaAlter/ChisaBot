import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { CHAT_FILES_MARKER } from "../../../../shared/chat-files";
import {
  DEFAULT_OPENAI_SPEECH_VOICES,
  DEFAULT_SPEECH_TTS_SPEED,
  DEFAULT_SPEECH_TTS_VOICE,
  MAX_SPEECH_TTS_CHARS,
  SPEECH_AUDIO_FORMATS,
  SPEECH_TTS_PROVIDER_PRESETS,
  type SpeechAudioFormat,
  type SpeechKeySource,
  type SpeechSettingsInput,
  type SpeechSettingsView,
  type SpeechStatusView,
  type SpeechTestAsrResult,
  type SpeechTtsProvider,
  type SpeechVoiceItem,
} from "../../../../shared/speech";

export {
  DEFAULT_OPENAI_SPEECH_VOICES,
  DEFAULT_SPEECH_TTS_SPEED,
  DEFAULT_SPEECH_TTS_VOICE,
  MAX_SPEECH_TTS_CHARS,
  SPEECH_AUDIO_FORMATS,
  SPEECH_TTS_PROVIDER_PRESETS,
  type SpeechAudioFormat,
  type SpeechKeySource,
  type SpeechSettingsInput,
  type SpeechSettingsView,
  type SpeechStatusView,
  type SpeechTestAsrResult,
  type SpeechTtsProvider,
  type SpeechVoiceItem,
};

const SPEECH_REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_SPEECH_STATUS: SpeechStatusView = {
  asrReady: false,
  ttsReady: false,
  defaultVoice: DEFAULT_SPEECH_TTS_VOICE,
  provider: "openai",
};

export const speechKeys = {
  all: ["speech"] as const,
  status: ["speech", "status"] as const,
  settings: ["speech", "settings"] as const,
  voices: (q = "") => ["speech", "voices", q] as const,
};

export type SynthesizeSpeechAudioInput = {
  text: string;
  voice?: string;
  format?: SpeechAudioFormat;
  speed?: number;
  signal?: AbortSignal;
};

export type SpeechTestTtsInput = {
  text?: string;
  provider?: SpeechTtsProvider;
  baseUrl?: string;
  model?: string;
  voice?: string;
  format?: SpeechAudioFormat;
  speed?: number;
  apiKey?: string;
  signal?: AbortSignal;
};

export type SpeechTestAsrInput = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  signal?: AbortSignal;
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/mp4": "mp4",
  "video/mp4": "mp4",
  "audio/m4a": "mp4",
  "audio/x-m4a": "mp4",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "application/ogg": "ogg",
};

function defaultRecordingName(mimeType: string): string {
  const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const ext = Object.hasOwn(EXTENSION_BY_MIME, base)
    ? EXTENSION_BY_MIME[base]
    : "webm";
  return `recording.${ext}`;
}

/** 查询当前部署 ASR / TTS 就绪状态；离线或接口未就绪时静默降级为未就绪，不阻塞聊天页渲染。 */
export function speechStatusQueryOptions() {
  return queryOptions({
    queryKey: speechKeys.status,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }): Promise<SpeechStatusView> => {
      try {
        const response = await tryClient("/api/speech/status", {
          signal,
          timeoutMs: 5_000,
        });
        if (!response.ok) return DEFAULT_SPEECH_STATUS;
        const payload = (await response
          .json()
          .catch(() => null)) as Partial<SpeechStatusView> | null;
        if (!payload || typeof payload !== "object") {
          return DEFAULT_SPEECH_STATUS;
        }
        return {
          asrReady: Boolean(payload.asrReady),
          ttsReady: Boolean(payload.ttsReady),
          defaultVoice:
            typeof payload.defaultVoice === "string"
              ? payload.defaultVoice
              : DEFAULT_SPEECH_TTS_VOICE,
          provider: payload.provider === "fish" ? "fish" : "openai",
        };
      } catch {
        return DEFAULT_SPEECH_STATUS;
      }
    },
  });
}

/** 管理员：读取语音服务设置视图。 */
export function speechSettingsQueryOptions() {
  return queryOptions({
    queryKey: speechKeys.settings,
    queryFn: async ({ signal }): Promise<SpeechSettingsView> => {
      const response = await client("/api/speech/settings", {
        signal,
        fallback: "无法加载语音服务设置。",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as SpeechSettingsView | null;
      if (!payload || typeof payload !== "object") {
        throw new Error("语音服务设置响应格式无效。");
      }
      return payload;
    },
  });
}

/** 管理员：保存语音服务设置。 */
export async function saveSpeechSettings(
  input: SpeechSettingsInput,
): Promise<SpeechSettingsView> {
  const response = await client("/api/speech/settings", {
    method: "PUT",
    body: input,
    fallback: "保存语音服务设置失败，请重试。",
  });
  const payload = (await response
    .json()
    .catch(() => null)) as SpeechSettingsView | null;
  if (!payload || typeof payload !== "object") {
    throw new Error("保存语音服务设置返回格式无效。");
  }
  return payload;
}

/** 按关键字拉取可用音色列表（内置 OpenAI + 已配置 Fish Audio 公共音色）。 */
export async function fetchSpeechVoices(
  q?: string,
  signal?: AbortSignal,
): Promise<SpeechVoiceItem[]> {
  const query = q?.trim() ?? "";
  const path = query
    ? `/api/speech/voices?q=${encodeURIComponent(query)}`
    : "/api/speech/voices";
  const voices = await client<SpeechVoiceItem[]>(path, "voices", {
    ...(signal ? { signal } : {}),
    fallback: "无法加载音色列表。",
  });
  return Array.isArray(voices) ? voices : [];
}

/** 管理员：短句试听 TTS（支持测试尚未保存的表单草稿），返回可播放音频 Blob。 */
export async function testSpeechTts(input: SpeechTestTtsInput): Promise<Blob> {
  const response = await client("/api/speech/test-tts", {
    method: "POST",
    body: {
      ...(input.text?.trim() ? { text: input.text.trim() } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.model !== undefined ? { model: input.model.trim() } : {}),
      ...(input.voice !== undefined ? { voice: input.voice.trim() } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    },
    fallback: "语音试听失败，请检查配置。",
    timeoutMs: SPEECH_REQUEST_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error("语音试听返回了空音频，请检查配置。");
  }
  return blob;
}

/** 管理员：测试 ASR 语音识别连通性（支持测试未保存草稿）。 */
export async function testSpeechAsr(
  input: SpeechTestAsrInput = {},
): Promise<SpeechTestAsrResult> {
  const response = await client("/api/speech/test-asr", {
    method: "POST",
    body: {
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.model !== undefined ? { model: input.model.trim() } : {}),
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    },
    fallback: "语音识别连通性测试失败。",
    timeoutMs: SPEECH_REQUEST_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const payload = (await response
    .json()
    .catch(() => null)) as Partial<SpeechTestAsrResult> | null;
  if (!payload || typeof payload.ok !== "boolean") {
    throw new Error("语音识别测试返回格式无效。");
  }
  return {
    ok: payload.ok,
    message:
      typeof payload.message === "string" && payload.message.trim()
        ? payload.message
        : payload.ok
          ? "语音识别服务连接正常。"
          : "语音识别服务测试失败。",
    ...(typeof payload.latencyMs === "number"
      ? { latencyMs: payload.latencyMs }
      : {}),
  };
}

/**
 * 清理 Markdown 文本供语音朗读：
 * 去除代码块围栏、图片语法、链接 URL 与格式标记，保留自然可读正文。
 */
export function stripMarkdownForSpeech(markdown: string): string {
  if (!markdown) return "";
  let text = markdown.replace(/\r\n?/g, "\n");

  // 去掉工具结果末行的聊天文件内部标记。
  const markerIndex = text.lastIndexOf(CHAT_FILES_MARKER);
  if (markerIndex >= 0) {
    text = text.slice(0, markerIndex);
  }

  // 去掉 HTML 注释。
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // 去掉围栏代码块（``` 或 ~~~），包括末尾未闭合的围栏。
  text = text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "\n");
  text = text.replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "\n");

  // 去掉嵌套图片链接 [![alt](img)](link) 与普通图片 ![alt](url)。
  text = text.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ");

  // 参考式链接定义行 [id]: https://...
  text = text.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");

  // Markdown 链接 [文本](URL) 仅保留可读文本；若标签为空则移除。
  text = text.replace(
    /\[([^\]]*)\]\((?:[^()\s]+|\([^)]*\))+(?:\s+"[^"]*")?\)/g,
    "$1",
  );
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

  // 自动链接 <https://...> 与裸 URL。
  text = text.replace(/<https?:\/\/[^>]+>/gi, " ");
  text = text.replace(/https?:\/\/[^\s<>()[\]"']+/gi, " ");

  // 行内代码去掉反引号保留代码标识。
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // 清除 Markdown 表格分隔行，并把普通表格行的管道符转换为自然停顿。
  text = text.replace(
    /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/gm,
    "",
  );
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_match, row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join("，"),
  );

  // 去掉水平分割线、标题井号、引用符号与列表前缀。
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*(?:>\s*)+/gm, "");
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "");

  // 去掉粗体、斜体、删除线格式符（不破坏词中下划线如 foo_bar）。
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?)(?<=\S)\1/g, "$2");
  text = text.replace(/~~(?=\S)([\s\S]*?)(?<=\S)~~/g, "$1");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  text = text.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "$1");

  // 去掉内联 HTML 标签。
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, " ");

  // 清理空的成对括号（例如「详见（）」在删掉链接后残留的空括号）。
  text = text.replace(/\(\s*\)|（\s*）/g, "");

  // 规范空白与换行。
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** 将朗读文本按句末标点安全截断到上限字符数内，避免切破代理对或半句话截断。 */
export function truncateForSpeech(
  text: string,
  maxChars = MAX_SPEECH_TTS_CHARS,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  if (maxChars <= 0) return "";

  let end = maxChars;
  // 避免把 UTF-16 高低代理对从中间截断。
  const lastCode = trimmed.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }

  const window = trimmed.slice(0, end);
  const minBoundary = Math.floor(end * 0.5);

  const sentenceEndRe = /[。！？.!?\n]/g;
  let lastSentenceEnd = -1;
  for (const match of window.matchAll(sentenceEndRe)) {
    if (match.index !== undefined && match.index >= minBoundary) {
      lastSentenceEnd = match.index + 1;
    }
  }
  if (lastSentenceEnd > 0) {
    return window.slice(0, lastSentenceEnd).trim();
  }

  const clauseEndRe = /[，、；,; ]/g;
  let lastClauseEnd = -1;
  for (const match of window.matchAll(clauseEndRe)) {
    if (match.index !== undefined && match.index >= minBoundary) {
      lastClauseEnd = match.index + 1;
    }
  }
  if (lastClauseEnd > 0) {
    return window.slice(0, lastClauseEnd).trim();
  }

  return window.trim();
}

/** 调用统一语音合成接口 `/api/speech/tts`，返回可直接创建对象 URL 播放的音频 Blob。 */
export async function synthesizeSpeechAudio(
  input: SynthesizeSpeechAudioInput,
): Promise<Blob> {
  const text = input.text.trim();
  if (!text) {
    throw new Error("合成文本不能为空。");
  }
  if (text.length > MAX_SPEECH_TTS_CHARS) {
    throw new Error(`合成文本不能超过 ${MAX_SPEECH_TTS_CHARS} 个字符。`);
  }

  const response = await client("/api/speech/tts", {
    method: "POST",
    body: {
      text,
      ...(input.voice?.trim() ? { voice: input.voice.trim() } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
    },
    fallback: "语音合成失败，请稍后重试。",
    timeoutMs: SPEECH_REQUEST_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!response.ok) {
    throw new Error("语音合成失败，请稍后重试。");
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error("语音合成返回了空音频，请重试。");
  }
  return blob;
}

/** 调用统一语音识别接口 `/api/speech/asr`，上传音频文件并返回识别文本。 */
export async function transcribeSpeechAudio(
  file: Blob | File,
  signal?: AbortSignal,
): Promise<string> {
  if (file.size === 0) {
    throw new Error("音频文件不能为空。");
  }

  const formData = new FormData();
  const fileName =
    file instanceof File && file.name.trim()
      ? file.name.trim()
      : defaultRecordingName(file.type);
  formData.set("file", file, fileName);

  const response = await client("/api/speech/asr", {
    method: "POST",
    body: formData,
    fallback: "语音识别失败，请稍后重试。",
    timeoutMs: SPEECH_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });

  const payload = (await response.json().catch(() => null)) as {
    text?: unknown;
  } | null;
  if (!payload || typeof payload.text !== "string") {
    throw new Error("语音识别返回格式无效，请稍后重试。");
  }
  return payload.text.trim();
}
