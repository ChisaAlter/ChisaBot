import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono, type MiddlewareHandler } from "hono";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../shared/user-preferences";
import { createPrimaryAgentService } from "../src/agents/primary-agent-service";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  type AgentChannel,
  type ChannelStore,
  createChannelRoutes,
} from "../src/channels/routes";
import type { Database } from "../src/db/client";
import { createPrimaryAgentRoutes } from "../src/settings/primary-agent-routes";
import {
  createUserPreferencesStore,
  type UserPreferencesStore,
} from "../src/user-preferences";
import { userPreferencesRoutes } from "../src/user-preferences-routes";

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "bot-a",
    name: "千咲",
    title: "全能私人助理",
    roleDescription: "负责日常对话调度",
    avatarSeed: "seed-a",
    visibility: "public",
    ownerUserId: "u1",
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    createdByAgentId: null,
    createdDepth: 0,
    ...overrides,
  };
}

function createMemoryFixture() {
  const prefsByUser = new Map<string, UserPreferences>();
  const profiles = new Map<string, AgentProfile>();
  const paused = new Set<string>();
  const auditEvents: AuditEventInput[] = [];
  const clearCalls: Array<{
    userId: string;
    expectedAgentId: string;
    cleared: boolean;
  }> = [];
  let defaultSeedCounter = 0;
  let defaultSeedEnabled = true;
  let ensureDefaultCalls = 0;

  let beforeClearCommit: (() => Promise<void>) | undefined;
  const userPreferences: UserPreferencesStore = {
    async read(userId) {
      return prefsByUser.get(userId) ?? { ...DEFAULT_USER_PREFERENCES };
    },
    async patch(userId, patch) {
      const next = {
        ...DEFAULT_USER_PREFERENCES,
        ...prefsByUser.get(userId),
        ...patch,
      };
      prefsByUser.set(userId, next);
      return next;
    },
    async clearMainBotIfMatches(userId, expectedAgentId) {
      if (beforeClearCommit) {
        await beforeClearCommit();
      }
      const current = prefsByUser.get(userId) ?? {
        ...DEFAULT_USER_PREFERENCES,
      };
      if (current.mainBotId !== expectedAgentId) {
        clearCalls.push({ userId, expectedAgentId, cleared: false });
        return false;
      }
      prefsByUser.set(userId, { ...current, mainBotId: null });
      clearCalls.push({ userId, expectedAgentId, cleared: true });
      return true;
    },
  };

  const canSee = (actor: AgentActor, profile: AgentProfile): boolean => {
    if (profile.deletedAt !== null) return false;
    if (profile.visibility === "public") return true;
    return profile.ownerUserId === actor.id || actor.role === "admin";
  };

  const agentProfileStore = {
    async get(actor: AgentActor, id: string): Promise<AgentProfile | null> {
      const found = profiles.get(id);
      if (!found || !canSee(actor, found)) return null;
      return found;
    },
    async list(
      actor: AgentActor,
      includeHidden = false,
    ): Promise<AgentProfile[]> {
      return [...profiles.values()].filter(
        (profile) =>
          canSee(actor, profile) && (includeHidden || !profile.hidden),
      );
    },
    async record(id: string): Promise<{ deleted: boolean } | null> {
      const found = profiles.get(id);
      if (!found) return null;
      return { deleted: found.deletedAt !== null };
    },
    async ensureDefaultBot(actor: AgentActor): Promise<boolean> {
      ensureDefaultCalls += 1;
      if (!defaultSeedEnabled) return false;
      const existingVisible = [...profiles.values()].filter(
        (profile) => canSee(actor, profile) && !profile.hidden,
      );
      if (existingVisible.length > 0) return false;
      defaultSeedCounter += 1;
      const seededId = `seeded-bot-${defaultSeedCounter}`;
      profiles.set(
        seededId,
        makeProfile({
          id: seededId,
          name: "助手",
          ownerUserId: actor.id,
          visibility: "private",
          systemOwned: true,
        }),
      );
      return true;
    },
  };

  const auditStore: AuditStore = {
    async insert(event) {
      auditEvents.push(event);
    },
  };

  const service = createPrimaryAgentService({
    userPreferences,
    agentProfileStore,
    isPaused: async (userId, agentId) => paused.has(`${userId}:${agentId}`),
  });

  const createdChannels: AgentChannel[] = [];
  const channelStore: ChannelStore = {
    async create(_actor, agentIds, _options) {
      const created: AgentChannel = {
        id: `chan-${createdChannels.length + 1}`,
        name: "测试对话",
        agentIds,
        threadId: `thread-${createdChannels.length + 1}`,
        active: true,
        lastMessageAt: null,
      };
      createdChannels.push(created);
      return created;
    },
    async direct(_actor, agentId) {
      return {
        id: `direct-${agentId}`,
        name: "直接对话",
        agentIds: [agentId],
        threadId: `thread-direct-${agentId}`,
        active: true,
        lastMessageAt: null,
      };
    },
    async get() {
      return null;
    },
    async list() {
      return { channels: [], nextCursor: null };
    },
    async setPinned() {},
    async markRead() {},
    async softDelete() {
      return true;
    },
  };

  const appFor = (userId: string | null, role: "admin" | "user" = "user") => {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      if (!userId) return context.json({ error: "Sign in" }, 401);
      context.set("actor", {
        id: userId,
        email: `${userId}@chisabot.test`,
        role,
      });
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/settings/primary-agent",
      createPrimaryAgentRoutes({
        requireUser,
        primaryAgentService: service,
        auditStore,
      }),
    );
    app.route(
      "/api/settings/preferences",
      userPreferencesRoutes(requireUser, userPreferences, {
        validateMainBot: (actor, agentId) =>
          service.validateCandidate(actor, agentId),
      }),
    );
    app.route(
      "/api/channels",
      createChannelRoutes(
        channelStore,
        requireUser,
        undefined,
        undefined,
        undefined,
        service,
      ),
    );
    return app;
  };

  return {
    prefsByUser,
    profiles,
    paused,
    auditEvents,
    clearCalls,
    createdChannels,
    service,
    setDefaultSeedEnabled: (enabled: boolean) => {
      defaultSeedEnabled = enabled;
    },
    setBeforeClearCommit: (hook: (() => Promise<void>) | undefined) => {
      beforeClearCommit = hook;
    },
    getEnsureDefaultCalls: () => ensureDefaultCalls,
    appFor,
  };
}

