import { createHash } from "node:crypto";
import {
  SHARE_LIMITS,
  type SkillAuxFileView,
  type SkillDiffLine,
  type SkillDiffResult,
  type SkillRevisionView,
} from "../../../shared/sharing";
import type { Database } from "../db/client";
import {
  isForbiddenShareFilePath,
  scanSecretsInText,
} from "../sharing/package";

/**
 * 技能治理存储：
 * 1. 不可变版本栈 `chisabot_skill_revisions`（按内容 SHA-256 不可变快照 + `chisabot_skill_heads` 当前版本指针）；
 * 2. 行级 Diff `diffRevisions` 与回滚 `rollbackToRevision`；
 * 3. 多文件只读技能包 `chisabot_skill_files`（安全相对路径校验 + 单文件上限 256 KiB + 密钥扫描）；
 * 4. 纯函数 `filterSkillsByAvailableTools`：每回合按可用工具动态隐身不满足 `requiresTools` 的技能。
 */

export const MAX_SKILL_AUX_FILES = SHARE_LIMITS.maxSkillAuxFiles;
export const MAX_SKILL_AUX_FILE_BYTES = SHARE_LIMITS.maxSkillAuxFileBytes;

const TOOL_NAME_RE = /^[A-Za-z0-9_.:/-]{1,200}$/;

export class SkillVersionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = "SkillVersionError";
  }
}

export type SkillVersionDatabase = {
  $client: Pick<Database["$client"], "unsafe"> &
    Partial<Pick<Database["$client"], "begin">>;
};

export type RecordSkillRevisionInput = {
  skillSlug: string;
  title: string;
  summary: string;
  instructions: string;
  requiresTools?: readonly string[];
  author: string;
  reason?: string;
};

export type SkillAuxFileInput = {
  path: string;
  content: string;
};

export type SkillVersionStore = {
  ensure(): Promise<void>;
  recordRevision(input: RecordSkillRevisionInput): Promise<SkillRevisionView>;
  listRevisions(skillSlug: string): Promise<{
    currentRevisionId: string | null;
    revisions: SkillRevisionView[];
  }>;
  getRevision(
    skillSlug: string,
    revisionId: string,
  ): Promise<SkillRevisionView | null>;
  getCurrentRevision(skillSlug: string): Promise<SkillRevisionView | null>;
  diffRevisions(
    skillSlug: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<SkillDiffResult>;
  rollbackToRevision(
    skillSlug: string,
    revisionId: string,
  ): Promise<SkillRevisionView>;
  setSkillFiles(
    skillSlug: string,
    files: readonly SkillAuxFileInput[],
    updatedBy: string,
  ): Promise<SkillAuxFileView[]>;
  listSkillFiles(skillSlug: string): Promise<SkillAuxFileView[]>;
  getSkillFile(
    skillSlug: string,
    filePath: string,
  ): Promise<SkillAuxFileView | null>;
  deleteSkillData(skillSlug: string): Promise<void>;
  listRequiresToolsMap(
    skillSlugs?: readonly string[],
  ): Promise<Map<string, string[]>>;
  listFileCountsMap(
    skillSlugs?: readonly string[],
  ): Promise<Map<string, number>>;
};

export function normalizeRequiresTools(
  raw: readonly string[] | undefined,
): string[] {
  if (!raw || raw.length === 0) return [];
  const out = new Set<string>();
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!TOOL_NAME_RE.test(trimmed)) {
      throw new SkillVersionError(`工具依赖名不合法：${trimmed}`, 400);
    }
    out.add(trimmed);
  }
  return [...out].slice(0, 100);
}

