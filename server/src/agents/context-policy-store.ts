import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type ModelContextPolicyOverride,
  parseTokenShorthand,
  validateContextPolicy,
} from "../../../shared/context-policy";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { validModelId } from "./model-selection";

/**
 * 按模型覆写上下文容量（`contextWindowTokens`）与摘要触发阈值（`summaryThresholdTokens`）。
 *
 * - 运行时幂等建表 `chisabot_model_context_overrides`，不改动 Drizzle 旧表结构。
 * - 支持 `1M`、`400K`、`128000` 等简写字符串或正整数，强制校验 `summaryThresholdTokens < contextWindowTokens` 与安全下限。
 * - 读路径内置短缓存（30s），写/删操作即时失效，供 `model-catalog.ts`、`history-budget.ts`、`dsh-runtime.ts` 优先消费。
 */

export class ContextPolicyValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ContextPolicyValidationError";
  }
}

export type ContextPolicyRow = {
  model_id: string;
  context_window_tokens: number | string;
  summary_threshold_tokens: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
};

export type ContextPolicyDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

export type ContextPolicyStore = {
  ensure(): Promise<void>;
  list(): Promise<ModelContextPolicyOverride[]>;
  get(modelId: string): Promise<ModelContextPolicyOverride | null>;
  upsert(actorId: string, raw: unknown): Promise<ModelContextPolicyOverride>;
  remove(modelId: string): Promise<boolean>;
  invalidate(): void;
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
};

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

function parseTokenField(
  raw: unknown,
  label: string,
  required: boolean,
): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    if (required) {
      throw new ContextPolicyValidationError(`请填写${label}。`);
    }
    return undefined;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
      throw new ContextPolicyValidationError(`${label}必须是正整数。`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = parseTokenShorthand(raw);
    if (parsed === null) {
      throw new ContextPolicyValidationError(
        `${label}格式无效，请使用正整数或 1M / 400K 简写。`,
      );
    }
    return parsed;
  }
  throw new ContextPolicyValidationError(
    `${label}必须是数字或 1M / 400K 格式字符串。`,
  );
}

function projectRow(row: ContextPolicyRow): ModelContextPolicyOverride {
  return {
    modelId: row.model_id,
    contextWindowTokens: Number(row.context_window_tokens),
    summaryThresholdTokens: Number(row.summary_threshold_tokens),
    updatedAt: iso(row.updated_at),
  };
}

function matchOverride(
  policies: readonly ModelContextPolicyOverride[],
  modelId: string,
): ModelContextPolicyOverride | null {
  const needle = modelId.trim().toLowerCase();
  if (!needle) return null;
  const exact = policies.find(
    (entry) => entry.modelId.toLowerCase() === needle,
  );
  if (exact) return exact;
  const tail = needle.split("/").pop() ?? needle;
  return (
    policies.find((entry) => {
      const candidate = entry.modelId.toLowerCase();
      return (candidate.split("/").pop() ?? candidate) === tail;
    }) ?? null
  );
}

