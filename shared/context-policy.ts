/**
 * 按模型覆写上下文容量与摘要阈值（前后端共用解析与校验逻辑）。
 */

export const MIN_CONTEXT_WINDOW_TOKENS = 4_096;
export const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;
export const MIN_SUMMARY_THRESHOLD_TOKENS = 2_048;
export const MIN_SUMMARY_HEADROOM_TOKENS = 1_024;
export const DEFAULT_SUMMARY_THRESHOLD_RATIO = 0.7;

export type ContextPolicyValues = {
  contextWindowTokens: number;
  summaryThresholdTokens: number;
};

export type ContextPolicyValidationResult =
  | { ok: true; value: ContextPolicyValues }
  | { ok: false; error: string };

export type ModelContextPolicyOverride = {
  modelId: string;
  contextWindowTokens: number;
  summaryThresholdTokens: number;
  updatedAt: string | null;
};

export type ModelContextPolicyInput = {
  modelId: string;
  contextWindowTokens: number | string;
  summaryThresholdTokens?: number | string | null;
};

/**
 * 解析 Token 简写字符串，支持 `1M`、`400K`、`128000`、`128,000`、`1.5m`、`32.5k` 等格式。
 * 无效输入、非正数或超出安全整数范围时返回 `null`。
 */
export function parseTokenShorthand(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[,_\s]+/g, "");
  if (!cleaned) return null;

  const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(cleaned);
  if (!match) return null;

  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const tokens = Math.round(numeric * multiplier);

  if (!Number.isSafeInteger(tokens) || tokens <= 0) return null;
  return tokens;
}

/** 将正整数 Token 数格式化为易读简写（例如 1000000 -> 1M，400000 -> 400K）。 */
export function formatTokenShorthand(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return tokens.toLocaleString("en-US");
}

/** 计算给定上下文容量下的默认摘要阈值（70%，同时满足最小安全下限与余量）。 */
export function defaultSummaryThresholdFor(
  contextWindowTokens: number,
): number {
  const scaled = Math.floor(
    contextWindowTokens * DEFAULT_SUMMARY_THRESHOLD_RATIO,
  );
  const maxAllowed = contextWindowTokens - MIN_SUMMARY_HEADROOM_TOKENS;
  return Math.max(MIN_SUMMARY_THRESHOLD_TOKENS, Math.min(scaled, maxAllowed));
}

/** 校验上下文窗口与摘要阈值：强制安全上下限，且 `summaryThresholdTokens < contextWindowTokens`。 */
export function validateContextPolicy(input: {
  contextWindowTokens: number;
  summaryThresholdTokens?: number | null;
}): ContextPolicyValidationResult {
  const { contextWindowTokens } = input;
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    !Number.isInteger(contextWindowTokens)
  ) {
    return { ok: false, error: "上下文容量必须是正整数。" };
  }
  if (contextWindowTokens < MIN_CONTEXT_WINDOW_TOKENS) {
    return {
      ok: false,
      error: `上下文容量不能低于 ${MIN_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")} tokens。`,
    };
  }
  if (contextWindowTokens > MAX_CONTEXT_WINDOW_TOKENS) {
    return {
      ok: false,
      error: `上下文容量不能超过 ${formatTokenShorthand(MAX_CONTEXT_WINDOW_TOKENS)} tokens。`,
    };
  }

  const summaryThresholdTokens =
    input.summaryThresholdTokens === undefined ||
    input.summaryThresholdTokens === null
      ? defaultSummaryThresholdFor(contextWindowTokens)
      : input.summaryThresholdTokens;

  if (
    typeof summaryThresholdTokens !== "number" ||
    !Number.isFinite(summaryThresholdTokens) ||
    !Number.isInteger(summaryThresholdTokens)
  ) {
    return { ok: false, error: "摘要触发阈值必须是正整数。" };
  }
  if (summaryThresholdTokens < MIN_SUMMARY_THRESHOLD_TOKENS) {
    return {
      ok: false,
      error: `摘要触发阈值不能低于 ${MIN_SUMMARY_THRESHOLD_TOKENS.toLocaleString("en-US")} tokens。`,
    };
  }
  if (summaryThresholdTokens >= contextWindowTokens) {
    return {
      ok: false,
      error: "摘要触发阈值必须严格小于上下文容量。",
    };
  }
  if (
    contextWindowTokens - summaryThresholdTokens <
    MIN_SUMMARY_HEADROOM_TOKENS
  ) {
    return {
      ok: false,
      error: `摘要触发阈值需至少为模型输出预留 ${MIN_SUMMARY_HEADROOM_TOKENS.toLocaleString("en-US")} tokens 余量。`,
    };
  }

  return {
    ok: true,
    value: {
      contextWindowTokens,
      summaryThresholdTokens,
    },
  };
}
