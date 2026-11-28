import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  MODEL_SCENARIOS,
  type ModelScenarioRoutingConfig,
  ScenarioRoutingValidationError,
  defaultScenarioRoute,
  defaultScenarioRoutingConfig,
  isModelScenario,
  resolveScenarioRoute,
  validateScenarioRoutingConfig,
} from "../../shared/model-scenario-routing";
import {
  createScenarioRoutingService,
  type ScenarioRoutingStore,
} from "../src/agents/model-scenario-routing";

function memoryStore(initial?: ModelScenarioRoutingConfig) {
  let config = initial ?? defaultScenarioRoutingConfig();
  let reads = 0;
  const store: ScenarioRoutingStore = {
    async read() {
      reads++;
      return config;
    },
    async write(next) {
      config = { ...next };
      return config;
    },
  };
  return { store, reads: () => reads, config: () => config };
}

describe("场景化模型路由契约", () => {
  test("场景键闭集：十一个场景全覆盖，未知键被拒", () => {
    expect(MODEL_SCENARIOS).toContain("chat");
    expect(MODEL_SCENARIOS).toContain("suggestions");
    expect(MODEL_SCENARIOS).toContain("completion");
    expect(MODEL_SCENARIOS).toContain("review");
    expect(isModelScenario("vision")).toBe(true);
    expect(isModelScenario("chal")).toBe(false);
    expect(() =>
      validateScenarioRoutingConfig({ scenarios: { chal: {} } }),
    ).toThrow(ScenarioRoutingValidationError);
  });

  test("空配置 = 全部继承，逐场景解析为默认值", () => {
    const config = defaultScenarioRoutingConfig();
    expect(config.scenarios).toEqual({});
    for (const scenario of MODEL_SCENARIOS) {
      expect(resolveScenarioRoute(config, scenario)).toEqual(
        defaultScenarioRoute(),
      );
    }
  });

  test("合法完整配置 roundtrip", () => {
    const input = {
      scenarios: {
        chat: {
          model: "deepseek/deepseek-chat",
          fallbacks: ["anthropic/claude-sonnet", "openai/gpt-5"],
          effort: "high",
          timeoutMs: 60_000,
          maxTokens: 8192,
          useAdaptive: false,
        },
        completion: {
          model: "openai/gpt-mini",
          effort: "none",
          timeoutMs: 3_000,
          maxTokens: 64,
        },
      },
    };
    const validated = validateScenarioRoutingConfig(input);
    expect(validated.scenarios.chat).toEqual({
      model: "deepseek/deepseek-chat",
      fallbacks: ["anthropic/claude-sonnet", "openai/gpt-5"],
      effort: "high",
      timeoutMs: 60_000,
      maxTokens: 8192,
      useAdaptive: false,
    });
    expect(validated.scenarios.completion?.useAdaptive).toBe(true);
    expect(validated.scenarios.completion?.fallbacks).toEqual([]);
    expect(validated.scenarios.completion?.maxTokens).toBe(64);
  });

  test("拒绝非法输入：缺省字段继承，错误字段 400", () => {
    expect(() => validateScenarioRoutingConfig(null)).toThrow();
    expect(() => validateScenarioRoutingConfig([])).toThrow();
    expect(() => validateScenarioRoutingConfig({ version: 2 })).toThrow();
    expect(() =>
      validateScenarioRoutingConfig({ scenarios: { chat: { model: "has space" } } }),
    ).toThrow();
    expect(() =>
      validateScenarioRoutingConfig({ scenarios: { chat: { effort: "ludicrous" } } }),
    ).toThrow();
    expect(() =>
      validateScenarioRoutingConfig({ scenarios: { chat: { timeoutMs: 500 } } }),
    ).toThrow();
    expect(() =>
      validateScenarioRoutingConfig({ scenarios: { chat: { timeoutMs: 60_001 * 10 } } }),
    ).toThrow();
    expect(() =>
      validateScenarioRoutingConfig({ scenarios: { chat: { maxTokens: 0 } } }),
    ).toThrow();
    expect(() =>
      validateScenarioRoutingConfig({ scenarios: { chat: { useAdaptive: "yes" } } }),
    ).toThrow();
    expect(() =>
      validateScenarioRoutingConfig({
        scenarios: {
          chat: { fallbacks: Array.from({ length: 9 }, (_, i) => `m/${i}`) },
        },
      }),
    ).toThrow();
  });

  test("备用链去重并剔除与主模型重复项，保持顺序", () => {
    const validated = validateScenarioRoutingConfig({
      scenarios: {
        review: {
          model: "a/x",
          fallbacks: ["a/x", "b/y", "b/y", " c/z "],
        },
      },
    });
    expect(validated.scenarios.review?.fallbacks).toEqual(["b/y", "c/z"]);
  });
});

describe("场景路由 service 缓存与 API", () => {
  test("config() 缓存 30 秒；save 立即刷新缓存", async () => {
    const memory = memoryStore();
    let t = 0;
    const service = createScenarioRoutingService({
      store: memory.store,
      now: () => t,
    });
    await service.config();
    await service.config();
    expect(memory.reads()).toBe(1);
    await service.save(
      { scenarios: { review: { model: "a/x", effort: "medium" } } },
      "admin",
    );
    const next = await service.config();
    expect(next.scenarios.review?.model).toBe("a/x");
    expect(memory.reads()).toBe(1);
    t += 31_000;
    await service.config();
    expect(memory.reads()).toBe(2);
  });

  function app(role: "admin" | "member", memory = memoryStore()) {
    const service = createScenarioRoutingService({ store: memory.store });
    const root = new Hono();
    root.route(
      "/api/admin/scenario-routing",
      service.routes(async (context, next) => {
        context.set("actor", { id: "u1", email: "u@x", role } as never);
        await next();
      }),
    );
    return { root, memory };
  }

  test("routes: admin 读取与保存；非法输入 400", async () => {
    const { root, memory } = app("admin");
    const initial = await root.request("/api/admin/scenario-routing");
    expect(initial.status).toBe(200);
    expect((await initial.json()).scenarios).toEqual({});

    const saved = await root.request("/api/admin/scenario-routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenarios: {
          title: { model: "openai/gpt-mini", effort: "low", maxTokens: 32 },
          vision: { model: "anthropic/claude-sonnet" },
        },
      }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.scenarios.title.maxTokens).toBe(32);
    expect(body.updatedBy).toBe("u1");
    expect(memory.config().scenarios.vision?.model).toBe(
      "anthropic/claude-sonnet",
    );

    const bad = await root.request("/api/admin/scenario-routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarios: { typo: { model: "a/x" } } }),
    });
    expect(bad.status).toBe(400);
    expect(memory.config().scenarios.vision?.model).toBe(
      "anthropic/claude-sonnet",
    );
  });

  test("routes: 非管理员被拒绝", async () => {
    const { root } = app("member");
    expect((await root.request("/api/admin/scenario-routing")).status).toBe(
      403,
    );
    const put = await root.request("/api/admin/scenario-routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarios: {} }),
    });
    expect(put.status).toBe(403);
  });
});
