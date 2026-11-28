/**
 * 场景化模型路由共享契约与纯函数。
 *
 * 设计目标：把分散在 chat / review / title / summarization / vision 等链路里的模型选择
 * 统一成一张按场景配置的路由表。每个场景可以独立指定主模型、备用链、思考强度、超时与
 * 输出上限；未配置的场景逐项继承当前行为（默认模型、全局备用链、模型默认 effort），
 * 因此空配置与升级前的行为完全一致。
 *
 * 设计红线：
 * - 不硬编码任何专有外部服务或专属模型名；
 * - 配置项只做格式校验，模型是否真实存在由模型目录在使用侧裁决；
 * - 场景键是闭集，拒绝未知键，防止拼写错误静默失效。
 */

import {
  isRoutingEffortSetting,
  isValidRoutingModelId,
  type RoutingEffortSetting,
} from "./model-routing";

export const MODEL_SCENARIOS = [
  "chat",
  "suggestions",
  "completion",
  "summarization",
  "memoryExtraction",
  "review",
  "subagent",
  "automation",
  "title",
  "vision",
  "test",
] as const;
export type ModelScenario = (typeof MODEL_SCENARIOS)[number];

export const MAX_SCENARIO_FALLBACKS = 8;
export const SCENARIO_TIMEOUT_MIN_MS = 1_000;
export const SCENARIO_TIMEOUT_MAX_MS = 600_000;
export const SCENARIO_MAX_TOKENS_MIN = 1;
export const SCENARIO_MAX_TOKENS_MAX = 200_000;

/**
 * 单个场景的路由配置。所有字段都有「继承」语义：
 * - `model` 空字符串 = 沿用该场景当前默认模型解析链；
 * - `fallbacks` 空数组 = 沿用全局备用模型链；
 * - `effort` `"default"` = 不覆盖思考强度；
 * - `timeoutMs` / `maxTokens` 为 `null` = 不覆盖；
 * - `useAdaptive` 仅对 chat / subagent 有意义：为 true 时场景内仍走自适应难度路由，
 *   场景配置只覆盖候选模型与强度上限。
 */
export type ScenarioRoute = {
  model: string;
  fallbacks: string[];
  effort: RoutingEffortSetting;
  timeoutMs: number | null;
  maxTokens: number | null;
  useAdaptive: boolean;
};

export type ModelScenarioRoutingConfig = {
  version: 1;
  scenarios: Partial<Record<ModelScenario, ScenarioRoute>>;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

export const MODEL_SCENARIO_LABELS: Record<
  ModelScenario,
  { label: string; description: string }
> = {
  chat: {
    label: "聊天主链路（chat）",
    description: "对话每一轮的主模型调用；默认走自适应难度路由",
  },
  suggestions: {
    label: "输入建议（suggestions）",
    description: "回复完成后为输入框预生成的下一步建议",
  },
  completion: {
    label: "行内补全（completion）",
    description: "输入过程中的灰色续写，要求低延迟低成本",
  },
  summarization: {
    label: "历史摘要（summarization）",
    description: "长上下文压缩与对话摘要",
  },
  memoryExtraction: {
    label: "记忆抽取（memoryExtraction）",
    description: "从对话中抽取长期记忆条目",
  },
  review: {
    label: "审批审查（review）",
    description: "审批卡自动审查与风险评级",
  },
  subagent: {
    label: "子代理（subagent）",
    description: "委派给子代理/自动化执行的任务",
  },
  automation: {
    label: "自动化（automation）",
    description: "定时任务与 webhook 触发的后台运行",
  },
  title: {
    label: "标题生成（title）",
    description: "会话标题自动命名",
  },
  vision: {
    label: "图像理解（vision）",
    description: "图片描述与视觉 fallback",
  },
  test: {
    label: "自检（test）",
    description: "设置页与部署后的模型连通性自检",
  },
};

export function isModelScenario(value: unknown): value is ModelScenario {
  return (
    typeof value === "string" &&
    (MODEL_SCENARIOS as readonly string[]).includes(value)
  );
}

export function defaultScenarioRoute(): ScenarioRoute {
  return {
    model: "",
    fallbacks: [],
    effort: "default",
    timeoutMs: null,
    maxTokens: null,
    useAdaptive: true,
  };
}

export function defaultScenarioRoutingConfig(): ModelScenarioRoutingConfig {
  return { version: 1, scenarios: {}, updatedAt: null, updatedBy: null };
}

/** 读取某场景的有效配置：未配置时返回全继承默认值。 */
export function resolveScenarioRoute(
  config: ModelScenarioRoutingConfig,
  scenario: ModelScenario,
): ScenarioRoute {
  return config.scenarios[scenario] ?? defaultScenarioRoute();
}

export class ScenarioRoutingValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ScenarioRoutingValidationError";
  }
}

function validateTimeoutMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < SCENARIO_TIMEOUT_MIN_MS ||
    value > SCENARIO_TIMEOUT_MAX_MS
  ) {
    throw new ScenarioRoutingValidationError(
      `超时必须是 ${SCENARIO_TIMEOUT_MIN_MS}–${SCENARIO_TIMEOUT_MAX_MS} 毫秒之间的整数，或留空继承。`,
    );
  }
  return value;
}

function validateMaxTokens(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < SCENARIO_MAX_TOKENS_MIN ||
    value > SCENARIO_MAX_TOKENS_MAX
  ) {
    throw new ScenarioRoutingValidationError(
      `输出上限必须是 ${SCENARIO_MAX_TOKENS_MIN}–${SCENARIO_MAX_TOKENS_MAX} 之间的整数，或留空继承。`,
    );
  }
  return value;
}

export function validateScenarioRoute(raw: unknown): ScenarioRoute {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScenarioRoutingValidationError("场景路由必须是 JSON 对象。");
  }
  const input = raw as Record<string, unknown>;
  const model = input.model ?? "";
  if (typeof model !== "string") {
    throw new ScenarioRoutingValidationError("场景主模型必须是字符串。");
  }
  const trimmedModel = model.trim();
  if (trimmedModel && !isValidRoutingModelId(trimmedModel)) {
    throw new ScenarioRoutingValidationError(
      "场景主模型 ID 格式无效（不能含空格或控制字符，最长 256 字符）。",
    );
  }
  const rawFallbacks = input.fallbacks ?? [];
  if (!Array.isArray(rawFallbacks)) {
    throw new ScenarioRoutingValidationError("场景备用模型必须是数组。");
  }
  const fallbacks: string[] = [];
  for (const item of rawFallbacks) {
    if (!isValidRoutingModelId(item)) {
      throw new ScenarioRoutingValidationError(
        "备用模型 ID 不能为空、不能含空格或控制字符，最长 256 字符。",
      );
    }
    const id = item.trim();
    if (id !== trimmedModel && !fallbacks.includes(id)) fallbacks.push(id);
  }
  if (fallbacks.length > MAX_SCENARIO_FALLBACKS) {
    throw new ScenarioRoutingValidationError(
      `每个场景的备用模型最多 ${MAX_SCENARIO_FALLBACKS} 个。`,
    );
  }
  const effort = input.effort ?? "default";
  if (!isRoutingEffortSetting(effort)) {
    throw new ScenarioRoutingValidationError("场景思考强度设置无效。");
  }
  const useAdaptive = input.useAdaptive ?? true;
  if (typeof useAdaptive !== "boolean") {
    throw new ScenarioRoutingValidationError("useAdaptive 必须是布尔值。");
  }
  return {
    model: trimmedModel,
    fallbacks,
    effort,
    timeoutMs: validateTimeoutMs(input.timeoutMs),
    maxTokens: validateMaxTokens(input.maxTokens),
    useAdaptive,
  };
}

export function validateScenarioRoutingConfig(
  raw: unknown,
): ModelScenarioRoutingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScenarioRoutingValidationError("场景路由配置必须是 JSON 对象。");
  }
  const input = raw as Record<string, unknown>;
  if (input.version !== undefined && input.version !== 1) {
    throw new ScenarioRoutingValidationError(
      "场景路由配置版本仅支持 1。",
    );
  }
  const rawScenarios = input.scenarios ?? {};
  if (
    !rawScenarios ||
    typeof rawScenarios !== "object" ||
    Array.isArray(rawScenarios)
  ) {
    throw new ScenarioRoutingValidationError("scenarios 必须是 JSON 对象。");
  }
  const scenarios: Partial<Record<ModelScenario, ScenarioRoute>> = {};
  for (const [key, value] of Object.entries(
    rawScenarios as Record<string, unknown>,
  )) {
    if (!isModelScenario(key)) {
      throw new ScenarioRoutingValidationError(
        `未知场景键：${key}（可用：${MODEL_SCENARIOS.join(" / ")}）。`,
      );
    }
    scenarios[key] = validateScenarioRoute(value);
  }
  return {
    version: 1,
    scenarios,
    updatedAt:
      typeof input.updatedAt === "string" || input.updatedAt === null
        ? input.updatedAt
        : null,
    updatedBy:
      typeof input.updatedBy === "string" || input.updatedBy === null
        ? input.updatedBy
        : null,
  };
}
