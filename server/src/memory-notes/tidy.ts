import { createHash, randomUUID } from "node:crypto";
import {
  MEMORY_LIMITS,
  type MemoryKind,
  type MemoryTidyGroup,
  type MemoryTidyLast,
  type MemoryTidyPreview,
  type MemoryTidyResult,
  type MemoryTidyUndoResult,
} from "../../../shared/memory-notes";

/**
 * 整理记忆（设置 → 记忆 →「更多」→ 整理记忆…，机器人工具 memory_dream）。审计 12-settings 必修 1。
 *
 * 以前一键就改库：同 (种类, 主题) 的笔记拼起来截到 4000 字、被并的整条删掉、不看是哪个机器人记的、多条 SQL 不在一个事务里，
 * 也没有撤销。现在：
 * - 先算出计划（{@link planTidy}，纯函数），网页拿去给用户确认（列出将合并的组），确认时带上计划指纹，库里变了就不做；
 * - 分组键带上机器人（agentId）和情境（context），不同机器人记的、不同情境下成立的不并；
 * - 合并后超过 4000 字的组整组不并（宁可不并，也不丢字）；行去重只删重复行，不截断；
 * - 整个整理在一个事务里做（锁住这个人自己的笔记），被改、被删的原文先存进 chisabot_memory_tidy_backups，
 *   撤销（{@link undoTidy}）原样放回。每人只留最近一次整理的原文（再整理一次就换成新的），7 天后清掉。
 */

