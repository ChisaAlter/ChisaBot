/**
 * 多模态创作模型池（多生图 / 多参考图改图 / 视频生成 / 视频理解）共用类型与 Schema 白名单校验。
 */

import type { ChatFileView } from "./chat-files";

export const MEDIA_CAPABILITIES = [
  "image-generate",
  "image-edit",
  "video-generate",
  "video-understand",
] as const;
export type MediaCapability = (typeof MEDIA_CAPABILITIES)[number];

export const MEDIA_POOL_PROVIDERS = [
  "openai",
  "minimax",
  "gemini",
  "kling",
  "volcengine",
  "custom",
] as const;
export type MediaPoolProvider = (typeof MEDIA_POOL_PROVIDERS)[number];

/** 单次生图 / 视频生成允许携带的参考图硬上限。 */
export const MAX_MEDIA_REFERENCE_IMAGES = 10;

export const MEDIA_CAPABILITY_LABELS: Record<MediaCapability, string> = {
  "image-generate": "文生图",
  "image-edit": "多图编辑",
  "video-generate": "视频生成",
  "video-understand": "视频理解",
};

export const MEDIA_PROVIDER_LABELS: Record<MediaPoolProvider, string> = {
  openai: "OpenAI 兼容",
  minimax: "MiniMax",
  gemini: "Google Gemini",
  kling: "可灵 Kling",
  volcengine: "火山引擎",
  custom: "自定义标准协议",
};

export type MediaParamType = "string" | "number" | "integer" | "boolean";

export type MediaParamPropertySchema = {
  type: MediaParamType;
  description?: string;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: string | number | boolean;
};

/**
 * 严格白名单 JSON Schema：只允许透传 `properties` 中显式声明且类型/范围合法的标量参数，
 * 严禁 `additionalProperties` 任意注入上游私有字段或认证覆盖字段。
 */
export type MediaParamSchema = {
  type: "object";
  properties: Record<string, MediaParamPropertySchema>;
  required?: readonly string[];
  additionalProperties?: false;
};

export const EMPTY_MEDIA_PARAM_SCHEMA: MediaParamSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export type MediaPoolModelEntry = {
  id: string;
  label: string;
  capability: MediaCapability;
  provider: MediaPoolProvider;
  baseUrl: string;
  model: string;
  costHint: string;
  styleTags: string[];
  /** 允许的最大参考图数量（0–10）。 */
  maxReferenceImages: number;
  paramSchema: MediaParamSchema;
  enabled: boolean;
  keySource?: "saved" | "none";
  keyHint?: string;
  updatedAt?: string | null;
};

export type MediaPoolModelInput = {
  id?: string;
  label: string;
  capability: MediaCapability;
  provider: MediaPoolProvider;
  baseUrl: string;
  model: string;
  costHint?: string;
  styleTags?: string[];
  maxReferenceImages?: number;
  paramSchema?: MediaParamSchema;
  enabled?: boolean;
  /** 不传表示保留旧密钥（同源前提下）；空字符串或 clearApiKey=true 表示清除。 */
  apiKey?: string;
  clearApiKey?: boolean;
};

export type VideoInspectStrategy =
  | "gemini-inline-bounded"
  | "keyframe-sampling"
  | "metadata-fallback";

export type VideoInspectResult = {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  modelId: string;
  modelLabel: string;
  strategy: VideoInspectStrategy;
  summary: string;
  framesSampled: number;
  audioTranscript?: string;
};

