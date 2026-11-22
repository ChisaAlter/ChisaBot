import {
  canReadMemoryNote,
  type MemoryKind,
  type MemoryViewer,
  type MemoryVisibility,
  type MemoryVisibilityNote,
  resolveMemoryVisibility,
} from "../../../shared/memory-notes";

/**
 * 记忆检索打分（DESIGN.md §50）。中文没有空格，按词切不动，所以用「整句包含 + 双字重合 + 英文词重合」打分：
 * 不需要向量模型，也不依赖数据库扩展；一个人最多几千条，在内存里算足够快。
 */
export type Scorable = {
  subject: string | null;
  content: string;
  context: string | null;
};

export type SearchableMemoryRow = Scorable & {
  id: string;
  owner_user_id: string;
  kind: MemoryKind;
  agent_id: string | null;
  visibility?: MemoryVisibility | null;
  shared?: boolean | null;
};

/** 将存储行转换为可见性判定的标准领域结构。 */
export function toVisibilityNote(
  row: Pick<
    SearchableMemoryRow,
    "owner_user_id" | "agent_id" | "visibility" | "shared"
  >,
): MemoryVisibilityNote {
  return {
    ownerUserId: row.owner_user_id,
    agentId: row.agent_id,
    visibility: resolveMemoryVisibility(row),
    shared: Boolean(row.shared),
  };
}

/** 按四级可见性规则过滤可读记忆，所有读/搜入口统一复用。 */
export function filterReadableMemoryNotes<T extends SearchableMemoryRow>(
  rows: readonly T[],
  viewer: MemoryViewer,
): T[] {
  return rows.filter((row) => canReadMemoryNote(toVisibilityNote(row), viewer));
}

const compareCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 按 `(kind, id)` 确定性字典序比较，保证前缀与平局排序在轮次间稳定。 */
export function compareMemoryKindId(
  a: Pick<SearchableMemoryRow, "kind" | "id">,
  b: Pick<SearchableMemoryRow, "kind" | "id">,
): number {
  return compareCodeUnit(a.kind, b.kind) || compareCodeUnit(a.id, b.id);
}

const WHITESPACE_RE = /\s+/g;
const LATIN_WORD_RE = /[a-z0-9][a-z0-9._@+-]*/g;
const NON_CJK_RE =
  /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Unicode SpecialCasing 仅 lt / tr / az 存在 locale 敏感小写映射；
// 其他 locale 下 toLowerCase() 与 toLocaleLowerCase() 逐码点恒等且避免 ICU 查表开销。
const DEFAULT_LOCALE_LANG = Intl.DateTimeFormat()
  .resolvedOptions()
  .locale.split("-")[0]
  ?.toLowerCase();
const USE_FAST_LOWER =
  DEFAULT_LOCALE_LANG !== "tr" &&
  DEFAULT_LOCALE_LANG !== "az" &&
  DEFAULT_LOCALE_LANG !== "lt";

const toLower = (text: string) =>
  USE_FAST_LOWER ? text.toLowerCase() : text.toLocaleLowerCase();

const norm = (text: string) =>
  text ? toLower(text).replace(WHITESPACE_RE, " ").trim() : "";

export type CompiledMemoryQuery = {
  readonly q: string;
  readonly latinWords: readonly string[];
  readonly cjkBigrams: readonly string[];
  readonly cjkSingles: readonly string[];
  readonly totalGrams: number;
};

/** 预编译检索查询：将归一化与 n-gram 提取提到外层，供批量笔记打分复用。 */
export function compileMemoryQuery(query: string): CompiledMemoryQuery {
  const q = norm(query);
  if (!q) {
    return {
      q: "",
      latinWords: [],
      cjkBigrams: [],
      cjkSingles: [],
      totalGrams: 0,
    };
  }
  const latinSet = new Set<string>();
  const words = q.match(LATIN_WORD_RE);
  if (words) {
    for (const word of words) {
      if (word.length > 1) latinSet.add(word);
    }
  }
  const bigramSet = new Set<string>();
  const singleSet = new Set<string>();
  const cjk = q.replace(NON_CJK_RE, " ");
  for (const run of cjk.split(" ")) {
    if (run.length === 1) {
      singleSet.add(run);
    } else if (run.length > 1) {
      for (let i = 0; i + 1 < run.length; i++) {
        bigramSet.add(run.slice(i, i + 2));
      }
    }
  }
  const latinWords = [...latinSet];
  const cjkBigrams = [...bigramSet];
  const cjkSingles = [...singleSet];
  return {
    q,
    latinWords,
    cjkBigrams,
    cjkSingles,
    totalGrams: latinWords.length + cjkBigrams.length + cjkSingles.length,
  };
}

/** 中文按双字，拉丁字母和数字按整词。 */
export function grams(text: string): Set<string> {
  const out = new Set<string>();
  const value = norm(text);
  for (const word of value.match(LATIN_WORD_RE) ?? [])
    if (word.length > 1) out.add(word);
  const cjk = value.replace(NON_CJK_RE, " ");
  for (const run of cjk.split(" ")) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function prevCodePointAt(text: string, index: number): string {
  if (index <= 0) return "";
  const code = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return text.slice(index - 2, index);
    }
  }
  return text[index - 1] ?? "";
}

