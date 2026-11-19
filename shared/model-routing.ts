/**
 * 自适应难度智能路由 + 动态思考强度（reasoning_effort）共享契约与纯函数。
 *
 * 设计红线：
 * - 绝不硬编码任何专有外部 SaaS（如 api.typesafe.ai）或专属模型名；
 * - 难度档位：routine | reasoning | expert；
 * - 思考档位：none | low | medium | high | xhigh | max；
 * - 触达输出上限（finishReason === "length"）时返回可续写信号，绝不整轮抛不可重试异常。
 */

export const TASK_DIFFICULTIES = ["routine", "reasoning", "expert"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type RoutingEffortSetting = ReasoningEffort | "default" | "auto";
export type ResolvedReasoningEffort = ReasoningEffort | "default";
export type RoutingMode = "manual" | "adaptive";
export type ClassifierMode = "rule" | "model";
export type RoutingDecisionSource =
  | "rule"
  | "classifier"
  | "manual"
  | "fallback";
export type RoutingProviderKind =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "openai-compatible";

export type ModelRoutingTierConfig = {
  model: string;
  effort: RoutingEffortSetting;
};

export type ModelEffortCatalogEntry = {
  id: string;
  efforts: ReasoningEffort[];
};

export type AdaptiveRoutingPolicy = {
  mode: RoutingMode;
  defaultEffort: ResolvedReasoningEffort;
  classifierMode: ClassifierMode;
  classifierModel: string | null;
  routes: Record<TaskDifficulty, ModelRoutingTierConfig>;
  models: ModelEffortCatalogEntry[];
  updatedAt?: string | null;
  updatedBy?: string | null;
};

export type RoutingDecision = {
  mode: RoutingMode;
  difficulty: TaskDifficulty;
  model: string;
  effort: ResolvedReasoningEffort;
  source: RoutingDecisionSource;
  confidence: number;
  elapsedMs: number;
  cached: boolean;
  classifierModel: string | null;
  fallbackReason?: string;
  skippedReason?: string;
  providerParams: Record<string, unknown>;
};

export type RoutingLogEntry = {
  id: string;
  createdAt: string;
  taskSummary: string;
  difficulty: TaskDifficulty;
  model: string;
  effort: ResolvedReasoningEffort;
  source: RoutingDecisionSource;
  confidence: number;
  elapsedMs: number;
  classifierModel: string | null;
  fallbackReason: string | null;
  dryRun: boolean;
};

export type RuleClassificationSignals = {
  difficulty: TaskDifficulty;
  suggestedEffort: ReasoningEffort;
  confidence: number;
  score: number;
  matchedKeywords: string[];
  reason: string;
};

export type DryRunRoutingResult = {
  decision: RoutingDecision;
  taskSummary: string;
  extractedMessages: string[];
  inputHash: string;
  ruleSignals: RuleClassificationSignals;
};

export type LengthTruncationContinuation = {
  truncated: true;
  continuable: true;
  finishReason: "length";
  notice: string;
  suggestedPrompt: string;
};

export const TASK_DIFFICULTY_LABELS: Record<
  TaskDifficulty,
  { label: string; description: string }
> = {
  routine: {
    label: "日常任务（routine）",
    description: "寒暄、简单问答、翻译、格式整理、单步查询",
  },
  reasoning: {
    label: "推理任务（reasoning）",
    description: "常规编程调试、多步分析、对比权衡、数据处理",
  },
  expert: {
    label: "专家难题（expert）",
    description: "跨模块架构、形式化证明、复杂算法、并发排障、深度研究",
  },
};

export const REASONING_EFFORT_LABELS: Record<RoutingEffortSetting, string> = {
  auto: "自动选择",
  default: "模型默认",
  none: "关闭（none）",
  low: "轻度（low）",
  medium: "中度（medium）",
  high: "高度（high）",
  xhigh: "超高（xhigh）",
  max: "极限（max）",
};

const ANTHROPIC_THINKING_BUDGETS: Record<
  Exclude<ReasoningEffort, "none">,
  number
> = {
  low: 2048,
  medium: 6144,
  high: 12288,
  xhigh: 20480,
  max: 32768,
};

export function isTaskDifficulty(value: unknown): value is TaskDifficulty {
  return (
    typeof value === "string" &&
    (TASK_DIFFICULTIES as readonly string[]).includes(value)
  );
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

export function isResolvedReasoningEffort(
  value: unknown,
): value is ResolvedReasoningEffort {
  return value === "default" || isReasoningEffort(value);
}

export function isRoutingEffortSetting(
  value: unknown,
): value is RoutingEffortSetting {
  return value === "auto" || isResolvedReasoningEffort(value);
}

export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isValidRoutingModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) return false;
  if (/\s/u.test(trimmed)) return false;
  return !hasControlCharacters(trimmed);
}

