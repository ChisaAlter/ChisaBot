/**
 * 可插拔多供应商联网搜索与按模型覆写配置（前后端共用契约）。
 */

export const WEB_SEARCH_PROVIDER_KINDS = [
  "builtin",
  "tavily",
  "brave",
  "serper",
  "bocha",
  "exa",
  "custom",
] as const;

export type WebSearchProviderKind = (typeof WEB_SEARCH_PROVIDER_KINDS)[number];

export const WEB_SEARCH_EXTERNAL_PROVIDERS = [
  "tavily",
  "brave",
  "serper",
  "bocha",
  "exa",
  "custom",
] as const;

export type WebSearchExternalProviderKind =
  (typeof WEB_SEARCH_EXTERNAL_PROVIDERS)[number];

export type WebSearchKeySource = "saved" | "none";

export type WebSearchOverrideMode = "provider" | "native";

export type WebSearchModelOverride = {
  /** 模型 ID（与模型目录一致，可按完整 ID 或末段匹配）。 */
  modelId: string;
  /**
   * - `provider`: 强制该模型使用指定搜索供应商；
   * - `native`: 关闭内置 `web_search` 工具，改走模型原生联网搜索能力。
   */
  mode: WebSearchOverrideMode;
  /** 当 `mode === "provider"` 时生效的供应商。 */
  provider?: WebSearchProviderKind;
};

export type WebSearchProviderSlotView = {
  baseUrl: string;
  keySource: WebSearchKeySource;
  keyHint: string;
};

export type WebSearchProviderSlotInput = {
  baseUrl?: string;
  /** 留空或不传在同厂商同源下保留已存密钥；跨源修改端点时绝不沿用旧密钥。 */
  apiKey?: string;
  clearApiKey?: boolean;
};

export type WebSearchSettingsView = {
  defaultProvider: WebSearchProviderKind;
  fallbackToBuiltin: boolean;
  timeoutMs: number;
  maxResults: number;
  providers: Record<WebSearchExternalProviderKind, WebSearchProviderSlotView>;
  modelOverrides: WebSearchModelOverride[];
  updatedAt: string | null;
};

export type WebSearchSettingsInput = {
  defaultProvider: WebSearchProviderKind;
  fallbackToBuiltin?: boolean;
  timeoutMs?: number;
  maxResults?: number;
  providers?: Partial<
    Record<WebSearchExternalProviderKind, WebSearchProviderSlotInput>
  >;
  modelOverrides?: WebSearchModelOverride[];
};

export type WebSearchTestHit = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchTestResult = {
  ok: boolean;
  provider: WebSearchProviderKind;
  usedFallback?: boolean;
  latencyMs: number;
  hits: WebSearchTestHit[];
  message: string;
};

export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 12_000;
export const MIN_WEB_SEARCH_TIMEOUT_MS = 3_000;
export const MAX_WEB_SEARCH_TIMEOUT_MS = 30_000;
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 6;
export const MAX_WEB_SEARCH_OVERRIDES = 100;

export type WebSearchProviderPreset = {
  kind: WebSearchProviderKind;
  label: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  note: string;
};

export const WEB_SEARCH_PROVIDER_PRESETS: Readonly<
  Record<WebSearchProviderKind, WebSearchProviderPreset>
> = {
  builtin: {
    kind: "builtin",
    label: "内建免费源（DuckDuckGo / Bing）",
    defaultBaseUrl: "",
    requiresApiKey: false,
    note: "零密钥开箱即用，优先 DuckDuckGo HTML，被拦或无结果时自动回退 Bing 相关性过滤。",
  },
  tavily: {
    kind: "tavily",
    label: "Tavily Search",
    defaultBaseUrl: "https://api.tavily.com/search",
    requiresApiKey: true,
    note: "专为 AI Agent 优化的高质量摘要检索，需配置 Tavily API Key（tvly-...）。",
  },
  brave: {
    kind: "brave",
    label: "Brave Search",
    defaultBaseUrl: "https://api.search.brave.com/res/v1/web/search",
    requiresApiKey: true,
    note: "独立索引、低延迟英文与多语种网页检索，使用 X-Subscription-Token 鉴权。",
  },
  serper: {
    kind: "serper",
    label: "Serper（Google 搜索）",
    defaultBaseUrl: "https://google.serper.dev/search",
    requiresApiKey: true,
    note: "返回 Google 实时搜索结果，适合时效性新闻与英文技术检索。",
  },
  bocha: {
    kind: "bocha",
    label: "博查 AI 搜索（Bocha）",
    defaultBaseUrl: "https://api.bochaai.com/v1/web-search",
    requiresApiKey: true,
    note: "针对中文网页、国内资讯与电商/生活信息优化的 AI 搜索引擎。",
  },
  exa: {
    kind: "exa",
    label: "Exa Search",
    defaultBaseUrl: "https://api.exa.ai/search",
    requiresApiKey: true,
    note: "支持语义神经检索与正文抽取，适合学术、代码仓库与深度资料调研。",
  },
  custom: {
    kind: "custom",
    label: "自定义搜索接口（JSON POST）",
    defaultBaseUrl: "",
    requiresApiKey: false,
    note: "向自定义公网 HTTPS 接口发送 { query, count } JSON POST，兼容 results / items / hits 数组响应。",
  },
};

export function isWebSearchProviderKind(
  value: unknown,
): value is WebSearchProviderKind {
  return (
    typeof value === "string" &&
    (WEB_SEARCH_PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

export function isExternalWebSearchProvider(
  value: WebSearchProviderKind,
): value is WebSearchExternalProviderKind {
  return value !== "builtin";
}
