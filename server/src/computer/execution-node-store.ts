/**
 * 远程执行节点可视化热配置与热切换存储 + 管理员 API（Wave 8）：
 *
 * - 运行时幂等建表 `chisabot_execution_nodes`（支持多节点保存、AES-256-GCM 封存访问令牌、激活节点热切换）；
 * - 子服务健康探活统一走 `trustedEndpointFetch("agent-computer", ...)`，禁止裸 fetch；
 * - 跨源密钥隔离：修改节点地址 origin 时如未重填令牌，自动清空旧令牌防凭据跨源外泄；
 * - 未激活远程节点时由 `provider.ts` 无缝回退到既有环境变量静态模式。
 */

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type {
  ExecutionNodeHealthDetail,
  ExecutionNodeHealthResult,
  ExecutionNodeHealthStatus,
  ExecutionNodeInput,
  ExecutionNodesListResponse,
  ExecutionNodeView,
} from "../../../shared/app-packages";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import { computerHeaders } from "../../../shared/protocol-headers";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { trustedEndpointFetch } from "../net/trusted-endpoint-fetch";

const NODE_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const MAX_EXECUTION_NODES = 32;
const PROBE_TIMEOUT_MS = 10_000;

export class ExecutionNodeError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "ExecutionNodeError";
    this.status = status;
  }
}

export type ActiveExecutionNode = {
  id: string;
  name: string;
  baseUrl: string;
  token?: string;
  allowPrivateNetwork: boolean;
};

export type StoredExecutionNodeRow = {
  id: string;
  name: string;
  baseUrl: string;
  encryptedToken: string | null;
  allowPrivateNetwork: boolean;
  isActive: boolean;
  lastHealthStatus: ExecutionNodeHealthStatus;
  lastHealthCheckedAt: string | null;
  lastHealthDetail: ExecutionNodeHealthDetail | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionNodeStorage = {
  ensure(): Promise<void>;
  list(): Promise<StoredExecutionNodeRow[]>;
  get(id: string): Promise<StoredExecutionNodeRow | null>;
  upsert(row: StoredExecutionNodeRow): Promise<void>;
  setActive(id: string | null): Promise<void>;
  delete(id: string): Promise<boolean>;
};

export type ExecutionNodeDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

type PgExecutionNodeRow = {
  id: string;
  name: string;
  base_url: string;
  encrypted_token: string | null;
  allow_private_network: boolean;
  is_active: boolean;
  last_health_status: string;
  last_health_checked_at: Date | string | null;
  last_health_detail: unknown;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function isoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value ? isoString(value) : null;
}

function parseDetail(value: unknown): ExecutionNodeHealthDetail | null {
  if (!value) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as ExecutionNodeHealthDetail)
    : null;
}