/** 结合常见模型族推断可用思考档位（仅作默认辅助，不强绑任何专有服务）。 */
export function inferModelEffortLevels(modelId: string): ReasoningEffort[] {
  if (/deepseek/i.test(modelId)) {
    return ["none", "low", "medium", "high", "max"];
  }
  if (/claude/i.test(modelId)) {
    return ["none", "low", "medium", "high", "xhigh", "max"];
  }
  if (/(?:^|\/)(?:o[134]|gpt-5|gemini-2\.5|qwen3)/i.test(modelId)) {
    return ["none", "low", "medium", "high", "xhigh", "max"];
  }
  return [...REASONING_EFFORTS];
}

export function defaultEffortForDifficulty(
  difficulty: TaskDifficulty,
): ReasoningEffort {
  switch (difficulty) {
    case "routine":
      return "low";
    case "reasoning":
      return "medium";
    case "expert":
      return "high";
  }
}

export function defaultAdaptiveRoutingPolicy(
  defaultModel = "",
): AdaptiveRoutingPolicy {
  const normalized = defaultModel.trim();
  return {
    mode: "manual",
    defaultEffort: "default",
    classifierMode: "rule",
    classifierModel: null,
    routes: {
      routine: { model: normalized, effort: "low" },
      reasoning: { model: normalized, effort: "medium" },
      expert: { model: normalized, effort: "high" },
    },
    models: normalized
      ? [{ id: normalized, efforts: inferModelEffortLevels(normalized) }]
      : [],
    updatedAt: null,
    updatedBy: null,
  };
}

/**
 * 将统一思考强度映射为各厂商请求参数：
 * - OpenAI / OpenAI-compatible：`{ reasoning_effort }`（若 modelId 为 DeepSeek 则同时附加 `thinking`）；
 * - DeepSeek：`{ reasoning_effort, thinking: { type: "enabled" | "disabled" } }`；
 * - Anthropic：`none` 对应 `{ thinking: { type: "disabled" } }`，其余档位附带 `thinking: { type: "enabled", budget_tokens }` 与 `reasoning_effort`。
 */
export function mapEffortToProviderParams(
  effort: RoutingEffortSetting | null | undefined,
  providerKind: RoutingProviderKind,
  modelId?: string,
): Record<string, unknown> {
  if (!effort || effort === "default" || effort === "auto") {
    return {};
  }
  const isDeepSeek =
    providerKind === "deepseek" ||
    Boolean(modelId && /deepseek/i.test(modelId));
  if (isDeepSeek) {
    return {
      reasoning_effort: effort,
      thinking: { type: effort === "none" ? "disabled" : "enabled" },
    };
  }
  if (providerKind === "anthropic") {
    if (effort === "none") {
      return {
        thinking: { type: "disabled" },
      };
    }
    return {
      reasoning_effort: effort,
      thinking: {
        type: "enabled",
        budget_tokens: ANTHROPIC_THINKING_BUDGETS[effort],
      },
    };
  }
  return {
    reasoning_effort: effort,
  };
}

export class AdaptiveRoutingValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "AdaptiveRoutingValidationError";
  }
}

