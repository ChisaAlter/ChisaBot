import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { forgetDeletedBot } from "@/lib/agents/mutations";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { useMainBot, usePrimaryAgent } from "@/lib/settings/message-list";
import { setPrimaryAgentMutationOptions } from "@/lib/settings/mutations";
import {
  installPrimaryAgentSync,
  PRIMARY_AGENT_SYNC_CHANNEL,
  type PrimaryAgentResponse,
  primaryAgentKeys,
  primaryAgentQueryOptions,
  settingsKeys,
} from "@/lib/settings/queries";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../shared/user-preferences";
import { settleReactWork } from "./settle-react-work";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function installFetch(
  handler: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
): void {
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(rawUrl, "http://localhost");
      return (
        (await handler(url.pathname, init)) ??
        new NativeResponse(null, { status: 404 })
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}

function makeAgent(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    title: `${name}助手`,
    roleDescription: "日常协助",
    avatarSeed: id,
    visibility: "public",
    builtIn: true,
    mine: true,
    canManage: true,
    canDelete: true,
    systemOwned: false,
    hidden: false,
    pinned: false,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

test("[TC-F01 & TC-F05] primaryAgentQueryOptions 经 client 解包保留完整 envelope 响应结构 (BUG-6)", async () => {
  const seen: string[] = [];
  const botB = makeAgent("bot-b", "候补");
  const expected: PrimaryAgentResponse = {
    configuredAgentId: "bot-hidden",
    isPaused: false,
    primaryAgent: botB,
    resolution: {
      status: "fallback_roster",
      fallbackUsed: true,
      reason: "HIDDEN",
    },
  };

  installFetch((path) => {
    seen.push(path);
    if (path === "/api/settings/primary-agent") {
      return NativeResponse.json(expected);
    }
    return undefined;
  });

  const qc = makeClient();
  const data = await qc.fetchQuery(primaryAgentQueryOptions("u1"));
  expect(seen).toEqual(["/api/settings/primary-agent"]);
  expect(data).toEqual(expected);
  expect(data.configuredAgentId).toBe("bot-hidden");
  expect(data.resolution).toEqual({
    status: "fallback_roster",
    fallbackUsed: true,
    reason: "HIDDEN",
  });

  // 缺损信封拦截
  installFetch((path) => {
    if (path === "/api/settings/primary-agent") {
      return NativeResponse.json({ invalid: true });
    }
    return undefined;
  });
  const qcBad = makeClient();
  await expect(
    qcBad.fetchQuery(primaryAgentQueryOptions("u1")),
  ).rejects.toThrow("无法加载主 Agent 设置");
});

test("[TC-F02] setPrimaryAgentMutationOptions 在请求挂起期间同步执行双缓存乐观更新", async () => {
  const qc = makeClient();
  const botA = makeAgent("bot-a", "千咲");
  const botB = makeAgent("bot-b", "代码官");

  qc.setQueryData<UserPreferences>(settingsKeys.preferences("u1"), {
    ...DEFAULT_USER_PREFERENCES,
    mainBotId: "bot-a",
  });
  qc.setQueryData<PrimaryAgentResponse>(primaryAgentKeys.current("u1"), {
    configuredAgentId: "bot-a",
    isPaused: false,
    primaryAgent: botA,
    resolution: { status: "configured", fallbackUsed: false },
  });
  qc.setQueryData(agentKeys.list(false), [botA, botB]);

  let releasePut!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });

  const requests: Array<{ method: string; body: unknown }> = [];
  installFetch(async (path, init) => {
    if (path === "/api/settings/primary-agent" && init?.method === "PUT") {
      const parsedBody =
        typeof init.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method: "PUT", body: parsedBody });
      startedResolve();
      await new Promise<void>((resolve) => {
        releasePut = resolve;
      });
      return NativeResponse.json({
        configuredAgentId: "bot-b",
        isPaused: false,
        primaryAgent: botB,
        resolution: { status: "configured", fallbackUsed: false },
      } satisfies PrimaryAgentResponse);
    }
    return NativeResponse.json({});
  });

  const mutation = qc
    .getMutationCache()
    .build(qc, setPrimaryAgentMutationOptions(qc, "u1"));
  const execPromise = mutation.execute("bot-b");
  await started;

  // 网络尚未返回，settingsKeys 与 primaryAgentKeys 都已经进入乐观态
  expect(
    qc.getQueryData<UserPreferences>(settingsKeys.preferences("u1"))?.mainBotId,
  ).toBe("bot-b");
  const optimisticPrimary = qc.getQueryData<PrimaryAgentResponse>(
    primaryAgentKeys.current("u1"),
  );
  expect(optimisticPrimary?.configuredAgentId).toBe("bot-b");
  expect(optimisticPrimary?.primaryAgent?.id).toBe("bot-b");
  expect(optimisticPrimary?.resolution.status).toBe("configured");

  releasePut();
  await execPromise;
  expect(requests).toEqual([{ method: "PUT", body: { agentId: "bot-b" } }]);
});

