/**
 * 远端 MCP 连接器全量增强（Wave 8）：
 * 1. SSE 传输支持（严格复用 `pinnedMcpFetch` DNS 钉死 + 同源边界 + 禁重定向，零裸 fetch）；
 * 2. 自定义 MCP 的 OAuth2 与 AES-256-GCM 加密自定义 Header 配置；
 * 3. 每连接器 `customInstructions` 与单工具级启停开关（`disabledTools[]`）；
 * 4. `listTools` `nextCursor` 完整分页（有界上限 + 游标环检测防死循环）；
 * 5. MCP 返回的 `image` content block 透传给视觉模型（严格魔数/像素炸弹/字节上限校验）；
 * 6. 工具调用超时/网络中断返回明确「不要自动重试，请先核查外部状态避免重复副作用」提示；
 * 7. `mcp-last-good` 降级保护：远端临时探测失败时保留最近一次可用工具快照而非清零配置。
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type {
  McpCustomOAuthPublicView,
  McpLastGoodSnapshot,
  McpLastGoodToolSnapshot,
  McpServerEnhancementPatch,
  McpServerEnhancementView,
  McpTransportMode,
} from "../../../shared/app-packages";
import { guardedFetchResponse } from "../../../shared/net/guarded-fetch";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  MAX_AVATAR_IMAGE_DIMENSION,
  MAX_AVATAR_IMAGE_PIXELS,
  validateAvatarImage,
} from "../bot-avatars/validate-image";
import type { ToolImagePart } from "../conversations/tool-images";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import type { ListedTool } from "./mcp";

export const MAX_MCP_TOOL_PAGES = 20;
export const MAX_MCP_TOOLS_TOTAL = 1000;
export const MAX_MCP_IMAGES_PER_RESULT = 4;
export const MAX_MCP_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4_000;
export const MAX_DISABLED_TOOLS = 500;
export const MAX_CUSTOM_HEADERS = 24;

export const MCP_NO_AUTO_RETRY_NOTICE =
  "MCP 工具调用超时或网络中断。远端操作可能已经执行，请不要自动重试，请先核查外部状态避免重复副作用。";

const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const FORBIDDEN_CUSTOM_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);
const OAUTH_REFRESH_SKEW_MS = 60_000;

export class McpEnhancementValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "McpEnhancementValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── 1. SSE / Streamable HTTP 传输构建（全部走 pinnedMcpFetch） ───────────

export type PinnedMcpFetcherFactory = (
  target: URL,
  pinned: { address: string; family: number },
  options?: { allowSameOriginPath?: boolean },
) => (url: string | URL, init?: RequestInit) => Promise<Response>;

export function createMcpClientTransport(input: {
  target: URL;
  pinned: { address: string; family: number };
  transport?: McpTransportMode;
  headers?: Record<string, string>;
  makePinnedFetch: PinnedMcpFetcherFactory;
}): StreamableHTTPClientTransport | SSEClientTransport {
  const mode: McpTransportMode = input.transport ?? "streamable-http";
  const requestInit =
    input.headers && Object.keys(input.headers).length > 0
      ? { headers: input.headers }
      : undefined;

  if (mode === "sse") {
    const sseFetch = input.makePinnedFetch(input.target, input.pinned, {
      allowSameOriginPath: true,
    });
    return new SSEClientTransport(input.target, {
      ...(requestInit ? { requestInit } : {}),
      fetch: sseFetch,
      eventSourceInit: {
        fetch: sseFetch as unknown as typeof fetch,
      },
    });
  }

  return new StreamableHTTPClientTransport(input.target, {
    ...(requestInit ? { requestInit } : {}),
    fetch: input.makePinnedFetch(input.target, input.pinned, {
      allowSameOriginPath: false,
    }),
  });
}

// ── 2. listTools nextCursor 完整有界分页 ─────────────────────────────────

type RawMcpListToolsResult = {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: ToolAnnotations;
  }>;
  nextCursor?: string;
};

export async function listAllMcpTools(
  listPage: (cursor?: string) => Promise<RawMcpListToolsResult>,
  options?: { maxPages?: number; maxTools?: number },
): Promise<ListedTool[]> {
  const maxPages = options?.maxPages ?? MAX_MCP_TOOL_PAGES;
  const maxTools = options?.maxTools ?? MAX_MCP_TOOLS_TOTAL;
  const collected: ListedTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await listPage(cursor);
    const items = Array.isArray(result.tools) ? result.tools : [];
    for (const tool of items) {
      collected.push({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        ...(tool.annotations?.destructiveHint === true
          ? { effect: "write" as const, destructive: true }
          : {}),
      });
      if (collected.length > maxTools) {
        throw new Error(
          `MCP 服务器返回的工具数量超过安全上限（${maxTools} 个）。`,
        );
      }
    }
    const next =
      typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : undefined;
    if (!next) {
      cursor = undefined;
      break;
    }
    if (seenCursors.has(next)) {
      throw new Error("MCP tools/list 分页游标出现循环重复，已中止拉取。");
    }
    seenCursors.add(next);
    cursor = next;
  }

  if (cursor) {
    throw new Error(
      `MCP tools/list 分页超过安全上限（${maxPages} 页），已中止拉取。`,
    );
  }
  return collected;
}

export async function listAllClientTools(
  client: Pick<Client, "listTools">,
  requestOptions: { timeout: number; signal?: AbortSignal },
): Promise<ListedTool[]> {
  return listAllMcpTools(async (cursor) => {
    const res = await client.listTools(
      cursor ? { cursor } : undefined,
      requestOptions,
    );
    return {
      tools: res.tools.map(
        (t: {
          name: string;
          description?: string;
          inputSchema?: unknown;
          annotations?: ToolAnnotations;
        }) => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          annotations: t.annotations,
        }),
      ),
      nextCursor: res.nextCursor,
    };
  });
}

// ── 3. MCP 返回 image content block 二进制魔数 + 尺寸 + 字节上限校验 ──────

function validateGifBytes(bytes: Uint8Array): {
  ok: boolean;
  reason?: string;
} {
  if (bytes.length < 10) {
    return { ok: false, reason: "GIF 文件头被截断。" };
  }
  const sig = String.fromCharCode(
    bytes[0] ?? 0,
    bytes[1] ?? 0,
    bytes[2] ?? 0,
    bytes[3] ?? 0,
    bytes[4] ?? 0,
    bytes[5] ?? 0,
  );
  if (sig !== "GIF87a" && sig !== "GIF89a") {
    return { ok: false, reason: "GIF 魔数无效。" };
  }
  const width = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
  const height = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
  if (width <= 0 || height <= 0) {
    return { ok: false, reason: "GIF 尺寸无效。" };
  }
  if (
    width > MAX_AVATAR_IMAGE_DIMENSION ||
    height > MAX_AVATAR_IMAGE_DIMENSION ||
    width * height > MAX_AVATAR_IMAGE_PIXELS
  ) {
    return { ok: false, reason: `GIF 分辨率超过安全上限（${width}×${height}）。` };
  }
  return { ok: true };
}

export function validateMcpImageBlock(
  rawData: unknown,
  declaredMime?: unknown,
):
  | { ok: true; part: ToolImagePart; bytes: number }
  | { ok: false; reason: string } {
  if (typeof rawData !== "string") {
    return { ok: false, reason: "图片 data 必须为 base64 字符串。" };
  }
  const cleanBase64 = rawData.replace(/\s+/g, "");
  if (!cleanBase64) {
    return { ok: false, reason: "图片 data 为空。" };
  }
  // Base64 编码后约 4/3 倍字节，先做编码长度预拦防内存峰值
  const maxEncodedChars = Math.ceil((MAX_MCP_IMAGE_BYTES * 4) / 3) + 8;
  if (cleanBase64.length > maxEncodedChars) {
    return {
      ok: false,
      reason: `图片大小超过安全上限（${MAX_MCP_IMAGE_BYTES} 字节）。`,
    };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleanBase64)) {
    return { ok: false, reason: "图片 data 不是合法的 base64 编码。" };
  }

  const bytes = Buffer.from(cleanBase64, "base64");
  if (bytes.length === 0) {
    return { ok: false, reason: "解码后的图片为空。" };
  }
  if (bytes.length > MAX_MCP_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `图片字节数（${bytes.length}）超过安全上限（${MAX_MCP_IMAGE_BYTES} 字节）。`,
    };
  }

  // 显式拒绝 SVG 声明
  if (
    typeof declaredMime === "string" &&
    declaredMime.toLowerCase().includes("svg")
  ) {
    return { ok: false, reason: "禁止透传 SVG 矢量图像块。" };
  }

  // 优先检查 GIF 魔数，否则走 PNG / JPEG / WebP 严格二进制防像素炸弹解析
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    const gifCheck = validateGifBytes(bytes);
    if (!gifCheck.ok) {
      return { ok: false, reason: gifCheck.reason ?? "GIF 图片校验失败。" };
    }
    return {
      ok: true,
      part: { mediaType: "image/gif", data: cleanBase64 },
      bytes: bytes.length,
    };
  }

  const imgCheck = validateAvatarImage(bytes);
  if (!imgCheck.ok) {
    return { ok: false, reason: imgCheck.reason };
  }
  return {
    ok: true,
    part: { mediaType: imgCheck.image.mime, data: cleanBase64 },
    bytes: bytes.length,
  };
}

export function extractValidatedMcpImages(content: unknown): {
  images: ToolImagePart[];
  rejected: string[];
} {
  const parts = Array.isArray(content) ? content : [];
  const images: ToolImagePart[] = [];
  const rejected: string[] = [];

  for (const part of parts) {
    if (!isPlainObject(part) || part.type !== "image") continue;
    if (images.length >= MAX_MCP_IMAGES_PER_RESULT) {
      rejected.push(
        `单次工具调用最多透传 ${MAX_MCP_IMAGES_PER_RESULT} 张图片，其余已略过。`,
      );
      break;
    }
    const checked = validateMcpImageBlock(part.data, part.mimeType);
    if (checked.ok) {
      images.push(checked.part);
    } else {
      rejected.push(checked.reason);
    }
  }

  return { images, rejected };
}

// ── 4. 超时与网络中断防自动重试提示 ──────────────────────────────────────

function isUserAbortOnly(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name ?? "") : "";
  if (name === "TimeoutError") return false;
  if (name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /user has aborted|the operation was aborted/i.test(message);
}

export function isMcpTimeoutOrNetworkError(error: unknown): boolean {
  if (!error || isUserAbortOnly(error)) return false;
  if (typeof error === "object" && error !== null) {
    const name = "name" in error ? String(error.name ?? "") : "";
    const code = "code" in error ? String(error.code ?? "") : "";
    if (name === "TimeoutError") return true;
    if (
      code === "-32001" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EPIPE" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "EHOSTUNREACH" ||
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s*out|timeout|socket hang up|econnreset|econnrefused|epipe|network|premature close|connection closed|fetch failed|请求超时/i.test(
    message,
  );
}

export function formatMcpCallFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (isMcpTimeoutOrNetworkError(error)) {
    if (detail.includes("不要自动重试")) return detail;
    return `${MCP_NO_AUTO_RETRY_NOTICE}（原始原因：${detail.slice(0, 240)}）`;
  }
  return detail;
}

// ── 5. 自定义指令引导拼装 ────────────────────────────────────────────────

export function formatConnectorCustomInstructions(
  entries: ReadonlyArray<{ serverId: string; customInstructions: string }>,
): string {
  const cleaned = entries
    .map((e) => ({
      serverId: e.serverId,
      text: e.customInstructions.trim(),
    }))
    .filter((e) => e.text.length > 0);
  if (cleaned.length === 0) return "";
  return [
    "已授权连接器的专属使用指引：",
    ...cleaned.map((item) => `- [${item.serverId}] ${item.text}`),
  ].join("\n");
}

// ── 6. 持久化存储（PG 幂等表 + 内存实现）与 mcp-last-good 降级保护 ────────

type SealedMcpOAuth = {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string | null;
};

export type StoredMcpEnhancementRow = {
  serverId: string;
  transport: McpTransportMode;
  customInstructions: string;
  disabledTools: string[];
  encryptedHeaders: string | null;
  encryptedOAuth: string | null;
  lastGoodTools: McpLastGoodToolSnapshot[] | null;
  lastGoodAt: string | null;
  lastProbeError: string | null;
  degraded: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type McpEnhancementStorage = {
  ensure(): Promise<void>;
  get(serverId: string): Promise<StoredMcpEnhancementRow | null>;
  list(): Promise<StoredMcpEnhancementRow[]>;
  upsert(row: StoredMcpEnhancementRow): Promise<void>;
  delete(serverId: string): Promise<void>;
};

export type McpEnhancementDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

type PgEnhancementRow = {
  server_id: string;
  transport: string;
  custom_instructions: string;
  disabled_tools: unknown;
  encrypted_headers: string | null;
  encrypted_oauth: string | null;
  last_good_tools: unknown;
  last_good_at: Date | string | null;
  last_probe_error: string | null;
  degraded: boolean;
  updated_at: Date | string | null;
  updated_by: string | null;
};

function parseJsonCol<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function isoOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function createPgMcpEnhancementStorage(
  database: McpEnhancementDatabase,
): McpEnhancementStorage {
  const sql = database.$client;

  function mapRow(row: PgEnhancementRow): StoredMcpEnhancementRow {
    const disabledRaw = parseJsonCol<unknown>(row.disabled_tools);
    const lastGoodRaw = parseJsonCol<unknown>(row.last_good_tools);
    return {
      serverId: row.server_id,
      transport: row.transport === "sse" ? "sse" : "streamable-http",
      customInstructions: row.custom_instructions ?? "",
      disabledTools: Array.isArray(disabledRaw)
        ? disabledRaw.filter((item): item is string => typeof item === "string")
        : [],
      encryptedHeaders: row.encrypted_headers ?? null,
      encryptedOAuth: row.encrypted_oauth ?? null,
      lastGoodTools: Array.isArray(lastGoodRaw)
        ? (lastGoodRaw as McpLastGoodToolSnapshot[])
        : null,
      lastGoodAt: isoOrNull(row.last_good_at),
      lastProbeError: row.last_probe_error ?? null,
      degraded: Boolean(row.degraded),
      updatedAt: isoOrNull(row.updated_at),
      updatedBy: row.updated_by ?? null,
    };
  }

  return {
    async ensure() {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS chisabot_mcp_enhancements (
          server_id text PRIMARY KEY,
          transport text NOT NULL DEFAULT 'streamable-http',
          custom_instructions text NOT NULL DEFAULT '',
          disabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
          encrypted_headers text,
          encrypted_oauth text,
          last_good_tools jsonb,
          last_good_at timestamptz,
          last_probe_error text,
          degraded boolean NOT NULL DEFAULT false,
          updated_at timestamptz,
          updated_by text
        );
      `);
    },

    async get(serverId) {
      const rows = await sql.unsafe<PgEnhancementRow[]>(
        `SELECT server_id, transport, custom_instructions, disabled_tools,
                encrypted_headers, encrypted_oauth, last_good_tools, last_good_at,
                last_probe_error, degraded, updated_at, updated_by
         FROM chisabot_mcp_enhancements
         WHERE server_id = $1`,
        [serverId],
      );
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async list() {
      const rows = await sql.unsafe<PgEnhancementRow[]>(
        `SELECT server_id, transport, custom_instructions, disabled_tools,
                encrypted_headers, encrypted_oauth, last_good_tools, last_good_at,
                last_probe_error, degraded, updated_at, updated_by
         FROM chisabot_mcp_enhancements
         ORDER BY server_id ASC`,
      );
      return rows.map(mapRow);
    },

    async upsert(row) {
      await sql.unsafe(
        `INSERT INTO chisabot_mcp_enhancements (
           server_id, transport, custom_instructions, disabled_tools,
           encrypted_headers, encrypted_oauth, last_good_tools, last_good_at,
           last_probe_error, degraded, updated_at, updated_by
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
         ON CONFLICT (server_id) DO UPDATE SET
           transport = $2,
           custom_instructions = $3,
           disabled_tools = $4::jsonb,
           encrypted_headers = $5,
           encrypted_oauth = $6,
           last_good_tools = $7::jsonb,
           last_good_at = $8,
           last_probe_error = $9,
           degraded = $10,
           updated_at = $11,
           updated_by = $12`,
        [
          row.serverId,
          row.transport,
          row.customInstructions,
          JSON.stringify(row.disabledTools),
          row.encryptedHeaders,
          row.encryptedOAuth,
          row.lastGoodTools ? JSON.stringify(row.lastGoodTools) : null,
          row.lastGoodAt,
          row.lastProbeError,
          row.degraded,
          row.updatedAt,
          row.updatedBy,
        ],
      );
    },

    async delete(serverId) {
      await sql.unsafe(
        `DELETE FROM chisabot_mcp_enhancements WHERE server_id = $1`,
        [serverId],
      );
    },
  };
}

export function createMemoryMcpEnhancementStorage(): McpEnhancementStorage {
  const rows = new Map<string, StoredMcpEnhancementRow>();
  return {
    async ensure() {},
    async get(serverId) {
      const found = rows.get(serverId);
      return found
        ? {
            ...found,
            disabledTools: [...found.disabledTools],
            lastGoodTools: found.lastGoodTools
              ? found.lastGoodTools.map((t) => ({ ...t }))
              : null,
          }
        : null;
    },
    async list() {
      return [...rows.values()].map((r) => ({
        ...r,
        disabledTools: [...r.disabledTools],
        lastGoodTools: r.lastGoodTools
          ? r.lastGoodTools.map((t) => ({ ...t }))
          : null,
      }));
    },
    async upsert(row) {
      rows.set(row.serverId, {
        ...row,
        disabledTools: [...row.disabledTools],
        lastGoodTools: row.lastGoodTools
          ? row.lastGoodTools.map((t) => ({ ...t }))
          : null,
      });
    },
    async delete(serverId) {
      rows.delete(serverId);
    },
  };
}

export type McpConnectionOverlay = {
  transport: McpTransportMode;
  extraHeaders: Record<string, string>;
  disabledTools: ReadonlySet<string>;
  customInstructions: string;
};

export type McpEnhancementStoreOptions = {
  storage: McpEnhancementStorage;
  encryptionKey: string;
  now?: () => number;
  refreshFetch?: (url: string, init: RequestInit) => Promise<Response>;
};

function defaultRow(serverId: string): StoredMcpEnhancementRow {
  return {
    serverId,
    transport: "streamable-http",
    customInstructions: "",
    disabledTools: [],
    encryptedHeaders: null,
    encryptedOAuth: null,
    lastGoodTools: null,
    lastGoodAt: null,
    lastProbeError: null,
    degraded: false,
    updatedAt: null,
    updatedBy: null,
  };
}

function assertHttpsPublicUrl(raw: string, label: string): string {
  const verdict = checkPublicUrl(raw.trim());
  if (!verdict.ok || verdict.url.protocol !== "https:") {
    throw new McpEnhancementValidationError(
      `${label} 必须是公网可达的 https:// 地址。`,
    );
  }
  return verdict.url.toString();
}

export function createMcpEnhancementStore(options: McpEnhancementStoreOptions) {
  const { storage, encryptionKey } = options;
  const nowFn = options.now ?? Date.now;

  async function unsealHeaders(
    encrypted: string | null,
  ): Promise<Record<string, string>> {
    if (!encrypted) return {};
    try {
      const parsed = JSON.parse(
        await decryptSecret(encryptionKey, encrypted),
      ) as unknown;
      if (!isPlainObject(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  async function unsealOAuth(
    encrypted: string | null,
  ): Promise<SealedMcpOAuth | null> {
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(
        await decryptSecret(encryptionKey, encrypted),
      ) as unknown;
      return isPlainObject(parsed) ? (parsed as SealedMcpOAuth) : null;
    } catch {
      return null;
    }
  }

  async function toView(
    row: StoredMcpEnhancementRow,
  ): Promise<McpServerEnhancementView> {
    const headers = await unsealHeaders(row.encryptedHeaders);
    const oauth = await unsealOAuth(row.encryptedOAuth);
    const oauthView: McpCustomOAuthPublicView | null = oauth
      ? {
          authorizationUrl: oauth.authorizationUrl,
          tokenUrl: oauth.tokenUrl,
          scopes: [...oauth.scopes],
          ...(oauth.clientId ? { clientId: oauth.clientId } : {}),
          hasClientSecret: Boolean(oauth.clientSecret),
          hasToken: Boolean(oauth.accessToken || oauth.refreshToken),
          expiresAt: oauth.expiresAt ?? null,
        }
      : null;

    const lastGood: McpLastGoodSnapshot | null =
      row.lastGoodTools && row.lastGoodAt
        ? {
            tools: row.lastGoodTools,
            capturedAt: row.lastGoodAt,
            degraded: row.degraded,
            lastProbeError: row.lastProbeError,
          }
        : row.degraded
          ? {
              tools: [],
              capturedAt: row.updatedAt ?? new Date(nowFn()).toISOString(),
              degraded: true,
              lastProbeError: row.lastProbeError,
            }
          : null;

    return {
      serverId: row.serverId,
      transport: row.transport,
      customInstructions: row.customInstructions,
      disabledTools: [...row.disabledTools],
      customHeaderKeys: Object.keys(headers).sort(),
      oauth: oauthView,
      lastGood,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  return {
    async ensure() {
      await storage.ensure();
    },

    async getView(serverId: string): Promise<McpServerEnhancementView> {
      const row = (await storage.get(serverId)) ?? defaultRow(serverId);
      return toView(row);
    },

    async listViews(): Promise<McpServerEnhancementView[]> {
      const rows = await storage.list();
      return Promise.all(rows.map((row) => toView(row)));
    },

    async update(
      serverId: string,
      patch: McpServerEnhancementPatch,
      actorId: string,
    ): Promise<McpServerEnhancementView> {
      const current = (await storage.get(serverId)) ?? defaultRow(serverId);
      const next: StoredMcpEnhancementRow = {
        ...current,
        disabledTools: [...current.disabledTools],
        updatedAt: new Date(nowFn()).toISOString(),
        updatedBy: actorId,
      };

      if (patch.transport !== undefined) {
        if (patch.transport !== "streamable-http" && patch.transport !== "sse") {
          throw new McpEnhancementValidationError(
            "transport 仅支持 streamable-http 或 sse。",
          );
        }
        next.transport = patch.transport;
      }

      if (patch.customInstructions !== undefined) {
        if (
          typeof patch.customInstructions !== "string" ||
          patch.customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS ||
          patch.customInstructions.includes("\0")
        ) {
          throw new McpEnhancementValidationError(
            `customInstructions 必须为不超过 ${MAX_CUSTOM_INSTRUCTIONS_CHARS} 字符的纯文本。`,
          );
        }
        next.customInstructions = patch.customInstructions.trim();
      }

      if (patch.disabledTools !== undefined) {
        if (
          !Array.isArray(patch.disabledTools) ||
          patch.disabledTools.length > MAX_DISABLED_TOOLS
        ) {
          throw new McpEnhancementValidationError(
            `disabledTools 最多包含 ${MAX_DISABLED_TOOLS} 个工具名。`,
          );
        }
        const cleaned: string[] = [];
        for (const name of patch.disabledTools) {
          if (typeof name !== "string" || !name.trim() || name.length > 200) {
            throw new McpEnhancementValidationError(
              `非法的禁用工具名称：${String(name)}`,
            );
          }
          cleaned.push(name.trim());
        }
        next.disabledTools = [...new Set(cleaned)].sort();
      }

      if (
        patch.customHeaders !== undefined ||
        patch.clearHeaderKeys !== undefined
      ) {
        const mergedHeaders = await unsealHeaders(current.encryptedHeaders);
        for (const key of patch.clearHeaderKeys ?? []) {
          delete mergedHeaders[key];
        }
        if (patch.customHeaders !== undefined) {
          if (!isPlainObject(patch.customHeaders)) {
            throw new McpEnhancementValidationError(
              "customHeaders 必须是键值对象。",
            );
          }
          for (const [rawKey, rawVal] of Object.entries(patch.customHeaders)) {
            const key = rawKey.trim();
            if (
              !HEADER_NAME_RE.test(key) ||
              FORBIDDEN_CUSTOM_HEADERS.has(key.toLowerCase())
            ) {
              throw new McpEnhancementValidationError(
                `禁止设置的自定义 Header 名称：${rawKey}`,
              );
            }
            if (typeof rawVal !== "string") {
              throw new McpEnhancementValidationError(
                `Header ${key} 的值必须是字符串。`,
              );
            }
            if (rawVal === "") {
              delete mergedHeaders[key];
            } else {
              if (/[\r\n\0]/.test(rawVal) || rawVal.length > 8192) {
                throw new McpEnhancementValidationError(
                  `Header ${key} 的值包含非法控制字符或超长。`,
                );
              }
              mergedHeaders[key] = rawVal;
            }
          }
        }
        if (Object.keys(mergedHeaders).length > MAX_CUSTOM_HEADERS) {
          throw new McpEnhancementValidationError(
            `自定义加密 Header 数量不能超过 ${MAX_CUSTOM_HEADERS} 个。`,
          );
        }
        next.encryptedHeaders =
          Object.keys(mergedHeaders).length > 0
            ? await encryptSecret(encryptionKey, JSON.stringify(mergedHeaders))
            : null;
      }

      if (patch.oauth !== undefined) {
        if (patch.oauth === null) {
          next.encryptedOAuth = null;
        } else {
          const prevOAuth = await unsealOAuth(current.encryptedOAuth);
          const authorizationUrl =
            patch.oauth.authorizationUrl !== undefined
              ? assertHttpsPublicUrl(
                  patch.oauth.authorizationUrl,
                  "oauth.authorizationUrl",
                )
              : (prevOAuth?.authorizationUrl ?? "");
          const tokenUrl =
            patch.oauth.tokenUrl !== undefined
              ? assertHttpsPublicUrl(patch.oauth.tokenUrl, "oauth.tokenUrl")
              : (prevOAuth?.tokenUrl ?? "");
          if (!authorizationUrl || !tokenUrl) {
            throw new McpEnhancementValidationError(
              "配置自定义 MCP OAuth2 必须提供 authorizationUrl 与 tokenUrl。",
            );
          }
          // 跨源保护：修改 tokenUrl origin 时清空旧密钥与令牌，防止凭据跨源外泄
          const prevOrigin = prevOAuth?.tokenUrl
            ? new URL(prevOAuth.tokenUrl).origin
            : null;
          const nextOrigin = new URL(tokenUrl).origin;
          const sameOrigin = prevOrigin === null || prevOrigin === nextOrigin;

          const scopes =
            patch.oauth.scopes !== undefined
              ? [
                  ...new Set(
                    patch.oauth.scopes
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0 && !/[\s\r\n\0]/.test(s)),
                  ),
                ]
              : (prevOAuth?.scopes ?? []);

          const mergedOAuth: SealedMcpOAuth = {
            authorizationUrl,
            tokenUrl,
            scopes,
            clientId:
              patch.oauth.clientId !== undefined
                ? patch.oauth.clientId.trim() || undefined
                : sameOrigin
                  ? prevOAuth?.clientId
                  : undefined,
            clientSecret:
              patch.oauth.clientSecret !== undefined
                ? patch.oauth.clientSecret.trim() || undefined
                : sameOrigin
                  ? prevOAuth?.clientSecret
                  : undefined,
            accessToken:
              patch.oauth.accessToken !== undefined
                ? patch.oauth.accessToken.trim() || undefined
                : sameOrigin
                  ? prevOAuth?.accessToken
                  : undefined,
            refreshToken:
              patch.oauth.refreshToken !== undefined
                ? patch.oauth.refreshToken.trim() || undefined
                : sameOrigin
                  ? prevOAuth?.refreshToken
                  : undefined,
            expiresAt:
              patch.oauth.expiresAt !== undefined
                ? patch.oauth.expiresAt
                : sameOrigin
                  ? (prevOAuth?.expiresAt ?? null)
                  : null,
          };
          next.encryptedOAuth = await encryptSecret(
            encryptionKey,
            JSON.stringify(mergedOAuth),
          );
        }
      }

      await storage.upsert(next);
      return toView(next);
    },

    /** 解析单个 MCP 连接器的增强传输层配置、解密后的自定义 Header 与自动刷新的 OAuth2 头。 */
    async resolveConnectionOverlay(
      serverId: string,
    ): Promise<McpConnectionOverlay> {
      const row = await storage.get(serverId);
      if (!row) {
        return {
          transport: "streamable-http",
          extraHeaders: {},
          disabledTools: new Set(),
          customInstructions: "",
        };
      }
      const extraHeaders = await unsealHeaders(row.encryptedHeaders);
      let oauth = await unsealOAuth(row.encryptedOAuth);

      if (
        oauth?.refreshToken &&
        oauth.expiresAt &&
        Date.parse(oauth.expiresAt) <= nowFn() + OAUTH_REFRESH_SKEW_MS &&
        oauth.clientId
      ) {
        const params = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: oauth.refreshToken,
          client_id: oauth.clientId,
        });
        if (oauth.clientSecret) {
          params.set("client_secret", oauth.clientSecret);
        }
        const response = options.refreshFetch
          ? await options.refreshFetch(oauth.tokenUrl, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: params.toString(),
            })
          : await guardedFetchResponse(oauth.tokenUrl, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: params.toString(),
              manualRedirect: true,
              maxBytes: 256 * 1024,
              timeoutMs: 15_000,
            });
        if (response.ok) {
          const body = (await response.json().catch(() => null)) as {
            access_token?: unknown;
            refresh_token?: unknown;
            expires_in?: unknown;
          } | null;
          if (typeof body?.access_token === "string" && body.access_token) {
            const expiresIn =
              typeof body.expires_in === "number" &&
              Number.isFinite(body.expires_in) &&
              body.expires_in > 0
                ? body.expires_in
                : 3600;
            oauth = {
              ...oauth,
              accessToken: body.access_token,
              refreshToken:
                typeof body.refresh_token === "string" && body.refresh_token
                  ? body.refresh_token
                  : oauth.refreshToken,
              expiresAt: new Date(nowFn() + expiresIn * 1000).toISOString(),
            };
            const encryptedOAuth = await encryptSecret(
              encryptionKey,
              JSON.stringify(oauth),
            );
            await storage.upsert({
              ...row,
              encryptedOAuth,
              updatedAt: new Date(nowFn()).toISOString(),
            });
          }
        }
      }

      if (oauth?.accessToken && !extraHeaders.Authorization) {
        extraHeaders.Authorization = /^(?:bearer|basic)\s+/i.test(
          oauth.accessToken,
        )
          ? oauth.accessToken
          : `Bearer ${oauth.accessToken}`;
      }

      return {
        transport: row.transport,
        extraHeaders,
        disabledTools: new Set(row.disabledTools),
        customInstructions: row.customInstructions,
      };
    },

    async isToolDisabled(serverId: string, toolName: string): Promise<boolean> {
      const row = await storage.get(serverId);
      if (!row) return false;
      return row.disabledTools.includes(toolName);
    },

    async disabledToolsMap(
      serverIds: readonly string[],
    ): Promise<Map<string, ReadonlySet<string>>> {
      const out = new Map<string, ReadonlySet<string>>();
      await Promise.all(
        [...new Set(serverIds)].map(async (serverId) => {
          const row = await storage.get(serverId);
          if (row && row.disabledTools.length > 0) {
            out.set(serverId, new Set(row.disabledTools));
          }
        }),
      );
      return out;
    },

    async customInstructionsForServers(
      serverIds: readonly string[],
    ): Promise<Array<{ serverId: string; customInstructions: string }>> {
      const results: Array<{ serverId: string; customInstructions: string }> =
        [];
      for (const serverId of [...new Set(serverIds)]) {
        const row = await storage.get(serverId);
        if (row && row.customInstructions.trim().length > 0) {
          results.push({
            serverId,
            customInstructions: row.customInstructions.trim(),
          });
        }
      }
      return results;
    },

    /** `mcp-last-good`：探测成功时更新最近一次可用工具快照并清除降级标记。 */
    async recordProbeSuccess(
      serverId: string,
      tools: ReadonlyArray<ListedTool>,
    ): Promise<McpLastGoodSnapshot> {
      const current = (await storage.get(serverId)) ?? defaultRow(serverId);
      const capturedAt = new Date(nowFn()).toISOString();
      const snapshotTools: McpLastGoodToolSnapshot[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description.slice(0, 400),
        ...(tool.effect ? { effect: tool.effect } : {}),
        ...(tool.destructive ? { destructive: true } : {}),
      }));
      const next: StoredMcpEnhancementRow = {
        ...current,
        lastGoodTools: snapshotTools,
        lastGoodAt: capturedAt,
        lastProbeError: null,
        degraded: false,
      };
      await storage.upsert(next);
      return {
        tools: snapshotTools,
        capturedAt,
        degraded: false,
        lastProbeError: null,
      };
    },

    /**
     * `mcp-last-good` 降级保护：远端临时探测失败时绝不清零历史快照与配置，
     * 而是保留最近一次可用工具快照并标记 `degraded: true` 供界面与助手提示。
     */
    async recordProbeFailure(
      serverId: string,
      errorMessage: string,
    ): Promise<{ preserved: boolean; snapshot: McpLastGoodSnapshot | null }> {
      const current = (await storage.get(serverId)) ?? defaultRow(serverId);
      const cleanError = errorMessage.slice(0, 400);
      const next: StoredMcpEnhancementRow = {
        ...current,
        lastProbeError: cleanError,
        degraded: true,
      };
      await storage.upsert(next);
      const preserved = Boolean(
        current.lastGoodTools && current.lastGoodTools.length > 0,
      );
      return {
        preserved,
        snapshot:
          current.lastGoodTools && current.lastGoodAt
            ? {
                tools: current.lastGoodTools,
                capturedAt: current.lastGoodAt,
                degraded: true,
                lastProbeError: cleanError,
              }
            : null,
      };
    },

    async remove(serverId: string): Promise<void> {
      await storage.delete(serverId);
    },
  };
}

