/**
 * 模型单价表（估算用）与成本估算纯函数（CB-146）。
 *
 * - 价格为每 1M token 美元价（input/output 分列），来源于各厂商公开标价的手工收录快照；
 * - 仅供「估算」展示：未收录模型一律返回 null（显示"未收录"）而不是猜一个错的价格；
 * - 匹配先精确后去 provider 前缀（"openai/gpt-4o" → "gpt-4o"），不做模糊匹配防止错估。
 */

export type ModelPriceEntry = {
  inputPer1M: number;
  outputPer1M: number;
};

/** 内置单价快照（2026-01 手工收录；允许过时——展示文案已标注估算）。 */
export const BUILTIN_MODEL_PRICING: Record<string, ModelPriceEntry> = {
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-5": { inputPer1M: 1.25, outputPer1M: 10 },
  "gpt-5-mini": { inputPer1M: 0.25, outputPer1M: 2 },
  o3: { inputPer1M: 2, outputPer1M: 8 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4 },
  "claude-sonnet-4-20250514": { inputPer1M: 3, outputPer1M: 15 },
  "claude-opus-4-20250514": { inputPer1M: 15, outputPer1M: 75 },
  "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.1 },
  "deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "qwen-plus": { inputPer1M: 0.4, outputPer1M: 1.2 },
  "qwen-max": { inputPer1M: 1.6, outputPer1M: 6.4 },
  "qwen-turbo": { inputPer1M: 0.05, outputPer1M: 0.2 },
  "glm-4-plus": { inputPer1M: 0.5, outputPer1M: 0.5 },
  "glm-4-air": { inputPer1M: 0.1, outputPer1M: 0.1 },
  "kimi-k2-0711-preview": { inputPer1M: 0.6, outputPer1M: 2.5 },
};

/** 归一化模型 id 后查价：精确命中优先，其次剥离 provider/ 前缀，再次按日期后缀回退（gpt-4o-2024-08-06 → gpt-4o）。 */
export function lookupModelPrice(modelId: string): ModelPriceEntry | null {
  const raw = modelId.trim().toLowerCase();
  if (!raw) return null;
  const exact = BUILTIN_MODEL_PRICING[raw];
  if (exact) return exact;
  const stripped = raw.includes("/")
    ? raw.slice(raw.lastIndexOf("/") + 1)
    : raw;
  const hit = BUILTIN_MODEL_PRICING[stripped];
  if (hit) return hit;
  // 去掉尾部日期/版本后缀逐级回退：claude-3-5-sonnet-20241022 已精确收录，gpt-4o-2024-11-20 → gpt-4o。
  const noDate = stripped
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
  return BUILTIN_MODEL_PRICING[noDate] ?? null;
}

/** 估算单事件成本（美元）；价格未收录返回 null。 */
export function estimateEventCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = lookupModelPrice(modelId);
  if (!price) return null;
  return (
    (Math.max(inputTokens, 0) / 1_000_000) * price.inputPer1M +
    (Math.max(outputTokens, 0) / 1_000_000) * price.outputPer1M
  );
}
