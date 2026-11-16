import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  mintRunAssertion,
  readRunAssertion,
} from "../src/agents/callback-token";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import type { PlanModelConfig } from "../src/agents/plan-model";
import type { ConversationBindings } from "../src/conversations/bindings";
import {
  createModelKeyPool,
  parseRetryAfterMs,
} from "../src/conversations/key-pool";
import { createModelConnectionProxy } from "../src/conversations/model-connection-proxy";
import { createPlanModelProxy } from "../src/conversations/plan-model-proxy";
import {
  createConversationRoutes,
  publicConversationError,
} from "../src/conversations/routes";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  createMemoryQuotaStorage,
  createQuotaService,
  QuotaExceededError,
} from "../src/quotas/service";
import { testEnvironment } from "./support/environment";
import { createTurnRunner } from "../src/turns/run-turn";

describe("ModelKeyPool 粘性选择与冷却规则", () => {
  test("同一 stickyKey 稳定命中同一把健康 Key，失败后顺延且冷却结束切回", () => {
    let now = 1_700_000_000_000;
    const pool = createModelKeyPool();
    const keys = [
      { id: "k1", label: "主池-1", apiKey: "sk-1" },
      { id: "k2", label: "备池-2", apiKey: "sk-2" },
      { id: "k3", label: "备池-3", apiKey: "sk-3" },
    ];
    pool.setPool("openai:https://api.test/v1", keys);

    const first = pool.selectKey(
      "openai:https://api.test/v1",
      "thread-42",
      now,
    );
    expect(first.key).not.toBeNull();
    const stickyPrimaryId = first.key?.id ?? "";

    for (let i = 0; i < 8; i++) {
      expect(
        pool.selectKey("openai:https://api.test/v1", "thread-42", now).key?.id,
      ).toBe(stickyPrimaryId);
    }

    pool.reportResult(
      "openai:https://api.test/v1",
      stickyPrimaryId,
      429,
      { "retry-after": "20" },
      now,
    );
    const failover = pool.selectKey(
      "openai:https://api.test/v1",
      "thread-42",
      now,
    );
    expect(failover.key).not.toBeNull();
    expect(failover.key?.id).not.toBe(stickyPrimaryId);

    const statusBefore = pool.getPoolStatus(
      "openai:https://api.test/v1",
      keys,
      now,
    );
    const cooledStatus = statusBefore.find(
      (item) => item.id === stickyPrimaryId,
    );
    expect(cooledStatus?.healthy).toBe(false);
    expect(cooledStatus?.cooldownUntil).toBe(now + 20_000);
    expect(cooledStatus?.lastStatus).toBe(429);

    now += 20_000;
    const recovered = pool.selectKey(
      "openai:https://api.test/v1",
      "thread-42",
      now,
    );
    expect(recovered.key?.id).toBe(stickyPrimaryId);
  });

  test("Retry-After 解析支持秒数、HTTP-date、上下限钳位以及 402/401 固定冷却", () => {
    const now = Date.UTC(2026, 4, 15, 10, 0, 0);
    expect(parseRetryAfterMs({ "retry-after": "1" }, now)).toBe(5_000);
    expect(parseRetryAfterMs({ "retry-after": "45" }, now)).toBe(45_000);
    expect(parseRetryAfterMs({ "retry-after": "9999" }, now)).toBe(300_000);
    expect(parseRetryAfterMs(undefined, now)).toBe(60_000);
    expect(
      parseRetryAfterMs(
        { "retry-after": new Date(now + 90_000).toUTCString() },
        now,
      ),
    ).toBe(90_000);

    const pool = createModelKeyPool();
    pool.setPool("p", [
      { id: "a", label: "A", apiKey: "sk-a" },
      { id: "b", label: "B", apiKey: "sk-b" },
    ]);
    pool.reportResult("p", "a", 402, undefined, now);
    pool.reportResult("p", "b", 401, undefined, now);

    const all = pool.getPoolStatus(
      "p",
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      now,
    );
    expect(all[0]?.cooldownUntil).toBe(now + 600_000);
    expect(all[1]?.cooldownUntil).toBe(now + 3_600_000);

    const exhausted = pool.selectKey("p", "s1", now);
    expect(exhausted.key).toBeNull();
    expect(exhausted.nextAvailableAt).toBe(now + 600_000);
  });

  test("setPool 更新列表时保留未改动 ID 的当前冷却态", () => {
    const now = 1_700_000_000_000;
    const pool = createModelKeyPool();
    pool.setPool("p", [
      { id: "k1", label: "一", apiKey: "sk-1" },
      { id: "k2", label: "二", apiKey: "sk-2" },
    ]);
    pool.reportResult("p", "k1", 403, undefined, now);
    pool.setPool("p", [
      { id: "k1", label: "一-重命名", apiKey: "sk-1" },
      { id: "k3", label: "三", apiKey: "sk-3" },
    ]);
    const status = pool.getPoolStatus(
      "p",
      [
        { id: "k1", label: "一-重命名" },
        { id: "k3", label: "三" },
      ],
      now,
    );
    expect(status[0]?.healthy).toBe(false);
    expect(status[0]?.cooldownUntil).toBe(now + 3_600_000);
    expect(status[1]?.healthy).toBe(true);
  });
});

