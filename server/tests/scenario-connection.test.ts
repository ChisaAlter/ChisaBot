import { describe, expect, test } from "bun:test";
import {
  createScenarioCompleter,
  scenarioConnectionResolver,
} from "../src/agents/scenario-connection";
import type { ModelScenarioRoutingConfig } from "../../shared/model-scenario-routing";
import type { RuntimeModelConnection } from "../src/conversation-runtime";

const connection = (model: string): RuntimeModelConnection => ({
  model: { provider: "openai", defaultModel: model },
  apiKey: "key-1",
});

const routing = (config: Partial<ModelScenarioRoutingConfig>["scenarios"]) => ({
  config: async () => ({ version: 1 as const, scenarios: config ?? {} }),
});

describe("场景化连接解析包装", () => {
  test("空配置返回原连接快照（逐字段一致）", async () => {
    const base = connection("deploy-model");
    const resolve = scenarioConnectionResolver("review", async () => base, routing({}));
    const result = await resolve();
    expect(result).toBe(base);
  });

  test("场景主模型非空时只覆盖 defaultModel，其余字段保留", async () => {
    const base = connection("deploy-model");
    const resolve = scenarioConnectionResolver(
      "review",
      async () => base,
      routing({ review: { ...routeShape, model: "review-cheap" } }),
    );
    const result = await resolve();
    expect(result.model.defaultModel).toBe("review-cheap");
    expect(result.model.provider).toBe("openai");
    expect(result.apiKey).toBe("key-1");
    expect(base.model.defaultModel).toBe("deploy-model");
  });

  test("路由读取失败时静默沿用原连接", async () => {
    const base = connection("deploy-model");
    const resolve = scenarioConnectionResolver("title", async () => base, {
      config: async () => {
        throw new Error("db down");
      },
    });
    expect(await resolve()).toBe(base);
  });
});

const routeShape = {
  model: "",
  fallbacks: [],
  effort: "default" as const,
  timeoutMs: null,
  maxTokens: null,
  useAdaptive: true,
};

describe("场景化 completer 链", () => {
  const completerFor =
    (
      behavior: Record<string, "ok" | "fail">,
      calls: string[],
    ) =>
    (resolveConnection: () => Promise<RuntimeModelConnection>) =>
    async (_prompt: string) => {
      const conn = await resolveConnection();
      const model = conn.model.defaultModel;
      calls.push(model);
      if (behavior[model] === "fail") throw new Error(`${model} down`);
      return `answer-from-${model}`;
    };

  test("场景未配置时直接用基础连接，不产生链", async () => {
    const calls: string[] = [];
    const complete = createScenarioCompleter({
      scenario: "review",
      routing: routing({}),
      baseConnection: async () => connection("deploy-model"),
      completerFor: completerFor({ "deploy-model": "ok" }, calls),
    });
    expect(await complete("p")).toBe("answer-from-deploy-model");
    expect(calls).toEqual(["deploy-model"]);
  });

  test("主模型成功时只调一次", async () => {
    const calls: string[] = [];
    const complete = createScenarioCompleter({
      scenario: "review",
      routing: routing({
        review: { ...routeShape, model: "r1", fallbacks: ["r2"] },
      }),
      baseConnection: async () => connection("deploy-model"),
      completerFor: completerFor({ r1: "ok" }, calls),
    });
    expect(await complete("p")).toBe("answer-from-r1");
    expect(calls).toEqual(["r1"]);
  });

  test("主模型失败按备用链切换", async () => {
    const calls: string[] = [];
    const complete = createScenarioCompleter({
      scenario: "review",
      routing: routing({
        review: { ...routeShape, model: "r1", fallbacks: ["r2", "r3"] },
      }),
      baseConnection: async () => connection("deploy-model"),
      completerFor: completerFor({ r1: "fail", r2: "fail", r3: "ok" }, calls),
    });
    expect(await complete("p")).toBe("answer-from-r3");
    expect(calls).toEqual(["r1", "r2", "r3"]);
  });

  test("全部失败抛最后一次错误", async () => {
    const calls: string[] = [];
    const complete = createScenarioCompleter({
      scenario: "review",
      routing: routing({ review: { ...routeShape, model: "r1", fallbacks: ["r2"] } }),
      baseConnection: async () => connection("deploy-model"),
      completerFor: completerFor({ r1: "fail", r2: "fail" }, calls),
    });
    await expect(complete("p")).rejects.toThrow("r2 down");
  });
});
