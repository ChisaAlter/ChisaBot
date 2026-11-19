/**
 * 按需脱敏模型请求观测器（环形缓冲 100 条，管理员可热启停）。
 *
 * 严格安全红线：
 * - 绝不记录任何 API Key、Authorization、x-api-key、Cookie 或原始请求头；
 * - 绝不记录思维链原文（reasoning_content / thinking / <think>...</think>）；
 * - 入参图片仅记录 SHA-256 摘要、媒体类型与字节数，绝不落盘或缓存原图 base64；
 * - 仅记录模型名、思考强度、工具名与耗时、HTTP 状态、总耗时、请求 ID 与脱敏后的极短摘要。
 */

import { createHash, randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type {
  ModelObservationRecord,
  ModelObservationSnapshot,
  ObservedImageDigest,
  ObservedToolSummary,
} from "../../../shared/admin-workbench";
import {
  isResolvedReasoningEffort,
  type ResolvedReasoningEffort,
} from "../../../shared/model-routing";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";

export const MAX_OBSERVATION_RECORDS = 100;
const MAX_OBSERVED_TOOLS = 64;
const MAX_OBSERVED_IMAGES = 16;
const MAX_SUMMARY_LENGTH = 240;

const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;
const CREDENTIAL_PATTERNS: readonly [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]"],
  [
    /(?:sk|pk|rk|api|apikey|ghp|gho|xoxb|xoxp|AIza)[_-]?[A-Za-z0-9._-]{10,}/gi,
    "[redacted]",
  ],
  [
    /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/g,
    "[redacted-jwt]",
  ],
  [
    /(?:authorization|x-api-key|api[_-]?key|cookie|set-cookie|password|secret)\s*[:=]\s*[^\s,;]+/gi,
    "[redacted-credential]",
  ],
];

export type ObserveModelCallInput = {
  provider: string;
  model: string;
  effort?: ResolvedReasoningEffort | string | null;
  status: number | null;
  durationMs: number;
  requestId?: string | null;
  requestBody?: unknown;
  toolTimings?: readonly ObservedToolSummary[];
  errorCode?: string | null;
};

export type ModelObservationService = {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): ModelObservationSnapshot;
  clear(): number;
  snapshot(): ModelObservationSnapshot;
  record(input: ObserveModelCallInput): ModelObservationRecord | null;
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
};

