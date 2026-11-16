import { client } from "@/lib/client";

export const SPEECH_AUDIO_FORMATS = ["mp3", "wav", "opus", "aac"] as const;
export type SpeechAudioFormat = (typeof SPEECH_AUDIO_FORMATS)[number];

export const MAX_SPEECH_TTS_CHARS = 4_000;
const SPEECH_REQUEST_TIMEOUT_MS = 60_000;

export type SynthesizeSpeechAudioInput = {
  text: string;
  voice?: string;
  format?: SpeechAudioFormat;
  speed?: number;
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
