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
  isResolvedReasoningEffort,
  isRoutingEffortSetting,
  isValidRoutingModelId,
  type ResolvedReasoningEffort,
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
    throw new ScenarioRoutingValidationError("场景路由配置版本仅支持 1。");
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

/**
 * chat 场景链决议：把场景配置套用到当前默认链解析上。
 *
 * 语义（空配置时输出与升级前逐字节一致）：
 * - `useAdaptive === false`：跳过自适应路由，主模型 = `route.model || baseModel`；
 * - 自适应开启且给出了 `adaptiveModel`：链首为自适应选择，其后是场景主模型
 *   （契约语义：场景内仍走自适应，场景配置只覆盖候选模型与强度上限）；
 * - `route.fallbacks` 非空时整体替代全局备用链，否则沿用全局链；
 * - 全链按序去重。
 */
export function applyChatScenarioRoute(input: {
  route: ScenarioRoute;
  adaptiveModel: string | null;
  baseModel: string;
  globalFallbacks: readonly string[];
}): { models: string[]; skipAdaptive: boolean } {
  const { route, adaptiveModel, baseModel, globalFallbacks } = input;
  const skipAdaptive = route.useAdaptive === false;
  const primaryBase = route.model || baseModel;
  const fallbacks = route.fallbacks.length ? route.fallbacks : globalFallbacks;
  const chain: string[] = [];
  if (!skipAdaptive && adaptiveModel) chain.push(adaptiveModel);
  chain.push(primaryBase);
  chain.push(...fallbacks);
  return {
    models: chain.filter((id, at) => chain.indexOf(id) === at),
    skipAdaptive,
  };
}

/**
 * 场景思考强度决议：只有具体档位（非 default/auto）才覆盖自适应结果，
 * default/auto 都表示「继承」——default 是不覆盖任何现状，auto 是交给自适应决定。
 */
export function resolveScenarioEffort(
  routeEffort: RoutingEffortSetting,
  adaptiveEffort: ResolvedReasoningEffort,
): ResolvedReasoningEffort {
  if (
    routeEffort !== "default" &&
    routeEffort !== "auto" &&
    isResolvedReasoningEffort(routeEffort)
  ) {
    return routeEffort;
  }
  return adaptiveEffort;
}

/** 场景 maxTokens 上限：与模型自身/窗口推导出的上限取较小者；null 表示不追加约束。 */
export function capScenarioMaxTokens(
  derived: number,
  scenarioMaxTokens: number | null,
): number {
  if (scenarioMaxTokens === null) return derived;
  return Math.max(1, Math.min(derived, scenarioMaxTokens));
}

/* ─────────────────────────── 路由决策日志（PR3） ─────────────────────────── */

/** 路由事件的消费方：决议发生在哪条链路。 */
export const SCENARIO_ROUTE_CONSUMERS = [
  "chat",
  "review",
  "title",
  "vision",
  "suggestions",
  "completion",
  "dry-run",
] as const;
export type ScenarioRouteConsumer = (typeof SCENARIO_ROUTE_CONSUMERS)[number];

export const SCENARIO_ROUTE_OUTCOMES = [
  "inherited",
  "resolved",
  "fallback",
  "failed",
] as const;
export type ScenarioRouteOutcome = (typeof SCENARIO_ROUTE_OUTCOMES)[number];

/**
 * 一条场景路由决策事件。只记决议元数据——链、命中、覆盖来源；
 * 绝不记录 prompt、对话内容或任何用户输入。
 */
export type ScenarioRouteEvent = {
  id: string;
  createdAt: string;
  scenario: ModelScenario;
  consumer: ScenarioRouteConsumer;
  /** 该场景在配置里有任何字段覆盖（非全继承）。 */
  configured: boolean;
  /** 决议出的有序模型链（单模型消费方只有一项）。 */
  chain: string[];
  /** 实际命中的模型；决议在选出前失败时为 null。 */
  chosenModel: string | null;
  outcome: ScenarioRouteOutcome;
  /** 脱敏短注记（如 fallback 原因），无内容数据。 */
  detail: string | null;
  dryRun: boolean;
};

