import { createHash } from "node:crypto";
import type {
  ModelCatalog,
  ModelCatalogEntry,
} from "../../shared/model-selection";
import { normalizeModelBaseUrl } from "../../shared/model-base-url";
import type { ModelConnectionRuntime } from "./model-settings";

export type ModelCatalogSyncState = {
  /** When the last successful sync finished, if any. */
  fetchedAt?: number;
  count?: number;
  source?: "magpie" | "gateway";
  lastAttemptAt?: number;
  /** The last sync's failure, already a safe Chinese message. Cleared by a success. */
  lastError?: string;
};
export type ModelCatalogService = {
  list(options?: { refresh?: boolean }): Promise<ModelCatalog>;
  /** Forget the cached list so the next read syncs again (e.g. after Magpie changed). */
  invalidate(): void;
  sync(): ModelCatalogSyncState;
  /** Sync now and then every `intervalMs`; returns a stop function. Failures keep the last list. */
  startAutoRefresh(intervalMs: number, initialDelayMs?: number): () => void;
};
export class ModelCatalogError extends Error {
  constructor(message = "模型列表暂时无法获取，请检查模型接口配置后重试。") {
    super(message);
    this.name = "ModelCatalogError";
  }
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 10000;
// The list is also refreshed in the background (startAutoRefresh), so reads rarely wait on it.
const CACHE_MS = 10 * 60_000;
const NON_CHAT = new Set([
  "image",
  "video",
  "embedding",
  "embeddings",
  "audio",
  "tts",
  "transcription",
  "rerank",
  "reranking",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeText(value: unknown, max = 240): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/u.test(value)
  );
}
/** Magpie labels a model "Display Name · Provider Name"; the tail is the provider's own name. */
function providerNameOf(label: unknown): string | undefined {
  if (!safeText(label)) return undefined;
  const at = label.lastIndexOf(" · ");
  const name = at >= 0 ? label.slice(at + 3).trim() : "";
  return name && name.length <= 80 ? name : undefined;
}
/** 目录说这个模型能不能看图：modalities.input / input_modalities / capabilities.vision / supports_vision。 */
export function imageInputOf(row: Record<string, unknown>): boolean | undefined {
  const modal = object(row.modalities) ? row.modalities.input : Array.isArray(row.modalities) ? row.modalities : undefined;
  const input = modal ?? row.input_modalities ?? (object(row.architecture) ? row.architecture.input_modalities : undefined);
  if (Array.isArray(input) && input.length) return input.some((m) => typeof m === "string" && /image|vision/i.test(m));
  const caps = object(row.capabilities) ? row.capabilities : undefined;
  for (const value of [caps?.vision, caps?.image_input, caps?.image, row.supports_vision, row.supports_image_input, row.supports_images]) {
    if (typeof value === "boolean") return value;
  }
  const features = row.features ?? row.supported_features;
  if (Array.isArray(features) && features.length) return features.some((m) => typeof m === "string" && /vision|image|multimodal/i.test(m));
  return undefined;
}
/**
 * 网关不声明 modalities 的模型里，实测能看图的（QA1102-14：ClinePass 的
 * deepseek-v4.1-flash-1017 经 Magpie 路由返回图只能原样上，目录没标就会走文字占位）。
 * 按完整 id 或最后一个 / 段匹配；目录明说 false 也压不过去——已知结论优先。
 */
const KNOWN_VISION_MODELS = new Set(["deepseek-v4.1-flash-1017"]);
/**
 * 目录行三个上下文字段全缺、但官方已知的窗口（QA1104-01：Devin 插件表给 swe-2 系登记
 * context:0，Magpie /models 不带 context_length，Hermes 探测落缺省 32K、卡在 64K 下限外）。
 * 值来自 `devin models` 的官方输出（SWE-2 / SWE-1.7 系均 262K）。按完整 id 或最后一个 /
 * 段匹配；目录明说了就压不过去。
 */
const KNOWN_CONTEXT_WINDOWS = new Map<string, number>([
  ["swe-2", 262_144],
  ["swe-2-medium", 262_144],
  ["swe-2-high", 262_144],
  ["swe-2-max", 262_144],
  ["swe-2-medium-lightning", 262_144],
  ["swe-2-high-lightning", 262_144],
  ["swe-2-max-lightning", 262_144],
  ["swe-1-7", 262_144],
  ["swe-1-7-medium", 262_144],
]);
function knownContextOf(row: Record<string, unknown>): number | undefined {
  const id = typeof row.id === "string" ? row.id : "";
  return knownContextWindowOf(id);
}
/** Resolve the known-window table by model id (exported for resolvers whose catalog
 *  connection is a different gateway than the runtime's — QA1104-01). */
export function knownContextWindowOf(modelId: string): number | undefined {
  return KNOWN_CONTEXT_WINDOWS.get(modelId) ?? KNOWN_CONTEXT_WINDOWS.get(modelId.split("/").pop() ?? "");
}
function visionOf(row: Record<string, unknown>): boolean | undefined {
  const id = typeof row.id === "string" ? row.id : "";
  if (KNOWN_VISION_MODELS.has(id) || KNOWN_VISION_MODELS.has(id.split("/").pop() ?? "")) return true;
  return imageInputOf(row);
}
/** 目录说这个模型能不能收 `file` 文档块：modalities.input / capabilities.file / supports_file_input 等。 */
export function fileInputOf(row: Record<string, unknown>): boolean | undefined {
  const modal = object(row.modalities) ? row.modalities.input : Array.isArray(row.modalities) ? row.modalities : undefined;
  const input = modal ?? row.input_modalities ?? (object(row.architecture) ? row.architecture.input_modalities : undefined);
  if (Array.isArray(input) && input.length) return input.some((m) => typeof m === "string" && /file|document|pdf/i.test(m));
  const caps = object(row.capabilities) ? row.capabilities : undefined;
  for (const value of [caps?.file, caps?.file_input, caps?.document, caps?.pdf, row.supports_files, row.supports_file_input, row.supports_document_input]) {
    if (typeof value === "boolean") return value;
  }
  const features = row.features ?? row.supported_features;
  if (Array.isArray(features) && features.length) return features.some((m) => typeof m === "string" && /file|document|pdf/i.test(m));
  return undefined;
}
/** 目录说这个模型能不能调工具：capabilities.function_calling / tools、supports_function_calling 等。 */
export function toolInputOf(row: Record<string, unknown>): boolean | undefined {
  const caps = object(row.capabilities) ? row.capabilities : undefined;
  for (const value of [
    caps?.function_calling, caps?.tools, caps?.tool_calling,
    row.supports_function_calling, row.supports_tool_choice, row.supports_tools,
  ]) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}
function project(body: unknown): ModelCatalogEntry[] {
  if (
    !object(body) ||
    !Array.isArray(body.data) ||
    body.data.length > MAX_MODELS ||
    body.has_more === true
  )
    throw new ModelCatalogError();
  const seen = new Set<string>();
  const models: ModelCatalogEntry[] = [];
  for (const row of body.data) {
    if (
      !object(row) ||
      !safeText(row.id, 200) ||
      /\s/u.test(row.id) ||
      seen.has(row.id)
    )
      continue;
    if (typeof row.kind === "string" && NON_CHAT.has(row.kind.toLowerCase()))
      continue;
    const output = object(row.modalities) ? row.modalities.output : undefined;
    if (Array.isArray(output) && output.length && !output.includes("text"))
      continue;
    seen.add(row.id);
    const label = safeText(row.display_name)
      ? row.display_name
      : safeText(row.magpie_label)
        ? row.magpie_label
        : row.id;
    const prefix = row.id.includes("/") ? row.id.split("/")[0]! : undefined;
    const provider =
      prefix ?? (safeText(row.owned_by, 200) ? row.owned_by : "");
    const context =
      row.context_window ?? row.context_length ?? row.max_input_tokens ?? knownContextOf(row);
    const providerName = providerNameOf(row.magpie_label);
    const maxOutput = row.max_output_tokens ?? row.max_completion_tokens;
    const supportsImages = visionOf(row);
    const supportsFiles = fileInputOf(row);
    const supportsTools = toolInputOf(row);
    models.push({
      id: row.id,
      label,
      provider,
      ...(providerName ? { providerName } : {}),
      ...(typeof context === "number" &&
      Number.isInteger(context) &&
      context > 0 &&
      context <= 1e9
        ? { contextWindow: context }
        : {}),
      ...(typeof maxOutput === "number" &&
      Number.isInteger(maxOutput) &&
      maxOutput > 0 &&
      maxOutput <= 1e8
        ? { maxOutputTokens: maxOutput }
        : {}),
      ...(supportsImages === undefined ? {} : { supportsImages }),
      ...(supportsFiles === undefined ? {} : { supportsFiles }),
      ...(supportsTools === undefined ? {} : { supportsTools }),
    });
  }
  return models;
}

async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new ModelCatalogError();
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new ModelCatalogError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      // Bound body reads as well as opening the connection.
      const chunk = await new Promise<Awaited<ReturnType<typeof reader.read>>>(
        (resolve, reject) => {
          const abort = () =>
            reject(new ModelCatalogError("模型列表请求超时，请稍后重试。"));
          if (signal.aborted) return abort();
          signal.addEventListener("abort", abort, { once: true });
          reader
            .read()
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        },
      );
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw new ModelCatalogError();
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Query only the saved private gateway; callers never supply a URL or credentials. */
export function createModelCatalogService(options: {
  resolveConnection: () => Promise<ModelConnectionRuntime>;
  fetch?: typeof fetch;
}): ModelCatalogService {
  const request = options.fetch ?? fetch;
  type Cache = {
    key: string;
    value?: ModelCatalog;
    pending?: Promise<ModelCatalog>;
    expired?: boolean;
  };
  let current: Cache | undefined;
  const state: ModelCatalogSyncState = {};
  const service: ModelCatalogService = {
    invalidate() {
      if (current) current.expired = true;
    },
    sync() {
      return { ...state };
    },
    startAutoRefresh(intervalMs, initialDelayMs = 3000) {
      const tick = () => {
        void service.list({ refresh: true }).catch(() => {});
      };
      const first = setTimeout(tick, initialDelayMs);
      const every = setInterval(tick, Math.max(60_000, intervalMs));
      first.unref?.();
      every.unref?.();
      return () => {
        clearTimeout(first);
        clearInterval(every);
      };
    },
    async list(input = {}) {
      let stale: ModelCatalog | undefined;
      try {
        const connection = await options.resolveConnection();
        if (connection.useApiKey && !connection.apiKey)
          throw new ModelCatalogError(
            "模型密钥尚未配置，请先在管理中保存模型接口。",
          );
        const address = new URL(connection.baseUrl);
        if (
          !["http:", "https:"].includes(address.protocol) ||
          address.username ||
          address.password ||
          address.search ||
          address.hash
        )
          throw new ModelCatalogError();
        const baseUrl = normalizeModelBaseUrl(
          connection.provider,
          connection.baseUrl,
        );
        // Do not store credentials in cache keys or public projections. Changing either isolates requests.
        const key = createHash("sha256")
          .update(
            JSON.stringify([
              connection.provider,
              baseUrl,
              connection.useApiKey,
              connection.apiKey,
            ]),
          )
          .digest("hex");
        if (current?.key !== key) current = { key };
        const cache = current;
        stale = cache.value;
        if (
          !input.refresh &&
          !cache.expired &&
          cache.value &&
          Date.now() - cache.value.fetchedAt < CACHE_MS
        )
          return structuredClone(cache.value);
        if (!cache.pending) {
          state.lastAttemptAt = Date.now();
          cache.pending = (async () => {
            const headers: Record<string, string> = {
              Accept: "application/json",
            };
            if (connection.useApiKey && connection.apiKey) {
              if (connection.provider === "anthropic") {
                headers["x-api-key"] = connection.apiKey;
                headers["anthropic-version"] = "2023-06-01";
              } else headers.Authorization = `Bearer ${connection.apiKey}`;
            }
            const signal = AbortSignal.timeout(15000);
            const response = await request(`${baseUrl}/models`, {
              method: "GET",
              headers,
              redirect: "error",
              signal,
            });
            if (!response.ok) {
              await response.body?.cancel().catch(() => {});
              throw new ModelCatalogError(
                response.status === 401 || response.status === 403
                  ? "模型列表访问被拒绝，请检查网关密钥及模型权限。"
                  : undefined,
              );
            }
            const body = await readJson(response, signal);
            const models = project(body);
            const value: ModelCatalog = {
              models,
              fetchedAt: Date.now(),
              source: isMagpie(body) ? "magpie" : "gateway",
            };
            cache.value = value;
            cache.expired = false;
            state.fetchedAt = value.fetchedAt;
            state.count = models.length;
            state.source = value.source;
            state.lastError = undefined;
            return value;
          })().finally(() => {
            cache.pending = undefined;
          });
        }
        return structuredClone(await cache.pending);
      } catch (error) {
        // Fetch, parsing and storage exceptions can contain keys or arbitrary upstream prose.
        const safe =
          error instanceof ModelCatalogError ? error : new ModelCatalogError();
        state.lastError = safe.message;
        // A passive read keeps working on the last good list while the gateway is down; an
        // explicit 刷新 reports the failure so its button lands on ✕.
        if (!input.refresh && stale?.models.length)
          return { ...structuredClone(stale), stale: true };
        throw safe;
      }
    },
  };
  return service;
}

function isMagpie(body: unknown) {
  return (
    object(body) &&
    Array.isArray(body.data) &&
    body.data.some((row) => object(row) && typeof row.magpie_label === "string")
  );
}
