import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  DEFAULT_HARNESS_FLAGS,
  HARNESS_FLAG_KEYS,
} from "../../shared/admin-workbench";
import {
  createHarnessSettingsService,
  createMemoryHarnessSettingsStorage,
  getHarnessFlags,
  HarnessSettingsValidationError,
  setActiveHarnessFlagsReader,
} from "../src/admin/harness-settings";
import {
  createModelObservationService,
  MAX_OBSERVATION_RECORDS,
} from "../src/agents/model-observation";
import type { AppVariables } from "../src/auth/guards";
import { createModelConnectionProxy } from "../src/conversations/model-connection-proxy";
import {
  buildUsageBreakdown,
  createMemoryUsageBreakdownStorage,
  createUsageBreakdownService,
  formatLocalDay,
} from "../src/quotas/usage-breakdown";

function createRoleMiddleware(
  role: "admin" | "user",
  id = role === "admin" ? "admin-1" : "user-1",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id,
      email: `${id}@example.test`,
      name: id,
      role,
    });
    await next();
  };
}

describe("本地时区 + 按用途(kind) + 思考 Token(reasoning) 细分用量账本", () => {
  test("同一 UTC 时刻在不同 IANA 时区下精确切日，并正确聚合 kind 与 reasoningTokens", async () => {
    // 2026-11-19T17:30:00Z：
    // - Asia/Shanghai (UTC+8) = 2026-11-20 01:30 → 属于 11-20
    // - UTC                   = 2026-11-19 17:30 → 属于 11-19
    // - America/Los_Angeles   = 2026-11-19 09:30 → 属于 11-19
    const crossDayInstant = Date.UTC(2026, 10, 19, 17, 30, 0);
    expect(formatLocalDay(crossDayInstant, "Asia/Shanghai")).toBe("2026-11-20");
    expect(formatLocalDay(crossDayInstant, "UTC")).toBe("2026-11-19");
    expect(formatLocalDay(crossDayInstant, "America/Los_Angeles")).toBe(
      "2026-11-19",
    );

    const nowMs = Date.UTC(2026, 10, 19, 18, 0, 0); // Shanghai 已进入 2026-11-20 02:00；UTC 仍在 2026-11-19
    const storage = createMemoryUsageBreakdownStorage({ now: () => nowMs });
    const service = createUsageBreakdownService(storage, { now: () => nowMs });

    // 事件 A：11-19T17:30Z（Shanghai 今日 11-20；UTC 今日 11-19）
    await service.record({
      ownerUserId: "u1",
      kind: "chat",
      modelId: "deepseek-reasoner",
      effort: "high",
      inputTokens: 1000,
      outputTokens: 600,
      reasoningTokens: 420,
      createdAt: crossDayInstant,
    });

    // 事件 B：11-19T15:00Z（Shanghai 昨日 11-19 23:00；UTC 今日 11-19 15:00）
    await service.record({
      ownerUserId: "u1",
      kind: "summary",
      modelId: "gpt-4.1-mini",
      effort: "low",
      inputTokens: 500,
      outputTokens: 100,
      reasoningTokens: 0,
      createdAt: Date.UTC(2026, 10, 19, 15, 0, 0),
    });

    // 事件 C：10 天前（仅落在 last30Days，不落在 today / last7Days）
    await service.record({
      ownerUserId: "u1",
      kind: "classifier",
      modelId: "gpt-4.1-mini",
      effort: "none",
      inputTokens: 200,
      outputTokens: 30,
      reasoningTokens: 0,
      createdAt: nowMs - 10 * 86_400_000,
    });

    // 事件 D：另一用户（绝不能串号）
    await service.record({
      ownerUserId: "u2",
      kind: "review",
      modelId: "other-model",
      effort: "max",
      inputTokens: 9999,
      outputTokens: 9999,
      reasoningTokens: 5000,
      createdAt: crossDayInstant,
    });

    const shanghai = await service.breakdown("u1", "Asia/Shanghai", nowMs);
    expect(shanghai.today.startDay).toBe("2026-11-20");
    expect(shanghai.today.totals).toEqual({
      inputTokens: 1000,
      outputTokens: 600,
      reasoningTokens: 420,
      totalTokens: 1600,
      requests: 1,
    });
    expect(shanghai.today.byKind.chat.reasoningTokens).toBe(420);
    expect(shanghai.today.byKind.summary.requests).toBe(0);
    // 近 7 天应包含事件 A 与事件 B
    expect(shanghai.last7Days.totals.requests).toBe(2);
    expect(shanghai.last7Days.totals.reasoningTokens).toBe(420);
    expect(shanghai.last7Days.byKind.summary.totalTokens).toBe(600);
    // 近 30 天包含事件 A、B、C
    expect(shanghai.last30Days.totals.requests).toBe(3);
    expect(shanghai.last30Days.byKind.classifier.totalTokens).toBe(230);

    // 切到 UTC 视角：事件 A 和事件 B 都在 2026-11-19 今日窗口内！
    const utc = await service.breakdown("u1", "UTC", nowMs);
    expect(utc.today.startDay).toBe("2026-11-19");
    expect(utc.today.totals.requests).toBe(2);
    expect(utc.today.totals.totalTokens).toBe(2200);
    expect(utc.today.totals.reasoningTokens).toBe(420);

    // 校验纯函数同样准确
    const pureResult = buildUsageBreakdown([], "UTC", nowMs);
    expect(pureResult.today.totals.requests).toBe(0);
  });

  test("GET /api/usage/breakdown?tz=... 严格隔离普通用户并拒绝非法时区", async () => {
    const storage = createMemoryUsageBreakdownStorage();
    const service = createUsageBreakdownService(storage);
    await service.record({
      ownerUserId: "user-1",
      kind: "test",
      modelId: "m1",
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
    });
    await service.record({
      ownerUserId: "user-2",
      kind: "chat",
      modelId: "m2",
      inputTokens: 500,
      outputTokens: 500,
      reasoningTokens: 100,
    });

    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/usage",
      service.routes(createRoleMiddleware("user", "user-1")),
    );

    // 即使普通用户试图传 ?userId=user-2，也必须只看到自己的数据
    const okResp = await app.request(
      "/api/usage/breakdown?tz=Asia/Shanghai&userId=user-2",
    );
    expect(okResp.status).toBe(200);
    const okJson = (await okResp.json()) as {
      breakdown: {
        timeZone: string;
        today: { totals: { totalTokens: number; reasoningTokens: number } };
      };
    };
    expect(okJson.breakdown.timeZone).toBe("Asia/Shanghai");
    expect(okJson.breakdown.today.totals.totalTokens).toBe(30);
    expect(okJson.breakdown.today.totals.reasoningTokens).toBe(5);

    const badTzResp = await app.request(
      "/api/usage/breakdown?tz=Mars/Olympus_Mons",
    );
    expect(badTzResp.status).toBe(400);
  });
});

