import {
  DICTATION_TIMEOUT_MS,
  dictationExtension,
  dictationMediaType,
  MAX_DICTATION_BYTES,
} from "../../../../shared/dictation";

export interface Recording {
  /** Shared with the visualizer; the recorder owns this stream's lifetime. */
  readonly stream?: MediaStream;
  finish(): Promise<Blob>;
  cancel(): void;
}

const BROWSER_SPEECH_MIME = "application/x-chisabot-speech";

type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function getSpeechRecognitionCtor(): (new () => BrowserSpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export function recordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export async function startSpeechRecognitionRecording(
  onError: (error: Error) => void,
): Promise<Recording> {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    throw new Error("当前浏览器不支持本地语音识别。");
  }
  let stream: MediaStream | undefined;
  if (navigator.mediaDevices?.getUserMedia) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // 即使未授予独立音频流可视化，也继续尝试 SpeechRecognition
    }
  }
  const releaseStream = () => {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  };

  const recognition = new Ctor();
  recognition.lang = (typeof navigator !== "undefined" && navigator.language) || "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;

  let transcript = "";
  let done: ReturnType<typeof Promise.withResolvers<Blob>> | undefined;
  let cancelled = false;

  recognition.onresult = (event) => {
    const parts: string[] = [];
    for (let i = 0; i < event.results.length; i++) {
      const item = event.results[i];
      const piece = item?.[0]?.transcript ?? "";
      if (piece) parts.push(piece);
    }
    transcript = parts.join("").trim();
  };

  recognition.onerror = (event) => {
    if (cancelled) return;
    if (event.error === "no-speech") return;
    releaseStream();
    onError(new Error(event.error === "not-allowed" ? "浏览器未授予麦克风权限。" : "语音速记中断，请重试。"));
  };

  recognition.onend = () => {
    releaseStream();
    if (done) {
      done.resolve(new Blob([transcript], { type: BROWSER_SPEECH_MIME }));
    }
  };

  try {
    recognition.start();
  } catch (err) {
    releaseStream();
    throw err;
  }

  return {
    stream,
    cancel() {
      cancelled = true;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // ignore
      }
      releaseStream();
      done?.reject(new DOMException("Recording cancelled", "AbortError"));
    },
    finish() {
      if (done) return done.promise;
      done = Promise.withResolvers<Blob>();
      try {
        recognition.stop();
      } catch {
        releaseStream();
        done.resolve(new Blob([transcript], { type: BROWSER_SPEECH_MIME }));
      }
      return done.promise;
    },
  };
}

export async function startRecording(
  onError: (error: Error) => void,
): Promise<Recording> {
  if (!recordingSupported())
    throw new Error("口述需要支持的浏览器和HTTPS（或localhost）。");
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
  if (!mimeType) throw new Error("此浏览器无法录制支持的音频格式。");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (error) {
    release();
    throw error;
  }
  let chunks: Blob[] = [];
  let size = 0;
  let done: ReturnType<typeof Promise.withResolvers<Blob>> | undefined;
  const cancel = () => {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    if (recorder.state !== "inactive") recorder.stop();
    release();
    chunks = [];
    done?.reject(new DOMException("Recording cancelled", "AbortError"));
  };
  recorder.ondataavailable = (event) => {
    size += event.data.size;
    if (size > MAX_DICTATION_BYTES) {
      cancel();
      onError(new Error("录音太大。尝试更短的消息。"));
      return;
    }
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onerror = () => {
    cancel();
    onError(new Error("麦克风停止录音。请重试。"));
  };
  recorder.onstop = () => {
    release();
    if (!done) {
      onError(new Error("录音被中断。请重试。"));
      return;
    }
    done.resolve(
      new Blob(chunks, { type: dictationMediaType(recorder.mimeType) }),
    );
    chunks = [];
  };
  try {
    recorder.start(250);
  } catch (error) {
    cancel();
    throw error;
  }
  return {
    stream,
    cancel,
    finish() {
      if (done) return done.promise;
      done = Promise.withResolvers<Blob>();
      if (recorder.state === "inactive") {
        release();
        done.reject(new Error("录音在音频收集之前停止。"));
      } else {
        recorder.stop();
        release();
      }
      return done.promise;
    },
  };
}

export async function transcribeRecording(
  audio: Blob,
  signal: AbortSignal,
): Promise<string> {
  if (audio.type.startsWith(BROWSER_SPEECH_MIME)) {
    const text = (await audio.text()).trim();
    if (!text) {
      throw new Error("未检测到语音。请尝试再次录音。");
    }
    return text;
  }
  const type = dictationMediaType(audio.type);
  const extension = dictationExtension(type);
  if (!extension || !audio.size || audio.size > MAX_DICTATION_BYTES) {
    throw new Error("录音为空或不支持。请重新录音。");
  }
  const body = new FormData();
  body.set("file", audio, `recording.${extension}`);
  const response = await fetch("/api/audio/transcriptions", {
    method: "POST",
    credentials: "include",
    headers: { "x-chisabot-dictation": "1" },
    body,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(DICTATION_TIMEOUT_MS + 5_000),
    ]),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      result &&
        typeof result === "object" &&
        "error" in result &&
        typeof result.error === "string"
        ? result.error
        : "转录失败。请重试。",
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("text" in result) ||
    typeof result.text !== "string" ||
    !result.text.trim()
  ) {
    throw new Error("未检测到语音。请尝试再次录音。");
  }
  return result.text.trim();
}
