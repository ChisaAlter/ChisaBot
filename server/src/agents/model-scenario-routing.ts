/**
 * 场景化模型路由设置存储与管理员 API（/api/admin/scenario-routing）。
 *
 * 存在 enterprise_settings 的一行（key = model_scenario_routes，
 * `{ version: 1, scenarios: { chat: {...}, review: {...} } }`），不新建表，
 * 回滚到旧镜像时这一行被忽略（旧版没有任何读取方）。空配置 = 所有场景继承当前行为，
 * 与升级前完全一致。
 *
 * 读的时候缓存 30 秒（每一轮聊天都要问一次场景路由），保存时立刻清缓存。
 * 本 PR 只提供契约 / 存储 / API；运行时消费方在后续 PR 逐个接入。
 */
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type ModelScenarioRoutingConfig,
  ScenarioRoutingValidationError,
  defaultScenarioRoutingConfig,
  validateScenarioRoutingConfig,
} from "../../../shared/model-scenario-routing";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { enterpriseSettings } from "../db/schema";

export const SCENARIO_ROUTING_KEY = "model_scenario_routes";

export type ScenarioRoutingStore = {
  read(): Promise<ModelScenarioRoutingConfig>;
  write(
    config: ModelScenarioRoutingConfig,
    actorUserId?: string,
  ): Promise<ModelScenarioRoutingConfig>;
};

export function createScenarioRoutingStore(
  database: Database,
): ScenarioRoutingStore {
  return {
    async read() {
      const [row] = await database
        .select({ value: enterpriseSettings.value })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, SCENARIO_ROUTING_KEY));
      if (!row) return defaultScenarioRoutingConfig();
      try {
        return validateScenarioRoutingConfig(row.value);
      } catch {
        return defaultScenarioRoutingConfig();
      }
    },
    async write(config, actorUserId) {
      const value = { version: 1, scenarios: config.scenarios };
      await database
        .insert(enterpriseSettings)
        .values({ key: SCENARIO_ROUTING_KEY, value, updatedBy: actorUserId ?? null })
        .onConflictDoUpdate({
          target: enterpriseSettings.key,
          set: { value, updatedBy: actorUserId ?? null, updatedAt: new Date() },
        });
      return { ...config, scenarios: config.scenarios };
    },
  };
}

export type ScenarioRoutingService = {
  /** 运行时每个场景决议时用（缓存 30 秒）。 */
  config(): Promise<ModelScenarioRoutingConfig>;
  get(): Promise<ModelScenarioRoutingConfig>;
  save(
    input: unknown,
    actorUserId?: string,
  ): Promise<ModelScenarioRoutingConfig>;
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
};

export function createScenarioRoutingService(options: {
  store: ScenarioRoutingStore;
  now?: () => number;
  cacheMs?: number;
}): ScenarioRoutingService {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 30_000;
  let cached: { at: number; config: ModelScenarioRoutingConfig } | null = null;

  const service: ScenarioRoutingService = {
    async config() {
      if (cached && now() - cached.at < cacheMs) return cached.config;
      const config = await options.store.read();
      cached = { at: now(), config };
      return config;
    },
    async get() {
      cached = null;
      return service.config();
    },
    async save(input, actorUserId) {
      const validated = validateScenarioRoutingConfig(input);
      await options.store.write(validated, actorUserId);
      const saved: ModelScenarioRoutingConfig = {
        ...validated,
        updatedAt: new Date(now()).toISOString(),
        updatedBy: actorUserId ?? null,
      };
      cached = {
        at: now(),
        config: { version: 1, scenarios: validated.scenarios },
      };
      return saved;
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
          if (error instanceof ScenarioRoutingValidationError) {
            return context.json({ error: error.message }, 400);
          }
          return context.json(
            { error: "场景路由配置暂时无法保存，请稍后重试。" },
            503,
          );
        }
      });
      return routes;
    },
  };
  return service;
}
