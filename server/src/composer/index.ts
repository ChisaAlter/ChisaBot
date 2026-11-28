/**
 * 输入框效率第一层：快捷短语 + 本地输入候选（CB-145 PR4）。
 *
 * 三张表（开机 ensure，幂等，回滚安全——旧版本不读它们）：
 * - chisabot_composer_settings：每人一行开关（总开关 / AI 建议 / 行内补全 / 习惯学习 / 本地候选）；
 * - chisabot_quick_phrases：用户自维护的快捷短语，(owner, normalized_text) 唯一；
 * - chisabot_composer_habit_items：按 (owner, agent) 统计实际发送过的高频输入，供本地候选排序。
 *
 * 隐私红线：
 * - 全部按 owner_user_id 隔离，任何接口都读不到别人的数据；
 * - 只记录「实际发送出去」的文本（由客户端在发送成功后回报），绝不记录未发送草稿；
 * - 用户可关闭学习（不再写入）并随时清空（按 bot 或全量）。
 *
 * 这一层完全本地匹配，不调用任何模型；AI 建议与行内补全在后续 PR 落地，
 * 设置行的 ai_enabled / completion_enabled 先存着，功能上线前不产生效果。
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";

export const COMPOSER_TEXT_MAX = 500;
export const COMPOSER_PHRASES_MAX = 200;
export const COMPOSER_CANDIDATES_MAX = 8;

export type ComposerSettings = {
  enabled: boolean;
  aiEnabled: boolean;
  completionEnabled: boolean;
  learningEnabled: boolean;
  localCompletionEnabled: boolean;
  updatedAt: string | null;
};

export type QuickPhrase = {
  id: string;
  text: string;
  position: number;
  createdAt: string;
  updatedAt: string | null;
};

export type ComposerCandidate = {
  source: "phrase" | "habit";
  text: string;
  useCount: number;
};

export class ComposerValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ComposerValidationError";
  }
}

/** 归一化用于去重与前缀匹配：小写、压缩空白、去首尾。 */
export function normalizeComposerText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function cleanText(input: unknown): string {
  if (typeof input !== "string")
    throw new ComposerValidationError("请提供文本。");
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) throw new ComposerValidationError("文本不能为空。");
  if ([...text].length > COMPOSER_TEXT_MAX)
    throw new ComposerValidationError(`文本最长 ${COMPOSER_TEXT_MAX} 字。`);
  return text;
}

function cleanId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(input))
    throw new ComposerValidationError("id 不合法。");
  return input;
}

