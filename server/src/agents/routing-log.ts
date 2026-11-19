/**
 * 自适应路由策略持久化与 30 天路由决策日志存储 + 管理员 API（/api/admin/routing/*）。
 *
 * - 运行时幂等建表 `chisabot_routing_policy`（单行策略）与 `chisabot_routing_logs`（30 天自动清理）；
 * - 路由日志仅存脱敏任务摘要、难度、命中模型、思考强度、来源、置信度、耗时与降级原因；
 * - 提供 PG 与纯内存双实现，方便无外部数据库运行单元测试。
 */

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  type AdaptiveRoutingPolicy,
  AdaptiveRoutingValidationError,
  defaultAdaptiveRoutingPolicy,
  isResolvedReasoningEffort,
  isTaskDifficulty,
  type RoutingDecisionSource,
  type RoutingLogEntry,
  type RoutingProviderKind,
  type TaskDifficulty,
  validateAdaptiveRoutingPolicy,
} from "../../../shared/model-routing";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import {
  type AdaptiveRouter,
  type RoutingDecisionLogPayload,
  redactRoutingText,
} from "./adaptive-router";

export const ROUTING_LOG_RETENTION_DAYS = 30;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type RoutingLogQuery = {
  limit?: number;
  difficulty?: TaskDifficulty;
  source?: RoutingDecisionSource;
};

export type RoutingLogStorage = {
  ensure(): Promise<void>;
  readPolicy(fallbackModel?: string): Promise<AdaptiveRoutingPolicy>;
  writePolicy(
    policy: AdaptiveRoutingPolicy,
    actorId: string,
  ): Promise<AdaptiveRoutingPolicy>;
  appendLog(
    entry: RoutingDecisionLogPayload & { createdAt?: Date },
  ): Promise<RoutingLogEntry>;
  listLogs(query?: RoutingLogQuery): Promise<{
    items: RoutingLogEntry[];
    total: number;
  }>;
  pruneOlderThan(days?: number, nowMs?: number): Promise<number>;
};

export type RoutingDatabaseClient = {
  $client: Pick<Database["$client"], "unsafe">;
};

type PolicyRow = {
  policy_json: string | AdaptiveRoutingPolicy;
  updated_at: Date | string | null;
  updated_by: string | null;
};

type LogRow = {
  id: string;
  created_at: Date | string;
  task_summary: string;
  difficulty: string;
  model: string;
  effort: string;
  source: string;
  confidence: number | string;
  elapsed_ms: number | string;
  classifier_model: string | null;
  fallback_reason: string | null;
  dry_run: boolean;
};

const VALID_SOURCES = new Set<RoutingDecisionSource>([
  "rule",
  "classifier",
  "manual",
  "fallback",
]);

function normalizeSource(value: string): RoutingDecisionSource {
  return VALID_SOURCES.has(value as RoutingDecisionSource)
    ? (value as RoutingDecisionSource)
    : "rule";
}

function mapLogRow(row: LogRow): RoutingLogEntry {
  const confidenceNum = Number(row.confidence);
  const elapsedNum = Number(row.elapsed_ms);
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    taskSummary: row.task_summary,
    difficulty: isTaskDifficulty(row.difficulty) ? row.difficulty : "reasoning",
    model: row.model,
    effort: isResolvedReasoningEffort(row.effort) ? row.effort : "default",
    source: normalizeSource(row.source),
    confidence: Number.isFinite(confidenceNum) ? confidenceNum : 0,
    elapsedMs: Number.isFinite(elapsedNum)
      ? Math.max(0, Math.round(elapsedNum))
      : 0,
    classifierModel: row.classifier_model ?? null,
    fallbackReason: row.fallback_reason ?? null,
    dryRun: Boolean(row.dry_run),
  };
}

