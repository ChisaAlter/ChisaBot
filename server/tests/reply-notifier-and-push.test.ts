import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import {
  extractBarkEndpointFromCurl,
  type NotificationFrequency,
  type ReplyNotificationEvent,
  shouldNotifyReply,
} from "../../shared/notifications";
import type { AppVariables } from "../src/auth/guards";
import { createForegroundRegistry } from "../src/delivery/foreground-registry";
import {
  createPushService,
  type PushDeviceRecord,
  type PushDeviceStore,
  sealPushCredential,
  truncateUtf8Bytes,
  unsealPushCredential,
} from "../src/delivery/push-service";
import {
  createReplyNotifier,
  MAX_SEEN_MESSAGES_PER_BOT,
} from "../src/delivery/reply-notifier";

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function createMemoryPushStore(): {
  store: PushDeviceStore;
  rows: Map<string, PushDeviceRecord>;
} {
  const rows = new Map<string, PushDeviceRecord>();
  const store: PushDeviceStore = {
    async registerDevice(input) {
      const record: PushDeviceRecord = {
        ...input,
        enabled: true,
        createdAt: new Date("2026-11-19T08:00:00.000Z"),
      };
      rows.set(record.id, record);
      return record;
    },
    async devices(owner) {
      return [...rows.values()].filter(
        (item) => item.ownerUserId === owner && item.enabled,
      );
    },
    async device(id) {
      return rows.get(id) ?? null;
    },
    async removeDevice(owner, id) {
      const existing = rows.get(id);
      if (existing && existing.ownerUserId === owner) {
        rows.set(id, { ...existing, enabled: false });
      }
    },
  };
  return { store, rows };
}

function authGuard(
  userId: string | null,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!userId) return context.json({ error: "Sign in required." }, 401);
    context.set("actor", {
      id: userId,
      email: `${userId}@example.com`,
      role: "user",
    });
    await next();
  };
}

describe("shouldNotifyReply 策略矩阵", () => {
  test("muted 彻底静音，拦截所有类型", () => {
    expect(
      shouldNotifyReply({
        frequency: "muted",
        kind: "reply",
        channelForeground: false,
      }),
    ).toBe(false);
    expect(
      shouldNotifyReply({
        frequency: "muted",
        kind: "task-complete",
        channelForeground: false,
      }),
    ).toBe(false);
    expect(
      shouldNotifyReply({
        frequency: "muted",
        kind: "needs-input",
        channelForeground: false,
      }),
    ).toBe(false);
  });

  test("needs-input 审批/提问始终穿透 task-complete 与普通回复前台抑制", () => {
    expect(
      shouldNotifyReply({
        frequency: "task-complete",
        kind: "needs-input",
        channelForeground: false,
      }),
    ).toBe(true);
    expect(
      shouldNotifyReply({
        frequency: "task-complete",
        kind: "needs-input",
        channelForeground: true,
      }),
    ).toBe(true);
    expect(
      shouldNotifyReply({
        frequency: "every-reply",
        kind: "needs-input",
        channelForeground: true,
      }),
    ).toBe(true);
  });

  test("channelForeground === true 抑制当前频道普通回复与任务完成，但不影响非前台频道", () => {
    expect(
      shouldNotifyReply({
        frequency: "every-reply",
        kind: "reply",
        channelForeground: true,
      }),
    ).toBe(false);
    expect(
      shouldNotifyReply({
        frequency: "every-reply",
        kind: "task-complete",
        channelForeground: true,
      }),
    ).toBe(false);
    expect(
      shouldNotifyReply({
        frequency: "every-reply",
        kind: "reply",
        channelForeground: false,
      }),
    ).toBe(true);
    expect(
      shouldNotifyReply({
        frequency: "task-complete",
        kind: "reply",
        channelForeground: false,
      }),
    ).toBe(false);
    expect(
      shouldNotifyReply({
        frequency: "task-complete",
        kind: "task-complete",
        channelForeground: false,
      }),
    ).toBe(true);
  });
});

