/**
 * 用量分析深化纯函数（CB-146）：维度分组 / 失败率 / 耗时分布 / 成本估算 / CSV 导出。
 *
 * 全部为 metadata-only 聚合——事件本身不含任何 prompt/输出内容，导出亦然。
 * 纯函数设计，内存与 PG 存储共用一套逻辑，便于无库单元测试。
 */

import { estimateEventCostUsd } from "../../../shared/usage-pricing";
import type { UsageEventRecord } from "./usage-breakdown";

export type UsageAnalyticsDimensionKey =
  | "provider"
  | "agent"
  | "scenario"
  | "model"
  | "kind";

export type UsageAnalyticsBucket = {
  key: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** 已收录单价事件的估算成本合计（美元）；窗口内无一收录则为 null。 */
  costUsd: number | null;
  /** 成本估算覆盖率（有单价事件的请求占比 0..1）——低价覆盖率下的成本合计偏低估。 */
  costCoverage: number;
  avgDurationMs: number;
};

export type UsageAnalyticsSummary = {
  requests: number;
  errors: number;
  failureRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  costCoverage: number;
  latency: {
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    samples: number;
  };
};

export type UsageAnalyticsReport = {
  summary: UsageAnalyticsSummary;
  byProvider: UsageAnalyticsBucket[];
  byAgent: UsageAnalyticsBucket[];
  byScenario: UsageAnalyticsBucket[];
  byModel: UsageAnalyticsBucket[];
  byKind: UsageAnalyticsBucket[];
};

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(ratio * sorted.length));
  return sorted[index] ?? 0;
}

type BucketAccum = {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costSum: number;
  priced: number;
  durationSum: number;
  durationCount: number;
};

function createAccum(): BucketAccum {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costSum: 0,
    priced: 0,
    durationSum: 0,
    durationCount: 0,
  };
}

function accumulate(accum: BucketAccum, event: UsageEventRecord): void {
  accum.requests += 1;
  if (event.status === "error") accum.errors += 1;
  accum.inputTokens += event.inputTokens;
  accum.outputTokens += event.outputTokens;
  accum.reasoningTokens += event.reasoningTokens;
  const cost = estimateEventCostUsd(
    event.modelId,
    event.inputTokens,
    event.outputTokens,
  );
  if (cost !== null) {
    accum.costSum += cost;
    accum.priced += 1;
  }
  if (event.durationMs > 0) {
    accum.durationSum += event.durationMs;
    accum.durationCount += 1;
  }
}

function finalizeBucket(key: string, accum: BucketAccum): UsageAnalyticsBucket {
  return {
    key,
    requests: accum.requests,
    errors: accum.errors,
    inputTokens: accum.inputTokens,
    outputTokens: accum.outputTokens,
    reasoningTokens: accum.reasoningTokens,
    costUsd: accum.priced > 0 ? Math.round(accum.costSum * 1e6) / 1e6 : null,
    costCoverage: accum.requests > 0 ? accum.priced / accum.requests : 0,
    avgDurationMs:
      accum.durationCount > 0
        ? Math.round(accum.durationSum / accum.durationCount)
        : 0,
  };
}

function groupBy(
  events: readonly UsageEventRecord[],
  keyOf: (event: UsageEventRecord) => string,
): UsageAnalyticsBucket[] {
  const groups = new Map<string, BucketAccum>();
  for (const event of events) {
    const key = keyOf(event) || "（未标注）";
    let accum = groups.get(key);
    if (!accum) {
      accum = createAccum();
      groups.set(key, accum);
    }
    accumulate(accum, event);
  }
  return [...groups.entries()]
    .map(([key, accum]) => finalizeBucket(key, accum))
    .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
}

/** 从明细事件构建维度化分析报告（纯函数）。 */
export function buildUsageAnalytics(
  events: readonly UsageEventRecord[],
): UsageAnalyticsReport {
  const total = createAccum();
  const durations: number[] = [];
  for (const event of events) {
    accumulate(total, event);
    if (event.durationMs > 0) durations.push(event.durationMs);
  }
  durations.sort((a, b) => a - b);
  const summary: UsageAnalyticsSummary = {
    requests: total.requests,
    errors: total.errors,
    failureRate: total.requests > 0 ? total.errors / total.requests : 0,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    reasoningTokens: total.reasoningTokens,
    costUsd: total.priced > 0 ? Math.round(total.costSum * 1e6) / 1e6 : null,
    costCoverage: total.requests > 0 ? total.priced / total.requests : 0,
    latency: {
      avgMs:
        durations.length > 0
          ? Math.round(
              durations.reduce((sum, ms) => sum + ms, 0) / durations.length,
            )
          : 0,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.length > 0 ? (durations[durations.length - 1] ?? 0) : 0,
      samples: durations.length,
    },
  };
  return {
    summary,
    byProvider: groupBy(events, (event) => event.provider),
    byAgent: groupBy(events, (event) => event.agentId),
    byScenario: groupBy(events, (event) => event.scenario),
    byModel: groupBy(events, (event) => event.modelId),
    byKind: groupBy(events, (event) => event.kind),
  };
}

function csvCell(value: string | number): string {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** metadata-only CSV 导出（绝无 prompt/内容列——事件结构本身就没有）。 */
export function buildUsageCsv(events: readonly UsageEventRecord[]): string {
  const header = [
    "created_at",
    "kind",
    "scenario",
    "provider",
    "agent_id",
    "model_id",
    "effort",
    "status",
    "error_kind",
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "duration_ms",
    "cost_usd_estimate",
  ];
  const lines = [header.join(",")];
  for (const event of events) {
    const cost = estimateEventCostUsd(
      event.modelId,
      event.inputTokens,
      event.outputTokens,
    );
    lines.push(
      [
        event.createdAt,
        event.kind,
        event.scenario,
        event.provider,
        event.agentId,
        event.modelId,
        event.effort,
        event.status,
        event.errorKind,
        event.inputTokens,
        event.outputTokens,
        event.reasoningTokens,
        event.durationMs,
        cost === null ? "" : cost.toFixed(6),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** 明细分页的 metadata-only 投影（剔除 ownerUserId 等内部字段后形状即全部）。 */
export function toUsageDetailRow(
  event: UsageEventRecord,
): Omit<UsageEventRecord, "ownerUserId"> {
  const { ownerUserId: _owner, ...rest } = event;
  return rest;
}
