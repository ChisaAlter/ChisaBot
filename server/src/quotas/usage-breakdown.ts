/**
 * 本地时区 + 按用途（kind）+ 思考 Token（reasoning）细分用量账本与 API（GET /api/usage/breakdown?tz=...）。
 *
 * - 运行时幂等建表 `chisabot_usage_events`，不改动 Drizzle 旧表结构；
 * - 严格按用户 IANA 本地时区切分自然日，避免 UTC 零点与本地作息错位；
 * - 单独计量 `reasoning_tokens`，区分 `chat | summary | classifier | review | test` 五类用途；
 * - 提供 PG 与内存双存储实现，便于无库单元测试。
 */

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  USAGE_KINDS,
  type UsageBreakdownResponse,
  type UsageBucketTotals,
  type UsageDayBreakdown,
  type UsageKind,
  type UsageModelBreakdown,
  type UsageWindowBreakdown,
} from "../../../shared/admin-workbench";
import {
  isResolvedReasoningEffort,
  type ResolvedReasoningEffort,
} from "../../../shared/model-routing";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";

export type UsageEventInput = {
  ownerUserId: string;
  kind?: UsageKind;
  modelId: string;
  effort?: ResolvedReasoningEffort | string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  createdAt?: Date | number;
};

export type UsageEventRecord = {
  id: string;
  ownerUserId: string;
  kind: UsageKind;
  modelId: string;
  effort: ResolvedReasoningEffort;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  createdAt: string;
};

export type UsageAggregateRow = {
  localDay: string;
  kind: UsageKind;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
};

export type UsageBreakdownStorage = {
  ensure(): Promise<void>;
  insertEvent(input: UsageEventInput): Promise<UsageEventRecord>;
  listEventsSince(
    ownerUserId: string,
    sinceIso: string,
  ): Promise<UsageEventRecord[]>;
  /** 可选 SQL 下推聚合接口：按 `(created_at AT TIME ZONE tz)::date, kind, model_id` 返回窗口内预聚合行。 */
  aggregateSince?(
    ownerUserId: string,
    sinceIso: string,
    timeZone: string,
    startDay: string,
    endDay: string,
  ): Promise<UsageAggregateRow[]>;
};

export type UsageBreakdownDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

export class UsageTimeZoneError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "UsageTimeZoneError";
  }
}

const VALID_KINDS = new Set<UsageKind>(USAGE_KINDS);

function clampInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function normalizeKind(raw: unknown): UsageKind {
  return typeof raw === "string" && VALID_KINDS.has(raw as UsageKind)
    ? (raw as UsageKind)
    : "chat";
}

function normalizeEffort(raw: unknown): ResolvedReasoningEffort {
  return isResolvedReasoningEffort(raw) ? raw : "default";
}

/** 校验 IANA 时区字符串；省略时默认 "UTC"，非法时抛出 UsageTimeZoneError（400）。 */
export function validateTimeZone(raw?: string | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "UTC";
  if (trimmed.length > 64) {
    throw new UsageTimeZoneError("时区名称过长。");
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: trimmed });
    return trimmed;
  } catch {
    throw new UsageTimeZoneError(
      `无效的 IANA 时区标识：${trimmed}（示例：Asia/Shanghai、UTC、America/New_York）。`,
    );
  }
}

/** 将时间戳按指定 IANA 时区格式化为本地自然日 YYYY-MM-DD。 */
export function formatLocalDay(timestampMs: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(timestampMs));
}

/** 对 YYYY-MM-DD 日历日期做纯天数平移（不受夏令时 23/25 小时影响）。 */
export function shiftCalendarDay(day: string, deltaDays: number): string {
  const parts = day.split("-").map((segment) => Number(segment));
  const year = parts[0] ?? 1970;
  const month = parts[1] ?? 1;
  const date = parts[2] ?? 1;
  const shifted = new Date(Date.UTC(year, month - 1, date + deltaDays));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function emptyBucket(): UsageBucketTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
}

function addEventToBucket(
  target: UsageBucketTotals,
  event: UsageEventRecord,
): void {
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.reasoningTokens += event.reasoningTokens;
  target.totalTokens += event.inputTokens + event.outputTokens;
  target.requests += 1;
}

function addAggregateToBucket(
  target: UsageBucketTotals,
  agg: UsageAggregateRow,
): void {
  target.inputTokens += agg.inputTokens;
  target.outputTokens += agg.outputTokens;
  target.reasoningTokens += agg.reasoningTokens;
  target.totalTokens += agg.inputTokens + agg.outputTokens;
  target.requests += agg.requests;
}

