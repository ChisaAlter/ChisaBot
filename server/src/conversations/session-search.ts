import { z } from "zod";
import { clipTitle } from "../bot-threads";
import type { Database } from "../db/client";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";

/**
 * 跨会话历史检索工具（`session_search`）。
 *
 * 允许机器人按关键词检索当前用户名下的其他主会话（`chisabot_local_threads`），
 * 严格按 `owner_user_id` 隔离并排除后台任务（`worker-*`）、侧边问答（`thread_kind = 'side'`）
 * 与当前正在进行的会话，避免把内部运行态或超长原始历史倾倒进上下文。
 */

const MAX_THREADS_SCANNED = 200;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const MAX_EXCERPT_CHARS = 280;
const MAX_MESSAGE_SEGMENTS_PER_THREAD = 400;

const DATA_URI_BASE64_PATTERN =
  /data:[a-zA-Z0-9/+.-]+;base64,[A-Za-z0-9+/=]{16,}/gi;
const LONG_BASE64_BLOB_PATTERN =
  /(?<![A-Za-z0-9_/-])[A-Za-z0-9+/]{128,}={0,2}(?![A-Za-z0-9_/-])/g;
const INTERNAL_MARKER_PATTERN = /⟦chisabot:[^⟧\n]+⟧[^\n]*/g;
const CJK_CHAR_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_WORD_PATTERN = /[a-z0-9][a-z0-9._@+-]*/g;

export type SessionSearchOptions = {
  database: Database;
  ownerUserId: string;
  currentThreadId?: string;
};

export type SessionThreadRow = {
  id: string;
  owner_user_id?: string;
  name: string | null;
  messages: unknown;
  thread_kind?: string | null;
  updated_at: Date | string;
};

export type SessionSearchHit = {
  threadId: string;
  title: string;
  updatedAt: string;
  matchedExcerpt: string;
};

type MessageSegment = {
  speaker: "用户" | "助手" | "记录";
  text: string;
};

type QueryTokens = {
  phrase: string;
  terms: string[];
  bigrams: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeForMatch(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/** 剥离 base64 数据 URI、长编码串与内部工具结果标记，只保留可读对话文本。 */
export function scrubSessionText(raw: string): string {
  return raw
    .replace(DATA_URI_BASE64_PATTERN, " ")
    .replace(LONG_BASE64_BLOB_PATTERN, " ")
    .replace(INTERNAL_MARKER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return scrubSessionText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      const cleaned = scrubSessionText(part);
      if (cleaned) parts.push(cleaned);
      continue;
    }
    if (!isRecord(part)) continue;
    // 只取文本段，跳过图片、二进制与内部附件元数据对象。
    if (
      part.type !== undefined &&
      part.type !== "text" &&
      part.type !== "input_text"
    ) {
      continue;
    }
    if (typeof part.text === "string") {
      const cleaned = scrubSessionText(part.text);
      if (cleaned) parts.push(cleaned);
    }
  }
  return parts.join(" ").trim();
}

function parseMessagesArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractSegments(rawMessages: unknown): {
  titleFallback: string;
  segments: MessageSegment[];
} {
  const entries = parseMessagesArray(rawMessages);
  const segments: MessageSegment[] = [];
  let titleFallback = "";
  const startIndex = Math.max(
    0,
    entries.length - MAX_MESSAGE_SEGMENTS_PER_THREAD,
  );

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    const role = typeof entry.role === "string" ? entry.role : "";
    if (role === "system" || role === "developer") continue;
    const text = extractMessageText(entry.content);
    if (!text) continue;
    if (!titleFallback && role === "user") {
      titleFallback = clipTitle(text);
    }
    if (index < startIndex) continue;
    const speaker: MessageSegment["speaker"] =
      role === "user" ? "用户" : role === "assistant" ? "助手" : "记录";
    segments.push({ speaker, text });
  }

  return { titleFallback, segments };
}

/** 构造兼容中英文的检索词：保留英文整词、连续中文词串及其双字切片。 */
export function tokenizeSearchQuery(query: string): QueryTokens {
  const phrase = normalizeForMatch(query);
  if (!phrase) return { phrase: "", terms: [], bigrams: [] };

  const termSet = new Set<string>();
  const bigramSet = new Set<string>();

  for (const word of phrase.match(LATIN_WORD_PATTERN) ?? []) {
    if (word.length >= 2 || !CJK_CHAR_PATTERN.test(phrase)) {
      termSet.add(word);
    }
  }

  for (const run of phrase.match(CJK_RUN_PATTERN) ?? []) {
    termSet.add(run);
    if (run.length === 1) {
      bigramSet.add(run);
    } else {
      for (let i = 0; i + 1 < run.length; i += 1) {
        bigramSet.add(run.slice(i, i + 2));
      }
    }
  }

  if (termSet.size === 0 && bigramSet.size === 0) {
    termSet.add(phrase);
  }

  return {
    phrase,
    terms: [...termSet],
    bigrams: [...bigramSet],
  };
}

