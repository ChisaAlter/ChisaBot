import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { CHAT_FILES_MARKER, type ChatFileView } from "../../shared/chat-files";
import {
  MAX_MEDIA_REFERENCE_IMAGES,
  validateMediaParams,
} from "../../shared/media-pool";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import {
  newInlineBudget,
  resolveAttachmentParts,
} from "../src/channels/attachment-parts";
import {
  createMediaPoolService,
  MAX_VIDEO_INLINE_BYTES,
  sameMediaOrigin,
} from "../src/chat-files/media-pool-service";

/** 构造合法最小 PNG（带完整 8 字节魔数与指定宽高的 IHDR chunk）。 */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  return buf;
}

/** 构造纯内存 SQL 桩，支持 media-pool-service 的全部表读写。 */
function createMemoryMediaPoolDb() {
  const poolRows = new Map<string, Record<string, unknown>>();
  const taskRows = new Map<string, Record<string, unknown>>();

  const unsafe = async <T = unknown>(
    query: string,
    params: unknown[] = [],
  ): Promise<T> => {
    const sql = query.replace(/\s+/g, " ").trim();

    if (/^CREATE TABLE/i.test(sql) || /^CREATE INDEX/i.test(sql)) {
      return [] as T;
    }

    if (/SELECT \* FROM chisabot_media_model_pool WHERE id = \$1/i.test(sql)) {
      const hit = poolRows.get(String(params[0]));
      return (hit ? [hit] : []) as T;
    }

    if (
      /SELECT \* FROM chisabot_media_model_pool WHERE enabled = true/i.test(sql)
    ) {
      const list = [...poolRows.values()].filter((row) => row.enabled === true);
      return list as T;
    }

    if (/SELECT \* FROM chisabot_media_model_pool ORDER BY/i.test(sql)) {
      return [...poolRows.values()] as T;
    }

    if (/INSERT INTO chisabot_media_model_pool/i.test(sql)) {
      const now = new Date().toISOString();
      const row: Record<string, unknown> = {
        id: params[0],
        label: params[1],
        capability: params[2],
        provider: params[3],
        base_url: params[4],
        model: params[5],
        cost_hint: params[6],
        style_tags: params[7],
        max_reference_images: params[8],
        param_schema: params[9],
        enabled: params[10],
        api_key: params[11],
        key_hint: params[12],
        created_at: now,
        updated_at: now,
        updated_by: params[13],
      };
      poolRows.set(String(params[0]), row);
      return [] as T;
    }

    if (/UPDATE chisabot_media_model_pool/i.test(sql)) {
      const id = String(params[0]);
      const prev = poolRows.get(id);
      if (!prev) return [] as T;
      poolRows.set(id, {
        ...prev,
        label: params[1],
        capability: params[2],
        provider: params[3],
        base_url: params[4],
        model: params[5],
        cost_hint: params[6],
        style_tags: params[7],
        max_reference_images: params[8],
        param_schema: params[9],
        enabled: params[10],
        api_key: params[11],
        key_hint: params[12],
        updated_at: new Date().toISOString(),
        updated_by: params[13],
      });
      return [] as T;
    }

    if (/DELETE FROM chisabot_media_model_pool WHERE id = \$1/i.test(sql)) {
      const id = String(params[0]);
      if (!poolRows.has(id)) return [] as T;
      poolRows.delete(id);
      return [{ id }] as T;
    }

    if (
      /SELECT \* FROM chisabot_video_generation_tasks WHERE owner_user_id = \$1 AND request_key = \$2/i.test(
        sql,
      )
    ) {
      const hit = [...taskRows.values()].find(
        (row) =>
          row.owner_user_id === params[0] && row.request_key === params[1],
      );
      return (hit ? [hit] : []) as T;
    }

    if (
      /SELECT \* FROM chisabot_video_generation_tasks WHERE owner_user_id = \$1 AND id = \$2/i.test(
        sql,
      )
    ) {
      const hit = taskRows.get(String(params[1]));
      return (hit && hit.owner_user_id === params[0] ? [hit] : []) as T;
    }

    if (/INSERT INTO chisabot_video_generation_tasks/i.test(sql)) {
      const now = new Date().toISOString();
      taskRows.set(String(params[0]), {
        id: params[0],
        owner_user_id: params[1],
        agent_id: params[2],
        request_key: params[3],
        model_id: params[4],
        provider_task_id: params[5],
        status: params[6],
        progress: params[7],
        prompt: params[8],
        result_file_id: null,
        error_message: null,
        created_at: now,
        updated_at: now,
      });
      return [] as T;
    }

    if (
      /UPDATE chisabot_video_generation_tasks SET status = 'succeeded'/i.test(
        sql,
      )
    ) {
      const prev = taskRows.get(String(params[0]));
      if (prev && prev.owner_user_id === params[1]) {
        prev.status = "succeeded";
        prev.progress = 100;
        prev.result_file_id = params[2];
        prev.error_message = null;
        prev.updated_at = new Date().toISOString();
      }
      return [] as T;
    }

    if (
      /UPDATE chisabot_video_generation_tasks SET status = 'failed'/i.test(sql)
    ) {
      const prev = taskRows.get(String(params[0]));
      if (prev && prev.owner_user_id === params[1]) {
        prev.status = "failed";
        prev.error_message = params[2];
        prev.updated_at = new Date().toISOString();
      }
      return [] as T;
    }

    if (/UPDATE chisabot_video_generation_tasks SET status = \$3/i.test(sql)) {
      const prev = taskRows.get(String(params[0]));
      if (prev && prev.owner_user_id === params[1]) {
        prev.status = params[2];
        prev.progress = params[3];
        prev.updated_at = new Date().toISOString();
      }
      return [] as T;
    }

    throw new Error(`未实现的测试 SQL：${sql}`);
  };

  return {
    db: { $client: { unsafe } as never },
    poolRows,
    taskRows,
  };
}

