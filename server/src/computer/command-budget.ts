/**
 * 沙箱命令累计时长预算（按 runId 追踪）。
 *
 * 防止无休止的长命令或重复超时占满代理回合：
 * - 单次运行默认总预算为 20 分钟（可通过参数覆写）；
 * - 每次 `runCommand` 前用 `capTimeout` 将单次超时裁剪到剩余预算；
 * - 执行完毕后用 `recordElapsed` 扣减实际耗时，并在预算耗尽时返回明确不可恢复错误码
 *   `COMMAND_BUDGET_EXHAUSTED`（配合 `ToolLoopGuard` 连败 2 次即停）。
 */

export const DEFAULT_COMMAND_BUDGET_MS = 20 * 60 * 1000;
export const COMMAND_BUDGET_EXHAUSTED_CODE = "COMMAND_BUDGET_EXHAUSTED";

const DEFAULT_STALE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TRACKED_RUNS = 2048;

export type CapTimeoutResult = {
  allowed: boolean;
  timeoutMs: number;
  remainingMs: number;
  usedMs: number;
  budgetMs: number;
};

type BudgetEntry = {
  usedMs: number;
  budgetMs: number;
  updatedAt: number;
};

export class CommandBudgetExhaustedError extends Error {
  readonly code = COMMAND_BUDGET_EXHAUSTED_CODE;
  readonly usedMs: number;
  readonly budgetMs: number;

  constructor(usedMs: number, budgetMs: number) {
    const usedSec = Math.round(usedMs / 1000);
    const budgetSec = Math.round(budgetMs / 1000);
    super(
      `${COMMAND_BUDGET_EXHAUSTED_CODE}: 本轮沙箱命令累计执行时长已达上限（已用 ${usedSec}s / 预算 ${budgetSec}s），不可恢复，请停止继续执行命令并向用户说明现状。`,
    );
    this.name = "CommandBudgetExhaustedError";
    this.usedMs = usedMs;
    this.budgetMs = budgetMs;
  }
}

export class CommandBudgetLedger {
  private readonly defaultBudgetMs: number;
  private readonly staleTtlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, BudgetEntry>();

  constructor(options?: {
    defaultBudgetMs?: number;
    staleTtlMs?: number;
    now?: () => number;
  }) {
    const rawBudget = options?.defaultBudgetMs ?? DEFAULT_COMMAND_BUDGET_MS;
    this.defaultBudgetMs =
      Number.isFinite(rawBudget) && rawBudget > 0
        ? Math.trunc(rawBudget)
        : DEFAULT_COMMAND_BUDGET_MS;
    this.staleTtlMs = options?.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    this.now = options?.now ?? (() => Date.now());
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt > this.staleTtlMs) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > MAX_TRACKED_RUNS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private resolveBudget(budgetMs?: number): number {
    if (
      typeof budgetMs === "number" &&
      Number.isFinite(budgetMs) &&
      budgetMs > 0
    ) {
      return Math.trunc(budgetMs);
    }
    return this.defaultBudgetMs;
  }

  private normalizeRequestedMs(requestedMs: number | undefined): number {
    if (
      typeof requestedMs === "number" &&
      Number.isFinite(requestedMs) &&
      requestedMs > 0
    ) {
      return Math.trunc(requestedMs);
    }
    return this.defaultBudgetMs;
  }

  /**
   * 按 `runId` 剩余预算裁剪本次请求超时。
   * 当 `runId` 为空时不追踪跨调用全局配额，直接放行。
   */
  capTimeout(
    runId: string | undefined | null,
    requestedMs: number | undefined,
    budgetMs?: number,
  ): CapTimeoutResult {
    const resolvedBudget = this.resolveBudget(budgetMs);
    const requested = this.normalizeRequestedMs(requestedMs);
    const normalizedId = typeof runId === "string" ? runId.trim() : "";
    if (!normalizedId) {
      return {
        allowed: true,
        timeoutMs: requested,
        remainingMs: resolvedBudget,
        usedMs: 0,
        budgetMs: resolvedBudget,
      };
    }

    this.prune();
    const existing = this.entries.get(normalizedId);
    const effectiveBudget = existing?.budgetMs ?? resolvedBudget;
    const usedMs = existing?.usedMs ?? 0;
    const remainingMs = Math.max(0, effectiveBudget - usedMs);

    if (remainingMs <= 0) {
      return {
        allowed: false,
        timeoutMs: 0,
        remainingMs: 0,
        usedMs,
        budgetMs: effectiveBudget,
      };
    }

    return {
      allowed: true,
      timeoutMs: Math.min(requested, remainingMs),
      remainingMs,
      usedMs,
      budgetMs: effectiveBudget,
    };
  }

  /**
   * 记录一次命令实际耗时并扣减 `runId` 预算。
   */
  recordElapsed(
    runId: string | undefined | null,
    elapsedMs: number,
    budgetMs?: number,
  ): { usedMs: number; remainingMs: number; budgetMs: number } {
    const resolvedBudget = this.resolveBudget(budgetMs);
    const normalizedId = typeof runId === "string" ? runId.trim() : "";
    const delta =
      Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.trunc(elapsedMs) : 0;

    if (!normalizedId) {
      return {
        usedMs: delta,
        remainingMs: Math.max(0, resolvedBudget - delta),
        budgetMs: resolvedBudget,
      };
    }

    this.prune();
    const now = this.now();
    const existing = this.entries.get(normalizedId);
    const effectiveBudget = existing?.budgetMs ?? resolvedBudget;
    const usedMs = (existing?.usedMs ?? 0) + delta;
    // 先删再插维持 LRU 顺序，避免活跃 run 被早早驱逐。
    if (existing) this.entries.delete(normalizedId);
    this.entries.set(normalizedId, {
      usedMs,
      budgetMs: effectiveBudget,
      updatedAt: now,
    });

    return {
      usedMs,
      remainingMs: Math.max(0, effectiveBudget - usedMs),
      budgetMs: effectiveBudget,
    };
  }

  getRemainingMs(runId: string | undefined | null): number {
    const normalizedId = typeof runId === "string" ? runId.trim() : "";
    if (!normalizedId) return this.defaultBudgetMs;
    const existing = this.entries.get(normalizedId);
    if (!existing) return this.defaultBudgetMs;
    return Math.max(0, existing.budgetMs - existing.usedMs);
  }

  clear(runId: string | undefined | null): void {
    const normalizedId = typeof runId === "string" ? runId.trim() : "";
    if (!normalizedId) return;
    this.entries.delete(normalizedId);
  }

  size(): number {
    return this.entries.size;
  }
}

const defaultCommandBudget = new CommandBudgetLedger();

export function capTimeout(
  runId: string | undefined | null,
  requestedMs: number | undefined,
  budgetMs?: number,
): CapTimeoutResult {
  return defaultCommandBudget.capTimeout(runId, requestedMs, budgetMs);
}

export function recordElapsed(
  runId: string | undefined | null,
  elapsedMs: number,
  budgetMs?: number,
): { usedMs: number; remainingMs: number; budgetMs: number } {
  return defaultCommandBudget.recordElapsed(runId, elapsedMs, budgetMs);
}

export function clearRunBudget(runId: string | undefined | null): void {
  defaultCommandBudget.clear(runId);
}