describe("模型连接代理：多 Key 轮换、流式透传与配额记账", () => {
  test("同池内遇 429 自动切换下一把 Key 重试成功，全池耗尽返回 429 与 Retry-After", async () => {
    const now = 1_700_000_000_000;
    const seenAuth: string[] = [];
    let mode: "fail_first_then_ok" | "fail_all" = "fail_first_then_ok";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const auth = request.headers.get("authorization") ?? "";
        seenAuth.push(auth);
        if (mode === "fail_all") {
          return Response.json(
            { error: "rate limited" },
            { status: 429, headers: { "retry-after": "25" } },
          );
        }
        if (seenAuth.length === 1) {
          return Response.json(
            { error: "rate limited" },
            { status: 429, headers: { "retry-after": "25" } },
          );
        }
        return Response.json({
          id: "chatcmpl-1",
          choices: [{ message: { role: "assistant", content: "重试成功" } }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        });
      },
    });

    try {
      const storage = createMemoryQuotaStorage();
      const quotaService = createQuotaService(storage);
      const keyPool = createModelKeyPool();
      const run = new AbortController();
      const proxy = createModelConnectionProxy(
        {
          provider: "openai",
          baseUrl: `${upstream.url}v1`,
          apiKey: "sk-key-1",
          pooledKeys: [
            { id: "k1", label: "K1", apiKey: "sk-key-1" },
            { id: "k2", label: "K2", apiKey: "sk-key-2" },
          ],
        },
        ["gpt-4o"],
        [],
        run.signal,
        {
          stickyKey: "session-rotate",
          keyPool,
          now: () => now,
          quota: {
            userId: "u-rotate",
            isAdmin: false,
            checkAdmission: quotaService.checkAdmission,
            recordUsage: quotaService.recordUsage,
          },
        },
      );

      const okRes = await proxy(
        { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      );
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toMatchObject({ id: "chatcmpl-1" });
      expect(seenAuth).toHaveLength(2);
      expect(seenAuth[0]).not.toBe(seenAuth[1]);

      const summary = await quotaService.getUserSummary("u-rotate", false, now);
      expect(summary.usage.daily).toEqual({
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 40,
        totalTokens: 150,
        requests: 1,
      });

      mode = "fail_all";
      const secondRes = await proxy(
        { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      );
      expect(secondRes.status).toBe(429);
      expect(secondRes.headers.get("retry-after")).toBe("25");
      const exhaustedJson = (await secondRes.json()) as {
        code?: string;
        error?: string;
      };
      expect(exhaustedJson.code).toBe("key_pool_exhausted");
      expect(exhaustedJson.error).toContain("冷却中");

      // 全池已冷却后再次请求，不再向外发任何请求
      const callsBefore = seenAuth.length;
      const blockedRes = await proxy(
        { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      );
      expect(blockedRes.status).toBe(429);
      expect(seenAuth.length).toBe(callsBefore);
    } finally {
      await upstream.stop(true);
    }
  });

  test("Anthropic SSE 边透传边解析 message_start/message_delta 用量，支持非阻塞首包", async () => {
    let releaseTail: (() => void) | undefined;
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const encoder = new TextEncoder();
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":80,"cache_read_input_tokens":32,"output_tokens":1}}}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"第一段"}}\n\n',
              ),
            );
            await tailGate;
            controller.enqueue(
              encoder.encode(
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":24}}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    try {
      const storage = createMemoryQuotaStorage();
      const quotaService = createQuotaService(storage);
      const now = 1_700_000_000_000;
      const proxy = createModelConnectionProxy(
        {
          provider: "anthropic",
          baseUrl: upstream.url.toString(),
          apiKey: "sk-ant-1",
        },
        ["claude-sonnet-4-5"],
        [],
        new AbortController().signal,
        {
          now: () => now,
          quota: {
            userId: "u-ant",
            isAdmin: false,
            checkAdmission: quotaService.checkAdmission,
            recordUsage: quotaService.recordUsage,
          },
        },
      );

      const response = await proxy(
        {
          model: "claude-sonnet-4-5",
          stream: true,
          messages: [{ role: "user", content: "你好" }],
        },
        new AbortController().signal,
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      // 验证非阻塞：尾段尚未发送前已可读出首个分片
      const firstChunk = await reader?.read();
      expect(firstChunk?.done).toBe(false);
      expect(new TextDecoder().decode(firstChunk?.value)).toContain(
        "message_start",
      );

      releaseTail?.();
      while (true) {
        const next = await reader?.read();
        if (!next || next.done) break;
      }

      const summary = await quotaService.getUserSummary("u-ant", false, now);
      expect(summary.usage.daily).toEqual({
        inputTokens: 80,
        outputTokens: 24,
        cacheReadTokens: 32,
        totalTokens: 104,
        requests: 1,
      });
    } finally {
      releaseTail?.();
      await upstream.stop(true);
    }
  });

  test("上游无 usage 时按 Math.ceil(chars/4) 回退估算，流取消时至多记一次请求", async () => {
    let releaseSecond: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const encoder = new TextEncoder();
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"123456789"}}]}\n\n',
              ),
            );
            await secondGate;
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    try {
      const storage = createMemoryQuotaStorage();
      const quotaService = createQuotaService(storage);
      const now = 1_700_000_000_000;
      const proxy = createModelConnectionProxy(
        {
          provider: "openai",
          baseUrl: `${upstream.url}v1`,
          apiKey: "sk-est",
        },
        ["gpt-4o"],
        [],
        new AbortController().signal,
        {
          now: () => now,
          estimatePromptChars: () => 17,
          quota: {
            userId: "u-cancel",
            isAdmin: false,
            checkAdmission: quotaService.checkAdmission,
            recordUsage: quotaService.recordUsage,
          },
        },
      );

      const response = await proxy(
        { model: "gpt-4o", stream: true, messages: [] },
        new AbortController().signal,
      );
      const reader = response.body?.getReader();
      await reader?.read();
      await reader?.cancel();
      await delay(10);

      const summary = await quotaService.getUserSummary("u-cancel", false, now);
      expect(summary.usage.daily.requests).toBe(1);
      expect(summary.usage.daily.inputTokens).toBe(Math.ceil(17 / 4));
      expect(summary.usage.daily.outputTokens).toBe(Math.ceil(9 / 4));
    } finally {
      releaseSecond?.();
      await upstream.stop(true);
    }
  });

  test("用户达到配额上限后 proxy 拒绝发往上游且 QuotaExceededError 不被 publicConversationError 误脱敏", async () => {
    let upstreamHits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        upstreamHits += 1;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    });

    try {
      const storage = createMemoryQuotaStorage();
      const quotaService = createQuotaService(storage);
      const now = Date.UTC(2026, 4, 15, 8, 30, 0);
      await quotaService.setQuota({
        userId: "u-limited",
        dailyTokenLimit: 100,
        dailyRequestLimit: 10,
        bypassAdmin: true,
        updatedBy: "admin",
      });
      await quotaService.recordUsage({
        userId: "u-limited",
        model: "gpt-4o",
        inputTokens: 80,
        outputTokens: 20,
        now,
      });

      const proxy = createModelConnectionProxy(
        {
          provider: "openai",
          baseUrl: `${upstream.url}v1`,
          apiKey: "sk-test",
        },
        ["gpt-4o"],
        [],
        new AbortController().signal,
        {
          now: () => now,
          quota: {
            userId: "u-limited",
            isAdmin: false,
            checkAdmission: quotaService.checkAdmission,
            recordUsage: quotaService.recordUsage,
          },
        },
      );

      const rejected = await proxy(
        { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      );
      expect(rejected.status).toBe(429);
      expect(upstreamHits).toBe(0);
      const body = (await rejected.json()) as {
        code?: string;
        error?: string;
        limitType?: string;
        used?: number;
        limit?: number;
      };
      expect(body.code).toBe("quota_exceeded");
      expect(body.limitType).toBe("daily_tokens");
      expect(body.used).toBe(100);
      expect(body.limit).toBe(100);
      expect(body.error).toContain("UTC 00:00 重置");

      const err = new QuotaExceededError({
        limitType: "daily_tokens",
        used: 100_000,
        limit: 100_000,
        resetAtUtc: "2026-05-16T00:00:00.000Z",
      });
      expect(publicConversationError(err)).toBe(err.message);
      expect(publicConversationError(err)).toContain("100,000 / 100,000");
      expect(publicConversationError(err)).toContain("UTC 00:00 重置");
    } finally {
      await upstream.stop(true);
    }
  });
});

