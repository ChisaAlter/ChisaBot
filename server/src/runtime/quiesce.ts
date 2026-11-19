import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";

/**
 * Supervisor 静默排空升级协议（Wave 10 §1.1）：
 *
 * - 追踪进程内所有在途回合数（`runningTurns()`）。
 * - `requestQuiesce(timeoutMs)` 进入排空态后立刻拒接一切新回合进入（与 `maintenance.ts` 联动），
 *   等待在途回合归零或到达超时上限，再向运维/部署脚本返回结构化排空结果。
 * - 暴露受管理员或内部令牌保护的 `GET /api/internal/health`（携带 `pid`/`runningTurns`/`quiescing`）
 *   与 `POST /api/internal/quiesce`。
 */

const DEFAULT_QUIESCE_TIMEOUT_MS = 30_000;
const MAX_QUIESCE_TIMEOUT_MS = 10 * 60_000;

export class QuiescingAdmissionError extends Error {
  readonly status = 503;
  constructor(
    message = "服务正在静默排空准备升级，暂不接收新回合，请稍后重试。",
  ) {
    super(message);
    this.name = "QuiescingAdmissionError";
  }
}

export type RuntimeHealthSnapshot = {
  ok: true;
  pid: number;
  runningTurns: number;
  quiescing: boolean;
  isBusy: boolean;
  quiesceRequestedAt: string | null;
};

export type QuiesceResult = {
  ok: boolean;
  drained: boolean;
  quiescing: true;
  pid: number;
  runningTurns: number;
  waitedMs: number;
  timedOut: boolean;
};

export type QuiesceController = {
  /** 同步登记一个在途回合；若已进入排空态立即抛出 QuiescingAdmissionError。返回幂等释放回调。 */
  beginTurn(turnId?: string): () => void;
  /** 包裹一个回合执行生命周期，保证无论成功、失败或中止都精确释放计数。 */
  trackTurn<T>(fn: () => Promise<T> | T, turnId?: string): Promise<T>;
  /** 当前在途回合数。 */
  runningTurns(): number;
  /** 是否正处于排空态。 */
  isQuiescing(): boolean;
  /** 请求静默排空：立刻停收新回合，等待在途回合归零或超时。 */
  requestQuiesce(timeoutMs?: number): Promise<QuiesceResult>;
  /** 取消排空态恢复接单（供健康恢复或测试使用）。 */
  resumeAdmission(): void;
  /** 返回健康检查快照（钉 `pid`、`runningTurns`、`quiescing`）。 */
  healthSnapshot(): RuntimeHealthSnapshot;
  /** 仅标记进入排空态（同步，不等待）。 */
  markQuiescing(): void;
};

export function createQuiesceController(
  options: { pid?: number; now?: () => number } = {},
): QuiesceController {
  const pid = options.pid ?? process.pid;
  const nowFn = options.now ?? Date.now;
  let activeTurns = 0;
  let quiescing = false;
  let quiesceRequestedAt: string | null = null;
  const drainWaiters = new Set<() => void>();

  const notifyDrainedIfIdle = (): void => {
    if (activeTurns !== 0 || drainWaiters.size === 0) return;
    const waiters = [...drainWaiters];
    drainWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  };

  const beginTurn = (_turnId?: string): (() => void) => {
    if (quiescing) {
      throw new QuiescingAdmissionError();
    }
    activeTurns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeTurns = Math.max(0, activeTurns - 1);
      notifyDrainedIfIdle();
    };
  };

  const markQuiescing = (): void => {
    if (!quiescing) {
      quiescing = true;
      quiesceRequestedAt = new Date(nowFn()).toISOString();
    }
  };

  return {
    beginTurn,

    async trackTurn<T>(fn: () => Promise<T> | T, turnId?: string): Promise<T> {
      const release = beginTurn(turnId);
      try {
        return await fn();
      } finally {
        release();
      }
    },

    runningTurns() {
      return activeTurns;
    },

    isQuiescing() {
      return quiescing;
    },

    markQuiescing,

    async requestQuiesce(
      timeoutMs: number = DEFAULT_QUIESCE_TIMEOUT_MS,
    ): Promise<QuiesceResult> {
      const clampedTimeout = Number.isFinite(timeoutMs)
        ? Math.max(0, Math.min(MAX_QUIESCE_TIMEOUT_MS, Math.floor(timeoutMs)))
        : DEFAULT_QUIESCE_TIMEOUT_MS;
      const startedAt = nowFn();
      markQuiescing();

      if (activeTurns === 0) {
        return {
          ok: true,
          drained: true,
          quiescing: true,
          pid,
          runningTurns: 0,
          waitedMs: 0,
          timedOut: false,
        };
      }

      let timedOut = false;
      if (clampedTimeout === 0) {
        timedOut = true;
      } else {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (isTimeout: boolean) => {
            if (settled) return;
            settled = true;
            drainWaiters.delete(onDrained);
            clearTimeout(timer);
            if (isTimeout) timedOut = true;
            resolve();
          };
          const onDrained = () => finish(false);
          drainWaiters.add(onDrained);
          const timer = setTimeout(() => finish(true), clampedTimeout);
        });
      }

      const drained = activeTurns === 0;
      return {
        ok: drained,
        drained,
        quiescing: true,
        pid,
        runningTurns: activeTurns,
        waitedMs: Math.max(0, nowFn() - startedAt),
        timedOut: !drained && timedOut,
      };
    },

    resumeAdmission() {
      quiescing = false;
      quiesceRequestedAt = null;
    },

    healthSnapshot() {
      return {
        ok: true,
        pid,
        runningTurns: activeTurns,
        quiescing,
        isBusy: activeTurns > 0,
        quiesceRequestedAt,
      };
    },
  };
}

