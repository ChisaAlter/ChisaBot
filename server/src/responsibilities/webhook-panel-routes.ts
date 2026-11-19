import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  WEBHOOK_RULE_QUOTA_PER_USER,
  WEBHOOK_RUN_STATUSES,
  WEBHOOK_TRIGGER_KINDS,
  type WebhookRuleView,
  type WebhookRunStatus,
  type WebhookRunView,
  type WebhookTriggerKind,
} from "../../../shared/webhooks";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { RESPONSIBILITY_RUN_KIND } from "./engine";
import {
  type TriggerConfig,
  type TriggerRecord,
  type TriggerStore,
  triggerFilterSchema,
} from "./triggers";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilityStore,
} from "./types";

/**
 * 面向用户的多 Webhook 规则与 7 态执行流水管理面板路由（挂载于 `/api/webhooks`）。
 *
 * - 完全复用已有 5 厂商签名族强后端（`responsibilities/{triggers,signatures,trigger-routes}.ts`）。
 * - 配额与速率限制严格按主体 `actor.id` 计数（per-principal，绝不按 socket IP 共享桶）。
 * - 创建与重置密钥仅一次性返回明文（`Cache-Control: no-store`），列表接口永不回显密钥。
 * - 关闭开关或删除规则时自动取消该规则下所有 `queued` 排队任务与 `work_items`，避免误触发。
 * - 运行流水统一投影为 7 态：`queued | running | completed | failed | interrupted | cancelled | skipped`。
 */

export const WEBHOOK_CANCELLED_PREFIX = "cancelled:";
export const DEFAULT_WEBHOOK_RATE_LIMIT = 30;
export const DEFAULT_WEBHOOK_RATE_WINDOW_MS = 60_000;

export type PrincipalRateLimiter = {
  check(principalId: string): { allowed: boolean; retryAfterSeconds: number };
};