test("[TC-F03] 服务端 500 失败时同时精确回滚 settingsKeys 与 primaryAgentKeys 快照", async () => {
  const qcWithSnapshot = makeClient();
  const botA = makeAgent("bot-a", "千咲");

  const initialPref: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    mainBotId: "bot-a",
  };
  const initialPrimary: PrimaryAgentResponse = {
    configuredAgentId: "bot-a",
    isPaused: false,
    primaryAgent: botA,
    resolution: { status: "configured", fallbackUsed: false },
  };
  qcWithSnapshot.setQueryData(settingsKeys.preferences("u1"), initialPref);
  qcWithSnapshot.setQueryData(primaryAgentKeys.current("u1"), initialPrimary);

  installFetch((path, init) => {
    if (path === "/api/settings/primary-agent" && init?.method === "PUT") {
      return NativeResponse.json({ error: "服务器异常" }, { status: 500 });
    }
    return NativeResponse.json({});
  });

  const m1 = qcWithSnapshot
    .getMutationCache()
    .build(
      qcWithSnapshot,
      setPrimaryAgentMutationOptions(qcWithSnapshot, "u1"),
    );
  await expect(m1.execute("bot-b")).rejects.toThrow("服务器异常");

  expect(
    qcWithSnapshot.getQueryData<UserPreferences>(
      settingsKeys.preferences("u1"),
    ),
  ).toEqual(initialPref);
  expect(
    qcWithSnapshot.getQueryData<PrimaryAgentResponse>(
      primaryAgentKeys.current("u1"),
    ),
  ).toEqual(initialPrimary);

  // 若请求前两套缓存均为空，失败后应精确移除临时写入的乐观条目而非残余对象
  const qcEmpty = makeClient();
  const m2 = qcEmpty
    .getMutationCache()
    .build(qcEmpty, setPrimaryAgentMutationOptions(qcEmpty, "u1"));
  await expect(m2.execute("bot-b")).rejects.toThrow("服务器异常");
  expect(qcEmpty.getQueryData(settingsKeys.preferences("u1"))).toBeUndefined();
  expect(qcEmpty.getQueryData(primaryAgentKeys.current("u1"))).toBeUndefined();
});

test("[TC-F04] onSettled 级联失效三组缓存且 forgetDeletedBot 同步清理主 Agent 缓存 (BUG-4)", async () => {
  const qc = makeClient();
  const botA = makeAgent("bot-a", "千咲");
  qc.setQueryData(settingsKeys.preferences("u1"), {
    ...DEFAULT_USER_PREFERENCES,
    mainBotId: "bot-a",
  });
  qc.setQueryData(primaryAgentKeys.current("u1"), {
    configuredAgentId: "bot-a",
    isPaused: false,
    primaryAgent: botA,
    resolution: { status: "configured", fallbackUsed: false },
  } satisfies PrimaryAgentResponse);

  const spy = spyOn(qc, "invalidateQueries");
  installFetch((path, init) => {
    if (path === "/api/settings/primary-agent" && init?.method === "DELETE") {
      return NativeResponse.json({
        configuredAgentId: null,
        isPaused: false,
        primaryAgent: null,
        resolution: {
          status: "none",
          fallbackUsed: false,
          reason: "NOT_CONFIGURED",
        },
      } satisfies PrimaryAgentResponse);
    }
    return NativeResponse.json({});
  });

  const m = qc
    .getMutationCache()
    .build(qc, setPrimaryAgentMutationOptions(qc, "u1"));
  await m.execute(null);

  const invalidatedKeys = spy.mock.calls.map((call) =>
    JSON.stringify(call[0]?.queryKey),
  );
  expect(invalidatedKeys).toContain(JSON.stringify(settingsKeys.all));
  expect(invalidatedKeys).toContain(JSON.stringify(primaryAgentKeys.all));
  expect(invalidatedKeys).toContain(JSON.stringify(agentKeys.all));

  // 测试删除 Bot 后 forgetDeletedBot (BUG-4)
  spy.mockClear();
  qc.setQueryData(settingsKeys.preferences("u1"), {
    ...DEFAULT_USER_PREFERENCES,
    mainBotId: "bot-a",
  });
  qc.setQueryData(primaryAgentKeys.current("u1"), {
    configuredAgentId: "bot-a",
    isPaused: false,
    primaryAgent: botA,
    resolution: { status: "configured", fallbackUsed: false },
  } satisfies PrimaryAgentResponse);

  await forgetDeletedBot(qc, "bot-a");
  expect(qc.getQueryState(settingsKeys.preferences("u1"))?.isInvalidated).toBe(
    true,
  );
  expect(qc.getQueryState(primaryAgentKeys.current("u1"))?.isInvalidated).toBe(
    true,
  );
  spy.mockRestore();
});

