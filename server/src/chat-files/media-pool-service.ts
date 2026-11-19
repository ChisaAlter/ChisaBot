import { createHash, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { MAX_AVATAR_BYTES } from "../../../shared/bot-avatars";
import {
  CHAT_FILES_MARKER,
  type ChatFileView,
  IMAGE_ASPECTS,
  type ImageAspect,
  MAX_CHAT_FILE_BYTES,
} from "../../../shared/chat-files";
import {
  EMPTY_MEDIA_PARAM_SCHEMA,
  MAX_MEDIA_REFERENCE_IMAGES,
  MEDIA_CAPABILITIES,
  MEDIA_POOL_PROVIDERS,
  type MediaCapability,
  type MediaPoolModelEntry,
  type MediaPoolProvider,
  normalizeMediaParamSchema,
  type VideoGenerationStatus,
  type VideoGenerationTaskView,
  type VideoInspectResult,
  validateMediaParams,
} from "../../../shared/media-pool";
import {
  BlockedUrlError,
  guardedFetch,
} from "../../../shared/net/guarded-fetch";
import { canManageAgent } from "../agents/profile-policy";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { extractVideoKeyframes } from "../audio/ffmpeg-transcode";
import type { AppVariables } from "../auth/guards";
import { validateAvatarImage } from "../bot-avatars/validate-image";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { trustedEndpointFetch } from "../net/trusted-endpoint-fetch";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { minimaxEndpoint, openaiBase, sizeForAspect } from "./image-provider";
import { sniffImage } from "./service";

/**
 * 多模态创作模型池服务（Wave 6）：
 * - 幂等表 `chisabot_media_model_pool`：按条目 AES-256-GCM 封存密钥 + 同源校验防跨源复用；
 * - 幂等表 `chisabot_video_generation_tasks`：按 `(owner_user_id, request_key)` 去重防重复扣费；
 * - 严格按条目的 `paramSchema` 白名单校验自定义参数透传；
 * - 工具：`media_pool_list`、`image_generate_multi`（≤10 参考图）、`video_generate`、`video_inspect`；
 * - AI 生成 Bot 头像：`generateBotAvatar` 与路由 `POST /api/bots/:agentId/avatar/generate`。
 *
 * 安全红线：
 * - 上游模型接口全部走 `trustedEndpointFetch("model-provider", ...)`（带 `redirect: "error"`）；
 * - 远端产物下载全部走 `guardedFetch`（SSRF 防护 + 字节上限）；
 * - `video_inspect` 严禁 90MB base64 暴力内联与写死私有 `/analyze` 端点，严格使用标准 Gemini / OpenAI-compatible 关键帧抽样协议。
 */

/** 专项视频理解允许直接内联的严格字节上限（10 MiB），超过一律走安全关键帧抽样。 */
export const MAX_VIDEO_INLINE_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 30_000;
const ADMIN_BODY_LIMIT_BYTES = 64 * 1024;

export class MediaPoolError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 413 | 502 = 400,
  ) {
    super(message);
    this.name = "MediaPoolError";
  }
}

export type MediaPoolDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

type PoolRow = {
  id: string;
  label: string;
  capability: string;
  provider: string;
  base_url: string;
  model: string;
  cost_hint: string;
  style_tags: unknown;
  max_reference_images: number;
  param_schema: unknown;
  enabled: boolean;
  api_key: string | null;
  key_hint: string;
  updated_at: Date | string | null;
};

type VideoTaskRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  request_key: string;
  model_id: string;
  provider_task_id: string;
  status: string;
  progress: number;
  prompt: string;
  result_file_id: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type MediaFileRecord = {
  id: string | null;
  name: string;
  mimeType: string;
  bytes: Buffer;
};

export type MediaPoolDependencies = {
  encryptionKey: string;
  /** 读取聊天文件或工作区文件（支持 fileId、/api/chat-files/<id> 或工作区路径）。 */
  loadFile?: (
    owner: string,
    agentId: string,
    source?: string,
    opts?: { kind?: "image" | "video" },
  ) => Promise<MediaFileRecord | null>;
  /** 将生成的图片/视频持久化为聊天文件并返回视图。 */
  storeFile?: (
    owner: string,
    agentId: string,
    file: {
      kind: "generated" | "edited";
      name: string;
      mimeType: string;
      bytes: Buffer;
      prompt?: string;
      model?: string;
    },
  ) => Promise<ChatFileView>;
  /** 按 fileId 查已有聊天文件视图（用于 video_generate 轮询已落盘结果）。 */
  getFileView?: (owner: string, fileId: string) => Promise<ChatFileView | null>;
  /** Bot 资料与头像服务（供 generateBotAvatar 鉴权与落库）。 */
  agents?: {
    get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  };
  botAvatars?: {
    setImage(
      actor: AgentActor,
      agentId: string,
      bytes: Uint8Array,
    ): Promise<{ kind: string; url?: string; version?: string }>;
  };
  /** 模型池没有启用的生图条目时，回退使用系统默认/个人生图能力生成原始图片字节。 */
  fallbackGenerateImage?: (
    actorId: string,
    agentId: string,
    prompt: string,
  ) => Promise<{ bytes: Buffer; model: string } | null>;
  /** 模型池没有启用 video-understand 条目时，可选回退使用现有识图模型。 */
  fallbackVisionModel?: (
    owner: string,
    agentId: string,
  ) => Promise<{ baseUrl: string; model: string; apiKey: string } | null>;
  /** 可选视频音轨转写钩子（如接入 speechService.transcribeAudio）。 */
  transcribeVideoAudio?: (
    bytes: Uint8Array,
    mimeType: string,
    name: string,
  ) => Promise<string | null>;
  /** 可选覆盖关键帧抽取器（默认走 FFmpeg 安全管道）。 */
  extractKeyframes?: (
    bytes: Uint8Array,
    frameCount: number,
  ) => Promise<Buffer[]>;
  /** 可选覆盖头像尺寸压制器（当 AI 生成图大于 256KB 时缩小至 256×256）。 */
  shrinkAvatarBytes?: (bytes: Uint8Array) => Promise<Uint8Array | null>;
  /** 可选测试注入的上游请求函数，默认走 `trustedEndpointFetch("model-provider", ...)`。 */
  transport?: (url: string, init?: RequestInit) => Promise<Response>;
  /** 可选测试注入的远端产物下载函数，默认走 `guardedFetch`。 */
  download?: (url: string, maxBytes: number) => Promise<Buffer>;
};

const iso = (value: Date | string | null | undefined): string =>
  value ? new Date(value).toISOString() : new Date(0).toISOString();

function keyHintOf(secret: string | undefined): string {
  const trimmed = secret?.trim() ?? "";
  return trimmed.length >= 8 ? trimmed.slice(-4) : "";
}

/** 同源校验（协议 + 主机 + 端口一致）：更换模型端点域名时禁止静默复用旧密钥。 */
export function sameMediaOrigin(
  a: string | undefined,
  b: string | undefined,
): boolean {
  const left = a?.trim();
  const right = b?.trim();
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** 严格校验媒体模型端点地址：仅允许 http/https，拒绝 userinfo、query 与 hash。 */
export function parseMediaEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new MediaPoolError("接口地址不能为空。");
  if (trimmed.length > 300) {
    throw new MediaPoolError("接口地址长度不能超过 300 个字符。");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new MediaPoolError("接口地址必须是合法的 HTTP(S) URL。");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    throw new MediaPoolError(
      "接口地址必须是 HTTP(S) URL，且不能包含用户名密码、查询参数或片段。",
    );
  }
  return url.href.replace(/\/+$/, "");
}

function parseJsonValue<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function normalizeStyleTags(raw: unknown): string[] {
  const list = parseJsonValue<unknown>(raw, []);
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const clean = item.trim().slice(0, 32);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 16) break;
  }
  return out;
}

function normalizeCapability(raw: string): MediaCapability {
  return (MEDIA_CAPABILITIES as readonly string[]).includes(raw)
    ? (raw as MediaCapability)
    : "image-generate";
}

function normalizeProvider(raw: string): MediaPoolProvider {
  return (MEDIA_POOL_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as MediaPoolProvider)
    : "openai";
}

function clampReferenceCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_MEDIA_REFERENCE_IMAGES, Math.max(0, Math.trunc(value)));
}

function rowToEntry(row: PoolRow): MediaPoolModelEntry {
  return {
    id: row.id,
    label: row.label,
    capability: normalizeCapability(row.capability),
    provider: normalizeProvider(row.provider),
    baseUrl: row.base_url,
    model: row.model,
    costHint: row.cost_hint ?? "",
    styleTags: normalizeStyleTags(row.style_tags),
    maxReferenceImages: clampReferenceCount(Number(row.max_reference_images)),
    paramSchema: normalizeMediaParamSchema(
      parseJsonValue(row.param_schema, EMPTY_MEDIA_PARAM_SCHEMA),
    ),
    enabled: Boolean(row.enabled),
    keySource: row.api_key ? "saved" : "none",
    keyHint: row.api_key ? (row.key_hint ?? "") : "",
    updatedAt: row.updated_at ? iso(row.updated_at) : null,
  };
}

function normalizeTaskStatus(raw: string): VideoGenerationStatus {
  const lower = raw.toLowerCase();
  if (
    lower === "succeeded" ||
    lower === "completed" ||
    lower === "success" ||
    lower === "done"
  ) {
    return "succeeded";
  }
  if (lower === "failed" || lower === "error" || lower === "cancelled") {
    return "failed";
  }
  if (
    lower === "running" ||
    lower === "processing" ||
    lower === "in_progress"
  ) {
    return "running";
  }
  return "queued";
}

function shortText(text: string, limit = 240): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function slugOf(text: string, fallback: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return ascii || fallback;
}

function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const poolEntryInputSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.:-]{2,80}$/, "条目 ID 仅支持字母、数字与 _ . : -")
      .optional(),
    label: z.string().trim().min(1, "显示名称不能为空。").max(80),
    capability: z.enum(MEDIA_CAPABILITIES),
    provider: z.enum(MEDIA_POOL_PROVIDERS),
    baseUrl: z.string().trim().min(1, "接口地址不能为空。").max(300),
    model: z.string().trim().min(1, "模型名称不能为空。").max(160),
    costHint: z.string().trim().max(120).optional().default(""),
    styleTags: z
      .array(z.string().trim().max(32))
      .max(16)
      .optional()
      .default([]),
    maxReferenceImages: z
      .number()
      .int("最大参考图数量必须是整数。")
      .min(0, "最大参考图数量不能小于 0。")
      .max(
        MAX_MEDIA_REFERENCE_IMAGES,
        `最大参考图数量不能超过 ${MAX_MEDIA_REFERENCE_IMAGES}。`,
      )
      .optional()
      .default(0),
    paramSchema: z.unknown().optional(),
    enabled: z.boolean().optional().default(true),
    apiKey: z.string().max(4000).optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict();

function defaultTransport(url: string, init?: RequestInit): Promise<Response> {
  return trustedEndpointFetch("model-provider", url, {
    ...init,
    redirect: init?.redirect ?? "error",
  });
}