export type ScenarioRouteEventInput = {
  scenario: ModelScenario;
  consumer: ScenarioRouteConsumer;
  configured: boolean;
  chain: string[];
  chosenModel: string | null;
  outcome: ScenarioRouteOutcome;
  detail?: string | null;
  dryRun?: boolean;
};

/* ───────────────────────────── Dry-run（PR3） ───────────────────────────── */

/**
 * 场景的接线状态：dry-run 需要告诉管理员这个场景的决议当前是否真的被消费。
 * wired-chain = chat 类链式消费；wired-single = 单次调用覆盖默认模型；
 * wired-completer = 主备链依次尝试；wired-vision = 视觉合成回退位；
 * unwired = 消费方尚未落地（配置已保存待生效）；excluded = 刻意不接入。
 */
export const SCENARIO_WIRING: Record<
  ModelScenario,
  {
    state:
      | "wired-chain"
      | "wired-single"
      | "wired-completer"
      | "wired-vision"
      | "unwired"
      | "excluded";
    note: string;
  }
> = {
  chat: { state: "wired-chain", note: "对话每一轮的主模型链决议。" },
  suggestions: {
    state: "unwired",
    note: "消费方随输入建议 PR 落地，当前配置已保存待生效。",
  },
  completion: {
    state: "unwired",
    note: "消费方随行内补全 PR 落地，当前配置已保存待生效。",
  },
  summarization: {
    state: "wired-chain",
    note: "压缩 / 摘要会话改用本场景链而非 chat。",
  },
  memoryExtraction: {
    state: "unwired",
    note: "消费方尚未落地，当前配置已保存待生效。",
  },
  review: {
    state: "wired-completer",
    note: "审批审查按主备链依次尝试，任一成功即返回。",
  },
  subagent: {
    state: "unwired",
    note: "消费方尚未落地，当前配置已保存待生效。",
  },
  automation: {
    state: "unwired",
    note: "消费方尚未落地，当前配置已保存待生效。",
  },
  title: { state: "wired-single", note: "标题生成连接的默认模型按场景覆盖。" },
  vision: {
    state: "wired-vision",
    note: "未显式配置识图模型时，场景主模型合成部署级默认。",
  },
  test: {
    state: "excluded",
    note: "刻意不接入：自检测的就是表单里指定的那个模型。",
  },
};

export type ScenarioDryRunInput = {
  scenario: ModelScenario;
  /** 已校验的（假设性或当前）配置。 */
  config: ModelScenarioRoutingConfig;
  /** 部署默认聊天模型。 */
  baseModel: string;
  /** 全局备用模型链。 */
  globalFallbacks: readonly string[];
  /** 自适应难度路由是否启用。 */
  adaptiveAvailable: boolean;
};

export type ScenarioDryRunResult = {
  scenario: ModelScenario;
  wiring: (typeof SCENARIO_WIRING)[ModelScenario]["state"];
  wiringNote: string;
  /** 该场景是否有任何字段覆盖。 */
  configured: boolean;
  /** 被覆盖的字段名列表。 */
  overrides: string[];
  /** 决议出的有序模型链（消费方未接线时仍按 chat 类语义展示假设链）。 */
  chain: string[];
  /** 自适应开启时链首会有分类器选择（dry-run 不做真实分类，仅符号标记）。 */
  adaptiveFirst: boolean;
  skipAdaptive: boolean;
  primary: string;
  effort: string;
  timeoutMs: number | null;
  maxTokens: number | null;
  /** 逐条中文解释决议如何得出。 */
  trace: string[];
};