export function createPgRoutingLogStorage(
  database: RoutingDatabaseClient,
  options?: { now?: () => number },
): RoutingLogStorage {
  const sql = database.$client;
  const nowFn = options?.now ?? Date.now;
  let lastPruneAt = 0;

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_routing_policy (
        id text PRIMARY KEY DEFAULT 'default',
        policy_json text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
      CREATE TABLE IF NOT EXISTS chisabot_routing_logs (
        id text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        task_summary text NOT NULL DEFAULT '',
        difficulty text NOT NULL,
        model text NOT NULL,
        effort text NOT NULL,
        source text NOT NULL,
        confidence double precision NOT NULL DEFAULT 0,
        elapsed_ms integer NOT NULL DEFAULT 0,
        classifier_model text,
        fallback_reason text,
        dry_run boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS idx_chisabot_routing_logs_created_at
        ON chisabot_routing_logs (created_at DESC);
    `);
  }

  async function readPolicy(
    fallbackModel = "",
  ): Promise<AdaptiveRoutingPolicy> {
    const rows = await sql.unsafe<PolicyRow[]>(
      "SELECT policy_json, updated_at, updated_by FROM chisabot_routing_policy WHERE id = 'default'",
    );
    const row = rows[0];
    if (!row) {
      return defaultAdaptiveRoutingPolicy(fallbackModel);
    }
    try {
      const parsed: unknown =
        typeof row.policy_json === "string"
          ? JSON.parse(row.policy_json)
          : row.policy_json;
      const validated = validateAdaptiveRoutingPolicy(parsed, fallbackModel);
      return {
        ...validated,
        updatedAt: row.updated_at
          ? new Date(row.updated_at).toISOString()
          : null,
        updatedBy: row.updated_by ?? null,
      };
    } catch {
      return defaultAdaptiveRoutingPolicy(fallbackModel);
    }
  }

  async function writePolicy(
    policy: AdaptiveRoutingPolicy,
    actorId: string,
  ): Promise<AdaptiveRoutingPolicy> {
    const now = new Date(nowFn());
    const stored: AdaptiveRoutingPolicy = {
      ...policy,
      updatedAt: now.toISOString(),
      updatedBy: actorId,
    };
    await sql.unsafe(
      `INSERT INTO chisabot_routing_policy (id, policy_json, updated_at, updated_by)
       VALUES ('default', $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         policy_json = $1,
         updated_at = $2,
         updated_by = $3`,
      [JSON.stringify(stored), now.toISOString(), actorId],
    );
    return stored;
  }

  async function pruneOlderThan(
    days = ROUTING_LOG_RETENTION_DAYS,
    nowMs = nowFn(),
  ): Promise<number> {
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
    const removed = await sql.unsafe<{ id: string }[]>(
      "DELETE FROM chisabot_routing_logs WHERE created_at < $1 RETURNING id",
      [cutoff],
    );
    lastPruneAt = nowMs;
    return removed.length;
  }

  async function appendLog(
    entry: RoutingDecisionLogPayload & { createdAt?: Date },
  ): Promise<RoutingLogEntry> {
    const id = randomUUID();
    const createdAt = entry.createdAt ?? new Date(nowFn());
    const summary = redactRoutingText(entry.taskSummary, 240);
    const fallbackReason = entry.fallbackReason
      ? redactRoutingText(entry.fallbackReason, 160)
      : null;

    await sql.unsafe(
      `INSERT INTO chisabot_routing_logs (
         id, created_at, task_summary, difficulty, model, effort, source,
         confidence, elapsed_ms, classifier_model, fallback_reason, dry_run
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        createdAt.toISOString(),
        summary,
        entry.difficulty,
        entry.model,
        entry.effort,
        entry.source,
        entry.confidence,
        Math.max(0, Math.round(entry.elapsedMs)),
        entry.classifierModel,
        fallbackReason,
        entry.dryRun,
      ],
    );

    const nowMs = nowFn();
    if (nowMs - lastPruneAt >= PRUNE_INTERVAL_MS) {
      await pruneOlderThan(ROUTING_LOG_RETENTION_DAYS, nowMs).catch(() => {});
    }

    return {
      id,
      createdAt: createdAt.toISOString(),
      taskSummary: summary,
      difficulty: entry.difficulty,
      model: entry.model,
      effort: entry.effort,
      source: entry.source,
      confidence: entry.confidence,
      elapsedMs: Math.max(0, Math.round(entry.elapsedMs)),
      classifierModel: entry.classifierModel,
      fallbackReason,
      dryRun: entry.dryRun,
    };
  }

  async function listLogs(query?: RoutingLogQuery): Promise<{
    items: RoutingLogEntry[];
    total: number;
  }> {
    const limit = Math.min(
      MAX_LOG_LIMIT,
      Math.max(1, Math.floor(query?.limit ?? DEFAULT_LOG_LIMIT)),
    );
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query?.difficulty) {
      params.push(query.difficulty);
      clauses.push(`difficulty = $${params.length}`);
    }
    if (query?.source) {
      params.push(query.source);
      clauses.push(`source = $${params.length}`);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const countRows = await sql.unsafe<{ total: string | number }[]>(
      `SELECT count(*) AS total FROM chisabot_routing_logs ${whereSql}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);
    params.push(limit);
    const rows = await sql.unsafe<LogRow[]>(
      `SELECT id, created_at, task_summary, difficulty, model, effort, source,
              confidence, elapsed_ms, classifier_model, fallback_reason, dry_run
       FROM chisabot_routing_logs
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return {
      items: rows.map(mapLogRow),
      total: Number.isFinite(total) ? total : rows.length,
    };
  }

  return {
    ensure,
    readPolicy,
    writePolicy,
    appendLog,
    listLogs,
    pruneOlderThan,
  };
}

export function createMemoryRoutingLogStorage(options?: {
  now?: () => number;
}): RoutingLogStorage {
  const nowFn = options?.now ?? Date.now;
  let savedPolicy: AdaptiveRoutingPolicy | null = null;
  let logs: RoutingLogEntry[] = [];

  return {
    async ensure() {},
    async readPolicy(fallbackModel = "") {
      if (!savedPolicy) {
        return defaultAdaptiveRoutingPolicy(fallbackModel);
      }
      return structuredClone(savedPolicy);
    },
    async writePolicy(policy, actorId) {
      savedPolicy = structuredClone({
        ...policy,
        updatedAt: new Date(nowFn()).toISOString(),
        updatedBy: actorId,
      });
      return structuredClone(savedPolicy);
    },
    async appendLog(entry) {
      const createdAt = entry.createdAt ?? new Date(nowFn());
      const record: RoutingLogEntry = {
        id: randomUUID(),
        createdAt: createdAt.toISOString(),
        taskSummary: redactRoutingText(entry.taskSummary, 240),
        difficulty: entry.difficulty,
        model: entry.model,
        effort: entry.effort,
        source: entry.source,
        confidence: entry.confidence,
        elapsedMs: Math.max(0, Math.round(entry.elapsedMs)),
        classifierModel: entry.classifierModel,
        fallbackReason: entry.fallbackReason
          ? redactRoutingText(entry.fallbackReason, 160)
          : null,
        dryRun: entry.dryRun,
      };
      logs.push(record);
      const cutoffMs = nowFn() - ROUTING_LOG_RETENTION_DAYS * 86_400_000;
      logs = logs.filter((item) => Date.parse(item.createdAt) >= cutoffMs);
      return { ...record };
    },
    async listLogs(query) {
      const limit = Math.min(
        MAX_LOG_LIMIT,
        Math.max(1, Math.floor(query?.limit ?? DEFAULT_LOG_LIMIT)),
      );
      const filtered = logs
        .filter(
          (item) =>
            (!query?.difficulty || item.difficulty === query.difficulty) &&
            (!query?.source || item.source === query.source),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        items: filtered.slice(0, limit).map((item) => ({ ...item })),
        total: filtered.length,
      };
    },
    async pruneOlderThan(days = ROUTING_LOG_RETENTION_DAYS, nowMs = nowFn()) {
      const cutoffMs = nowMs - days * 86_400_000;
      const before = logs.length;
      logs = logs.filter((item) => Date.parse(item.createdAt) >= cutoffMs);
      return before - logs.length;
    },
  };
}

const dryRunRequestSchema = z
  .object({
    text: z
      .string({ error: "请输入需要试跑的任务文本。" })
      .trim()
      .min(1, "试跑文本不能为空。")
      .max(16_000, "试跑文本过长（最多 16,000 字符）。"),
    providerKind: z
      .enum(["openai", "anthropic", "deepseek", "openai-compatible"])
      .optional(),
    recordLog: z.boolean().optional(),
  })
  .strict();

export function createRoutingAdminRoutes(options: {
  storage: RoutingLogStorage;
  router: AdaptiveRouter;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  getDefaultModel?: () => Promise<string> | string;
  getProviderKind?: () => Promise<RoutingProviderKind> | RoutingProviderKind;
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.use("*", options.requireUser);
  routes.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/policy", async (context) => {
    try {
      const fallbackModel = (await options.getDefaultModel?.()) ?? "";
      const policy = await options.storage.readPolicy(fallbackModel);
      return context.json({ policy });
    } catch {
      return context.json(
        { error: "自适应路由策略暂时无法读取，请稍后重试。" },
        503,
      );
    }
  });

  routes.put(
    "/policy",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json({ error: "路由策略请求体过大。" }, 413),
    }),
    async (context) => {
      const body: unknown = await context.req.json().catch(() => null);
      try {
        const fallbackModel = (await options.getDefaultModel?.()) ?? "";
        const validated = validateAdaptiveRoutingPolicy(body, fallbackModel);
        const saved = await options.storage.writePolicy(
          validated,
          context.var.actor.id,
        );
        options.router.clearCache();
        return context.json({ policy: saved });
      } catch (error) {
        if (error instanceof AdaptiveRoutingValidationError) {
          return context.json({ error: error.message }, 400);
        }
        return context.json(
          { error: "自适应路由策略暂时无法保存，请稍后重试。" },
          503,
        );
      }
    },
  );

  routes.get("/logs", async (context) => {
    const rawLimit = context.req.query("limit");
    const parsedLimit = rawLimit ? Number(rawLimit) : DEFAULT_LOG_LIMIT;
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(MAX_LOG_LIMIT, Math.floor(parsedLimit))
        : DEFAULT_LOG_LIMIT;
    const rawDifficulty = context.req.query("difficulty");
    const rawSource = context.req.query("source");
    const difficulty = isTaskDifficulty(rawDifficulty)
      ? rawDifficulty
      : undefined;
    const source =
      rawSource && VALID_SOURCES.has(rawSource as RoutingDecisionSource)
        ? (rawSource as RoutingDecisionSource)
        : undefined;
    try {
      const result = await options.storage.listLogs({
        limit,
        ...(difficulty ? { difficulty } : {}),
        ...(source ? { source } : {}),
      });
      return context.json(result);
    } catch {
      return context.json(
        { error: "路由决策日志暂时无法读取，请稍后重试。" },
        503,
      );
    }
  });

  routes.post(
    "/dry-run",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (context) => context.json({ error: "试跑请求体过大。" }, 413),
    }),
    async (context) => {
      const rawBody: unknown = await context.req.json().catch(() => null);
      const parsed = dryRunRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        return context.json(
          { error: parsed.error.issues[0]?.message ?? "试跑请求参数无效。" },
          400,
        );
      }
      try {
        const fallbackModel = (await options.getDefaultModel?.()) ?? "";
        const providerKind =
          parsed.data.providerKind ??
          (await options.getProviderKind?.()) ??
          "openai-compatible";
        const result = await options.router.dryRunRoute({
          text: parsed.data.text,
          fallbackModel,
          providerKind,
          recordLog: parsed.data.recordLog ?? true,
        });
        return context.json({ result });
      } catch {
        return context.json({ error: "路由试跑失败，请检查配置后重试。" }, 503);
      }
    },
  );

  return routes;
}