export function validateAdaptiveRoutingPolicy(
  raw: unknown,
  fallbackModel = "",
): AdaptiveRoutingPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdaptiveRoutingValidationError("路由策略必须是 JSON 对象。");
  }
  const input = raw as Record<string, unknown>;
  const mode = input.mode ?? "manual";
  if (mode !== "manual" && mode !== "adaptive") {
    throw new AdaptiveRoutingValidationError(
      "路由模式仅支持 manual 或 adaptive。",
    );
  }
  const defaultEffort = input.defaultEffort ?? "default";
  if (!isResolvedReasoningEffort(defaultEffort)) {
    throw new AdaptiveRoutingValidationError("默认思考强度档位无效。");
  }
  const classifierMode = input.classifierMode ?? "rule";
  if (classifierMode !== "rule" && classifierMode !== "model") {
    throw new AdaptiveRoutingValidationError(
      "分类器模式仅支持 rule 或 model。",
    );
  }
  let classifierModel: string | null = null;
  if (
    input.classifierModel !== undefined &&
    input.classifierModel !== null &&
    input.classifierModel !== ""
  ) {
    if (!isValidRoutingModelId(input.classifierModel)) {
      throw new AdaptiveRoutingValidationError(
        "轻量分类模型 ID 格式无效（不能含空格或控制字符，最长 256 字符）。",
      );
    }
    classifierModel = input.classifierModel.trim();
  }
  if (classifierMode === "model" && !classifierModel) {
    throw new AdaptiveRoutingValidationError(
      "启用轻量模型分类时必须填写已配置的分类模型 ID。",
    );
  }

  const rawModels = input.models ?? [];
  if (!Array.isArray(rawModels) || rawModels.length > 100) {
    throw new AdaptiveRoutingValidationError(
      "模型思考能力清单必须为数组且不超过 100 项。",
    );
  }
  const seenIds = new Set<string>();
  const models: ModelEffortCatalogEntry[] = [];
  for (const item of rawModels) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AdaptiveRoutingValidationError("模型条目格式无效。");
    }
    const record = item as Record<string, unknown>;
    if (!isValidRoutingModelId(record.id)) {
      throw new AdaptiveRoutingValidationError("模型条目中的模型 ID 无效。");
    }
    const id = record.id.trim();
    if (seenIds.has(id)) {
      throw new AdaptiveRoutingValidationError(`模型 ID 重复：${id}`);
    }
    seenIds.add(id);
    if (!Array.isArray(record.efforts)) {
      throw new AdaptiveRoutingValidationError(
        `模型 ${id} 的思考强度列表必须是数组。`,
      );
    }
    for (const level of record.efforts) {
      if (!isReasoningEffort(level)) {
        throw new AdaptiveRoutingValidationError(
          `模型 ${id} 包含不支持的思考强度：${String(level)}`,
        );
      }
    }
    models.push({
      id,
      efforts: REASONING_EFFORTS.filter((level) =>
        (record.efforts as unknown[]).includes(level),
      ),
    });
  }

  const rawRoutes = input.routes;
  if (!rawRoutes || typeof rawRoutes !== "object" || Array.isArray(rawRoutes)) {
    throw new AdaptiveRoutingValidationError(
      "必须提供 routine / reasoning / expert 三档路由规则。",
    );
  }
  const routeRecord = rawRoutes as Record<string, unknown>;
  const normalizedFallback = fallbackModel.trim();
  const routes = {} as Record<TaskDifficulty, ModelRoutingTierConfig>;
  for (const tier of TASK_DIFFICULTIES) {
    const tierValue = routeRecord[tier];
    if (
      !tierValue ||
      typeof tierValue !== "object" ||
      Array.isArray(tierValue)
    ) {
      throw new AdaptiveRoutingValidationError(`缺少 ${tier} 难度档位配置。`);
    }
    const tierObj = tierValue as Record<string, unknown>;
    const rawModel = tierObj.model ?? normalizedFallback;
    if (typeof rawModel !== "string") {
      throw new AdaptiveRoutingValidationError(
        `${tier} 档位的模型必须是字符串。`,
      );
    }
    const trimmedModel = rawModel.trim();
    if (trimmedModel && !isValidRoutingModelId(trimmedModel)) {
      throw new AdaptiveRoutingValidationError(
        `${tier} 档位的模型 ID 格式无效。`,
      );
    }
    const tierEffort = tierObj.effort ?? "auto";
    if (!isRoutingEffortSetting(tierEffort)) {
      throw new AdaptiveRoutingValidationError(
        `${tier} 档位的思考强度设置无效。`,
      );
    }
    if (trimmedModel) {
      const catalogEntry = models.find((entry) => entry.id === trimmedModel);
      if (
        catalogEntry &&
        catalogEntry.efforts.length > 0 &&
        tierEffort !== "default" &&
        tierEffort !== "auto" &&
        !catalogEntry.efforts.includes(tierEffort)
      ) {
        throw new AdaptiveRoutingValidationError(
          `模型 ${trimmedModel} 未声明支持思考强度 ${tierEffort}。`,
        );
      }
    }
    routes[tier] = {
      model: trimmedModel,
      effort: tierEffort,
    };
  }

  return {
    mode,
    defaultEffort,
    classifierMode,
    classifierModel,
    routes,
    models,
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
 * 触达输出长度截断上限（finishReason === "length"）时的可续写友好信号。
 * 绝不抛不可重试异常导致已生成的半截回复丢失。
 */
export function buildLengthTruncationContinuation(input: {
  model?: string;
  maxTokens?: number;
}): LengthTruncationContinuation {
  const modelLabel = input.model?.trim()
    ? `（模型 ${input.model.trim()}）`
    : "";
  const limitLabel =
    typeof input.maxTokens === "number" && input.maxTokens > 0
      ? `单轮输出上限 ${input.maxTokens} tokens`
      : "单轮输出长度上限";
  return {
    truncated: true,
    continuable: true,
    finishReason: "length",
    notice: `本轮回复已达到${limitLabel}${modelLabel}，已完整保留当前已生成内容；回复「继续」即可无缝续写剩余部分。`,
    suggestedPrompt: "请从刚才中断的地方继续输出剩余内容，不要重复前文。",
  };
}