describe("PlanModelProxy 配额与流式估算", () => {
  test("Plan 流量在超限时返回 429 简体中文 JSON 且不调用下游 Plan Harness", async () => {
    let harnessHits = 0;
    const harness = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        harnessHits += 1;
        return new Response("", { status: 200 });
      },
    });

    try {
      const storage = createMemoryQuotaStorage();
      const quotaService = createQuotaService(storage);
      await quotaService.setQuota({
        userId: "u-plan",
        dailyRequestLimit: 1,
        bypassAdmin: true,
        updatedBy: "admin",
      });
      const now = Date.UTC(2026, 4, 15, 1, 0, 0);
      await quotaService.recordUsage({
        userId: "u-plan",
        model: "claude",
        inputTokens: 10,
        outputTokens: 10,
        requests: 1,
        now,
      });

      const plan: PlanModelConfig = {
        provider: "claude",
        endpoint: new URL(`${harness.url}model`),
        token: "plan-token",
      };
      const proxy = createPlanModelProxy(
        plan,
        "bot-1",
        {
          threadId: "t-1",
          runId: "r-1",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
        },
        [],
        new AbortController().signal,
        {
          now: () => now,
          quota: {
            userId: "u-plan",
            isAdmin: false,
            checkAdmission: quotaService.checkAdmission,
            recordUsage: quotaService.recordUsage,
          },
        },
      );

      const rejected = await proxy(
        {
          model: "claude",
          messages: [{ role: "user", content: "plan" }],
          tools: [],
        },
        new AbortController().signal,
      );
      expect(rejected.status).toBe(429);
      expect(harnessHits).toBe(0);
      const data = (await rejected.json()) as { code?: string; error?: string };
      expect(data.code).toBe("quota_exceeded");
      expect(data.error).toContain("每日请求次数配额上限");
    } finally {
      await harness.stop(true);
    }
  });
});