export function sanitizeObservedText(
  raw: string,
  maxChars = MAX_SUMMARY_LENGTH,
): string {
  let text = raw.replace(THINK_TAG_RE, " ");
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractImageFromPart(
  part: Record<string, unknown>,
): ObservedImageDigest | null {
  // OpenAI image_url: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
  if (part.type === "image_url" && isRecord(part.image_url)) {
    const url =
      typeof part.image_url.url === "string" ? part.image_url.url : "";
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(url);
    if (match?.[1] && match[2]) {
      const bytes = Buffer.from(match[2], "base64");
      return {
        sha256: sha256OfBytes(bytes),
        mediaType: match[1].toLowerCase(),
        bytes: bytes.length,
      };
    }
  }
  // Anthropic / DSH image block: { type: "image", source: { type: "base64", media_type, data } }
  if (part.type === "image" && isRecord(part.source)) {
    const data =
      typeof part.source.data === "string"
        ? part.source.data
        : typeof part.source.value === "string"
          ? part.source.value
          : "";
    if (data) {
      const mediaType =
        typeof part.source.media_type === "string"
          ? part.source.media_type
          : typeof part.source.mimeType === "string"
            ? part.source.mimeType
            : "image/png";
      const cleaned = data.replace(/^data:[^;]+;base64,/i, "");
      const bytes = Buffer.from(cleaned, "base64");
      return {
        sha256: sha256OfBytes(bytes),
        mediaType: mediaType.toLowerCase(),
        bytes: bytes.length,
      };
    }
  }
  return null;
}

function extractSanitizedBodyMetadata(body: unknown): {
  tools: ObservedToolSummary[];
  images: ObservedImageDigest[];
  redactedSummary: string;
} {
  if (!isRecord(body)) {
    return { tools: [], images: [], redactedSummary: "" };
  }

  const tools: ObservedToolSummary[] = [];
  if (Array.isArray(body.tools)) {
    for (const rawTool of body.tools) {
      if (tools.length >= MAX_OBSERVED_TOOLS) break;
      if (!isRecord(rawTool)) continue;
      const fn = isRecord(rawTool.function) ? rawTool.function : undefined;
      const rawName =
        typeof rawTool.name === "string"
          ? rawTool.name
          : typeof fn?.name === "string"
            ? fn.name
            : "";
      const name = rawName.trim().slice(0, 120);
      if (name) {
        tools.push({ name });
      }
    }
  }

  const images: ObservedImageDigest[] = [];
  let latestUserText = "";
  let messageCount = 0;

  if (Array.isArray(body.messages)) {
    messageCount = body.messages.length;
    for (const message of body.messages) {
      if (!isRecord(message)) continue;
      // 严禁读取 reasoning_content / thinking 等思维链字段
      if (typeof message.content === "string") {
        if (message.role === "user" && message.content.trim()) {
          latestUserText = message.content;
        }
      } else if (Array.isArray(message.content)) {
        const textParts: string[] = [];
        for (const part of message.content) {
          if (!isRecord(part)) continue;
          if (part.type === "thinking" || part.type === "reasoning") continue;
          if (part.type === "text" && typeof part.text === "string") {
            textParts.push(part.text);
          } else if (images.length < MAX_OBSERVED_IMAGES) {
            const digest = extractImageFromPart(part);
            if (digest) images.push(digest);
          }
        }
        if (message.role === "user" && textParts.length > 0) {
          latestUserText = textParts.join(" ");
        }
      }
    }
  }

  const preview = sanitizeObservedText(latestUserText, 180);
  const summaryParts = [
    messageCount > 0 ? `消息 ${messageCount} 条` : "",
    tools.length > 0 ? `工具 ${tools.length} 个` : "",
    images.length > 0 ? `图片 ${images.length} 张` : "",
    preview ? `摘要：${preview}` : "",
  ].filter(Boolean);

  return {
    tools,
    images,
    redactedSummary: sanitizeObservedText(
      summaryParts.join(" · "),
      MAX_SUMMARY_LENGTH,
    ),
  };
}

const toggleSchema = z
  .object({
    enabled: z.boolean({ error: "enabled 字段必须是布尔值。" }),
  })
  .strict();

export function createModelObservationService(options?: {
  capacity?: number;
  initiallyEnabled?: boolean;
  now?: () => number;
}): ModelObservationService {
  const capacity = Math.max(
    1,
    Math.min(500, options?.capacity ?? MAX_OBSERVATION_RECORDS),
  );
  const nowFn = options?.now ?? Date.now;
  let enabled = options?.initiallyEnabled ?? false;
  const ring: ModelObservationRecord[] = [];

  function snapshot(): ModelObservationSnapshot {
    return {
      enabled,
      capacity,
      count: ring.length,
      items: [...ring].reverse().map((item) => ({
        ...item,
        tools: item.tools.map((tool) => ({ ...tool })),
        images: item.images.map((image) => ({ ...image })),
      })),
    };
  }

  function record(input: ObserveModelCallInput): ModelObservationRecord | null {
    if (!enabled) return null;
    const extracted = extractSanitizedBodyMetadata(input.requestBody);
    const mergedToolsMap = new Map<string, ObservedToolSummary>();
    for (const tool of extracted.tools) {
      mergedToolsMap.set(tool.name, tool);
    }
    for (const timed of input.toolTimings ?? []) {
      const cleanName = timed.name.trim().slice(0, 120);
      if (!cleanName) continue;
      if (
        mergedToolsMap.size >= MAX_OBSERVED_TOOLS &&
        !mergedToolsMap.has(cleanName)
      ) {
        break;
      }
      mergedToolsMap.set(cleanName, {
        name: cleanName,
        ...(typeof timed.durationMs === "number" &&
        Number.isFinite(timed.durationMs) &&
        timed.durationMs >= 0
          ? { durationMs: Math.round(timed.durationMs) }
          : {}),
      });
    }

    const effort = isResolvedReasoningEffort(input.effort)
      ? input.effort
      : null;
    const entry: ModelObservationRecord = {
      id: randomUUID(),
      recordedAt: new Date(nowFn()).toISOString(),
      provider: input.provider.trim().slice(0, 64) || "unknown",
      model: input.model.trim().slice(0, 200) || "unknown",
      effort,
      status:
        typeof input.status === "number" && Number.isFinite(input.status)
          ? Math.floor(input.status)
          : null,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      requestId: input.requestId
        ? sanitizeObservedText(input.requestId, 120)
        : null,
      tools: [...mergedToolsMap.values()],
      images: extracted.images,
      redactedSummary: extracted.redactedSummary,
      errorCode: input.errorCode
        ? sanitizeObservedText(input.errorCode, 80)
        : null,
    };

    if (ring.length >= capacity) {
      ring.shift();
    }
    ring.push(entry);
    return {
      ...entry,
      tools: entry.tools.map((tool) => ({ ...tool })),
      images: entry.images.map((image) => ({ ...image })),
    };
  }

  return {
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = Boolean(next);
      return snapshot();
    },
    clear() {
      const removed = ring.length;
      ring.length = 0;
      return removed;
    },
    snapshot,
    record,
    routes(requireUser) {
      const routes = new Hono<{ Variables: AppVariables }>();
      routes.use("*", requireUser);
      routes.use("*", async (context, next) => {
        const denied = requireAdmin(context);
        if (denied) return denied;
        context.header("Cache-Control", "no-store");
        await next();
      });

      routes.get("/", (context) => context.json(snapshot()));

      routes.put("/toggle", async (context) => {
        const body: unknown = await context.req.json().catch(() => null);
        const parsed = toggleSchema.safeParse(body);
        if (!parsed.success) {
          return context.json(
            { error: parsed.error.issues[0]?.message ?? "参数格式无效。" },
            400,
          );
        }
        enabled = parsed.data.enabled;
        return context.json(snapshot());
      });

      routes.delete("/", (context) => {
        const cleared = ring.length;
        ring.length = 0;
        return context.json({ ok: true, cleared, ...snapshot() });
      });

      return routes;
    },
  };
}