export function createContextPolicyStore(
  database: ContextPolicyDatabase,
  options: {
    now?: () => number;
    cacheMs?: number;
  } = {},
): ContextPolicyStore {
  const sql = database.$client;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 30_000;
  let cache: { at: number; policies: ModelContextPolicyOverride[] } | null =
    null;

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_model_context_overrides (
        model_id text PRIMARY KEY,
        context_window_tokens integer NOT NULL,
        summary_threshold_tokens integer NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
    `);
  }

  function invalidate(): void {
    cache = null;
  }

  async function readAll(
    useCache = true,
  ): Promise<ModelContextPolicyOverride[]> {
    if (useCache && cache && now() - cache.at < cacheMs) {
      return cache.policies.map((item) => ({ ...item }));
    }
    const rows = await sql.unsafe<ContextPolicyRow[]>(
      `SELECT model_id, context_window_tokens, summary_threshold_tokens, updated_at, updated_by
       FROM chisabot_model_context_overrides
       ORDER BY model_id ASC`,
    );
    const policies = rows.map(projectRow);
    cache = { at: now(), policies };
    return policies.map((item) => ({ ...item }));
  }

  async function list(): Promise<ModelContextPolicyOverride[]> {
    return readAll(false);
  }

  async function get(
    modelId: string,
  ): Promise<ModelContextPolicyOverride | null> {
    if (!modelId.trim()) return null;
    const policies = await readAll(true);
    return matchOverride(policies, modelId);
  }

  async function upsert(
    actorId: string,
    raw: unknown,
  ): Promise<ModelContextPolicyOverride> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ContextPolicyValidationError("请提交有效的 JSON 参数。");
    }
    const body = raw as Record<string, unknown>;
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!validModelId(modelId)) {
      throw new ContextPolicyValidationError(
        "模型 ID 不能为空、不能包含空白或控制字符，且不超过 200 个字符。",
      );
    }

    const contextWindowTokens = parseTokenField(
      body.contextWindowTokens,
      "上下文容量",
      true,
    );
    const summaryThresholdTokens = parseTokenField(
      body.summaryThresholdTokens,
      "摘要触发阈值",
      false,
    );

    const validated = validateContextPolicy({
      contextWindowTokens: contextWindowTokens ?? 0,
      summaryThresholdTokens,
    });
    if (!validated.ok) {
      throw new ContextPolicyValidationError(validated.error);
    }

    const rows = await sql.unsafe<ContextPolicyRow[]>(
      `INSERT INTO chisabot_model_context_overrides (
         model_id,
         context_window_tokens,
         summary_threshold_tokens,
         updated_at,
         updated_by
       )
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (model_id) DO UPDATE SET
         context_window_tokens = $2,
         summary_threshold_tokens = $3,
         updated_at = now(),
         updated_by = $4
       RETURNING model_id, context_window_tokens, summary_threshold_tokens, updated_at, updated_by`,
      [
        modelId,
        validated.value.contextWindowTokens,
        validated.value.summaryThresholdTokens,
        actorId,
      ],
    );
    invalidate();
    const row = rows[0];
    if (!row) {
      return {
        modelId,
        contextWindowTokens: validated.value.contextWindowTokens,
        summaryThresholdTokens: validated.value.summaryThresholdTokens,
        updatedAt: new Date(now()).toISOString(),
      };
    }
    return projectRow(row);
  }

  async function remove(modelId: string): Promise<boolean> {
    const trimmed = modelId.trim();
    if (!trimmed) return false;
    const rows = await sql.unsafe<{ model_id: string }[]>(
      `DELETE FROM chisabot_model_context_overrides
       WHERE model_id = $1
       RETURNING model_id`,
      [trimmed],
    );
    invalidate();
    return rows.length > 0;
  }

  function routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }> {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.use("*", async (context, next) => {
      context.header("Cache-Control", "no-store");
      const denied = requireAdmin(context);
      if (denied) return denied;
      await next();
    });

    app.get("/", async (context) => {
      try {
        return context.json({ policies: await list() });
      } catch {
        return context.json(
          { error: "模型上下文策略暂时无法读取，请稍后重试。" },
          503,
        );
      }
    });

    app.put(
      "/",
      bodyLimit({
        maxSize: 16 * 1024,
        onError: (context) => context.json({ error: "请求体过大。" }, 413),
      }),
      async (context) => {
        const body = await context.req.json().catch(() => null);
        try {
          const policy = await upsert(context.var.actor.id, body);
          const policies = await list();
          return context.json({ policy, policies });
        } catch (error) {
          if (error instanceof ContextPolicyValidationError) {
            return context.json({ error: error.message }, 400);
          }
          return context.json(
            { error: "模型上下文策略保存失败，请稍后重试。" },
            503,
          );
        }
      },
    );

    const handleDelete = async (
      modelId: string,
      context: Context<{ Variables: AppVariables }>,
    ) => {
      if (!modelId.trim()) {
        return context.json({ error: "请提供要移除的模型 ID。" }, 400);
      }
      try {
        const deleted = await remove(modelId);
        if (!deleted) {
          return context.json({ error: "未找到该模型的上下文覆写配置。" }, 404);
        }
        return context.json({ deleted: true, policies: await list() });
      } catch {
        return context.json(
          { error: "删除模型上下文策略失败，请稍后重试。" },
          503,
        );
      }
    };

    app.delete(
      "/",
      bodyLimit({
        maxSize: 8 * 1024,
        onError: (context) => context.json({ error: "请求体过大。" }, 413),
      }),
      async (context) => {
        const fromQuery = context.req.query("modelId") ?? "";
        const body = !fromQuery
          ? ((await context.req.json().catch(() => null)) as {
              modelId?: unknown;
            } | null)
          : null;
        const modelId =
          fromQuery || (typeof body?.modelId === "string" ? body.modelId : "");
        return handleDelete(modelId, context);
      },
    );

    app.delete("/:modelId", async (context) => {
      const rawParam = context.req.param("modelId") ?? "";
      let decoded = rawParam;
      try {
        decoded = decodeURIComponent(rawParam);
      } catch {
        decoded = rawParam;
      }
      return handleDelete(decoded, context);
    });

    return app;
  }

  return {
    ensure,
    list,
    get,
    upsert,
    remove,
    invalidate,
    routes,
  };
}
