/**
 * 输入框智能第二层：AI 输入建议（CB-145 PR5）。
 *
 * 机器人回复完成后，预判用户下一步可能发送的消息，提前给出 2–4 条候选。
 * 与第一层（快捷短语 / 高频习惯，纯本地匹配）不同，这一层把对话上下文发给
 * 部署方自己配置的模型（经场景化路由的 suggestions 场景）。上下文与聊天本身
 * 走的是同一个部署模型——但因为是额外的模型调用，整条链路默认关闭，
 * 由用户在设置 → 输入助手里显式打开（aiEnabled），主开关 enabled 关闭时同样停止。
 *
 * 上下文由客户端随请求带来（浏览器本来就有最近消息），服务端无状态、
 * 不回读会话库：每条消息截断、总量封顶，任何东西都不写库、不进日志。
 *
 * 成本护栏：
 * - 每人最小调用间隔（默认 1.5s）+ 同 key 在飞去重 + 60s 结果缓存——前端防抖之外的
 *   服务端硬保护，任何客户端 bug 都不会把模型调用变成刷量；
 * - 单次调用 8s 超时即放弃，失败一律回落为空建议（候选条是被动的，绝不打扰输入）；
 * - 缓存只驻留内存、按上下文归一化哈希做 key；
 * - 建议文本经过解析清洗：去编号去引号、限量限长。
 */

export const AI_SUGGEST_MAX = 4;
export const AI_SUGGEST_TEXT_MAX = 200;
export const AI_SUGGEST_CACHE_TTL_MS = 60_000;
export const AI_SUGGEST_RATE_LIMIT_MS = 1_500;
export const AI_SUGGEST_TIMEOUT_MS = 8_000;
export const AI_SUGGEST_CONTEXT_MAX_MESSAGES = 6;
export const AI_SUGGEST_CONTEXT_MESSAGE_MAX = 500;

export type AiSuggestContextMessage = {
  role: "user" | "bot";
  text: string;
};

export type AiSuggestCompleter = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;

function normalizeKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 清洗客户端带来的上下文：角色闭集、逐条截断、总量封顶、空文本剔除。 */
export function cleanAiSuggestContext(
  input: unknown,
): AiSuggestContextMessage[] {
  if (!Array.isArray(input)) return [];
  const out: AiSuggestContextMessage[] = [];
  for (const item of input.slice(-AI_SUGGEST_CONTEXT_MAX_MESSAGES)) {
    if (!item || typeof item !== "object") continue;
    const role = (item as Record<string, unknown>).role;
    const text = (item as Record<string, unknown>).text;
    if (role !== "user" && role !== "bot") continue;
    if (typeof text !== "string" || !text.trim()) continue;
    out.push({
      role,
      text: text.trim().slice(0, AI_SUGGEST_CONTEXT_MESSAGE_MAX),
    });
  }
  return out;
}

/** 组 prompt：单段文本进、纯文本出，与 createModelCompleter 的形状一致。 */
export function buildAiSuggestPrompt(
  context: readonly AiSuggestContextMessage[],
): string {
  const transcript = context
    .map(
      (message) =>
        `${message.role === "user" ? "用户" : "助手"}：${message.text}`,
    )
    .join("\n");
  return [
    "下面是一段用户与 AI 助手的最近对话。请预判用户接下来最可能发送的消息，给出 2 到 4 条候选。",
    "要求：每条占一行；不要编号、不要项目符号、不要引号、不要解释；使用与用户相同的语言；每条不超过 200 字；是用户会说的话，不是助手的回答。",
    "",
    "对话：",
    transcript,
  ].join("\n");
}

/** 解析模型输出为干净的去重建议列表；剔除空行、编号与引号。 */
export function parseAiSuggestions(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const text = line
      .replace(/^\s*(?:[-*•·]|\d{1,2}[.、)]|[（(]?\d{1,2}[）)])\s*/, "")
      .replace(/^["'「『“”]+|["'」』“”]+$/g, "")
      .trim();
    if (!text) continue;
    if ([...text].length > AI_SUGGEST_TEXT_MAX) continue;
    const key = normalizeKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= AI_SUGGEST_MAX) break;
  }
  return out;
}

export type AiSuggestResult = {
  suggestions: string[];
  /** true 表示命中缓存或在飞去重，未触发新的模型调用。 */
  cached: boolean;
};

export function createComposerAiSuggester(options: {
  completer: AiSuggestCompleter;
  now?: () => number;
  cacheTtlMs?: number;
  rateLimitMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
  /** 自定义 prompt 组装（默认：下一步建议）；行内补全等变体注入自己的。 */
  promptFor?: (context: readonly AiSuggestContextMessage[]) => string;
  /** 自定义输出解析（默认：多行建议列表）。 */
  parseOutput?: (
    raw: string,
    context: readonly AiSuggestContextMessage[],
  ) => string[];
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

  async function callModel(
    key: string,
    owner: string,
    context: readonly AiSuggestContextMessage[],
  ): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const raw = await options.completer(
        (options.promptFor ?? buildAiSuggestPrompt)(context),
        controller.signal,
      );
      const suggestions = (
        options.parseOutput ?? ((r: string) => parseAiSuggestions(r))
      )(raw, context);
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
   * 候选条是被动增强，永远不值得为一条建议打断用户输入。
   */
  async function suggest(
    owner: string,
    botId: string,
    context: readonly AiSuggestContextMessage[],
  ): Promise<AiSuggestResult> {
    const tail = context
      .map(
        (message) =>
          `${message.role}:${normalizeKey(message.text).slice(0, 80)}`,
      )
      .join("|");
    const key = `${owner}${botId}${tail}`;
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
    const promise = callModel(key, owner, context).catch(() => [] as string[]);
    inflight.set(key, promise);
    const suggestions = await promise;
    return { suggestions, cached: false };
  }

  return { suggest };
}

export type ComposerAiSuggester = ReturnType<typeof createComposerAiSuggester>;
