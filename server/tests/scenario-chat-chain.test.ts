import { describe, expect, test } from "bun:test";
import {
  applyChatScenarioRoute,
  capScenarioMaxTokens,
  defaultScenarioRoute,
  resolveScenarioEffort,
  type ScenarioRoute,
} from "../../shared/model-scenario-routing";

const route = (overrides: Partial<ScenarioRoute>): ScenarioRoute => ({
  ...defaultScenarioRoute(),
  ...overrides,
});

describe("chat 场景链决议", () => {
  test("空配置与升级前链逐字节一致（无自适应）", () => {
    const result = applyChatScenarioRoute({
      route: defaultScenarioRoute(),
      adaptiveModel: null,
      baseModel: "base-model",
      globalFallbacks: ["fb1", "fb2"],
    });
    expect(result.models).toEqual(["base-model", "fb1", "fb2"]);
    expect(result.skipAdaptive).toBe(false);
  });

  test("空配置与升级前链一致（有自适应选择排链首）", () => {
    const result = applyChatScenarioRoute({
      route: defaultScenarioRoute(),
      adaptiveModel: "adaptive-pick",
      baseModel: "base-model",
      globalFallbacks: ["fb1"],
    });
    expect(result.models).toEqual(["adaptive-pick", "base-model", "fb1"]);
  });

  test("场景主模型替换部署默认模型，且不再出现在链中", () => {
    const result = applyChatScenarioRoute({
      route: route({ model: "cheap-chat" }),
      adaptiveModel: null,
      baseModel: "base-model",
      globalFallbacks: ["fb1"],
    });
    expect(result.models).toEqual(["cheap-chat", "fb1"]);
  });

  test("场景备用链非空时整体替代全局备用链", () => {
    const result = applyChatScenarioRoute({
      route: route({ model: "cheap-chat", fallbacks: ["sfb1", "sfb2"] }),
      adaptiveModel: null,
      baseModel: "base-model",
      globalFallbacks: ["fb1"],
    });
    expect(result.models).toEqual(["cheap-chat", "sfb1", "sfb2"]);
  });

  test("useAdaptive=false 时跳过自适应且场景主模型排链首", () => {
    const result = applyChatScenarioRoute({
      route: route({ model: "fixed-chat", useAdaptive: false }),
      adaptiveModel: "adaptive-pick",
      baseModel: "base-model",
      globalFallbacks: ["fb1"],
    });
    expect(result.skipAdaptive).toBe(true);
    expect(result.models).toEqual(["fixed-chat", "fb1"]);
  });

  test("自适应选择与场景主模型按序去重", () => {
    const result = applyChatScenarioRoute({
      route: route({ model: "same-model" }),
      adaptiveModel: "same-model",
      baseModel: "base-model",
      globalFallbacks: ["same-model", "fb1"],
    });
    expect(result.models).toEqual(["same-model", "fb1"]);
  });

  test("思考强度：具体档位覆盖自适应结果", () => {
    expect(resolveScenarioEffort("low", "high")).toBe("low");
    expect(resolveScenarioEffort("max", "default")).toBe("max");
  });

  test("思考强度：default 与 auto 都继承自适应结果", () => {
    expect(resolveScenarioEffort("default", "high")).toBe("high");
    expect(resolveScenarioEffort("auto", "high")).toBe("high");
    expect(resolveScenarioEffort("auto", "default")).toBe("default");
  });

  test("maxTokens：场景上限取较小者，null 不追加约束", () => {
    expect(capScenarioMaxTokens(8000, null)).toBe(8000);
    expect(capScenarioMaxTokens(8000, 2000)).toBe(2000);
    expect(capScenarioMaxTokens(8000, 16000)).toBe(8000);
    expect(capScenarioMaxTokens(8000, 0)).toBe(1);
  });
});