export function createPgExecutionNodeStorage(
  database: ExecutionNodeDatabase,
): ExecutionNodeStorage {
  const sql = database.$client;

  function mapRow(row: PgExecutionNodeRow): StoredExecutionNodeRow {
    const status: ExecutionNodeHealthStatus =
      row.last_health_status === "healthy" ||
      row.last_health_status === "unhealthy"
        ? row.last_health_status
        : "unknown";
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      encryptedToken: row.encrypted_token ?? null,
      allowPrivateNetwork: Boolean(row.allow_private_network),
      isActive: Boolean(row.is_active),
      lastHealthStatus: status,
      lastHealthCheckedAt: isoOrNull(row.last_health_checked_at),
      lastHealthDetail: parseDetail(row.last_health_detail),
      createdBy: row.created_by,
      createdAt: isoString(row.created_at),
      updatedAt: isoString(row.updated_at),
    };
  }

  return {
    async ensure() {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS chisabot_execution_nodes (
          id text PRIMARY KEY,
          name text NOT NULL,
          base_url text NOT NULL,
          encrypted_token text,
          allow_private_network boolean NOT NULL DEFAULT false,
          is_active boolean NOT NULL DEFAULT false,
          last_health_status text NOT NULL DEFAULT 'unknown',
          last_health_checked_at timestamptz,
          last_health_detail jsonb,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
    },

    async list() {
      const rows = await sql.unsafe<PgExecutionNodeRow[]>(
        `SELECT id, name, base_url, encrypted_token, allow_private_network,
                is_active, last_health_status, last_health_checked_at,
                last_health_detail, created_by, created_at, updated_at
         FROM chisabot_execution_nodes
         ORDER BY is_active DESC, updated_at DESC, id ASC`,
      );
      return rows.map(mapRow);
    },

    async get(id) {
      const rows = await sql.unsafe<PgExecutionNodeRow[]>(
        `SELECT id, name, base_url, encrypted_token, allow_private_network,
                is_active, last_health_status, last_health_checked_at,
                last_health_detail, created_by, created_at, updated_at
         FROM chisabot_execution_nodes
         WHERE id = $1`,
        [id],
      );
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async upsert(row) {
      await sql.unsafe(
        `INSERT INTO chisabot_execution_nodes (
           id, name, base_url, encrypted_token, allow_private_network,
           is_active, last_health_status, last_health_checked_at,
           last_health_detail, created_by, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET
           name = $2,
           base_url = $3,
           encrypted_token = $4,
           allow_private_network = $5,
           is_active = $6,
           last_health_status = $7,
           last_health_checked_at = $8,
           last_health_detail = $9::jsonb,
           updated_at = $12`,
        [
          row.id,
          row.name,
          row.baseUrl,
          row.encryptedToken,
          row.allowPrivateNetwork,
          row.isActive,
          row.lastHealthStatus,
          row.lastHealthCheckedAt,
          row.lastHealthDetail ? JSON.stringify(row.lastHealthDetail) : null,
          row.createdBy,
          row.createdAt,
          row.updatedAt,
        ],
      );
    },

    async setActive(id) {
      await sql.unsafe(
        `UPDATE chisabot_execution_nodes
         SET is_active = CASE WHEN id = $1 THEN true ELSE false END,
             updated_at = now()`,
        [id ?? ""],
      );
    },

    async delete(id) {
      const rows = await sql.unsafe<{ id: string }[]>(
        `DELETE FROM chisabot_execution_nodes WHERE id = $1 RETURNING id`,
        [id],
      );
      return rows.length > 0;
    },
  };
}

export function createMemoryExecutionNodeStorage(): ExecutionNodeStorage {
  const rows = new Map<string, StoredExecutionNodeRow>();

  return {
    async ensure() {},
    async list() {
      return [...rows.values()]
        .map((r) => ({
          ...r,
          lastHealthDetail: r.lastHealthDetail ? { ...r.lastHealthDetail } : null,
        }))
        .sort((a, b) => {
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          return b.updatedAt.localeCompare(a.updatedAt);
        });
    },
    async get(id) {
      const found = rows.get(id);
      return found
        ? {
            ...found,
            lastHealthDetail: found.lastHealthDetail
              ? { ...found.lastHealthDetail }
              : null,
          }
        : null;
    },
    async upsert(row) {
      rows.set(row.id, {
        ...row,
        lastHealthDetail: row.lastHealthDetail
          ? { ...row.lastHealthDetail }
          : null,
      });
    },
    async setActive(id) {
      for (const [key, row] of rows.entries()) {
        rows.set(key, {
          ...row,
          isActive: id !== null && key === id,
        });
      }
    },
    async delete(id) {
      return rows.delete(id);
    },
  };
}

export function validateExecutionNodeUrl(
  rawUrl: unknown,
  allowPrivateNetwork: boolean,
): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new ExecutionNodeError("执行节点地址不能为空。", 400);
  }
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ExecutionNodeError("执行节点地址不是有效的 URL。", 400);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    /%2f|%5c|%2e/i.test(parsed.pathname)
  ) {
    throw new ExecutionNodeError(
      "执行节点地址必须是干净的 http(s) 地址（不能含账密、查询串或编码穿越）。",
      400,
    );
  }
  if (parsed.protocol !== "https:" && !allowPrivateNetwork) {
    throw new ExecutionNodeError(
      "非私网节点必须使用 HTTPS，或显式勾选「允许内网 / 专网节点」。",
      400,
    );
  }
  // 即使勾选允许私网，也始终拒绝云元数据地址（169.254.169.254 等）
  const verdict = checkPublicUrl(parsed.href, {
    allowPrivate: allowPrivateNetwork,
  });
  if (!verdict.ok) {
    throw new ExecutionNodeError(
      `执行节点地址未通过安全校验：${verdict.reason}`,
      400,
    );
  }
  return parsed.href.replace(/\/+$/, "");
}