describe("DSH 运行时 100% 强制代理（禁止向 DSH 下发真实密钥）", () => {
  test.each(["openai", "anthropic"] as const)(
    "%s 协议在 useApiKey=true 时也走 modelProxy，真实 apiKey 仅在服务端注入上游，绝不离开服务端",
    async (provider) => {
      const realSecret = `sk-ultra-secret-${provider}-never-leak`;
      const upstreamAuths: Array<{
        authorization: string | null;
        apiKey: string | null;
      }> = [];
      const gatewaySeenAuths: Array<{
        authorization: string | null;
        apiKey: string | null;
      }> = [];

      const target = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          upstreamAuths.push({
            authorization: request.headers.get("authorization"),
            apiKey: request.headers.get("x-api-key"),
          });
          const body = (await request.json()) as { model: string };
          const data =
            provider === "anthropic"
              ? [
                  {
                    type: "message_start",
                    message: {
                      id: "msg-1",
                      type: "message",
                      role: "assistant",
                      model: body.model,
                      content: [],
                      stop_reason: null,
                      usage: { input_tokens: 15, output_tokens: 0 },
                    },
                  },
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "proxy-verified" },
                  },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: 6 },
                  },
                  { type: "message_stop" },
                ]
                  .map(
                    (event) =>
                      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                  )
                  .join("")
              : `${[{ role: "assistant", content: "proxy-verified" }, {}]
                  .map(
                    (delta, index) =>
                      `data: ${JSON.stringify({ id: "reply-1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: index ? "stop" : null }], ...(index ? { usage: { prompt_tokens: 15, completion_tokens: 6 } } : {}) })}\n\n`,
                  )
                  .join("")}data: [DONE]\n\n`;
          return new Response(data, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });

      const gateway = createDshToolGateway({} as never);
      const gatewayServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          gatewaySeenAuths.push({
            authorization: request.headers.get("authorization"),
            apiKey: request.headers.get("x-api-key"),
          });
          return gateway.routes.fetch(request);
        },
      });

      const cwd = resolve(import.meta.dir, "../../runtime/dsh");
      const root = join(cwd, ".runtime");
      await mkdir(root, { recursive: true });
      const home = await mkdtemp(join(root, "w1a-proxy-"));
      await writeFile(
        join(home, "chisabot.json"),
        JSON.stringify({
          ownerUserId: "user-w1a",
          port: 0,
          providers: {},
          gatewayUrl: gatewayServer.url.toString(),
        }),
      );
      const host = spawn("node", ["src/start.mjs"], {
        cwd,
        windowsHide: true,
        env: { ...process.env, CHISABOT_DSH_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      host.stdout.on("data", (value) => {
        output += value;
      });
      host.stderr.on("data", (value) => {
        output += value;
      });

      try {
        for (
          let n = 0;
          n < 600 &&
          !output.includes("chisabot-runtime-ready") &&
          host.exitCode === null;
          n++
        ) {
          await delay(100);
        }
        expect(output).toContain("chisabot-runtime-ready");

        const encryptionKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
        const bindingStore = new Map<
          string,
          {
            bindingId: string;
            revision: number;
            ownerUserId: string;
            threadId: string;
            botId: string;
            runtimeId: string;
            sessionId: string;
          }
        >();
        const bindings: ConversationBindings = {
          async ensure() {},
          async get(threadId) {
            return bindingStore.get(threadId) ?? null;
          },
          async getOrCreate(input) {
            const existing = bindingStore.get(input.threadId);
            const revision = input.revision ?? 1;
            if (existing && existing.revision === revision) {
              return existing;
            }
            const next = {
              bindingId: `binding-${input.threadId}-${revision}`,
              revision,
              ownerUserId: input.ownerUserId,
              threadId: input.threadId,
              botId: input.botId,
              runtimeId: input.runtimeId,
              sessionId: existing?.sessionId ?? `session-${input.threadId}`,
            };
            bindingStore.set(input.threadId, next);
            return next;
          },
        };
        const storage = createMemoryQuotaStorage();
        const quotaService = createQuotaService(storage);
        const keyPool = createModelKeyPool();
        const agent = new DshRuntimeAgent({
          botId: "bot-1",
          binding: {
            toolGatewayUrl: gatewayServer.url.toString().replace(/\/$/, ""),
            readRun: (token) => readRunAssertion(token, encryptionKey),
            targetFor: async () => ({
              id: "target-1",
              ownerUserId: "user-w1a",
              connectionFile: join(home, "connection.json"),
            }),
            bindings,
            gateway,
          },
          signRun: (runInput) =>
            mintRunAssertion(
              {
                botId: "bot-1",
                actorId: "user-w1a",
                runId: runInput.runId,
                threadId: runInput.threadId,
              },
              encryptionKey,
            ),
          tools: [],
          prompt: () => "system",
          connection: {
            provider,
            baseUrl:
              provider === "openai" ? `${target.url}v1` : target.url.toString(),
            apiKey: realSecret,
            useApiKey: true,
            model: "proxy-test-model",
          },
          keyPool,
          quota: {
            checkAdmission: quotaService.checkAdmission,
            recordUsage: quotaService.recordUsage,
          },
          modelInfo: async () => ({
            maxOutputTokens: 1024,
            contextWindow: 16_384,
            supportsImages: false,
          }),
          fallbacks: async () => [],
        });

        await new Promise<void>((resolveRun, rejectRun) => {
          const subscription = agent
            .run({
              threadId: `thread-${provider}`,
              runId: `run-${provider}`,
              state: {},
              messages: [{ id: "m-1", role: "user", content: "hello" }],
              tools: [],
              context: [],
              forwardedProps: {},
            })
            .subscribe({
              error: rejectRun,
              complete: () => {
                subscription.unsubscribe();
                resolveRun();
              },
            });
        });

        // 1. DSH Host 发向工具网关的授权头必须是短期 capability，严禁包含真实 API Key
        expect(gatewaySeenAuths.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(gatewaySeenAuths)).not.toContain(realSecret);

        // 2. 模型服务端代理收到后才会注入真实 API Key 请求上游
        expect(upstreamAuths).toHaveLength(1);
        if (provider === "openai") {
          expect(upstreamAuths[0]?.authorization).toBe(`Bearer ${realSecret}`);
        } else {
          expect(upstreamAuths[0]?.apiKey).toBe(realSecret);
        }

        // 3. 用量已被全自动流式记账入账
        const summary = await quotaService.getUserSummary("user-w1a", false);
        expect(summary.usage.daily.requests).toBe(1);
        expect(summary.usage.daily.inputTokens).toBe(15);
        expect(summary.usage.daily.outputTokens).toBe(6);
      } finally {
        if (host.exitCode === null) {
          const stopped = once(host, "exit");
          host.kill();
          await stopped;
        }
        await rm(home, { recursive: true, force: true });
        await gatewayServer.stop(true);
        await target.stop(true);
      }
    },
    100_000,
  );
});

describe("QuotaService 仓储与负数防注入", () => {
  test("负数用量会被钳位为 0，日/月与分模型汇总严格准确", async () => {
    const storage = createMemoryQuotaStorage();
    const service = createQuotaService(storage);
    const day1 = Date.UTC(2026, 4, 15, 10, 0, 0);
    const day2 = Date.UTC(2026, 4, 16, 10, 0, 0);

    await service.recordUsage({
      userId: "u-1",
      model: "gpt-4o",
      inputTokens: -500,
      outputTokens: 25,
      cacheReadTokens: -10,
      requests: 1,
      now: day1,
    });
    await service.recordUsage({
      userId: "u-1",
      model: "claude-sonnet",
      inputTokens: 40,
      outputTokens: 60,
      cacheReadTokens: 15,
      requests: 2,
      now: day2,
    });

    const summaryDay2 = await service.getUserSummary("u-1", false, day2);
    expect(summaryDay2.usage.daily).toEqual({
      inputTokens: 40,
      outputTokens: 60,
      cacheReadTokens: 15,
      totalTokens: 100,
      requests: 2,
    });
    expect(summaryDay2.usage.monthly).toEqual({
      inputTokens: 40,
      outputTokens: 85,
      cacheReadTokens: 15,
      totalTokens: 125,
      requests: 3,
    });
    expect(summaryDay2.usage.byModel).toHaveLength(2);
  });
});

describe("Quota HTTP 路由与对话/无头回合门禁回归", () => {
  function createQuotaTestApp(
    actor: { id: string; email: string; name: string; role: "admin" | "user" },
    quotaService: ReturnType<typeof createQuotaService>,
    peopleList?: () => Promise<{
      people: Array<{
        id: string;
        email: string;
        name: string | null;
        image: null;
        role: "admin" | "user";
        providers: string[];
        lastSignedInAt: string | null;
        revoked: boolean;
        configuredAdmin: boolean;
      }>;
      nextCursor: null;
    }>,
  ) {
    const config = {
      ...loadConfig(testEnvironment()),
      singleUser: true,
    };
    const args: unknown[] = Array.from({ length: createApp.length });
    args[0] = config;
    if (peopleList) {
      args[17] = {
        list: peopleList,
      };
    }
    args[createApp.length] = {
      quotaService,
      singleUserGuard: async (
        context: { set: (key: "actor", value: typeof actor) => void },
        next: () => Promise<void>,
      ) => {
        context.set("actor", actor);
        await next();
      },
    };
    return createApp(...(args as Parameters<typeof createApp>));
  }

  test("/api/admin/quotas 与 /api/me/quota 权限校验、单用户兜底与扁平 DTO 投影准确", async () => {
    const storage = createMemoryQuotaStorage();
    const quotaService = createQuotaService(storage);
    await quotaService.recordUsage({
      userId: "user-alice",
      model: "gpt-4o",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      requests: 2,
    });

    const adminActor = {
      id: "admin-local",
      email: "admin@chisabot.test",
      name: "管理员",
      role: "admin" as const,
    };
    const userActor = {
      id: "user-alice",
      email: "alice@chisabot.test",
      name: "Alice",
      role: "user" as const,
    };

    const adminApp = createQuotaTestApp(adminActor, quotaService, async () => ({
      people: [
        {
          id: "user-alice",
          email: "alice@chisabot.test",
          name: "Alice",
          image: null,
          role: "user",
          providers: ["local"],
          lastSignedInAt: null,
          revoked: false,
          configuredAdmin: false,
        },
      ],
      nextCursor: null,
    }));

    const listRes = await adminApp.request("/api/admin/quotas");
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      quotas: Array<{
        userId: string;
        displayName?: string | null;
        role?: string | null;
        usage: {
          dailyInputTokens: number;
          dailyTotalTokens: number;
          monthlyTotalTokens: number;
          byModel: Array<{ model: string; dailyTokens: number }>;
        };
      }>;
    };
    // 同时包含已记账用户与单机管理员兜底行
    expect(listJson.quotas.some((row) => row.userId === "admin-local")).toBe(
      true,
    );
    const aliceRow = listJson.quotas.find((row) => row.userId === "user-alice");
    expect(aliceRow?.displayName).toBe("Alice");
    expect(aliceRow?.role).toBe("user");
    expect(aliceRow?.usage.dailyInputTokens).toBe(120);
    expect(aliceRow?.usage.dailyTotalTokens).toBe(150);
    expect(aliceRow?.usage.monthlyTotalTokens).toBe(150);
    expect(aliceRow?.usage.byModel).toEqual([
      {
        model: "gpt-4o",
        dailyTokens: 150,
        dailyRequests: 2,
        monthlyTokens: 150,
        monthlyRequests: 2,
      },
    ]);

    const invalidPut = await adminApp.request("/api/admin/quotas/user-alice", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dailyTokenLimit: -10,
        monthlyTokenLimit: null,
        dailyRequestLimit: null,
      }),
    });
    expect(invalidPut.status).toBe(400);

    const putRes = await adminApp.request("/api/admin/quotas/user-alice", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dailyTokenLimit: 1000,
        monthlyTokenLimit: 5000,
        dailyRequestLimit: 20,
        bypassAdmin: true,
      }),
    });
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as {
      quota: {
        dailyTokenLimit: number | null;
        monthlyTokenLimit: number | null;
      };
    };
    expect(putJson.quota.dailyTokenLimit).toBe(1000);
    expect(putJson.quota.monthlyTokenLimit).toBe(5000);

    const userApp = createQuotaTestApp(userActor, quotaService);
    const deniedRes = await userApp.request("/api/admin/quotas");
    expect(deniedRes.status).toBe(403);

    const deniedPut = await userApp.request("/api/admin/quotas/user-alice", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyTokenLimit: null }),
    });
    expect(deniedPut.status).toBe(403);

    const meRes = await userApp.request("/api/me/quota");
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as {
      summary: {
        userId: string;
        quota: { dailyTokenLimit: number | null } | null;
        usage: {
          dailyTotalTokens: number;
          dailyRequests: number;
          byModel: Array<{ model: string; dailyTokens: number }>;
        };
      };
    };
    expect(meJson.summary.userId).toBe("user-alice");
    expect(meJson.summary.quota?.dailyTokenLimit).toBe(1000);
    expect(meJson.summary.usage.dailyTotalTokens).toBe(150);
    expect(meJson.summary.usage.dailyRequests).toBe(2);
    expect(meJson.summary.usage.byModel[0]?.model).toBe("gpt-4o");
  });

  test("createConversationRoutes 与 createTurnRunner 在超限时第一时间拦截并返回 429 QuotaExceededError", async () => {
    const quotaService = createQuotaService(createMemoryQuotaStorage());
    await quotaService.setQuota({
      userId: "u-blocked",
      dailyTokenLimit: 100,
      monthlyTokenLimit: null,
      dailyRequestLimit: null,
      bypassAdmin: true,
      updatedBy: "admin",
    });
    await quotaService.recordUsage({
      userId: "u-blocked",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 0,
      requests: 1,
    });

    const routes = createConversationRoutes({
      backend: {} as never,
      resolver: {
        resolveAgentForActor: async () => {
          throw new Error("should not resolve agent after quota exceeded");
        },
        resolveAgentsForActor: async () => ({}),
      },
      identifyActor: async () => ({ id: "u-blocked", role: "user" }),
      checkQuota: ({ id, isAdmin }) => quotaService.checkAdmission(id, isAdmin),
    });

    const res = await routes.request("/api/conversations/thread-q1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "bot-1",
        input: {
          runId: "run-q1",
          messages: [{ id: "m-1", role: "user", content: "hello" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("quota_exceeded");
    expect(body.error).toContain("已达到每日 Token 配额上限");

    let touchedThread = false;
    const runTurn = createTurnRunner({
      conversations: {
        getOrCreateThread: async () => {
          touchedThread = true;
          return {};
        },
        getThreadMessages: async () => ({ messages: [] }),
      },
      runner: {} as never,
      buildAgentFor: async () => {
        throw new Error("should not build agent after quota exceeded");
      },
      checkQuota: (ownerUserId) =>
        quotaService.checkAdmission(ownerUserId, false),
    });

    await expect(
      runTurn({
        ownerUserId: "u-blocked",
        routineId: "routine-1",
        agentId: "bot-1",
        threadId: "thread-q2",
        instruction: "run",
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(touchedThread).toBe(false);
  });
});