export type McpEnhancementStore = ReturnType<typeof createMcpEnhancementStore>;

/** 管理台远端 MCP 增强配置路由（挂载于 `/api/mcp-enhancements`）。 */
export function createMcpEnhancementRoutes(options: {
  store: McpEnhancementStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { store, requireUser } = options;

  routes.use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  });

  routes.get("/", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    return context.json({ enhancements: await store.listViews() });
  });

  routes.get("/:serverId", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const serverId = context.req.param("serverId");
    return context.json({ enhancement: await store.getView(serverId) });
  });

  routes.put(
    "/:serverId",
    requireUser,
    bodyLimit({ maxSize: 128 * 1024 }),
    async (context) => {
      const forbidden = requireAdmin(context);
      if (forbidden) return forbidden;
      const serverId = context.req.param("serverId");
      const body = (await context.req.json().catch(() => null)) as
        | McpServerEnhancementPatch
        | null;
      if (!isPlainObject(body)) {
        return context.json({ error: "请求体必须是 JSON 对象。" }, 400);
      }
      try {
        const enhancement = await store.update(
          serverId,
          body,
          context.var.actor.email ?? context.var.actor.id,
        );
        return context.json({ enhancement });
      } catch (error) {
        if (error instanceof McpEnhancementValidationError) {
          return context.json({ error: error.message }, 400);
        }
        throw error;
      }
    },
  );

  return routes;
}
