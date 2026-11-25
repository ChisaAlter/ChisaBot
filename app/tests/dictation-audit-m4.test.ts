import { afterEach, expect, test } from "bun:test";
import {
  DICTATION_NO_SPEECH_MESSAGE,
  DICTATION_UPLOAD_NETWORK_MESSAGE,
  DICTATION_UPLOAD_OFFLINE_MESSAGE,
  DictationError,
  MIC_DENIED_ANDROID_MESSAGE,
  MIC_DENIED_MESSAGE,
  MIC_DENIED_PC_MESSAGE,
  micDeniedMessage,
  micPlatform,
  transcribeRecording,
} from "@/lib/dictation/recording";
import {
  DICTATION_TRANSCRIBE_FAILED_MESSAGE,
  DictationSession,
} from "@/lib/dictation/session";

/**
 * Audit module 4, dictation: a retry after a failure must capture or upload again rather than
 * re-transcribe an empty result, and a missing network must be named as such.
 */

const realFetch = globalThis.fetch;
const g = globalThis as unknown as { window?: unknown };
const realWindow = g.window;

function setOnline(online: boolean) {
  Object.defineProperty(globalThis.navigator, "onLine", {
    value: online,
    configurable: true,
  });
}

afterEach(() => {
  setOnline(true);
  globalThis.fetch = realFetch;
  g.window = realWindow;
});

const signal = () => new AbortController().signal;

test("a server that heard nothing makes retry record again, not resend the same audio", async () => {
  let recordings = 0;
  let uploads = 0;
  const session = new DictationSession({
    record: async () => {
      recordings++;
      return {
        finish: async () => new Blob(["a"], { type: "audio/webm" }),
        cancel() {},
      };
    },
    transcribe: async () => {
      uploads++;
      throw new DictationError(DICTATION_NO_SPEECH_MESSAGE, true);
    },
    onTranscript() {},
  });
  await session.start();
  await session.finish();
  expect(session.getSnapshot().canRetry).toBe(false);
  await session.retry();
  expect(recordings).toBe(2);
  expect(uploads).toBe(1);
});

test("a network failure while uploading keeps the audio and retry uploads it again", async () => {
  const audio = new Blob(["a"], { type: "audio/webm" });
  let recordings = 0;
  const seen: Blob[] = [];
  const session = new DictationSession({
    record: async () => {
      recordings++;
      return { finish: async () => audio, cancel() {} };
    },
    transcribe: async (blob) => {
      seen.push(blob);
      if (seen.length === 1)
        throw new DictationError(DICTATION_UPLOAD_OFFLINE_MESSAGE, false);
      return "ok";
    },
    onTranscript() {},
  });
  await session.start();
  await session.finish();
  expect(session.getSnapshot()).toMatchObject({
    canRetry: true,
    error: DICTATION_UPLOAD_OFFLINE_MESSAGE,
  });
  await session.retry();
  expect(recordings).toBe(1);
  expect(seen).toEqual([audio, audio]);
});

test("uploading while offline names the network and does not call the server", async () => {
  setOnline(false);
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response("{}");
  }) as unknown as typeof fetch;
  const error = await transcribeRecording(
    new Blob(["a"], { type: "audio/webm" }),
    signal(),
  ).catch((e: unknown) => e);
  expect(called).toBe(0);
  expect((error as DictationError).message).toBe(
    DICTATION_UPLOAD_OFFLINE_MESSAGE,
  );
  expect((error as DictationError).rerecord).toBe(false);
});

test("a fetch network error is reported in Chinese and keeps the audio retryable", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  const error = await transcribeRecording(
    new Blob(["a"], { type: "audio/webm" }),
    signal(),
  ).catch((e: unknown) => e);
  expect((error as DictationError).message).toBe(
    DICTATION_UPLOAD_NETWORK_MESSAGE,
  );
  expect((error as DictationError).rerecord).toBe(false);
});

test("a denied microphone tells the user where to allow it", async () => {
  expect(micDeniedMessage("browser")).toBe(MIC_DENIED_MESSAGE);
  expect(MIC_DENIED_MESSAGE).toContain("地址栏");
  expect(MIC_DENIED_MESSAGE).toContain("允许");
  const session = new DictationSession({
    record: async () => {
      throw new DOMException("denied", "NotAllowedError");
    },
    transcribe: async () => "unused",
    onTranscript() {},
  });
  await session.start();
  expect(session.getSnapshot().error).toBe(MIC_DENIED_MESSAGE);
});

test("the denied-microphone sentence matches where the app runs", () => {
  const doc = globalThis as unknown as { document?: unknown };
  const realDocument = doc.document;
  try {
    g.window = {};
    expect(micPlatform()).toBe("browser");
    expect(micDeniedMessage()).toBe(MIC_DENIED_MESSAGE);

    // The PC app has no address bar, so it must not be sent looking for one.
    g.window = { chisabotWindow: {} };
    expect(micPlatform()).toBe("pc");
    expect(micDeniedMessage()).toBe(MIC_DENIED_PC_MESSAGE);
    expect(MIC_DENIED_PC_MESSAGE).not.toContain("地址栏");
    expect(MIC_DENIED_PC_MESSAGE).toContain("隐私");
    expect(MIC_DENIED_PC_MESSAGE).toContain("允许桌面应用访问麦克风");

    g.window = {};
    doc.document = {
      documentElement: {
        hasAttribute: (name: string) => name === "data-android-app",
      },
    };
    expect(micPlatform()).toBe("android");
    expect(micDeniedMessage()).toBe(MIC_DENIED_ANDROID_MESSAGE);
    expect(MIC_DENIED_ANDROID_MESSAGE).not.toContain("地址栏");
    // The WebView cannot get the microphone at all yet (no onPermissionRequest, no RECORD_AUDIO),
    // so no setting can fix it: say it is not supported and where it does work, not where to click.
    expect(MIC_DENIED_ANDROID_MESSAGE).toContain("暂时还不支持语音输入");
    expect(MIC_DENIED_ANDROID_MESSAGE).not.toContain("网站设置");
    expect(MIC_DENIED_ANDROID_MESSAGE).not.toContain("权限");
    expect(MIC_DENIED_ANDROID_MESSAGE).not.toContain("重新录音");
  } finally {
    doc.document = realDocument;
    g.window = realWindow;
  }
});

test("a transcription that fails without a reason says so in the module's voice and offers 「重试」", async () => {
  const session = new DictationSession({
    record: async () => ({
      finish: async () => new Blob(["a"], { type: "audio/webm" }),
      cancel() {},
    }),
    transcribe: async () => {
      throw "boom";
    },
    onTranscript() {},
  });
  await session.start();
  await session.finish();
  expect(session.getSnapshot()).toMatchObject({
    phase: "error",
    canRetry: true,
    error: DICTATION_TRANSCRIBE_FAILED_MESSAGE,
  });
});
