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
  /**
   * admit() 发还的预留。结算按（实际 - 预留）差量写回预留所在日/模型的同一行，
   * 上游失败的调用以全零实际值调用即可释放预留。
   */
  reservation?: QuotaReservation;
};

/** admit() 预留在账本中的一段额度：1 次请求 + 估计输入 + 声明的最大输出。 */
export type QuotaReservation = {
  userId: string;
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type AdmitUsageInput = {
  userId: string;
  isAdmin: boolean;
  model: string;
  /** 请求体字符数，用于估计输入 token 预留。 */
  requestChars?: number;
  /** 客户端声明的 max_tokens/max_completion_tokens；缺省时按默认输出预留。 */
  maxOutputTokens?: number;
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
  /**
   * 串行化同一用户的准入判定：PG 实现对用户配额行 FOR UPDATE，
   * 内存实现按用户排队。回调内的读改写对并发 admit 原子可见。
   */
  withUserQuotaLock: <T>(
    userId: string,
    fn: (locked: QuotaStorage) => Promise<T>,
  ) => Promise<T>;
};

export type QuotaService = {
  checkAdmission: (
    userId: string,
    isAdmin: boolean,
    now?: number,
  ) => Promise<void>;
  /**
   * 原子准入：串行检查配额后把本次调用的预留量立即写进账本，
   * 并发的 admit 不可能放行超出上限的调用。返回预留用于结算或释放。
   */
  admit: (input: AdmitUsageInput) => Promise<QuotaReservation | null>;
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

/** 请求未声明输出上限时的准入预留量；声明了 max_tokens 则以声明值为准。 */
const DEFAULT_RESERVED_OUTPUT_TOKENS = 8192;

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

    async withUserQuotaLock(userId, fn) {
      return database.transaction(async (tx) => {
        /*
         * 锁住用户配额行，把该用户所有 admit 的判定串行化。
         * 行不存在说明没有限额，也就没有需要竞争的额度。
         */
        await tx.execute(
          sql`SELECT 1 FROM ${userQuotas} WHERE ${userQuotas.userId} = ${userId} FOR UPDATE`,
        );
        return fn(createPgQuotaStorage(tx as unknown as Database));
      });
    },
  };
}

export function createMemoryQuotaStorage(): QuotaStorage {
  const quotas = new Map<string, UserQuotaRecord>();
  const ledger = new Map<string, UsageLedgerRow>();
  const admissionLocks = new Map<string, Promise<void>>();

  const storage: QuotaStorage = {
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

    async withUserQuotaLock(userId, fn) {
      const previous = admissionLocks.get(userId) ?? Promise.resolve();
      let release = () => {};
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      admissionLocks.set(
        userId,
        previous.then(() => current),
      );
      await previous;
      try {
        return await fn(storage);
      } finally {
        release();
      }
    },
  };
  return storage;
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

    async admit(input) {
      const userId = input.userId.trim();
      if (!userId) return null;
      const model = input.model.trim() || "unknown";
      const now = input.now ?? Date.now();
      const { day, month } = utcDateParts(now);
      return storage.withUserQuotaLock(userId, async (locked) => {
        const quota = await locked.getQuota(userId);
        if (!quota) return null;
        if (input.isAdmin && quota.bypassAdmin) return null;
        if (
          quota.dailyRequestLimit === null &&
          quota.dailyTokenLimit === null &&
          quota.monthlyTokenLimit === null
        ) {
          return null;
        }
        const rows = await locked.listUsageInMonth(month, userId);
        const usage = aggregateUsageRows(rows, day);
        /*
         * 判定口径与 checkAdmission 一致（committed ≥ 上限即拒）。在途调用的
         * 预留已作为账本行提交，committed usage 本身就含它们；同一锁内读写，
         * 并发 admit 必然看到彼此刚占走的额度，不会双双放行。
         */
        const decision = evaluateQuotaAdmission({
          quota,
          isAdmin: input.isAdmin,
          usage,
          now,
        });
        if (!decision.allowed) {
          throw new QuotaExceededError(decision);
        }
        /*
         * 立即把预留记进账本：1 次请求 + 估计输入 + 声明的最大输出，各项只占到
         * 剩余额度为止。声明了 max_tokens 的调用最坏情况就是预留本身，token
         * 上限成为真硬上限；未声明的调用超出默认预留的部分仍只在结算时入账，
         * 超限幅度被在途调用数限制住而不再无界。
         */
        let headroom = Number.MAX_SAFE_INTEGER;
        if (quota.dailyTokenLimit !== null) {
          headroom = Math.min(
            headroom,
            quota.dailyTokenLimit - usage.daily.totalTokens,
          );
        }
        if (quota.monthlyTokenLimit !== null) {
          headroom = Math.min(
            headroom,
            quota.monthlyTokenLimit - usage.monthly.totalTokens,
          );
        }
        headroom = Math.max(0, headroom);
        const reservedInput = Math.min(
          Math.ceil(Math.max(0, input.requestChars ?? 0) / 4),
          headroom,
        );
        const reservedOutput = Math.min(
          input.maxOutputTokens !== undefined
            ? clampNonNegativeInt(input.maxOutputTokens)
            : DEFAULT_RESERVED_OUTPUT_TOKENS,
          Math.max(0, headroom - reservedInput),
        );
        await locked.incrementUsage({
          userId,
          day,
          model,
          inputTokens: reservedInput,
          outputTokens: reservedOutput,
          cacheReadTokens: 0,
          requests: 1,
          updatedAt: new Date(now),
        });
        return {
          userId,
          day,
          model,
          inputTokens: reservedInput,
          outputTokens: reservedOutput,
        };
      });
    },

    async recordUsage(input) {
      const userId = input.userId.trim();
      if (!userId) return;
      const reservation = input.reservation;
      const model = (reservation?.model ?? input.model).trim() || "unknown";
      const inputTokens =
        clampNonNegativeInt(input.inputTokens) -
        (reservation?.inputTokens ?? 0);
      const outputTokens =
        clampNonNegativeInt(input.outputTokens) -
        (reservation?.outputTokens ?? 0);
      const cacheReadTokens = clampNonNegativeInt(input.cacheReadTokens ?? 0);
      const requests =
        (input.requests === undefined
          ? 1
          : clampNonNegativeInt(input.requests)) - (reservation ? 1 : 0);
      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadTokens === 0 &&
        requests === 0
      ) {
        return;
      }
      const nowMs = input.now ?? Date.now();
      const day = reservation?.day ?? utcDateParts(nowMs).day;
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