function parseFrontmatterRequiresTools(instructions: string): string[] {
  const normalized = instructions.replace(/\r\n/g, "\n").trim();
  const out = new Set<string>();

  // 支持 YAML frontmatter 中的 requiresTools / requires_tools / requires-tools
  const fmMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (fmMatch?.[1]) {
    const lines = fmMatch[1].split("\n");
    let readingList = false;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (readingList) {
        const item = /^-\s+(.+)$/.exec(trimmed);
        if (item?.[1]) {
          const val = item[1].trim().replace(/^["']|["']$/g, "");
          if (TOOL_NAME_RE.test(val)) out.add(val);
          continue;
        }
        readingList = false;
      }
      const kv = /^requires[_-]?tools\s*:\s*(.*)$/i.exec(trimmed);
      if (kv) {
        const rest = (kv[1] ?? "").trim();
        if (!rest) {
          readingList = true;
        } else {
          for (const token of rest.replace(/^\[|\]$/g, "").split(/[,\s]+/)) {
            const clean = token.trim().replace(/^["']|["']$/g, "");
            if (TOOL_NAME_RE.test(clean)) out.add(clean);
          }
        }
      }
    }
  }

  // 同时支持正文顶部的声明注释：<!-- requiresTools: tool_a, tool_b -->
  const commentMatch = /<!--\s*requires[_-]?tools\s*:\s*([^>]+?)\s*-->/i.exec(
    normalized.slice(0, 1200),
  );
  if (commentMatch?.[1]) {
    for (const token of commentMatch[1].split(/[,\s]+/)) {
      const clean = token.trim().replace(/^["']|["']$/g, "");
      if (TOOL_NAME_RE.test(clean)) out.add(clean);
    }
  }

  return [...out];
}

export type SkillWithToolDeps = {
  slug?: string;
  instructions?: string;
  requiresTools?: readonly string[];
  tools?: readonly string[];
};

/** 合并技能显式声明、版本元数据和指令文本中标注的 `requiresTools`。 */
export function extractSkillRequiresTools(skill: SkillWithToolDeps): string[] {
  const out = new Set<string>();
  for (const item of skill.requiresTools ?? []) {
    const clean = item.trim();
    if (clean && TOOL_NAME_RE.test(clean)) out.add(clean);
  }
  for (const item of skill.tools ?? []) {
    const clean = item.trim();
    if (clean && TOOL_NAME_RE.test(clean)) out.add(clean);
  }
  if (skill.instructions) {
    for (const item of parseFrontmatterRequiresTools(skill.instructions)) {
      out.add(item);
    }
  }
  return [...out];
}

/**
 * 纯函数：根据当前回合可用工具集合过滤技能清单。
 * 声明了 `requiresTools` 的技能必须全部工具就绪才对模型可见，缺失任意一项自动隐身。
 */
export function filterSkillsByAvailableTools<T extends SkillWithToolDeps>(
  skills: readonly T[],
  availableToolNames: Iterable<string> | ReadonlySet<string>,
): T[] {
  const available =
    availableToolNames instanceof Set
      ? availableToolNames
      : new Set(availableToolNames);

  return skills.filter((skill) => {
    const required = extractSkillRequiresTools(skill);
    if (required.length === 0) return true;
    return required.every((toolName) => available.has(toolName));
  });
}

/** 校验多文件只读技能包的辅助文件相对路径（严格 POSIX 相对路径，防穿越与敏感文件）。 */
export function validateSkillAuxFilePath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new SkillVersionError("辅助文件路径不能为空。", 400);
  }
  if (rawPath.length > SHARE_LIMITS.maxPathLength) {
    throw new SkillVersionError("辅助文件路径过长。", 400);
  }
  for (let i = 0; i < rawPath.length; i++) {
    const code = rawPath.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new SkillVersionError("辅助文件路径包含非法控制字符。", 400);
    }
  }
  if (rawPath.includes("\\") || rawPath.includes(":")) {
    throw new SkillVersionError(
      `辅助文件路径必须使用 POSIX 相对路径且禁止反斜杠或盘符：${rawPath}`,
      400,
    );
  }
  if (rawPath.startsWith("/") || rawPath.endsWith("/")) {
    throw new SkillVersionError(
      `辅助文件路径不能以斜杠开头或结尾：${rawPath}`,
      400,
    );
  }
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new SkillVersionError(
        `辅助文件路径存在非法目录穿越或空段：${rawPath}`,
        400,
      );
    }
  }
  if (rawPath.toLowerCase() === "skill.md") {
    throw new SkillVersionError(
      "SKILL.md 为技能主文件，辅助文件请使用其他相对路径（如 templates/guide.md）。",
      400,
    );
  }
  if (isForbiddenShareFilePath(rawPath)) {
    throw new SkillVersionError(
      `安全拦截：禁止在技能包中存放敏感文件「${rawPath}」。`,
      400,
    );
  }
  return rawPath;
}