function validateNodeName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ExecutionNodeError("节点名称必须是字符串。", 400);
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 100 || /[\r\n\0]/.test(trimmed)) {
    throw new ExecutionNodeError(
      "节点名称长度须为 1–100 字符且不含换行/控制字符。",
      400,
    );
  }
  return trimmed;
}

function validateNodeToken(raw: unknown): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new ExecutionNodeError("访问令牌必须是字符串。", 400);
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 512 || /[\r\n\0]/.test(trimmed)) {
    throw new ExecutionNodeError(
      "访问令牌长度不能超过 512 字符且不能含控制字符。",
      400,
    );
  }
  return trimmed;
}

function toView(row: StoredExecutionNodeRow): ExecutionNodeView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    allowPrivateNetwork: row.allowPrivateNetwork,
    hasToken: Boolean(row.encryptedToken),
    isActive: row.isActive,
    lastHealthStatus: row.lastHealthStatus,
    lastHealthCheckedAt: row.lastHealthCheckedAt,
    lastHealthDetail: row.lastHealthDetail,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type ExecutionNodeStoreOptions = {
  storage: ExecutionNodeStorage;
  encryptionKey: string;
  auditStore?: AuditStore;
  now?: () => number;
  staticFallbackProvider?: string | null;
  /** 可选自定义可信出网函数（测试隔离用；生产默认 `trustedEndpointFetch`）。 */
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
};