function finalizeWindow(
  startDay: string,
  endDay: string,
  totals: UsageBucketTotals,
  byKind: Record<UsageKind, UsageBucketTotals>,
  byModelMap: Map<string, UsageModelBreakdown>,
  byDayMap: Map<string, UsageDayBreakdown>,
): UsageWindowBreakdown {
  const byModel = [...byModelMap.values()].sort(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      left.modelId.localeCompare(right.modelId),
  );
  const byDay = [...byDayMap.values()].sort((left, right) =>
    left.day.localeCompare(right.day),
  );

  return {
    startDay,
    endDay,
    totals,
    byKind,
    byModel,
    byDay,
  };
}

function emptyByKind(): Record<UsageKind, UsageBucketTotals> {
  return Object.fromEntries(
    USAGE_KINDS.map((kind) => [kind, emptyBucket()]),
  ) as Record<UsageKind, UsageBucketTotals>;
}

function aggregateWindow(
  events: readonly { event: UsageEventRecord; localDay: string }[],
  startDay: string,
  endDay: string,
): UsageWindowBreakdown {
  const totals = emptyBucket();
  const byKind = emptyByKind();
  const byModelMap = new Map<string, UsageModelBreakdown>();
  const byDayMap = new Map<string, UsageDayBreakdown>();

  for (const item of events) {
    if (item.localDay < startDay || item.localDay > endDay) continue;
    const { event, localDay } = item;
    addEventToBucket(totals, event);
    addEventToBucket(byKind[event.kind], event);

    let modelEntry = byModelMap.get(event.modelId);
    if (!modelEntry) {
      modelEntry = { modelId: event.modelId, ...emptyBucket() };
      byModelMap.set(event.modelId, modelEntry);
    }
    addEventToBucket(modelEntry, event);

    let dayEntry = byDayMap.get(localDay);
    if (!dayEntry) {
      dayEntry = { day: localDay, ...emptyBucket() };
      byDayMap.set(localDay, dayEntry);
    }
    addEventToBucket(dayEntry, event);
  }

  return finalizeWindow(startDay, endDay, totals, byKind, byModelMap, byDayMap);
}

function aggregateWindowFromAggregates(
  aggregates: readonly UsageAggregateRow[],
  startDay: string,
  endDay: string,
): UsageWindowBreakdown {
  const totals = emptyBucket();
  const byKind = emptyByKind();
  const byModelMap = new Map<string, UsageModelBreakdown>();
  const byDayMap = new Map<string, UsageDayBreakdown>();

  for (const agg of aggregates) {
    if (agg.localDay < startDay || agg.localDay > endDay) continue;
    if (agg.requests <= 0) continue;
    addAggregateToBucket(totals, agg);
    addAggregateToBucket(byKind[agg.kind], agg);

    let modelEntry = byModelMap.get(agg.modelId);
    if (!modelEntry) {
      modelEntry = { modelId: agg.modelId, ...emptyBucket() };
      byModelMap.set(agg.modelId, modelEntry);
    }
    addAggregateToBucket(modelEntry, agg);

    let dayEntry = byDayMap.get(agg.localDay);
    if (!dayEntry) {
      dayEntry = { day: agg.localDay, ...emptyBucket() };
      byDayMap.set(agg.localDay, dayEntry);
    }
    addAggregateToBucket(dayEntry, agg);
  }

  return finalizeWindow(startDay, endDay, totals, byKind, byModelMap, byDayMap);
}

/** 纯聚合函数：基于 SQL 端按 `(local_day, kind, model_id)` 预聚合结果组装今日 / 近 7 天 / 近 30 天视图。 */
export function buildUsageBreakdownFromAggregates(
  aggregates: readonly UsageAggregateRow[],
  timeZone: string,
  nowMs = Date.now(),
): UsageBreakdownResponse {
  const validTz = validateTimeZone(timeZone);
  const todayDay = formatLocalDay(nowMs, validTz);
  const last7Start = shiftCalendarDay(todayDay, -6);
  const last30Start = shiftCalendarDay(todayDay, -29);

  return {
    timeZone: validTz,
    generatedAt: new Date(nowMs).toISOString(),
    today: aggregateWindowFromAggregates(aggregates, todayDay, todayDay),
    last7Days: aggregateWindowFromAggregates(aggregates, last7Start, todayDay),
    last30Days: aggregateWindowFromAggregates(
      aggregates,
      last30Start,
      todayDay,
    ),
  };
}