export type VideoGenerationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type VideoGenerationTaskView = {
  taskId: string;
  requestKey: string;
  modelId: string;
  status: VideoGenerationStatus;
  progress: number;
  prompt: string;
  file?: ChatFileView;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type MediaParamValidationResult =
  | { ok: true; value: Record<string, string | number | boolean> }
  | { ok: false; errors: string[] };

const FORBIDDEN_PARAM_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "api_key",
  "apiKey",
  "authorization",
  "headers",
  "baseUrl",
  "base_url",
  "model",
  "prompt",
  "image",
  "image[]",
  "n",
  "size",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 校验并规范化存储用的参数 Schema（只允许白名单标量字段）。 */
export function normalizeMediaParamSchema(raw: unknown): MediaParamSchema {
  if (!isPlainRecord(raw)) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const rawProps = isPlainRecord(raw.properties) ? raw.properties : {};
  const properties: Record<string, MediaParamPropertySchema> = {};

  for (const [key, spec] of Object.entries(rawProps)) {
    const cleanKey = key.trim();
    if (
      !cleanKey ||
      cleanKey.length > 64 ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(cleanKey) ||
      FORBIDDEN_PARAM_KEYS.has(cleanKey) ||
      !isPlainRecord(spec)
    ) {
      continue;
    }
    const type = spec.type;
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "integer" &&
      type !== "boolean"
    ) {
      continue;
    }
    const prop: MediaParamPropertySchema = { type };
    if (typeof spec.description === "string" && spec.description.trim()) {
      prop.description = spec.description.trim().slice(0, 200);
    }
    if (Array.isArray(spec.enum) && spec.enum.length > 0) {
      const allowed = spec.enum.filter(
        (item): item is string | number | boolean =>
          typeof item === "string" ||
          (typeof item === "number" && Number.isFinite(item)) ||
          typeof item === "boolean",
      );
      if (allowed.length > 0) {
        prop.enum = allowed.slice(0, 32);
      }
    }
    if (typeof spec.minimum === "number" && Number.isFinite(spec.minimum)) {
      prop.minimum = spec.minimum;
    }
    if (typeof spec.maximum === "number" && Number.isFinite(spec.maximum)) {
      prop.maximum = spec.maximum;
    }
    if (
      typeof spec.minLength === "number" &&
      Number.isInteger(spec.minLength) &&
      spec.minLength >= 0
    ) {
      prop.minLength = spec.minLength;
    }
    if (
      typeof spec.maxLength === "number" &&
      Number.isInteger(spec.maxLength) &&
      spec.maxLength >= 0
    ) {
      prop.maxLength = spec.maxLength;
    }
    if (
      typeof spec.default === "string" ||
      (typeof spec.default === "number" && Number.isFinite(spec.default)) ||
      typeof spec.default === "boolean"
    ) {
      prop.default = spec.default;
    }
    properties[cleanKey] = prop;
  }

  const required = Array.isArray(raw.required)
    ? raw.required.filter(
        (name): name is string =>
          typeof name === "string" && Object.hasOwn(properties, name),
      )
    : [];

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * 依据模型条目的 `paramSchema` 严格校验自定义透传参数。
 * - 未在 schema.properties 中声明的字段一律拒绝（防止注入任意上游字段）。
 * - 严格检查类型、枚举、数值范围与字符串长度。
 */
export function validateMediaParams(
  schema: MediaParamSchema,
  rawParams: unknown,
): MediaParamValidationResult {
  if (rawParams === undefined || rawParams === null) {
    const missing = (schema.required ?? []).filter(
      (name) => schema.properties[name]?.default === undefined,
    );
    if (missing.length > 0) {
      return {
        ok: false,
        errors: missing.map((name) => `缺少必填自定义参数：${name}`),
      };
    }
    const defaults: Record<string, string | number | boolean> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.default !== undefined) {
        defaults[key] = prop.default;
      }
    }
    return { ok: true, value: defaults };
  }

  if (!isPlainRecord(rawParams)) {
    return { ok: false, errors: ["自定义参数 params 必须是键值对象。"] };
  }

  const errors: string[] = [];
  const out: Record<string, string | number | boolean> = {};
  const properties = schema.properties ?? {};

  for (const [key, rawValue] of Object.entries(rawParams)) {
    if (FORBIDDEN_PARAM_KEYS.has(key) || !Object.hasOwn(properties, key)) {
      errors.push(`参数「${key}」不在该模型的 paramSchema 白名单中。`);
      continue;
    }
    const spec = properties[key];
    if (!spec) {
      errors.push(`参数「${key}」未定义。`);
      continue;
    }

    if (spec.type === "string") {
      if (typeof rawValue !== "string") {
        errors.push(`参数「${key}」必须是字符串。`);
        continue;
      }
      if (spec.minLength !== undefined && rawValue.length < spec.minLength) {
        errors.push(`参数「${key}」长度不能少于 ${spec.minLength}。`);
        continue;
      }
      if (spec.maxLength !== undefined && rawValue.length > spec.maxLength) {
        errors.push(`参数「${key}」长度不能超过 ${spec.maxLength}。`);
        continue;
      }
      if (spec.enum && !spec.enum.includes(rawValue)) {
        errors.push(`参数「${key}」取值必须为：${spec.enum.join(" / ")}。`);
        continue;
      }
      out[key] = rawValue;
      continue;
    }

    if (spec.type === "number" || spec.type === "integer") {
      if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
        errors.push(`参数「${key}」必须是有效数字。`);
        continue;
      }
      if (spec.type === "integer" && !Number.isInteger(rawValue)) {
        errors.push(`参数「${key}」必须是整数。`);
        continue;
      }
      if (spec.minimum !== undefined && rawValue < spec.minimum) {
        errors.push(`参数「${key}」不能小于 ${spec.minimum}。`);
        continue;
      }
      if (spec.maximum !== undefined && rawValue > spec.maximum) {
        errors.push(`参数「${key}」不能大于 ${spec.maximum}。`);
        continue;
      }
      if (spec.enum && !spec.enum.includes(rawValue)) {
        errors.push(`参数「${key}」取值必须为：${spec.enum.join(" / ")}。`);
        continue;
      }
      out[key] = rawValue;
      continue;
    }

    if (spec.type === "boolean") {
      if (typeof rawValue !== "boolean") {
        errors.push(`参数「${key}」必须是布尔值。`);
        continue;
      }
      if (spec.enum && !spec.enum.includes(rawValue)) {
        errors.push(`参数「${key}」取值不被允许。`);
        continue;
      }
      out[key] = rawValue;
    }
  }

  for (const [key, spec] of Object.entries(properties)) {
    if (!Object.hasOwn(out, key) && spec.default !== undefined) {
      out[key] = spec.default;
    }
  }

  for (const requiredKey of schema.required ?? []) {
    if (!Object.hasOwn(out, requiredKey)) {
      errors.push(`缺少必填自定义参数：${requiredKey}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: out };
}
