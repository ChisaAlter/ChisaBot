import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { Hono, type MiddlewareHandler } from "hono";
import {
  defaultSummaryThresholdFor,
  formatTokenShorthand,
  parseTokenShorthand,
  validateContextPolicy,
} from "../../shared/context-policy";
import {
  type ContextPolicyDatabase,
  type ContextPolicyRow,
  ContextPolicyValidationError,
  createContextPolicyStore,
} from "../src/agents/context-policy-store";
import {
  compactHistory,
  createMemoryHistorySummaryStore,
} from "../src/agents/history-budget";
import type { AppVariables } from "../src/auth/guards";
import { createModelCatalogService } from "../src/model-catalog";
import {
  SEARCH_GROUNDING_NOTE,
  SEARCH_TURN_ENOUGH,
} from "../src/web/search-grounding";
import {
  createWebSearchSettingsStore,
  parseSearchEndpointUrl,
  sameSearchOrigin,
  type WebSearchSettingsDatabase,
  type WebSearchSettingsRow,
  WebSearchSettingsValidationError,
} from "../src/web/search-settings";
import {
  createWebSearchRoutes,
  type SearchOutcome,
  webToolsForModel,
} from "../src/web/tools";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("base64");

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

function makeFakeWebSearchDb() {
  let row: WebSearchSettingsRow | null = null;
  let tableCreated = false;

  const database: WebSearchSettingsDatabase = {
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
        if (trimmed.startsWith("INSERT INTO chisabot_web_search_settings")) {
          const values = params ?? [];
          row = {
            id: "default",
            default_provider: String(values[0] ?? "builtin"),
            fallback_to_builtin: Boolean(values[1]),
            timeout_ms: Number(values[2] ?? 12_000),
            max_results: Number(values[3] ?? 6),
            providers_json: JSON.parse(String(values[4] ?? "{}")),
            model_overrides_json: JSON.parse(String(values[5] ?? "[]")),
            updated_at: new Date(),
            updated_by: (values[6] as string | null) ?? null,
          };
          return [];
        }
        throw new Error(`Unexpected SQL in web-search test: ${trimmed}`);
      }) as unknown as WebSearchSettingsDatabase["$client"]["unsafe"],
    },
  };

  return {
    database,
    getRow: () => row,
    isTableCreated: () => tableCreated,
  };
}

function makeFakeContextPolicyDb() {
  const rows = new Map<string, ContextPolicyRow>();
  let tableCreated = false;

  const database: ContextPolicyDatabase = {
    $client: {
      unsafe: (async (query: string, params?: unknown[]) => {
        const trimmed = query.trim();
        if (trimmed.startsWith("CREATE TABLE")) {
          tableCreated = true;
          return [];
        }
        if (trimmed.startsWith("SELECT")) {
          return [...rows.values()]
            .sort((a, b) => a.model_id.localeCompare(b.model_id))
            .map((r) => ({ ...r }));
        }
        if (
          trimmed.startsWith("INSERT INTO chisabot_model_context_overrides")
        ) {
          const values = params ?? [];
          const modelId = String(values[0] ?? "");
          const entry: ContextPolicyRow = {
            model_id: modelId,
            context_window_tokens: Number(values[1] ?? 0),
            summary_threshold_tokens: Number(values[2] ?? 0),
            updated_at: new Date(),
            updated_by: (values[3] as string | null) ?? null,
          };
          rows.set(modelId, entry);
          return [{ ...entry }];
        }
        if (
          trimmed.startsWith("DELETE FROM chisabot_model_context_overrides")
        ) {
          const modelId = String(params?.[0] ?? "");
          if (!rows.has(modelId)) return [];
          rows.delete(modelId);
          return [{ model_id: modelId }];
        }
        throw new Error(`Unexpected SQL in context-policy test: ${trimmed}`);
      }) as unknown as ContextPolicyDatabase["$client"]["unsafe"],
    },
  };

  return {
    database,
    isTableCreated: () => tableCreated,
    size: () => rows.size,
  };
}

