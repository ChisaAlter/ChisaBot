/**
 * Harness 7 项高影响 AI 能力热开关持久化存储 + 管理员 API（GET/PUT /api/admin/harness）+ 运行时读取器 `getHarnessFlags()`。
 *
 * - 运行时幂等建单行表 `chisabot_harness_settings`（id = 'default'）；
 * - 集中管控 7 项高影响能力：
 *   1. memoryDreaming（后台记忆整理，默认关闭，明确标注消耗模型 Token）
 *   2. interactiveForms（交互表单，默认开启）
 *   3. browserSubagent（浏览器子 Agent，默认开启）
 *   4. cookieImport（导入浏览器登录态，默认开启）
 *   5. passkeyForward（通行密钥 WebAuthn 转发，默认开启）
 *   6. desktopControl（桌面图形操作，默认开启）
 *   7. teachByDemo（演示教学录制，默认开启）
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  DEFAULT_HARNESS_FLAGS,
  HARNESS_FLAG_DESCRIPTORS,
  type HarnessFlags,
  type HarnessSettingsView,
} from "../../../shared/admin-workbench";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";

export class HarnessSettingsValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "HarnessSettingsValidationError";
  }
}

export type HarnessSettingsRecord = {
  flags: HarnessFlags;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type HarnessSettingsStorage = {
  ensure(): Promise<void>;
  read(): Promise<HarnessSettingsRecord>;
  write(flags: HarnessFlags, actorId: string): Promise<HarnessSettingsRecord>;
};

export type HarnessSettingsDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

type HarnessRow = {
  memory_dreaming: boolean;
  interactive_forms: boolean;
  browser_subagent: boolean;
  cookie_import: boolean;
  passkey_forward: boolean;
  desktop_control: boolean;
  teach_by_demo: boolean;
  updated_at: Date | string | null;
  updated_by: string | null;
};

const harnessPatchSchema = z
  .object({
    memoryDreaming: z.boolean().optional(),
    interactiveForms: z.boolean().optional(),
    browserSubagent: z.boolean().optional(),
    cookieImport: z.boolean().optional(),
    passkeyForward: z.boolean().optional(),
    desktopControl: z.boolean().optional(),
    teachByDemo: z.boolean().optional(),
  })
  .strict();

export function parseHarnessPatch(
  raw: unknown,
  base: HarnessFlags = DEFAULT_HARNESS_FLAGS,
): HarnessFlags {
  const source =
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "flags" in raw &&
    Object.keys(raw).length === 1
      ? (raw as { flags: unknown }).flags
      : raw;
  const parsed = harnessPatchSchema.safeParse(source);
  if (!parsed.success) {
    throw new HarnessSettingsValidationError(
      parsed.error.issues[0]?.message ??
        "能力开关参数必须是有效的布尔键值对象。",
    );
  }
  return {
    memoryDreaming: parsed.data.memoryDreaming ?? base.memoryDreaming,
    interactiveForms: parsed.data.interactiveForms ?? base.interactiveForms,
    browserSubagent: parsed.data.browserSubagent ?? base.browserSubagent,
    cookieImport: parsed.data.cookieImport ?? base.cookieImport,
    passkeyForward: parsed.data.passkeyForward ?? base.passkeyForward,
    desktopControl: parsed.data.desktopControl ?? base.desktopControl,
    teachByDemo: parsed.data.teachByDemo ?? base.teachByDemo,
  };
}

export function createPgHarnessSettingsStorage(
  database: HarnessSettingsDatabase,
  options?: { now?: () => number },
): HarnessSettingsStorage {
  const sql = database.$client;
  const nowFn = options?.now ?? Date.now;

  return {
    async ensure() {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS chisabot_harness_settings (
          id text PRIMARY KEY DEFAULT 'default',
          memory_dreaming boolean NOT NULL DEFAULT false,
          interactive_forms boolean NOT NULL DEFAULT true,
          browser_subagent boolean NOT NULL DEFAULT true,
          cookie_import boolean NOT NULL DEFAULT true,
          passkey_forward boolean NOT NULL DEFAULT true,
          desktop_control boolean NOT NULL DEFAULT true,
          teach_by_demo boolean NOT NULL DEFAULT true,
          updated_at timestamptz,
          updated_by text
        );
      `);
    },

    async read() {
      const rows = await sql.unsafe<HarnessRow[]>(
        `SELECT memory_dreaming, interactive_forms, browser_subagent,
                cookie_import, passkey_forward, desktop_control, teach_by_demo,
                updated_at, updated_by
         FROM chisabot_harness_settings
         WHERE id = 'default'`,
      );
      const row = rows[0];
      if (!row) {
        return {
          flags: { ...DEFAULT_HARNESS_FLAGS },
          updatedAt: null,
          updatedBy: null,
        };
      }
      return {
        flags: {
          memoryDreaming: Boolean(row.memory_dreaming),
          interactiveForms: Boolean(row.interactive_forms),
          browserSubagent: Boolean(row.browser_subagent),
          cookieImport: Boolean(row.cookie_import),
          passkeyForward: Boolean(row.passkey_forward),
          desktopControl: Boolean(row.desktop_control),
          teachByDemo: Boolean(row.teach_by_demo),
        },
        updatedAt: row.updated_at
          ? new Date(row.updated_at).toISOString()
          : null,
        updatedBy: row.updated_by ?? null,
      };
    },

    async write(flags, actorId) {
      const updatedAt = new Date(nowFn()).toISOString();
      await sql.unsafe(
        `INSERT INTO chisabot_harness_settings (
           id, memory_dreaming, interactive_forms, browser_subagent,
           cookie_import, passkey_forward, desktop_control, teach_by_demo,
           updated_at, updated_by
         )
         VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           memory_dreaming = $1,
           interactive_forms = $2,
           browser_subagent = $3,
           cookie_import = $4,
           passkey_forward = $5,
           desktop_control = $6,
           teach_by_demo = $7,
           updated_at = $8,
           updated_by = $9`,
        [
          flags.memoryDreaming,
          flags.interactiveForms,
          flags.browserSubagent,
          flags.cookieImport,
          flags.passkeyForward,
          flags.desktopControl,
          flags.teachByDemo,
          updatedAt,
          actorId,
        ],
      );
      return {
        flags: { ...flags },
        updatedAt,
        updatedBy: actorId,
      };
    },
  };
}

export function createMemoryHarnessSettingsStorage(options?: {
  initial?: Partial<HarnessFlags>;
  now?: () => number;
}): HarnessSettingsStorage {
  const nowFn = options?.now ?? Date.now;
  let current: HarnessSettingsRecord = {
    flags: { ...DEFAULT_HARNESS_FLAGS, ...options?.initial },
    updatedAt: null,
    updatedBy: null,
  };

  return {
    async ensure() {},
    async read() {
      return {
        flags: { ...current.flags },
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
      };
    },
    async write(flags, actorId) {
      current = {
        flags: { ...flags },
        updatedAt: new Date(nowFn()).toISOString(),
        updatedBy: actorId,
      };
      return {
        flags: { ...current.flags },
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
      };
    },
  };
}

export type HarnessSettingsService = {
  ensure(): Promise<void>;
  refresh(): Promise<HarnessFlags>;
  currentFlags(): HarnessFlags;
  view(): Promise<HarnessSettingsView>;
  save(raw: unknown, actorId: string): Promise<HarnessSettingsView>;
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
};

let activeHarnessFlagsReader: () => HarnessFlags = () => ({
  ...DEFAULT_HARNESS_FLAGS,
});

/** 运行时同步读取当前生效的 7 项 Harness 能力开关快照。 */
export function getHarnessFlags(): HarnessFlags {
  return { ...activeHarnessFlagsReader() };
}