function validateAuxFilesBatch(
  files: readonly SkillAuxFileInput[],
): Array<{ path: string; content: string; sha256: string; bytes: number }> {
  if (files.length > MAX_SKILL_AUX_FILES) {
    throw new SkillVersionError(
      `单个技能最多附带 ${MAX_SKILL_AUX_FILES} 个辅助文件。`,
      413,
    );
  }
  const seen = new Set<string>();
  const validated: Array<{
    path: string;
    content: string;
    sha256: string;
    bytes: number;
  }> = [];

  for (const file of files) {
    const safePath = validateSkillAuxFilePath(file.path);
    if (seen.has(safePath)) {
      throw new SkillVersionError(`存在重复辅助文件路径：${safePath}`, 400);
    }
    seen.add(safePath);

    if (typeof file.content !== "string") {
      throw new SkillVersionError(
        `辅助文件「${safePath}」正文必须是文本。`,
        400,
      );
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_SKILL_AUX_FILE_BYTES) {
      throw new SkillVersionError(
        `辅助文件「${safePath}」超出 256 KiB 单文件上限。`,
        413,
      );
    }
    const findings = scanSecretsInText(
      file.content,
      `技能辅助文件 ${safePath}`,
    );
    const blocked = findings.filter((f) => f.severity === "block");
    if (blocked.length > 0) {
      throw new SkillVersionError(
        `辅助文件「${safePath}」未通过安全扫描：${blocked.map((b) => b.message).join("；")}`,
        400,
      );
    }
    const sha256 = createHash("sha256")
      .update(file.content, "utf8")
      .digest("hex");
    validated.push({ path: safePath, content: file.content, sha256, bytes });
  }

  // 检查路径前缀冲突（如 scripts 与 scripts/run.py 不能同时存在）
  const sorted = [...seen].sort();
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (cur && next?.startsWith(`${cur}/`)) {
      throw new SkillVersionError(
        `辅助文件路径冲突（目录与文件重名）：${cur} 与 ${next}`,
        400,
      );
    }
  }

  return validated.sort((a, b) => a.path.localeCompare(b.path));
}