/** 纯聚合函数：按用户 IANA 本地时区切分今日 / 近 7 天 / 近 30 天细分用量。 */
export function buildUsageBreakdown(
  events: readonly UsageEventRecord[],
  timeZone: string,
  nowMs = Date.now(),
): UsageBreakdownResponse {
  const validTz = validateTimeZone(timeZone);
  const todayDay = formatLocalDay(nowMs, validTz);
  const last7Start = shiftCalendarDay(todayDay, -6);
  const last30Start = shiftCalendarDay(todayDay, -29);

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localized: { event: UsageEventRecord; localDay: string }[] = [];
  for (const event of events) {
    const parsedMs = Date.parse(event.createdAt);
    if (!Number.isFinite(parsedMs)) continue;
    localized.push({
      event,
      localDay: formatter.format(new Date(parsedMs)),
    });
  }

  return {
    timeZone: validTz,
    generatedAt: new Date(nowMs).toISOString(),
    today: aggregateWindow(localized, todayDay, todayDay),
    last7Days: aggregateWindow(localized, last7Start, todayDay),
    last30Days: aggregateWindow(localized, last30Start, todayDay),
  };
}

type UsageEventRow = {
  id: string;
  owner_user_id: string;
  kind: string;
  model_id: string;
  effort: string;
  input_tokens: number | string;
  output_tokens: number | string;
  reasoning_tokens: number | string;
  created_at: Date | string;
};

function mapEventRow(row: UsageEventRow): UsageEventRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    kind: normalizeKind(row.kind),
    modelId: row.model_id,
    effort: normalizeEffort(row.effort),
    inputTokens: clampInt(Number(row.input_tokens)),
    outputTokens: clampInt(Number(row.output_tokens)),
    reasoningTokens: clampInt(Number(row.reasoning_tokens)),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

type UsageAggregateDbRow = {
  local_day: string;
  kind: string;
  model_id: string;
  input_tokens: number | string;
  output_tokens: number | string;
  reasoning_tokens: number | string;
  requests: number | string;
};

function mapAggregateRow(row: UsageAggregateDbRow): UsageAggregateRow {
  return {
    localDay: String(row.local_day),
    kind: normalizeKind(row.kind),
    modelId: row.model_id,
    inputTokens: clampInt(Number(row.input_tokens)),
    outputTokens: clampInt(Number(row.output_tokens)),
    reasoningTokens: clampInt(Number(row.reasoning_tokens)),
    requests: clampInt(Number(row.requests)),
  };
}

export function createPgUsageBreakdownStorage(
  database: UsageBreakdownDatabase,
  options?: { now?: () => number },
): UsageBreakdownStorage {
  const sql = database.$client;
  const nowFn = options?.now ?? Date.now;

  return {
    async ensure() {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS chisabot_usage_events (
          id text PRIMARY KEY,
          owner_user_id text NOT NULL,
          kind text NOT NULL DEFAULT 'chat',
          model_id text NOT NULL,
          effort text NOT NULL DEFAULT 'default',
          input_tokens bigint NOT NULL DEFAULT 0,
          output_tokens bigint NOT NULL DEFAULT 0,
          reasoning_tokens bigint NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_chisabot_usage_events_user_created
          ON chisabot_usage_events (owner_user_id, created_at DESC);
      `);
    },

    async insertEvent(input) {
      const id = randomUUID();
      const createdAtMs =
        input.createdAt instanceof Date
          ? input.createdAt.getTime()
          : typeof input.createdAt === "number"
            ? input.createdAt
            : nowFn();
      const record: UsageEventRecord = {
        id,
        ownerUserId: input.ownerUserId.trim(),
        kind: normalizeKind(input.kind),
        modelId: input.modelId.trim() || "unknown",
        effort: normalizeEffort(input.effort),
        inputTokens: clampInt(input.inputTokens),
        outputTokens: clampInt(input.outputTokens),
        reasoningTokens: clampInt(input.reasoningTokens ?? 0),
        createdAt: new Date(createdAtMs).toISOString(),
      };
      await sql.unsafe(
        `INSERT INTO chisabot_usage_events (
           id, owner_user_id, kind, model_id, effort,
           input_tokens, output_tokens, reasoning_tokens, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.ownerUserId,
          record.kind,
          record.modelId,
          record.effort,
          record.inputTokens,
          record.outputTokens,
          record.reasoningTokens,
          record.createdAt,
        ],
      );
      return record;
    },

    async listEventsSince(ownerUserId, sinceIso) {
      const rows = await sql.unsafe<UsageEventRow[]>(
        `SELECT id, owner_user_id, kind, model_id, effort,
                input_tokens, output_tokens, reasoning_tokens, created_at
         FROM chisabot_usage_events
         WHERE owner_user_id = $1 AND created_at >= $2
         ORDER BY created_at DESC`,
        [ownerUserId, sinceIso],
      );
      return rows.map(mapEventRow);
    },

    async aggregateSince(ownerUserId, sinceIso, timeZone, startDay, endDay) {
      const validTz = validateTimeZone(timeZone);
      const rows = await sql.unsafe<UsageAggregateDbRow[]>(
        `SELECT to_char((created_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS local_day,
                kind,
                model_id,
                COALESCE(SUM(GREATEST(input_tokens, 0)), 0)::bigint AS input_tokens,
                COALESCE(SUM(GREATEST(output_tokens, 0)), 0)::bigint AS output_tokens,
                COALESCE(SUM(GREATEST(reasoning_tokens, 0)), 0)::bigint AS reasoning_tokens,
                COUNT(*)::bigint AS requests
         FROM chisabot_usage_events
         WHERE owner_user_id = $1
           AND created_at >= $2
           AND (created_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date
         GROUP BY 1, 2, 3`,
        [ownerUserId, sinceIso, validTz, startDay, endDay],
      );
      return rows.map(mapAggregateRow);
    },
  };
}

