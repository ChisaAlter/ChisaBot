import { tryClient } from "@/lib/client";
import { isAndroidApp } from "@/lib/device";
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

/**
 * Where to turn the microphone back on, since nothing will ask a second time by itself. One sentence
 * per place the app runs, because the way back differs: a browser has the lock icon in its address
 * bar, and the PC app has no address bar at all (the switch is in Windows' privacy settings, and the
 * one that blocks a desktop app is 「允许桌面应用访问麦克风」).
 *
 * THE ANDROID APP HAS NO WAY BACK YET, so it is not sent looking for one: its WebView does not
 * implement `onPermissionRequest` and the manifest does not declare `RECORD_AUDIO`, so neither
 * Chrome's site settings nor the app's permission page can turn the microphone on. It says plainly
 * that voice input is not supported there yet. When the Android side grants the microphone (a
 * separate client PR), this becomes real instructions.
 */
export const MIC_DENIED_MESSAGE =
  "麦克风权限被拒绝了。点地址栏左边的锁形图标，把「麦克风」改成「允许」后点「重新录音」；手机上请到系统设置里允许浏览器使用麦克风。";
export const MIC_DENIED_PC_MESSAGE =
  "麦克风权限被拒绝了。请到 Windows「设置 → 隐私和安全性 → 麦克风」里打开「允许桌面应用访问麦克风」，再点「重新录音」。";
export const MIC_DENIED_ANDROID_MESSAGE =
  "安卓 App 暂时还不支持语音输入。要用语音输入，请在 PC 客户端或浏览器里打开 ChisaBot。";

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

export const DICTATION_UPLOAD_OFFLINE_MESSAGE =
  "没有网络连接，没能把录音传上去。联网后点「重试」。";
export const DICTATION_UPLOAD_NETWORK_MESSAGE =
  "网络出错，没能把录音传上去。请点「重试」。";
export const DICTATION_NO_SPEECH_MESSAGE = "未检测到语音。请重新录音。";

/**
 * A dictation failure that says whether trying again can reuse what was captured. `rerecord` is
 * true when the capture itself is the problem (nothing was heard), so "try again" has to open the
 * microphone.
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

export function recordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
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
    response = await tryClient("/api/audio/transcriptions", {
      method: "POST",
      headers: { "x-chisabot-dictation": "1" },
      body,
      signal,
      timeoutMs: DICTATION_TIMEOUT_MS + 5_000,
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
