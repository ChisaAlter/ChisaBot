import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import type { AgentChannel } from "../src/channels/routes";
import { createQuickIntents } from "../src/delivery/quick-intents";

function makeProfile(
  overrides: Partial<AgentProfile> & { id: string; name: string },
): AgentProfile {
  return {
    title: "助手",
    roleDescription: "负责协助日常任务",
    avatarSeed: overrides.id,
    visibility: "private",
    ownerUserId: "alice",
    systemOwned: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    pinnedAt: null,
    assignedToMe: false,
    deletedAt: null,
    createdByAgentId: null,
    createdDepth: 0,
    endpoint: null,
    hasAuth: false,
    ...overrides,
  };
}

function authGuard(
  actor: AgentActor | null,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!actor) return context.json({ error: "Sign in required." }, 401);
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.com`,
      role: actor.role,
    });
    await next();
  };
}

function fixture(options?: { directDelayMs?: number }) {
  const profiles: AgentProfile[] = [
    makeProfile({ id: "bot_regular", name: "普通助手", ownerUserId: "alice" }),
    makeProfile({
      id: "bot_pinned_old",
      name: "置顶一",
      ownerUserId: "alice",
      pinned: true,
      pinnedAt: "2026-11-18T10:00:00.000Z",
    }),
    makeProfile({
      id: "bot_main",
      name: "主力助手",
      ownerUserId: "alice",
    }),
    makeProfile({
      id: "bot_pinned_new",
      name: "置顶二",
      ownerUserId: "alice",
      pinned: true,
      pinnedAt: "2026-11-19T08:00:00.000Z",
    }),
    makeProfile({
      id: "bot_bob_private",
      name: "Bob 私有机器人",
      ownerUserId: "bob",
      visibility: "private",
    }),
  ];

  const channels = new Map<string, AgentChannel>();
  channels.set("ch_alice_main", {
    id: "ch_alice_main",
    name: "主力助手",
    agentIds: ["bot_main"],
    threadId: "thread_alice_main",
    active: true,
    lastMessageAt: null,
  });

  const dispatched: Array<{
    userId: string;
    agentId: string;
    channelId: string;
    text: string;
    clientNonce: string;
  }> = [];

  let turnBehavior: (text: string) => Promise<{ replyText?: string }> = async (
    text,
  ) => ({
    replyText: `已处理：${text}`,
  });

  const canAccess = (actor: AgentActor, profile: AgentProfile) =>
    actor.role === "admin" ||
    profile.visibility === "public" ||
    profile.ownerUserId === actor.id;

  const service = createQuickIntents({
    agentProfileStore: {
      async list(actor) {
        return profiles.filter((p) => canAccess(actor, p));
      },
      async get(actor, id) {
        return profiles.find((p) => p.id === id && canAccess(actor, p)) ?? null;
      },
    },
    channelStore: {
      async direct(actor, agentId) {
        if (options?.directDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.directDelayMs),
          );
        }
        const id = `ch_${actor.id}_${agentId}`;
        const existing = channels.get(id);
        if (existing) return existing;
        const created: AgentChannel = {
          id,
          name: agentId,
          agentIds: [agentId],
          threadId: `thread_${actor.id}_${agentId}`,
          active: true,
          lastMessageAt: null,
        };
        channels.set(id, created);
        return created;
      },
      async get(actor, channelId) {
        const found = channels.get(channelId);
        if (!found) return null;
        if (channelId.startsWith(`ch_${actor.id}_`)) return found;
        return null;
      },
    },
    getMainBotId: async (userId) => (userId === "alice" ? "bot_main" : null),
    dispatchTurn: async (input) => {
      dispatched.push({
        userId: input.actor.id,
        agentId: input.agent.id,
        channelId: input.channelId,
        text: input.text,
        clientNonce: input.clientNonce,
      });
      return turnBehavior(input.text);
    },
  });

  function appFor(actor: AgentActor | null) {
    return new Hono().route("/api/intents", service.routes(authGuard(actor)));
  }

  return {
    appFor,
    dispatched,
    setTurnBehavior: (fn: typeof turnBehavior) => {
      turnBehavior = fn;
    },
  };
}

describe("quick-intents 无界面快捷指令入口", () => {
  test("GET /api/intents/agents 返回当前用户可见 Bot 且主 Bot 与置顶优先", async () => {
    const { appFor } = fixture();
    const anon = await appFor(null).request("/api/intents/agents");
    expect(anon.status).toBe(401);

    const res = await appFor({ id: "alice", role: "user" }).request(
      "/api/intents/agents",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{
        id: string;
        main: boolean;
        pinned: boolean;
        deepLink: string;
      }>;
    };
    expect(body.agents.map((a) => a.id)).toEqual([
      "bot_main",
      "bot_pinned_new",
      "bot_pinned_old",
      "bot_regular",
    ]);
    expect(body.agents[0]?.main).toBe(true);
    expect(body.agents[0]?.deepLink).toBe("chisabot://agent/bot_main");
    // 不包含 bob 的私有机器人
    expect(body.agents.some((a) => a.id === "bot_bob_private")).toBe(false);
  });

  test("POST /api/intents/send 基于 clientNonce 做幂等去重、冲突拒绝与状态回查", async () => {
    const { appFor, dispatched } = fixture();
    const aliceApp = appFor({ id: "alice", role: "user" });
    const bobApp = appFor({ id: "bob", role: "user" });

    // 1. 首次发送返回 ACCEPTED
    const first = await aliceApp.request("/api/intents/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "bot_main",
        text: "帮我总结今天的日程",
        clientNonce: "shortcut-nonce-001",
      }),
    });
    expect(first.status).toBe(202);
    const firstJson = (await first.json()) as {
      status: string;
      channelId: string;
      messageId: string;
      deepLink: string;
    };
    expect(firstJson.status).toBe("ACCEPTED");
    expect(firstJson.channelId).toBe("ch_alice_bot_main");
    expect(firstJson.deepLink).toBe(
      "chisabot://channel/ch_alice_bot_main?agent=bot_main",
    );

    // 等待异步回合完成
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched).toHaveLength(1);

    // 2. 相同 clientNonce + 相同内容重试返回 DUPLICATE，不重复触发回合
    const duplicate = await aliceApp.request("/api/intents/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "bot_main",
        text: "帮我总结今天的日程",
        clientNonce: "shortcut-nonce-001",
      }),
    });
    expect(duplicate.status).toBe(200);
    const dupJson = (await duplicate.json()) as {
      status: string;
      messageId: string;
      replySummary: string | null;
    };
    expect(dupJson.status).toBe("DUPLICATE");
    expect(dupJson.messageId).toBe(firstJson.messageId);
    expect(dupJson.replySummary).toBe("已处理：帮我总结今天的日程");
    expect(dispatched).toHaveLength(1);

    // 3. 相同 clientNonce + 不同内容返回 409 REJECTED (NONCE_CONFLICT)
    const conflict = await aliceApp.request("/api/intents/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "bot_main",
        text: "换了一段不同的内容",
        clientNonce: "shortcut-nonce-001",
      }),
    });
    expect(conflict.status).toBe(409);
    const conflictJson = (await conflict.json()) as {
      status: string;
      code: string;
    };
    expect(conflictJson.status).toBe("REJECTED");
    expect(conflictJson.code).toBe("NONCE_CONFLICT");

    // 4. GET /status/:nonce 查到执行状态与最新回复摘要；跨用户查询严格 404
    const statusRes = await aliceApp.request(
      "/api/intents/status/shortcut-nonce-001",
    );
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as {
      status: string;
      replySummary: string | null;
      channelId: string;
    };
    expect(statusJson.status).toBe("completed");
    expect(statusJson.replySummary).toBe("已处理：帮我总结今天的日程");
    expect(statusJson.channelId).toBe("ch_alice_bot_main");

    const crossStatus = await bobApp.request(
      "/api/intents/status/shortcut-nonce-001",
    );
    expect(crossStatus.status).toBe(404);
  });

  test("越权访问他人私有 Bot 或无权 channelId 一律拒发且不触发回合", async () => {
    const { appFor, dispatched } = fixture();
    const aliceApp = appFor({ id: "alice", role: "user" });

    // 越权发送给 bob 的私有机器人
    const forbiddenBot = await aliceApp.request("/api/intents/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "bot_bob_private",
        text: "你好",
        clientNonce: "nonce-forbid-1",
      }),
    });
    expect(forbiddenBot.status).toBe(403);
    const forbiddenBody = (await forbiddenBot.json()) as {
      status: string;
      code: string;
    };
    expect(forbiddenBody.status).toBe("REJECTED");
    expect(forbiddenBody.code).toBe("BOT_NOT_ACCESSIBLE");

    // 越权指定不存在或不匹配的 channelId
    const forbiddenChannel = await aliceApp.request("/api/intents/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "bot_regular",
        channelId: "ch_alice_main",
        text: "你好",
        clientNonce: "nonce-forbid-2",
      }),
    });
    expect(forbiddenChannel.status).toBe(403);
    expect(dispatched).toHaveLength(0);
  });

  test("后台回合失败时状态回查清晰返回 failed 与错误说明", async () => {
    const { appFor, setTurnBehavior } = fixture();
    setTurnBehavior(async () => {
      throw new Error("模型配额不足");
    });
    const aliceApp = appFor({ id: "alice", role: "user" });

    const accepted = await aliceApp.request("/api/intents/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "bot_main",
        text: "触发失败分支",
        clientNonce: "nonce-fail-1",
      }),
    });
    expect(accepted.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const status = await aliceApp.request("/api/intents/status/nonce-fail-1");
    expect(status.status).toBe(200);
    const json = (await status.json()) as {
      status: string;
      error: string | null;
    };
    expect(json.status).toBe("failed");
    expect(json.error).toContain("模型配额不足");
  });

  test("并发相同 clientNonce 请求跨越 await channelStore.direct 仍严格只派发 1 次", async () => {
    const { appFor, dispatched } = fixture({ directDelayMs: 25 });
    const aliceApp = appFor({ id: "alice", role: "user" });
    const reqInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "bot_main",
        text: "并发幂等发送测试",
        clientNonce: "concurrent-nonce-1",
      }),
    };

    const [first, second] = await Promise.all([
      aliceApp.request("/api/intents/send", reqInit),
      aliceApp.request("/api/intents/send", reqInit),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 202]);

    const bodies = (await Promise.all([first.json(), second.json()])) as Array<{
      status: string;
      messageId: string;
    }>;
    expect(bodies.map((b) => b.status).sort()).toEqual([
      "ACCEPTED",
      "DUPLICATE",
    ]);
    expect(bodies[0]?.messageId).toBe(bodies[1]?.messageId);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(dispatched).toHaveLength(1);
  });
});