export function computeSkillRevisionSha256(snapshot: {
  title: string;
  summary: string;
  instructions: string;
  requiresTools: readonly string[];
}): string {
  const payload = JSON.stringify({
    title: snapshot.title,
    summary: snapshot.summary,
    instructions: snapshot.instructions,
    requiresTools: [...snapshot.requiresTools].sort(),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function makeRevisionId(skillSlug: string, contentSha256: string): string {
  const hash = createHash("sha256")
    .update(`${skillSlug}\0${contentSha256}`, "utf8")
    .digest("hex");
  return `rev_${hash.slice(0, 20)}`;
}

function formatRevisionForDiff(rev: SkillRevisionView): string {
  const headerLines = [
    `标题: ${rev.title}`,
    `简介: ${rev.summary}`,
    ...(rev.requiresTools.length > 0
      ? [`依赖工具: ${rev.requiresTools.join(", ")}`]
      : []),
    "---",
  ];
  return `${headerLines.join("\n")}\n${rev.instructions.replace(/\r\n/g, "\n")}`;
}

/** 计算两段文本的确定性行级 Diff（LCS 并在超大文本下自动回退前后缀裁剪防 O(N²) 退化）。 */
export function computeLineDiff(
  fromText: string,
  toText: string,
): { lines: SkillDiffLine[]; addedLines: number; removedLines: number } {
  const oldLines = fromText.replace(/\r\n/g, "\n").split("\n");
  const newLines = toText.replace(/\r\n/g, "\n").split("\n");

  // 先剥离公共前缀与公共后缀，减小 DP 规模
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);

  const lines: SkillDiffLine[] = [];
  let addedLines = 0;
  let removedLines = 0;

  for (let i = 0; i < prefix; i++) {
    lines.push({
      type: "context",
      oldLine: i + 1,
      newLine: i + 1,
      text: oldLines[i] ?? "",
    });
  }

  const m = midOld.length;
  const n = midNew.length;
  if (m === 0 && n === 0) {
    // 完全一致
  } else if (m * n > 250_000) {
    // 超大改动块保护：直接输出移除段 + 新增段
    for (let i = 0; i < m; i++) {
      removedLines++;
      lines.push({
        type: "remove",
        oldLine: prefix + i + 1,
        newLine: null,
        text: midOld[i] ?? "",
      });
    }
    for (let j = 0; j < n; j++) {
      addedLines++;
      lines.push({
        type: "add",
        oldLine: null,
        newLine: prefix + j + 1,
        text: midNew[j] ?? "",
      });
    }
  } else {
    const stride = n + 1;
    const dp = new Uint32Array((m + 1) * stride);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i * stride + j] = (dp[(i + 1) * stride + (j + 1)] ?? 0) + 1;
        } else {
          const down = dp[(i + 1) * stride + j] ?? 0;
          const right = dp[i * stride + (j + 1)] ?? 0;
          dp[i * stride + j] = Math.max(down, right);
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        lines.push({
          type: "context",
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
          text: midOld[i] ?? "",
        });
        i++;
        j++;
      } else if (
        (dp[(i + 1) * stride + j] ?? 0) >= (dp[i * stride + (j + 1)] ?? 0)
      ) {
        removedLines++;
        lines.push({
          type: "remove",
          oldLine: prefix + i + 1,
          newLine: null,
          text: midOld[i] ?? "",
        });
        i++;
      } else {
        addedLines++;
        lines.push({
          type: "add",
          oldLine: null,
          newLine: prefix + j + 1,
          text: midNew[j] ?? "",
        });
        j++;
      }
    }
    while (i < m) {
      removedLines++;
      lines.push({
        type: "remove",
        oldLine: prefix + i + 1,
        newLine: null,
        text: midOld[i] ?? "",
      });
      i++;
    }
    while (j < n) {
      addedLines++;
      lines.push({
        type: "add",
        oldLine: null,
        newLine: prefix + j + 1,
        text: midNew[j] ?? "",
      });
      j++;
    }
  }

  for (let k = 0; k < suffix; k++) {
    const oldIdx = oldLines.length - suffix + k;
    const newIdx = newLines.length - suffix + k;
    lines.push({
      type: "context",
      oldLine: oldIdx + 1,
      newLine: newIdx + 1,
      text: oldLines[oldIdx] ?? "",
    });
  }

  return { lines, addedLines, removedLines };
}

type RevisionRow = {
  id: string;
  skill_slug: string;
  content_sha256: string;
  title: string;
  summary: string;
  instructions: string;
  requires_tools: string[] | string;
  author: string;
  reason: string;
  created_at: Date | string;
  seq?: number | string;
};

type FileRow = {
  skill_slug: string;
  file_path: string;
  content: string;
  sha256: string;
  bytes: number;
  updated_by: string;
  updated_at: Date | string;
};

function parseJsonStringArray(
  raw: string[] | string | null | undefined,
): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toRevisionView(
  row: RevisionRow,
  currentRevisionId?: string | null,
): SkillRevisionView {
  return {
    revisionId: row.id,
    skillSlug: row.skill_slug,
    contentSha256: row.content_sha256,
    title: row.title,
    summary: row.summary,
    instructions: row.instructions,
    requiresTools: parseJsonStringArray(row.requires_tools),
    author: row.author,
    reason: row.reason,
    createdAt: new Date(row.created_at).toISOString(),
    ...(currentRevisionId !== undefined
      ? { isCurrent: row.id === currentRevisionId }
      : {}),
  };
}