describe("按需脱敏模型请求观测器与代理链路集成", () => {
  test("默认关闭零记录；热开启后环形缓冲 100 条；绝不泄露 API Key/Authorization/思维链原文，图片仅记 SHA-256", async () => {
    const observer = createModelObservationService();
    expect(observer.isEnabled()).toBe(false);

    // 关闭状态下记录返回 null
    expect(
      observer.record({
        provider: "openai",
        model: "gpt-5",
        status: 200,
        durationMs: 120,
      }),
    ).toBeNull();
    expect(observer.snapshot().count).toBe(0);

    observer.setEnabled(true);
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const expectedSha = createHash("sha256").update(pngBytes).digest("hex");
    const pngBase64 = pngBytes.toString("base64");

    const record = observer.record({
      provider: "openai",
      model: "deepseek-reasoner",
      effort: "high",
      status: 200,
      durationMs: 342,
      requestId: "req_abc123",
      toolTimings: [{ name: "web_search", durationMs: 88 }],
      requestBody: {
        model: "deepseek-reasoner",
        tools: [{ type: "function", function: { name: "web_search" } }],
        messages: [
          {
            role: "assistant",
            reasoning_content: "TOP_SECRET_CHAIN_OF_THOUGHT_DO_NOT_LOG",
            content: [
              { type: "thinking", thinking: "HIDDEN_ANTHROPIC_THINKING" },
              { type: "text", text: "普通助手回复" },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "请用 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc12345678 和 sk-live-secret999999999999 <think>秘密思考过程</think> 帮我检查图片",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${pngBase64}` },
              },
            ],
          },
        ],
      },
    });

    expect(record).not.toBeNull();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("TOP_SECRET_CHAIN_OF_THOUGHT_DO_NOT_LOG");
    expect(serialized).not.toContain("HIDDEN_ANTHROPIC_THINKING");
    expect(serialized).not.toContain("秘密思考过程");
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain(pngBase64);
    expect(record?.images).toEqual([
      { sha256: expectedSha, mediaType: "image/png", bytes: pngBytes.length },
    ]);
    expect(record?.tools).toEqual([{ name: "web_search", durationMs: 88 }]);

    // 写入 120 条验证环形缓冲严格封顶 100 条
    for (let i = 0; i < 120; i += 1) {
      observer.record({
        provider: "openai",
        model: `model-${i}`,
        status: 200,
        durationMs: i,
      });
    }
    const snap = observer.snapshot();
    expect(snap.capacity).toBe(MAX_OBSERVATION_RECORDS);
    expect(snap.count).toBe(MAX_OBSERVATION_RECORDS);
    expect(snap.items[0]?.model).toBe("model-119");
    expect(snap.items[snap.items.length - 1]?.model).toBe("model-20");

    // 管理员 HTTP 路由校验（GET / PUT toggle / DELETE）
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/observation",
      observer.routes(createRoleMiddleware("admin")),
    );
    const toggleOff = await app.request("/api/admin/observation/toggle", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggleOff.status).toBe(200);
    expect(((await toggleOff.json()) as { enabled: boolean }).enabled).toBe(
      false,
    );

    const cleared = await app.request("/api/admin/observation", {
      method: "DELETE",
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { count: number }).count).toBe(0);

    // PUT /toggle 超过 4 KiB 必须拒绝返回 413
    const oversized = await app.request("/api/admin/observation/toggle", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, padding: "x".repeat(5 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });

  test("model-connection-proxy 透传 reasoningEffort 参数、提取 reasoningTokens 并写入脱敏观测器", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        capturedBodies.push((await request.json()) as Record<string, unknown>);
        return Response.json(
          {
            id: "chatcmpl-test",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 80,
              completion_tokens_details: { reasoning_tokens: 55 },
            },
          },
          { headers: { "x-request-id": "req-proxy-1" } },
        );
      },
    });

    try {
      const observer = createModelObservationService({
        initiallyEnabled: true,
      });
      const breakdownRecorded: Array<{
        reasoningTokens: number;
        effort: string;
        kind: string;
      }> = [];
      const proxy = createModelConnectionProxy(
        {
          provider: "openai",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "sk-super-secret-proxy-key-9999999",
        },
        ["deepseek-reasoner"],
        ["web_search"],
        new AbortController().signal,
        {
          reasoningEffort: "high",
          observer,
          ownerUserId: "u-proxy",
          usageKind: "chat",
          onUsageBreakdown: (event) => {
            breakdownRecorded.push({
              reasoningTokens: event.reasoningTokens,
              effort: event.effort,
              kind: event.kind,
            });
          },
        },
      );

      const response = await proxy(
        {
          model: "deepseek-reasoner",
          messages: [{ role: "user", content: "测试思考参数透传" }],
        },
        new AbortController().signal,
      );
      expect(response.status).toBe(200);
      await response.text();
      // 等待 TransformStream flush 回调完成
      await new Promise((resolve) => setTimeout(resolve, 20));

      const capturedBody = capturedBodies[0];
      expect(capturedBody).toBeDefined();
      expect(capturedBody?.reasoning_effort).toBe("high");
      expect(capturedBody?.thinking).toEqual({ type: "enabled" });
      expect(breakdownRecorded).toEqual([
        { reasoningTokens: 55, effort: "high", kind: "chat" },
      ]);

      const snap = observer.snapshot();
      expect(snap.count).toBe(1);
      expect(snap.items[0]?.requestId).toBe("req-proxy-1");
      expect(JSON.stringify(snap)).not.toContain("sk-super-secret-proxy-key");
    } finally {
      server.stop(true);
    }
  });

  test("Anthropic 代理绝不注入非法 reasoning_effort，并按 max_tokens 钳制 thinking.budget_tokens（max_tokens <= 1024 时跳过）", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        capturedBodies.push((await request.json()) as Record<string, unknown>);
        return Response.json({
          id: "msg-test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 40, output_tokens: 20 },
        });
      },
    });

    try {
      const proxy = createModelConnectionProxy(
        {
          provider: "anthropic",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "sk-ant-test-key-12345678",
        },
        ["claude-sonnet-4-5"],
        [],
        new AbortController().signal,
        {
          reasoningEffort: "high", // 默认 budget_tokens = 12288
        },
      );

      // 1. max_tokens = 4096 -> budget_tokens 钳制为 3072 (< 4096)，且无 reasoning_effort
      const r1 = await proxy(
        {
          model: "claude-sonnet-4-5",
          max_tokens: 4096,
          messages: [{ role: "user", content: "hello" }],
        },
        new AbortController().signal,
      );
      expect(r1.status).toBe(200);
      await r1.text();

      // 2. max_tokens = 1024 -> 跳过开启 thinking，避免 Anthropic 400
      const r2 = await proxy(
        {
          model: "claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        },
        new AbortController().signal,
      );
      expect(r2.status).toBe(200);
      await r2.text();

      // 3. max_tokens = 2048 -> budget_tokens 钳制为 1024 (满足 >= 1024 且 < max_tokens)
      const r3 = await proxy(
        {
          model: "claude-sonnet-4-5",
          max_tokens: 2048,
          messages: [{ role: "user", content: "hello" }],
        },
        new AbortController().signal,
      );
      expect(r3.status).toBe(200);
      await r3.text();

      // 4. max_tokens = 32000 -> 保持原始 12288
      const r4 = await proxy(
        {
          model: "claude-sonnet-4-5",
          max_tokens: 32000,
          messages: [{ role: "user", content: "hello" }],
        },
        new AbortController().signal,
      );
      expect(r4.status).toBe(200);
      await r4.text();

      expect(capturedBodies).toHaveLength(4);
      for (const body of capturedBodies) {
        expect("reasoning_effort" in body).toBe(false);
      }
      expect(capturedBodies[0]?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 3072,
      });
      expect(capturedBodies[1]?.thinking).toBeUndefined();
      expect(capturedBodies[2]?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 1024,
      });
      expect(capturedBodies[3]?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 12288,
      });
    } finally {
      server.stop(true);
    }
  });
});

describe("Harness 7 项高影响 AI 能力热开关台", () => {
  test("默认值、持久化保存、严格校验、运行时 getHarnessFlags() 与 HTTP 路由", async () => {
    const storage = createMemoryHarnessSettingsStorage();
    const service = createHarnessSettingsService(storage);
    await service.ensure();

    try {
      expect(HARNESS_FLAG_KEYS).toHaveLength(7);
      expect(getHarnessFlags()).toEqual({
        ...DEFAULT_HARNESS_FLAGS,
        memoryDreaming: false,
      });

      // 保存局部更新并实时同步到 getHarnessFlags()
      const saved = await service.save(
        { memoryDreaming: true, desktopControl: false },
        "admin-1",
      );
      expect(saved.flags.memoryDreaming).toBe(true);
      expect(saved.flags.desktopControl).toBe(false);
      expect(saved.flags.browserSubagent).toBe(true);
      expect(saved.updatedBy).toBe("admin-1");
      expect(getHarnessFlags().memoryDreaming).toBe(true);
      expect(getHarnessFlags().desktopControl).toBe(false);

      // 未知字段或非布尔值必须拒绝
      await expect(
        service.save({ unknownFlag: true }, "admin-1"),
      ).rejects.toBeInstanceOf(HarnessSettingsValidationError);
      await expect(
        service.save({ memoryDreaming: "yes" }, "admin-1"),
      ).rejects.toBeInstanceOf(HarnessSettingsValidationError);

      // HTTP 路由校验（管理员可读写、普通用户 403）
      const adminApp = new Hono<{ Variables: AppVariables }>();
      adminApp.route(
        "/api/admin/harness",
        service.routes(createRoleMiddleware("admin")),
      );
      const userApp = new Hono<{ Variables: AppVariables }>();
      userApp.route(
        "/api/admin/harness",
        service.routes(createRoleMiddleware("user")),
      );

      expect((await userApp.request("/api/admin/harness")).status).toBe(403);

      const getResp = await adminApp.request("/api/admin/harness");
      expect(getResp.status).toBe(200);
      const getJson = (await getResp.json()) as {
        flags: Record<string, boolean>;
        descriptors: Array<{ key: string; consumesTokens?: boolean }>;
      };
      expect(getJson.flags.memoryDreaming).toBe(true);
      expect(
        getJson.descriptors.find((d) => d.key === "memoryDreaming")
          ?.consumesTokens,
      ).toBe(true);

      const putResp = await adminApp.request("/api/admin/harness", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teachByDemo: false, passkeyForward: false }),
      });
      expect(putResp.status).toBe(200);
      expect(getHarnessFlags().teachByDemo).toBe(false);
      expect(getHarnessFlags().passkeyForward).toBe(false);
    } finally {
      setActiveHarnessFlagsReader(null);
    }
  });
});