describe("foregroundRegistry 精确按 (userId, channelId) 追踪与双保险", () => {
  test("查看频道 A 只抑制 A，绝不误吞频道 B，且校验活连接与 60s TTL", () => {
    let now = 1_700_000_000_000;
    const registry = createForegroundRegistry({ now: () => now });

    // 未建立 SSE/WS 活连接前，即便发了心跳也必须返回 false（双保险）
    registry.heartbeat({
      userId: "alice",
      deviceId: "tab-1",
      channelId: "ch_a",
      active: true,
    });
    expect(registry.isChannelForeground("alice", "ch_a")).toBe(false);

    // 绑定活连接后，频道 A 在前台，频道 B 不在前台，且其他用户不受影响
    const detach = registry.trackConnection("alice", "tab-1");
    expect(registry.isChannelForeground("alice", "ch_a")).toBe(true);
    expect(registry.isChannelForeground("alice", "ch_b")).toBe(false);
    expect(registry.isChannelForeground("bob", "ch_a")).toBe(false);

    // 推进 59 秒仍在 TTL 内
    now += 59_000;
    expect(registry.isChannelForeground("alice", "ch_a")).toBe(true);

    // 超过 60 秒 TTL 自动失效
    now += 2_000;
    expect(registry.isChannelForeground("alice", "ch_a")).toBe(false);

    // 重新续期后恢复，但一旦活连接断开立刻返回 false
    registry.heartbeat({
      userId: "alice",
      deviceId: "tab-1",
      channelId: "ch_a",
      active: true,
    });
    expect(registry.isChannelForeground("alice", "ch_a")).toBe(true);
    detach();
    expect(registry.isChannelForeground("alice", "ch_a")).toBe(false);
  });

  test("前台心跳 Hono 路由正确鉴权、记录与清理", async () => {
    const registry = createForegroundRegistry();
    const detach = registry.trackConnection("alice", "dev-1");
    const app = new Hono().route(
      "/api/notifications/foreground",
      registry.routes(authGuard("alice")),
    );
    const anonApp = new Hono().route(
      "/api/notifications/foreground",
      registry.routes(authGuard(null)),
    );

    const unauth = await anonApp.request("/api/notifications/foreground");
    expect(unauth.status).toBe(401);

    const postRes = await app.request("/api/notifications/foreground", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "dev-1",
        channelId: "ch_1",
        active: true,
      }),
    });
    expect(postRes.status).toBe(200);
    expect(registry.isChannelForeground("alice", "ch_1")).toBe(true);
    expect(registry.isChannelForeground("alice", "ch_2")).toBe(false);

    const delRes = await app.request("/api/notifications/foreground/dev-1", {
      method: "DELETE",
    });
    expect(delRes.status).toBe(204);
    expect(registry.isChannelForeground("alice", "ch_1")).toBe(false);
    detach();
  });
});

