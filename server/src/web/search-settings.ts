import { z } from "zod";
import {
  BlockedUrlError,
  guardedFetch,
  type GuardedFetchOptions,
} from "../../../shared/net/guarded-fetch";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import {
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  MAX_WEB_SEARCH_OVERRIDES,
  MAX_WEB_SEARCH_TIMEOUT_MS,
  MIN_WEB_SEARCH_TIMEOUT_MS,
  WEB_SEARCH_EXTERNAL_PROVIDERS,
  WEB_SEARCH_PROVIDER_KINDS,
  WEB_SEARCH_PROVIDER_PRESETS,
  type WebSearchExternalProviderKind,
  type WebSearchModelOverride,
  type WebSearchProviderKind,
  type WebSearchProviderSlotView,
  type WebSearchSettingsView,
  type WebSearchTestResult,
} from "../../../shared/web-search";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import type { SearchHit, SearchOutcome } from "./tools";

/**
 * 可插拔多供应商联网搜索管理员设置与执行器。
 *
 * - 运行时幂等建单行表 `chisabot_web_search_settings`（id = 'default'），不修改 Drizzle 旧表。
 * - 各供应商 API Key 均采用 AES-256-GCM 独立封存，并实施严格跨厂商与跨源（`sameSearchOrigin`）隔离：
 *   修改某供应商端点到不同 origin 或切换供应商时，绝不沿用/外泄旧密钥。
 * - 所有外部搜索请求统一经 `guardedFetch` 出网（DNS 钉死 + SSRF 拒绝 + 超时 + 1 MiB 响应体上限）。
 */

export const MAX_SEARCH_RESPONSE_BYTES = 1_048_576;

export class WebSearchSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchSettingsValidationError";
  }
}

type StoredProviderSlot = {
  baseUrl?: string;
  encryptedApiKey?: string | null;
  keyHint?: string;
};

type StoredProvidersMap = Partial<
  Record<WebSearchExternalProviderKind, StoredProviderSlot>
>;

export type WebSearchSettingsRow = {
  id: string;
  default_provider: string;
  fallback_to_builtin: boolean;
  timeout_ms: number;
  max_results: number;
  providers_json: unknown;
  model_overrides_json: unknown;
  updated_at: Date | string | null;
  updated_by: string | null;
};

export type WebSearchSettingsDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

export type ResolvedWebSearchPlan =
  | { mode: "native" }
  | {
      mode: "provider";
      provider: WebSearchProviderKind;
      baseUrl: string;
      apiKey?: string;
      fallbackToBuiltin: boolean;
      timeoutMs: number;
      maxResults: number;
    };

export type WebSearchTestInput = {
  query?: string;
  count?: number;
  provider?: WebSearchProviderKind;
  baseUrl?: string;
  apiKey?: string;
  fallbackToBuiltin?: boolean;
  timeoutMs?: number;
};