async function defaultDownload(url: string, maxBytes: number): Promise<Buffer> {
  let response: Awaited<ReturnType<typeof guardedFetch>>;
  try {
    response = await guardedFetch(url, {
      maxBytes,
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      throw new MediaPoolError(
        "媒体模型返回了不允许访问的内网或非法地址。",
        400,
      );
    }
    throw new MediaPoolError("下载远端媒体产物失败，请稍后重试。", 502);
  }
  if (response.status >= 400) {
    throw new MediaPoolError(
      `下载远端媒体产物失败（HTTP ${response.status}）。`,
      502,
    );
  }
  if (response.truncated || response.body.length > maxBytes) {
    throw new MediaPoolError("远端媒体产物超过大小限制。", 413);
  }
  return response.body;
}

function geminiEndpoint(baseUrl: string, model: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (/\/v1beta$/i.test(clean) || /\/v1$/i.test(clean)) {
    return `${clean}/models/${encodeURIComponent(model)}:generateContent`;
  }
  return `${clean}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

async function readJsonResponse(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new MediaPoolError(
      `${label}返回了非 JSON 响应（HTTP ${response.status}）：${shortText(raw, 140)}`,
      502,
    );
  }
}

function extractApiError(json: Record<string, unknown>): string {
  const err = json.error as { message?: unknown } | string | undefined;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object" && typeof err.message === "string") {
    return err.message.trim();
  }
  const base = json.base_resp as { status_msg?: unknown } | undefined;
  if (base && typeof base.status_msg === "string" && base.status_msg.trim()) {
    return base.status_msg.trim();
  }
  if (typeof json.message === "string" && json.message.trim()) {
    return json.message.trim();
  }
  return "";
}

function extractGeminiText(json: Record<string, unknown>): string {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const first = candidates[0] as
    | { content?: { parts?: Array<{ text?: unknown }> } }
    | undefined;
  const parts = Array.isArray(first?.content?.parts) ? first.content.parts : [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function extractGeminiImageBytes(json: Record<string, unknown>): Buffer | null {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  for (const candidate of candidates) {
    const parts = (
      candidate as {
        content?: {
          parts?: Array<{
            inlineData?: { data?: unknown };
            inline_data?: { data?: unknown };
          }>;
        };
      }
    )?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const b64 = part.inlineData?.data ?? part.inline_data?.data;
      if (typeof b64 === "string" && b64.length > 0) {
        return Buffer.from(b64, "base64");
      }
    }
  }
  return null;
}

function extractChatCompletionText(json: Record<string, unknown>): string {
  const choice = Array.isArray(json.choices)
    ? (json.choices[0] as { message?: { content?: unknown } } | undefined)
    : undefined;
  const content = choice?.message?.content;
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part &&
              typeof part === "object" &&
              typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
            )
            .join("")
        : "";
  return raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
}

function defaultAvatarPrompt(
  agent: AgentProfile,
  extraPrompt?: string,
  style?: string,
): string {
  const custom = extraPrompt?.trim();
  const styleText = style?.trim() ? `，视觉风格：${style.trim()}` : "";
  if (custom) {
    return `${custom}${styleText}。主体居中，圆形头像友好构图，干净背景，无文字水印。`;
  }
  const roleHint = [agent.name, agent.title, agent.roleDescription]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join("，")
    .slice(0, 260);
  return `为名为「${agent.name}」的 AI 助手设计一枚简洁现代的高质感方形头像${styleText}。角色特征：${roleHint || "智能助手"}。主体居中清晰、高辨识度、无文字无水印。`;
}

export function createMediaPoolService(
  database: MediaPoolDatabase,
  deps: MediaPoolDependencies,
) {
  const sql = database.$client;
  const doFetch = deps.transport ?? defaultTransport;
  const download = deps.download ?? defaultDownload;
  const extractKeyframes =
    deps.extractKeyframes ??
    ((bytes: Uint8Array, frameCount: number) =>
      extractVideoKeyframes(bytes, { frameCount }));

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_media_model_pool (
        id text PRIMARY KEY,
        label text NOT NULL,
        capability text NOT NULL,
        provider text NOT NULL,
        base_url text NOT NULL,
        model text NOT NULL,
        cost_hint text NOT NULL DEFAULT '',
        style_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
        max_reference_images integer NOT NULL DEFAULT 0,
        param_schema jsonb NOT NULL DEFAULT '{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
        enabled boolean NOT NULL DEFAULT true,
        api_key text,
        key_hint text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
      CREATE INDEX IF NOT EXISTS chisabot_media_model_pool_cap_idx
        ON chisabot_media_model_pool (capability, enabled);
      CREATE TABLE IF NOT EXISTS chisabot_video_generation_tasks (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        agent_id text NOT NULL,
        request_key text NOT NULL,
        model_id text NOT NULL,
        provider_task_id text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'queued',
        progress integer NOT NULL DEFAULT 0,
        prompt text NOT NULL,
        result_file_id text,
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_user_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS chisabot_video_tasks_owner_idx
        ON chisabot_video_generation_tasks (owner_user_id, created_at DESC);
    `);
  }

  async function readPoolRow(id: string): Promise<PoolRow | null> {
    const rows = await sql.unsafe<PoolRow[]>(
      "SELECT * FROM chisabot_media_model_pool WHERE id = $1",
      [id],
    );
    return rows[0] ?? null;
  }

  async function listEntries(
    opts: {
      includeDisabled?: boolean;
      capability?: MediaCapability;
      tag?: string;
    } = {},
  ): Promise<MediaPoolModelEntry[]> {
    const rows = await sql.unsafe<PoolRow[]>(
      "SELECT * FROM chisabot_media_model_pool ORDER BY capability ASC, updated_at DESC, id ASC",
    );
    const needle = opts.tag?.trim().toLowerCase() ?? "";
    return rows.map(rowToEntry).filter((entry) => {
      if (!opts.includeDisabled && !entry.enabled) return false;
      if (opts.capability && entry.capability !== opts.capability) return false;
      if (
        needle &&
        !entry.styleTags.some((tag) => tag.toLowerCase().includes(needle)) &&
        !entry.label.toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    });
  }

  async function getEntry(id: string): Promise<MediaPoolModelEntry | null> {
    const row = await readPoolRow(id);
    return row ? rowToEntry(row) : null;
  }

  async function resolveApiKeyForRow(row: PoolRow): Promise<string> {
    if (!row.api_key) return "";
    return (await decryptSecret(deps.encryptionKey, row.api_key)).trim();
  }

  async function createEntry(
    actorId: string,
    raw: unknown,
  ): Promise<MediaPoolModelEntry> {
    const parsed = poolEntryInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MediaPoolError(
        parsed.error.issues[0]?.message ?? "模型池配置参数无效。",
        400,
      );
    }
    const input = parsed.data;
    const id = input.id || `mp_${randomUUID().slice(0, 12)}`;
    const existing = await readPoolRow(id);
    if (existing) {
      throw new MediaPoolError(`模型池条目「${id}」已存在。`, 400);
    }
    const baseUrl = parseMediaEndpointUrl(input.baseUrl);
    const paramSchema = normalizeMediaParamSchema(input.paramSchema);
    const styleTags = normalizeStyleTags(input.styleTags);
    const rawKey = input.apiKey?.trim() ?? "";
    const sealed = rawKey
      ? await encryptSecret(deps.encryptionKey, rawKey)
      : null;
    const keyHint = keyHintOf(rawKey);

    await sql.unsafe(
      `INSERT INTO chisabot_media_model_pool
       (id, label, capability, provider, base_url, model, cost_hint, style_tags, max_reference_images, param_schema, enabled, api_key, key_hint, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, now(), $14)`,
      [
        id,
        input.label,
        input.capability,
        input.provider,
        baseUrl,
        input.model,
        input.costHint,
        JSON.stringify(styleTags),
        clampReferenceCount(input.maxReferenceImages),
        JSON.stringify(paramSchema),
        input.enabled,
        sealed,
        keyHint,
        actorId,
      ],
    );
    const created = await readPoolRow(id);
    if (!created) throw new MediaPoolError("写入模型池条目失败。", 502);
    return rowToEntry(created);
  }

  async function updateEntry(
    actorId: string,
    id: string,
    raw: unknown,
  ): Promise<MediaPoolModelEntry> {
    const existing = await readPoolRow(id);
    if (!existing) {
      throw new MediaPoolError(`找不到模型池条目「${id}」。`, 404);
    }
    const parsed = poolEntryInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MediaPoolError(
        parsed.error.issues[0]?.message ?? "模型池配置参数无效。",
        400,
      );
    }
    const input = parsed.data;
    const baseUrl = parseMediaEndpointUrl(input.baseUrl);
    const paramSchema = normalizeMediaParamSchema(input.paramSchema);
    const styleTags = normalizeStyleTags(input.styleTags);

    let sealed: string | null = existing.api_key;
    let keyHint = existing.key_hint ?? "";
    if (input.clearApiKey === true) {
      sealed = null;
      keyHint = "";
    } else if (input.apiKey !== undefined) {
      const cleanKey = input.apiKey.trim();
      sealed = cleanKey
        ? await encryptSecret(deps.encryptionKey, cleanKey)
        : null;
      keyHint = keyHintOf(cleanKey);
    } else if (
      sealed &&
      (!sameMediaOrigin(existing.base_url, baseUrl) ||
        existing.provider !== input.provider)
    ) {
      // 同源与同服务商校验：更改端点来源或协议厂商时严禁跨源复用旧密钥。
      sealed = null;
      keyHint = "";
    }

    await sql.unsafe(
      `UPDATE chisabot_media_model_pool
       SET label = $2, capability = $3, provider = $4, base_url = $5, model = $6,
           cost_hint = $7, style_tags = $8::jsonb, max_reference_images = $9,
           param_schema = $10::jsonb, enabled = $11, api_key = $12, key_hint = $13,
           updated_at = now(), updated_by = $14
       WHERE id = $1`,
      [
        id,
        input.label,
        input.capability,
        input.provider,
        baseUrl,
        input.model,
        input.costHint,
        JSON.stringify(styleTags),
        clampReferenceCount(input.maxReferenceImages),
        JSON.stringify(paramSchema),
        input.enabled,
        sealed,
        keyHint,
        actorId,
      ],
    );
    const updated = await readPoolRow(id);
    if (!updated) throw new MediaPoolError("更新模型池条目失败。", 502);
    return rowToEntry(updated);
  }

  async function deleteEntry(id: string): Promise<boolean> {
    const rows = await sql.unsafe<{ id: string }[]>(
      "DELETE FROM chisabot_media_model_pool WHERE id = $1 RETURNING id",
      [id],
    );
    return rows.length > 0;
  }

  async function selectPoolRow(
    capabilities: readonly MediaCapability[],
    requestedModelId?: string,
    minReferenceImages = 0,
  ): Promise<PoolRow | null> {
    if (requestedModelId?.trim()) {
      const row = await readPoolRow(requestedModelId.trim());
      if (!row?.enabled) {
        throw new MediaPoolError(
          `找不到已启用的模型池条目「${requestedModelId.trim()}」。`,
          404,
        );
      }
      const cap = normalizeCapability(row.capability);
      if (!capabilities.includes(cap)) {
        throw new MediaPoolError(
          `模型池条目「${row.label}」的能力为 ${cap}，不支持当前操作。`,
          400,
        );
      }
      return row;
    }

    const rows = await sql.unsafe<PoolRow[]>(
      "SELECT * FROM chisabot_media_model_pool WHERE enabled = true ORDER BY updated_at DESC, id ASC",
    );
    for (const cap of capabilities) {
      const hit = rows.find(
        (row) =>
          row.enabled &&
          normalizeCapability(row.capability) === cap &&
          clampReferenceCount(Number(row.max_reference_images)) >=
            minReferenceImages,
      );
      if (hit) return hit;
    }
    return (
      rows.find(
        (row) =>
          row.enabled &&
          capabilities.includes(normalizeCapability(row.capability)),
      ) ?? null
    );
  }

  // ------------------------------------------------------------------ 生图（多模型 + 多参考图 ≤ 10 + Schema 参数）

  async function invokePoolImageModel(
    row: PoolRow,
    request: {
      prompt: string;
      aspect: ImageAspect;
      references: MediaFileRecord[];
      extraParams: Record<string, string | number | boolean>;
    },
  ): Promise<Buffer> {
    const entry = rowToEntry(row);
    const apiKey = await resolveApiKeyForRow(row);
    const authHeader: Record<string, string> = apiKey
      ? { authorization: `Bearer ${apiKey}` }
      : {};
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

    if (entry.provider === "minimax") {
      const body: Record<string, unknown> = {
        ...request.extraParams,
        model: entry.model,
        prompt: request.prompt,
        aspect_ratio: request.aspect,
        n: 1,
        response_format: "base64",
      };
      if (request.references.length > 0) {
        body.subject_reference = request.references.map((ref) => ({
          type: "character",
          image_file: `data:${ref.mimeType};base64,${ref.bytes.toString("base64")}`,
        }));
      }
      const response = await doFetch(minimaxEndpoint(entry.baseUrl), {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const json = await readJsonResponse(response, "MiniMax 生图接口");
      const baseResp = json.base_resp as
        | { status_code?: number; status_msg?: string }
        | undefined;
      if (!response.ok || (baseResp && baseResp.status_code !== 0)) {
        throw new MediaPoolError(
          `生图模型报错（${baseResp?.status_code ?? response.status}）：${shortText(extractApiError(json) || "未知错误")}`,
          502,
        );
      }
      const data = json.data as
        | { image_base64?: unknown; image_urls?: unknown }
        | undefined;
      const b64 = Array.isArray(data?.image_base64)
        ? data.image_base64[0]
        : undefined;
      if (typeof b64 === "string" && b64) return Buffer.from(b64, "base64");
      const url = Array.isArray(data?.image_urls)
        ? data.image_urls[0]
        : undefined;
      if (typeof url === "string" && url) {
        return download(url, MAX_CHAT_FILE_BYTES);
      }
      throw new MediaPoolError("生图模型未返回图片内容。", 502);
    }

    if (entry.provider === "gemini") {
      const parts: Array<Record<string, unknown>> = [
        { text: request.prompt },
        ...request.references.map((ref) => ({
          inline_data: {
            mime_type: ref.mimeType,
            data: ref.bytes.toString("base64"),
          },
        })),
      ];
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
      };
      const response = await doFetch(
        geminiEndpoint(entry.baseUrl, entry.model),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              responseModalities: ["IMAGE", "TEXT"],
              ...request.extraParams,
            },
          }),
          signal,
        },
      );
      const json = await readJsonResponse(response, "Gemini 生图接口");
      if (!response.ok) {
        throw new MediaPoolError(
          `Gemini 生图失败（HTTP ${response.status}）：${shortText(extractApiError(json) || "未知错误")}`,
          502,
        );
      }
      const bytes = extractGeminiImageBytes(json);
      if (!bytes) {
        throw new MediaPoolError("Gemini 接口未返回图片字节。", 502);
      }
      return bytes;
    }

    // OpenAI-compatible / Volcengine / Kling / Custom 标准图片接口
    const base = openaiBase(entry.baseUrl);
    let response: Response;
    if (request.references.length > 0) {
      const form = new FormData();
      form.set("model", entry.model);
      form.set("prompt", request.prompt);
      form.set("n", "1");
      form.set("size", sizeForAspect(request.aspect));
      for (const [key, value] of Object.entries(request.extraParams)) {
        form.set(key, String(value));
      }
      for (let i = 0; i < request.references.length; i += 1) {
        const ref = request.references[i];
        if (!ref) continue;
        const ext = IMAGE_EXT_BY_MIME[ref.mimeType] ?? "png";
        const fieldName = request.references.length > 1 ? "image[]" : "image";
        form.append(
          fieldName,
          new Blob([new Uint8Array(ref.bytes)], { type: ref.mimeType }),
          ref.name || `ref-${i + 1}.${ext}`,
        );
      }
      response = await doFetch(`${base}/images/edits`, {
        method: "POST",
        headers: authHeader,
        body: form,
        signal,
      });
    } else {
      response = await doFetch(`${base}/images/generations`, {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: JSON.stringify({
          ...request.extraParams,
          model: entry.model,
          prompt: request.prompt,
          n: 1,
          size: sizeForAspect(request.aspect),
        }),
        signal,
      });
    }

    const json = await readJsonResponse(response, "生图接口");
    if (!response.ok) {
      throw new MediaPoolError(
        `生图模型报错（HTTP ${response.status}）：${shortText(extractApiError(json) || "未知错误")}`,
        502,
      );
    }
    const first = Array.isArray(json.data)
      ? (json.data[0] as { b64_json?: unknown; url?: unknown } | undefined)
      : undefined;
    if (typeof first?.b64_json === "string" && first.b64_json) {
      return Buffer.from(first.b64_json, "base64");
    }
    if (typeof first?.url === "string" && first.url) {
      if (first.url.startsWith("data:")) {
        return Buffer.from(
          first.url.slice(first.url.indexOf(",") + 1),
          "base64",
        );
      }
      return download(first.url, MAX_CHAT_FILE_BYTES);
    }
    throw new MediaPoolError("生图模型没有返回图片。", 502);
  }

  async function generateImageMulti(
    owner: string,
    agentId: string,
    input: {
      prompt: string;
      modelId?: string;
      aspectRatio?: ImageAspect;
      referenceSources?: string[];
      params?: Record<string, unknown>;
    },
  ): Promise<{ file: ChatFileView; entry: MediaPoolModelEntry }> {
    const refs = (input.referenceSources ?? [])
      .map((item) => item.trim())
      .filter(Boolean);
    if (refs.length > MAX_MEDIA_REFERENCE_IMAGES) {
      throw new MediaPoolError(
        `单次最多支持 ${MAX_MEDIA_REFERENCE_IMAGES} 张参考图（当前传入 ${refs.length} 张）。`,
        400,
      );
    }

    const capabilities: MediaCapability[] =
      refs.length > 0
        ? ["image-edit", "image-generate"]
        : ["image-generate", "image-edit"];
    const row = await selectPoolRow(capabilities, input.modelId, refs.length);
    if (!row) {
      throw new MediaPoolError(
        "多模态模型池中尚未配置可用的生图模型，请在 设置 → 模型 → 多模态创作模型池 中添加并启用。",
        400,
      );
    }

    const entry = rowToEntry(row);
    if (refs.length > entry.maxReferenceImages) {
      throw new MediaPoolError(
        `模型「${entry.label}」最多支持 ${entry.maxReferenceImages} 张参考图，当前传入 ${refs.length} 张。`,
        400,
      );
    }

    const paramCheck = validateMediaParams(entry.paramSchema, input.params);
    if (!paramCheck.ok) {
      throw new MediaPoolError(paramCheck.errors.join("；"), 400);
    }

    const loadedRefs: MediaFileRecord[] = [];
    for (const ref of refs) {
      const file = deps.loadFile
        ? await deps.loadFile(owner, agentId, ref, { kind: "image" })
        : null;
      if (!file) {
        throw new MediaPoolError(`找不到参考图「${ref}」。`, 404);
      }
      const mime = sniffImage(file.bytes);
      if (!mime) {
        throw new MediaPoolError(
          `参考图「${file.name}」不是有效的位图格式（仅支持 PNG/JPEG/GIF/WebP）。`,
          400,
        );
      }
      loadedRefs.push({ ...file, mimeType: mime });
    }

    const rawBytes = await invokePoolImageModel(row, {
      prompt: input.prompt,
      aspect: input.aspectRatio ?? "1:1",
      references: loadedRefs,
      extraParams: paramCheck.value,
    });
    const outMime = sniffImage(rawBytes);
    if (!outMime) {
      throw new MediaPoolError("模型返回的字节不是有效图片。", 502);
    }

    if (!deps.storeFile) {
      throw new MediaPoolError("聊天文件存储服务未就绪。", 502);
    }
    const name = `${stamp()}-${slugOf(input.prompt, "image")}.${IMAGE_EXT_BY_MIME[outMime] ?? "png"}`;
    const file = await deps.storeFile(owner, agentId, {
      kind: loadedRefs.length > 0 ? "edited" : "generated",
      name,
      mimeType: outMime,
      bytes: rawBytes,
      prompt: input.prompt,
      model: entry.model,
    });
    return { file, entry };
  }

  // ------------------------------------------------------------------ 视频生成（异步提交 + 幂等 requestKey + 状态轮询）

  async function readVideoTaskByRequestKey(
    owner: string,
    requestKey: string,
  ): Promise<VideoTaskRow | null> {
    const rows = await sql.unsafe<VideoTaskRow[]>(
      "SELECT * FROM chisabot_video_generation_tasks WHERE owner_user_id = $1 AND request_key = $2",
      [owner, requestKey],
    );
    return rows[0] ?? null;
  }

  async function readVideoTaskById(
    owner: string,
    taskId: string,
  ): Promise<VideoTaskRow | null> {
    const rows = await sql.unsafe<VideoTaskRow[]>(
      "SELECT * FROM chisabot_video_generation_tasks WHERE owner_user_id = $1 AND id = $2",
      [owner, taskId],
    );
    return rows[0] ?? null;
  }

  async function persistVideoResult(
    owner: string,
    agentId: string,
    task: VideoTaskRow,
    modelName: string,
    videoBytes: Buffer,
  ): Promise<ChatFileView> {
    if (!deps.storeFile) {
      throw new MediaPoolError("聊天文件存储服务未就绪。", 502);
    }
    const name = `${stamp()}-${slugOf(task.prompt, "video")}.mp4`;
    const saved = await deps.storeFile(owner, agentId, {
      kind: "generated",
      name,
      mimeType: "video/mp4",
      bytes: videoBytes,
      prompt: task.prompt,
      model: modelName,
    });
    await sql.unsafe(
      `UPDATE chisabot_video_generation_tasks
       SET status = 'succeeded', progress = 100, result_file_id = $3, error_message = NULL, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2`,
      [task.id, owner, saved.id],
    );
    return saved;
  }

  async function buildVideoTaskView(
    owner: string,
    task: VideoTaskRow,
    file?: ChatFileView,
  ): Promise<VideoGenerationTaskView> {
    const resolvedFile =
      file ??
      (task.result_file_id && deps.getFileView
        ? ((await deps.getFileView(owner, task.result_file_id)) ?? undefined)
        : undefined);
    return {
      taskId: task.id,
      requestKey: task.request_key,
      modelId: task.model_id,
      status: normalizeTaskStatus(task.status),
      progress: Number(task.progress ?? 0),
      prompt: task.prompt,
      ...(resolvedFile ? { file: resolvedFile } : {}),
      ...(task.error_message ? { error: task.error_message } : {}),
      createdAt: iso(task.created_at),
      updatedAt: iso(task.updated_at),
    };
  }

  async function submitVideoGeneration(
    owner: string,
    agentId: string,
    input: {
      prompt: string;
      requestKey?: string;
      modelId?: string;
      referenceSources?: string[];
      params?: Record<string, unknown>;
    },
  ): Promise<{ task: VideoGenerationTaskView; deduplicated: boolean }> {
    const refs = (input.referenceSources ?? [])
      .map((item) => item.trim())
      .filter(Boolean);
    if (refs.length > MAX_MEDIA_REFERENCE_IMAGES) {
      throw new MediaPoolError(
        `视频参考图数量不能超过 ${MAX_MEDIA_REFERENCE_IMAGES} 张。`,
        400,
      );
    }

    const row = await selectPoolRow(
      ["video-generate"],
      input.modelId,
      refs.length,
    );
    if (!row) {
      throw new MediaPoolError(
        "尚未配置已启用的视频生成模型（video-generate），请在 设置 → 模型 → 多模态创作模型池 中添加。",
        400,
      );
    }
    const entry = rowToEntry(row);

    const requestKey =
      input.requestKey?.trim() ||
      `vg_${createHash("sha256")
        .update(
          JSON.stringify([
            owner,
            agentId,
            entry.id,
            input.prompt.trim(),
            refs,
            input.params ?? {},
          ]),
        )
        .digest("hex")
        .slice(0, 24)}`;

    // 幂等校验：命中相同 (owner, requestKey) 直接返回已有任务，绝不重复调上游扣费。
    const existing = await readVideoTaskByRequestKey(owner, requestKey);
    if (existing) {
      return {
        task: await buildVideoTaskView(owner, existing),
        deduplicated: true,
      };
    }

    if (refs.length > entry.maxReferenceImages) {
      throw new MediaPoolError(
        `视频模型「${entry.label}」最多支持 ${entry.maxReferenceImages} 张参考图。`,
        400,
      );
    }

    const paramCheck = validateMediaParams(entry.paramSchema, input.params);
    if (!paramCheck.ok) {
      throw new MediaPoolError(paramCheck.errors.join("；"), 400);
    }

    const loadedRefs: MediaFileRecord[] = [];
    for (const ref of refs) {
      const file = deps.loadFile
        ? await deps.loadFile(owner, agentId, ref, { kind: "image" })
        : null;
      if (!file) throw new MediaPoolError(`找不到参考图「${ref}」。`, 404);
      const mime = sniffImage(file.bytes);
      if (!mime) {
        throw new MediaPoolError(`参考图「${file.name}」不是有效图片。`, 400);
      }
      loadedRefs.push({ ...file, mimeType: mime });
    }

    const apiKey = await resolveApiKeyForRow(row);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": requestKey,
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    };
    const submitUrl =
      entry.provider === "minimax"
        ? `${entry.baseUrl.replace(/\/v1$/i, "")}/v1/video_generation`
        : `${openaiBase(entry.baseUrl)}/videos/generations`;

    const payload: Record<string, unknown> = {
      ...paramCheck.value,
      model: entry.model,
      prompt: input.prompt,
      ...(loadedRefs.length > 0
        ? {
            reference_images: loadedRefs.map(
              (ref) =>
                `data:${ref.mimeType};base64,${ref.bytes.toString("base64")}`,
            ),
          }
        : {}),
    };

    const response = await doFetch(submitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const json = await readJsonResponse(response, "视频生成接口");
    if (!response.ok) {
      throw new MediaPoolError(
        `视频生成提交失败（HTTP ${response.status}）：${shortText(extractApiError(json) || "未知错误")}`,
        502,
      );
    }

    const taskId = `vt_${randomUUID().slice(0, 12)}`;
    const providerTaskId = String(
      json.task_id ??
        json.id ??
        (json.data as { id?: unknown } | undefined)?.id ??
        taskId,
    );
    const rawStatus = String(json.status ?? "queued");
    const status = normalizeTaskStatus(rawStatus);
    const progress =
      typeof json.progress === "number" && Number.isFinite(json.progress)
        ? Math.min(100, Math.max(0, Math.trunc(json.progress)))
        : status === "succeeded"
          ? 100
          : 0;

    await sql.unsafe(
      `INSERT INTO chisabot_video_generation_tasks
       (id, owner_user_id, agent_id, request_key, model_id, provider_task_id, status, progress, prompt, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
      [
        taskId,
        owner,
        agentId,
        requestKey,
        entry.id,
        providerTaskId,
        status,
        progress,
        input.prompt,
      ],
    );

    const inserted = await readVideoTaskById(owner, taskId);
    if (!inserted) throw new MediaPoolError("写入视频生成任务失败。", 502);

    const directUrl =
      typeof json.video_url === "string"
        ? json.video_url
        : typeof (json.data as { url?: unknown } | undefined)?.url === "string"
          ? String((json.data as { url?: unknown }).url)
          : null;
    const directB64 =
      typeof json.b64_video === "string" ? json.b64_video : null;

    if (directUrl || directB64) {
      const videoBytes = directB64
        ? Buffer.from(directB64, "base64")
        : await download(directUrl ?? "", MAX_CHAT_FILE_BYTES);
      const savedFile = await persistVideoResult(
        owner,
        agentId,
        inserted,
        entry.model,
        videoBytes,
      );
      const updated = (await readVideoTaskById(owner, taskId)) ?? inserted;
      return {
        task: await buildVideoTaskView(owner, updated, savedFile),
        deduplicated: false,
      };
    }

    return {
      task: await buildVideoTaskView(owner, inserted),
      deduplicated: false,
    };
  }

  async function pollVideoGenerationStatus(
    owner: string,
    agentId: string,
    query: { taskId?: string; requestKey?: string },
  ): Promise<VideoGenerationTaskView> {
    const task = query.taskId?.trim()
      ? await readVideoTaskById(owner, query.taskId.trim())
      : query.requestKey?.trim()
        ? await readVideoTaskByRequestKey(owner, query.requestKey.trim())
        : null;
    if (!task) {
      throw new MediaPoolError("找不到对应的视频生成任务。", 404);
    }
    const currentStatus = normalizeTaskStatus(task.status);
    if (currentStatus === "succeeded" || currentStatus === "failed") {
      return buildVideoTaskView(owner, task);
    }

    const row = await readPoolRow(task.model_id);
    if (!row) {
      return buildVideoTaskView(owner, task);
    }
    const entry = rowToEntry(row);
    const apiKey = await resolveApiKeyForRow(row);
    const headers: Record<string, string> = apiKey
      ? { authorization: `Bearer ${apiKey}` }
      : {};
    const statusUrl =
      entry.provider === "minimax"
        ? `${entry.baseUrl.replace(/\/v1$/i, "")}/v1/query/video_generation?task_id=${encodeURIComponent(task.provider_task_id)}`
        : `${openaiBase(entry.baseUrl)}/videos/generations/${encodeURIComponent(task.provider_task_id)}`;

    const response = await doFetch(statusUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    const json = await readJsonResponse(response, "视频状态查询接口");
    if (!response.ok) {
      throw new MediaPoolError(
        `查询视频任务状态失败（HTTP ${response.status}）：${shortText(extractApiError(json) || "未知错误")}`,
        502,
      );
    }

    const nextStatus = normalizeTaskStatus(String(json.status ?? task.status));
    const nextProgress =
      typeof json.progress === "number" && Number.isFinite(json.progress)
        ? Math.min(100, Math.max(0, Math.trunc(json.progress)))
        : nextStatus === "succeeded"
          ? 100
          : Number(task.progress ?? 0);

    if (nextStatus === "failed") {
      const errMsg = shortText(extractApiError(json) || "视频生成失败");
      await sql.unsafe(
        `UPDATE chisabot_video_generation_tasks
         SET status = 'failed', error_message = $3, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2`,
        [task.id, owner, errMsg],
      );
      const updated = (await readVideoTaskById(owner, task.id)) ?? task;
      return buildVideoTaskView(owner, updated);
    }

    const videoUrl =
      typeof json.video_url === "string"
        ? json.video_url
        : typeof (json.data as { url?: unknown } | undefined)?.url === "string"
          ? String((json.data as { url?: unknown }).url)
          : null;
    const videoB64 = typeof json.b64_video === "string" ? json.b64_video : null;

    if (nextStatus === "succeeded" && (videoUrl || videoB64)) {
      const videoBytes = videoB64
        ? Buffer.from(videoB64, "base64")
        : await download(videoUrl ?? "", MAX_CHAT_FILE_BYTES);
      const savedFile = await persistVideoResult(
        owner,
        agentId,
        task,
        entry.model,
        videoBytes,
      );
      const updated = (await readVideoTaskById(owner, task.id)) ?? task;
      return buildVideoTaskView(owner, updated, savedFile);
    }

    await sql.unsafe(
      `UPDATE chisabot_video_generation_tasks
       SET status = $3, progress = $4, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2`,
      [task.id, owner, nextStatus, nextProgress],
    );
    const updated = (await readVideoTaskById(owner, task.id)) ?? task;
    return buildVideoTaskView(owner, updated);
  }

  // ------------------------------------------------------------------ 专项视频理解子会话（拒绝 90MB base64 暴力内联 & 拒绝私有 /analyze）

  async function inspectVideo(
    owner: string,
    agentId: string,
    input: {
      source?: string;
      question: string;
      modelId?: string;
      frameCount?: number;
      focusTimestamp?: string;
    },
  ): Promise<VideoInspectResult> {
    const file = deps.loadFile
      ? await deps.loadFile(owner, agentId, input.source, { kind: "video" })
      : null;
    if (!file) {
      throw new MediaPoolError(
        "找不到要分析的视频文件，请确认文件 id 或先上传视频。",
        404,
      );
    }
    if (!file.mimeType.toLowerCase().startsWith("video/")) {
      throw new MediaPoolError(
        `文件「${file.name}」（${file.mimeType}）不是视频文件。`,
        400,
      );
    }

    const poolRow = await selectPoolRow(
      ["video-understand"],
      input.modelId,
    ).catch((error) => {
      if (input.modelId) throw error;
      return null;
    });

    let effectiveProvider: MediaPoolProvider = "openai";
    let effectiveBaseUrl = "";
    let effectiveModel = "";
    let effectiveApiKey = "";
    let effectiveId = "fallback-vision";
    let effectiveLabel = "默认多模态模型";

    if (poolRow) {
      const entry = rowToEntry(poolRow);
      effectiveProvider = entry.provider;
      effectiveBaseUrl = entry.baseUrl;
      effectiveModel = entry.model;
      effectiveApiKey = await resolveApiKeyForRow(poolRow);
      effectiveId = entry.id;
      effectiveLabel = entry.label;
    } else if (deps.fallbackVisionModel) {
      const vision = await deps.fallbackVisionModel(owner, agentId);
      if (vision) {
        effectiveProvider = "openai";
        effectiveBaseUrl = vision.baseUrl;
        effectiveModel = vision.model;
        effectiveApiKey = vision.apiKey;
        effectiveLabel = `识图回退（${vision.model}）`;
      }
    }

    if (!effectiveBaseUrl || !effectiveModel) {
      throw new MediaPoolError(
        "尚未配置视频理解模型（video-understand），请在 设置 → 模型 → 多模态创作模型池 中添加。",
        400,
      );
    }

    const focusHint = input.focusTimestamp?.trim()
      ? `\n重点关注时间点/片段：${input.focusTimestamp.trim()}`
      : "";
    const promptText = `你正在执行专项视频理解子会话，请仅依据提供的视频内容客观回答用户问题，不要编造未出现的细节。\n用户问题：${input.question}${focusHint}`;

    let audioTranscript: string | undefined;
    if (deps.transcribeVideoAudio) {
      const transcript = await deps
        .transcribeVideoAudio(file.bytes, file.mimeType, file.name)
        .catch(() => null);
      if (transcript?.trim()) {
        audioTranscript = transcript.trim();
      }
    }

    // 策略 1：标准 Gemini 多模态协议且视频大小严格 ≤ MAX_VIDEO_INLINE_BYTES（10 MiB）
    if (
      effectiveProvider === "gemini" &&
      file.bytes.length <= MAX_VIDEO_INLINE_BYTES
    ) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(effectiveApiKey ? { "x-goog-api-key": effectiveApiKey } : {}),
      };
      const parts: Array<Record<string, unknown>> = [
        {
          text: audioTranscript
            ? `${promptText}\n\n【音轨转写参考】\n${audioTranscript}`
            : promptText,
        },
        {
          inline_data: {
            mime_type: file.mimeType,
            data: file.bytes.toString("base64"),
          },
        },
      ];
      const response = await doFetch(
        geminiEndpoint(effectiveBaseUrl, effectiveModel),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      const json = await readJsonResponse(response, "Gemini 视频理解接口");
      if (!response.ok) {
        throw new MediaPoolError(
          `视频理解模型报错（HTTP ${response.status}）：${shortText(extractApiError(json) || "未知错误")}`,
          502,
        );
      }
      const summary = extractGeminiText(json);
      if (!summary) {
        throw new MediaPoolError("视频理解模型没有返回分析文本。", 502);
      }
      return {
        fileId: file.id ?? file.name,
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.bytes.length,
        modelId: effectiveId,
        modelLabel: effectiveLabel,
        strategy: "gemini-inline-bounded",
        summary,
        framesSampled: 0,
        ...(audioTranscript ? { audioTranscript } : {}),
      };
    }

    // 策略 2：标准等距关键帧抽样 + OpenAI-compatible / Gemini 多图理解（严禁暴力 base64 内联超大视频）
    const frameCount = Math.min(
      Math.max(Math.trunc(input.frameCount ?? 4), 1),
      8,
    );
    const frames = await extractKeyframes(file.bytes, frameCount);

    if (frames.length === 0) {
      const fallbackLines = [
        `视频「${file.name}」（${file.mimeType}，${(file.bytes.length / 1024 / 1024).toFixed(2)} MB）超出安全内联上限（${Math.round(MAX_VIDEO_INLINE_BYTES / 1024 / 1024)} MB）或当前模型需走关键帧抽样，但当前运行环境未能抽取到关键帧（可能未安装 FFmpeg 或编码不受支持）。`,
        audioTranscript
          ? `已提取到的音轨转写内容：\n${audioTranscript}`
          : "请确认服务端已安装 FFmpeg 或提供时长更短的视频片段。",
      ];
      return {
        fileId: file.id ?? file.name,
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.bytes.length,
        modelId: effectiveId,
        modelLabel: effectiveLabel,
        strategy: "metadata-fallback",
        summary: fallbackLines.join("\n\n"),
        framesSampled: 0,
        ...(audioTranscript ? { audioTranscript } : {}),
      };
    }

    const framePrompt = [
      promptText,
      `说明：以下为从视频「${file.name}」按等距抽样提取的 ${frames.length} 张按时间先后排列的关键帧画面。`,
      audioTranscript ? `【音轨转写参考】\n${audioTranscript}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    let summary = "";
    if (effectiveProvider === "gemini") {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(effectiveApiKey ? { "x-goog-api-key": effectiveApiKey } : {}),
      };
      const response = await doFetch(
        geminiEndpoint(effectiveBaseUrl, effectiveModel),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: framePrompt },
                  ...frames.map((frame) => ({
                    inline_data: {
                      mime_type: "image/jpeg",
                      data: frame.toString("base64"),
                    },
                  })),
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      const json = await readJsonResponse(response, "Gemini 关键帧理解接口");
      if (!response.ok) {
        throw new MediaPoolError(
          `视频理解模型报错（HTTP ${response.status}）：${shortText(extractApiError(json) || "未知错误")}`,
          502,
        );
      }
      summary = extractGeminiText(json);
    } else {
      const response = await doFetch(
        `${openaiBase(effectiveBaseUrl)}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(effectiveApiKey
              ? { authorization: `Bearer ${effectiveApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: effectiveModel,
            max_tokens: 1800,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: framePrompt },
                  ...frames.map((frame) => ({
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${frame.toString("base64")}`,
                    },
                  })),
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      const json = await readJsonResponse(response, "视频理解接口");
      if (!response.ok) {
        throw new MediaPoolError(
          `视频理解模型报错（HTTP ${response.status}）：${shortText(extractApiError(json) || "未知错误")}`,
          502,
        );
      }
      summary = extractChatCompletionText(json);
    }

    if (!summary) {
      throw new MediaPoolError("视频理解模型没有返回分析文本。", 502);
    }

    return {
      fileId: file.id ?? file.name,
      fileName: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.length,
      modelId: effectiveId,
      modelLabel: effectiveLabel,
      strategy: "keyframe-sampling",
      summary,
      framesSampled: frames.length,
      ...(audioTranscript ? { audioTranscript } : {}),
    };
  }

  // ------------------------------------------------------------------ AI 生成 Bot 头像

  async function generateBotAvatar(
    actor: AgentActor,
    agentId: string,
    input: { prompt?: string; modelId?: string; style?: string } = {},
  ): Promise<{
    avatar: { kind: string; url?: string; version?: string };
    prompt: string;
    model: string;
  }> {
    if (!deps.agents || !deps.botAvatars) {
      throw new MediaPoolError("头像服务未就绪。", 502);
    }
    const agent = await deps.agents.get(actor, agentId);
    if (!agent) {
      throw new MediaPoolError("找不到这个机器人。", 404);
    }
    if (!canManageAgent(actor, agent)) {
      throw new MediaPoolError("你没有权限修改这个机器人的头像。", 403);
    }

    const prompt = defaultAvatarPrompt(agent, input.prompt, input.style);
    let rawBytes: Uint8Array | null = null;
    let modelName = "";

    const poolRow = await selectPoolRow(
      ["image-generate"],
      input.modelId,
    ).catch((error) => {
      if (input.modelId) throw error;
      return null;
    });

    if (poolRow) {
      const entry = rowToEntry(poolRow);
      rawBytes = await invokePoolImageModel(poolRow, {
        prompt,
        aspect: "1:1",
        references: [],
        extraParams: {},
      });
      modelName = entry.model;
    } else if (deps.fallbackGenerateImage) {
      const generated = await deps.fallbackGenerateImage(
        actor.id,
        agentId,
        prompt,
      );
      if (generated) {
        rawBytes = generated.bytes;
        modelName = generated.model;
      }
    }

    if (!rawBytes) {
      throw new MediaPoolError(
        "尚未配置可用的生图模型，请先在 设置 → 模型 中配置生图模型或多模态模型池。",
        400,
      );
    }

    // 严格通过防像素炸弹二进制校验
    const initialValidation = validateAvatarImage(rawBytes);
    if (!initialValidation.ok) {
      throw new MediaPoolError(
        `AI 生成的头像未通过安全图片校验：${initialValidation.reason}`,
        400,
      );
    }

    let finalBytes: Uint8Array = rawBytes;
    if (finalBytes.length > MAX_AVATAR_BYTES && deps.shrinkAvatarBytes) {
      const shrunk = await deps.shrinkAvatarBytes(finalBytes).catch(() => null);
      if (shrunk && shrunk.length > 0 && shrunk.length <= MAX_AVATAR_BYTES) {
        const recheck = validateAvatarImage(shrunk);
        if (recheck.ok) {
          finalBytes = shrunk;
        }
      }
    }

    if (finalBytes.length > MAX_AVATAR_BYTES) {
      throw new MediaPoolError(
        "AI 生成的头像体积超过 256 KB 上限，请选用更小分辨率的模型参数。",
        413,
      );
    }

    const avatar = await deps.botAvatars.setImage(actor, agentId, finalBytes);
    return { avatar, prompt, model: modelName };
  }

  // ------------------------------------------------------------------ 机器人工具集

  const withFiles = (text: string, files: ChatFileView[]) =>
    `${text}\n${CHAT_FILES_MARKER}${JSON.stringify(files.map(({ prompt: _p, ...rest }) => rest))}`;

  async function tools(owner: string, agentId: string): Promise<GrantedTool[]> {
    const wrap = <T extends z.ZodType>(
      name: string,
      description: string,
      parameters: T,
      run: (input: z.infer<T>) => Promise<string>,
      effect?: "read" | "write",
    ): GrantedTool => ({
      name,
      ref: `media-pool/${name}`,
      ...(effect ? { effect } : {}),
      description,
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        }
        try {
          return await run(parsed.data);
        } catch (error) {
          if (error instanceof MediaPoolError) {
            return `${REFUSAL_MARKER} ${error.message}`;
          }
          return `${REFUSAL_MARKER} ${error instanceof Error ? error.message : "多模态工具执行失败。"}`;
        }
      },
    });

    const entries = await listEntries({ includeDisabled: false }).catch(
      () => [] as MediaPoolModelEntry[],
    );
    const hasImagePool = entries.some(
      (item) =>
        item.capability === "image-generate" ||
        item.capability === "image-edit",
    );
    const hasVideoGen = entries.some(
      (item) => item.capability === "video-generate",
    );
    const hasVideoUnderstand =
      entries.some((item) => item.capability === "video-understand") ||
      Boolean(deps.fallbackVisionModel);

    const out: GrantedTool[] = [];

    if (entries.length > 0) {
      out.push(
        wrap(
          "media_pool_list",
          "列出多模态创作模型池中已启用的生图、多图编辑、视频生成与视频理解模型，包含画风标签、成本提示、最大参考图数量与允许透传的 paramSchema，便于自主选型。",
          z
            .object({
              capability: z.enum(MEDIA_CAPABILITIES).optional(),
              tag: z.string().trim().max(32).optional(),
            })
            .strict(),
          async (input) => {
            const list = await listEntries({
              includeDisabled: false,
              ...(input.capability ? { capability: input.capability } : {}),
              ...(input.tag ? { tag: input.tag } : {}),
            });
            return JSON.stringify(
              {
                total: list.length,
                models: list.map((item) => ({
                  id: item.id,
                  label: item.label,
                  capability: item.capability,
                  provider: item.provider,
                  model: item.model,
                  costHint: item.costHint,
                  styleTags: item.styleTags,
                  maxReferenceImages: item.maxReferenceImages,
                  paramSchema: item.paramSchema,
                })),
              },
              null,
              2,
            );
          },
          "read",
        ),
      );
    }

    if (hasImagePool) {
      out.push(
        wrap(
          "image_generate_multi",
          `使用多模态模型池中的指定模型生成或编辑图片，支持最多 ${MAX_MEDIA_REFERENCE_IMAGES} 张参考图，并严格按该模型的 paramSchema 透传自定义参数。`,
          z
            .object({
              prompt: z.string().trim().min(1).max(2000),
              modelId: z.string().trim().max(80).optional(),
              aspect_ratio: z.enum(IMAGE_ASPECTS).optional(),
              reference_sources: z
                .array(z.string().trim().min(1).max(400))
                .max(MAX_MEDIA_REFERENCE_IMAGES)
                .optional(),
              params: z.record(z.string(), z.unknown()).optional(),
            })
            .strict(),
          async (input) => {
            const { file, entry } = await generateImageMulti(owner, agentId, {
              prompt: input.prompt,
              ...(input.modelId ? { modelId: input.modelId } : {}),
              ...(input.aspect_ratio
                ? { aspectRatio: input.aspect_ratio }
                : {}),
              ...(input.reference_sources
                ? { referenceSources: input.reference_sources }
                : {}),
              ...(input.params ? { params: input.params } : {}),
            });
            return withFiles(
              `已使用模型「${entry.label}（${entry.model}）」生成图片，已在聊天里展示。文件 id：${file.id}`,
              [file],
            );
          },
          "write",
        ),
      );
    }

    if (hasVideoGen) {
      out.push(
        wrap(
          "video_generate",
          "提交异步视频生成任务或查询任务状态。支持幂等 request_key 防止重复扣费；任务完成后自动落盘为可播放视频卡片。",
          z
            .object({
              action: z.enum(["submit", "status"]).optional().default("submit"),
              prompt: z.string().trim().max(2000).optional(),
              request_key: z.string().trim().min(1).max(120).optional(),
              task_id: z.string().trim().min(1).max(80).optional(),
              modelId: z.string().trim().max(80).optional(),
              reference_sources: z
                .array(z.string().trim().min(1).max(400))
                .max(MAX_MEDIA_REFERENCE_IMAGES)
                .optional(),
              params: z.record(z.string(), z.unknown()).optional(),
            })
            .strict(),
          async (input) => {
            if (input.action === "status") {
              const task = await pollVideoGenerationStatus(owner, agentId, {
                ...(input.task_id ? { taskId: input.task_id } : {}),
                ...(input.request_key ? { requestKey: input.request_key } : {}),
              });
              const summary = `视频任务 ${task.taskId} 状态：${task.status}（进度 ${task.progress}%）${task.error ? `；原因：${task.error}` : ""}`;
              return task.file ? withFiles(summary, [task.file]) : summary;
            }
            if (!input.prompt?.trim()) {
              throw new MediaPoolError(
                "提交视频生成任务必须提供 prompt。",
                400,
              );
            }
            const { task, deduplicated } = await submitVideoGeneration(
              owner,
              agentId,
              {
                prompt: input.prompt,
                ...(input.request_key ? { requestKey: input.request_key } : {}),
                ...(input.modelId ? { modelId: input.modelId } : {}),
                ...(input.reference_sources
                  ? { referenceSources: input.reference_sources }
                  : {}),
                ...(input.params ? { params: input.params } : {}),
              },
            );
            const prefix = deduplicated
              ? `命中幂等键 ${task.requestKey}，已复用已有任务 ${task.taskId}（未重复扣费），当前状态：${task.status}（进度 ${task.progress}%）。`
              : `已提交视频生成任务 ${task.taskId}（幂等键：${task.requestKey}），当前状态：${task.status}（进度 ${task.progress}%）。可用 action="status" 与 task_id 查询进度。`;
            return task.file ? withFiles(prefix, [task.file]) : prefix;
          },
          "write",
        ),
      );
    }

    if (hasVideoUnderstand) {
      out.push(
        wrap(
          "video_inspect",
          "专项视频理解子会话工具：通过标准多模态协议或安全关键帧抽样分析视频画面、动作、字幕与音轨内容，支持多轮追问。",
          z
            .object({
              question: z.string().trim().min(1).max(1000),
              source: z.string().trim().max(400).optional(),
              modelId: z.string().trim().max(80).optional(),
              frame_count: z.number().int().min(1).max(8).optional(),
              focus_timestamp: z.string().trim().max(40).optional(),
            })
            .strict(),
          async (input) => {
            const result = await inspectVideo(owner, agentId, {
              question: input.question,
              ...(input.source ? { source: input.source } : {}),
              ...(input.modelId ? { modelId: input.modelId } : {}),
              ...(input.frame_count ? { frameCount: input.frame_count } : {}),
              ...(input.focus_timestamp
                ? { focusTimestamp: input.focus_timestamp }
                : {}),
            });
            return `视频理解结果（模型：${result.modelLabel}，策略：${result.strategy}${result.framesSampled > 0 ? `，抽样 ${result.framesSampled} 帧` : ""}）：\n${result.summary}`;
          },
          "read",
        ),
      );
    }

    return out;
  }

  // ------------------------------------------------------------------ 路由

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.onError((error, c) => {
      if (error instanceof MediaPoolError) {
        return c.json({ error: error.message }, error.status);
      }
      return c.json({ error: "多模态模型池服务暂时不可用，请稍后重试。" }, 503);
    });

    const requireAdminRole: MiddlewareHandler<{
      Variables: AppVariables;
    }> = async (c, next) => {
      if (c.var.actor.role !== "admin") {
        return c.json({ error: "只有管理员可以维护多模态模型池。" }, 403);
      }
      await next();
    };

    app.get("/", async (c) => {
      const isAdmin = c.var.actor.role === "admin";
      const includeDisabled = isAdmin && c.req.query("enabledOnly") !== "1";
      const rawCap = c.req.query("capability");
      const capability =
        rawCap && (MEDIA_CAPABILITIES as readonly string[]).includes(rawCap)
          ? (rawCap as MediaCapability)
          : undefined;
      const entries = await listEntries({
        includeDisabled,
        ...(capability ? { capability } : {}),
      });
      return c.json({ entries });
    });

    app.post(
      "/",
      requireAdminRole,
      bodyLimit({ maxSize: ADMIN_BODY_LIMIT_BYTES }),
      async (c) => {
        const body = await c.req.json().catch(() => null);
        const entry = await createEntry(c.var.actor.id, body);
        return c.json({ entry }, 201);
      },
    );

    app.put(
      "/:id",
      requireAdminRole,
      bodyLimit({ maxSize: ADMIN_BODY_LIMIT_BYTES }),
      async (c) => {
        const body = await c.req.json().catch(() => null);
        const entry = await updateEntry(
          c.var.actor.id,
          c.req.param("id"),
          body,
        );
        return c.json({ entry });
      },
    );

    app.delete("/:id", requireAdminRole, async (c) => {
      const deleted = await deleteEntry(c.req.param("id"));
      if (!deleted) return c.json({ error: "找不到该模型池条目。" }, 404);
      return c.body(null, 204);
    });

    return app;
  }

  /** Bot AI 生成头像路由：挂载在 `/api/bots` 下，提供 `POST /api/bots/:agentId/avatar/generate`。 */
  function botAvatarRoutes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.onError((error, c) => {
      if (error instanceof MediaPoolError) {
        return c.json({ error: error.message }, error.status);
      }
      return c.json({ error: "生成头像失败，请稍后重试。" }, 502);
    });

    const generateAvatarBodySchema = z
      .object({
        prompt: z.string().trim().max(1000).optional(),
        modelId: z.string().trim().max(80).optional(),
        style: z.string().trim().max(80).optional(),
      })
      .strict();

    app.post(
      "/:agentId/avatar/generate",
      bodyLimit({ maxSize: 16 * 1024 }),
      async (c) => {
        const raw = await c.req.json().catch(() => ({}));
        const parsed = generateAvatarBodySchema.safeParse(raw ?? {});
        if (!parsed.success) {
          return c.json(
            { error: parsed.error.issues[0]?.message ?? "参数无效。" },
            400,
          );
        }
        const result = await generateBotAvatar(
          c.var.actor,
          c.req.param("agentId"),
          parsed.data,
        );
        return c.json(result, 200);
      },
    );

    return app;
  }

  return {
    ensure,
    listEntries,
    getEntry,
    createEntry,
    updateEntry,
    deleteEntry,
    generateImageMulti,
    submitVideoGeneration,
    pollVideoGenerationStatus,
    inspectVideo,
    generateBotAvatar,
    tools,
    routes,
    botAvatarRoutes,
  };
}

export type MediaPoolService = ReturnType<typeof createMediaPoolService>;