describe("replyNotifier 启动基线防风暴、单 Bot 有界 256 去重与精准派发", () => {
  test("未 seedBaseline 前缓冲，seedBaseline 后忽略旧历史仅派发新消息，且看 A 不吞 B", async () => {
    const registry = createForegroundRegistry();
    const detach = registry.trackConnection("alice", "tab-a");
    registry.heartbeat({
      userId: "alice",
      deviceId: "tab-a",
      channelId: "ch_a",
      active: true,
    });

    const inAppEvents: ReplyNotificationEvent[] = [];
    const pushEvents: Array<{
      userId: string;
      deepLink: string;
      title: string;
    }> = [];
    let frequency: NotificationFrequency = "every-reply";

    const notifier = createReplyNotifier({
      foregroundRegistry: registry,
      getFrequency: async () => frequency,
      resolveAgentName: async (_u, agentId) =>
        agentId === "bot_a" ? "助理 A" : "助理 B",
      onInAppNotification: (_u, event) => {
        inAppEvents.push(event);
      },
      pushService: {
        sendToUser: async (userId, message) => {
          pushEvents.push({
            userId,
            deepLink: message.deepLink,
            title: message.title,
          });
          return [];
        },
      },
    });

    // 冷启动未 seed 前到达的事件先缓冲，不立刻发送
    const deferred = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_b",
      agentId: "bot_b",
      messageId: "msg_old_1",
      text: "历史消息不应重发",
      kind: "reply",
    });
    expect(deferred.verdict).toBe("deferred");
    expect(inAppEvents).toHaveLength(0);

    // 写入历史基线，同时触发回放：msg_old_1 命中基线被去重，零重发风暴！
    const replay = await notifier.seedBaseline([
      { userId: "alice", agentId: "bot_b", messageId: "msg_old_1" },
    ]);
    expect(replay[0]?.verdict).toBe("duplicate");
    expect(inAppEvents).toHaveLength(0);

    // 正在看频道 A：频道 A 普通回复被抑制
    const suppressedA = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_a",
      agentId: "bot_a",
      messageId: "msg_a_1",
      text: "A 的回复",
      kind: "reply",
    });
    expect(suppressedA.verdict).toBe("foreground-suppressed");
    expect(inAppEvents).toHaveLength(0);

    // 正在看频道 A：频道 B 的回复必须照常派发，并携带 chisabot://channel/ch_b 深链！
    const deliveredB = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_b",
      agentId: "bot_b",
      messageId: "msg_b_1",
      text: "B 完成了你的任务",
      kind: "reply",
    });
    expect(deliveredB.verdict).toBe("delivered");
    expect(inAppEvents).toHaveLength(1);
    expect(inAppEvents[0]?.deepLink).toBe(
      "chisabot://channel/ch_b?agent=bot_b",
    );
    expect(inAppEvents[0]?.agentName).toBe("助理 B");
    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0]?.deepLink).toBe("chisabot://channel/ch_b?agent=bot_b");

    // 同一 messageId 重试自动去重
    const dupB = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_b",
      agentId: "bot_b",
      messageId: "msg_b_1",
      text: "B 完成了你的任务",
      kind: "reply",
    });
    expect(dupB.verdict).toBe("duplicate");

    // 切到 task-complete：普通 reply 被过滤，但 needs-input 穿透！
    frequency = "task-complete";
    const filteredReply = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_b",
      agentId: "bot_b",
      messageId: "msg_b_2",
      text: "普通回复",
      kind: "reply",
    });
    expect(filteredReply.verdict).toBe("frequency-filtered");

    const approvalPenetrated = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_a",
      agentId: "bot_a",
      messageId: "req_1",
      text: "需要批准执行命令",
      kind: "needs-input",
    });
    expect(approvalPenetrated.verdict).toBe("delivered");
    expect(pushEvents[1]?.title).toBe("助理 A · 需要你处理");

    detach();
  });

  test("单 Bot 有界 256 条 seen 去重：超出上限淘汰最旧 ID", async () => {
    const registry = createForegroundRegistry();
    const notifier = createReplyNotifier({ foregroundRegistry: registry });
    await notifier.seedBaseline([]);

    for (let i = 0; i < MAX_SEEN_MESSAGES_PER_BOT; i += 1) {
      const res = await notifier.notifyReply({
        userId: "alice",
        channelId: "ch_x",
        agentId: "bot_x",
        messageId: `m_${i}`,
        text: `reply ${i}`,
        kind: "reply",
      });
      expect(res.verdict).toBe("delivered");
    }

    // 第 0 条仍在集合内 -> duplicate
    const stillDup = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_x",
      agentId: "bot_x",
      messageId: "m_0",
      text: "dup",
      kind: "reply",
    });
    expect(stillDup.verdict).toBe("duplicate");

    // 再写入 1 条新消息，挤掉最早的 m_0
    const next = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_x",
      agentId: "bot_x",
      messageId: "m_256",
      text: "new",
      kind: "reply",
    });
    expect(next.verdict).toBe("delivered");

    // 此时集合为 {m_1..m_256}：先校验 m_1 仍在集合中 -> duplicate
    const retained = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_x",
      agentId: "bot_x",
      messageId: "m_1",
      text: "still dup",
      kind: "reply",
    });
    expect(retained.verdict).toBe("duplicate");

    // m_0 已被淘汰 -> 可重新接受（重插后淘汰 m_1，集合变为 {m_2..m_256, m_0}）
    const evicted = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_x",
      agentId: "bot_x",
      messageId: "m_0",
      text: "re-accepted",
      kind: "reply",
    });
    expect(evicted.verdict).toBe("delivered");

    const retainedAfterReinsert = await notifier.notifyReply({
      userId: "alice",
      channelId: "ch_x",
      agentId: "bot_x",
      messageId: "m_2",
      text: "still dup after reinsert",
      kind: "reply",
    });
    expect(retainedAfterReinsert.verdict).toBe("duplicate");
  });
});