describe("primary agent backend suite (TC-S01 ~ TC-S13)", () => {
  test("[TC-S01] PUT 合法活跃 Agent 成功绑定主 Agent，写入审计日志，并拦截非法格式", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set("bot-a", makeProfile({ id: "bot-a", name: "千咲" }));

    const app = fx.appFor("u1");
    const res = await app.request("/api/settings/primary-agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "bot-a" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configuredAgentId).toBe("bot-a");
    expect(body.isPaused).toBe(false);
    expect(body.primaryAgent?.id).toBe("bot-a");
    expect(body.resolution).toEqual({
      status: "configured",
      fallbackUsed: false,
    });
    expect(fx.prefsByUser.get("u1")?.mainBotId).toBe("bot-a");
    expect(fx.auditEvents).toHaveLength(1);
    expect(fx.auditEvents[0]).toMatchObject({
      eventType: "configuration.changed",
      targetType: "user_preferences",
      targetId: "u1",
      actorUserId: "u1",
      payload: {
        change: "primary_agent_set",
        targetAgentId: "bot-a",
        previousAgentId: null,
      },
    });

    for (const badBody of [{ agentId: "" }, { agentId: "bad\nid" }, {}]) {
      const badRes = await app.request("/api/settings/primary-agent", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(badBody),
      });
      expect(badRes.status).toBe(400);
      expect(await badRes.json()).toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  test("[TC-S02] 未认证请求访问主 Agent 管理端点均返回 401", async () => {
    const fx = createMemoryFixture();
    const anon = fx.appFor(null);
    expect((await anon.request("/api/settings/primary-agent")).status).toBe(
      401,
    );
    expect(
      (
        await anon.request("/api/settings/primary-agent", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId: "bot-a" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await anon.request("/api/settings/primary-agent", {
          method: "DELETE",
        })
      ).status,
    ).toBe(401);
  });

  test("[TC-S03] 试图绑定他人的私有 Agent 返回 403 Forbidden", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set(
      "bot-other",
      makeProfile({
        id: "bot-other",
        visibility: "private",
        ownerUserId: "u2",
      }),
    );

    const res = await fx.appFor("u1").request("/api/settings/primary-agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "bot-other" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(fx.prefsByUser.get("u1")?.mainBotId).toBeUndefined();
  });

  test("[TC-S04 & TC-S05] 绑定不存在或已软删除的 Agent 返回 404 Not Found", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set(
      "bot-deleted",
      makeProfile({
        id: "bot-deleted",
        deletedAt: new Date("2026-11-01T00:00:00Z"),
      }),
    );
    const app = fx.appFor("u1");

    const missingRes = await app.request("/api/settings/primary-agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "no-such-agent" }),
    });
    expect(missingRes.status).toBe(404);
    expect(await missingRes.json()).toMatchObject({ code: "AGENT_NOT_FOUND" });

    const deletedRes = await app.request("/api/settings/primary-agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "bot-deleted" }),
    });
    expect(deletedRes.status).toBe(404);
    expect(await deletedRes.json()).toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  test("[TC-S06] 目标 Agent 处于 paused 状态时返回 409 AGENT_PAUSED", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set("bot-p", makeProfile({ id: "bot-p", name: "休眠助手" }));
    fx.paused.add("u1:bot-p");

    const res = await fx.appFor("u1").request("/api/settings/primary-agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "bot-p" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "AGENT_PAUSED",
      agentId: "bot-p",
    });
  });

  test("[TC-S07] DELETE 解绑主 Agent 置为 null 且不误触发 ensureDefaultBot 自动回写", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set("bot-a", makeProfile({ id: "bot-a" }));
    fx.prefsByUser.set("u1", {
      ...DEFAULT_USER_PREFERENCES,
      mainBotId: "bot-a",
    });
    // 移除所有可见 Agent，确认 DELETE 仍保持 mainBotId === null 且不调用 ensureDefaultBot
    fx.profiles.delete("bot-a");

    const res = await fx.appFor("u1").request("/api/settings/primary-agent", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configuredAgentId).toBeNull();
    expect(body.primaryAgent).toBeNull();
    expect(body.resolution).toEqual({
      status: "none",
      fallbackUsed: false,
      reason: "NOT_CONFIGURED",
    });
    expect(fx.prefsByUser.get("u1")?.mainBotId).toBeNull();
    expect(fx.getEnsureDefaultCalls()).toBe(0);
    expect(fx.auditEvents[0]?.payload).toMatchObject({
      change: "primary_agent_cleared",
      targetAgentId: null,
      previousAgentId: "bot-a",
    });
  });

  test("[TC-S08] 未配主 Agent 时降级到名册首位活跃 Agent，且 PATCH /api/settings/preferences 对非法 mainBotId 同等拦截 (BUG-2)", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set(
      "bot-paused",
      makeProfile({ id: "bot-paused", name: "已暂停" }),
    );
    fx.profiles.set(
      "bot-active",
      makeProfile({ id: "bot-active", name: "正常在线" }),
    );
    fx.profiles.set(
      "bot-secret",
      makeProfile({
        id: "bot-secret",
        visibility: "private",
        ownerUserId: "u2",
      }),
    );
    fx.paused.add("u1:bot-paused");

    const app = fx.appFor("u1");
    const getRes = await app.request("/api/settings/primary-agent");
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.configuredAgentId).toBeNull();
    expect(body.primaryAgent?.id).toBe("bot-active");
    expect(body.isPaused).toBe(false);
    expect(body.resolution).toEqual({
      status: "fallback_roster",
      fallbackUsed: true,
      reason: "NOT_CONFIGURED",
    });

    // BUG-2 防护：经旧偏好补丁端点传入无效/无权限/暂停的 mainBotId 也必须拦截
    const patchForbidden = await app.request("/api/settings/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mainBotId: "bot-secret" }),
    });
    expect(patchForbidden.status).toBe(403);

    const patchPaused = await app.request("/api/settings/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mainBotId: "bot-paused" }),
    });
    expect(patchPaused.status).toBe(409);

    const patchMissing = await app.request("/api/settings/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mainBotId: "missing-bot" }),
    });
    expect(patchMissing.status).toBe(404);
  });

  test("[TC-S09] 名册全空时 GET 自动触发 ensureDefaultBot 播种「助手」", async () => {
    const fx = createMemoryFixture();
    const res = await fx.appFor("u1").request("/api/settings/primary-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(fx.getEnsureDefaultCalls()).toBe(1);
    expect(body.primaryAgent?.name).toBe("助手");
    expect(body.resolution).toEqual({
      status: "fallback_seeded",
      fallbackUsed: true,
    });
  });

  test("[TC-S10] createUserPreferencesStore.clearMainBotIfMatches 生成带 CAS 条件 SQL，且软删除后顺畅降级", async () => {
    let capturedWhere: unknown;
    let capturedSet: unknown;
    const fakeDb = {
      update() {
        return {
          set(values: unknown) {
            capturedSet = values;
            return {
              where(condition: unknown) {
                capturedWhere = condition;
                return {
                  async returning() {
                    return [{ id: "u1" }];
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Database;

    const store = createUserPreferencesStore(fakeDb);
    const cleared = await store.clearMainBotIfMatches?.("u1", "bot-dead");
    expect(cleared).toBe(true);
    expect(capturedSet).toBeDefined();

    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      capturedWhere as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(compiled.sql).toContain("mainBotId");
    expect(compiled.params).toContain("u1");
    expect(compiled.params).toContain("bot-dead");

    // 软删后级联置空与降级表现
    const fx = createMemoryFixture();
    fx.profiles.set("bot-a", makeProfile({ id: "bot-a", name: "旧主" }));
    fx.profiles.set("bot-b", makeProfile({ id: "bot-b", name: "候补" }));
    fx.prefsByUser.set("u1", {
      ...DEFAULT_USER_PREFERENCES,
      mainBotId: "bot-a",
    });
    // 模拟 softDelete 事务将 bot-a 标记删除并清除 mainBotId
    fx.profiles.set(
      "bot-a",
      makeProfile({ id: "bot-a", deletedAt: new Date() }),
    );
    await fx.service.getStatus({ id: "u1", role: "user" });
    await Promise.resolve();
    const afterStatus = await fx
      .appFor("u1")
      .request("/api/settings/primary-agent");
    expect(afterStatus.status).toBe(200);
    expect((await afterStatus.json()).primaryAgent?.id).toBe("bot-b");
    expect(fx.prefsByUser.get("u1")?.mainBotId).toBeNull();
  });

  test("[TC-S11] 运行时 CAS 自愈保护：并发已换绑新主 Agent 时旧自愈任务绝不覆写", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set("bot-b", makeProfile({ id: "bot-b", name: "新主" }));
    fx.prefsByUser.set("u1", {
      ...DEFAULT_USER_PREFERENCES,
      mainBotId: "bot-dead",
    });

    let releaseClear!: () => void;
    const clearStarted = new Promise<void>((resolve) => {
      fx.setBeforeClearCommit(async () => {
        resolve();
        await new Promise<void>((done) => {
          releaseClear = done;
        });
      });
    });

    // 触发 getStatus -> scheduleSelfHealClear("u1", "bot-dead") 排队微任务并进入 DB 事务等待
    const status = await fx.service.getStatus({ id: "u1", role: "user" });
    expect(status.resolution).toEqual({
      status: "fallback_roster",
      fallbackUsed: true,
      reason: "DELETED_OR_MISSING",
    });
    await clearStarted;

    // 在旧自愈任务实际落库判断 CAS 前，并发请求已将用户主 Agent 切换到 bot-b
    await fx.service.setPrimaryAgent({ id: "u1", role: "user" }, "bot-b");
    releaseClear();

    // 冲刷所有微任务
    await Promise.resolve();
    await Promise.resolve();

    expect(fx.prefsByUser.get("u1")?.mainBotId).toBe("bot-b");
    expect(fx.clearCalls).toEqual([
      { userId: "u1", expectedAgentId: "bot-dead", cleared: false },
    ]);
  });

  test("[TC-S12] POST /api/channels 缺省解析主 Agent，遇暂停 409 拦截、无可用 422 拦截", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set("bot-a", makeProfile({ id: "bot-a", name: "千咲" }));
    fx.prefsByUser.set("u1", {
      ...DEFAULT_USER_PREFERENCES,
      mainBotId: "bot-a",
    });
    const app = fx.appFor("u1");

    // 1. 缺省 agentIds 自动绑定主 Agent
    const createOk = await app.request("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createOk.status).toBe(201);
    expect(fx.createdChannels[0]?.agentIds).toEqual(["bot-a"]);

    // 2. 主 Agent 暂停时强拦截返回 409 AGENT_PAUSED
    fx.paused.add("u1:bot-a");
    const createPaused = await app.request("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [] }),
    });
    expect(createPaused.status).toBe(409);
    expect(await createPaused.json()).toMatchObject({
      code: "AGENT_PAUSED",
      agentId: "bot-a",
    });

    // 3. 名册无任何可用 Agent 且无法播种时返回 422 NO_AVAILABLE_AGENT
    fx.profiles.clear();
    fx.setDefaultSeedEnabled(false);
    const createNone = await app.request("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [] }),
    });
    expect(createNone.status).toBe(422);
    expect(await createNone.json()).toMatchObject({
      code: "NO_AVAILABLE_AGENT",
    });
  });

  test("[TC-S13] 主 Agent 标记 hidden 时新会话回退到可见首位但 DB 保留配置，且 resolveForBackground 尊重主 Agent (BUG-1)", async () => {
    const fx = createMemoryFixture();
    fx.profiles.set(
      "bot-hidden",
      makeProfile({ id: "bot-hidden", name: "隐藏主", hidden: true }),
    );
    fx.profiles.set(
      "bot-visible",
      makeProfile({ id: "bot-visible", name: "可见候补" }),
    );
    fx.prefsByUser.set("u1", {
      ...DEFAULT_USER_PREFERENCES,
      mainBotId: "bot-hidden",
    });

    const app = fx.appFor("u1");
    const res = await app.request("/api/settings/primary-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.primaryAgent?.id).toBe("bot-visible");
    expect(body.configuredAgentId).toBe("bot-hidden");
    expect(body.resolution).toEqual({
      status: "fallback_roster",
      fallbackUsed: true,
      reason: "HIDDEN",
    });
    await Promise.resolve();
    await Promise.resolve();
    // 绝不清空或覆盖数据库中既有的 hidden mainBotId
    expect(fx.prefsByUser.get("u1")?.mainBotId).toBe("bot-hidden");
    expect(fx.clearCalls).toHaveLength(0);

    const createdFor = await fx.service.resolveForChannelCreation({
      id: "u1",
      role: "user",
    });
    expect(createdFor.id).toBe("bot-visible");
    expect(await fx.service.resolveForBackground("u1")).toBe("bot-visible");

    // 当设为正常可见主 Agent 时，resolveForBackground 优先命中主 Agent（修 BUG-1）
    await fx.service.setPrimaryAgent({ id: "u1", role: "user" }, "bot-visible");
    fx.profiles.set(
      "bot-second",
      makeProfile({ id: "bot-second", name: "第二候补" }),
    );
    expect(await fx.service.resolveForBackground("u1")).toBe("bot-visible");

    // 暂停主 Agent 时后台解析同样顺滑跳过，找下一个未暂停 Agent
    fx.paused.add("u1:bot-visible");
    expect(await fx.service.resolveForBackground("u1")).toBe("bot-second");
  });
});