function scoreText(text: string, tokens: QueryTokens): number {
  const hay = normalizeForMatch(text);
  if (!hay || !tokens.phrase) return 0;

  let total = 0;
  if (hay.includes(tokens.phrase)) {
    total += 10;
  }

  let matchedTerms = 0;
  for (const term of tokens.terms) {
    if (hay.includes(term)) {
      matchedTerms += 1;
    }
  }
  if (tokens.terms.length > 0 && matchedTerms > 0) {
    total += (matchedTerms / tokens.terms.length) * 6;
  }

  let matchedBigrams = 0;
  for (const bg of tokens.bigrams) {
    if (hay.includes(bg)) {
      matchedBigrams += 1;
    }
  }
  if (tokens.bigrams.length > 0 && matchedBigrams > 0) {
    const ratio = matchedBigrams / tokens.bigrams.length;
    // 只有双字重合达到一定比例或已命中完整词串时才计分，降低长会话里的偶发误匹配。
    if (ratio >= 0.4 || matchedTerms > 0) {
      total += ratio * 3;
    }
  }

  return total;
}

function clipAroundMatch(
  text: string,
  tokens: QueryTokens,
  maxChars = MAX_EXCERPT_CHARS,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const lower = trimmed.toLocaleLowerCase();
  const candidates = [tokens.phrase, ...tokens.terms, ...tokens.bigrams].filter(
    (item) => item.length > 0,
  );
  let matchAt = -1;
  for (const needle of candidates) {
    const idx = lower.indexOf(needle);
    if (idx >= 0) {
      matchAt = idx;
      break;
    }
  }

  if (matchAt < 0) {
    return `${sliceSafe(trimmed, 0, maxChars - 1)}…`;
  }

  const headRoom = Math.min(80, Math.floor(maxChars / 3));
  let start = Math.max(0, matchAt - headRoom);
  let end = Math.min(trimmed.length, start + maxChars);
  if (end === trimmed.length) {
    start = Math.max(0, end - maxChars);
  }
  if (start > 0 && isLowSurrogate(trimmed.charCodeAt(start))) {
    start += 1;
  }
  if (end < trimmed.length && isHighSurrogate(trimmed.charCodeAt(end - 1))) {
    end -= 1;
  }

  const body = trimmed.slice(start, end).trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < trimmed.length ? "…" : "";
  return `${prefix}${body}${suffix}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function sliceSafe(text: string, start: number, end: number): string {
  let safeEnd = Math.min(text.length, end);
  if (safeEnd > start && isHighSurrogate(text.charCodeAt(safeEnd - 1))) {
    safeEnd -= 1;
  }
  return text.slice(start, safeEnd);
}

/** 纯检索与排序逻辑，便于单测直接验证分词、打分、片段截取与隔离保护。 */
export function rankSessionRows(
  rows: readonly SessionThreadRow[],
  options: {
    ownerUserId: string;
    currentThreadId?: string;
    query: string;
    limit?: number;
  },
): SessionSearchHit[] {
  const tokens = tokenizeSearchQuery(options.query);
  if (!tokens.phrase) return [];
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT), 1),
    MAX_SEARCH_LIMIT,
  );

  const scored: { hit: SessionSearchHit; score: number; updatedMs: number }[] =
    [];

  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    // 二次防线：即便上层查询返回了非主会话或跨用户行，也在这里强制剔除。
    if (
      row.owner_user_id !== undefined &&
      row.owner_user_id !== options.ownerUserId
    ) {
      continue;
    }
    if (
      row.thread_kind !== undefined &&
      row.thread_kind !== null &&
      row.thread_kind !== "primary"
    ) {
      continue;
    }
    if (row.id.startsWith("worker-")) continue;
    if (options.currentThreadId && row.id === options.currentThreadId) continue;

    const { titleFallback, segments } = extractSegments(row.messages);
    const title = clipTitle(row.name) || titleFallback || "（没有文字的对话）";
    const titleScore = scoreText(title, tokens) * 1.4;

    let bestSegmentScore = 0;
    let bodyScoreSum = 0;
    const matchedSegments: {
      seg: MessageSegment;
      score: number;
      index: number;
    }[] = [];

    for (let idx = 0; idx < segments.length; idx += 1) {
      const seg = segments[idx];
      if (!seg) continue;
      const segScore = scoreText(seg.text, tokens);
      if (segScore > 0) {
        bodyScoreSum += segScore * 0.25;
        matchedSegments.push({ seg, score: segScore, index: idx });
        if (segScore > bestSegmentScore) {
          bestSegmentScore = segScore;
        }
      }
    }

    const combinedScore =
      titleScore + bestSegmentScore + Math.min(bodyScoreSum, 4);
    if (combinedScore <= 0) continue;

    matchedSegments.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.index - b.index,
    );
    const topTwo = matchedSegments.slice(0, 2);
    const perSnippetBudget =
      topTwo.length > 1
        ? Math.floor((MAX_EXCERPT_CHARS - 16) / 2)
        : MAX_EXCERPT_CHARS;
    const matchedExcerpt =
      topTwo.length > 0
        ? topTwo
            .map(
              (entry) =>
                `${entry.seg.speaker}: ${clipAroundMatch(entry.seg.text, tokens, perSnippetBudget)}`,
            )
            .join(" | ")
        : segments[0]
          ? `${segments[0].speaker}: ${clipAroundMatch(segments[0].text, tokens)}`
          : `标题命中：${title}`;
    const updatedDate = new Date(row.updated_at);
    const updatedMs = Number.isFinite(updatedDate.getTime())
      ? updatedDate.getTime()
      : 0;

    scored.push({
      score: combinedScore,
      updatedMs,
      hit: {
        threadId: row.id,
        title,
        updatedAt: Number.isFinite(updatedDate.getTime())
          ? updatedDate.toISOString()
          : new Date(0).toISOString(),
        matchedExcerpt,
      },
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.updatedMs - a.updatedMs;
  });

  return scored.slice(0, limit).map((entry) => entry.hit);
}

const searchParameters = z
  .object({
    query: z
      .string()
      .trim()
      .min(1, "请提供要检索的关键词。")
      .max(300)
      .describe("要检索的关键词或短语（支持中文与英文）"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("最多返回条数，默认 5，上限 20"),
  })
  .strict();

function isMissingThreadTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "42P01") return true;
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: unknown }).message ?? "");
  return /chisabot_local_threads.*does not exist|no such table/i.test(message);
}

/** 创建跨会话检索工具（按 ownerUserId 严格隔离，仅检索主会话）。 */
export function createSessionSearchTools({
  database,
  ownerUserId,
  currentThreadId,
}: SessionSearchOptions): GrantedTool[] {
  const sql = database.$client;

  return [
    {
      name: "session_search",
      ref: "conversations/session_search",
      effect: "read",
      description:
        "跨会话历史检索：按关键词搜索当前用户名下的其他主对话（不含后台任务与侧边问答），返回会话 threadId、标题、更新时间与命中摘要片段。当用户提到以前在别的对话里讨论过的事情、决定或上下文时使用；只返回摘要片段，不会一次性倾倒整段历史。",
      parameters: searchParameters,
      async execute(args) {
        const cleanOwner = ownerUserId.trim();
        if (!cleanOwner) {
          return `${REFUSAL_MARKER} session_search 缺少有效用户信息。`;
        }
        const parsed = searchParameters.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} session_search 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        }

        const limit = Math.min(
          Math.max(parsed.data.limit ?? DEFAULT_SEARCH_LIMIT, 1),
          MAX_SEARCH_LIMIT,
        );
        const cleanCurrent = currentThreadId?.trim() || null;

        let rows: SessionThreadRow[];
        try {
          rows = cleanCurrent
            ? await sql.unsafe<SessionThreadRow[]>(
                `SELECT id, owner_user_id, name, messages, thread_kind, updated_at
                 FROM chisabot_local_threads
                 WHERE owner_user_id = $1
                   AND COALESCE(thread_kind, 'primary') = 'primary'
                   AND id NOT LIKE 'worker-%'
                   AND id <> $2
                 ORDER BY updated_at DESC
                 LIMIT ${MAX_THREADS_SCANNED}`,
                [cleanOwner, cleanCurrent],
              )
            : await sql.unsafe<SessionThreadRow[]>(
                `SELECT id, owner_user_id, name, messages, thread_kind, updated_at
                 FROM chisabot_local_threads
                 WHERE owner_user_id = $1
                   AND COALESCE(thread_kind, 'primary') = 'primary'
                   AND id NOT LIKE 'worker-%'
                 ORDER BY updated_at DESC
                 LIMIT ${MAX_THREADS_SCANNED}`,
                [cleanOwner],
              );
        } catch (error) {
          if (isMissingThreadTableError(error)) {
            return JSON.stringify(
              {
                total: 0,
                results: [],
                message: "当前没有可检索的过往会话。",
              },
              null,
              2,
            );
          }
          throw error;
        }

        const results = rankSessionRows(rows, {
          ownerUserId: cleanOwner,
          ...(cleanCurrent ? { currentThreadId: cleanCurrent } : {}),
          query: parsed.data.query,
          limit,
        });

        if (results.length === 0) {
          return JSON.stringify(
            {
              total: 0,
              results: [],
              message: "没有找到匹配的过往会话。",
            },
            null,
            2,
          );
        }

        return JSON.stringify(
          {
            total: results.length,
            results,
          },
          null,
          2,
        );
      },
    },
  ];
}