function nextCodePointAt(text: string, index: number): string {
  if (index >= text.length) return "";
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      return text.slice(index, index + 2);
    }
  }
  return text[index] ?? "";
}

function hasIsolatedCjk(text: string, ch: string): boolean {
  let idx = text.indexOf(ch);
  while (idx !== -1) {
    const prev = prevCodePointAt(text, idx);
    const next = nextCodePointAt(text, idx + 1);
    if (
      (!prev || !CJK_CHAR_RE.test(prev)) &&
      (!next || !CJK_CHAR_RE.test(next))
    ) {
      return true;
    }
    idx = text.indexOf(ch, idx + 1);
  }
  return false;
}

function collectLatinWords(text: string, target: Set<string>): void {
  if (!text) return;
  const matches = text.match(LATIN_WORD_RE);
  if (!matches) return;
  for (const word of matches) {
    if (word.length > 1) target.add(word);
  }
}

/** 使用预编译查询对单条笔记打分（0–1），与 `score(query, note)` 严格等价。 */
export function scoreWithCompiledQuery(
  compiled: CompiledMemoryQuery,
  note: Scorable,
): number {
  const { q } = compiled;
  if (!q) return 0;
  const subject = note.subject ? norm(note.subject) : "";
  if (subject && (subject === q || subject.includes(q) || q.includes(subject)))
    return 1;
  const body = note.context
    ? norm(`${note.content} ${note.context}`)
    : norm(note.content);
  if (body.includes(q)) return 0.85;
  if (compiled.totalGrams === 0) return 0;

  let hit = 0;
  for (let i = 0; i < compiled.cjkBigrams.length; i++) {
    const bg = compiled.cjkBigrams[i];
    if (bg && ((subject !== "" && subject.includes(bg)) || body.includes(bg))) {
      hit++;
    }
  }
  for (let i = 0; i < compiled.cjkSingles.length; i++) {
    const sg = compiled.cjkSingles[i];
    if (
      sg &&
      ((subject !== "" && hasIsolatedCjk(subject, sg)) ||
        hasIsolatedCjk(body, sg))
    ) {
      hit++;
    }
  }
  if (compiled.latinWords.length > 0) {
    let latinSet: Set<string> | null = null;
    for (let i = 0; i < compiled.latinWords.length; i++) {
      const word = compiled.latinWords[i];
      if (!word) continue;
      if ((subject === "" || !subject.includes(word)) && !body.includes(word)) {
        continue;
      }
      if (latinSet === null) {
        latinSet = new Set<string>();
        collectLatinWords(subject, latinSet);
        collectLatinWords(body, latinSet);
      }
      if (latinSet.has(word)) hit++;
    }
  }
  return (hit / compiled.totalGrams) * 0.8;
}

/** 0–1。0.25 以上算相关；完全包含查询词的直接 ≥ 0.8。 */
export function score(query: string, note: Scorable): number {
  return scoreWithCompiledQuery(compileMemoryQuery(query), note);
}

export const RELEVANT = 0.25;

/** 统一应用四级可见性隔离与相关性评分的纯搜索函数。 */
export function searchMemoryNotes<T extends SearchableMemoryRow>(
  rows: readonly T[],
  query: string,
  viewer: MemoryViewer,
  options: { kind?: MemoryKind; limit?: number } = {},
): T[] {
  const limit = options.limit ?? 30;
  const visible = filterReadableMemoryNotes(rows, viewer).filter(
    (row) => !options.kind || row.kind === options.kind,
  );
  const q = query.trim();
  if (!q) return visible.slice(0, limit);
  const compiled = compileMemoryQuery(q);
  if (!compiled.q) return [];
  const hits: Array<{ row: T; s: number }> = [];
  for (const row of visible) {
    const s = scoreWithCompiledQuery(compiled, row);
    if (s >= RELEVANT) hits.push({ row, s });
  }
  hits.sort((a, b) => b.s - a.s || compareMemoryKindId(a.row, b.row));
  return hits.slice(0, limit).map((hit) => hit.row);
}

/** 对已完成四级可见性过滤的行执行动态召回排序（供已过滤热路径内部复用）。 */
export function rankPreFilteredRecallNotes<T extends SearchableMemoryRow>(
  scopedRows: readonly T[],
  query: string,
  options: { limit?: number } = {},
): Array<{ row: T; score: number }> {
  const q = query.trim();
  if (!q) return [];
  const compiled = compileMemoryQuery(q);
  if (!compiled.q) return [];
  const limit = options.limit ?? 8;
  const hits: Array<{ row: T; score: number }> = [];
  for (const row of scopedRows) {
    const s = scoreWithCompiledQuery(compiled, row);
    if (s >= RELEVANT) hits.push({ row, score: s });
  }
  hits.sort((a, b) => b.score - a.score || compareMemoryKindId(a.row, b.row));
  return hits.slice(0, limit);
}

/** 为上下文动态召回块筛选高相关性记忆片段（只返回达标条目及分数）。 */
export function rankDynamicRecallNotes<T extends SearchableMemoryRow>(
  rows: readonly T[],
  query: string,
  viewer: MemoryViewer,
  options: { limit?: number } = {},
): Array<{ row: T; score: number }> {
  const q = query.trim();
  if (!q) return [];
  return rankPreFilteredRecallNotes(
    filterReadableMemoryNotes(rows, viewer),
    q,
    options,
  );
}
