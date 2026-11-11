/**
 * 智能体提供方实例存储、敏感环境变量加解密与 Bot 子代理授权管理。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_DRIVER_KINDS,
  AGENT_DRIVER_SPECS,
  AGENT_PROVIDER_PRESETS,
  type AgentDriverConfig,
  type AgentDriverKind,
  type AgentEnvVarInput,
  type AgentEnvVarView,
  type AgentInstanceView,
  type AgentProbeState,
  agentToolName,
  BOT_AGENT_GRANT_MODES,
  type BotAgentGrant,
  type BotAgentGrantMode,
  defaultBotAgentGrant,
  isAgentDriverKind,
  normalizeInstanceSlug,
  type RuntimeInstanceSpec,
} from "../../../shared/agent-providers";
import type { DetectedAgent } from "../../../shared/local-agents";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";

type StoredEnvVar = {
  name: string;
  sensitive: boolean;
  plainValue?: string;
  encryptedValue?: string;
};

export type InstanceRow = {
  id: string;
  owner_user_id: string;
  environment_id: string;
  slug: string;
  driver: string;
  name: string;
  description: string;
  enabled: boolean;
  expose_as_tool: boolean;
  is_default_seed: boolean;
  sort_order: number;
  config: AgentDriverConfig | null;
  env_vars: StoredEnvVar[] | null;
  probe: AgentProbeState | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type GrantRow = {
  owner_user_id: string;
  bot_id: string;
  mode: string;
  instance_ids: string[] | null;
  expose_named_tools: boolean;
  allow_nested_subagents: boolean;
  max_depth: number;
  updated_at: Date | string | null;
};

const FALLBACK_KEY = createHash("sha256")
  .update("chisabot-agent-instance-fallback-key")
  .digest("base64");

const iso = (val: Date | string | null | undefined) =>
  val ? new Date(val).toISOString() : null;

export type EnvironmentMetaResolver = (
  ownerUserId: string,
  environmentId: string,
) => Promise<{ name: string; online: boolean }>;

export function createAgentInstancesStore(options: {
  database: Database;
  encryptionKey?: string;
  resolveEnvMeta: EnvironmentMetaResolver;
}) {
  const sql = options.database.$client;
  const key = options.encryptionKey || FALLBACK_KEY;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_agent_instances (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        environment_id text NOT NULL,
        slug text NOT NULL,
        driver text NOT NULL,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        enabled boolean NOT NULL DEFAULT true,
        expose_as_tool boolean NOT NULL DEFAULT true,
        is_default_seed boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0,
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        env_vars jsonb NOT NULL DEFAULT '[]'::jsonb,
        probe jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_user_id, environment_id, slug)
      );
      CREATE INDEX IF NOT EXISTS chisabot_agent_instances_owner_env
        ON chisabot_agent_instances (owner_user_id, environment_id, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS chisabot_bot_agent_grants (
        owner_user_id text NOT NULL,
        bot_id text NOT NULL,
        mode text NOT NULL DEFAULT 'all',
        instance_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        expose_named_tools boolean NOT NULL DEFAULT true,
        allow_nested_subagents boolean NOT NULL DEFAULT true,
        max_depth integer NOT NULL DEFAULT 3,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_user_id, bot_id)
      );
    `);
  }

  function toEnvVarViews(
    stored: StoredEnvVar[] | null | undefined,
  ): AgentEnvVarView[] {
    if (!Array.isArray(stored)) return [];
    return stored
      .filter(
        (item) => item && typeof item.name === "string" && item.name.trim(),
      )
      .map((item) => ({
        name: item.name,
        value: item.sensitive ? "" : String(item.plainValue ?? ""),
        sensitive: Boolean(item.sensitive),
        hasValue: item.sensitive
          ? Boolean(item.encryptedValue)
          : Boolean(item.plainValue && item.plainValue.length > 0),
      }));
  }

  async function encodeEnvVars(
    inputs: readonly AgentEnvVarInput[] | undefined,
    existing: readonly StoredEnvVar[] = [],
  ): Promise<StoredEnvVar[]> {
    if (!inputs) return [...existing];
    const prevByName = new Map(existing.map((e) => [e.name, e]));
    const result: StoredEnvVar[] = [];
    const seen = new Set<string>();

    for (const item of inputs) {
      const name = item.name.trim();
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const prev = prevByName.get(name);
      const sensitive = item.sensitive === true;
      if (item.keepExisting && prev) {
        if (sensitive && prev.encryptedValue) {
          result.push({
            name,
            sensitive: true,
            encryptedValue: prev.encryptedValue,
          });
          continue;
        }
        if (sensitive && prev.plainValue !== undefined) {
          result.push({
            name,
            sensitive: true,
            encryptedValue: await encryptSecret(key, prev.plainValue),
          });
          continue;
        }
        if (!sensitive && prev.plainValue !== undefined) {
          result.push({ name, sensitive: false, plainValue: prev.plainValue });
          continue;
        }
      }
      const rawVal = String(item.value ?? "");
      if (sensitive) {
        if (!rawVal) {
          result.push({ name, sensitive: true });
        } else {
          result.push({
            name,
            sensitive: true,
            encryptedValue: await encryptSecret(key, rawVal),
          });
        }
      } else {
        result.push({ name, sensitive: false, plainValue: rawVal });
      }
    }
    return result;
  }

  async function decryptEnvMap(
    row: InstanceRow,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const item of row.env_vars ?? []) {
      if (!item?.name) continue;
      if (item.sensitive) {
        if (!item.encryptedValue) continue;
        try {
          out[item.name] = await decryptSecret(key, item.encryptedValue);
        } catch {
          // 密钥轮换无法解密旧条目时跳过，不泄露密文
        }
      } else if (item.plainValue !== undefined) {
        out[item.name] = item.plainValue;
      }
    }
    return out;
  }

  async function toView(
    row: InstanceRow,
    envMetaCache?: Map<string, { name: string; online: boolean }>,
  ): Promise<AgentInstanceView> {
    let meta = envMetaCache?.get(row.environment_id);
    if (!meta) {
      meta = await options.resolveEnvMeta(
        row.owner_user_id,
        row.environment_id,
      );
      envMetaCache?.set(row.environment_id, meta);
    }
    const driver = isAgentDriverKind(row.driver) ? row.driver : "custom";
    return {
      id: row.id,
      slug: row.slug,
      environmentId: row.environment_id,
      environmentName: meta.name,
      environmentOnline: meta.online,
      driver,
      name: row.name,
      description: row.description || "",
      enabled: row.enabled,
      exposeAsTool: row.expose_as_tool,
      toolName: agentToolName(row.slug),
      isDefaultSeed: row.is_default_seed,
      sortOrder: row.sort_order,
      config: row.config ?? {},
      envVars: toEnvVarViews(row.env_vars),
      probe: row.probe ?? null,
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
      updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    };
  }

  async function toRuntimeSpec(row: InstanceRow): Promise<RuntimeInstanceSpec> {
    const driver = isAgentDriverKind(row.driver) ? row.driver : "custom";
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      driver,
      config: row.config ?? {},
      env: await decryptEnvMap(row),
    };
  }

  async function uniqueSlug(
    ownerUserId: string,
    environmentId: string,
    desired: string,
    excludeId?: string,
  ): Promise<string> {
    const base = normalizeInstanceSlug(desired);
    const rows = await sql.unsafe<{ id: string; slug: string }[]>(
      "SELECT id, slug FROM chisabot_agent_instances WHERE owner_user_id = $1 AND environment_id = $2",
      [ownerUserId, environmentId],
    );
    const taken = new Set(
      rows.filter((r) => r.id !== excludeId).map((r) => r.slug),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base.slice(0, 44)}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base.slice(0, 40)}-${randomUUID().slice(0, 6)}`;
  }

  async function listRows(
    ownerUserId: string,
    environmentId?: string,
  ): Promise<InstanceRow[]> {
    if (environmentId) {
      return sql.unsafe<InstanceRow[]>(
        "SELECT * FROM chisabot_agent_instances WHERE owner_user_id = $1 AND environment_id = $2 ORDER BY sort_order ASC, created_at ASC",
        [ownerUserId, environmentId],
      );
    }
    return sql.unsafe<InstanceRow[]>(
      "SELECT * FROM chisabot_agent_instances WHERE owner_user_id = $1 ORDER BY environment_id ASC, sort_order ASC, created_at ASC",
      [ownerUserId],
    );
  }

  async function listInstances(
    ownerUserId: string,
    environmentId?: string,
  ): Promise<AgentInstanceView[]> {
    const rows = await listRows(ownerUserId, environmentId);
    const cache = new Map<string, { name: string; online: boolean }>();
    const views: AgentInstanceView[] = [];
    for (const row of rows) {
      views.push(await toView(row, cache));
    }
    return views;
  }

  async function getRow(
    ownerUserId: string,
    id: string,
  ): Promise<InstanceRow | null> {
    const rows = await sql.unsafe<InstanceRow[]>(
      "SELECT * FROM chisabot_agent_instances WHERE id = $1 AND owner_user_id = $2",
      [id, ownerUserId],
    );
    return rows[0] ?? null;
  }

  async function getInstance(
    ownerUserId: string,
    id: string,
  ): Promise<AgentInstanceView | null> {
    const row = await getRow(ownerUserId, id);
    return row ? toView(row) : null;
  }

  /**
   * 根据 id、slug 或 `envId:slug` 解析目标实例（优先选择已启用且宿主在线的实例）。
   */
  async function resolveInstanceRow(
    ownerUserId: string,
    ref: string,
    preferredEnvironmentId?: string,
  ): Promise<InstanceRow | null> {
    const needle = ref.trim();
    if (!needle) return null;
    const all = await listRows(ownerUserId);
    const byId = all.find((r) => r.id === needle);
    if (byId) return byId;

    if (needle.includes(":")) {
      const [envPart = "", slugPart = ""] = needle.split(":", 2);
      const exact = all.find(
        (r) =>
          r.environment_id === envPart &&
          (r.slug === slugPart.toLowerCase() || r.id === slugPart),
      );
      if (exact) return exact;
    }

    const normalized = normalizeInstanceSlug(needle, "");
    const matches = all.filter(
      (r) =>
        r.slug === normalized ||
        r.name.toLowerCase() === needle.toLowerCase() ||
        r.driver === needle.toLowerCase(),
    );
    if (!matches.length) return null;
    if (preferredEnvironmentId) {
      const inEnv = matches.find(
        (r) => r.environment_id === preferredEnvironmentId && r.enabled,
      );
      if (inEnv) return inEnv;
    }
    const enabledRows = matches.filter((r) => r.enabled);
    const candidates = enabledRows.length ? enabledRows : matches;
    for (const cand of candidates) {
      const meta = await options.resolveEnvMeta(
        ownerUserId,
        cand.environment_id,
      );
      if (meta.online) return cand;
    }
    return candidates[0] ?? null;
  }

  async function createInstance(input: {
    ownerUserId: string;
    environmentId: string;
    driver: AgentDriverKind;
    name: string;
    slug?: string;
    description?: string;
    enabled?: boolean;
    exposeAsTool?: boolean;
    isDefaultSeed?: boolean;
    config?: AgentDriverConfig;
    envVars?: AgentEnvVarInput[];
    probe?: AgentProbeState | null;
  }): Promise<AgentInstanceView> {
    const id = `agi_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const spec = AGENT_DRIVER_SPECS[input.driver];
    const name = input.name.trim().slice(0, 80) || spec.label;
    const slug = await uniqueSlug(
      input.ownerUserId,
      input.environmentId,
      input.slug || name || input.driver,
    );
    const encodedEnv = await encodeEnvVars(input.envVars ?? [], []);
    const countRes = await sql.unsafe<{ n: number }[]>(
      "SELECT count(*)::int AS n FROM chisabot_agent_instances WHERE owner_user_id = $1 AND environment_id = $2",
      [input.ownerUserId, input.environmentId],
    );
    const sortOrder = countRes[0]?.n ?? 0;

    const rows = await sql.unsafe<InstanceRow[]>(
      `INSERT INTO chisabot_agent_instances (
         id, owner_user_id, environment_id, slug, driver, name, description,
         enabled, expose_as_tool, is_default_seed, sort_order, config, env_vars, probe
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12::text::jsonb, $13::text::jsonb, $14::text::jsonb
       ) RETURNING *`,
      [
        id,
        input.ownerUserId,
        input.environmentId,
        slug,
        input.driver,
        name,
        (input.description ?? "").trim().slice(0, 1000),
        input.enabled !== false,
        input.exposeAsTool !== false,
        input.isDefaultSeed === true,
        sortOrder,
        JSON.stringify(input.config ?? {}),
        JSON.stringify(encodedEnv),
        input.probe ? JSON.stringify(input.probe) : null,
      ],
    );
    const created = rows[0];
    if (!created) throw new Error("Failed to insert agent instance");
    return toView(created);
  }

  async function updateInstance(
    ownerUserId: string,
    id: string,
    patch: {
      name?: string;
      slug?: string;
      description?: string;
      enabled?: boolean;
      exposeAsTool?: boolean;
      sortOrder?: number;
      config?: AgentDriverConfig;
      envVars?: AgentEnvVarInput[];
    },
  ): Promise<AgentInstanceView | null> {
    const current = await getRow(ownerUserId, id);
    if (!current) return null;
    const nextName =
      patch.name !== undefined
        ? patch.name.trim().slice(0, 80) || current.name
        : current.name;
    const nextSlug =
      patch.slug !== undefined && patch.slug.trim() !== current.slug
        ? await uniqueSlug(
            ownerUserId,
            current.environment_id,
            patch.slug,
            current.id,
          )
        : current.slug;
    const nextDescription =
      patch.description !== undefined
        ? patch.description.trim().slice(0, 1000)
        : current.description;
    const nextEnabled =
      patch.enabled !== undefined ? patch.enabled : current.enabled;
    const nextExpose =
      patch.exposeAsTool !== undefined
        ? patch.exposeAsTool
        : current.expose_as_tool;
    const nextSort =
      patch.sortOrder !== undefined ? patch.sortOrder : current.sort_order;
    const nextConfig =
      patch.config !== undefined
        ? { ...(current.config ?? {}), ...patch.config }
        : (current.config ?? {});
    const nextEnv =
      patch.envVars !== undefined
        ? await encodeEnvVars(patch.envVars, current.env_vars ?? [])
        : (current.env_vars ?? []);

    const rows = await sql.unsafe<InstanceRow[]>(
      `UPDATE chisabot_agent_instances
       SET slug = $3, name = $4, description = $5, enabled = $6, expose_as_tool = $7,
           sort_order = $8, config = $9::text::jsonb, env_vars = $10::text::jsonb, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2
       RETURNING *`,
      [
        id,
        ownerUserId,
        nextSlug,
        nextName,
        nextDescription,
        nextEnabled,
        nextExpose,
        nextSort,
        JSON.stringify(nextConfig),
        JSON.stringify(nextEnv),
      ],
    );
    return rows[0] ? toView(rows[0]) : null;
  }

  async function deleteInstance(
    ownerUserId: string,
    id: string,
  ): Promise<boolean> {
    const rows = await sql.unsafe<{ id: string }[]>(
      "DELETE FROM chisabot_agent_instances WHERE id = $1 AND owner_user_id = $2 RETURNING id",
      [id, ownerUserId],
    );
    return rows.length > 0;
  }

  async function saveProbe(
    ownerUserId: string,
    id: string,
    probe: AgentProbeState,
  ): Promise<AgentInstanceView | null> {
    const rows = await sql.unsafe<InstanceRow[]>(
      "UPDATE chisabot_agent_instances SET probe = $3::text::jsonb, updated_at = now() WHERE id = $1 AND owner_user_id = $2 RETURNING *",
      [id, ownerUserId, JSON.stringify(probe)],
    );
    return rows[0] ? toView(rows[0]) : null;
  }

  /**
   * 当宿主完成自动检测时：
   * 1. 若该宿主下尚无任何实例，自动将检测到的已安装智能体种子化为可用实例；
   * 2. 对已存在的同驱动默认实例刷新探活状态。
   */
  async function syncDetectedAgents(
    ownerUserId: string,
    environmentId: string,
    detected: readonly DetectedAgent[],
  ): Promise<void> {
    const existing = await listRows(ownerUserId, environmentId);
    const nowIso = new Date().toISOString();

    if (existing.length === 0) {
      for (const det of detected) {
        if (!(AGENT_DRIVER_KINDS as readonly string[]).includes(det.kind)) {
          continue;
        }
        const driver = det.kind as AgentDriverKind;
        // 默认不自动暴露 builtin 为重复外部工具（除非用户手动添加），聚焦外部 CLI 智能体；若只有 builtin 则也种一条禁用或备选记录
        const preset = AGENT_PROVIDER_PRESETS.find((p) => p.driver === driver);
        const isBuiltin = driver === "builtin";
        await createInstance({
          ownerUserId,
          environmentId,
          driver,
          name: preset?.name ?? AGENT_DRIVER_SPECS[driver].label,
          slug: preset?.slug ?? driver,
          description:
            preset?.description ?? AGENT_DRIVER_SPECS[driver].description,
          enabled: !isBuiltin,
          exposeAsTool: !isBuiltin,
          isDefaultSeed: true,
          config: {
            ...(preset?.config ?? {}),
            ...(det.path ? { commandPath: det.path } : {}),
          },
          probe: {
            status: "available",
            version: det.version,
            resolvedPath: det.path,
            authenticated: isBuiltin ? true : null,
            authLabel: isBuiltin ? "内置引擎" : "已检测",
            message: "可用",
            checkedAt: nowIso,
          },
        }).catch(() => {});
      }
      return;
    }

    // 已有实例：刷新默认种子实例的版本与路径快照
    const byKind = new Map(detected.map((d) => [d.kind, d]));
    for (const row of existing) {
      if (!row.is_default_seed) continue;
      const found = byKind.get(row.driver as DetectedAgent["kind"]);
      if (found) {
        await saveProbe(ownerUserId, row.id, {
          status: "available",
          version: found.version,
          resolvedPath: found.path,
          authenticated: row.probe?.authenticated ?? null,
          authLabel: row.probe?.authLabel ?? "可用",
          message: "可用",
          checkedAt: nowIso,
        }).catch(() => {});
      }
    }
  }

  async function forgetEnvironment(
    ownerUserId: string,
    environmentId: string,
  ): Promise<void> {
    await sql.unsafe(
      "DELETE FROM chisabot_agent_instances WHERE owner_user_id = $1 AND environment_id = $2",
      [ownerUserId, environmentId],
    );
  }

  // ── Bot 子代理授权 ──────────────────────────────────────────────────────

  async function getBotGrant(
    ownerUserId: string,
    botId: string,
  ): Promise<BotAgentGrant> {
    const rows = await sql.unsafe<GrantRow[]>(
      "SELECT * FROM chisabot_bot_agent_grants WHERE owner_user_id = $1 AND bot_id = $2",
      [ownerUserId, botId],
    );
    const row = rows[0];
    if (!row) return defaultBotAgentGrant(botId);
    const mode: BotAgentGrantMode = (
      BOT_AGENT_GRANT_MODES as readonly string[]
    ).includes(row.mode)
      ? (row.mode as BotAgentGrantMode)
      : "all";
    return {
      botId,
      mode,
      instanceIds: Array.isArray(row.instance_ids)
        ? row.instance_ids.filter((id): id is string => typeof id === "string")
        : [],
      exposeNamedTools: row.expose_named_tools !== false,
      allowNestedSubagents: row.allow_nested_subagents !== false,
      maxDepth: Math.min(5, Math.max(1, Number(row.max_depth) || 3)),
      updatedAt: iso(row.updated_at),
    };
  }

  async function saveBotGrant(
    ownerUserId: string,
    botId: string,
    patch: {
      mode?: BotAgentGrantMode;
      instanceIds?: string[];
      exposeNamedTools?: boolean;
      allowNestedSubagents?: boolean;
      maxDepth?: number;
    },
  ): Promise<BotAgentGrant> {
    const current = await getBotGrant(ownerUserId, botId);
    const next: BotAgentGrant = {
      botId,
      mode: patch.mode ?? current.mode,
      instanceIds:
        patch.instanceIds !== undefined
          ? [...new Set(patch.instanceIds.map((s) => s.trim()).filter(Boolean))]
          : current.instanceIds,
      exposeNamedTools:
        patch.exposeNamedTools !== undefined
          ? patch.exposeNamedTools
          : current.exposeNamedTools,
      allowNestedSubagents:
        patch.allowNestedSubagents !== undefined
          ? patch.allowNestedSubagents
          : current.allowNestedSubagents,
      maxDepth:
        patch.maxDepth !== undefined
          ? Math.min(5, Math.max(1, Math.floor(patch.maxDepth)))
          : current.maxDepth,
      updatedAt: new Date().toISOString(),
    };

    await sql.unsafe(
      `INSERT INTO chisabot_bot_agent_grants (
         owner_user_id, bot_id, mode, instance_ids, expose_named_tools, allow_nested_subagents, max_depth, updated_at
       ) VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7, now())
       ON CONFLICT (owner_user_id, bot_id) DO UPDATE SET
         mode = EXCLUDED.mode,
         instance_ids = EXCLUDED.instance_ids,
         expose_named_tools = EXCLUDED.expose_named_tools,
         allow_nested_subagents = EXCLUDED.allow_nested_subagents,
         max_depth = EXCLUDED.max_depth,
         updated_at = now()`,
      [
        ownerUserId,
        botId,
        next.mode,
        JSON.stringify(next.instanceIds),
        next.exposeNamedTools,
        next.allowNestedSubagents,
        next.maxDepth,
      ],
    );
    return getBotGrant(ownerUserId, botId);
  }

  async function listGrantedInstances(
    ownerUserId: string,
    botId: string,
    options?: { onlineOnly?: boolean },
  ): Promise<{ grant: BotAgentGrant; instances: AgentInstanceView[] }> {
    const [grant, all] = await Promise.all([
      getBotGrant(ownerUserId, botId),
      listInstances(ownerUserId),
    ]);
    if (grant.mode === "none") {
      return { grant, instances: [] };
    }
    const allowedSet =
      grant.mode === "selected" ? new Set(grant.instanceIds) : null;
    const filtered = all.filter((inst) => {
      if (!inst.enabled) return false;
      if (options?.onlineOnly && !inst.environmentOnline) return false;
      if (allowedSet && !allowedSet.has(inst.id)) return false;
      return true;
    });
    return { grant, instances: filtered };
  }

  return {
    ensure,
    listRows,
    listInstances,
    getRow,
    getInstance,
    resolveInstanceRow,
    toRuntimeSpec,
    toView,
    createInstance,
    updateInstance,
    deleteInstance,
    saveProbe,
    syncDetectedAgents,
    forgetEnvironment,
    getBotGrant,
    saveBotGrant,
    listGrantedInstances,
  };
}
