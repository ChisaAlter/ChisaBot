import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import {
  CHAT_FILES_MARKER,
  type ChatFileView,
  filesFromToolResult,
} from "../../shared/chat-files";
import { DEFAULT_OPENAI_SPEECH_VOICES } from "../../shared/speech";
import { type AppVariables, requireAdmin } from "../src/auth/guards";
import {
  createSpeechService,
  type SpeechConfig,
  SpeechServiceError,
} from "../src/audio/speech-service";
import {
  createSpeechSettingsStore,
  parseSpeechEndpointUrl,
  type SpeechSettingsDatabase,
  type SpeechSettingsRow,
  SpeechSettingsValidationError,
} from "../src/audio/speech-settings";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("base64");

function makeFakeSpeechDb() {
  let row: SpeechSettingsRow | null = null;
  let tableCreated = false;

  const database: SpeechSettingsDatabase = {
    $client: {
      unsafe: (async (query: string, params?: unknown[]) => {
        const trimmed = query.trim();
        if (trimmed.startsWith("CREATE TABLE")) {
          tableCreated = true;
          return [];
        }
        if (trimmed.startsWith("SELECT")) {
          return row ? [{ ...row }] : [];
        }
        if (trimmed.startsWith("INSERT INTO chisabot_speech_settings")) {
          const values = params ?? [];
          row = {
            id: "default",
            asr_enabled: Boolean(values[0]),
            asr_base_url: String(values[1] ?? ""),
            asr_model: String(values[2] ?? ""),
            asr_api_key: (values[3] as string | null) ?? null,
            asr_key_hint: String(values[4] ?? ""),
            tts_enabled: Boolean(values[5]),
            tts_provider: String(values[6] ?? "openai"),
            tts_base_url: String(values[7] ?? ""),
            tts_model: String(values[8] ?? ""),
            tts_voice: String(values[9] ?? ""),
            tts_speed: Number(values[10] ?? 1),
            tts_api_key: (values[11] as string | null) ?? null,
            tts_key_hint: String(values[12] ?? ""),
            updated_at: new Date(),
            updated_by: (values[13] as string | null) ?? null,
          };
          return [];
        }
        throw new Error(`Unexpected SQL in test: ${trimmed}`);
      }) as unknown as SpeechSettingsDatabase["$client"]["unsafe"],
    },
  };

  return {
    database,
    getRow: () => row,
    isTableCreated: () => tableCreated,
  };
}

function makeAuthMiddleware(
  role: "admin" | "user",
  id = `actor-${role}`,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id,
      email: `${id}@example.com`,
      role,
    });
    await next();
  };
}