export function createExecutionNodeStore(options: ExecutionNodeStoreOptions) {
  const { storage, encryptionKey, auditStore } = options;
  const nowFn = options.now ?? Date.now;
  const doFetch =
    options.fetchImpl ??
    ((input: string | URL | Request, init?: RequestInit) =>
      trustedEndpointFetch("agent-computer", input, init));

  let activeCache: ActiveExecutionNode | null = null;
  let cacheInitialized = false;

  async function unsealToken(
    encrypted: string | null,
  ): Promise<string | undefined> {
    if (!encrypted) return undefined;
    try {
      const plain = await decryptSecret(encryptionKey, encrypted);
      return plain || undefined;
    } catch {
      return undefined;
    }
  }

  async function refreshActiveCache(): Promise<ActiveExecutionNode | null> {
    const all = await storage.list();
    const active = all.find((row) => row.isActive) ?? null;
    if (!active) {
      activeCache = null;
      cacheInitialized = true;
      return null;
    }
    const token = await unsealToken(active.encryptedToken);
    activeCache = {
      id: active.id,
      name: active.name,
      baseUrl: active.baseUrl,
      ...(token ? { token } : {}),
      allowPrivateNetwork: active.allowPrivateNetwork,
    };
    cacheInitialized = true;
    return activeCache;
  }

  async function audit(
    action: string,
    targetId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!auditStore) return;
    await recordAuditEvent(auditStore, {
      eventType: "configuration.changed",
      targetType: "execution_node",
      targetId,
      payload: { action, ...payload },
    }).catch(() => {});
  }

  async function probeEndpoint(
    baseUrl: string,
    token?: string,
  ): Promise<ExecutionNodeHealthResult> {
    const started = nowFn();
    const headers: Record<string, string> = {
      ...computerHeaders(undefined, token),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    try {
      const response = await doFetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const latencyMs = Math.max(0, nowFn() - started);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          latencyMs,
          error: `远程执行节点健康检查返回 HTTP ${response.status}。`,
        };
      }
      const body = (await response.json().catch(() => null)) as {
        ok?: unknown;
        ready?: unknown;
        status?: unknown;
        protocol?: unknown;
        services?: unknown;
      } | null;
      const ready =
        body?.ready === true ||
        body?.ok === true ||
        body?.status === "ok" ||
        body === null;
      return {
        ok: ready,
        status: response.status,
        latencyMs,
        ...(typeof body?.protocol === "string"
          ? { protocol: body.protocol }
          : {}),
        ready,
        ...(body?.services &&
        typeof body.services === "object" &&
        !Array.isArray(body.services)
          ? { services: body.services as Record<string, unknown> }
          : {}),
        ...(!ready ? { error: "远程执行节点已响应但尚未就绪。" } : {}),
      };
    } catch (error) {
      const latencyMs = Math.max(0, nowFn() - started);
      return {
        ok: false,
        latencyMs,
        error: `无法连接远程执行节点：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    async ensure() {
      await storage.ensure();
      await refreshActiveCache();
    },

    /** 同步读取当前已热切换激活的远程执行节点（未配置时返回 null，交由 provider 回退静态环境变量）。 */
    getActiveSync(): ActiveExecutionNode | null {
      return activeCache ? { ...activeCache } : null;
    },

    async getActive(): Promise<ActiveExecutionNode | null> {
      if (!cacheInitialized) {
        return refreshActiveCache();
      }
      return activeCache ? { ...activeCache } : null;
    },

    async list(): Promise<ExecutionNodesListResponse> {
      const rows = await storage.list();
      const active = rows.find((r) => r.isActive) ?? null;
      return {
        nodes: rows.map(toView),
        activeNodeId: active?.id ?? null,
        staticFallbackConfigured: Boolean(options.staticFallbackProvider),
        staticFallbackProvider: options.staticFallbackProvider ?? null,
      };
    },

    async create(
      input: ExecutionNodeInput,
      actorId: string,
    ): Promise<ExecutionNodeView> {
      const existingList = await storage.list();
      if (existingList.length >= MAX_EXECUTION_NODES) {
        throw new ExecutionNodeError(
          `远程执行节点数量已达上限（${MAX_EXECUTION_NODES}）。`,
          400,
        );
      }
      const id =
        typeof input.id === "string" && input.id.trim()
          ? input.id.trim().toLowerCase()
          : `node-${randomUUID().slice(0, 8)}`;
      if (!NODE_ID_RE.test(id)) {
        throw new ExecutionNodeError(
          "节点 id 必须为 2–48 位小写字母、数字或连字符。",
          400,
        );
      }
      if (await storage.get(id)) {
        throw new ExecutionNodeError(`节点 "${id}" 已存在。`, 409);
      }
      const name = validateNodeName(input.name);
      const allowPrivateNetwork = input.allowPrivateNetwork === true;
      const baseUrl = validateExecutionNodeUrl(
        input.baseUrl,
        allowPrivateNetwork,
      );
      const token = validateNodeToken(input.token);
      const encryptedToken = token
        ? await encryptSecret(encryptionKey, token)
        : null;
      const nowIso = new Date(nowFn()).toISOString();
      const row: StoredExecutionNodeRow = {
        id,
        name,
        baseUrl,
        encryptedToken,
        allowPrivateNetwork,
        isActive: false,
        lastHealthStatus: "unknown",
        lastHealthCheckedAt: null,
        lastHealthDetail: null,
        createdBy: actorId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await storage.upsert(row);
      await audit("execution_node.created", id, {
        actor: actorId,
        name,
        baseUrl,
        allowPrivateNetwork,
        hasToken: Boolean(encryptedToken),
      });
      return toView(row);
    },

    async update(
      id: string,
      input: Partial<ExecutionNodeInput>,
      actorId: string,
    ): Promise<ExecutionNodeView> {
      const existing = await storage.get(id);
      if (!existing) {
        throw new ExecutionNodeError(`执行节点 "${id}" 不存在。`, 404);
      }
      const allowPrivateNetwork =
        input.allowPrivateNetwork ?? existing.allowPrivateNetwork;
      const name =
        input.name !== undefined ? validateNodeName(input.name) : existing.name;
      const baseUrl =
        input.baseUrl !== undefined
          ? validateExecutionNodeUrl(input.baseUrl, allowPrivateNetwork)
          : existing.baseUrl;

      // 跨源密钥隔离：变更 origin 且未显式提供新令牌时清空旧令牌
      const sameOrigin = new URL(existing.baseUrl).origin === new URL(baseUrl).origin;
      let encryptedToken = existing.encryptedToken;
      if (input.clearToken === true) {
        encryptedToken = null;
      } else if (input.token !== undefined && input.token.trim().length > 0) {
        const cleanToken = validateNodeToken(input.token);
        encryptedToken = cleanToken
          ? await encryptSecret(encryptionKey, cleanToken)
          : null;
      } else if (!sameOrigin) {
        encryptedToken = null;
      }

      const nowIso = new Date(nowFn()).toISOString();
      const updated: StoredExecutionNodeRow = {
        ...existing,
        name,
        baseUrl,
        allowPrivateNetwork,
        encryptedToken,
        updatedAt: nowIso,
      };
      await storage.upsert(updated);
      if (updated.isActive) {
        await refreshActiveCache();
      }
      await audit("execution_node.updated", id, {
        actor: actorId,
        name,
        baseUrl,
        allowPrivateNetwork,
        hasToken: Boolean(encryptedToken),
      });
      return toView(updated);
    },

    async remove(id: string, actorId: string): Promise<boolean> {
      const deleted = await storage.delete(id);
      if (deleted) {
        await refreshActiveCache();
        await audit("execution_node.deleted", id, { actor: actorId });
      }
      return deleted;
    },

    /** 一键热切换当前激活的远程执行节点（立即生效，无需重启服务）。 */
    async activate(id: string, actorId: string): Promise<ExecutionNodeView> {
      const target = await storage.get(id);
      if (!target) {
        throw new ExecutionNodeError(`执行节点 "${id}" 不存在。`, 404);
      }
      await storage.setActive(id);
      await refreshActiveCache();
      await audit("execution_node.activated", id, {
        actor: actorId,
        name: target.name,
        baseUrl: target.baseUrl,
      });
      const updated = (await storage.get(id)) ?? { ...target, isActive: true };
      return toView(updated);
    },

    /** 停用所有动态远程执行节点，无缝回退到静态环境变量模式。 */
    async deactivateAll(actorId: string): Promise<void> {
      await storage.setActive(null);
      await refreshActiveCache();
      await audit("execution_node.deactivated", "default", { actor: actorId });
    },

    /** 对已保存节点执行健康探活，并写回最近探测状态。 */
    async probeById(id: string): Promise<{
      node: ExecutionNodeView;
      health: ExecutionNodeHealthResult;
    }> {
      const row = await storage.get(id);
      if (!row) {
        throw new ExecutionNodeError(`执行节点 "${id}" 不存在。`, 404);
      }
      const token = await unsealToken(row.encryptedToken);
      const health = await probeEndpoint(row.baseUrl, token);
      const checkedAt = new Date(nowFn()).toISOString();
      const updated: StoredExecutionNodeRow = {
        ...row,
        lastHealthStatus: health.ok ? "healthy" : "unhealthy",
        lastHealthCheckedAt: checkedAt,
        lastHealthDetail: {
          ...(health.status !== undefined ? { status: health.status } : {}),
          latencyMs: health.latencyMs,
          ...(health.protocol ? { protocol: health.protocol } : {}),
          ...(health.ready !== undefined ? { ready: health.ready } : {}),
          ...(health.services ? { services: health.services } : {}),
          ...(health.error ? { error: health.error } : {}),
        },
        updatedAt: checkedAt,
      };
      await storage.upsert(updated);
      return { node: toView(updated), health };
    },

    /** 对未保存表单草稿执行探活；若引用已有 nodeId 复用旧令牌，严格校验同源防外泄。 */
    async probeDraft(input: {
      nodeId?: string;
      baseUrl: string;
      token?: string;
      allowPrivateNetwork?: boolean;
    }): Promise<ExecutionNodeHealthResult> {
      const allowPrivate = input.allowPrivateNetwork === true;
      const baseUrl = validateExecutionNodeUrl(input.baseUrl, allowPrivate);
      let token = validateNodeToken(input.token);
      if (!token && input.nodeId) {
        const saved = await storage.get(input.nodeId);
        if (
          saved &&
          new URL(saved.baseUrl).origin === new URL(baseUrl).origin
        ) {
          token = await unsealToken(saved.encryptedToken);
        }
      }
      return probeEndpoint(baseUrl, token);
    },

    /** 管理员 API 路由（挂载于 `/api/admin/execution-nodes`）。 */
    routes(
      requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
    ): Hono<{ Variables: AppVariables }> {
      const routes = new Hono<{ Variables: AppVariables }>();

      routes.use("*", async (context, next) => {
        await next();
        context.header("Cache-Control", "no-store");
      });

      const actorLabel = (context: { var: AppVariables }) =>
        context.var.actor.email ?? context.var.actor.id;

      routes.get("/", requireUser, async (context) => {
        const forbidden = requireAdmin(context);
        if (forbidden) return forbidden;
        return context.json(await this.list());
      });

      routes.post(
        "/",
        requireUser,
        bodyLimit({ maxSize: 32 * 1024 }),
        async (context) => {
          const forbidden = requireAdmin(context);
          if (forbidden) return forbidden;
          const body = (await context.req.json().catch(() => null)) as
            | ExecutionNodeInput
            | null;
          if (!body || typeof body !== "object") {
            return context.json({ error: "请求体必须是 JSON 对象。" }, 400);
          }
          try {
            const node = await this.create(body, actorLabel(context));
            return context.json({ node }, 201);
          } catch (error) {
            if (error instanceof ExecutionNodeError) {
              return context.json({ error: error.message }, error.status);
            }
            throw error;
          }
        },
      );

      routes.post(
        "/probe",
        requireUser,
        bodyLimit({ maxSize: 32 * 1024 }),
        async (context) => {
          const forbidden = requireAdmin(context);
          if (forbidden) return forbidden;
          const body = (await context.req.json().catch(() => null)) as {
            nodeId?: unknown;
            baseUrl?: unknown;
            token?: unknown;
            allowPrivateNetwork?: unknown;
          } | null;
          if (!body || typeof body !== "object") {
            return context.json({ error: "请求体必须是 JSON 对象。" }, 400);
          }
          try {
            const health = await this.probeDraft({
              ...(typeof body.nodeId === "string"
                ? { nodeId: body.nodeId }
                : {}),
              baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
              ...(typeof body.token === "string" ? { token: body.token } : {}),
              allowPrivateNetwork: body.allowPrivateNetwork === true,
            });
            return context.json({ health });
          } catch (error) {
            if (error instanceof ExecutionNodeError) {
              return context.json({ error: error.message }, error.status);
            }
            throw error;
          }
        },
      );

      routes.post("/deactivate", requireUser, async (context) => {
        const forbidden = requireAdmin(context);
        if (forbidden) return forbidden;
        await this.deactivateAll(actorLabel(context));
        return context.json(await this.list());
      });

      routes.put(
        "/:id",
        requireUser,
        bodyLimit({ maxSize: 32 * 1024 }),
        async (context) => {
          const forbidden = requireAdmin(context);
          if (forbidden) return forbidden;
          const body = (await context.req.json().catch(() => null)) as
            | Partial<ExecutionNodeInput>
            | null;
          if (!body || typeof body !== "object") {
            return context.json({ error: "请求体必须是 JSON 对象。" }, 400);
          }
          try {
            const node = await this.update(
              context.req.param("id"),
              body,
              actorLabel(context),
            );
            return context.json({ node });
          } catch (error) {
            if (error instanceof ExecutionNodeError) {
              return context.json({ error: error.message }, error.status);
            }
            throw error;
          }
        },
      );

      routes.post("/:id/activate", requireUser, async (context) => {
        const forbidden = requireAdmin(context);
        if (forbidden) return forbidden;
        try {
          const node = await this.activate(
            context.req.param("id"),
            actorLabel(context),
          );
          return context.json({ node, ...(await this.list()) });
        } catch (error) {
          if (error instanceof ExecutionNodeError) {
            return context.json({ error: error.message }, error.status);
          }
          throw error;
        }
      });

      routes.post("/:id/probe", requireUser, async (context) => {
        const forbidden = requireAdmin(context);
        if (forbidden) return forbidden;
        try {
          const result = await this.probeById(context.req.param("id"));
          return context.json(result);
        } catch (error) {
          if (error instanceof ExecutionNodeError) {
            return context.json({ error: error.message }, error.status);
          }
          throw error;
        }
      });

      routes.delete("/:id", requireUser, async (context) => {
        const forbidden = requireAdmin(context);
        if (forbidden) return forbidden;
        const deleted = await this.remove(
          context.req.param("id"),
          actorLabel(context),
        );
        if (!deleted) {
          return context.json({ error: "执行节点不存在。" }, 404);
        }
        return context.json({ ok: true });
      });

      return routes;
    },
  };
}

export type ExecutionNodeStore = ReturnType<typeof createExecutionNodeStore>;
