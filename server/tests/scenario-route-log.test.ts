import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  defaultScenarioRoutingConfig,
  type ModelScenarioRoutingConfig,
  resolveScenarioDryRun,
  scenarioRouteOverrides,
  validateScenarioRoutingConfig,
} from "../../shared/model-scenario-routing";
import {
  createScenarioRoutingService,
  type ScenarioRoutingStore,
} from "../src/agents/model-scenario-routing";
import {
  createMemoryScenarioRouteLogStorage,
  createPgScenarioRouteLogStorage,
} from "../src/agents/scenario-route-log";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

function configured(): ModelScenarioRoutingConfig {
  return validateScenarioRoutingConfig({
    scenarios: {
      chat: {
        model: "deepseek/deepseek-chat",
        fallbacks: ["openai/gpt-5"],
        effort: "high",
        useAdaptive: false,
      },
    },
  });
}

describe("resolveScenarioDryRun 纯函数", () => {
  const base = {
    baseModel: "openai/gpt-main",
    globalFallbacks: ["openai/gpt-backup"],
    adaptiveAvailable: true,
  };

  test("空配置：主模型与备用链全部继承，无覆盖字段", () => {
    const result = resolveScenarioDryRun({
      scenario: "chat",
      config: defaultScenarioRoutingConfig(),
      ...base,
    });
    expect(result.configured).toBe(false);
    expect(result.overrides).toEqual([]);
    expect(result.primary).toBe("openai/gpt-main");
    expect(result.chain).toEqual([
      "〈自适应选择〉",
      "openai/gpt-main",
      "openai/gpt-backup",
    ]);
    expect(result.adaptiveFirst).toBe(true);
    expect(result.skipAdaptive).toBe(false);
  });

  test("覆盖配置：场景主模型与备用链整体替代，useAdaptive=false 跳过自适应", () => {
    const result = resolveScenarioDryRun({
      scenario: "chat",
      config: configured(),
      ...base,
    });
    expect(result.configured).toBe(true);
    expect(result.overrides).toEqual(
      expect.arrayContaining(["model", "fallbacks", "effort", "useAdaptive"]),
    );
    expect(result.primary).toBe("deepseek/deepseek-chat");
    expect(result.chain).toEqual(["deepseek/deepseek-chat", "openai/gpt-5"]);
    expect(result.adaptiveFirst).toBe(false);
    expect(result.skipAdaptive).toBe(true);
    expect(result.effort).toBe("high");
  });

  test("useAdaptive 未关闭时自适应符号在链首", () => {
    const config = validateScenarioRoutingConfig({
      scenarios: { chat: { model: "a/x" } },
    });
    const result = resolveScenarioDryRun({ scenario: "chat", config, ...base });
    expect(result.chain[0]).toBe("〈自适应选择〉");
    expect(result.chain[1]).toBe("a/x");
  });

  test("未接线场景给出接线状态说明；test 场景刻意排除", () => {
    const unwired = resolveScenarioDryRun({
      scenario: "suggestions",
      config: defaultScenarioRoutingConfig(),
      ...base,
    });
    expect(unwired.wiring).toBe("unwired");
    expect(unwired.wiringNote).toContain("落地");
    const excluded = resolveScenarioDryRun({
      scenario: "test",
      config: defaultScenarioRoutingConfig(),
      ...base,
    });
    expect(excluded.wiring).toBe("excluded");
  });

  test("summarization 是链式语义：自适应符号按 chat 规则出现", () => {
    const result = resolveScenarioDryRun({
      scenario: "summarization",
      config: defaultScenarioRoutingConfig(),
      ...base,
    });
    expect(result.chain[0]).toBe("〈自适应选择〉");
    expect(result.wiring).toBe("wired-chain");
  });

  test("trace 逐条解释继承与覆盖", () => {
    const result = resolveScenarioDryRun({
      scenario: "chat",
      config: configured(),
      ...base,
    });
    expect(result.trace.join("\n")).toContain("场景配置覆盖");
    expect(result.trace.join("\n")).toContain("useAdaptive=false");
  });
});

describe("scenarioRouteOverrides", () => {
  test("全继承为空；逐字段识别", () => {
    const empty = resolveScenarioDryRun({
      scenario: "chat",
      config: defaultScenarioRoutingConfig(),
      baseModel: "m",
      globalFallbacks: [],
      adaptiveAvailable: false,
    });
    expect(empty.overrides).toEqual([]);
    const route = validateScenarioRoutingConfig({
      scenarios: { chat: { model: "a/x", maxTokens: 100 } },
    }).scenarios.chat!;
    expect(scenarioRouteOverrides(route)).toEqual(["model", "maxTokens"]);
  });
});