export function createComposerService(database: Database) {
  const sql = database.$client;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_composer_settings (
        owner_user_id text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT true,
        ai_enabled boolean NOT NULL DEFAULT false,
        completion_enabled boolean NOT NULL DEFAULT false,
        learning_enabled boolean NOT NULL DEFAULT false,
        local_completion_enabled boolean NOT NULL DEFAULT true,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS chisabot_quick_phrases (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        text text NOT NULL,
        normalized_text text NOT NULL,
        position integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        UNIQUE (owner_user_id, normalized_text)
      );
      CREATE INDEX IF NOT EXISTS chisabot_quick_phrases_owner_idx
        ON chisabot_quick_phrases (owner_user_id, position);
      CREATE TABLE IF NOT EXISTS chisabot_composer_habit_items (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        agent_id text NOT NULL,
        text text NOT NULL,
        normalized_text text NOT NULL,
        use_count integer NOT NULL DEFAULT 0,
        shown_count integer NOT NULL DEFAULT 0,
        accepted_count integer NOT NULL DEFAULT 0,
        ignored_count integer NOT NULL DEFAULT 0,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        UNIQUE (owner_user_id, agent_id, normalized_text)
      );
      CREATE INDEX IF NOT EXISTS chisabot_composer_habit_owner_idx
        ON chisabot_composer_habit_items (owner_user_id, agent_id, use_count DESC);
    `);
  }

  // ------------------------------------------------------------------ settings

  const DEFAULT_SETTINGS: Omit<ComposerSettings, "updatedAt"> = {
    enabled: true,
    aiEnabled: false,
    completionEnabled: false,
    learningEnabled: false,
    localCompletionEnabled: true,
  };

  async function readSettings(owner: string): Promise<ComposerSettings> {
    const rows = await sql.unsafe(
      "SELECT enabled, ai_enabled, completion_enabled, learning_enabled, local_completion_enabled, updated_at FROM chisabot_composer_settings WHERE owner_user_id = $1",
      [owner],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return { ...DEFAULT_SETTINGS, updatedAt: null };
    return {
      enabled: row.enabled === true,
      aiEnabled: row.ai_enabled === true,
      completionEnabled: row.completion_enabled === true,
      learningEnabled: row.learning_enabled === true,
      localCompletionEnabled: row.local_completion_enabled === true,
      updatedAt: row.updated_at
        ? new Date(row.updated_at as string).toISOString()
        : null,
    };
  }

  async function writeSettings(
    owner: string,
    input: unknown,
  ): Promise<ComposerSettings> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ComposerValidationError("请提供设置对象。");
    const value = input as Record<string, unknown>;
    const bool = (v: unknown, fallback: boolean) =>
      v === undefined ? fallback : v === true;
    const current = await readSettings(owner);
    const next = {
      enabled: bool(value.enabled, current.enabled),
      aiEnabled: bool(value.aiEnabled, current.aiEnabled),
      completionEnabled: bool(
        value.completionEnabled,
        current.completionEnabled,
      ),
      learningEnabled: bool(value.learningEnabled, current.learningEnabled),
      localCompletionEnabled: bool(
        value.localCompletionEnabled,
        current.localCompletionEnabled,
      ),
    };
    await sql.unsafe(
      `INSERT INTO chisabot_composer_settings (owner_user_id, enabled, ai_enabled, completion_enabled, learning_enabled, local_completion_enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (owner_user_id) DO UPDATE SET
         enabled = $2, ai_enabled = $3, completion_enabled = $4, learning_enabled = $5, local_completion_enabled = $6, updated_at = now()`,
      [
        owner,
        next.enabled,
        next.aiEnabled,
        next.completionEnabled,
        next.learningEnabled,
        next.localCompletionEnabled,
      ],
    );
    return readSettings(owner);
  }

  // ------------------------------------------------------------------ quick phrases

  async function listPhrases(owner: string): Promise<QuickPhrase[]> {
    const rows = await sql.unsafe(
      "SELECT id, text, position, created_at, updated_at FROM chisabot_quick_phrases WHERE owner_user_id = $1 ORDER BY position, created_at",
      [owner],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      text: String(row.text),
      position: Number(row.position),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: row.updated_at
        ? new Date(row.updated_at as string).toISOString()
        : null,
    }));
  }

  async function addPhrase(
    owner: string,
    input: unknown,
  ): Promise<QuickPhrase> {
    const text = cleanText((input as Record<string, unknown>)?.text);
    const normalized = normalizeComposerText(text);
    const count = await sql.unsafe(
      "SELECT count(*)::int AS n FROM chisabot_quick_phrases WHERE owner_user_id = $1",
      [owner],
    );
    if ((count[0] as { n: number }).n >= COMPOSER_PHRASES_MAX)
      throw new ComposerValidationError(
        `快捷短语最多 ${COMPOSER_PHRASES_MAX} 条。`,
      );
    const exists = await sql.unsafe(
      "SELECT id FROM chisabot_quick_phrases WHERE owner_user_id = $1 AND normalized_text = $2",
      [owner, normalized],
    );
    if (exists.length) throw new ComposerValidationError("这条短语已经存在。");
    const id = crypto.randomUUID();
    const bottom = await sql.unsafe(
      "SELECT COALESCE(max(position) + 1, 0)::int AS p FROM chisabot_quick_phrases WHERE owner_user_id = $1",
      [owner],
    );
    const position = (bottom[0] as { p: number }).p;
    await sql.unsafe(
      "INSERT INTO chisabot_quick_phrases (id, owner_user_id, text, normalized_text, position) VALUES ($1, $2, $3, $4, $5)",
      [id, owner, text, normalized, position],
    );
    return {
      id,
      text,
      position,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
  }

  async function updatePhrase(
    owner: string,
    id: string,
    input: unknown,
  ): Promise<QuickPhrase | null> {
    cleanId(id);
    const text = cleanText((input as Record<string, unknown>)?.text);
    const normalized = normalizeComposerText(text);
    const dupe = await sql.unsafe(
      "SELECT id FROM chisabot_quick_phrases WHERE owner_user_id = $1 AND normalized_text = $2 AND id <> $3",
      [owner, normalized, id],
    );
    if (dupe.length) throw new ComposerValidationError("这条短语已经存在。");
    const rows = await sql.unsafe(
      "UPDATE chisabot_quick_phrases SET text = $3, normalized_text = $4, updated_at = now() WHERE owner_user_id = $1 AND id = $2 RETURNING id, text, position, created_at, updated_at",
      [owner, id, text, normalized],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      text: String(row.text),
      position: Number(row.position),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: row.updated_at
        ? new Date(row.updated_at as string).toISOString()
        : null,
    };
  }

  async function deletePhrase(owner: string, id: string): Promise<boolean> {
    cleanId(id);
    const rows = await sql.unsafe(
      "DELETE FROM chisabot_quick_phrases WHERE owner_user_id = $1 AND id = $2 RETURNING id",
      [owner, id],
    );
    return rows.length > 0;
  }

  async function reorderPhrases(
    owner: string,
    input: unknown,
  ): Promise<QuickPhrase[]> {
    const ids = (input as Record<string, unknown>)?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw new ComposerValidationError("请提供 id 顺序列表。");
    const existing = await listPhrases(owner);
    if (ids.length !== existing.length || new Set(ids).size !== ids.length)
      throw new ComposerValidationError("顺序列表与现有短语不一致。");
    const known = new Set(existing.map((phrase) => phrase.id));
    if (ids.some((id) => !known.has(id)))
      throw new ComposerValidationError("顺序列表与现有短语不一致。");
    for (const [position, id] of (ids as string[]).entries()) {
      await sql.unsafe(
        "UPDATE chisabot_quick_phrases SET position = $3, updated_at = now() WHERE owner_user_id = $1 AND id = $2",
        [owner, id, position],
      );
    }
    return listPhrases(owner);
  }

  // ------------------------------------------------------------------ habits + candidates

  /** 发送成功后由客户端回报：只在学习开启时写入；多次发送同一文本累加 use_count。 */
  async function recordHabit(
    owner: string,
    input: unknown,
  ): Promise<{ recorded: boolean }> {
    const settings = await readSettings(owner);
    if (!settings.learningEnabled) return { recorded: false };
    const body = (input ?? {}) as Record<string, unknown>;
    const agentId = cleanId(body.botId);
    const text = cleanText(body.text);
    const normalized = normalizeComposerText(text);
    await sql.unsafe(
      `INSERT INTO chisabot_composer_habit_items (id, owner_user_id, agent_id, text, normalized_text, use_count, last_used_at)
       VALUES ($1, $2, $3, $4, $5, 1, now())
       ON CONFLICT (owner_user_id, agent_id, normalized_text) DO UPDATE SET
         use_count = chisabot_composer_habit_items.use_count + 1,
         text = $4,
         last_used_at = now(),
         updated_at = now()`,
      [crypto.randomUUID(), owner, agentId, text, normalized],
    );
    return { recorded: true };
  }

  /** 本地候选：快捷短语（按 position）优先，其后按 bot 的高频习惯（按 use_count）。 */
  async function candidates(
    owner: string,
    input: { botId?: string; prefix?: string },
  ): Promise<ComposerCandidate[]> {
    const settings = await readSettings(owner);
    if (!settings.enabled || !settings.localCompletionEnabled) return [];
    const prefix =
      typeof input.prefix === "string"
        ? normalizeComposerText(input.prefix)
        : "";
    const out: ComposerCandidate[] = [];
    const seen = new Set<string>();
    if (prefix) {
      const phrases = await sql.unsafe(
        "SELECT text FROM chisabot_quick_phrases WHERE owner_user_id = $1 AND normalized_text LIKE $2 ORDER BY position LIMIT $3",
        [owner, `${prefix}%`, COMPOSER_CANDIDATES_MAX],
      );
      for (const row of phrases as Record<string, unknown>[]) {
        const text = String(row.text);
        const key = normalizeComposerText(text);
        if (key === prefix || seen.has(key)) continue;
        seen.add(key);
        out.push({ source: "phrase", text, useCount: 0 });
      }
    }
    if (input.botId && settings.learningEnabled && prefix) {
      const botId = cleanId(input.botId);
      const habits = await sql.unsafe(
        "SELECT text, use_count FROM chisabot_composer_habit_items WHERE owner_user_id = $1 AND agent_id = $2 AND normalized_text LIKE $3 ORDER BY use_count DESC, last_used_at DESC NULLS LAST LIMIT $4",
        [owner, botId, `${prefix}%`, COMPOSER_CANDIDATES_MAX],
      );
      for (const row of habits as Record<string, unknown>[]) {
        const text = String(row.text);
        const key = normalizeComposerText(text);
        if (key === prefix || seen.has(key)) continue;
        seen.add(key);
        out.push({ source: "habit", text, useCount: Number(row.use_count) });
      }
    }
    return out.slice(0, COMPOSER_CANDIDATES_MAX);
  }

  async function clearHabits(
    owner: string,
    botId?: string,
  ): Promise<{ cleared: number }> {
    if (botId) {
      cleanId(botId);
      const rows = await sql.unsafe(
        "DELETE FROM chisabot_composer_habit_items WHERE owner_user_id = $1 AND agent_id = $2 RETURNING id",
        [owner, botId],
      );
      return { cleared: rows.length };
    }
    const rows = await sql.unsafe(
      "DELETE FROM chisabot_composer_habit_items WHERE owner_user_id = $1 RETURNING id",
      [owner],
    );
    return { cleared: rows.length };
  }

  // ------------------------------------------------------------------ routes

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.use("*", async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    });
    const owner = (context: { var: AppVariables }) => context.var.actor.id;

    app.get("/settings", async (context) =>
      context.json(await readSettings(owner(context))),
    );
    app.put("/settings", async (context) => {
      try {
        return context.json(
          await writeSettings(
            owner(context),
            await context.req.json().catch(() => null),
          ),
        );
      } catch (error) {
        if (error instanceof ComposerValidationError)
          return context.json({ error: error.message }, error.status);
        throw error;
      }
    });

    app.get("/quick-phrases", async (context) =>
      context.json({ phrases: await listPhrases(owner(context)) }),
    );
    app.post("/quick-phrases", async (context) => {
      try {
        return context.json(
          await addPhrase(
            owner(context),
            await context.req.json().catch(() => null),
          ),
          201,
        );
      } catch (error) {
        if (error instanceof ComposerValidationError)
          return context.json({ error: error.message }, error.status);
        throw error;
      }
    });
    app.patch("/quick-phrases/:id", async (context) => {
      try {
        const updated = await updatePhrase(
          owner(context),
          context.req.param("id"),
          await context.req.json().catch(() => null),
        );
        if (!updated) return context.json({ error: "找不到这条短语。" }, 404);
        return context.json(updated);
      } catch (error) {
        if (error instanceof ComposerValidationError)
          return context.json({ error: error.message }, error.status);
        throw error;
      }
    });
    app.delete("/quick-phrases/:id", async (context) => {
      try {
        const deleted = await deletePhrase(
          owner(context),
          context.req.param("id"),
        );
        if (!deleted) return context.json({ error: "找不到这条短语。" }, 404);
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof ComposerValidationError)
          return context.json({ error: error.message }, error.status);
        throw error;
      }
    });
    app.post("/quick-phrases/reorder", async (context) => {
      try {
        return context.json({
          phrases: await reorderPhrases(
            owner(context),
            await context.req.json().catch(() => null),
          ),
        });
      } catch (error) {
        if (error instanceof ComposerValidationError)
          return context.json({ error: error.message }, error.status);
        throw error;
      }
    });

    app.get("/candidates", async (context) => {
      try {
        return context.json({
          candidates: await candidates(owner(context), {
            botId: context.req.query("botId") ?? undefined,
            prefix: context.req.query("prefix") ?? undefined,
          }),
        });
      } catch (error) {
        if (error instanceof ComposerValidationError)
          return context.json({ error: error.message }, error.status);
        throw error;
      }
    });
    app.post("/habits/record", async (context) => {
      try {
        return context.json(
          await recordHabit(
            owner(context),
            await context.req.json().catch(() => null),
          ),
        );
      } catch (error) {
        if (error instanceof ComposerValidationError)
          return context.json({ error: error.message }, error.status);
        throw error;
      }
    });
    app.delete("/habits", async (context) => {
      try {
        return context.json(
          await clearHabits(
            owner(context),
            context.req.query("botId") ?? undefined,
          ),
        );
      } catch (error) {
        if (error instanceof ComposerValidationError)
          return context.json({ error: error.message }, error.status);
        throw error;
      }
    });
    return app;
  }

  return {
    ensure,
    readSettings,
    writeSettings,
    listPhrases,
    addPhrase,
    updatePhrase,
    deletePhrase,
    reorderPhrases,
    recordHabit,
    candidates,
    clearHabits,
    routes,
  };
}

export type ComposerService = ReturnType<typeof createComposerService>;
