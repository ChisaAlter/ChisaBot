import {
  DICTATION_TIMEOUT_MS,
  dictationExtension,
  dictationMediaType,
  MAX_DICTATION_BYTES,
} from "../../../../shared/dictation";
import { isAndroidApp } from "@/lib/device";

export interface Recording {
  /** Shared with the visualizer; the recorder owns this stream's lifetime. */
  readonly stream?: MediaStream;
  finish(): Promise<Blob>;
  cancel(): void;
}

const BROWSER_SPEECH_MIME = "application/x-chisabot-speech";

/**
 * Where to turn the microphone back on, since nothing will ask a second time by itself. One sentence
 * per place the app runs, because the way back differs: a browser has the lock icon in its address
 * bar, the PC app has no address bar at all (the switch is in the system's privacy settings), and
 * on Android the WebView follows Chrome's site setting first and the app permission second.
 */
export const MIC_DENIED_MESSAGE =
  "麦克风权限被拒绝了。点地址栏左边的锁形图标，把「麦克风」改成「允许」后点「重新录音」；手机上请到系统设置里允许浏览器使用麦克风。";
export const MIC_DENIED_PC_MESSAGE =
  "麦克风权限被拒绝了。请到系统设置的「隐私和安全性 → 麦克风」里允许 ChisaBot 使用麦克风，再点「重新录音」。";
export const MIC_DENIED_ANDROID_MESSAGE =
  "麦克风权限被拒绝了。先到 Chrome 的「设置 → 网站设置 → 麦克风」里允许本站使用麦克风；还不行的话，到系统设置的「应用 → ChisaBot → 权限」里打开麦克风，再点「重新录音」。";

export type MicPlatform = "browser" | "pc" | "android";

/** Which of the three the app is running in, by the same marks `isNativeClient` reads. */
export function micPlatform(): MicPlatform {
  if (isAndroidApp()) return "android";
  if (typeof window !== "undefined") {
    const w = window as { chisabotWindow?: unknown };
    if (w.chisabotWindow) return "pc";
    if (
      typeof navigator !== "undefined" &&
      /\bElectron\//.test(navigator.userAgent ?? "")
    ) {
      return "pc";
    }
  }
  return "browser";
}

/** The denied-microphone sentence for where this app is running. */
export function micDeniedMessage(
  platform: MicPlatform = micPlatform(),
): string {
  if (platform === "pc") return MIC_DENIED_PC_MESSAGE;
  if (platform === "android") return MIC_DENIED_ANDROID_MESSAGE;
  return MIC_DENIED_MESSAGE;
}

/** Browser speech recognition runs on the vendor's servers, so it needs the network as much as upload does. */
export const DICTATION_OFFLINE_MESSAGE =
  "没有网络连接，语音输入用不了。联网后点「重新录音」。";
export const DICTATION_UPLOAD_OFFLINE_MESSAGE =
  "没有网络连接，没能把录音传上去。联网后点「重试」。";
export const DICTATION_UPLOAD_NETWORK_MESSAGE =
  "网络出错，没能把录音传上去。请点「重试」。";
export const DICTATION_NO_SPEECH_MESSAGE = "未检测到语音。请重新录音。";

/**
 * A dictation failure that says whether trying again can reuse what was captured. `rerecord` is
 * true when the capture itself is the problem (nothing was heard, or browser recognition produced
 * an empty transcript that cannot be recognised again), so "try again" has to open the microphone.
 */
export class DictationError extends Error {
  constructor(
    message: string,
    readonly rerecord: boolean,
  ) {
    super(message);
    this.name = "DictationError";
  }
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }>;
      }) => void)
    | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function getSpeechRecognitionCtor():
  | (new () => BrowserSpeechRecognition)
  | null {
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
  recognition.lang =
    (typeof navigator !== "undefined" && navigator.language) || "zh-CN";
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
    onError(
      new Error(
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? micDeniedMessage()
          : event.error === "network" || isOffline()
            ? DICTATION_OFFLINE_MESSAGE
            : "语音输入中断了，请重新录音。",
      ),
    );
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
    throw new Error("语音输入需要支持的浏览器和 HTTPS（或 localhost）。");
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
      // Recognition gives up silently when the network drops, so an empty result while offline
      // is a missing connection, not a quiet speaker. Either way the transcript is gone: re-record.
      throw new DictationError(
        isOffline() ? DICTATION_OFFLINE_MESSAGE : DICTATION_NO_SPEECH_MESSAGE,
        true,
      );
    }
    return text;
  }
  const type = dictationMediaType(audio.type);
  const extension = dictationExtension(type);
  if (!extension || !audio.size || audio.size > MAX_DICTATION_BYTES) {
    throw new DictationError("录音为空或不支持。请重新录音。", true);
  }
  if (isOffline())
    throw new DictationError(DICTATION_UPLOAD_OFFLINE_MESSAGE, false);
  const body = new FormData();
  body.set("file", audio, `recording.${extension}`);
  let response: Response;
  try {
    response = await fetch("/api/audio/transcriptions", {
      method: "POST",
      credentials: "include",
      headers: { "x-chisabot-dictation": "1" },
      body,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(DICTATION_TIMEOUT_MS + 5_000),
      ]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    // The recording is still held, so the same audio can be uploaded again.
    throw new DictationError(
      isOffline()
        ? DICTATION_UPLOAD_OFFLINE_MESSAGE
        : DICTATION_UPLOAD_NETWORK_MESSAGE,
      false,
    );
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      result &&
        typeof result === "object" &&
        "error" in result &&
        typeof result.error === "string"
        ? result.error
        : "识别失败。请重试。",
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("text" in result) ||
    typeof result.text !== "string" ||
    !result.text.trim()
  ) {
    throw new DictationError(DICTATION_NO_SPEECH_MESSAGE, true);
  }
  return result.text.trim();
}
