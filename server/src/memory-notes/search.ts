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

const norm = (text: string) =>
  text.toLocaleLowerCase().replace(/\s+/g, " ").trim();

/** 中文按双字，拉丁字母和数字按整词。 */
export function grams(text: string): Set<string> {
  const out = new Set<string>();
  const value = norm(text);
  for (const word of value.match(/[a-z0-9][a-z0-9._@+-]*/g) ?? [])
    if (word.length > 1) out.add(word);
  const cjk = value.replace(
    /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
    " ",
  );
  for (const run of cjk.split(" ")) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 0–1。0.25 以上算相关；完全包含查询词的直接 ≥ 0.8。 */
export function score(query: string, note: Scorable): number {
  const q = norm(query);
  if (!q) return 0;
  const subject = norm(note.subject ?? "");
  const body = norm(`${note.content} ${note.context ?? ""}`);
  if (subject && (subject === q || subject.includes(q) || q.includes(subject)))
    return 1;
  if (body.includes(q)) return 0.85;
  const qg = grams(q);
  if (!qg.size) return 0;
  const hay = grams(`${subject} ${subject} ${body}`);
  let hit = 0;
  for (const g of qg) if (hay.has(g)) hit++;
  return (hit / qg.size) * 0.8;
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
  return visible
    .map((row) => ({ row, s: score(q, row) }))
    .filter((hit) => hit.s >= RELEVANT)
    .sort((a, b) => b.s - a.s || compareMemoryKindId(a.row, b.row))
    .slice(0, limit)
    .map((hit) => hit.row);
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
  const limit = options.limit ?? 8;
  return filterReadableMemoryNotes(rows, viewer)
    .map((row) => ({ row, score: score(q, row) }))
    .filter((hit) => hit.score >= RELEVANT)
    .sort((a, b) => b.score - a.score || compareMemoryKindId(a.row, b.row))
    .slice(0, limit);
}