describe("Bark curl 解析、AES-256-GCM 凭据封存与移动推送服务", () => {
  test("extractBarkEndpointFromCurl 支持多种 Bark 复制格式并拒绝危险链接", () => {
    expect(
      extractBarkEndpointFromCurl(
        'curl "https://api.day.app/AbCdEfGh123456/推送标题/推送内容"',
      ),
    ).toEqual({
      serverUrl: "https://api.day.app",
      deviceKey: "AbCdEfGh123456",
    });

    expect(
      extractBarkEndpointFromCurl(
        `curl -X "POST" "https://bark.example.com/sub/push" -H 'Content-Type: application/json' -d '{"title":"hi","device_key":"MyDeviceKey_9988"}'`,
      ),
    ).toEqual({
      serverUrl: "https://bark.example.com/sub",
      deviceKey: "MyDeviceKey_9988",
    });

    expect(
      extractBarkEndpointFromCurl(
        "https://bark.example.com/push?device_key=QueryKey_12345678",
      ),
    ).toEqual({
      serverUrl: "https://bark.example.com",
      deviceKey: "QueryKey_12345678",
    });

    // 含内嵌凭据、片段或非法短 key 必须拒绝
    expect(
      extractBarkEndpointFromCurl("https://user:pass@api.day.app/AbCdEfGh1234"),
    ).toBeNull();
    expect(extractBarkEndpointFromCurl("https://api.day.app/short")).toBeNull();
    expect(extractBarkEndpointFromCurl("echo hello")).toBeNull();
  });

  test("AES-256-GCM 封存与 UTF-8 字节安全截断绝不产生乱码", () => {
    const secret = "super-secret-bark-device-key-2026";
    const sealed = sealPushCredential(TEST_ENCRYPTION_KEY, secret);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain(secret);
    expect(unsealPushCredential(TEST_ENCRYPTION_KEY, sealed)).toBe(secret);

    const mixed = "你好世界🚀🎉测试截断多字节字符不会坏";
    const truncated = truncateUtf8Bytes(mixed, 16);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(16);
    expect(truncated.includes("\uFFFD")).toBe(false);
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("pushService 加密落库、发送 Bark/FCM/APNs，并在 404/410/Unregistered 时自动清理失效设备", async () => {
    const { store, rows } = createMemoryPushStore();
    const calls: Array<{
      url: string;
      body: string;
      headers: Record<string, string>;
    }> = [];

    let nextResponse: () => Response = () =>
      new Response(JSON.stringify({ code: 200, message: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const mockFetch: typeof fetch = (async (input, init) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
      }
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        headers,
      });
      return nextResponse();
    }) as typeof fetch;

    const service = createPushService({
      store,
      encryptionKey: TEST_ENCRYPTION_KEY,
      fetchImpl: mockFetch,
    });

    // 1. 注册 Bark 设备：验证库中密文不含明文 Key
    const barkView = await service.registerDevice("alice", {
      provider: "bark",
      label: "主力 iPhone",
      barkCurl: 'curl "https://api.day.app/BarkSecretKey_9999/标题/正文"',
    });
    expect(barkView.provider).toBe("bark");
    expect(barkView.host).toBe("api.day.app");

    const storedBark = rows.get(barkView.id);
    expect(storedBark?.token.startsWith("enc:v1:")).toBe(true);
    expect(storedBark?.token).not.toContain("BarkSecretKey_9999");
    expect(storedBark?.projectId).not.toContain("BarkSecretKey_9999");

    // 2. 单设备测试推送成功
    const testOutcome = await service.sendTest("alice", barkView.id, {
      channelId: "ch_main",
      agentId: "bot_1",
    });
    expect(testOutcome?.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.day.app/push");
    const sentBarkBody = JSON.parse(calls[0]?.body ?? "{}") as Record<
      string,
      string
    >;
    expect(sentBarkBody.device_key).toBe("BarkSecretKey_9999");
    expect(sentBarkBody.url).toBe("chisabot://channel/ch_main?agent=bot_1");

    // 3. 注册 FCM 设备，模拟 FCM 返回 404 UNREGISTERED -> 自动清理失效设备
    const fcmView = await service.registerDevice("alice", {
      provider: "fcm",
      fcmProjectId: "chisa-demo",
      deviceToken: "fcm_token_abcdef1234567890",
      accessToken: "oauth_access_token_secret",
    });
    nextResponse = () =>
      new Response(
        JSON.stringify({
          error: {
            code: 404,
            status: "NOT_FOUND",
            details: [{ errorCode: "UNREGISTERED" }],
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );

    const fcmOutcome = await service.sendTest("alice", fcmView.id);
    expect(fcmOutcome?.ok).toBe(false);
    expect(fcmOutcome?.invalidTokenRemoved).toBe(true);
    expect(rows.get(fcmView.id)?.enabled).toBe(false);

    // 4. 注册 APNs 设备，模拟 APNs 返回 410 Unregistered -> 自动清理失效设备
    const apnsView = await service.registerDevice("alice", {
      provider: "apns",
      topic: "cn.ayase.chisabot",
      deviceToken: "a".repeat(64),
      environment: "production",
      bearerToken: "eyJhbGciOiJFUzI1NiJ9.payload.sig",
    });
    nextResponse = () =>
      new Response(JSON.stringify({ reason: "Unregistered" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      });

    const apnsOutcome = await service.sendTest("alice", apnsView.id);
    expect(apnsOutcome?.ok).toBe(false);
    expect(apnsOutcome?.invalidTokenRemoved).toBe(true);
    expect(rows.get(apnsView.id)?.enabled).toBe(false);

    // 5. Hono 路由跨用户隔离验证：bob 无法删除 alice 的 Bark 设备
    const bobApp = new Hono().route(
      "/api/push",
      service.routes(authGuard("bob")),
    );
    const crossDelete = await bobApp.request(
      `/api/push/devices/${barkView.id}`,
      {
        method: "DELETE",
      },
    );
    expect(crossDelete.status).toBe(404);
    expect(rows.get(barkView.id)?.enabled).toBe(true);
  });
});