export type TidyRow = {
  id: string;
  owner_user_id: string;
  kind: MemoryKind;
  subject: string | null;
  content: string;
  context: string | null;
  agent_id: string | null;
  shared?: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

/** 只用到 Bun SQL 的这两样，测试里可以换成内存实现（事务回滚测试）。 */
export type TidySql = {
  unsafe<T = unknown>(query: string, params?: unknown[]): Promise<T>;
  begin<T>(fn: (tx: TidySql) => Promise<T>): Promise<T>;
};

/** 整理过的原文留多久（只为撤销）。 */
export const TIDY_BACKUP_DAYS = 7;

export const TIDY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chisabot_memory_tidy_backups (
    batch_id text NOT NULL,
    owner_user_id text NOT NULL,
    note_id text NOT NULL,
    action text NOT NULL,
    original jsonb NOT NULL,
    after_content text,
    merged integer NOT NULL DEFAULT 0,
    deduplicated integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (batch_id, note_id)
  );
  CREATE INDEX IF NOT EXISTS chisabot_memory_tidy_backups_owner ON chisabot_memory_tidy_backups (owner_user_id, created_at DESC);
`;

const norm = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** 分组键：种类 + 机器人 + 情境 + 主题（没主题就用正文，即完全重复的才算一组）。 */
export function tidyGroupKey(
  row: Pick<TidyRow, "kind" | "subject" | "content" | "context" | "agent_id">,
): string {
  const subject = norm(row.subject);
  return JSON.stringify([
    row.kind,
    row.agent_id ?? "",
    norm(row.context),
    subject ? "subj" : "body",
    subject || norm(row.content),
  ]);
}

/** 行去重：日志开头的时间（「- 14:20 」）不算正文；只删完全重复的行，不截断。 */
export function dedupeLines(content: string): {
  content: string;
  removed: number;
} {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return { content, removed: 0 };
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const core = line.replace(/^-\s*(\d{1,2}:\d{2}\s+)?/, "").toLowerCase();
    if (seen.has(core)) continue;
    seen.add(core);
    kept.push(line);
  }
  return kept.length < lines.length
    ? { content: kept.join("\n"), removed: lines.length - kept.length }
    : { content, removed: 0 };
}

type PlannedGroup = MemoryTidyGroup & {
  keep: TidyRow;
  drop: TidyRow[];
  content: string;
};
type PlannedDedup = { row: TidyRow; content: string; removed: number };
export type TidyPlan = {
  groups: PlannedGroup[];
  dedups: PlannedDedup[];
  fingerprint: string;
  total: number;
};

const clipTitle = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].length > 24 ? `${[...flat].slice(0, 24).join("")}…` : flat;
};

/**
 * 算整理计划（不碰库）。rows 只能是这个人自己的、非公共知识库的笔记，按 updated_at 新到旧：
 * 每组留最新那条，旧的按顺序接在后面（已经包含在里面的不重复接）。
 */
export function planTidy(rows: readonly TidyRow[]): TidyPlan {
  const buckets = new Map<string, TidyRow[]>();
  for (const row of rows) {
    const key = tidyGroupKey(row);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  const groups: PlannedGroup[] = [];
  const dedups: PlannedDedup[] = [];
  let total = 0;
  for (const list of buckets.values()) {
    const [keep, ...rest] = list as [TidyRow, ...TidyRow[]];
    if (!rest.length) {
      total++;
      const lines = dedupeLines(keep.content);
      if (lines.removed)
        dedups.push({
          row: keep,
          content: lines.content,
          removed: lines.removed,
        });
      continue;
    }
    let merged = keep.content;
    for (const row of rest) {
      const piece = row.content.trim();
      if (piece && !merged.includes(piece)) merged = `${merged}\n${piece}`;
    }
    const lines = dedupeLines(merged);
    const title = clipTitle(keep.subject || keep.content.split("\n")[0] || "");
    const base = {
      kind: keep.kind,
      title,
      agentId: keep.agent_id,
      context: keep.context,
      count: list.length,
      ids: list.map((row) => row.id),
    };
    if (lines.content.length > MEMORY_LIMITS.content) {
      // 宁可不并也不丢字：整组原样保留，每条各自只做行去重。
      groups.push({
        ...base,
        skipped: "too_long",
        length: lines.content.length,
        keep,
        drop: [],
        content: keep.content,
      });
      total += list.length;
      for (const row of list) {
        const own = dedupeLines(row.content);
        if (own.removed)
          dedups.push({ row, content: own.content, removed: own.removed });
      }
      continue;
    }
    total++;
    groups.push({
      ...base,
      skipped: null,
      length: lines.content.length,
      keep,
      drop: rest,
      content: lines.content,
    });
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        groups
          .filter((group) => !group.skipped)
          .map((group) => [
            group.ids,
            group.content,
            [group.keep, ...group.drop].map((row) =>
              new Date(row.updated_at).toISOString(),
            ),
          ]),
        dedups.map((dedup) => [
          dedup.row.id,
          new Date(dedup.row.updated_at).toISOString(),
          dedup.content,
        ]),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return { groups, dedups, fingerprint, total };
}

export function previewOf(plan: TidyPlan): MemoryTidyPreview {
  return {
    token: plan.fingerprint,
    groups: plan.groups.map(
      ({ keep: _keep, drop: _drop, content: _content, ...group }) => group,
    ),
    mergedCount: plan.groups
      .filter((group) => !group.skipped)
      .reduce((sum, group) => sum + group.count - 1, 0),
    deduplicatedCount: plan.dedups.length,
    totalRemaining: plan.total,
  };
}

const LOCK_ROWS =
  "SELECT * FROM chisabot_memory_notes WHERE owner_user_id = $1 AND shared = false ORDER BY updated_at DESC, id LIMIT $2 FOR UPDATE";

export class TidyConflictError extends Error {}

/** 这个人自己的笔记（不含公共知识库），新到旧。 */
export async function loadTidyRows(
  sql: Pick<TidySql, "unsafe">,
  owner: string,
  lock = false,
): Promise<TidyRow[]> {
  return await sql.unsafe<TidyRow[]>(
    lock ? LOCK_ROWS : LOCK_ROWS.replace(" FOR UPDATE", ""),
    [owner, MEMORY_LIMITS.perUser],
  );
}

/**
 * 按计划整理，整个在一个事务里：锁行 → 重新算计划（给了 token 就必须和预览时一致）→ 存原文 → 改 / 删。
 * 任何一步失败整个回滚，库里保持整理前的样子。
 */
export async function applyTidy(
  sql: TidySql,
  owner: string,
  options: { token?: string | null } = {},
): Promise<MemoryTidyResult> {
  return await sql.begin(async (tx) => {
    const plan = planTidy(await loadTidyRows(tx, owner, true));
    if (options.token && options.token !== plan.fingerprint)
      throw new TidyConflictError(
        "记忆在你确认前有了变化，请重新点「整理记忆」看一遍。",
      );
    const preview = previewOf(plan);
    const merging = plan.groups.filter((group) => !group.skipped);
    if (!merging.length && !plan.dedups.length)
      return { ...preview, batchId: null, summary: summaryOf(preview) };
    const batchId = `tidy_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    // 每人只留最近一次整理的原文；顺手清掉过期的。
    await tx.unsafe(
      "DELETE FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 OR created_at < now() - make_interval(days => $2)",
      [owner, TIDY_BACKUP_DAYS],
    );
    const backups: [TidyRow, "updated" | "deleted", string | null][] = [];
    const updates: { id: string; content: string }[] = [];
    const deletes: string[] = [];
    for (const group of merging) {
      backups.push([group.keep, "updated", group.content]);
      updates.push({ id: group.keep.id, content: group.content });
      for (const row of group.drop) {
        backups.push([row, "deleted", null]);
        deletes.push(row.id);
      }
    }
    for (const dedup of plan.dedups) {
      backups.push([dedup.row, "updated", dedup.content]);
      updates.push({ id: dedup.row.id, content: dedup.content });
    }
    for (const [row, action, after] of backups) {
      await tx.unsafe(
        `INSERT INTO chisabot_memory_tidy_backups (batch_id, owner_user_id, note_id, action, original, after_content, merged, deduplicated)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          batchId,
          owner,
          row.id,
          action,
          JSON.stringify(row),
          after,
          preview.mergedCount,
          preview.deduplicatedCount,
        ],
      );
    }
    for (const update of updates)
      await tx.unsafe(
        "UPDATE chisabot_memory_notes SET content = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2",
        [update.id, owner, update.content],
      );
    if (deletes.length)
      await tx.unsafe(
        "DELETE FROM chisabot_memory_notes WHERE owner_user_id = $1 AND id = ANY(string_to_array($2, chr(31)))",
        [owner, deletes.join("\u001f")],
      );
    return { ...preview, batchId, summary: summaryOf(preview) };
  });
}

export function summaryOf(
  preview: Pick<
    MemoryTidyPreview,
    "mergedCount" | "deduplicatedCount" | "totalRemaining" | "groups"
  >,
): string {
  const skipped = preview.groups.filter((group) => group.skipped).length;
  const skippedText = skipped
    ? `；${skipped} 组合并后会超过 ${MEMORY_LIMITS.content} 字，没有合并`
    : "";
  if (!preview.mergedCount && !preview.deduplicatedCount)
    return `记忆已经很整洁，没有要合并的（共 ${preview.totalRemaining} 条${skippedText}）。`;
  const done = [
    preview.mergedCount ? `合并了 ${preview.mergedCount} 条重复笔记` : "",
    preview.deduplicatedCount
      ? `${preview.deduplicatedCount} 条去掉了重复行`
      : "",
  ].filter(Boolean);
  return `已整理记忆：${done.join("，")}，现在共 ${preview.totalRemaining} 条${skippedText}。`;
}

type BackupRow = {
  note_id: string;
  action: "updated" | "deleted";
  original: TidyRow | string;
  after_content: string | null;
  created_at: Date | string;
  merged: number;
  deduplicated: number;
  batch_id: string;
};

/** 最近一次还能撤销的整理（设置页「更多」菜单里的「撤销上次整理」）。 */
export async function lastTidy(
  sql: Pick<TidySql, "unsafe">,
  owner: string,
): Promise<MemoryTidyLast | null> {
  const [row] = await sql.unsafe<BackupRow[]>(
    `SELECT batch_id, created_at, merged, deduplicated FROM chisabot_memory_tidy_backups
     WHERE owner_user_id = $1 AND created_at >= now() - make_interval(days => $2) ORDER BY created_at DESC LIMIT 1`,
    [owner, TIDY_BACKUP_DAYS],
  );
  return row
    ? {
        batchId: row.batch_id,
        createdAt: new Date(row.created_at).toISOString(),
        mergedCount: Number(row.merged),
        deduplicatedCount: Number(row.deduplicated),
      }
    : null;
}

/**
 * 撤销一次整理（一个事务）：被删的原样插回来（同一个 id），被改的改回原文。
 * 整理后又被改过的那条（内容不再是整理后的样子）不覆盖，算进 skipped，免得把用户后来的修改冲掉。
 */
export async function undoTidy(
  sql: TidySql,
  owner: string,
  batchId: string,
): Promise<MemoryTidyUndoResult> {
  if (!/^tidy_[a-f0-9]{8,40}$/.test(batchId))
    return { restored: 0, skipped: 0 };
  return await sql.begin(async (tx) => {
    const rows = await tx.unsafe<BackupRow[]>(
      "SELECT * FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 AND batch_id = $2 FOR UPDATE",
      [owner, batchId],
    );
    let restored = 0;
    let skipped = 0;
    for (const backup of rows) {
      const original = (
        typeof backup.original === "string"
          ? JSON.parse(backup.original)
          : backup.original
      ) as TidyRow;
      if (backup.action === "deleted") {
        const inserted = await tx.unsafe<{ id: string }[]>(
          `INSERT INTO chisabot_memory_notes (id, owner_user_id, kind, subject, content, context, agent_id, shared, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [
            original.id,
            owner,
            original.kind,
            original.subject,
            original.content,
            original.context,
            original.agent_id,
            new Date(original.created_at),
            new Date(original.updated_at),
          ],
        );
        if (inserted.length) restored++;
        else skipped++;
      } else {
        const updated = await tx.unsafe<{ id: string }[]>(
          "UPDATE chisabot_memory_notes SET content = $3, updated_at = $5 WHERE id = $1 AND owner_user_id = $2 AND content = $4 RETURNING id",
          [
            original.id,
            owner,
            original.content,
            backup.after_content,
            new Date(original.updated_at),
          ],
        );
        if (updated.length) restored++;
        else skipped++;
      }
    }
    await tx.unsafe(
      "DELETE FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 AND batch_id = $2",
      [owner, batchId],
    );
    return { restored, skipped };
  });
}