export function setActiveHarnessFlagsReader(
  reader: (() => HarnessFlags) | null,
): void {
  activeHarnessFlagsReader = reader ?? (() => ({ ...DEFAULT_HARNESS_FLAGS }));
}

export function createHarnessSettingsService(
  storage: HarnessSettingsStorage,
  options?: { activateGlobal?: boolean },
): HarnessSettingsService {
  let cached: HarnessSettingsRecord = {
    flags: { ...DEFAULT_HARNESS_FLAGS },
    updatedAt: null,
    updatedBy: null,
  };

  const toView = (record: HarnessSettingsRecord): HarnessSettingsView => ({
    flags: { ...record.flags },
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    descriptors: HARNESS_FLAG_DESCRIPTORS,
  });

  const service: HarnessSettingsService = {
    async ensure() {
      await storage.ensure();
      cached = await storage.read();
    },
    async refresh() {
      cached = await storage.read();
      return { ...cached.flags };
    },
    currentFlags() {
      return { ...cached.flags };
    },
    async view() {
      cached = await storage.read();
      return toView(cached);
    },
    async save(raw, actorId) {
      const current = await storage.read();
      const nextFlags = parseHarnessPatch(raw, current.flags);
      cached = await storage.write(nextFlags, actorId);
      return toView(cached);
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

      routes.get("/", async (context) => {
        try {
          return context.json(await service.view());
        } catch {
          return context.json(
            { error: "能力开关配置暂时无法读取，请稍后重试。" },
            503,
          );
        }
      });

      routes.put(
        "/",
        bodyLimit({
          maxSize: 16 * 1024,
          onError: (context) =>
            context.json({ error: "能力开关请求体过大。" }, 413),
        }),
        async (context) => {
          const body: unknown = await context.req.json().catch(() => null);
          try {
            return context.json(await service.save(body, context.var.actor.id));
          } catch (error) {
            if (error instanceof HarnessSettingsValidationError) {
              return context.json({ error: error.message }, 400);
            }
            return context.json(
              { error: "能力开关配置暂时无法保存，请稍后重试。" },
              503,
            );
          }
        },
      );

      return routes;
    },
  };

  if (options?.activateGlobal !== false) {
    setActiveHarnessFlagsReader(() => service.currentFlags());
  }

  return service;
}
