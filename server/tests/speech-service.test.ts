import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createSpeechService,
  MAX_SPEECH_ASR_BYTES,
  MAX_SPEECH_TTS_CHARS,
  type SpeechConfig,
  SpeechServiceError,
  speechConfigFromEnv,
} from "../src/audio/speech-service";
import { TOOL_STOPPED_ZH } from "../src/confirmations/context";
import { REFUSAL_MARKER } from "../src/plugins/tools";

const authenticatedUser: MiddlewareHandler<{
  Variables: AppVariables;
}> = async (context, next) => {
  context.set("actor", {
    id: "user-speech-1",
    email: "speech@example.com",
    role: "user",
  });
  await next();
};

const unauthenticatedUser: MiddlewareHandler<{ Variables: AppVariables }> = (
  context,
) => context.json({ error: "Authentication required." }, 401);

function makeAsrForm(
  mimeType = "audio/webm",
  size = 16,
  fileName?: string,
  language?: string,
): FormData {
  const ext = mimeType.includes("mp4")
    ? "mp4"
    : mimeType.includes("wav")
      ? "wav"
      : mimeType.includes("mpeg") || mimeType.includes("mp3")
        ? "mp3"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("html")
            ? "html"
            : "webm";
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(size)], fileName ?? `clip.${ext}`, {
      type: mimeType,
    }),
  );
  if (language !== undefined) {
    form.set("language", language);
  }
  return form;
}

describe("speechConfigFromEnv", () => {
  test("普通聊天凭据不会启用语音服务，空环境返回空配置", () => {
    expect(
      speechConfigFromEnv({
        OPENAI_API_KEY: "chat-secret",
        OPENAI_BASE_URL: "https://chat.example/v1",
      }),
    ).toEqual({});
  });

  test("优先读取 SPEECH_TTS_* 与 SPEECH_ASR_*，并去除末尾斜杠", () => {
    const config = speechConfigFromEnv({
      SPEECH_ASR_BASE_URL: "https://asr.example/v1///",
      SPEECH_ASR_MODEL: "whisper-large-v3",
      SPEECH_ASR_API_KEY: "asr-key",
      SPEECH_TTS_BASE_URL: "http://localhost:8880/v1/",
      SPEECH_TTS_MODEL: "kokoro-v1",
      SPEECH_TTS_VOICE: "zf_xiaoxiao",
      SPEECH_TTS_API_KEY: "tts-key",
      TRANSCRIPTION_PROVIDER: "openai-compatible",
      TRANSCRIPTION_BASE_URL: "https://legacy.example/v1",
      TRANSCRIPTION_MODEL: "legacy-whisper",
      TRANSCRIPTION_API_KEY: "legacy-key",
    });

    expect(config).toEqual({
      asr: {
        baseUrl: "https://asr.example/v1",
        model: "whisper-large-v3",
        apiKey: "asr-key",
      },
      tts: {
        baseUrl: "http://localhost:8880/v1",
        model: "kokoro-v1",
        voice: "zf_xiaoxiao",
        apiKey: "tts-key",
      },
    });
  });

  test("未配置 SPEECH_ASR_* 时兼容复用 TRANSCRIPTION_* 作为 ASR 兜底", () => {
    const withProvider = speechConfigFromEnv({
      TRANSCRIPTION_PROVIDER: "openai-compatible",
      TRANSCRIPTION_BASE_URL: "https://transcribe.example/v1/",
      TRANSCRIPTION_MODEL: "whisper-1",
      TRANSCRIPTION_API_KEY: "transcribe-key",
    });
    expect(withProvider).toEqual({
      asr: {
        baseUrl: "https://transcribe.example/v1",
        model: "whisper-1",
        apiKey: "transcribe-key",
      },
    });

    const withoutProvider = speechConfigFromEnv({
      TRANSCRIPTION_BASE_URL: "http://127.0.0.1:9000/v1",
      TRANSCRIPTION_MODEL: "faster-whisper",
    });
    expect(withoutProvider).toEqual({
      asr: {
        baseUrl: "http://127.0.0.1:9000/v1",
        model: "faster-whisper",
      },
    });
  });

  test("拒绝非法 URL、内嵌凭据、查询串、片段以及不完整配置", () => {
    expect(() =>
      speechConfigFromEnv({
        SPEECH_TTS_BASE_URL: "file:///tmp/tts",
        SPEECH_TTS_MODEL: "tts-1",
      }),
    ).toThrow("HTTP(S)");

    expect(() =>
      speechConfigFromEnv({
        SPEECH_ASR_BASE_URL: "https://user:pass@asr.example/v1",
        SPEECH_ASR_MODEL: "whisper-1",
      }),
    ).toThrow("用户名密码");

    expect(() =>
      speechConfigFromEnv({
        SPEECH_TTS_BASE_URL: "https://tts.example/v1?api_key=leak",
        SPEECH_TTS_MODEL: "tts-1",
      }),
    ).toThrow("查询参数");

    expect(() =>
      speechConfigFromEnv({
        SPEECH_TTS_BASE_URL: "https://tts.example/v1#section",
        SPEECH_TTS_MODEL: "tts-1",
      }),
    ).toThrow("片段");

    expect(() =>
      speechConfigFromEnv({
        TRANSCRIPTION_PROVIDER: "custom-unknown",
        TRANSCRIPTION_BASE_URL: "https://asr.example/v1",
        TRANSCRIPTION_MODEL: "whisper-1",
      }),
    ).toThrow("TRANSCRIPTION_PROVIDER");

    expect(() =>
      speechConfigFromEnv({
        SPEECH_TTS_API_KEY: "only-key",
      }),
    ).toThrow("SPEECH_TTS_BASE_URL");

    expect(() =>
      speechConfigFromEnv({
        SPEECH_ASR_MODEL: "only-model",
      }),
    ).toThrow("SPEECH_ASR_BASE_URL");
  });
});