describe("web-search 多供应商存储、AES 加密、跨源跨厂商隔离与在线试搜", () => {
  test("URL 校验与同源判定：拒绝 userinfo / query / hash / 非 http 协议", () => {
    expect(
      parseSearchEndpointUrl("https://api.tavily.com/search/", "Tavily"),
    ).toBe("https://api.tavily.com/search");
    expect(() =>
      parseSearchEndpointUrl("ftp://api.tavily.com/search", "Tavily"),
    ).toThrow(WebSearchSettingsValidationError);
    expect(() =>
      parseSearchEndpointUrl(
        "https://user:pass@api.tavily.com/search",
        "Tavily",
      ),
    ).toThrow(WebSearchSettingsValidationError);
    expect(() =>
      parseSearchEndpointUrl("https://api.tavily.com/search?q=1", "Tavily"),
    ).toThrow(WebSearchSettingsValidationError);
    expect(
      sameSearchOrigin(
        "https://search.example.com/v1/query",
        "https://search.example.com/v2/search",
      ),
    ).toBe(true);
    expect(
      sameSearchOrigin(
        "https://a.example.com/search",
        "https://b.example.com/search",
      ),
    ).toBe(false);
  });

  test("AES-256-GCM 密文落盘 + 跨厂商切换不串密钥 + 跨源改地址自动清空旧密钥", async () => {
    const fakeDb = makeFakeWebSearchDb();
    const store = createWebSearchSettingsStore(fakeDb.database, {
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    await store.ensure();
    expect(fakeDb.isTableCreated()).toBe(true);

    const tavilySecret = "tvly-super-secret-key-9876";
    const customSecret = "cust-origin-secret-4321";

    const saved = await store.save("admin-1", {
      defaultProvider: "tavily",
      fallbackToBuiltin: true,
      providers: {
        tavily: { apiKey: tavilySecret },
        custom: {
          baseUrl: "https://a.search.example/api",
          apiKey: customSecret,
        },
      },
      modelOverrides: [
        { modelId: "openai/gpt-4o", mode: "native" },
        { modelId: "deepseek-chat", mode: "provider", provider: "bocha" },
      ],
    });

    // 1. 密文落盘：数据库原始行绝不包含明文密钥
    const rawJson = JSON.stringify(fakeDb.getRow()?.providers_json);
    expect(rawJson).not.toContain(tavilySecret);
    expect(rawJson).not.toContain(customSecret);
    expect(saved.providers.tavily.keySource).toBe("saved");
    expect(saved.providers.tavily.keyHint).toBe("9876");
    expect(saved.providers.brave.keySource).toBe("none");

    // 2. 跨厂商隔离：切换到 brave 不继承 tavily 的密钥，也不破坏 tavily 槽位
    await store.save("admin-1", { defaultProvider: "brave" });
    const bravePlan = await store.resolveForModel("any-model");
    expect(bravePlan.mode).toBe("provider");
    if (bravePlan.mode === "provider") {
      expect(bravePlan.provider).toBe("brave");
      expect(bravePlan.apiKey).toBeUndefined();
    }

    // 3. 跨源改 custom 端点地址（未填新密钥）绝不把旧 origin 的密钥继承给新 origin
    const afterCrossOrigin = await store.save("admin-1", {
      defaultProvider: "custom",
      providers: {
        custom: {
          baseUrl: "https://evil.other.example/api",
        },
      },
    });
    expect(afterCrossOrigin.providers.custom.keySource).toBe("none");
    expect(afterCrossOrigin.providers.custom.keyHint).toBe("");
    const customPlan = await store.resolveForModel("any-model");
    expect(customPlan.mode).toBe("provider");
    if (customPlan.mode === "provider") {
      expect(customPlan.apiKey).toBeUndefined();
    }

    // 4. 同源修改路径时仍保留原密钥；试搜改到不同源绝不外泄已存密钥
    await store.save("admin-1", {
      defaultProvider: "custom",
      providers: {
        custom: {
          baseUrl: "https://trusted.example/v1/search",
          apiKey: customSecret,
        },
      },
    });
    const sameOriginSaved = await store.save("admin-1", {
      defaultProvider: "custom",
      providers: {
        custom: {
          baseUrl: "https://trusted.example/v2/search",
        },
      },
    });
    expect(sameOriginSaved.providers.custom.keySource).toBe("saved");

    let fetchCalled = false;
    let seenAuthHeader: string | null = null;
    await store.testSearch(
      {
        provider: "custom",
        baseUrl: "https://untrusted.example/search",
        query: "leak check",
      },
      {
        fetchImpl: (async (_input, init) => {
          fetchCalled = true;
          const headers = new Headers(init?.headers);
          seenAuthHeader = headers.get("authorization");
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      },
    );
    expect(fetchCalled).toBe(true);
    expect(seenAuthHeader).toBeNull();
  });

  test("多供应商适配器执行、失败回退内建源、native 模型覆写与接地防循环治理", async () => {
    const fakeDb = makeFakeWebSearchDb();
    const builtinHits: SearchOutcome = {
      hits: [
        {
          title: "Fallback Cafe",
          url: "https://fallback.example/cafe",
          snippet: "地址：静安区南京西路100号 人均 45 元",
        },
      ],
      sourceDown: false,
    };

    const store = createWebSearchSettingsStore(fakeDb.database, {
      encryptionKey: TEST_ENCRYPTION_KEY,
      builtinSearch: async () => builtinHits,
    });
    await store.ensure();
    await store.save("admin-1", {
      defaultProvider: "tavily",
      fallbackToBuiltin: true,
      providers: {
        tavily: { apiKey: "tvly-live-key-0001" },
        brave: { apiKey: "brave-live-key-0002" },
        serper: { apiKey: "serper-live-key-0003" },
        bocha: { apiKey: "bocha-live-key-0004" },
        exa: { apiKey: "exa-live-key-0005" },
      },
      modelOverrides: [
        { modelId: "gemini-2.5-pro", mode: "native" },
        { modelId: "deepseek-v3", mode: "provider", provider: "bocha" },
      ],
    });

    // 1. native 覆写模型关闭内置 web_search，仅保留 web_fetch
    const nativeTools = await webToolsForModel({
      settings: store,
      modelId: "google/gemini-2.5-pro",
    });
    expect(nativeTools.map((t) => t.name)).toEqual(["web_fetch"]);

    // 2. bocha 覆写模型走博查适配器，且完整保留接地提醒与每轮 2 次上限
    const calledUrls: string[] = [];
    const bochaFetch = (async (input: string | URL | Request) => {
      calledUrls.push(String(input));
      return new Response(
        JSON.stringify({
          data: {
            webPages: {
              value: [
                {
                  name: "博查命中咖啡店",
                  url: "https://bocha.example/coffee",
                  snippet: "地址：徐汇区安福路88号 人均 52 元",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const bochaTools = await webToolsForModel({
      settings: store,
      modelId: "deepseek-v3",
      executeDeps: { fetchImpl: bochaFetch },
    });
    const searchTool = bochaTools.find((t) => t.name === "web_search");
    expect(searchTool).toBeTruthy();

    const turnSignal = new AbortController().signal;
    const first = await searchTool!.execute(
      { query: "上海咖啡" },
      { signal: turnSignal },
    );
    expect(calledUrls[0]).toContain("api.bochaai.com");
    expect(first).toContain("博查命中咖啡店");
    expect(first).toContain("地址：徐汇区安福路88号");
    expect(first).toContain(SEARCH_GROUNDING_NOTE);

    // 同一轮第 2 次允许，第 3 次触发 SEARCH_TURN_ENOUGH 熔断
    await searchTool!.execute(
      { query: "上海咖啡 二次" },
      { signal: turnSignal },
    );
    const third = await searchTool!.execute(
      { query: "上海咖啡 三次" },
      { signal: turnSignal },
    );
    expect(third).toBe(SEARCH_TURN_ENOUGH);

    // 3. 外部源 HTTP 500 时优雅回退内建源
    const fallbackOutcome = await store.executeSearch("上海咖啡", {
      modelId: "other-model",
      fetchImpl: (async () =>
        new Response("upstream error", { status: 500 })) as typeof fetch,
    });
    expect(fallbackOutcome.usedFallback).toBe(true);
    expect(fallbackOutcome.provider).toBe("builtin");
    expect(fallbackOutcome.hits[0]?.title).toBe("Fallback Cafe");
  });

  test("管理员路由：鉴权拦截非管理员、写 Cache-Control: no-store 与在线试搜", async () => {
    const fakeDb = makeFakeWebSearchDb();
    const store = createWebSearchSettingsStore(fakeDb.database, {
      encryptionKey: TEST_ENCRYPTION_KEY,
      builtinSearch: async (query) => ({
        hits: [
          {
            title: `结果: ${query}`,
            url: "https://docs.example.com/guide",
            snippet: "文档摘要",
          },
        ],
        sourceDown: false,
      }),
    });
    await store.ensure();

    const userApp = new Hono();
    userApp.route(
      "/api/web-search",
      createWebSearchRoutes({
        store,
        requireUser: makeAuthMiddleware("user"),
      }),
    );
    const denied = await userApp.request("/api/web-search/settings");
    expect(denied.status).toBe(403);

    const adminApp = new Hono();
    adminApp.route(
      "/api/web-search",
      createWebSearchRoutes({
        store,
        requireUser: makeAuthMiddleware("admin"),
      }),
    );

    const getRes = await adminApp.request("/api/web-search/settings");
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("cache-control")).toBe("no-store");

    const putRes = await adminApp.request("/api/web-search/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        defaultProvider: "builtin",
        fallbackToBuiltin: true,
      }),
    });
    expect(putRes.status).toBe(200);

    const testRes = await adminApp.request("/api/web-search/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "ChisaBot", provider: "builtin" }),
    });
    expect(testRes.status).toBe(200);
    expect(testRes.headers.get("cache-control")).toBe("no-store");
    const testBody = (await testRes.json()) as {
      ok: boolean;
      hits: { title: string }[];
    };
    expect(testBody.ok).toBe(true);
    expect(testBody.hits[0]?.title).toContain("ChisaBot");
  });
});

describe("context-policy 简写解析、阈值校验、管理员接口与运行时接入", () => {
  test("parseTokenShorthand 与 validateContextPolicy 边界校验", () => {
    expect(parseTokenShorthand("1M")).toBe(1_000_000);
    expect(parseTokenShorthand("400K")).toBe(400_000);
    expect(parseTokenShorthand("128000")).toBe(128_000);
    expect(parseTokenShorthand("128,000")).toBe(128_000);
    expect(parseTokenShorthand("1.5m")).toBe(1_500_000);
    expect(parseTokenShorthand("0")).toBeNull();
    expect(parseTokenShorthand("-400K")).toBeNull();
    expect(parseTokenShorthand("invalid")).toBeNull();
    expect(formatTokenShorthand(1_000_000)).toBe("1M");
    expect(formatTokenShorthand(400_000)).toBe("400K");

    const ok = validateContextPolicy({
      contextWindowTokens: 1_000_000,
      summaryThresholdTokens: 400_000,
    });
    expect(ok).toEqual({
      ok: true,
      value: {
        contextWindowTokens: 1_000_000,
        summaryThresholdTokens: 400_000,
      },
    });

    const autoDefault = validateContextPolicy({ contextWindowTokens: 200_000 });
    expect(autoDefault).toEqual({
      ok: true,
      value: {
        contextWindowTokens: 200_000,
        summaryThresholdTokens: defaultSummaryThresholdFor(200_000),
      },
    });

    // 摘要阈值 >= 上下文容量必须拒绝
    expect(
      validateContextPolicy({
        contextWindowTokens: 128_000,
        summaryThresholdTokens: 128_000,
      }).ok,
    ).toBe(false);
    expect(
      validateContextPolicy({
        contextWindowTokens: 128_000,
        summaryThresholdTokens: 150_000,
      }).ok,
    ).toBe(false);
    // 低于安全下限拒绝
    expect(
      validateContextPolicy({
        contextWindowTokens: 2_000,
        summaryThresholdTokens: 1_000,
      }).ok,
    ).toBe(false);
    // 余量不足拒绝
    expect(
      validateContextPolicy({
        contextWindowTokens: 8_192,
        summaryThresholdTokens: 8_000,
      }).ok,
    ).toBe(false);
  });

  test("context-policy-store CRUD、管理员 API 与 model-catalog / history-budget 生效", async () => {
    const fakeDb = makeFakeContextPolicyDb();
    const store = createContextPolicyStore(fakeDb.database);
    await store.ensure();
    expect(fakeDb.isTableCreated()).toBe(true);

    // 支持字符串简写保存
    const saved = await store.upsert("admin-1", {
      modelId: "openai/gpt-4.1",
      contextWindowTokens: "1M",
      summaryThresholdTokens: "400K",
    });
    expect(saved.contextWindowTokens).toBe(1_000_000);
    expect(saved.summaryThresholdTokens).toBe(400_000);

    // 完整 ID 与末段均可命中
    expect((await store.get("openai/gpt-4.1"))?.contextWindowTokens).toBe(
      1_000_000,
    );
    expect((await store.get("gpt-4.1"))?.summaryThresholdTokens).toBe(400_000);

    await expect(
      store.upsert("admin-1", {
        modelId: "bad-model",
        contextWindowTokens: "100K",
        summaryThresholdTokens: "120K",
      }),
    ).rejects.toThrow(ContextPolicyValidationError);

    // model-catalog 叠加覆写，优先生效
    const catalog = createModelCatalogService({
      resolveConnection: async () => ({
        provider: "openai",
        baseUrl: "https://gateway.example/v1",
        model: "openai/gpt-4.1",
        useApiKey: true,
        apiKey: "sk-test",
        source: "saved",
      }),
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "openai/gpt-4.1", context_length: 128_000 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      resolveContextOverrides: () => store.list(),
    });
    const listed = await catalog.list();
    expect(listed.models[0]?.contextWindow).toBe(1_000_000);
    expect(listed.models[0]?.summaryThresholdTokens).toBe(400_000);

    // history-budget 尊重显式 summaryThresholdTokens（更早触发摘要刷新任务）
    const history: Message[] = Array.from({ length: 12 }, (_, idx) => ({
      id: `m-${idx}`,
      role: idx % 2 === 0 ? "user" : "assistant",
      content: "测试长对话内容".repeat(120),
    })) as Message[];
    const summaryStore = createMemoryHistorySummaryStore();
    const withDefaultRatio = await compactHistory({
      threadId: "t-1",
      runId: "r-default",
      history,
      overheadTokens: 0,
      contextWindow: 100_000,
      store: summaryStore,
      summarize: async () => ({ summary: "摘要", model: "m" }),
    });
    expect(withDefaultRatio.refresh).toBeNull();

    const withLowOverride = await compactHistory({
      threadId: "t-1",
      runId: "r-override",
      history,
      overheadTokens: 0,
      contextWindow: 100_000,
      summaryThresholdTokens: 5_000,
      store: summaryStore,
      summarize: async () => ({ summary: "摘要", model: "m" }),
    });
    expect(withLowOverride.refresh).not.toBeNull();

    // 管理员 API 路由（含斜杠 modelId 通过 query 删除）
    const app = new Hono();
    app.route(
      "/api/admin/context-policies",
      store.routes(makeAuthMiddleware("admin")),
    );
    const getRes = await app.request("/api/admin/context-policies");
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("cache-control")).toBe("no-store");

    const delRes = await app.request(
      `/api/admin/context-policies?modelId=${encodeURIComponent("openai/gpt-4.1")}`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);
    expect(fakeDb.size()).toBe(0);
  });
});