function toAuxFileView(row: FileRow): SkillAuxFileView {
  return {
    path: row.file_path,
    content: row.content,
    sha256: row.sha256,
    bytes: Number(row.bytes),
    readOnly: true,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** 生产 PostgreSQL 版技能治理存储（启动时幂等建表，不触碰旧 Drizzle 表）。 */
export function createSkillVersionStore(
  database: SkillVersionDatabase,
): SkillVersionStore {
  const sql = database.$client;

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_skill_revisions (
        id text PRIMARY KEY,
        seq bigserial NOT NULL,
        skill_slug text NOT NULL,
        content_sha256 text NOT NULL,
        title text NOT NULL,
        summary text NOT NULL DEFAULT '',
        instructions text NOT NULL,
        requires_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
        author text NOT NULL,
        reason text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS chisabot_skill_revisions_slug_sha_idx
        ON chisabot_skill_revisions (skill_slug, content_sha256);
      CREATE INDEX IF NOT EXISTS chisabot_skill_revisions_slug_seq_idx
        ON chisabot_skill_revisions (skill_slug, seq DESC);

      CREATE TABLE IF NOT EXISTS chisabot_skill_heads (
        skill_slug text PRIMARY KEY,
        current_revision_id text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS chisabot_skill_files (
        skill_slug text NOT NULL,
        file_path text NOT NULL,
        content text NOT NULL,
        sha256 text NOT NULL,
        bytes integer NOT NULL,
        updated_by text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (skill_slug, file_path)
      );
      CREATE INDEX IF NOT EXISTS chisabot_skill_files_slug_idx
        ON chisabot_skill_files (skill_slug);
    `);
  }

  async function recordRevision(
    input: RecordSkillRevisionInput,
  ): Promise<SkillRevisionView> {
    const requiresTools = normalizeRequiresTools(
      input.requiresTools ??
        extractSkillRequiresTools({ instructions: input.instructions }),
    );
    const title = input.title.trim();
    const summary = input.summary.trim();
    const instructions = input.instructions.replace(/\r\n/g, "\n").trim();
    const contentSha256 = computeSkillRevisionSha256({
      title,
      summary,
      instructions,
      requiresTools,
    });
    const id = makeRevisionId(input.skillSlug, contentSha256);
    const reason = (input.reason ?? "").trim().slice(0, 200);
    const author = input.author.trim().slice(0, 120) || "system";

    await sql.unsafe(
      `INSERT INTO chisabot_skill_revisions
         (id, skill_slug, content_sha256, title, summary, instructions, requires_tools, author, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (skill_slug, content_sha256) DO NOTHING`,
      [
        id,
        input.skillSlug,
        contentSha256,
        title,
        summary,
        instructions,
        JSON.stringify(requiresTools),
        author,
        reason,
      ],
    );

    const rows = await sql.unsafe<RevisionRow[]>(
      `SELECT * FROM chisabot_skill_revisions
       WHERE skill_slug = $1 AND content_sha256 = $2
       LIMIT 1`,
      [input.skillSlug, contentSha256],
    );
    const saved = rows[0];
    if (!saved) {
      throw new SkillVersionError("无法写入技能不可变版本快照。", 400);
    }

    await sql.unsafe(
      `INSERT INTO chisabot_skill_heads (skill_slug, current_revision_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (skill_slug)
       DO UPDATE SET current_revision_id = EXCLUDED.current_revision_id, updated_at = now()`,
      [input.skillSlug, saved.id],
    );

    return toRevisionView(saved, saved.id);
  }

  async function currentHeadId(skillSlug: string): Promise<string | null> {
    const rows = await sql.unsafe<{ current_revision_id: string }[]>(
      "SELECT current_revision_id FROM chisabot_skill_heads WHERE skill_slug = $1 LIMIT 1",
      [skillSlug],
    );
    return rows[0]?.current_revision_id ?? null;
  }

  async function listRevisions(skillSlug: string): Promise<{
    currentRevisionId: string | null;
    revisions: SkillRevisionView[];
  }> {
    const [headId, rows] = await Promise.all([
      currentHeadId(skillSlug),
      sql.unsafe<RevisionRow[]>(
        `SELECT * FROM chisabot_skill_revisions
         WHERE skill_slug = $1
         ORDER BY seq DESC
         LIMIT 100`,
        [skillSlug],
      ),
    ]);
    const effectiveHead = headId ?? rows[0]?.id ?? null;
    return {
      currentRevisionId: effectiveHead,
      revisions: rows.map((row) => toRevisionView(row, effectiveHead)),
    };
  }

  async function getRevision(
    skillSlug: string,
    revisionId: string,
  ): Promise<SkillRevisionView | null> {
    const [headId, rows] = await Promise.all([
      currentHeadId(skillSlug),
      sql.unsafe<RevisionRow[]>(
        `SELECT * FROM chisabot_skill_revisions
         WHERE skill_slug = $1 AND id = $2
         LIMIT 1`,
        [skillSlug, revisionId],
      ),
    ]);
    const row = rows[0];
    return row ? toRevisionView(row, headId) : null;
  }

  async function getCurrentRevision(
    skillSlug: string,
  ): Promise<SkillRevisionView | null> {
    const headId = await currentHeadId(skillSlug);
    if (headId) {
      const found = await getRevision(skillSlug, headId);
      if (found) return found;
    }
    const rows = await sql.unsafe<RevisionRow[]>(
      `SELECT * FROM chisabot_skill_revisions
       WHERE skill_slug = $1
       ORDER BY seq DESC
       LIMIT 1`,
      [skillSlug],
    );
    const latest = rows[0];
    return latest ? toRevisionView(latest, latest.id) : null;
  }

  async function diffRevisions(
    skillSlug: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<SkillDiffResult> {
    const [fromRev, toRev] = await Promise.all([
      getRevision(skillSlug, fromRevisionId),
      getRevision(skillSlug, toRevisionId),
    ]);
    if (!fromRev) {
      throw new SkillVersionError(`找不到基准版本：${fromRevisionId}`, 404);
    }
    if (!toRev) {
      throw new SkillVersionError(`找不到目标版本：${toRevisionId}`, 404);
    }
    const diff = computeLineDiff(
      formatRevisionForDiff(fromRev),
      formatRevisionForDiff(toRev),
    );
    return {
      fromRevisionId: fromRev.revisionId,
      toRevisionId: toRev.revisionId,
      ...diff,
    };
  }

  async function rollbackToRevision(
    skillSlug: string,
    revisionId: string,
  ): Promise<SkillRevisionView> {
    const target = await getRevision(skillSlug, revisionId);
    if (!target) {
      throw new SkillVersionError(`找不到可回滚的目标版本：${revisionId}`, 404);
    }
    await sql.unsafe(
      `INSERT INTO chisabot_skill_heads (skill_slug, current_revision_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (skill_slug)
       DO UPDATE SET current_revision_id = EXCLUDED.current_revision_id, updated_at = now()`,
      [skillSlug, target.revisionId],
    );
    return { ...target, isCurrent: true };
  }

  async function setSkillFiles(
    skillSlug: string,
    files: readonly SkillAuxFileInput[],
    updatedBy: string,
  ): Promise<SkillAuxFileView[]> {
    const validated = validateAuxFilesBatch(files);
    const actor = updatedBy.trim().slice(0, 120) || "system";

    const replaceWithin = async (
      exec: Pick<Database["$client"], "unsafe">,
    ): Promise<SkillAuxFileView[]> => {
      // 按 skill_slug 事务级咨询锁串行化同技能并发替换，确保 DELETE + INSERT 原子不丢失也不撞主键
      await exec.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `chisabot_skill_files:${skillSlug}`,
      ]);
      await exec.unsafe(
        "DELETE FROM chisabot_skill_files WHERE skill_slug = $1",
        [skillSlug],
      );
      for (const file of validated) {
        await exec.unsafe(
          `INSERT INTO chisabot_skill_files
             (skill_slug, file_path, content, sha256, bytes, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [skillSlug, file.path, file.content, file.sha256, file.bytes, actor],
        );
      }
      const rows = await exec.unsafe<FileRow[]>(
        `SELECT * FROM chisabot_skill_files
         WHERE skill_slug = $1
         ORDER BY file_path ASC`,
        [skillSlug],
      );
      return rows.map(toAuxFileView);
    };

    if (typeof sql.begin === "function") {
      return await sql.begin(async (transaction) =>
        replaceWithin(
          transaction as unknown as Pick<Database["$client"], "unsafe">,
        ),
      );
    }
    return replaceWithin(sql);
  }

  async function listSkillFiles(
    skillSlug: string,
  ): Promise<SkillAuxFileView[]> {
    const rows = await sql.unsafe<FileRow[]>(
      `SELECT * FROM chisabot_skill_files
       WHERE skill_slug = $1
       ORDER BY file_path ASC`,
      [skillSlug],
    );
    return rows.map(toAuxFileView);
  }

  async function getSkillFile(
    skillSlug: string,
    filePath: string,
  ): Promise<SkillAuxFileView | null> {
    const safePath = validateSkillAuxFilePath(filePath);
    const rows = await sql.unsafe<FileRow[]>(
      `SELECT * FROM chisabot_skill_files
       WHERE skill_slug = $1 AND file_path = $2
       LIMIT 1`,
      [skillSlug, safePath],
    );
    return rows[0] ? toAuxFileView(rows[0]) : null;
  }

  async function deleteSkillData(skillSlug: string): Promise<void> {
    await sql.unsafe("DELETE FROM chisabot_skill_files WHERE skill_slug = $1", [
      skillSlug,
    ]);
    await sql.unsafe("DELETE FROM chisabot_skill_heads WHERE skill_slug = $1", [
      skillSlug,
    ]);
    await sql.unsafe(
      "DELETE FROM chisabot_skill_revisions WHERE skill_slug = $1",
      [skillSlug],
    );
  }

  async function listRequiresToolsMap(
    skillSlugs?: readonly string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (skillSlugs && skillSlugs.length === 0) return map;
    const rows = skillSlugs
      ? await sql.unsafe<
          { skill_slug: string; requires_tools: string[] | string }[]
        >(
          `SELECT h.skill_slug, r.requires_tools
           FROM chisabot_skill_heads h
           JOIN chisabot_skill_revisions r ON r.id = h.current_revision_id
           WHERE h.skill_slug = ANY($1::text[])`,
          [skillSlugs],
        )
      : await sql.unsafe<
          { skill_slug: string; requires_tools: string[] | string }[]
        >(
          `SELECT h.skill_slug, r.requires_tools
           FROM chisabot_skill_heads h
           JOIN chisabot_skill_revisions r ON r.id = h.current_revision_id`,
        );
    for (const row of rows) {
      map.set(row.skill_slug, parseJsonStringArray(row.requires_tools));
    }
    return map;
  }

  async function listFileCountsMap(
    skillSlugs?: readonly string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (skillSlugs && skillSlugs.length === 0) return map;
    const rows = skillSlugs
      ? await sql.unsafe<{ skill_slug: string; count: string | number }[]>(
          `SELECT skill_slug, COUNT(*)::int AS count
           FROM chisabot_skill_files
           WHERE skill_slug = ANY($1::text[])
           GROUP BY skill_slug`,
          [skillSlugs],
        )
      : await sql.unsafe<{ skill_slug: string; count: string | number }[]>(
          `SELECT skill_slug, COUNT(*)::int AS count
           FROM chisabot_skill_files
           GROUP BY skill_slug`,
        );
    for (const row of rows) {
      map.set(row.skill_slug, Number(row.count));
    }
    return map;
  }

  return {
    ensure,
    recordRevision,
    listRevisions,
    getRevision,
    getCurrentRevision,
    diffRevisions,
    rollbackToRevision,
    setSkillFiles,
    listSkillFiles,
    getSkillFile,
    deleteSkillData,
    listRequiresToolsMap,
    listFileCountsMap,
  };
}

/** 内存版技能治理存储（零外部依赖，与生产实现共享同一契约，供单测使用）。 */
export function createMemorySkillVersionStore(): SkillVersionStore {
  const revisionsBySlug = new Map<
    string,
    Array<SkillRevisionView & { seq: number }>
  >();
  const heads = new Map<string, string>();
  const filesBySlug = new Map<string, SkillAuxFileView[]>();
  let seqCounter = 0;

  return {
    async ensure() {},

    async recordRevision(input) {
      const requiresTools = normalizeRequiresTools(
        input.requiresTools ??
          extractSkillRequiresTools({ instructions: input.instructions }),
      );
      const title = input.title.trim();
      const summary = input.summary.trim();
      const instructions = input.instructions.replace(/\r\n/g, "\n").trim();
      const contentSha256 = computeSkillRevisionSha256({
        title,
        summary,
        instructions,
        requiresTools,
      });
      const id = makeRevisionId(input.skillSlug, contentSha256);
      const list = revisionsBySlug.get(input.skillSlug) ?? [];
      let existing = list.find((r) => r.contentSha256 === contentSha256);
      if (!existing) {
        seqCounter += 1;
        existing = {
          revisionId: id,
          skillSlug: input.skillSlug,
          contentSha256,
          title,
          summary,
          instructions,
          requiresTools,
          author: input.author.trim().slice(0, 120) || "system",
          reason: (input.reason ?? "").trim().slice(0, 200),
          createdAt: new Date().toISOString(),
          seq: seqCounter,
        };
        list.push(existing);
        revisionsBySlug.set(input.skillSlug, list);
      }
      heads.set(input.skillSlug, existing.revisionId);
      const { seq: _seq, ...view } = existing;
      return { ...view, isCurrent: true };
    },

    async listRevisions(skillSlug) {
      const list = [...(revisionsBySlug.get(skillSlug) ?? [])].sort(
        (a, b) => b.seq - a.seq,
      );
      const head = heads.get(skillSlug) ?? list[0]?.revisionId ?? null;
      return {
        currentRevisionId: head,
        revisions: list.map(({ seq: _seq, ...item }) => ({
          ...item,
          isCurrent: item.revisionId === head,
        })),
      };
    },

    async getRevision(skillSlug, revisionId) {
      const head = heads.get(skillSlug) ?? null;
      const found = (revisionsBySlug.get(skillSlug) ?? []).find(
        (r) => r.revisionId === revisionId,
      );
      if (!found) return null;
      const { seq: _seq, ...item } = found;
      return { ...item, isCurrent: item.revisionId === head };
    },

    async getCurrentRevision(skillSlug) {
      const head = heads.get(skillSlug);
      const list = revisionsBySlug.get(skillSlug) ?? [];
      const found = head
        ? list.find((r) => r.revisionId === head)
        : [...list].sort((a, b) => b.seq - a.seq)[0];
      if (!found) return null;
      const { seq: _seq, ...item } = found;
      return { ...item, isCurrent: true };
    },

    async diffRevisions(skillSlug, fromRevisionId, toRevisionId) {
      const fromRev = await this.getRevision(skillSlug, fromRevisionId);
      const toRev = await this.getRevision(skillSlug, toRevisionId);
      if (!fromRev) {
        throw new SkillVersionError(`找不到基准版本：${fromRevisionId}`, 404);
      }
      if (!toRev) {
        throw new SkillVersionError(`找不到目标版本：${toRevisionId}`, 404);
      }
      const diff = computeLineDiff(
        formatRevisionForDiff(fromRev),
        formatRevisionForDiff(toRev),
      );
      return {
        fromRevisionId: fromRev.revisionId,
        toRevisionId: toRev.revisionId,
        ...diff,
      };
    },

    async rollbackToRevision(skillSlug, revisionId) {
      const found = await this.getRevision(skillSlug, revisionId);
      if (!found) {
        throw new SkillVersionError(
          `找不到可回滚的目标版本：${revisionId}`,
          404,
        );
      }
      heads.set(skillSlug, found.revisionId);
      return { ...found, isCurrent: true };
    },

    async setSkillFiles(skillSlug, files, _updatedBy) {
      const validated = validateAuxFilesBatch(files);
      const now = new Date().toISOString();
      const views: SkillAuxFileView[] = validated.map((f) => ({
        path: f.path,
        content: f.content,
        sha256: f.sha256,
        bytes: f.bytes,
        readOnly: true,
        updatedAt: now,
      }));
      filesBySlug.set(skillSlug, views);
      return views;
    },

    async listSkillFiles(skillSlug) {
      return [...(filesBySlug.get(skillSlug) ?? [])];
    },

    async getSkillFile(skillSlug, filePath) {
      const safePath = validateSkillAuxFilePath(filePath);
      return (
        (filesBySlug.get(skillSlug) ?? []).find((f) => f.path === safePath) ??
        null
      );
    },

    async deleteSkillData(skillSlug) {
      revisionsBySlug.delete(skillSlug);
      heads.delete(skillSlug);
      filesBySlug.delete(skillSlug);
    },

    async listRequiresToolsMap(skillSlugs) {
      const map = new Map<string, string[]>();
      const targets = skillSlugs ?? [...heads.keys()];
      for (const slug of targets) {
        const rev = await this.getCurrentRevision(slug);
        if (rev) map.set(slug, [...rev.requiresTools]);
      }
      return map;
    },

    async listFileCountsMap(skillSlugs) {
      const map = new Map<string, number>();
      const targets = skillSlugs ?? [...filesBySlug.keys()];
      for (const slug of targets) {
        const count = filesBySlug.get(slug)?.length ?? 0;
        if (count > 0) map.set(slug, count);
      }
      return map;
    },
  };
}