test("[TC-F06] useMainBot 与 usePrimaryAgent 保持接口兼容并与独立主 Agent 缓存一致", async () => {
  const qc = makeClient();
  const botA = makeAgent("bot-a", "千咲");
  const botB = makeAgent("bot-b", "助手B");
  let currentMain = "bot-a";

  installFetch((path, init) => {
    if (path === "/api/me") {
      return NativeResponse.json({
        user: { id: "u1", email: "u1@chisabot.test", name: "测试" },
      });
    }
    if (path === "/api/settings/preferences") {
      return NativeResponse.json({
        preferences: { ...DEFAULT_USER_PREFERENCES, mainBotId: currentMain },
      });
    }
    if (path === "/api/settings/primary-agent" && init?.method !== "PUT") {
      return NativeResponse.json({
        configuredAgentId: currentMain,
        isPaused: false,
        primaryAgent: currentMain === "bot-a" ? botA : botB,
        resolution: { status: "configured", fallbackUsed: false },
      } satisfies PrimaryAgentResponse);
    }
    if (path === "/api/settings/primary-agent" && init?.method === "PUT") {
      currentMain = "bot-b";
      return NativeResponse.json({
        configuredAgentId: "bot-b",
        isPaused: false,
        primaryAgent: botB,
        resolution: { status: "configured", fallbackUsed: false },
      } satisfies PrimaryAgentResponse);
    }
    return undefined;
  });

  qc.setQueryData(authKeys.currentUser(), {
    id: "u1",
    email: "u1@chisabot.test",
    name: "测试",
  });
  qc.setQueryData(agentKeys.list(false), [botA, botB]);

  let latestMainHook: ReturnType<typeof useMainBot> | null = null;
  let latestPrimaryHook: ReturnType<typeof usePrimaryAgent> | null = null;

  function Probe() {
    latestMainHook = useMainBot();
    latestPrimaryHook = usePrimaryAgent();
    return createElement(
      "div",
      { "data-testid": "probe" },
      `${latestMainHook.mainBotId ?? "none"}|${latestPrimaryHook.configuredAgentId ?? "none"}`,
    );
  }

  const view = render(
    createElement(QueryClientProvider, { client: qc }, createElement(Probe)),
  );

  await waitFor(() => {
    expect(view.getByTestId("probe").textContent).toBe("bot-a|bot-a");
  });
  expect(latestMainHook).not.toBeNull();
  expect(latestMainHook!.settled).toBe(true);
  expect(typeof latestMainHook!.setMainBot).toBe("function");
  expect(typeof latestMainHook!.setMainBotAsync).toBe("function");
  expect(latestPrimaryHook!.resolution?.status).toBe("configured");

  await act(async () => {
    await latestMainHook!.setMainBotAsync("bot-b");
  });

  await waitFor(() => {
    expect(view.getByTestId("probe").textContent).toBe("bot-b|bot-b");
  });
});

test("[TC-F07] BroadcastChannel 跨标签变更广播可触发关联缓存失效并在销毁后解绑", async () => {
  const qc = makeClient();
  const botA = makeAgent("bot-a", "千咲");
  qc.setQueryData(settingsKeys.preferences("u1"), {
    ...DEFAULT_USER_PREFERENCES,
    mainBotId: "bot-a",
  });
  qc.setQueryData(primaryAgentKeys.current("u1"), {
    configuredAgentId: "bot-a",
    isPaused: false,
    primaryAgent: botA,
    resolution: { status: "configured", fallbackUsed: false },
  } satisfies PrimaryAgentResponse);

  const stopSync = installPrimaryAgentSync(qc);
  const remoteTab = new BroadcastChannel(PRIMARY_AGENT_SYNC_CHANNEL);
  remoteTab.postMessage({
    type: "primary-agent-changed",
    userId: "u1",
    mainBotId: "bot-b",
    senderTabId: "external-tab-99",
  });

  await waitFor(() => {
    expect(
      qc.getQueryState(primaryAgentKeys.current("u1"))?.isInvalidated,
    ).toBe(true);
    expect(
      qc.getQueryState(settingsKeys.preferences("u1"))?.isInvalidated,
    ).toBe(true);
  });

  stopSync();

  // 销毁后重新置回未失效态，再广播不应再触发失效
  qc.setQueryData(settingsKeys.preferences("u1"), {
    ...DEFAULT_USER_PREFERENCES,
    mainBotId: "bot-b",
  });
  remoteTab.postMessage({
    type: "primary-agent-changed",
    userId: "u1",
    mainBotId: "bot-c",
    senderTabId: "external-tab-99",
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(qc.getQueryState(settingsKeys.preferences("u1"))?.isInvalidated).toBe(
    false,
  );

  remoteTab.close();
});
