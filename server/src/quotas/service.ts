/**
 * CB-045：按用户统计日/月模型用量并实施硬配额上限的服务。
 *
 * 约定：
 * - 日/月周期一律以 UTC 自然日（YYYY-MM-DD）与自然月（YYYY-MM）为准；
 * - `totalTokens = inputTokens + outputTokens`（与 OpenAI `prompt_tokens` 含缓存语义一致，不重复加 `cacheReadTokens`）；
 * - 管理员仅在 `quota.bypassAdmin === true` 时豁免阻断，但用量账本照常原子累加；
 * - 仓储接口可注入，支持 PostgreSQL Drizzle 实库与内存适配器，方便无外部数据库运行单元测试与形式化检验。
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { usageLedger, userQuotas } from "../db/schema/admin";

export type QuotaLimitType =
  | "daily_tokens"
  | "monthly_tokens"
  | "daily_requests";

export type UserQuotaRecord = {
  userId: string;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  dailyRequestLimit: number | null;
  bypassAdmin: boolean;
  updatedBy: string;
  updatedAt: string;
};

export type SetUserQuotaInput = {
  userId: string;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  dailyRequestLimit?: number | null;
  bypassAdmin?: boolean;
  updatedBy?: string;
};

export type UsageCounters = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requests: number;
};

export type ModelUsageDetail = {
  model: string;
  daily: UsageCounters;
  monthly: UsageCounters;
};

export type UsageAggregate = {
  daily: UsageCounters;
  monthly: UsageCounters;
  byModel: ModelUsageDetail[];
};

export type QuotaOverviewRow = {
  userId: string;
  quota: UserQuotaRecord | null;
  usage: UsageAggregate;
};

export type UserQuotaSummary = {
  userId: string;
  isAdmin: boolean;
  bypassed: boolean;
  day: string;
  month: string;
  resetAtUtc: string;
  quota: UserQuotaRecord | null;
  usage: UsageAggregate;
};

export type RecordUsageInput = {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  requests?: number;
  now?: number;
};

export type UsageLedgerRow = {
  userId: string;
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requests: number;
};

export type QuotaAdmissionDecision =
  | {
      allowed: true;
      bypassed: boolean;
    }
  | {
      allowed: false;
      limitType: QuotaLimitType;
      used: number;
      limit: number;
      resetAtUtc: string;
    };

export type QuotaStorage = {
  getQuota: (userId: string) => Promise<UserQuotaRecord | null>;
  upsertQuota: (input: {
    userId: string;
    dailyTokenLimit: number | null;
    monthlyTokenLimit: number | null;
    dailyRequestLimit: number | null;
    bypassAdmin: boolean;
    updatedBy: string;
    updatedAt: Date;
  }) => Promise<UserQuotaRecord>;
  deleteQuota: (userId: string) => Promise<boolean>;
  listQuotas: () => Promise<UserQuotaRecord[]>;
  incrementUsage: (input: {
    userId: string;
    day: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    requests: number;
    updatedAt: Date;
  }) => Promise<void>;
  listUsageInMonth: (
    monthPrefix: string,
    userId?: string,
  ) => Promise<UsageLedgerRow[]>;
};

export type QuotaService = {
  checkAdmission: (
    userId: string,
    isAdmin: boolean,
    now?: number,
  ) => Promise<void>;
  recordUsage: (input: RecordUsageInput) => Promise<void>;
  getQuota: (userId: string) => Promise<UserQuotaRecord | null>;
  setQuota: (input: SetUserQuotaInput) => Promise<UserQuotaRecord>;
  deleteQuota: (userId: string) => Promise<boolean>;
  listQuotasWithUsage: (now?: number) => Promise<QuotaOverviewRow[]>;
  getUserSummary: (
    userId: string,
    isAdmin: boolean,
    now?: number,
  ) => Promise<UserQuotaSummary>;
};

const MAX_PG_INT32 = 2_147_483_647;

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatQuotaExceededMessage(
  limitType: QuotaLimitType,
  used: number,
  limit: number,
): string {
  const ratio = `（${formatCount(used)} / ${formatCount(limit)}）`;
  switch (limitType) {
    case "daily_tokens":
      return `已达到每日 Token 配额上限${ratio}，将在 UTC 00:00 重置`;
    case "monthly_tokens":
      return `已达到每月 Token 配额上限${ratio}，将在下月 UTC 1 日 00:00 重置`;
    case "daily_requests":
      return `已达到每日请求次数配额上限${ratio}，将在 UTC 00:00 重置`;
  }
}

export class QuotaExceededError extends Error {
  readonly status = 429 as const;
  readonly code = "quota_exceeded" as const;
  readonly limitType: QuotaLimitType;
  readonly used: number;
  readonly limit: number;
  readonly resetAtUtc: string;

  constructor(input: {
    limitType: QuotaLimitType;
    used: number;
    limit: number;
    resetAtUtc: string;
  }) {
    super(formatQuotaExceededMessage(input.limitType, input.used, input.limit));
    this.name = "QuotaExceededError";
    this.limitType = input.limitType;
    this.used = input.used;
    this.limit = input.limit;
    this.resetAtUtc = input.resetAtUtc;
  }
}

export class QuotaValidationError extends Error {
  readonly status = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = "QuotaValidationError";
  }
}

/** 将任意外部输入钳位为非负整数（拒绝负数、NaN 与小数）。 */
export function clampNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function normalizeLimit(
  value: number | null | undefined,
  maxAllowed: number,
  label: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maxAllowed
  ) {
    throw new QuotaValidationError(`${label}必须为非负整数或留空。`);
  }
  return value;
}