describe("speech-settings 存储、合并优先级与 URL 校验", () => {
  test("未写库时平滑回退到 envSpeechConfig，保存后 DB 优先且空密钥保留原已存密钥", async () => {
    const fakeDb = makeFakeSpeechDb();
    const envSpeechConfig: SpeechConfig = {
      asr: {
        baseUrl: "https://env-asr.example/v1",
        model: "whisper-env",
        apiKey: "env-asr-secret-1111",
      },
      tts: {
        provider: "openai",
        baseUrl: "https://env-tts.example/v1",
        model: "tts-env",
        voice: "nova",
        apiKey: "env-tts-secret-2222",
      },
    };

    const store = createSpeechSettingsStore(fakeDb.database, {
      encryptionKey: TEST_ENCRYPTION_KEY,
      envSpeechConfig,
    });
    await store.ensure();
    expect(fakeDb.isTableCreated()).toBe(true);

    // 1. 初始未写 DB：全部来自 env
    const initialView = await store.view();
    expect(initialView.asr).toEqual({
      enabled: true,
      baseUrl: "https://env-asr.example/v1",
      model: "whisper-env",
    });
    expect(initialView.asrKeySource).toBe("environment");
    expect(initialView.asrKeyHint).toBe("1111");
    expect(initialView.tts.baseUrl).toBe("https://env-tts.example/v1");
    expect(initialView.tts.voice).toBe("nova");
    expect(initialView.ttsKeySource).toBe("environment");
    expect(initialView.ttsKeyHint).toBe("2222");

    // 2. 保存 DB：覆盖 TTS 为 Fish Audio 并存加密密钥，ASR 留空地址/模型走 env 回退
    const saved = await store.save("admin-1", {
      asr: {
        enabled: true,
        baseUrl: "",
        model: "",
      },
      tts: {
        enabled: true,
        provider: "fish",
        baseUrl: "https://api.fish.audio///",
        model: "s1",
        voice: "fish-voice-001",
        speed: 1.15,
        apiKey: "sk-fish-live-secret-9876",
      },
    });

    expect(saved.asr.baseUrl).toBe("https://env-asr.example/v1");
    expect(saved.asr.model).toBe("whisper-env");
    expect(saved.asrKeySource).toBe("environment");
    expect(saved.tts).toEqual({
      enabled: true,
      provider: "fish",
      baseUrl: "https://api.fish.audio",
      model: "s1",
      voice: "fish-voice-001",
      speed: 1.15,
    });
    expect(saved.ttsKeySource).toBe("saved");
    expect(saved.ttsKeyHint).toBe("9876");

    // 落盘密文不得包含明文密钥
    const storedRow = fakeDb.getRow();
    expect(storedRow?.tts_api_key).toBeTruthy();
    expect(storedRow?.tts_api_key).not.toContain("sk-fish-live-secret-9876");

    const resolved1 = await store.resolveConfig();
    expect(resolved1.asr).toEqual({
      baseUrl: "https://env-asr.example/v1",
      model: "whisper-env",
      apiKey: "env-asr-secret-1111",
    });
    expect(resolved1.tts).toEqual({
      provider: "fish",
      baseUrl: "https://api.fish.audio",
      model: "s1",
      voice: "fish-voice-001",
      speed: 1.15,
      apiKey: "sk-fish-live-secret-9876",
    });

    // 3. 再次保存且 apiKey 传空字符串：必须保留原已存密钥
    await store.save("admin-1", {
      asr: {
        enabled: false,
        baseUrl: "",
        model: "",
        apiKey: "",
      },
      tts: {
        enabled: true,
        provider: "fish",
        baseUrl: "https://api.fish.audio",
        model: "s1",
        voice: "fish-voice-002",
        speed: 1.0,
        apiKey: "   ",
      },
    });
    const resolved2 = await store.resolveConfig();
    expect(resolved2.asr).toBeUndefined();
    expect(resolved2.tts?.apiKey).toBe("sk-fish-live-secret-9876");
    expect(resolved2.tts?.voice).toBe("fish-voice-002");

    // 4. 显式 clearApiKey 清空 Fish Audio 已存密钥后，绝不跨源/跨厂商回退到 OpenAI env 密钥
    const clearedCrossOrigin = await store.save("admin-1", {
      asr: { enabled: false, baseUrl: "", model: "" },
      tts: {
        enabled: true,
        provider: "fish",
        baseUrl: "https://api.fish.audio",
        model: "s1",
        voice: "fish-voice-002",
        clearApiKey: true,
      },
    });
    expect(clearedCrossOrigin.ttsKeySource).toBe("none");
    expect(clearedCrossOrigin.ttsKeyHint).toBe("");
    const resolved3 = await store.resolveConfig();
    expect(resolved3.tts?.apiKey).toBeUndefined();

    // 5. 切回与 env 同源且同厂商（openai + https://env-tts.example/v1）后，正常平滑回退到 env 密钥
    const sameOriginView = await store.save("admin-1", {
      asr: { enabled: false, baseUrl: "", model: "" },
      tts: {
        enabled: true,
        provider: "openai",
        baseUrl: "https://env-tts.example/v1",
        model: "tts-1",
        voice: "alloy",
      },
    });
    expect(sameOriginView.ttsKeySource).toBe("environment");
    expect(sameOriginView.ttsKeyHint).toBe("2222");
    const resolved4 = await store.resolveConfig();
    expect(resolved4.tts?.apiKey).toBe("env-tts-secret-2222");
  });

  test("跨源或切换厂商绝不复用已存密钥或环境变量密钥（含 save/resolveConfig/test-tts/test-asr 与降级路由）", async () => {
    const fakeDb = makeFakeSpeechDb();
    const store = createSpeechSettingsStore(fakeDb.database, {
      encryptionKey: TEST_ENCRYPTION_KEY,
      envSpeechConfig: {
        asr: {
          baseUrl: "https://env-asr.example/v1",
          model: "whisper-env",
          apiKey: "env-asr-secret-1111",
        },
        tts: {
          provider: "openai",
          baseUrl: "https://env-tts.example/v1",
          model: "tts-env",
          apiKey: "env-tts-secret-2222",
        },
      },
    });
    await store.ensure();

    // 保存已存密钥绑定在 saved-asr.example / saved-tts.example（openai）
    await store.save("admin-1", {
      asr: {
        enabled: true,
        baseUrl: "https://saved-asr.example/v1",
        model: "whisper-1",
        apiKey: "db-asr-secret-3333",
      },
      tts: {
        enabled: true,
        provider: "openai",
        baseUrl: "https://saved-tts.example/v1",
        model: "tts-1",
        voice: "alloy",
        apiKey: "db-tts-secret-4444",
      },
    });

    // 1. resolveForTestTts：同源同厂商复用 DB 密钥；跨源或切换 provider 必须为 undefined
    const sameTts = await store.resolveForTestTts({
      provider: "openai",
      baseUrl: "https://saved-tts.example/v2",
      model: "tts-1",
    });
    expect(sameTts?.apiKey).toBe("db-tts-secret-4444");

    const crossOriginTts = await store.resolveForTestTts({
      provider: "openai",
      baseUrl: "https://attacker.example/v1",
      model: "tts-1",
    });
    expect(crossOriginTts?.apiKey).toBeUndefined();

    const switchedProviderTts = await store.resolveForTestTts({
      provider: "fish",
      baseUrl: "https://saved-tts.example/v1",
      model: "s1",
    });
    expect(switchedProviderTts?.apiKey).toBeUndefined();

    // 2. resolveForTestAsr：同源复用 DB 密钥；跨源必须为 undefined
    const sameAsr = await store.resolveForTestAsr({
      baseUrl: "https://saved-asr.example/v2",
      model: "whisper-1",
    });
    expect(sameAsr?.apiKey).toBe("db-asr-secret-3333");

    const crossOriginAsr = await store.resolveForTestAsr({
      baseUrl: "https://attacker-asr.example/v1",
      model: "whisper-1",
    });
    expect(crossOriginAsr?.apiKey).toBeUndefined();

    // 3. save() 改配不同 origin 且未填 apiKey 时，既不继承旧 DB 密钥，也不回退跨源 env 密钥
    const switchedView = await store.save("admin-1", {
      asr: {
        enabled: true,
        baseUrl: "https://new-asr.example/v1",
        model: "whisper-1",
      },
      tts: {
        enabled: true,
        provider: "openai",
        baseUrl: "https://new-tts.example/v1",
        model: "tts-1",
        voice: "alloy",
      },
    });
    expect(switchedView.asrKeySource).toBe("none");
    expect(switchedView.ttsKeySource).toBe("none");
    const resolvedSwitched = await store.resolveConfig();
    expect(resolvedSwitched.asr?.apiKey).toBeUndefined();
    expect(resolvedSwitched.tts?.apiKey).toBeUndefined();

    // 4. 无 settingsStore 降级分支下的 /test-tts 与 /test-asr 同样拦截跨源/切厂商密钥复用
    const seenAuthHeaders: { url: string; auth: string | null }[] = [];
    const statelessService = createSpeechService({
      getConfig: () => ({
        asr: {
          baseUrl: "https://env-asr.example/v1",
          model: "whisper-1",
          apiKey: "env-only-asr-secret",
        },
        tts: {
          provider: "openai",
          baseUrl: "https://env-tts.example/v1",
          model: "tts-1",
          apiKey: "env-only-tts-secret",
        },
      }),
      transport: async (url, init) => {
        seenAuthHeaders.push({
          url,
          auth: new Headers(init.headers).get("authorization"),
        });
        if (url.endsWith("/audio/transcriptions")) {
          return Response.json({ text: "" });
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      },
    });
    const adminApp = new Hono().route(
      "/api/speech",
      statelessService.routes(makeAuthMiddleware("admin"), requireAdmin),
    );

    // 跨源 test-tts 不得带 Authorization
    const resCrossTts = await adminApp.request("/api/speech/test-tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        baseUrl: "https://evil-tts.example/v1",
        model: "tts-1",
      }),
    });
    expect(resCrossTts.status).toBe(200);

    // 同源但切 provider 到 fish 不得带 Authorization
    const resSwitchProvider = await adminApp.request("/api/speech/test-tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "fish",
        baseUrl: "https://env-tts.example/v1",
        model: "s1",
      }),
    });
    expect(resSwitchProvider.status).toBe(200);

    // 跨源 test-asr 不得带 Authorization
    const resCrossAsr = await adminApp.request("/api/speech/test-asr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://evil-asr.example/v1",
        model: "whisper-1",
      }),
    });
    expect(resCrossAsr.status).toBe(200);

    // 同源 test-asr 正常带 Authorization
    const resSameAsr = await adminApp.request("/api/speech/test-asr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://env-asr.example/v1",
        model: "whisper-1",
      }),
    });
    expect(resSameAsr.status).toBe(200);

    expect(seenAuthHeaders).toEqual([
      { url: "https://evil-tts.example/v1/audio/speech", auth: null },
      { url: "https://env-tts.example/v1/tts", auth: null },
      { url: "https://evil-asr.example/v1/audio/transcriptions", auth: null },
      {
        url: "https://env-asr.example/v1/audio/transcriptions",
        auth: "Bearer env-only-asr-secret",
      },
    ]);
  });

  test("严格校验端点 URL：拒绝非 HTTP(S)、userinfo、query 与 hash", async () => {
    expect(
      parseSpeechEndpointUrl("https://tts.example.com/v1///", "TTS 地址"),
    ).toBe("https://tts.example.com/v1");

    for (const badUrl of [
      "ftp://tts.example.com/v1",
      "file:///etc/passwd",
      "https://user:pass@tts.example.com/v1",
      "https://tts.example.com/v1?token=123",
      "https://tts.example.com/v1#frag",
      "https://tts.example.com/v1?",
      "https://tts.example.com/v1#",
      "not-a-url",
    ]) {
      expect(() => parseSpeechEndpointUrl(badUrl, "TTS 地址")).toThrow(
        SpeechSettingsValidationError,
      );
    }

    const fakeDb = makeFakeSpeechDb();
    const store = createSpeechSettingsStore(fakeDb.database, {
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    await expect(
      store.save("admin-1", {
        asr: { enabled: false, baseUrl: "", model: "" },
        tts: {
          enabled: true,
          provider: "openai",
          baseUrl: "https://admin:pw@evil.example/v1",
          model: "tts-1",
          voice: "alloy",
        },
      }),
    ).rejects.toThrow(SpeechSettingsValidationError);
  });
});

