/**
 * 设置 → 模型 →「摘要模型」：Hermes 内核下长对话压缩前文（agents/history-budget.ts）时，用哪个模型写摘要。
 *
 * 存在 enterprise_settings 的一行（key = history_summary_model，`{ version: 1, model: "…" | null }`），
 * 不新建表；回滚到旧镜像时这一行被忽略。null = 跟随这一轮的主模型（不在代码里写死任何模型）。
 * 读的时候缓存 30 秒（每次需要摘要时问一次），保存时立刻清缓存。
 */
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { enterpriseSettings } from "../db/schema";

export const HISTORY_SUMMARY_MODEL_KEY = "history_summary_model";

export type HistorySummaryModelSettings = { model: string | null };

export class HistorySummaryModelValidationError extends Error {
  readonly status = 400;
}

/** 校验：null / 空字符串 = 跟随主模型；否则是一个模型 id（无空白、无控制字符，最长 200）。 */
export function parseHistorySummaryModel(input: unknown): string | null {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).model
      : input;
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string")
    throw new HistorySummaryModelValidationError(
      "请提供摘要模型 id，或留空跟随主模型。",
    );
  const id = raw.trim();
  if (!id) return null;
  if (
    id.length > 200 ||
    /\s/u.test(id) ||
    [...id].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new HistorySummaryModelValidationError(
      "模型 id 不能有空格，最长 200 个字符。",
    );
  return id;
}

export type HistorySummaryModelStore = {
  read(): Promise<string | null>;
  write(model: string | null, actorUserId?: string): Promise<string | null>;
};

export function createHistorySummaryModelStore(
  database: Database,
): HistorySummaryModelStore {
  return {
    async read() {
      const [row] = await database
        .select({ value: enterpriseSettings.value })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, HISTORY_SUMMARY_MODEL_KEY));
      try {
        return row ? parseHistorySummaryModel(row.value) : null;
      } catch {
        return null;
      }
    },
    async write(model, actorUserId) {
      const value = { version: 1, model };
      await database
        .insert(enterpriseSettings)
        .values({
          key: HISTORY_SUMMARY_MODEL_KEY,
          value,
          updatedBy: actorUserId ?? null,
        })
        .onConflictDoUpdate({
          target: enterpriseSettings.key,
          set: { value, updatedBy: actorUserId ?? null, updatedAt: new Date() },
        });
      return model;
    },
  };
}

export type HistorySummaryModelService = {
  /** 需要摘要时用（缓存 30 秒）；null = 跟随主模型。 */
  model(): Promise<string | null>;
  get(): Promise<HistorySummaryModelSettings>;
  save(
    input: unknown,
    actorUserId?: string,
  ): Promise<HistorySummaryModelSettings>;
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
};

export function createHistorySummaryModelService(options: {
  store: HistorySummaryModelStore;
  now?: () => number;
  cacheMs?: number;
}): HistorySummaryModelService {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 30_000;
  let cached: { at: number; model: string | null } | null = null;

  const service: HistorySummaryModelService = {
    async model() {
      if (cached && now() - cached.at < cacheMs) return cached.model;
      const model = await options.store.read();
      cached = { at: now(), model };
      return model;
    },
    async get() {
      cached = null;
      return { model: await service.model() };
    },
    async save(input, actorUserId) {
      const model = parseHistorySummaryModel(input);
      await options.store.write(model, actorUserId);
      cached = { at: now(), model };
      return { model };
    },
    routes(requireUser) {
      const routes = new Hono<{ Variables: AppVariables }>();
      routes.use("*", requireUser);
      routes.use("*", async (context, next) => {
        const denied = requireAdmin(context);
        if (denied) return denied;
        context.header("Cache-Control", "no-store");
        await next();
      });
      routes.get("/", async (context) => context.json(await service.get()));
      routes.put("/", async (context) => {
        const body = await context.req.json().catch(() => null);
        try {
          return context.json(
            await service.save(body, context.get("actor")?.id),
          );
        } catch (error) {
          if (error instanceof HistorySummaryModelValidationError)
            return context.json({ error: error.message }, 400);
          return context.json(
            { error: "摘要模型暂时无法保存，请稍后重试。" },
            503,
          );
        }
      });
      return routes;
    },
  };
  return service;
}