const defaultController = createQuiesceController();

export function getRuntimeQuiesceController(): QuiesceController {
  return defaultController;
}

export function beginTurn(turnId?: string): () => void {
  return defaultController.beginTurn(turnId);
}

export function trackTurn<T>(
  fn: () => Promise<T> | T,
  turnId?: string,
): Promise<T> {
  return defaultController.trackTurn(fn, turnId);
}

export function runningTurns(): number {
  return defaultController.runningTurns();
}

export function isQuiescing(): boolean {
  return defaultController.isQuiescing();
}

export function requestQuiesce(timeoutMs?: number): Promise<QuiesceResult> {
  return defaultController.requestQuiesce(timeoutMs);
}

export function runtimeHealthSnapshot(): RuntimeHealthSnapshot {
  return defaultController.healthSnapshot();
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractInternalToken(headers: Headers): string {
  const custom = headers.get("x-chisabot-internal-token")?.trim();
  if (custom) return custom;
  const auth = headers.get("authorization")?.trim() ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

const quiesceBodySchema = z
  .strictObject({
    timeoutMs: z.number().int().min(0).max(MAX_QUIESCE_TIMEOUT_MS).optional(),
  })
  .optional();

/**
 * 内部排空与健康检查路由（挂载于 `/api/internal`）：
 * - `GET /api/internal/health`
 * - `POST /api/internal/quiesce`
 * - `POST /api/internal/quiesce/resume`
 *
 * 鉴权策略（fail-closed）：
 * 1. 若配置了 `internalToken` 且请求携带匹配的 Bearer / `x-chisabot-internal-token` 令牌 → 放行；
 * 2. 否则若提供了 `requireUser` → 校验登录且必须是管理员（`requireAdmin`）；
 * 3. 否则一律拒绝（401/403）。
 */
export function createInternalQuiesceRoutes(options: {
  controller?: QuiesceController;
  internalToken?: string;
  requireUser?: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const controller = options.controller ?? defaultController;
  const internalToken = options.internalToken?.trim() || undefined;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const presented = extractInternalToken(context.req.raw.headers);
    if (internalToken && presented) {
      if (sameSecret(presented, internalToken)) {
        return next();
      }
      return context.json({ error: "内部令牌无效。" }, 401);
    }
    if (options.requireUser) {
      let authorized = false;
      const result = await options.requireUser(context, async () => {
        const denied = requireAdmin(context);
        if (denied) {
          context.res = denied;
          return;
        }
        authorized = true;
      });
      if (!authorized) {
        return result ?? context.res;
      }
      return next();
    }
    return context.json(
      { error: "需要管理员身份或有效内部令牌。" },
      internalToken ? 401 : 403,
    );
  });

  routes.get("/health", (context) => context.json(controller.healthSnapshot()));

  routes.post(
    "/quiesce",
    bodyLimit({
      maxSize: 8 * 1024,
      onError: (context) => context.json({ error: "排空请求体过大。" }, 413),
    }),
    async (context) => {
      const rawText = await context.req.text();
      let timeoutMs: number | undefined;
      if (rawText.trim().length > 0) {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(rawText);
        } catch {
          return context.json({ error: "请求体不是合法 JSON。" }, 400);
        }
        const parsed = quiesceBodySchema.safeParse(parsedJson);
        if (!parsed.success) {
          return context.json({ error: "排空参数无效。" }, 400);
        }
        timeoutMs = parsed.data?.timeoutMs;
      }
      const outcome = await controller.requestQuiesce(timeoutMs);
      return context.json(outcome, outcome.drained ? 200 : 409);
    },
  );

  routes.post(
    "/quiesce/resume",
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (context) => context.json({ error: "请求体过大。" }, 413),
    }),
    (context) => {
      controller.resumeAdmission();
      return context.json(controller.healthSnapshot());
    },
  );

  return routes;
}