describe("内存决策日志存储", () => {
  test("append/list：按场景与消费方过滤，总数正确", async () => {
    const storage = createMemoryScenarioRouteLogStorage();
    await storage.append({
      scenario: "chat",
      consumer: "chat",
      configured: true,
      chain: ["a/x"],
      chosenModel: "a/x",
      outcome: "resolved",
    });
    await storage.append({
      scenario: "review",
      consumer: "review",
      configured: true,
      chain: ["b/y", "c/z"],
      chosenModel: "c/z",
      outcome: "fallback",
    });
    const all = await storage.list();
    expect(all.total).toBe(2);
    expect(all.items[0]!.scenario).toBe("review");
    const chatOnly = await storage.list({ scenario: "chat" });
    expect(chatOnly.total).toBe(1);
    const reviewOnly = await storage.list({ consumer: "review" });
    expect(reviewOnly.items[0]!.chosenModel).toBe("c/z");
  });

  test("pruneOlderThan 清理过期事件", async () => {
    let t = 1_000_000;
    const storage = createMemoryScenarioRouteLogStorage({ now: () => t });
    await storage.append({
      scenario: "chat",
      consumer: "chat",
      configured: true,
      chain: ["a"],
      chosenModel: "a",
      outcome: "resolved",
    });
    t += 31 * 86_400_000;
    await storage.append({
      scenario: "chat",
      consumer: "chat",
      configured: true,
      chain: ["b"],
      chosenModel: "b",
      outcome: "resolved",
    });
    const removed = await storage.pruneOlderThan(30, t);
    expect(removed).toBe(1);
    expect((await storage.list()).total).toBe(1);
  });
});

function memoryStore(initial?: ModelScenarioRoutingConfig) {
  let config = initial ?? defaultScenarioRoutingConfig();
  const store: ScenarioRoutingStore = {
    async read() {
      return config;
    },
    async write(next) {
      config = { ...next };
      return config;
    },
  };
  return { store, config: () => config };
}

function app(
  role: "admin" | "member",
  memory = memoryStore(),
  log = createMemoryScenarioRouteLogStorage(),
) {
  const service = createScenarioRoutingService({
    store: memory.store,
    log,
    dryRunContext: {
      baseModel: () => "openai/gpt-main",
      globalFallbacks: () => ["openai/gpt-backup"],
      adaptiveAvailable: () => true,
    },
  });
  const root = new Hono();
  root.route(
    "/api/admin/scenario-routing",
    service.routes(async (context, next) => {
      context.set("actor", { id: "u1", email: "u@x", role } as never);
      await next();
    }),
  );
  return { root, memory, log };
}

describe("dry-run 与 logs 端点", () => {
  test("dry-run：当前配置决议，事件落库为 dryRun", async () => {
    const { root, log } = app("admin", memoryStore(configured()));
    const response = await root.request("/api/admin/scenario-routing/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "chat" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.primary).toBe("deepseek/deepseek-chat");
    expect(body.chain).toEqual(["deepseek/deepseek-chat", "openai/gpt-5"]);
    expect(log.entries.length).toBe(1);
    expect(log.entries[0]!.dryRun).toBe(true);
    expect(log.entries[0]!.consumer).toBe("dry-run");
    expect(log.entries[0]!.chain).not.toContain("〈自适应选择〉");
  });

  test("dry-run：假设性配置不持久化", async () => {
    const memory = memoryStore();
    const { root } = app("admin", memory);
    const response = await root.request("/api/admin/scenario-routing/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: "chat",
        config: { scenarios: { chat: { model: "hypo/model" } } },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.primary).toBe("hypo/model");
    expect(memory.config().scenarios.chat).toBeUndefined();
  });

  test("dry-run：未知场景键 400；假设配置非法 400", async () => {
    const { root } = app("admin");
    const badScenario = await root.request(
      "/api/admin/scenario-routing/dry-run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "chal" }),
      },
    );
    expect(badScenario.status).toBe(400);
    const badConfig = await root.request(
      "/api/admin/scenario-routing/dry-run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scenario: "chat",
          config: { scenarios: { typo: {} } },
        }),
      },
    );
    expect(badConfig.status).toBe(400);
  });

  test("logs：过滤与限额；非管理员被拒绝", async () => {
    const { root, log } = app("admin");
    await log.append({
      scenario: "chat",
      consumer: "chat",
      configured: true,
      chain: ["a/x"],
      chosenModel: "a/x",
      outcome: "resolved",
    });
    const response = await root.request(
      "/api/admin/scenario-routing/logs?scenario=chat&limit=10",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0].chosenModel).toBe("a/x");

    const member = app("member");
    expect(
      (await member.root.request("/api/admin/scenario-routing/logs")).status,
    ).toBe(403);
    expect(
      (
        await member.root.request("/api/admin/scenario-routing/dry-run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenario: "chat" }),
        })
      ).status,
    ).toBe(403);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("PG 决策日志存储", () => {
  const database = url ? createDatabase(url, TEST_POOL) : null!;

  afterAll(async () => {
    await database?.$client.end().catch(() => {});
  });

  test("ensure 幂等；append/list/prune 全链路", async () => {
    const storage = createPgScenarioRouteLogStorage(database);
    await storage.ensure();
    await storage.ensure();
    const event = await storage.append({
      scenario: "vision",
      consumer: "vision",
      configured: true,
      chain: ["openai/gpt-vision"],
      chosenModel: "openai/gpt-vision",
      outcome: "resolved",
    });
    expect(event.id).toBeTruthy();
    const listed = await storage.list({ scenario: "vision" });
    expect(listed.items.some((item) => item.id === event.id)).toBe(true);
    expect(listed.items[0]!.chain).toEqual(["openai/gpt-vision"]);
    const removed = await storage.pruneOlderThan(0);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      (await storage.list({ scenario: "vision" })).items.some(
        (item) => item.id === event.id,
      ),
    ).toBe(false);
  });
});