/** 计算给定时间戳对应的 UTC 自然日、自然月与下一次重置时刻。 */
export function utcDateParts(nowMs: number = Date.now()): {
  day: string;
  month: string;
  resetAtUtc: string;
  nextMonthResetAtUtc: string;
} {
  const date = new Date(nowMs);
  const year = date.getUTCFullYear();
  const monthNum = date.getUTCMonth();
  const dayNum = date.getUTCDate();
  const month = `${year}-${String(monthNum + 1).padStart(2, "0")}`;
  const day = `${month}-${String(dayNum).padStart(2, "0")}`;
  const resetAtUtc = new Date(
    Date.UTC(year, monthNum, dayNum + 1, 0, 0, 0, 0),
  ).toISOString();
  const nextMonthResetAtUtc = new Date(
    Date.UTC(year, monthNum + 1, 1, 0, 0, 0, 0),
  ).toISOString();
  return { day, month, resetAtUtc, nextMonthResetAtUtc };
}

function emptyCounters(): UsageCounters {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
}

function addCounters(target: UsageCounters, row: UsageLedgerRow): void {
  const inputTokens = clampNonNegativeInt(row.inputTokens);
  const outputTokens = clampNonNegativeInt(row.outputTokens);
  const cacheReadTokens = clampNonNegativeInt(row.cacheReadTokens);
  const requests = clampNonNegativeInt(row.requests);
  target.inputTokens += inputTokens;
  target.outputTokens += outputTokens;
  target.cacheReadTokens += cacheReadTokens;
  target.totalTokens += inputTokens + outputTokens;
  target.requests += requests;
}

/** 纯聚合函数：从某月账本行汇总日/月用量与分模型明细。 */
export function aggregateUsageRows(
  rows: readonly UsageLedgerRow[],
  day: string,
): UsageAggregate {
  const daily = emptyCounters();
  const monthly = emptyCounters();
  const models = new Map<string, ModelUsageDetail>();

  for (const row of rows) {
    addCounters(monthly, row);
    if (row.day === day) {
      addCounters(daily, row);
    }
    let modelDetail = models.get(row.model);
    if (!modelDetail) {
      modelDetail = {
        model: row.model,
        daily: emptyCounters(),
        monthly: emptyCounters(),
      };
      models.set(row.model, modelDetail);
    }
    addCounters(modelDetail.monthly, row);
    if (row.day === day) {
      addCounters(modelDetail.daily, row);
    }
  }

  const byModel = [...models.values()].sort(
    (a, b) =>
      b.monthly.totalTokens - a.monthly.totalTokens ||
      a.model.localeCompare(b.model),
  );

  return { daily, monthly, byModel };
}