describe("Fish Audio、音色搜索、speech_synthesize 落盘与资源保护", () => {
  test("listVoices 合并 Fish Audio 与内置 OpenAI 音色、支持关键字过滤，异常时优雅降级", async () => {
    let seenUrl = "";
    const fishService = createSpeechService({
      getConfig: () => ({
        tts: {
          provider: "fish",
          baseUrl: "https://api.fish.audio/v1",
          model: "s1",
          apiKey: "fish-secret-token",
        },
      }),
      transport: async (url, init) => {
        seenUrl = url;
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer fish-secret-token",
        );
        expect(init.redirect).toBe("error");
        return Response.json({
          items: [
            {
              _id: "fish-cn-01",
              title: "甜美小千",
              visibility: "public",
              languages: ["zh"],
              description: "清甜治愈系中文播报",
            },
            {
              _id: "fish-private",
              title: "私有声音",
              visibility: "private",
            },
            {
              _id: "fish-dmca",
              title: "下架声音",
              visibility: "public",
              dmca_taken_down: true,
            },
          ],
        });
      },
    });

    const all = await fishService.listVoices();
    expect(seenUrl).toContain("https://api.fish.audio/model?");
    expect(all[0]).toMatchObject({
      id: "fish-cn-01",
      name: "甜美小千",
      provider: "fish",
      language: "zh",
    });
    expect(all.some((v) => v.id === "fish-private")).toBe(false);
    expect(all.some((v) => v.id === "fish-dmca")).toBe(false);
    expect(all.length).toBe(1 + DEFAULT_OPENAI_SPEECH_VOICES.length);

    const filtered = await fishService.listVoices("小千");
    expect(filtered.map((v) => v.id)).toEqual(["fish-cn-01"]);

    const filteredOpenAi = await fishService.listVoices("shimmer");
    expect(filteredOpenAi.map((v) => v.id)).toEqual(["shimmer"]);

    // 上游网络报错时优雅降级返回 OpenAI 内置列表，不崩溃
    const brokenFish = createSpeechService({
      getConfig: () => ({
        tts: {
          provider: "fish",
          baseUrl: "https://api.fish.audio",
          model: "s1",
        },
      }),
      transport: async () => {
        throw new Error("network down");
      },
    });
    const fallbackVoices = await brokenFish.listVoices("nova");
    expect(fallbackVoices.map((v) => v.id)).toEqual(["nova"]);
  });

  test("synthesizeSpeech 支持 Fish Audio 协议（/v1/tts + model 头 + prosody/reference_id）", async () => {
    let capturedUrl = "";
    let capturedModelHeader: string | null = null;
    let capturedBody: Record<string, unknown> | null = null;

    const service = createSpeechService({
      getConfig: () => ({
        tts: {
          provider: "fish",
          baseUrl: "https://api.fish.audio",
          model: "s1",
          voice: "fish-ref-888",
          speed: 1.2,
          apiKey: "fish-key",
        },
      }),
      transport: async (url, init) => {
        capturedUrl = url;
        capturedModelHeader = new Headers(init.headers).get("model");
        capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x01]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      },
    });

    const out = await service.synthesizeSpeech({
      text: "你好 Fish Audio",
      format: "mp3",
    });

    expect(capturedUrl).toBe("https://api.fish.audio/v1/tts");
    expect(capturedModelHeader).toBe("s1");
    expect(capturedBody).toEqual({
      text: "你好 Fish Audio",
      format: "mp3",
      prosody: { speed: 1.2 },
      reference_id: "fish-ref-888",
    });
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.voice).toBe("fish-ref-888");
  });

  test("speech_synthesize 持久化音频并在末行附加 CHAT_FILES_MARKER", async () => {
    const uploaded: {
      actorId: string;
      agentId: string;
      name: string;
      mimeType: string;
      size: number;
    }[] = [];

    const service = createSpeechService({
      getConfig: () => ({
        tts: {
          baseUrl: "https://tts.example/v1",
          model: "tts-1",
          voice: "coral",
        },
      }),
      transport: async () =>
        new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      persistAudio: async (actorId, agentId, file): Promise<ChatFileView> => {
        uploaded.push({
          actorId,
          agentId,
          name: file.name,
          mimeType: file.mimeType,
          size: file.bytes.byteLength,
        });
        return {
          id: "cf-audio-1",
          name: file.name,
          mimeType: "audio/mpeg",
          size: file.bytes.byteLength,
          kind: "upload",
          url: "/api/chat-files/cf-audio-1",
          workspacePath: `uploads/${file.name}`,
          createdAt: "2026-11-19T00:00:00.000Z",
        };
      },
    });

    const [tool] = service.tools({ actorId: "u-1", agentId: "bot-9" });
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing speech_synthesize tool");

    const output = await tool.execute({
      text: "生成一段欢迎语音",
      format: "mp3",
    });
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatchObject({
      actorId: "u-1",
      agentId: "bot-9",
      mimeType: "audio/mpeg",
      size: 6,
    });
    expect(output).toContain(CHAT_FILES_MARKER);

    const parsedFiles = filesFromToolResult(output);
    expect(parsedFiles).toHaveLength(1);
    expect(parsedFiles[0]).toMatchObject({
      id: "cf-audio-1",
      mimeType: "audio/mpeg",
      url: "/api/chat-files/cf-audio-1",
      size: 6,
    });

    // 无上下文调用依然保持兼容不崩，不附 CHAT_FILES_MARKER
    const [noCtxTool] = service.tools();
    if (!noCtxTool) throw new Error("missing tool");
    const plain = await noCtxTool.execute({ text: "无持久化回调回退" });
    expect(plain).toContain("语音合成完成");
    expect(plain).not.toContain(CHAT_FILES_MARKER);
  });

  test("拦截超过上限的 TTS 音频响应体（含 Content-Length 与流式块）", async () => {
    // 1. Content-Length 声明超限
    const declaredTooBig = createSpeechService({
      getConfig: () => ({
        tts: { baseUrl: "https://tts.example/v1", model: "tts-1" },
      }),
      maxTtsAudioBytes: 32,
      transport: async () =>
        new Response(new Uint8Array(64), {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "content-length": "64",
          },
        }),
    });
    await expect(
      declaredTooBig.synthesizeSpeech({ text: "过大音频" }),
    ).rejects.toMatchObject({
      status: 413,
      code: "payload-too-large",
    });

    // 2. 无 Content-Length 的 chunked 流式响应超限
    const chunkedTooBig = createSpeechService({
      getConfig: () => ({
        tts: { baseUrl: "https://tts.example/v1", model: "tts-1" },
      }),
      maxTtsAudioBytes: 32,
      transport: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(20));
            controller.enqueue(new Uint8Array(20));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      },
    });
    await expect(
      chunkedTooBig.synthesizeSpeech({ text: "流式超限" }),
    ).rejects.toMatchObject({
      status: 413,
      code: "payload-too-large",
    });
  });

  test("用户级并发保护：同用户最多 2 路并发 TTS，第 3 路返回 429，不同用户互不阻塞", async () => {
    const resolvers: (() => void)[] = [];
    const waiters: (() => void)[] = [];
    const notifyWaiters = () => {
      while (waiters.length > 0) {
        waiters.shift()?.();
      }
    };
    const waitForResolvers = async (targetCount: number) => {
      while (resolvers.length < targetCount) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    };

    const service = createSpeechService({
      getConfig: () => ({
        tts: { baseUrl: "https://tts.example/v1", model: "tts-1" },
      }),
      maxConcurrentTtsPerUser: 2,
      transport: () =>
        new Promise<Response>((resolve) => {
          resolvers.push(() =>
            resolve(
              new Response(new Uint8Array([9, 8, 7]), {
                status: 200,
                headers: { "content-type": "audio/mpeg" },
              }),
            ),
          );
          notifyWaiters();
        }),
    });

    const p1 = service.synthesizeSpeech({ text: "第一路", actorKey: "user-A" });
    const p2 = service.synthesizeSpeech({ text: "第二路", actorKey: "user-A" });
    await waitForResolvers(2);

    // 第 3 路同用户立即被 429 拦截
    let thirdError: unknown = null;
    try {
      await service.synthesizeSpeech({ text: "第三路", actorKey: "user-A" });
    } catch (error) {
      thirdError = error;
    }
    expect(thirdError).toBeInstanceOf(SpeechServiceError);
    if (thirdError instanceof SpeechServiceError) {
      expect(thirdError.status).toBe(429);
      expect(thirdError.code).toBe("rate-limited");
    }

    // 不同用户 user-B 不受 user-A 并发影响
    const pOther = service.synthesizeSpeech({
      text: "其他用户",
      actorKey: "user-B",
    });
    await waitForResolvers(3);

    // 全部放行
    while (resolvers.length > 0) {
      resolvers.shift()?.();
    }
    const [r1, r2, rOther] = await Promise.all([p1, p2, pOther]);
    expect(r1.audio.byteLength).toBe(3);
    expect(r2.audio.byteLength).toBe(3);
    expect(rOther.audio.byteLength).toBe(3);

    // 结束后计数归零，可再次发起
    const pAfter = service.synthesizeSpeech({
      text: "释放后再来",
      actorKey: "user-A",
    });
    await waitForResolvers(1);
    resolvers.shift()?.();
    expect((await pAfter).audio.byteLength).toBe(3);
  });

  test("管理路由权限与接口闭环：/status、/voices、/settings、/test-tts、/test-asr 均带 no-store", async () => {
    const fakeDb = makeFakeSpeechDb();
    const store = createSpeechSettingsStore(fakeDb.database, {
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    await store.ensure();

    const service = createSpeechService({
      getConfig: () => store.resolveConfig(),
      settingsStore: store,
      transport: async (url) => {
        if (url.endsWith("/audio/transcriptions")) {
          return Response.json({ text: "" });
        }
        return new Response(new Uint8Array([0x49, 0x44, 0x33]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      },
    });

    const userApp = new Hono().route(
      "/api/speech",
      service.routes(makeAuthMiddleware("user"), requireAdmin),
    );
    const adminApp = new Hono().route(
      "/api/speech",
      service.routes(makeAuthMiddleware("admin"), requireAdmin),
    );

    // 普通用户可查 status 与 voices，不可改 settings / test
    const statusRes = await userApp.request("/api/speech/status");
    expect(statusRes.status).toBe(200);
    expect(statusRes.headers.get("cache-control")).toBe("no-store");
    expect(await statusRes.json()).toEqual({
      asrReady: false,
      ttsReady: false,
      defaultVoice: "alloy",
      provider: "openai",
    });

    const voicesRes = await userApp.request("/api/speech/voices?q=alloy");
    expect(voicesRes.status).toBe(200);
    expect(voicesRes.headers.get("cache-control")).toBe("no-store");
    const voicesJson = (await voicesRes.json()) as { voices: { id: string }[] };
    expect(voicesJson.voices.map((v) => v.id)).toEqual(["alloy"]);

    expect((await userApp.request("/api/speech/settings")).status).toBe(403);
    expect(
      (
        await userApp.request("/api/speech/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await userApp.request("/api/speech/test-tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await userApp.request("/api/speech/test-asr", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);

    // 管理员保存设置后 status 立刻变为就绪
    const putRes = await adminApp.request("/api/speech/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        asr: {
          enabled: true,
          baseUrl: "https://asr.example/v1",
          model: "whisper-1",
          apiKey: "asr-key-12345678",
        },
        tts: {
          enabled: true,
          provider: "openai",
          baseUrl: "https://tts.example/v1",
          model: "tts-1",
          voice: "sage",
          speed: 1.0,
          apiKey: "tts-key-87654321",
        },
      }),
    });
    expect(putRes.status).toBe(200);
    expect(putRes.headers.get("cache-control")).toBe("no-store");

    const statusAfter = (await (
      await userApp.request("/api/speech/status")
    ).json()) as { asrReady: boolean; ttsReady: boolean; defaultVoice: string };
    expect(statusAfter).toMatchObject({
      asrReady: true,
      ttsReady: true,
      defaultVoice: "sage",
    });
    expect(await service.isTtsReady()).toBe(true);

    // 管理员试听 TTS 与测试 ASR 连通性
    const testTtsRes = await adminApp.request("/api/speech/test-tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "试听一下" }),
    });
    expect(testTtsRes.status).toBe(200);
    expect(testTtsRes.headers.get("content-type")).toBe("audio/mpeg");
    expect(testTtsRes.headers.get("cache-control")).toBe("no-store");
    expect((await testTtsRes.arrayBuffer()).byteLength).toBe(3);

    const testAsrRes = await adminApp.request("/api/speech/test-asr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(testAsrRes.status).toBe(200);
    expect(testAsrRes.headers.get("cache-control")).toBe("no-store");
    expect(await testAsrRes.json()).toMatchObject({
      ok: true,
    });
  });
});