export function createMemoryUsageBreakdownStorage(options?: {
  now?: () => number;
}): UsageBreakdownStorage {
  const nowFn = options?.now ?? Date.now;
  const rows: UsageEventRecord[] = [];

  return {
    async ensure() {},
    async insertEvent(input) {
      const createdAtMs =
        input.createdAt instanceof Date
          ? input.createdAt.getTime()
          : typeof input.createdAt === "number"
            ? input.createdAt
            : nowFn();
      const record: UsageEventRecord = {
        id: randomUUID(),
        ownerUserId: input.ownerUserId.trim(),
        kind: normalizeKind(input.kind),
        modelId: input.modelId.trim() || "unknown",
        effort: normalizeEffort(input.effort),
        inputTokens: clampInt(input.inputTokens),
        outputTokens: clampInt(input.outputTokens),
        reasoningTokens: clampInt(input.reasoningTokens ?? 0),
        createdAt: new Date(createdAtMs).toISOString(),
      };
      rows.push(record);
      return { ...record };
    },
    async listEventsSince(ownerUserId, sinceIso) {
      const cutoffMs = Date.parse(sinceIso);
      return rows
        .filter(
          (row) =>
            row.ownerUserId === ownerUserId &&
            Date.parse(row.createdAt) >= cutoffMs,
        )
        .map((row) => ({ ...row }));
    },
  };
}

export type UsageBreakdownService = {
  ensure(): Promise<void>;
  record(input: UsageEventInput): Promise<UsageEventRecord | null>;
  breakdown(
    ownerUserId: string,
    timeZone?: string | null,
    nowMs?: number,
  ): Promise<UsageBreakdownResponse>;
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
};

export function createUsageBreakdownService(
  storage: UsageBreakdownStorage,
  options?: { now?: () => number },
): UsageBreakdownService {
  const nowFn = options?.now ?? Date.now;

  const service: UsageBreakdownService = {
    ensure: () => storage.ensure(),
    async record(input) {
      if (!input.ownerUserId.trim()) return null;
      return storage.insertEvent(input);
    },
    async breakdown(ownerUserId, timeZone, nowMs = nowFn()) {
      const validTz = validateTimeZone(timeZone);
      // 回溯 32 个完整自然日（UTC+14 到 UTC-12 的最大边界缓冲），确保 30 天本地窗口零遗漏。
      const sinceIso = new Date(nowMs - 32 * 86_400_000).toISOString();
      if (storage.aggregateSince) {
        const todayDay = formatLocalDay(nowMs, validTz);
        const last30Start = shiftCalendarDay(todayDay, -29);
        try {
          const aggregates = await storage.aggregateSince(
            ownerUserId,
            sinceIso,
            validTz,
            last30Start,
            todayDay,
          );
          return buildUsageBreakdownFromAggregates(aggregates, validTz, nowMs);
        } catch (error) {
          // 极少数仅 ICU 支持但 PG tzdata 未收录的时区别名（SQLSTATE 22023）平滑回退至明细聚合。
          if ((error as { code?: unknown } | null)?.code !== "22023") {
            throw error;
          }
        }
      }
      const events = await storage.listEventsSince(ownerUserId, sinceIso);
      return buildUsageBreakdown(events, validTz, nowMs);
    },
    routes(requireUser) {
      const routes = new Hono<{ Variables: AppVariables }>();
      routes.use("*", requireUser);
      routes.get("/breakdown", async (context) => {
        context.header("Cache-Control", "no-store");
        const tz = context.req.query("tz");
        const requestedUserId = context.req.query("userId")?.trim();
        const actor = context.var.actor;
        // 非管理员严格锁定只看自己；管理员若显式传 userId 可查看指定用户。
        const targetUserId =
          actor.role === "admin" && requestedUserId
            ? requestedUserId
            : actor.id;
        try {
          const breakdown = await service.breakdown(targetUserId, tz);
          return context.json({ breakdown });
        } catch (error) {
          if (error instanceof UsageTimeZoneError) {
            return context.json({ error: error.message }, 400);
          }
          return context.json(
            { error: "细分用量统计暂时无法读取，请稍后重试。" },
            503,
          );
        }
      });
      return routes;
    },
  };

  return service;
}