export type WebSearchExecuteDeps = {
  builtinSearch?: (
    query: string,
    count: number,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<SearchOutcome>;
  fetchImpl?: GuardedFetchOptions["fetchImpl"];
  resolve?: GuardedFetchOptions["resolve"];
  isBlocked?: GuardedFetchOptions["isBlocked"];
};

export type WebSearchSettingsStore = {
  ensure(): Promise<void>;
  view(): Promise<WebSearchSettingsView>;
  save(actorId: string, raw: unknown): Promise<WebSearchSettingsView>;
  resolveForModel(modelId?: string): Promise<ResolvedWebSearchPlan>;
  executeSearch(
    query: string,
    options?: {
      modelId?: string;
      count?: number;
      signal?: AbortSignal;
    } & WebSearchExecuteDeps,
  ): Promise<
    SearchOutcome & { provider: WebSearchProviderKind; usedFallback: boolean }
  >;
  testSearch(
    rawInput: unknown,
    options?: { signal?: AbortSignal } & WebSearchExecuteDeps,
  ): Promise<WebSearchTestResult>;
};

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

function keyHintOf(secret: string | undefined): string {
  const trimmed = secret?.trim() ?? "";
  return trimmed.length >= 8 ? trimmed.slice(-4) : "";
}

/** 校验两个搜索端点是否同源（协议 + 主机 + 端口一致），防跨源密钥泄露。 */
export function sameSearchOrigin(
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

/** 严格校验搜索服务端点 URL：仅允许 http/https，拒绝 userinfo、query 与 hash。 */
export function parseSearchEndpointUrl(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new WebSearchSettingsValidationError(`${label}不能为空。`);
  }
  if (trimmed.length > 300) {
    throw new WebSearchSettingsValidationError(
      `${label}长度不能超过 300 个字符。`,
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebSearchSettingsValidationError(
      `${label}必须是合法的 HTTP(S) URL。`,
    );
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
    throw new WebSearchSettingsValidationError(
      `${label}必须是 HTTP(S) URL，且不能包含用户名密码、查询参数或片段。`,
    );
  }
  return url.href.replace(/\/+$/, "");
}

function effectiveBaseUrlOf(
  provider: WebSearchExternalProviderKind,
  customBaseUrl: string | undefined,
): string {
  const trimmed = customBaseUrl?.trim() ?? "";
  if (trimmed) return trimmed.replace(/\/+$/, "");
  return WEB_SEARCH_PROVIDER_PRESETS[provider].defaultBaseUrl;
}

function normalizeProviderKind(raw: unknown): WebSearchProviderKind {
  return typeof raw === "string" &&
    (WEB_SEARCH_PROVIDER_KINDS as readonly string[]).includes(raw)
    ? (raw as WebSearchProviderKind)
    : "builtin";
}

function normalizeTimeoutMs(raw: unknown): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (
    Number.isFinite(num) &&
    num >= MIN_WEB_SEARCH_TIMEOUT_MS &&
    num <= MAX_WEB_SEARCH_TIMEOUT_MS
  ) {
    return Math.round(num);
  }
  return DEFAULT_WEB_SEARCH_TIMEOUT_MS;
}

function normalizeMaxResults(raw: unknown): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(num) && num >= 1 && num <= 10) {
    return Math.round(num);
  }
  return DEFAULT_WEB_SEARCH_MAX_RESULTS;
}

function parseStoredProviders(raw: unknown): StoredProvidersMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: StoredProvidersMap = {};
  for (const kind of WEB_SEARCH_EXTERNAL_PROVIDERS) {
    const slot = record[kind];
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) continue;
    const obj = slot as Record<string, unknown>;
    out[kind] = {
      ...(typeof obj.baseUrl === "string" ? { baseUrl: obj.baseUrl } : {}),
      ...(typeof obj.encryptedApiKey === "string"
        ? { encryptedApiKey: obj.encryptedApiKey }
        : { encryptedApiKey: null }),
      ...(typeof obj.keyHint === "string" ? { keyHint: obj.keyHint } : {}),
    };
  }
  return out;
}

function parseStoredOverrides(raw: unknown): WebSearchModelOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: WebSearchModelOverride[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const modelId = typeof obj.modelId === "string" ? obj.modelId.trim() : "";
    if (!modelId || modelId.length > 200 || seen.has(modelId.toLowerCase())) {
      continue;
    }
    const mode = obj.mode === "native" ? "native" : "provider";
    const provider =
      mode === "provider" ? normalizeProviderKind(obj.provider) : undefined;
    seen.add(modelId.toLowerCase());
    out.push({
      modelId,
      mode,
      ...(provider ? { provider } : {}),
    });
    if (out.length >= MAX_WEB_SEARCH_OVERRIDES) break;
  }
  return out;
}