/** 列出场景路由里实际被覆盖（非继承）的字段。 */
export function scenarioRouteOverrides(route: ScenarioRoute): string[] {
  const overrides: string[] = [];
  if (route.model) overrides.push("model");
  if (route.fallbacks.length) overrides.push("fallbacks");
  if (route.effort !== "default") overrides.push("effort");
  if (route.timeoutMs !== null) overrides.push("timeoutMs");
  if (route.maxTokens !== null) overrides.push("maxTokens");
  if (route.useAdaptive === false) overrides.push("useAdaptive");
  return overrides;
}

/**
 * Dry-run 纯函数：对给定场景与（假设性）配置跑出决议链与逐条解释，
 * 不发起任何模型调用。chat 类场景的自适应选择以符号标记表示。
 */
export function resolveScenarioDryRun(
  input: ScenarioDryRunInput,
): ScenarioDryRunResult {
  const route = resolveScenarioRoute(input.config, input.scenario);
  const overrides = scenarioRouteOverrides(route);
  const configured = overrides.length > 0;
  const wiring = SCENARIO_WIRING[input.scenario];
  const trace: string[] = [];

  const primaryBase = route.model || input.baseModel;
  if (route.model) {
    trace.push(`主模型：场景配置覆盖为 ${route.model}。`);
  } else {
    trace.push(`主模型：场景未配置，继承部署默认 ${input.baseModel}。`);
  }

  const fallbacks = route.fallbacks.length
    ? route.fallbacks
    : input.globalFallbacks;
  if (route.fallbacks.length) {
    trace.push(
      `备用链：场景配置整体替代全局链（${route.fallbacks.join(" → ") || "空"}）。`,
    );
  } else if (input.globalFallbacks.length) {
    trace.push(`备用链：继承全局链（${input.globalFallbacks.join(" → ")}）。`);
  } else {
    trace.push("备用链：全局未配置，且无场景覆盖。");
  }

  const chainSemantics = ["chat", "summarization"].includes(input.scenario);
  const skipAdaptive = chainSemantics && route.useAdaptive === false;
  const adaptiveFirst =
    chainSemantics && !skipAdaptive && input.adaptiveAvailable;
  if (chainSemantics) {
    if (skipAdaptive) {
      trace.push("自适应：场景配置 useAdaptive=false，跳过难度分类。");
    } else if (input.adaptiveAvailable) {
      trace.push(
        "自适应：启用，链首为分类器实时选择（dry-run 不做真实分类）。",
      );
    } else {
      trace.push("自适应：未启用，链首即主模型。");
    }
  }

  const chain: string[] = [];
  if (adaptiveFirst) chain.push("〈自适应选择〉");
  chain.push(primaryBase);
  chain.push(...fallbacks);
  const deduped = chain.filter((id, at) => chain.indexOf(id) === at);

  let effort: string;
  if (route.effort !== "default" && route.effort !== "auto") {
    effort = route.effort;
    trace.push(`思考强度：场景覆盖为 ${route.effort}。`);
  } else if (route.effort === "auto") {
    effort = "auto（交给自适应决定）";
    trace.push("思考强度：auto，由自适应分类决定。");
  } else {
    effort = "继承（不覆盖）";
    trace.push("思考强度：未覆盖，继承自适应结果或模型默认。");
  }

  if (route.timeoutMs !== null) {
    trace.push(
      `超时：场景覆盖为 ${route.timeoutMs}ms（仅对有逐次超时机制的消费方生效）。`,
    );
  }
  if (route.maxTokens !== null) {
    trace.push(
      `输出上限：场景覆盖为 ${route.maxTokens}，与模型/窗口推导上限取小。`,
    );
  }
  if (wiring.state === "unwired") {
    trace.push(`接线状态：${wiring.note}`);
  } else if (wiring.state === "excluded") {
    trace.push(`接线状态：${wiring.note}`);
  }

  return {
    scenario: input.scenario,
    wiring: wiring.state,
    wiringNote: wiring.note,
    configured,
    overrides,
    chain: deduped,
    adaptiveFirst,
    skipAdaptive,
    primary: primaryBase,
    effort,
    timeoutMs: route.timeoutMs,
    maxTokens: route.maxTokens,
    trace,
  };
}
