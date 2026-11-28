/**
 * 输入框智能第二层：AI 输入建议（CB-145 PR5）。
 *
 * 与第一层（快捷短语 / 高频习惯，纯本地匹配）不同，这一层把用户正在起草的文本发给
 * 部署方自己配置的模型（经场景化路由的 suggestions 场景），请模型给出几条
 * 「用户可能想发送的完整消息」。因为草稿离开了本机，整条链路默认关闭，
 * 由用户在设置 → 输入助手里显式打开（aiEnabled），主开关 enabled 关闭时同样停止。
 *
 * 成本与隐私护栏：
 * - 每人最小调用间隔（默认 1.5s）+ 同 key 在飞去重 + 60s 结果缓存——前端防抖之外的
 *   服务端硬保护，任何客户端 bug 都不会把模型调用变成刷量；
 * - 单次调用 8s 超时即放弃，失败一律回落为空建议（候选条是被动的，绝不打扰输入）；
 * - 缓存只驻留内存、按内容归一化哈希做 key，不写库、不进日志；
 * - 建议文本经过解析清洗：去编号去引号、剔除与草稿相同的句子、限量限长。
 */
import { normalizeComposerText } from "./index";

export const AI_SUGGEST_MAX = 3;
export const AI_SUGGEST_TEXT_MAX = 200;
export const AI_SUGGEST_CACHE_TTL_MS = 60_000;
export const AI_SUGGEST_RATE_LIMIT_MS = 1_500;
export const AI_SUGGEST_TIMEOUT_MS = 8_000;

export type AiSuggestCompleter = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;

/** 组 prompt：单段文本进、纯文本出，与 createModelCompleter 的形状一致。 */
export function buildAiSuggestPrompt(draft: string): string {
  return [
    "用户正在输入框里起草一条要发给 AI 助手的消息。请根据草稿，给出不超过 3 条用户可能想要发送的完整消息（可以是补全，也可以是更自然的改写）。",
    "要求：每条占一行；不要编号、不要项目符号、不要引号、不要解释；与草稿使用同一种语言；每条不超过 200 字；不要重复草稿本身。",
    "",
    "草稿：",
    draft,
  ].join("\n");
}

/** 解析模型输出为干净的去重建议列表；剔除空行、编号、引号与草稿本身。 */
export function parseAiSuggestions(raw: string, draft: string): string[] {
  const draftKey = normalizeComposerText(draft);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const text = line
      .replace(/^\s*(?:[-*•·]|\d{1,2}[.、)]|[（(]?\d{1,2}[）)])\s*/, "")
      .replace(/^["'「『“”]+|["'」』“”]+$/g, "")
      .trim();
    if (!text) continue;
    if ([...text].length > AI_SUGGEST_TEXT_MAX) continue;
    const key = normalizeComposerText(text);
    if (!key || key === draftKey || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= AI_SUGGEST_MAX) break;
  }
  return out;
}

export type AiSuggestResult = {
  suggestions: string[];
  /** true 表示命中缓存，未触发模型调用。 */
  cached: boolean;
};

export function createComposerAiSuggester(options: {
  completer: AiSuggestCompleter;
  now?: () => number;
  cacheTtlMs?: number;
  rateLimitMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
}) {
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? AI_SUGGEST_CACHE_TTL_MS;
  const rateLimitMs = options.rateLimitMs ?? AI_SUGGEST_RATE_LIMIT_MS;
  const timeoutMs = options.timeoutMs ?? AI_SUGGEST_TIMEOUT_MS;
  const maxEntries = options.maxEntries ?? 500;

  const cache = new Map<string, { expires: number; suggestions: string[] }>();
  const inflight = new Map<string, Promise<string[]>>();
  const lastCallAt = new Map<string, number>();

  function pruneCache() {
    if (cache.size <= maxEntries) return;
    const cutoff = now();
    for (const [key, entry] of cache) {
      if (entry.expires <= cutoff) cache.delete(key);
    }
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  async function callModel(key: string, owner: string, draft: string): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const raw = await options.completer(
        buildAiSuggestPrompt(draft),
        controller.signal,
      );
      const suggestions = parseAiSuggestions(raw, draft);
      cache.set(key, { expires: now() + cacheTtlMs, suggestions });
      pruneCache();
      return suggestions;
    } finally {
      clearTimeout(timer);
      lastCallAt.set(owner, now());
      inflight.delete(key);
    }
  }

  /**
   * 取 AI 建议。任何失败（模型报错、超时、限流）都回落为空数组——
   * 候选条是被动增强，永远不值得为一一条建议打断用户输入。
   */
  async function suggest(
    owner: string,
    botId: string,
    draft: string,
  ): Promise<AiSuggestResult> {
    const key = `${owner}${botId}${normalizeComposerText(draft)}`;
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      return { suggestions: hit.suggestions, cached: true };
    }
    const flying = inflight.get(key);
    if (flying) {
      const suggestions = await flying.catch(() => [] as string[]);
      return { suggestions, cached: true };
    }
    const last = lastCallAt.get(owner) ?? 0;
    if (now() - last < rateLimitMs) return { suggestions: [], cached: false };
    const promise = callModel(key, owner, draft).catch(() => [] as string[]);
    inflight.set(key, promise);
    const suggestions = await promise;
    return { suggestions, cached: false };
  }

  return { suggest };
}

export type ComposerAiSuggester = ReturnType<typeof createComposerAiSuggester>;