/** 按用户主体（actor.id）计数的滑动窗口限流器，避免代理/隧道下所有流量折成 127.0.0.1 互相挤爆。 */
export function createPrincipalRateLimiter(
  options: { maxRequests?: number; windowMs?: number; now?: () => number } = {},
): PrincipalRateLimiter {
  const maxRequests = Math.max(
    1,
    options.maxRequests ?? DEFAULT_WEBHOOK_RATE_LIMIT,
  );
  const windowMs = Math.max(
    1_000,
    options.windowMs ?? DEFAULT_WEBHOOK_RATE_WINDOW_MS,
  );
  const now = options.now ?? Date.now;
  const buckets = new Map<string, number[]>();

  return {
    check(principalId: string) {
      const ts = now();
      const cutoff = ts - windowMs;
      const existing = buckets.get(principalId) ?? [];
      const recent = existing.filter((t) => t > cutoff);
      if (recent.length >= maxRequests) {
        const oldest = recent[0] ?? ts;
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((oldest + windowMs - ts) / 1000),
        );
        buckets.set(principalId, recent);
        return { allowed: false, retryAfterSeconds };
      }
      recent.push(ts);
      buckets.set(principalId, recent);
      // 有界清理防止无上限增长
      if (buckets.size > 4096) {
        for (const [key, list] of buckets) {
          if (list.every((t) => t <= cutoff)) buckets.delete(key);
        }
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

/**
 * 将底层 `responsibility_runs` 的 6 态（queued/running/waiting/succeeded/failed/skipped）
 * 与取消/中断语义统一投影为前端 7 态执行流水。
 */
export function normalizeWebhookRunStatus(input: {
  status: string;
  error?: string | null;
}): WebhookRunStatus {
  const raw = input.status.trim().toLowerCase();
  const err = (input.error ?? "").trim();

  if (raw === "queued") return "queued";
  if (raw === "running" || raw === "waiting") return "running";
  if (raw === "succeeded" || raw === "completed") return "completed";
  if (raw === "interrupted") return "interrupted";
  if (raw === "cancelled" || raw === "canceled") return "cancelled";

  if (raw === "failed") {
    if (
      /worker stopped|interrupted|aborted|kernel restarted|已中断|重启/i.test(
        err,
      )
    ) {
      return "interrupted";
    }
    return "failed";
  }

  if (raw === "skipped") {
    if (
      err.toLowerCase().startsWith(WEBHOOK_CANCELLED_PREFIX) ||
      err.toLowerCase().startsWith("canceled:") ||
      err.startsWith("已取消")
    ) {
      return "cancelled";
    }
    return "skipped";
  }

  return "failed";
}

function emptyStatusCounts(): Record<WebhookRunStatus, number> {
  return {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    skipped: 0,
  };
}

const createWebhookRuleSchema = z
  .object({
    title: z
      .string({ error: "请输入规则名称。" })
      .trim()
      .min(1, "规则名称不能为空。")
      .max(160, "规则名称不能超过 160 个字符。"),
    agentId: z
      .string({ error: "请选择执行机器人。" })
      .trim()
      .min(1, "请选择执行机器人。")
      .max(128),
    instruction: z
      .string({ error: "请输入触发后机器人要执行的指令。" })
      .trim()
      .min(1, "触发指令不能为空。")
      .max(6000, "触发指令不能超过 6000 个字符。"),
    successCriteria: z.string().trim().max(3000).optional(),
    kind: z.enum(WEBHOOK_TRIGGER_KINDS, {
      error: "仅支持 webhook、github、linear、sentry、pagerduty 五类签名族。",
    }),
    repository: z
      .string()
      .trim()
      .regex(/^[\w.-]+\/[\w.-]+$/, "GitHub 仓库格式须为 owner/name。")
      .max(256)
      .optional(),
    eventTypes: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
    fieldFilter: z
      .object({
        path: z
          .string()
          .trim()
          .regex(
            /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,7}$/,
            "字段路径格式如 data.team.key。",
          ),
        equals: z.string().trim().min(1).max(256),
      })
      .strict()
      .optional(),
    secret: z.string().trim().max(4096).optional(),
    responsibilityId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const toggleEnabledSchema = z
  .object({
    enabled: z.boolean({ error: "enabled 必须是布尔值。" }),
  })
  .strict();

const rotateSecretSchema = z
  .object({
    secret: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();

function buildTriggerConfig(
  input: z.infer<typeof createWebhookRuleSchema>,
): TriggerConfig {
  const filter = triggerFilterSchema.parse({
    eventTypes: input.eventTypes ?? [],
    ...(input.fieldFilter ? { field: input.fieldFilter } : {}),
  });
  if (input.kind === "github") {
    return {
      kind: "github",
      ...(input.repository ? { repository: input.repository } : {}),
      filter,
    };
  }
  return {
    kind: input.kind,
    filter,
  };
}

export type WebhookPanelStore = {
  listRules(ownerUserId: string): Promise<WebhookRuleView[]>;
  getRule(
    ownerUserId: string,
    triggerId: string,
  ): Promise<WebhookRuleView | null>;
  createRule(
    actor: AgentActor,
    input: z.infer<typeof createWebhookRuleSchema>,
  ): Promise<{ rule: WebhookRuleView; secret: string | null }>;
  setEnabled(
    ownerUserId: string,
    triggerId: string,
    enabled: boolean,
  ): Promise<{ rule: WebhookRuleView; cancelledRuns: number }>;
  rotateSecret(
    ownerUserId: string,
    triggerId: string,
    pastedSecret?: string,
  ): Promise<{ rule: WebhookRuleView; secret: string | null }>;
  deleteRule(
    ownerUserId: string,
    triggerId: string,
  ): Promise<{ deleted: true; cancelledRuns: number }>;
  listRuns(
    ownerUserId: string,
    filter?: {
      triggerId?: string;
      status?: WebhookRunStatus;
      limit?: number;
    },
  ): Promise<{
    runs: WebhookRunView[];
    counts: Record<WebhookRunStatus, number>;
  }>;
};

type TriggerJoinRow = {
  id: string;
  responsibility_id: string;
  kind: string;
  config: TriggerConfig;
  credential_id: string | null;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  title: string;
  agent_id: string;
  instruction: string;
};

type RunJoinRow = {
  id: string;
  responsibility_id: string;
  status: string;
  reply_text: string | null;
  error: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  rule_title: string;
  source: string;
  event_type: string;
  external_id: string;
};

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoNullable = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

function isWebhookKind(raw: string): raw is WebhookTriggerKind {
  return (WEBHOOK_TRIGGER_KINDS as readonly string[]).includes(raw);
}

function projectRuleRow(row: TriggerJoinRow): WebhookRuleView {
  const kind: WebhookTriggerKind = isWebhookKind(row.kind)
    ? row.kind
    : "webhook";
  const cfg = row.config;
  const filter = cfg && cfg.kind !== "slack" ? cfg.filter : undefined;
  const repository =
    cfg && cfg.kind === "github" && cfg.repository ? cfg.repository : undefined;
  return {
    id: row.id,
    responsibilityId: row.responsibility_id,
    title: row.title,
    agentId: row.agent_id,
    instruction: row.instruction,
    kind,
    enabled: Boolean(row.enabled),
    hasSecret: row.credential_id !== null,
    ingressPath: `/api/events/triggers/${row.id}`,
    ...(repository ? { repository } : {}),
    eventTypes: Array.isArray(filter?.eventTypes) ? [...filter.eventTypes] : [],
    ...(filter?.field ? { fieldFilter: { ...filter.field } } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function projectRuleFromRecord(
  trigger: TriggerRecord,
  meta: { title: string; agentId: string; instruction: string },
): WebhookRuleView {
  const kind: WebhookTriggerKind = isWebhookKind(trigger.kind)
    ? trigger.kind
    : "webhook";
  const cfg = trigger.config;
  const filter = cfg && cfg.kind !== "slack" ? cfg.filter : undefined;
  const repository =
    cfg && cfg.kind === "github" && cfg.repository ? cfg.repository : undefined;
  return {
    id: trigger.id,
    responsibilityId: trigger.responsibilityId,
    title: meta.title,
    agentId: meta.agentId,
    instruction: meta.instruction,
    kind,
    enabled: trigger.enabled,
    hasSecret: trigger.hasSecret,
    ingressPath: `/api/events/triggers/${trigger.id}`,
    ...(repository ? { repository } : {}),
    eventTypes: Array.isArray(filter?.eventTypes) ? [...filter.eventTypes] : [],
    ...(filter?.field ? { fieldFilter: { ...filter.field } } : {}),
    createdAt: trigger.createdAt.toISOString(),
    updatedAt: trigger.updatedAt.toISOString(),
  };
}

function extractTriggerIdFromExternalId(externalId: string): string | null {
  const colon = externalId.indexOf(":");
  if (colon <= 0) return null;
  const prefix = externalId.slice(0, colon);
  return /^[0-9a-f-]{36}$/i.test(prefix) ? prefix : null;
}

/** 基于 PostgreSQL 现有 `responsibilities` / `responsibility_triggers` / `responsibility_runs` 构建面板存储。 */
export function createPgWebhookPanelStore(deps: {
  database: { $client: Pick<Database["$client"], "unsafe"> };
  responsibilities: Pick<ResponsibilityStore, "create" | "get">;
  triggers: Pick<
    TriggerStore,
    "create" | "setEnabled" | "setSecret" | "remove"
  >;
  resolveDirectChannel: (
    actor: AgentActor,
    agentId: string,
  ) => Promise<{ channelId: string }>;
}): WebhookPanelStore {
  const sql = deps.database.$client;

  async function cancelQueuedRunsForTrigger(
    ownerUserId: string,
    triggerId: string,
    responsibilityId: string,
    reason: string,
  ): Promise<number> {
    const cancelledRows = await sql.unsafe<{ id: string }[]>(
      `UPDATE responsibility_runs r
       SET status = 'skipped',
           error = $4,
           finished_at = now()
       FROM responsibility_events e
       WHERE r.event_id = e.id
         AND r.responsibility_id = $1
         AND e.owner_user_id = $2
         AND r.status = 'queued'
         AND e.external_id LIKE $3
       RETURNING r.id`,
      [
        responsibilityId,
        ownerUserId,
        `${triggerId}:%`,
        `${WEBHOOK_CANCELLED_PREFIX}${reason}`,
      ],
    );

    if (cancelledRows.length > 0) {
      const ids = cancelledRows.map((row) => row.id);
      await sql.unsafe(
        `UPDATE work_items
         SET finished_at = now(),
             last_error = 'cancelled',
             updated_at = now()
         WHERE kind = $1
           AND key = ANY($2::text[])
           AND finished_at IS NULL`,
        [RESPONSIBILITY_RUN_KIND, ids],
      );
    }
    return cancelledRows.length;
  }

  async function listRules(ownerUserId: string): Promise<WebhookRuleView[]> {
    const rows = await sql.unsafe<TriggerJoinRow[]>(
      `SELECT t.id, t.responsibility_id, t.kind, t.config, t.credential_id,
              t.enabled, t.created_at, t.updated_at,
              r.title, r.agent_id, r.instruction
       FROM responsibility_triggers t
       INNER JOIN responsibilities r ON r.id = t.responsibility_id
       WHERE t.owner_user_id = $1
         AND t.kind IN ('webhook', 'github', 'linear', 'sentry', 'pagerduty')
       ORDER BY t.created_at DESC
       LIMIT 200`,
      [ownerUserId],
    );
    return rows.map(projectRuleRow);
  }

  async function getRule(
    ownerUserId: string,
    triggerId: string,
  ): Promise<WebhookRuleView | null> {
    const rows = await sql.unsafe<TriggerJoinRow[]>(
      `SELECT t.id, t.responsibility_id, t.kind, t.config, t.credential_id,
              t.enabled, t.created_at, t.updated_at,
              r.title, r.agent_id, r.instruction
       FROM responsibility_triggers t
       INNER JOIN responsibilities r ON r.id = t.responsibility_id
       WHERE t.owner_user_id = $1
         AND t.id = $2
         AND t.kind IN ('webhook', 'github', 'linear', 'sentry', 'pagerduty')
       LIMIT 1`,
      [ownerUserId, triggerId],
    );
    const row = rows[0];
    return row ? projectRuleRow(row) : null;
  }

  return {
    listRules,
    getRule,
    async createRule(actor, input) {
      let responsibilityId = input.responsibilityId;
      let meta = {
        title: input.title,
        agentId: input.agentId,
        instruction: input.instruction,
      };
      if (responsibilityId) {
        const goal = await deps.responsibilities.get(
          actor.id,
          responsibilityId,
        );
        meta = {
          title: goal.title,
          agentId: goal.agentId,
          instruction: goal.instruction,
        };
      } else {
        const direct = await deps.resolveDirectChannel(actor, input.agentId);
        const goal = await deps.responsibilities.create(actor.id, {
          agentId: input.agentId,
          channelId: direct.channelId,
          title: input.title,
          instruction: input.instruction,
          successCriteria:
            input.successCriteria?.trim() ||
            "完成入站 Webhook 事件分析并在对话中输出处理结果。",
          subscriptions: [],
        });
        responsibilityId = goal.id;
        meta = {
          title: goal.title,
          agentId: goal.agentId,
          instruction: goal.instruction,
        };
      }
      const config = buildTriggerConfig(input);
      const created = await deps.triggers.create(actor.id, responsibilityId, {
        config,
        ...(input.secret ? { secret: input.secret } : {}),
      });
      return {
        rule: projectRuleFromRecord(created.trigger, meta),
        secret: created.secret,
      };
    },
    async setEnabled(ownerUserId, triggerId, enabled) {
      const existing = await getRule(ownerUserId, triggerId);
      if (!existing) throw new ResponsibilityNotFoundError();
      const updated = await deps.triggers.setEnabled(
        ownerUserId,
        triggerId,
        enabled,
      );
      const cancelledRuns = !enabled
        ? await cancelQueuedRunsForTrigger(
            ownerUserId,
            triggerId,
            existing.responsibilityId,
            "触发器已停用，排队事件已自动取消。",
          )
        : 0;
      return {
        rule: projectRuleFromRecord(updated, {
          title: existing.title,
          agentId: existing.agentId,
          instruction: existing.instruction,
        }),
        cancelledRuns,
      };
    },
    async rotateSecret(ownerUserId, triggerId, pastedSecret) {
      const existing = await getRule(ownerUserId, triggerId);
      if (!existing) throw new ResponsibilityNotFoundError();
      const rotated = await deps.triggers.setSecret(
        ownerUserId,
        triggerId,
        pastedSecret,
      );
      return {
        rule: projectRuleFromRecord(rotated.trigger, {
          title: existing.title,
          agentId: existing.agentId,
          instruction: existing.instruction,
        }),
        secret: rotated.secret,
      };
    },
    async deleteRule(ownerUserId, triggerId) {
      const existing = await getRule(ownerUserId, triggerId);
      if (!existing) throw new ResponsibilityNotFoundError();
      const cancelledRuns = await cancelQueuedRunsForTrigger(
        ownerUserId,
        triggerId,
        existing.responsibilityId,
        "触发器已删除，排队事件已自动取消。",
      );
      await deps.triggers.remove(ownerUserId, triggerId);
      return { deleted: true, cancelledRuns };
    },
    async listRuns(ownerUserId, filter = {}) {
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
      const rows = await sql.unsafe<RunJoinRow[]>(
        `SELECT r.id, r.responsibility_id, r.status, r.reply_text, r.error,
                r.created_at, r.started_at, r.finished_at,
                g.title AS rule_title,
                e.source, e.type AS event_type, e.external_id
         FROM responsibility_runs r
         INNER JOIN responsibilities g ON g.id = r.responsibility_id
         INNER JOIN responsibility_events e ON e.id = r.event_id
         WHERE g.owner_user_id = $1
           AND e.source IN ('webhook', 'github', 'linear', 'sentry', 'pagerduty')
         ORDER BY r.created_at DESC
         LIMIT 200`,
        [ownerUserId],
      );
      const counts = emptyStatusCounts();
      const projected: WebhookRunView[] = [];
      for (const row of rows) {
        const triggerId = extractTriggerIdFromExternalId(row.external_id);
        if (filter.triggerId && triggerId !== filter.triggerId) continue;
        const normalized = normalizeWebhookRunStatus({
          status: row.status,
          error: row.error,
        });
        counts[normalized] += 1;
        if (filter.status && normalized !== filter.status) continue;
        if (projected.length < limit) {
          const cleanError = row.error?.startsWith(WEBHOOK_CANCELLED_PREFIX)
            ? row.error.slice(WEBHOOK_CANCELLED_PREFIX.length)
            : row.error;
          projected.push({
            id: row.id,
            triggerId,
            responsibilityId: row.responsibility_id,
            ruleTitle: row.rule_title,
            source: row.source,
            eventType: row.event_type,
            status: normalized,
            replyPreview: row.reply_text ? row.reply_text.slice(0, 240) : null,
            error: cleanError ?? null,
            createdAt: iso(row.created_at),
            startedAt: isoNullable(row.started_at),
            finishedAt: isoNullable(row.finished_at),
          });
        }
      }
      return { runs: projected, counts };
    },
  };
}

export function createWebhookPanelRoutes(deps: {
  store: WebhookPanelStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  quotaPerUser?: number;
  rateLimiter?: PrincipalRateLimiter;
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const quotaPerUser = Math.max(
    1,
    deps.quotaPerUser ?? WEBHOOK_RULE_QUOTA_PER_USER,
  );
  const limiter = deps.rateLimiter ?? createPrincipalRateLimiter();

  routes.use("*", deps.requireUser);
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.onError((error, context) => {
    if (error instanceof ResponsibilityNotFoundError) {
      return context.json({ error: "找不到该 Webhook 规则。" }, 404);
    }
    if (error instanceof ResponsibilityRefusedError) {
      return context.json({ error: error.message }, 400);
    }
    return context.json({ error: "Webhook 服务暂时不可用，请稍后重试。" }, 503);
  });

  const enforcePrincipalRateLimit = (
    context: Context<{ Variables: AppVariables }>,
  ): Response | null => {
    const verdict = limiter.check(context.var.actor.id);
    if (!verdict.allowed) {
      context.header("Retry-After", String(verdict.retryAfterSeconds));
      return context.json(
        {
          error: `操作过于频繁，请在 ${verdict.retryAfterSeconds} 秒后重试。`,
        },
        429,
      );
    }
    return null;
  };

  routes.get("/", async (context) => {
    const rules = await deps.store.listRules(context.var.actor.id);
    return context.json({
      rules,
      quota: { used: rules.length, limit: quotaPerUser },
    });
  });

  routes.get("/runs", async (context) => {
    const triggerId = context.req.query("triggerId")?.trim() || undefined;
    const rawStatus = context.req.query("status")?.trim() || undefined;
    let status: WebhookRunStatus | undefined;
    if (rawStatus) {
      if (!(WEBHOOK_RUN_STATUSES as readonly string[]).includes(rawStatus)) {
        return context.json({ error: "无效的运行状态筛选条件。" }, 400);
      }
      status = rawStatus as WebhookRunStatus;
    }
    const rawLimit = Number(context.req.query("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
    const result = await deps.store.listRuns(context.var.actor.id, {
      ...(triggerId ? { triggerId } : {}),
      ...(status ? { status } : {}),
      limit,
    });
    return context.json(result);
  });

  routes.post(
    "/",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) => context.json({ error: "请求体过大。" }, 413),
    }),
    async (context) => {
      const rateLimited = enforcePrincipalRateLimit(context);
      if (rateLimited) return rateLimited;

      const existing = await deps.store.listRules(context.var.actor.id);
      if (existing.length >= quotaPerUser) {
        return context.json(
          {
            error: `当前账号的 Webhook 规则数量已达上限（${quotaPerUser} 条），请删除不需要的规则后再新建。`,
          },
          429,
        );
      }

      const raw = await context.req.json().catch(() => null);
      const parsed = createWebhookRuleSchema.safeParse(raw);
      if (!parsed.success) {
        return context.json(
          {
            error: parsed.error.issues[0]?.message ?? "Webhook 规则参数无效。",
          },
          400,
        );
      }
      const created = await deps.store.createRule(
        context.var.actor,
        parsed.data,
      );
      return context.json(created, 201);
    },
  );

  routes.patch(
    "/:triggerId/enabled",
    bodyLimit({
      maxSize: 8 * 1024,
      onError: (context) => context.json({ error: "请求体过大。" }, 413),
    }),
    async (context) => {
      const rateLimited = enforcePrincipalRateLimit(context);
      if (rateLimited) return rateLimited;

      const raw = await context.req.json().catch(() => null);
      const parsed = toggleEnabledSchema.safeParse(raw);
      if (!parsed.success) {
        return context.json(
          { error: parsed.error.issues[0]?.message ?? "参数无效。" },
          400,
        );
      }
      const result = await deps.store.setEnabled(
        context.var.actor.id,
        context.req.param("triggerId"),
        parsed.data.enabled,
      );
      return context.json(result);
    },
  );

  routes.post(
    "/:triggerId/rotate-secret",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (context) => context.json({ error: "请求体过大。" }, 413),
    }),
    async (context) => {
      const rateLimited = enforcePrincipalRateLimit(context);
      if (rateLimited) return rateLimited;

      const hasJson = context.req
        .header("content-type")
        ?.toLowerCase()
        .includes("application/json");
      const raw = hasJson ? await context.req.json().catch(() => null) : {};
      const parsed = rotateSecretSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return context.json(
          { error: parsed.error.issues[0]?.message ?? "密钥参数无效。" },
          400,
        );
      }
      const result = await deps.store.rotateSecret(
        context.var.actor.id,
        context.req.param("triggerId"),
        parsed.data.secret,
      );
      return context.json(result);
    },
  );

  routes.delete("/:triggerId", async (context) => {
    const rateLimited = enforcePrincipalRateLimit(context);
    if (rateLimited) return rateLimited;

    const result = await deps.store.deleteRule(
      context.var.actor.id,
      context.req.param("triggerId"),
    );
    return context.json(result);
  });

  return routes;
}