/** 纯准入判定函数（供服务执行与形式化检验复用）。 */
export function evaluateQuotaAdmission(input: {
  quota: UserQuotaRecord | null;
  isAdmin: boolean;
  usage: UsageAggregate;
  now?: number;
}): QuotaAdmissionDecision {
  const { quota, isAdmin, usage } = input;
  if (!quota) {
    return { allowed: true, bypassed: false };
  }
  if (isAdmin && quota.bypassAdmin) {
    return { allowed: true, bypassed: true };
  }

  const { resetAtUtc, nextMonthResetAtUtc } = utcDateParts(input.now);

  if (
    quota.dailyRequestLimit !== null &&
    usage.daily.requests >= quota.dailyRequestLimit
  ) {
    return {
      allowed: false,
      limitType: "daily_requests",
      used: usage.daily.requests,
      limit: quota.dailyRequestLimit,
      resetAtUtc,
    };
  }

  if (
    quota.dailyTokenLimit !== null &&
    usage.daily.totalTokens >= quota.dailyTokenLimit
  ) {
    return {
      allowed: false,
      limitType: "daily_tokens",
      used: usage.daily.totalTokens,
      limit: quota.dailyTokenLimit,
      resetAtUtc,
    };
  }

  if (
    quota.monthlyTokenLimit !== null &&
    usage.monthly.totalTokens >= quota.monthlyTokenLimit
  ) {
    return {
      allowed: false,
      limitType: "monthly_tokens",
      used: usage.monthly.totalTokens,
      limit: quota.monthlyTokenLimit,
      resetAtUtc: nextMonthResetAtUtc,
    };
  }

  return { allowed: true, bypassed: false };
}