const providerSlotInputSchema = z
  .object({
    baseUrl: z.string().trim().max(300, "搜索接口地址过长。").optional(),
    apiKey: z.string().max(4000, "搜索 API 密钥过长。").optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict();

const modelOverrideInputSchema = z
  .object({
    modelId: z
      .string({ error: "模型 ID 必须是字符串。" })
      .trim()
      .min(1, "模型 ID 不能为空。")
      .max(200, "模型 ID 过长。")
      .refine((v) => !/\s/u.test(v), "模型 ID 不能包含空白字符。"),
    mode: z.enum(["provider", "native"], {
      error: "覆写模式仅支持 provider 或 native。",
    }),
    provider: z.enum(WEB_SEARCH_PROVIDER_KINDS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "provider" && !value.provider) {
      ctx.addIssue({
        code: "custom",
        message: "按供应商覆写时必须指定搜索供应商。",
      });
    }
  });

const webSearchSettingsInputSchema = z
  .object({
    defaultProvider: z.enum(WEB_SEARCH_PROVIDER_KINDS, {
      error: "不支持的搜索供应商类型。",
    }),
    fallbackToBuiltin: z.boolean().optional(),
    timeoutMs: z
      .number()
      .finite("超时时间必须是有效数字。")
      .min(
        MIN_WEB_SEARCH_TIMEOUT_MS,
        `超时时间不能低于 ${MIN_WEB_SEARCH_TIMEOUT_MS} 毫秒。`,
      )
      .max(
        MAX_WEB_SEARCH_TIMEOUT_MS,
        `超时时间不能高于 ${MAX_WEB_SEARCH_TIMEOUT_MS} 毫秒。`,
      )
      .optional(),
    maxResults: z
      .number()
      .int("最大结果数必须是整数。")
      .min(1, "最大结果数至少为 1。")
      .max(10, "最大结果数不能超过 10。")
      .optional(),
    providers: z
      .object({
        tavily: providerSlotInputSchema.optional(),
        brave: providerSlotInputSchema.optional(),
        serper: providerSlotInputSchema.optional(),
        bocha: providerSlotInputSchema.optional(),
        exa: providerSlotInputSchema.optional(),
        custom: providerSlotInputSchema.optional(),
      })
      .strict()
      .optional(),
    modelOverrides: z
      .array(modelOverrideInputSchema)
      .max(
        MAX_WEB_SEARCH_OVERRIDES,
        `按模型覆写最多支持 ${MAX_WEB_SEARCH_OVERRIDES} 条。`,
      )
      .optional(),
  })
  .strict();

const webSearchTestInputSchema = z
  .object({
    query: z.string().trim().min(1, "请输入试搜关键词。").max(300).optional(),
    count: z.number().int().min(1).max(10).optional(),
    provider: z.enum(WEB_SEARCH_PROVIDER_KINDS).optional(),
    baseUrl: z.string().trim().max(300).optional(),
    apiKey: z.string().max(4000).optional(),
    fallbackToBuiltin: z.boolean().optional(),
    timeoutMs: z
      .number()
      .finite()
      .min(MIN_WEB_SEARCH_TIMEOUT_MS)
      .max(MAX_WEB_SEARCH_TIMEOUT_MS)
      .optional(),
  })
  .strict();

function sanitizeHit(candidate: {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
}): SearchHit | null {
  const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (!checkPublicUrl(url).ok) return null;
  const title =
    typeof candidate.title === "string"
      ? candidate.title.replace(/\s+/g, " ").trim().slice(0, 300)
      : "";
  const snippet =
    typeof candidate.snippet === "string"
      ? candidate.snippet.replace(/\s+/g, " ").trim().slice(0, 600)
      : "";
  return {
    title: title || url,
    url,
    snippet,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractHitsFromPayload(
  provider: WebSearchExternalProviderKind,
  payload: unknown,
  count: number,
): SearchHit[] {
  const root = asRecord(payload);
  if (!root) return [];

  let rawList: unknown[] = [];
  if (provider === "tavily" || provider === "exa") {
    rawList = Array.isArray(root.results) ? root.results : [];
  } else if (provider === "brave") {
    const web = asRecord(root.web);
    rawList = Array.isArray(web?.results) ? web.results : [];
  } else if (provider === "serper") {
    rawList = Array.isArray(root.organic) ? root.organic : [];
  } else if (provider === "bocha") {
    const data = asRecord(root.data);
    const webPages = asRecord(data?.webPages) ?? asRecord(root.webPages);
    rawList = Array.isArray(webPages?.value)
      ? webPages.value
      : Array.isArray(root.results)
        ? root.results
        : [];
  } else {
    // custom: 兼容常见 JSON 响应结构
    const data = asRecord(root.data);
    const webPages = asRecord(data?.webPages);
    rawList = Array.isArray(root.results)
      ? root.results
      : Array.isArray(root.items)
        ? root.items
        : Array.isArray(root.hits)
          ? root.hits
          : Array.isArray(data?.results)
            ? data.results
            : Array.isArray(webPages?.value)
              ? webPages.value
              : [];
  }

  const hits: SearchHit[] = [];
  for (const item of rawList) {
    const obj = asRecord(item);
    if (!obj) continue;
    const highlights = Array.isArray(obj.highlights)
      ? obj.highlights
          .filter((v): v is string => typeof v === "string")
          .join(" ")
      : undefined;
    const hit = sanitizeHit({
      title: obj.title ?? obj.name,
      url: obj.url ?? obj.link,
      snippet:
        obj.snippet ??
        obj.summary ??
        obj.description ??
        obj.content ??
        obj.text ??
        highlights,
    });
    if (hit) hits.push(hit);
    if (hits.length >= count) break;
  }
  return hits;
}

/** 执行单个外部搜索供应商请求（统一经 guardedFetch 出网，带超时与 1 MiB 响应体上限）。 */
export async function callExternalSearchProvider(params: {
  provider: WebSearchExternalProviderKind;
  baseUrl: string;
  apiKey?: string;
  query: string;
  count: number;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: GuardedFetchOptions["fetchImpl"];
  resolve?: GuardedFetchOptions["resolve"];
  isBlocked?: GuardedFetchOptions["isBlocked"];
}): Promise<SearchHit[]> {
  const { provider, apiKey, query, count, timeoutMs, signal } = params;
  const preset = WEB_SEARCH_PROVIDER_PRESETS[provider];
  const baseUrl = parseSearchEndpointUrl(
    params.baseUrl || preset.defaultBaseUrl,
    `${preset.label} 接口地址`,
  );
  if (preset.requiresApiKey && !apiKey?.trim()) {
    throw new Error(`${preset.label} 尚未配置 API 密钥。`);
  }

  let requestUrl = baseUrl;
  let method: "GET" | "POST" = "POST";
  let body: string | undefined;
  const headers: Record<string, string> = {
    accept: "application/json",
  };

  switch (provider) {
    case "tavily":
      headers["content-type"] = "application/json";
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      body = JSON.stringify({
        query,
        max_results: count,
        search_depth: "basic",
        include_answer: false,
      });
      break;
    case "brave": {
      method = "GET";
      const target = new URL(baseUrl);
      target.searchParams.set("q", query);
      target.searchParams.set("count", String(count));
      requestUrl = target.toString();
      if (apiKey) headers["x-subscription-token"] = apiKey;
      break;
    }
    case "serper":
      headers["content-type"] = "application/json";
      if (apiKey) headers["x-api-key"] = apiKey;
      body = JSON.stringify({ q: query, num: count });
      break;
    case "bocha":
      headers["content-type"] = "application/json";
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      body = JSON.stringify({ query, count, summary: true });
      break;
    case "exa":
      headers["content-type"] = "application/json";
      if (apiKey) headers["x-api-key"] = apiKey;
      body = JSON.stringify({
        query,
        numResults: count,
        contents: { text: { maxCharacters: 400 } },
      });
      break;
    case "custom":
      headers["content-type"] = "application/json";
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      body = JSON.stringify({ query, count });
      break;
  }

  let response: Awaited<ReturnType<typeof guardedFetch>>;
  try {
    response = await guardedFetch(requestUrl, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      maxBytes: MAX_SEARCH_RESPONSE_BYTES,
      timeoutMs,
      maxRedirects: 2,
      ...(signal ? { signal } : {}),
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      ...(params.resolve ? { resolve: params.resolve } : {}),
      ...(params.isBlocked ? { isBlocked: params.isBlocked } : {}),
    });
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      throw new Error(`搜索端点被安全策略拦截：${error.message}`);
    }
    throw error;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${preset.label} 返回异常状态码 HTTP ${response.status}。`);
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(response.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${preset.label} 返回的不是有效的 JSON 响应。`);
  }

  return extractHitsFromPayload(provider, parsed, count);
}

function findModelOverride(
  overrides: readonly WebSearchModelOverride[],
  modelId: string | undefined,
): WebSearchModelOverride | undefined {
  const target = modelId?.trim().toLowerCase();
  if (!target) return undefined;
  const tail = target.split("/").pop() ?? target;
  return (
    overrides.find((entry) => entry.modelId.toLowerCase() === target) ??
    overrides.find((entry) => {
      const candidate = entry.modelId.toLowerCase();
      return (candidate.split("/").pop() ?? candidate) === tail;
    })
  );
}

export function createWebSearchSettingsStore(
  database: WebSearchSettingsDatabase,
  options: {
    encryptionKey: string;
    builtinSearch?: WebSearchExecuteDeps["builtinSearch"];
  },
): WebSearchSettingsStore {
  const sql = database.$client;

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_web_search_settings (
        id text PRIMARY KEY DEFAULT 'default',
        default_provider text NOT NULL DEFAULT 'builtin',
        fallback_to_builtin boolean NOT NULL DEFAULT true,
        timeout_ms integer NOT NULL DEFAULT ${DEFAULT_WEB_SEARCH_TIMEOUT_MS},
        max_results integer NOT NULL DEFAULT ${DEFAULT_WEB_SEARCH_MAX_RESULTS},
        providers_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        model_overrides_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz,
        updated_by text
      );
    `);
  }

  async function readRow(): Promise<WebSearchSettingsRow | null> {
    const rows = await sql.unsafe<WebSearchSettingsRow[]>(
      "SELECT * FROM chisabot_web_search_settings WHERE id = 'default'",
    );
    return rows[0] ?? null;
  }

  function buildView(row: WebSearchSettingsRow | null): WebSearchSettingsView {
    const storedProviders = parseStoredProviders(row?.providers_json);
    const providers = {} as Record<
      WebSearchExternalProviderKind,
      WebSearchProviderSlotView
    >;
    for (const kind of WEB_SEARCH_EXTERNAL_PROVIDERS) {
      const slot = storedProviders[kind];
      const baseUrl = effectiveBaseUrlOf(kind, slot?.baseUrl);
      const hasSavedKey = Boolean(slot?.encryptedApiKey);
      providers[kind] = {
        baseUrl,
        keySource: hasSavedKey ? "saved" : "none",
        keyHint: hasSavedKey ? (slot?.keyHint ?? "") : "",
      };
    }

    return {
      defaultProvider: normalizeProviderKind(row?.default_provider),
      fallbackToBuiltin: row === null ? true : Boolean(row.fallback_to_builtin),
      timeoutMs: normalizeTimeoutMs(row?.timeout_ms),
      maxResults: normalizeMaxResults(row?.max_results),
      providers,
      modelOverrides: parseStoredOverrides(row?.model_overrides_json),
      updatedAt: iso(row?.updated_at),
    };
  }

  async function resolveScopedProviderKey(params: {
    provider: WebSearchExternalProviderKind;
    targetBaseUrl: string;
    explicitApiKey?: string;
    storedProviders: StoredProvidersMap;
  }): Promise<string | undefined> {
    const explicit = params.explicitApiKey?.trim();
    if (explicit) return explicit;

    const slot = params.storedProviders[params.provider];
    if (!slot?.encryptedApiKey) return undefined;
    const savedBaseUrl = effectiveBaseUrlOf(params.provider, slot.baseUrl);
    if (!sameSearchOrigin(params.targetBaseUrl, savedBaseUrl)) {
      return undefined;
    }
    const decrypted = await decryptSecret(
      options.encryptionKey,
      slot.encryptedApiKey,
    );
    return decrypted.trim() || undefined;
  }

  async function view(): Promise<WebSearchSettingsView> {
    return buildView(await readRow());
  }

  async function save(
    actorId: string,
    raw: unknown,
  ): Promise<WebSearchSettingsView> {
    const parsed = webSearchSettingsInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new WebSearchSettingsValidationError(
        parsed.error.issues[0]?.message ?? "联网搜索配置参数无效。",
      );
    }
    const input = parsed.data;
    const prevRow = await readRow();
    const prevProviders = parseStoredProviders(prevRow?.providers_json);
    const nextProviders: StoredProvidersMap = {};

    for (const kind of WEB_SEARCH_EXTERNAL_PROVIDERS) {
      const prevSlot = prevProviders[kind];
      const incoming = input.providers?.[kind];
      const preset = WEB_SEARCH_PROVIDER_PRESETS[kind];
      const prevEffectiveBase = effectiveBaseUrlOf(kind, prevSlot?.baseUrl);

      if (!incoming) {
        if (prevSlot) nextProviders[kind] = prevSlot;
        continue;
      }

      const rawBase = incoming.baseUrl?.trim() ?? "";
      const normalizedBase = rawBase
        ? parseSearchEndpointUrl(rawBase, `${preset.label} 接口地址`)
        : "";
      const nextEffectiveBase = effectiveBaseUrlOf(kind, normalizedBase);

      // 同厂商且同源才允许继承已存密钥；跨源修改地址或 clearApiKey 时绝不沿用旧密钥。
      const canKeepSavedKey =
        Boolean(prevSlot?.encryptedApiKey) &&
        sameSearchOrigin(nextEffectiveBase, prevEffectiveBase);

      let encryptedApiKey: string | null = canKeepSavedKey
        ? (prevSlot?.encryptedApiKey ?? null)
        : null;
      let keyHint = canKeepSavedKey ? (prevSlot?.keyHint ?? "") : "";

      const typedKey = incoming.apiKey?.trim() ?? "";
      if (incoming.clearApiKey) {
        encryptedApiKey = null;
        keyHint = "";
      } else if (typedKey) {
        encryptedApiKey = await encryptSecret(options.encryptionKey, typedKey);
        keyHint = keyHintOf(typedKey);
      }

      nextProviders[kind] = {
        baseUrl: normalizedBase,
        encryptedApiKey,
        keyHint,
      };
    }

    if (input.defaultProvider === "custom") {
      const customBase = nextProviders.custom?.baseUrl?.trim() ?? "";
      if (!customBase) {
        throw new WebSearchSettingsValidationError(
          "启用自定义搜索接口时必须填写接口地址。",
        );
      }
    }

    const dedupedOverrides: WebSearchModelOverride[] = [];
    const seenModels = new Set<string>();
    const rawOverrides =
      input.modelOverrides !== undefined
        ? input.modelOverrides
        : parseStoredOverrides(prevRow?.model_overrides_json);
    for (const item of rawOverrides) {
      const key = item.modelId.toLowerCase();
      if (seenModels.has(key)) {
        throw new WebSearchSettingsValidationError(
          `模型「${item.modelId}」在覆写列表中重复出现。`,
        );
      }
      seenModels.add(key);
      dedupedOverrides.push(
        item.mode === "native"
          ? { modelId: item.modelId, mode: "native" }
          : {
              modelId: item.modelId,
              mode: "provider",
              provider: item.provider ?? "builtin",
            },
      );
    }

    const fallbackToBuiltin =
      input.fallbackToBuiltin ??
      (prevRow ? Boolean(prevRow.fallback_to_builtin) : true);
    const timeoutMs = normalizeTimeoutMs(
      input.timeoutMs ?? prevRow?.timeout_ms,
    );
    const maxResults = normalizeMaxResults(
      input.maxResults ?? prevRow?.max_results,
    );

    await sql.unsafe(
      `INSERT INTO chisabot_web_search_settings (
         id,
         default_provider,
         fallback_to_builtin,
         timeout_ms,
         max_results,
         providers_json,
         model_overrides_json,
         updated_at,
         updated_by
       )
       VALUES ('default', $1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, now(), $7)
       ON CONFLICT (id) DO UPDATE SET
         default_provider = $1,
         fallback_to_builtin = $2,
         timeout_ms = $3,
         max_results = $4,
         providers_json = $5::text::jsonb,
         model_overrides_json = $6::text::jsonb,
         updated_at = now(),
         updated_by = $7`,
      [
        input.defaultProvider,
        fallbackToBuiltin,
        timeoutMs,
        maxResults,
        JSON.stringify(nextProviders),
        JSON.stringify(dedupedOverrides),
        actorId,
      ],
    );

    return view();
  }

  async function resolveForModel(
    modelId?: string,
  ): Promise<ResolvedWebSearchPlan> {
    const row = await readRow();
    const currentView = buildView(row);
    const storedProviders = parseStoredProviders(row?.providers_json);
    const override = findModelOverride(currentView.modelOverrides, modelId);

    if (override?.mode === "native") {
      return { mode: "native" };
    }

    const provider: WebSearchProviderKind =
      override?.mode === "provider" && override.provider
        ? override.provider
        : currentView.defaultProvider;

    if (provider === "builtin") {
      return {
        mode: "provider",
        provider: "builtin",
        baseUrl: "",
        fallbackToBuiltin: currentView.fallbackToBuiltin,
        timeoutMs: currentView.timeoutMs,
        maxResults: currentView.maxResults,
      };
    }

    const slot = storedProviders[provider];
    const baseUrl = effectiveBaseUrlOf(provider, slot?.baseUrl);
    const apiKey = await resolveScopedProviderKey({
      provider,
      targetBaseUrl: baseUrl,
      storedProviders,
    });

    return {
      mode: "provider",
      provider,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      fallbackToBuiltin: currentView.fallbackToBuiltin,
      timeoutMs: currentView.timeoutMs,
      maxResults: currentView.maxResults,
    };
  }

  async function executeSearch(
    query: string,
    execOptions: {
      modelId?: string;
      count?: number;
      signal?: AbortSignal;
    } & WebSearchExecuteDeps = {},
  ): Promise<
    SearchOutcome & { provider: WebSearchProviderKind; usedFallback: boolean }
  > {
    const plan = await resolveForModel(execOptions.modelId);
    const builtin = execOptions.builtinSearch ?? options.builtinSearch;
    const count = Math.max(
      1,
      Math.min(
        execOptions.count ??
          (plan.mode === "provider"
            ? plan.maxResults
            : DEFAULT_WEB_SEARCH_MAX_RESULTS),
        10,
      ),
    );

    if (plan.mode === "native") {
      return {
        hits: [],
        sourceDown: false,
        provider: "builtin",
        usedFallback: false,
      };
    }

    if (plan.provider === "builtin") {
      if (!builtin) {
        return {
          hits: [],
          sourceDown: true,
          provider: "builtin",
          usedFallback: false,
        };
      }
      const outcome = await builtin(
        query,
        count,
        execOptions.signal,
        plan.timeoutMs,
      );
      return { ...outcome, provider: "builtin", usedFallback: false };
    }

    try {
      const hits = await callExternalSearchProvider({
        provider: plan.provider,
        baseUrl: plan.baseUrl,
        apiKey: plan.apiKey,
        query,
        count,
        timeoutMs: plan.timeoutMs,
        signal: execOptions.signal,
        fetchImpl: execOptions.fetchImpl,
        resolve: execOptions.resolve,
        isBlocked: execOptions.isBlocked,
      });
      return {
        hits,
        sourceDown: false,
        provider: plan.provider,
        usedFallback: false,
      };
    } catch (error) {
      if (execOptions.signal?.aborted) throw error;
      if (plan.fallbackToBuiltin && builtin) {
        const fallback = await builtin(
          query,
          count,
          execOptions.signal,
          plan.timeoutMs,
        );
        return {
          ...fallback,
          provider: "builtin",
          usedFallback: true,
        };
      }
      return {
        hits: [],
        sourceDown: true,
        provider: plan.provider,
        usedFallback: false,
      };
    }
  }

  async function testSearch(
    rawInput: unknown,
    execOptions: { signal?: AbortSignal } & WebSearchExecuteDeps = {},
  ): Promise<WebSearchTestResult> {
    const parsed = webSearchTestInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new WebSearchSettingsValidationError(
        parsed.error.issues[0]?.message ?? "试搜参数无效。",
      );
    }
    const input = parsed.data;
    const row = await readRow();
    const currentView = buildView(row);
    const storedProviders = parseStoredProviders(row?.providers_json);

    const provider = input.provider ?? currentView.defaultProvider;
    const query = input.query?.trim() || "ChisaBot";
    const count = input.count ?? currentView.maxResults;
    const timeoutMs = input.timeoutMs ?? currentView.timeoutMs;
    const fallbackToBuiltin =
      input.fallbackToBuiltin ?? currentView.fallbackToBuiltin;
    const builtin = execOptions.builtinSearch ?? options.builtinSearch;
    const startedAt = performance.now();

    if (provider === "builtin") {
      if (!builtin) {
        return {
          ok: false,
          provider: "builtin",
          latencyMs: Math.round(performance.now() - startedAt),
          hits: [],
          message: "内建搜索执行器未就绪。",
        };
      }
      try {
        const outcome = await builtin(
          query,
          count,
          execOptions.signal,
          timeoutMs,
        );
        const latencyMs = Math.round(performance.now() - startedAt);
        if (outcome.sourceDown) {
          return {
            ok: false,
            provider: "builtin",
            latencyMs,
            hits: [],
            message:
              "内建搜索源当前不可用（DuckDuckGo 与 Bing 均未返回结果）。",
          };
        }
        return {
          ok: true,
          provider: "builtin",
          latencyMs,
          hits: outcome.hits,
          message:
            outcome.hits.length > 0
              ? `内建搜索成功，返回 ${outcome.hits.length} 条结果。`
              : "内建搜索连通正常，但该关键词未命中相关结果。",
        };
      } catch (error) {
        return {
          ok: false,
          provider: "builtin",
          latencyMs: Math.round(performance.now() - startedAt),
          hits: [],
          message:
            error instanceof Error ? error.message : "内建搜索请求失败。",
        };
      }
    }

    const preset = WEB_SEARCH_PROVIDER_PRESETS[provider];
    const targetBaseUrl = effectiveBaseUrlOf(
      provider,
      input.baseUrl !== undefined
        ? input.baseUrl
        : storedProviders[provider]?.baseUrl,
    );
    if (!targetBaseUrl) {
      throw new WebSearchSettingsValidationError(
        `测试 ${preset.label} 前必须填写接口地址。`,
      );
    }
    const validatedBaseUrl = parseSearchEndpointUrl(
      targetBaseUrl,
      `${preset.label} 接口地址`,
    );

    const apiKey = await resolveScopedProviderKey({
      provider,
      targetBaseUrl: validatedBaseUrl,
      explicitApiKey: input.apiKey,
      storedProviders,
    });

    try {
      const hits = await callExternalSearchProvider({
        provider,
        baseUrl: validatedBaseUrl,
        apiKey,
        query,
        count,
        timeoutMs,
        signal: execOptions.signal,
        fetchImpl: execOptions.fetchImpl,
        resolve: execOptions.resolve,
        isBlocked: execOptions.isBlocked,
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      return {
        ok: true,
        provider,
        usedFallback: false,
        latencyMs,
        hits,
        message:
          hits.length > 0
            ? `${preset.label} 搜索成功，返回 ${hits.length} 条结果。`
            : `${preset.label} 连通正常，但该关键词未返回结果。`,
      };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "外部搜索请求失败。";
      if (fallbackToBuiltin && builtin && !execOptions.signal?.aborted) {
        try {
          const fallback = await builtin(
            query,
            count,
            execOptions.signal,
            timeoutMs,
          );
          const latencyMs = Math.round(performance.now() - startedAt);
          if (!fallback.sourceDown && fallback.hits.length > 0) {
            return {
              ok: false,
              provider,
              usedFallback: true,
              latencyMs,
              hits: fallback.hits,
              message: `${preset.label} 失败（${reason}），已验证内建回退源可用（返回 ${fallback.hits.length} 条）。`,
            };
          }
        } catch {
          // 回退同样失败时保留原始错误说明。
        }
      }
      return {
        ok: false,
        provider,
        usedFallback: false,
        latencyMs: Math.round(performance.now() - startedAt),
        hits: [],
        message: reason,
      };
    }
  }

  return {
    ensure,
    view,
    save,
    resolveForModel,
    executeSearch,
    testSearch,
  };
}