const TEST_KEY = Buffer.alloc(32, 0x5a).toString("base64");

describe("多模态模型池 CRUD、AES-256-GCM 密钥封存与同源校验", () => {
  test("管理员 CRUD、落盘密文非明文、跨源更新自动剥离旧密钥", async () => {
    const { db, poolRows } = createMemoryMediaPoolDb();
    const service = createMediaPoolService(db, { encryptionKey: TEST_KEY });
    await service.ensure();

    const adminActor: AgentActor = {
      id: "admin-1",
      email: "admin@example.test",
      role: "admin",
    };
    const memberActor: AgentActor = {
      id: "member-1",
      email: "member@example.test",
      role: "member",
    };
    let currentActor: AgentActor = memberActor;
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", currentActor);
      await next();
    };
    const app = service.routes(requireUser);

    // 普通成员禁止写入
    const denied = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "越权测试",
        capability: "image-generate",
        provider: "openai",
        baseUrl: "https://images.example.test/v1",
        model: "gpt-image-1",
      }),
    });
    expect(denied.status).toBe(403);

    // 管理员创建条目，密钥 AES-GCM 封存
    currentActor = adminActor;
    const createdRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "img-realistic",
        label: "写实画质模型",
        capability: "image-generate",
        provider: "openai",
        baseUrl: "https://images.example.test/v1",
        model: "gpt-image-1",
        costHint: "¥0.2/张",
        styleTags: ["写实", "摄影"],
        maxReferenceImages: 6,
        paramSchema: {
          type: "object",
          properties: {
            quality: { type: "string", enum: ["low", "medium", "high"] },
            steps: { type: "integer", minimum: 10, maximum: 50 },
          },
          additionalProperties: false,
        },
        apiKey: "sk-live-secret-9876",
      }),
    });
    expect(createdRes.status).toBe(201);
    const createdBody = (await createdRes.json()) as {
      entry: { keySource: string; keyHint: string; id: string };
    };
    expect(createdBody.entry.id).toBe("img-realistic");
    expect(createdBody.entry.keySource).toBe("saved");
    expect(createdBody.entry.keyHint).toBe("9876");

    // 校验数据库落盘的是密文而非明文
    const storedRaw = poolRows.get("img-realistic");
    expect(typeof storedRaw?.api_key).toBe("string");
    expect(String(storedRaw?.api_key)).not.toContain("sk-live-secret-9876");

    // 同源更新（只改路径与标签）保留密钥
    expect(
      sameMediaOrigin(
        "https://images.example.test/v1",
        "https://images.example.test/v2",
      ),
    ).toBe(true);
    const sameOriginUpdate = await app.request("/img-realistic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "写实画质模型 v2",
        capability: "image-generate",
        provider: "openai",
        baseUrl: "https://images.example.test/v2",
        model: "gpt-image-1",
        maxReferenceImages: 8,
      }),
    });
    expect(sameOriginUpdate.status).toBe(200);
    const sameJson = (await sameOriginUpdate.json()) as {
      entry: { keySource: string; keyHint: string };
    };
    expect(sameJson.entry.keySource).toBe("saved");
    expect(sameJson.entry.keyHint).toBe("9876");

    // 跨源更新（换域名且未传新密钥）必须清除旧密钥，防止跨源泄露
    expect(
      sameMediaOrigin(
        "https://images.example.test/v2",
        "https://attacker.example.test/v1",
      ),
    ).toBe(false);
    const crossOriginUpdate = await app.request("/img-realistic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "跨源测试",
        capability: "image-generate",
        provider: "openai",
        baseUrl: "https://attacker.example.test/v1",
        model: "gpt-image-1",
      }),
    });
    expect(crossOriginUpdate.status).toBe(200);
    const crossJson = (await crossOriginUpdate.json()) as {
      entry: { keySource: string; keyHint: string };
    };
    expect(crossJson.entry.keySource).toBe("none");
    expect(crossJson.entry.keyHint).toBe("");
    expect(poolRows.get("img-realistic")?.api_key).toBeNull();

    // 删除条目
    const delRes = await app.request("/img-realistic", { method: "DELETE" });
    expect(delRes.status).toBe(204);
    expect(await service.getEntry("img-realistic")).toBeNull();
  });

  test("paramSchema 白名单校验拦截未声明字段与越界数值", () => {
    const schema = {
      type: "object" as const,
      properties: {
        quality: { type: "string" as const, enum: ["standard", "hd"] },
        cfg_scale: { type: "number" as const, minimum: 1, maximum: 20 },
        seed: { type: "integer" as const, minimum: 0 },
        enhance: { type: "boolean" as const, default: true },
      },
      required: ["quality"],
      additionalProperties: false as const,
    };

    const ok = validateMediaParams(schema, {
      quality: "hd",
      cfg_scale: 7.5,
      seed: 42,
    });
    expect(ok).toEqual({
      ok: true,
      value: { quality: "hd", cfg_scale: 7.5, seed: 42, enhance: true },
    });

    const injected = validateMediaParams(schema, {
      quality: "hd",
      evil_override: "pwned",
    });
    expect(injected.ok).toBe(false);

    const outOfRange = validateMediaParams(schema, {
      quality: "ultra",
      cfg_scale: 99,
      seed: 1.5,
    });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) {
      expect(outOfRange.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("多参考图生图（≤10）、视频生成幂等与专项视频理解子会话", () => {
  test("image_generate_multi 严格限制 ≤10 张参考图并透传白名单参数", async () => {
    const { db } = createMemoryMediaPoolDb();
    const tinyPng = makePng(64, 64);
    const seenAuthHeaders: string[] = [];
    let seenRefCount = 0;
    let seenQuality = "";

    const service = createMediaPoolService(db, {
      encryptionKey: TEST_KEY,
      loadFile: async (_owner, _agentId, source) => ({
        id: source ?? "ref-1",
        name: `${source ?? "ref"}.png`,
        mimeType: "image/png",
        bytes: tinyPng,
      }),
      storeFile: async (_owner, _agentId, file) => ({
        id: "file-img-01",
        name: file.name,
        mimeType: file.mimeType,
        size: file.bytes.length,
        kind: file.kind,
        url: "/api/chat-files/file-img-01",
        workspacePath: null,
        createdAt: new Date().toISOString(),
      }),
      transport: async (_url, init) => {
        const headers = new Headers(init?.headers);
        seenAuthHeaders.push(headers.get("authorization") ?? "");
        if (init?.body instanceof FormData) {
          seenRefCount = init.body.getAll("image[]").length;
          seenQuality = String(init.body.get("quality") ?? "");
        }
        return Response.json({
          data: [{ b64_json: tinyPng.toString("base64") }],
        });
      },
    });
    await service.ensure();
    await service.createEntry("admin-1", {
      id: "multi-img-pro",
      label: "多图融合大师",
      capability: "image-edit",
      provider: "openai",
      baseUrl: "https://media.example.test/v1",
      model: "gpt-image-1",
      maxReferenceImages: MAX_MEDIA_REFERENCE_IMAGES,
      styleTags: ["插画", "融合"],
      paramSchema: {
        type: "object",
        properties: {
          quality: { type: "string", enum: ["standard", "high"] },
        },
        additionalProperties: false,
      },
      apiKey: "sk-multi-image-key-1234",
    });

    const granted = await service.tools("user-1", "bot-1");
    const listTool = granted.find((t) => t.name === "media_pool_list");
    const genTool = granted.find((t) => t.name === "image_generate_multi");
    expect(listTool).toBeDefined();
    expect(genTool).toBeDefined();

    // 自主选型列表不暴露密钥
    const listText = await listTool?.execute({ capability: "image-edit" });
    expect(listText).toContain("multi-img-pro");
    expect(listText).not.toContain("sk-multi-image-key-1234");

    // 11 张参考图被严格拒绝
    const elevenRefs = Array.from({ length: 11 }, (_, i) => `ref-${i + 1}`);
    const overLimit = await service
      .generateImageMulti("user-1", "bot-1", {
        prompt: "合成海报",
        modelId: "multi-img-pro",
        referenceSources: elevenRefs,
      })
      .catch((e: Error) => e);
    expect(overLimit).toBeInstanceOf(Error);
    expect((overLimit as Error).message).toContain("10");

    // 10 张参考图 + 合法白名单参数成功
    const tenRefs = Array.from({ length: 10 }, (_, i) => `ref-${i + 1}`);
    const okResult = await genTool?.execute({
      prompt: "把 10 个元素合成奇幻海报",
      modelId: "multi-img-pro",
      reference_sources: tenRefs,
      params: { quality: "high" },
    });
    expect(okResult).toContain(CHAT_FILES_MARKER);
    expect(seenRefCount).toBe(10);
    expect(seenQuality).toBe("high");
    expect(seenAuthHeaders[0]).toBe("Bearer sk-multi-image-key-1234");

    // 未声明参数注入被拒绝
    const badParamOut = await genTool?.execute({
      prompt: "注入测试",
      modelId: "multi-img-pro",
      params: { hacked_field: true },
    });
    expect(badParamOut).toContain("白名单");
  });

  test("video_generate 幂等 requestKey 防重复扣费，并支持状态轮询落盘", async () => {
    const { db } = createMemoryMediaPoolDb();
    let submitCalls = 0;
    const storedFiles = new Map<string, ChatFileView>();

    const service = createMediaPoolService(db, {
      encryptionKey: TEST_KEY,
      storeFile: async (_owner, _agentId, file) => {
        const view: ChatFileView = {
          id: "video-file-01",
          name: file.name,
          mimeType: file.mimeType,
          size: file.bytes.length,
          kind: file.kind,
          url: "/api/chat-files/video-file-01",
          workspacePath: null,
          createdAt: new Date().toISOString(),
        };
        storedFiles.set(view.id, view);
        return view;
      },
      getFileView: async (_owner, id) => storedFiles.get(id) ?? null,
      download: async () => Buffer.from("fake-mp4-binary-stream"),
      transport: async (url, init) => {
        if (init?.method === "POST") {
          submitCalls += 1;
          return Response.json({
            id: "upstream-job-777",
            status: "queued",
            progress: 10,
          });
        }
        if (url.includes("upstream-job-777")) {
          return Response.json({
            id: "upstream-job-777",
            status: "succeeded",
            progress: 100,
            video_url: "https://cdn.example.test/out.mp4",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    await service.ensure();
    await service.createEntry("admin-1", {
      id: "vid-pro",
      label: "电影级视频模型",
      capability: "video-generate",
      provider: "openai",
      baseUrl: "https://video.example.test/v1",
      model: "sora-next",
      apiKey: "sk-video-key-5555",
    });

    // 相同 requestKey 提交两次，只扣一次上游调用
    const first = await service.submitVideoGeneration("user-1", "bot-1", {
      prompt: "航拍日落云海",
      requestKey: "req-sunset-001",
    });
    const second = await service.submitVideoGeneration("user-1", "bot-1", {
      prompt: "航拍日落云海",
      requestKey: "req-sunset-001",
    });
    expect(submitCalls).toBe(1);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.task.taskId).toBe(first.task.taskId);

    // 轮询状态完成并落盘生成视频卡片
    const polled = await service.pollVideoGenerationStatus("user-1", "bot-1", {
      taskId: first.task.taskId,
    });
    expect(polled.status).toBe("succeeded");
    expect(polled.file?.mimeType).toBe("video/mp4");
    expect(polled.file?.url).toBe("/api/chat-files/video-file-01");
  });

  test("video_inspect 严禁私有 /analyze 端点与超大视频暴力 base64 内联，支持标准 Gemini 与关键帧抽样", async () => {
    const { db } = createMemoryMediaPoolDb();
    const calledUrls: string[] = [];
    const tinyVideo = Buffer.alloc(1024, 0x11);
    const hugeVideo = Buffer.alloc(MAX_VIDEO_INLINE_BYTES + 1024, 0x22);
    let currentVideo = tinyVideo;

    const service = createMediaPoolService(db, {
      encryptionKey: TEST_KEY,
      loadFile: async () => ({
        id: "vid-1",
        name: "demo.mp4",
        mimeType: "video/mp4",
        bytes: currentVideo,
      }),
      extractKeyframes: async (_bytes, count) =>
        Array.from({ length: Math.min(count, 3) }, () => makePng(32, 32)),
      transport: async (url) => {
        calledUrls.push(url);
        expect(url).not.toContain("/analyze");
        if (url.includes(":generateContent")) {
          return Response.json({
            candidates: [
              { content: { parts: [{ text: "画面里一只橘猫跳上桌面。" }] } },
            ],
          });
        }
        return Response.json({
          choices: [{ message: { content: "关键帧显示白板上有三段流程。" } }],
        });
      },
    });
    await service.ensure();
    await service.createEntry("admin-1", {
      id: "gem-video",
      label: "Gemini 视频理解",
      capability: "video-understand",
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.5-flash",
      apiKey: "gm-secret-1111",
    });

    // 小视频走标准 Gemini generateContent
    const smallResult = await service.inspectVideo("user-1", "bot-1", {
      source: "vid-1",
      question: "视频里发生了什么？",
    });
    expect(smallResult.strategy).toBe("gemini-inline-bounded");
    expect(smallResult.summary).toContain("橘猫");
    expect(calledUrls[0]).toContain(
      "/v1beta/models/gemini-2.5-flash:generateContent",
    );

    // 超过 10 MiB 大视频禁止暴力 base64 内联，自动走关键帧抽样策略
    currentVideo = hugeVideo;
    const hugeResult = await service.inspectVideo("user-1", "bot-1", {
      source: "vid-1",
      question: "白板上写了什么？",
      frameCount: 3,
    });
    expect(hugeResult.strategy).toBe("keyframe-sampling");
    expect(hugeResult.framesSampled).toBe(3);
  });

  test("POST /api/bots/:agentId/avatar/generate 校验像素炸弹并落库设为 Bot 头像", async () => {
    const { db } = createMemoryMediaPoolDb();
    const owner: AgentActor = {
      id: "owner-1",
      email: "owner@example.test",
      role: "member",
    };
    const stranger: AgentActor = {
      id: "stranger-1",
      email: "stranger@example.test",
      role: "member",
    };
    const botProfile = {
      id: "bot-alpha",
      name: "小千",
      title: "科研助手",
      roleDescription: "整理文献",
      ownerUserId: owner.id,
      visibility: "private",
      systemOwned: false,
      deletedAt: null,
    } as unknown as AgentProfile;

    let generatedPayload = makePng(256, 256);
    let savedAvatarBytes: Uint8Array | null = null;
    let activeActor: AgentActor = owner;

    const service = createMediaPoolService(db, {
      encryptionKey: TEST_KEY,
      agents: {
        get: async (_actor, id) => (id === botProfile.id ? botProfile : null),
      },
      botAvatars: {
        setImage: async (_actor, agentId, bytes) => {
          savedAvatarBytes = bytes;
          return {
            kind: "image",
            url: `/api/bot-avatars/${agentId}/image?v=abc123`,
            version: "abc123",
          };
        },
      },
      transport: async () =>
        Response.json({
          data: [{ b64_json: generatedPayload.toString("base64") }],
        }),
    });
    await service.ensure();
    await service.createEntry("admin-1", {
      id: "avatar-gen-model",
      label: "头像生图模型",
      capability: "image-generate",
      provider: "openai",
      baseUrl: "https://images.example.test/v1",
      model: "gpt-image-1",
      apiKey: "sk-avatar-key-9999",
    });

    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", activeActor);
      await next();
    };
    const app = service.botAvatarRoutes(requireUser);

    // 非所有者返回 403
    activeActor = stranger;
    const forbidden = await app.request("/bot-alpha/avatar/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "科技风蓝猫" }),
    });
    expect(forbidden.status).toBe(403);

    // 上游返回像素炸弹（9000×9000 PNG）被拦截返回 400
    activeActor = owner;
    generatedPayload = makePng(9000, 9000);
    const bombRes = await app.request("/bot-alpha/avatar/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "超大炸弹" }),
    });
    expect(bombRes.status).toBe(400);
    expect(savedAvatarBytes).toBeNull();

    // 合法 256×256 PNG 通过校验并落库
    generatedPayload = makePng(256, 256);
    const okRes = await app.request("/bot-alpha/avatar/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "极简温暖猫头鹰" }),
    });
    expect(okRes.status).toBe(200);
    const okJson = (await okRes.json()) as {
      avatar: { kind: string; url: string };
    };
    expect(okJson.avatar.kind).toBe("image");
    expect(savedAvatarBytes).not.toBeNull();
  });

  test("attachment-parts 对 video/* 附件输出 video_inspect 引导且不退化为无法读取", async () => {
    const budget = newInlineBudget(1024);
    const bigVideoBytes = Buffer.alloc(64 * 1024, 0x00);
    const content = [
      {
        type: "video",
        source: {
          type: "url",
          value: "/api/chat-files/11111111-1111-1111-1111-111111111111",
          mimeType: "video/mp4",
        },
        metadata: { filename: "clip.mp4" },
      },
    ];

    const resolved = (await resolveAttachmentParts(
      content,
      async () => ({
        mimeType: "video/mp4",
        name: "clip.mp4",
        bytes: bigVideoBytes,
      }),
      "fail",
      budget,
    )) as Array<{ type: string; text: string }>;

    expect(resolved[0]?.type).toBe("text");
    expect(resolved[0]?.text).toContain("video_inspect");
    expect(resolved[0]?.text).toContain("11111111-1111-1111-1111-111111111111");
    expect(resolved[0]?.text).not.toContain("没法交给模型看");
    // 视频附件不消耗 32MiB base64 内联预算
    expect(budget.remaining).toBe(1024);
  });
});