function mapQuotaRow(row: typeof userQuotas.$inferSelect): UserQuotaRecord {
  return {
    userId: row.userId,
    dailyTokenLimit: row.dailyTokenLimit ?? null,
    monthlyTokenLimit: row.monthlyTokenLimit ?? null,
    dailyRequestLimit: row.dailyRequestLimit ?? null,
    bypassAdmin: row.bypassAdmin,
    updatedBy: row.updatedBy ?? "",
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createPgQuotaStorage(database: Database): QuotaStorage {
  return {
    async getQuota(userId) {
      const [row] = await database
        .select()
        .from(userQuotas)
        .where(eq(userQuotas.userId, userId));
      return row ? mapQuotaRow(row) : null;
    },

    async upsertQuota(input) {
      const [row] = await database
        .insert(userQuotas)
        .values({
          userId: input.userId,
          dailyTokenLimit: input.dailyTokenLimit,
          monthlyTokenLimit: input.monthlyTokenLimit,
          dailyRequestLimit: input.dailyRequestLimit,
          bypassAdmin: input.bypassAdmin,
          updatedBy: input.updatedBy,
          updatedAt: input.updatedAt,
        })
        .onConflictDoUpdate({
          target: userQuotas.userId,
          set: {
            dailyTokenLimit: input.dailyTokenLimit,
            monthlyTokenLimit: input.monthlyTokenLimit,
            dailyRequestLimit: input.dailyRequestLimit,
            bypassAdmin: input.bypassAdmin,
            updatedBy: input.updatedBy,
            updatedAt: input.updatedAt,
          },
        })
        .returning();
      if (!row) {
        throw new Error("保存用户配额失败。");
      }
      return mapQuotaRow(row);
    },

    async deleteQuota(userId) {
      const removed = await database
        .delete(userQuotas)
        .where(eq(userQuotas.userId, userId))
        .returning({ userId: userQuotas.userId });
      return removed.length > 0;
    },

    async listQuotas() {
      const rows = await database.select().from(userQuotas);
      return rows.map(mapQuotaRow);
    },

    async incrementUsage(input) {
      await database
        .insert(usageLedger)
        .values({
          userId: input.userId,
          day: input.day,
          model: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          cacheReadTokens: input.cacheReadTokens,
          requests: input.requests,
          updatedAt: input.updatedAt,
        })
        .onConflictDoUpdate({
          target: [usageLedger.userId, usageLedger.day, usageLedger.model],
          set: {
            inputTokens: sql`${usageLedger.inputTokens} + ${input.inputTokens}`,
            outputTokens: sql`${usageLedger.outputTokens} + ${input.outputTokens}`,
            cacheReadTokens: sql`${usageLedger.cacheReadTokens} + ${input.cacheReadTokens}`,
            requests: sql`${usageLedger.requests} + ${input.requests}`,
            updatedAt: input.updatedAt,
          },
        });
    },

    async listUsageInMonth(monthPrefix, userId) {
      const startDay = `${monthPrefix}-01`;
      const endDay = `${monthPrefix}-31`;
      const range = and(
        gte(usageLedger.day, startDay),
        lte(usageLedger.day, endDay),
      );
      const condition = userId
        ? and(eq(usageLedger.userId, userId), range)
        : range;
      const rows = await database
        .select({
          userId: usageLedger.userId,
          day: usageLedger.day,
          model: usageLedger.model,
          inputTokens: usageLedger.inputTokens,
          outputTokens: usageLedger.outputTokens,
          cacheReadTokens: usageLedger.cacheReadTokens,
          requests: usageLedger.requests,
        })
        .from(usageLedger)
        .where(condition);
      return rows;
    },
  };
}

export function createMemoryQuotaStorage(): QuotaStorage {
  const quotas = new Map<string, UserQuotaRecord>();
  const ledger = new Map<string, UsageLedgerRow>();

  return {
    async getQuota(userId) {
      const row = quotas.get(userId);
      return row ? { ...row } : null;
    },

    async upsertQuota(input) {
      const record: UserQuotaRecord = {
        userId: input.userId,
        dailyTokenLimit: input.dailyTokenLimit,
        monthlyTokenLimit: input.monthlyTokenLimit,
        dailyRequestLimit: input.dailyRequestLimit,
        bypassAdmin: input.bypassAdmin,
        updatedBy: input.updatedBy,
        updatedAt: input.updatedAt.toISOString(),
      };
      quotas.set(input.userId, record);
      return { ...record };
    },

    async deleteQuota(userId) {
      return quotas.delete(userId);
    },

    async listQuotas() {
      return [...quotas.values()].map((item) => ({ ...item }));
    },

    async incrementUsage(input) {
      const key = `${input.userId}\u0000${input.day}\u0000${input.model}`;
      const current = ledger.get(key);
      if (!current) {
        ledger.set(key, {
          userId: input.userId,
          day: input.day,
          model: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          cacheReadTokens: input.cacheReadTokens,
          requests: input.requests,
        });
        return;
      }
      current.inputTokens += input.inputTokens;
      current.outputTokens += input.outputTokens;
      current.cacheReadTokens += input.cacheReadTokens;
      current.requests += input.requests;
    },

    async listUsageInMonth(monthPrefix, userId) {
      const prefix = `${monthPrefix}-`;
      const result: UsageLedgerRow[] = [];
      for (const row of ledger.values()) {
        if (!row.day.startsWith(prefix)) continue;
        if (userId !== undefined && row.userId !== userId) continue;
        result.push({ ...row });
      }
      return result;
    },
  };
}

export function createQuotaService(storage: QuotaStorage): QuotaService {
  return {
    async checkAdmission(userId, isAdmin, now = Date.now()) {
      const quota = await storage.getQuota(userId);
      if (!quota) return;
      if (isAdmin && quota.bypassAdmin) return;
      if (
        quota.dailyRequestLimit === null &&
        quota.dailyTokenLimit === null &&
        quota.monthlyTokenLimit === null
      ) {
        return;
      }
      const { day, month } = utcDateParts(now);
      const rows = await storage.listUsageInMonth(month, userId);
      const usage = aggregateUsageRows(rows, day);
      const decision = evaluateQuotaAdmission({
        quota,
        isAdmin,
        usage,
        now,
      });
      if (!decision.allowed) {
        throw new QuotaExceededError(decision);
      }
    },

    async recordUsage(input) {
      const userId = input.userId.trim();
      if (!userId) return;
      const model = input.model.trim() || "unknown";
      const inputTokens = clampNonNegativeInt(input.inputTokens);
      const outputTokens = clampNonNegativeInt(input.outputTokens);
      const cacheReadTokens = clampNonNegativeInt(input.cacheReadTokens ?? 0);
      const requests =
        input.requests === undefined ? 1 : clampNonNegativeInt(input.requests);
      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadTokens === 0 &&
        requests === 0
      ) {
        return;
      }
      const nowMs = input.now ?? Date.now();
      const { day } = utcDateParts(nowMs);
      await storage.incrementUsage({
        userId,
        day,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        requests,
        updatedAt: new Date(nowMs),
      });
    },

    getQuota(userId) {
      return storage.getQuota(userId);
    },

    async setQuota(input) {
      const userId = input.userId.trim();
      if (!userId) {
        throw new QuotaValidationError("用户 ID 不能为空。");
      }
      const dailyTokenLimit = normalizeLimit(
        input.dailyTokenLimit,
        Number.MAX_SAFE_INTEGER,
        "每日 Token 配额上限",
      );
      const monthlyTokenLimit = normalizeLimit(
        input.monthlyTokenLimit,
        Number.MAX_SAFE_INTEGER,
        "每月 Token 配额上限",
      );
      const dailyRequestLimit = normalizeLimit(
        input.dailyRequestLimit,
        MAX_PG_INT32,
        "每日请求次数配额上限",
      );
      if (
        input.bypassAdmin !== undefined &&
        typeof input.bypassAdmin !== "boolean"
      ) {
        throw new QuotaValidationError("管理员豁免开关格式无效。");
      }
      return storage.upsertQuota({
        userId,
        dailyTokenLimit,
        monthlyTokenLimit,
        dailyRequestLimit,
        bypassAdmin: input.bypassAdmin ?? true,
        updatedBy: input.updatedBy?.trim() ?? "",
        updatedAt: new Date(),
      });
    },

    deleteQuota(userId) {
      return storage.deleteQuota(userId);
    },

    async listQuotasWithUsage(now = Date.now()) {
      const { day, month } = utcDateParts(now);
      const [quotas, usageRows] = await Promise.all([
        storage.listQuotas(),
        storage.listUsageInMonth(month),
      ]);
      const quotaByUser = new Map(quotas.map((item) => [item.userId, item]));
      const rowsByUser = new Map<string, UsageLedgerRow[]>();
      for (const row of usageRows) {
        const list = rowsByUser.get(row.userId);
        if (list) list.push(row);
        else rowsByUser.set(row.userId, [row]);
      }
      const allUsers = new Set<string>([
        ...quotaByUser.keys(),
        ...rowsByUser.keys(),
      ]);
      return [...allUsers]
        .sort((a, b) => a.localeCompare(b))
        .map((userId) => ({
          userId,
          quota: quotaByUser.get(userId) ?? null,
          usage: aggregateUsageRows(rowsByUser.get(userId) ?? [], day),
        }));
    },

    async getUserSummary(userId, isAdmin, now = Date.now()) {
      const { day, month, resetAtUtc } = utcDateParts(now);
      const [quota, rows] = await Promise.all([
        storage.getQuota(userId),
        storage.listUsageInMonth(month, userId),
      ]);
      const usage = aggregateUsageRows(rows, day);
      const bypassed = Boolean(isAdmin && (quota?.bypassAdmin ?? true));
      return {
        userId,
        isAdmin,
        bypassed,
        day,
        month,
        resetAtUtc,
        quota,
        usage,
      };
    },
  };
}