describe("transcribeAudio & synthesizeSpeech", () => {
  const fullConfig: SpeechConfig = {
    asr: {
      baseUrl: "https://asr.example/v1/",
      model: "whisper-1",
      apiKey: "asr-secret-token",
    },
    tts: {
      baseUrl: "https://tts.example/v1/",
      model: "tts-1-hd",
      voice: "nova",
      apiKey: "tts-secret-token",
    },
  };

  test("transcribeAudio 正确组装 multipart/form-data 请求并归一化带编码参数的 MIME", async () => {
    const controller = new AbortController();
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    let capturedRedirect: RequestRedirect | undefined;
    let capturedModel: FormDataEntryValue | null = null;
    let capturedLang: FormDataEntryValue | null = null;
    let capturedFile: FormDataEntryValue | null = null;

    const service = createSpeechService({
      getConfig: () => fullConfig,
      transport: async (url, init) => {
        capturedUrl = url;
        capturedAuth = new Headers(init.headers).get("authorization");
        capturedRedirect = init.redirect;
        expect(init.method).toBe("POST");
        expect(init.body).toBeInstanceOf(FormData);
        if (init.body instanceof FormData) {
          capturedModel = init.body.get("model");
          capturedLang = init.body.get("language");
          capturedFile = init.body.get("file");
        }
        return Response.json({ text: "  你好，ChisaBot！  " });
      },
    });

    const result = await service.transcribeAudio({
      data: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/webm;codecs=opus",
      fileName: "voice-note.webm",
      language: "zh",
      signal: controller.signal,
    });

    expect(result).toEqual({ text: "你好，ChisaBot！" });
    expect(capturedUrl).toBe("https://asr.example/v1/audio/transcriptions");
    expect(capturedAuth).toBe("Bearer asr-secret-token");
    expect(capturedRedirect).toBe("error");
    expect(capturedModel).toBe("whisper-1");
    expect(capturedLang).toBe("zh");
    expect(capturedFile).toBeInstanceOf(File);
    if (capturedFile instanceof File) {
      expect(capturedFile.type).toBe("audio/webm");
      expect(capturedFile.name).toBe("voice-note.webm");
    }
  });

  test("transcribeAudio 对 429/500 上游错误脱敏，绝不泄露密钥或上游响应体", async () => {
    const rateLimited = createSpeechService({
      getConfig: () => fullConfig,
      transport: async () =>
        new Response("rate limit exceeded for key asr-secret-token", {
          status: 429,
        }),
    });
    try {
      await rateLimited.transcribeAudio({
        data: new Uint8Array([1, 2]),
        mimeType: "audio/wav",
      });
      throw new Error("expected rate limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(SpeechServiceError);
      if (error instanceof SpeechServiceError) {
        expect(error.status).toBe(429);
        expect(error.code).toBe("rate-limited");
        expect(error.message).not.toContain("asr-secret-token");
      }
    }

    const upstreamDown = createSpeechService({
      getConfig: () => fullConfig,
      transport: async () =>
        new Response("INTERNAL_DB_URL=postgres://secret:pw@10.0.0.1", {
          status: 500,
        }),
    });
    try {
      await upstreamDown.transcribeAudio({
        data: new ArrayBuffer(8),
        mimeType: "audio/mpeg",
      });
      throw new Error("expected upstream failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SpeechServiceError);
      if (error instanceof SpeechServiceError) {
        expect(error.status).toBe(502);
        expect(error.message).not.toContain("INTERNAL_DB_URL");
        expect(error.message).not.toContain("postgres://");
      }
    }
  });

  test("transcribeAudio 在超时或上游网络抛错时返回安全错误且不泄露异常细节", async () => {
    const timedOut = createSpeechService({
      getConfig: () => fullConfig,
      timeoutMs: 25,
      transport: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    await expect(
      timedOut.transcribeAudio({
        data: new Uint8Array([1, 2, 3]),
        mimeType: "audio/ogg",
      }),
    ).rejects.toMatchObject({
      status: 504,
      code: "upstream-timeout",
    });

    const networkErr = createSpeechService({
      getConfig: () => fullConfig,
      transport: async () => {
        throw new Error("ECONNREFUSED Bearer asr-secret-token");
      },
    });
    try {
      await networkErr.transcribeAudio({
        data: new Uint8Array([1, 2]),
        mimeType: "audio/mp4",
      });
      throw new Error("expected network error");
    } catch (error) {
      expect(error).toBeInstanceOf(SpeechServiceError);
      if (error instanceof SpeechServiceError) {
        expect(error.status).toBe(502);
        expect(error.message).not.toContain("asr-secret-token");
        expect(error.message).not.toContain("ECONNREFUSED");
      }
    }
  });

  test("synthesizeSpeech 组装 JSON 请求并返回音频字节与元信息", async () => {
    const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
    let capturedBody: Record<string, unknown> | null = null;
    let capturedUrl = "";

    const service = createSpeechService({
      getConfig: () => fullConfig,
      transport: async (url, init) => {
        capturedUrl = url;
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer tts-secret-token",
        );
        expect(new Headers(init.headers).get("content-type")).toBe(
          "application/json",
        );
        expect(init.redirect).toBe("error");
        capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(audioBytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      },
    });

    const result = await service.synthesizeSpeech({
      text: "  早安，今天天气不错。  ",
      format: "opus",
      speed: 1.25,
    });

    expect(capturedUrl).toBe("https://tts.example/v1/audio/speech");
    expect(capturedBody).toEqual({
      model: "tts-1-hd",
      input: "早安，今天天气不错。",
      voice: "nova",
      response_format: "opus",
      speed: 1.25,
    });
    expect(result.audio).toEqual(audioBytes);
    expect(result.contentType).toBe("audio/opus");
    expect(result.voice).toBe("nova");
    expect(result.format).toBe("opus");
  });

  test("synthesizeSpeech 校验文本边界、语速边界与上游 429/500 脱敏", async () => {
    const service = createSpeechService({
      getConfig: () => fullConfig,
      transport: async () => new Response(new Uint8Array([1]), { status: 200 }),
    });

    await expect(
      service.synthesizeSpeech({ text: "   " }),
    ).rejects.toMatchObject({ status: 400, code: "invalid-input" });
    await expect(
      service.synthesizeSpeech({ text: "a".repeat(MAX_SPEECH_TTS_CHARS + 1) }),
    ).rejects.toMatchObject({ status: 400, code: "invalid-input" });
    await expect(
      service.synthesizeSpeech({ text: "hello", speed: 0.1 }),
    ).rejects.toMatchObject({ status: 400, code: "invalid-input" });
    await expect(
      service.synthesizeSpeech({ text: "hello", speed: 4.5 }),
    ).rejects.toMatchObject({ status: 400, code: "invalid-input" });

    const okMax = await service.synthesizeSpeech({
      text: "a".repeat(MAX_SPEECH_TTS_CHARS),
    });
    expect(okMax.audio.byteLength).toBe(1);

    const errService = createSpeechService({
      getConfig: () => fullConfig,
      transport: async () =>
        new Response("upstream secret tts-secret-token", { status: 500 }),
    });
    try {
      await errService.synthesizeSpeech({ text: "测试报错" });
      throw new Error("expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(SpeechServiceError);
      if (error instanceof SpeechServiceError) {
        expect(error.status).toBe(502);
        expect(error.message).not.toContain("tts-secret-token");
      }
    }
  });
});

describe("HTTP 路由 /api/speech 与 speech_synthesize 工具", () => {
  test("未登录请求在进入业务逻辑前被 requireUser 拦截返回 401", async () => {
    const service = createSpeechService({
      getConfig: () => ({
        asr: { baseUrl: "https://asr.example/v1", model: "whisper-1" },
        tts: { baseUrl: "https://tts.example/v1", model: "tts-1" },
      }),
      transport: async () => {
        throw new Error("must not be called");
      },
    });
    const app = new Hono().route(
      "/api/speech",
      service.routes(unauthenticatedUser),
    );

    const ttsRes = await app.request("/api/speech/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    expect(ttsRes.status).toBe(401);

    const asrRes = await app.request("/api/speech/asr", {
      method: "POST",
      body: makeAsrForm(),
    });
    expect(asrRes.status).toBe(401);
  });

  test("未配置 TTS / ASR 时返回 503 明确中文提示", async () => {
    const service = createSpeechService({
      getConfig: () => ({}),
    });
    const app = new Hono().route(
      "/api/speech",
      service.routes(authenticatedUser),
    );

    const ttsRes = await app.request("/api/speech/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    expect(ttsRes.status).toBe(503);
    const ttsJson = (await ttsRes.json()) as { error: string };
    expect(ttsJson.error).toContain("尚未配置");

    const asrRes = await app.request("/api/speech/asr", {
      method: "POST",
      body: makeAsrForm(),
    });
    expect(asrRes.status).toBe(503);
    const asrJson = (await asrRes.json()) as { error: string };
    expect(asrJson.error).toContain("尚未配置");
  });

  test("POST /tts 校验参数并返回二进制音频流与正确响应头", async () => {
    const expectedBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
    const service = createSpeechService({
      getConfig: () => ({
        tts: {
          baseUrl: "https://tts.example/v1",
          model: "tts-1",
          voice: "alloy",
        },
      }),
      transport: async () =>
        new Response(expectedBytes, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    });
    const app = new Hono().route(
      "/api/speech",
      service.routes(authenticatedUser),
    );

    expect(
      (
        await app.request("/api/speech/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json",
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await app.request("/api/speech/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "   " }),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await app.request("/api/speech/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "你好", format: "flac" }),
        })
      ).status,
    ).toBe(400);

    const okRes = await app.request("/api/speech/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "请朗读这段话", format: "mp3", speed: 1.1 }),
    });
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("content-type")).toBe("audio/mpeg");
    expect(okRes.headers.get("cache-control")).toBe("no-store");
    expect(okRes.headers.get("content-length")).toBe(
      String(expectedBytes.byteLength),
    );
    expect(new Uint8Array(await okRes.arrayBuffer())).toEqual(expectedBytes);
  });

  test("POST /asr 支持 webm/mp4/wav/mp3/ogg 并拦截 400/413/415", async () => {
    const seenTypes: string[] = [];
    const service = createSpeechService({
      getConfig: () => ({
        asr: { baseUrl: "https://asr.example/v1", model: "whisper-1" },
      }),
      transport: async (_url, init) => {
        if (init.body instanceof FormData) {
          const file = init.body.get("file");
          if (file instanceof File) seenTypes.push(file.type);
        }
        return Response.json({ text: "识别成功" });
      },
    });
    const app = new Hono().route(
      "/api/speech",
      service.routes(authenticatedUser),
    );

    expect(
      (
        await app.request("/api/speech/asr", {
          method: "POST",
          body: makeAsrForm("audio/webm", 0),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await app.request("/api/speech/asr", {
          method: "POST",
          body: makeAsrForm("text/html", 16),
        })
      ).status,
    ).toBe(415);

    expect(
      (
        await app.request("/api/speech/asr", {
          method: "POST",
          body: makeAsrForm("audio/webm", MAX_SPEECH_ASR_BYTES + 1),
        })
      ).status,
    ).toBe(413);

    for (const mime of [
      "audio/webm",
      "audio/mp4",
      "audio/wav",
      "audio/mpeg",
      "audio/ogg",
    ]) {
      const res = await app.request("/api/speech/asr", {
        method: "POST",
        body: makeAsrForm(mime, 32, undefined, "zh"),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ text: "识别成功" });
    }
    expect(seenTypes).toEqual([
      "audio/webm",
      "audio/mp4",
      "audio/wav",
      "audio/mpeg",
      "audio/ogg",
    ]);
  });

  test("speech_synthesize 工具正确声明元数据、处理中止并返回摘要", async () => {
    const service = createSpeechService({
      publicOrigin: "https://chisa.example/",
      getConfig: () => ({
        tts: {
          baseUrl: "https://tts.example/v1",
          model: "tts-1",
          voice: "echo",
        },
      }),
      transport: async () =>
        new Response(new Uint8Array(256), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        }),
    });

    const tools = service.tools();
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool?.name).toBe("speech_synthesize");
    expect(tool?.ref).toBe("audio/speech_synthesize");
    expect(tool?.effect).toBe("read");
    if (!tool) throw new Error("missing speech_synthesize tool");

    const stopped = new AbortController();
    stopped.abort();
    expect(
      await tool.execute({ text: "你好" }, { signal: stopped.signal }),
    ).toBe(`${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`);

    const badArgs = await tool.execute({ text: "" });
    expect(badArgs.startsWith(REFUSAL_MARKER)).toBe(true);

    const summary = await tool.execute({
      text: "请为我朗读这段公告",
      format: "wav",
    });
    expect(summary).toContain("wav");
    expect(summary).toContain("audio/wav");
    expect(summary).toContain("echo");
    expect(summary).toContain("256 字节");
    expect(summary).toContain("https://chisa.example/api/speech/tts");
  });
});
