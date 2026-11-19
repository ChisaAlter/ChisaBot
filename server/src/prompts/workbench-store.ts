/**
 * 多角色系统提示词版本化工作台存储与运行态观测器。
 *
 * - 运行时幂等建表 `chisabot_prompt_overrides` 与 `chisabot_prompt_revisions`；
 * - 每个内置角色最多保留最近 30 条修订历史；
 * - 写入采用 `digest + expectedRevision` 双重乐观锁（冲突返回 HTTP 409），防并发覆盖；
 * - 支持一键恢复原版 / 上一版，并作为新版本入审计历史；
 * - `snapshot()` 为单回合冻结全部角色提示词副本，回合进行中不受后台编辑撕裂；
 * - `recordAssembly(role, sections)` 自动脱敏所有动态/用户相关段落为 `[动态内容已隐藏]`；
 * - `recordTools(role, tools)` 记录当轮生效工具清单并区分 Harness / MCP、静态 / 动态。
 */

import { createHash } from "node:crypto";
import {
  type EffectiveToolEntry,
  isPromptRole,
  MAX_PROMPT_BYTES,
  MAX_PROMPT_REVISIONS,
  PROMPT_ROLE_DESCRIPTORS,
  PROMPT_ROLES,
  type PromptAssemblySection,
  type PromptAssemblySnapshot,
  type PromptPreviousVersion,
  type PromptRevisionAction,
  type PromptRevisionFull,
  type PromptRole,
  type PromptRoleDetail,
  type PromptRoleSummary,
  REDACTED_DYNAMIC_PLACEHOLDER,
  type TurnToolsetSnapshot,
} from "../../../shared/prompt-workbench";
import type { Database } from "../db/client";

export class PromptWorkbenchError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "PromptWorkbenchError";
    this.status = status;
  }
}

export type PromptSaveInput = {
  digest: string;
  expectedRevision: number;
  content?: string;
  restore?: "original" | "previous";
};

export type AssemblySectionInput = {
  name: string;
  label?: string;
  kind?: "static" | "dynamic";
  content?: string;
};

export type ObservedToolInput = {
  name: string;
  identifier?: string;
  ref?: string;
  source?: "Harness" | "MCP";
  placement?: "static" | "dynamic";
  enabled?: boolean;
};

export type PromptOverrideState = {
  role: PromptRole;
  originalContent: string;
  originalDigest: string;
  currentContent: string;
  currentRevision: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type PromptWorkbenchStorage = {
  ensure(): Promise<void>;
  getOverride(role: PromptRole): Promise<PromptOverrideState | null>;
  listOverrides(): Promise<PromptOverrideState[]>;
  upsertOverride(state: PromptOverrideState): Promise<void>;
  listRevisions(role: PromptRole): Promise<PromptRevisionFull[]>;
  appendRevision(
    role: PromptRole,
    revision: PromptRevisionFull,
    maxKeep: number,
  ): Promise<void>;
};

export type PromptWorkbenchDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

export type PromptTurnSnapshot = {
  resolve(role: PromptRole, fallbackOriginal?: string): string;
  revisionOf(role: PromptRole): number;
  recordAssembly(
    role: PromptRole,
    sections: readonly AssemblySectionInput[],
    basePrompt?: string,
  ): PromptAssemblySnapshot;
  recordTools(
    role: PromptRole,
    tools: readonly ObservedToolInput[],
  ): TurnToolsetSnapshot;
};

export type PromptWorkbenchStore = {
  ensure(): Promise<void>;
  registerOriginal(role: PromptRole, content: string): Promise<void>;
  list(): Promise<PromptRoleSummary[]>;
  get(role: string): Promise<PromptRoleDetail>;
  save(
    role: string,
    input: PromptSaveInput,
    actorId: string,
  ): Promise<PromptRoleDetail>;
  snapshot(): Promise<PromptTurnSnapshot>;
  recordAssembly(
    role: PromptRole,
    sections: readonly AssemblySectionInput[],
    options?: { basePrompt?: string; revision?: number },
  ): PromptAssemblySnapshot;
  recordTools(
    role: PromptRole,
    tools: readonly ObservedToolInput[],
  ): TurnToolsetSnapshot;
};

const DYNAMIC_SECTION_NAME_RE =
  /(?:memory|standing|instruction|profile|user|identity|inbox|form|draft|untrusted|channel|group|attachment|account|secret|context)/i;

const SECTION_LABELS_ZH: Record<string, string> = {
  "agent-profile": "Bot 资料",
  "standing-instructions": "用户常驻指令",
  "personal-memory": "长期记忆",
  "user-identity": "用户身份",
  "user-form": "交互表单",
  "computer-guidance": "云端浏览器与工作区指引",
  "granted-tools": "已授权工具说明",
  "mcp-instructions": "MCP 扩展指令",
  "work-style": "表达风格与规范",
  "untrusted-content": "不可信内容隔离规范",
  provenance: "来源标注规范",
  skills: "已装配技能",
  "inbox-skills": "中途补充指令",
};

export function promptDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validatePromptContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new PromptWorkbenchError(400, "提示词内容必须是字符串。");
  }
  if (!content.trim()) {
    throw new PromptWorkbenchError(400, "提示词内容不能为空。");
  }
  if (content.includes("\0")) {
    throw new PromptWorkbenchError(400, "提示词内容不能包含空字节（NUL）。");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_PROMPT_BYTES) {
    throw new PromptWorkbenchError(
      400,
      `提示词内容超过大小上限（最大 ${MAX_PROMPT_BYTES} 字节）。`,
    );
  }
  return content;
}

function classifyToolSource(tool: ObservedToolInput): "Harness" | "MCP" {
  if (tool.source === "MCP" || tool.source === "Harness") {
    return tool.source;
  }
  const ref = tool.ref ?? tool.identifier ?? "";
  if (
    /\bmcp\b/i.test(ref) ||
    /^mcp[._:/-]/i.test(tool.name) ||
    /^composio[._:/-]/i.test(tool.name) ||
    /^plugin:/i.test(ref)
  ) {
    return "MCP";
  }
  return "Harness";
}

function normalizeAssemblySections(
  sections: readonly AssemblySectionInput[],
): PromptAssemblySection[] {
  return sections.slice(0, 80).map((section) => {
    const cleanName = section.name.trim().slice(0, 100) || "section";
    const label =
      section.label?.trim().slice(0, 120) ||
      SECTION_LABELS_ZH[cleanName] ||
      cleanName;
    const isDynamic =
      section.kind === "dynamic" ||
      (section.kind !== "static" && DYNAMIC_SECTION_NAME_RE.test(cleanName));
    if (isDynamic) {
      return {
        name: cleanName,
        label,
        kind: "dynamic",
        content: REDACTED_DYNAMIC_PLACEHOLDER,
        redacted: true,
      };
    }
    const rawContent = (section.content ?? "").trim();
    return {
      name: cleanName,
      label,
      kind: "static",
      content: rawContent.slice(0, 2000),
      redacted: false,
    };
  });
}

type OverrideRow = {
  role: string;
  original_content: string;
  original_digest: string;
  current_content: string;
  current_revision: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
};

type RevisionRow = {
  role: string;
  revision: number | string;
  content: string;
  digest: string;
  action: string;
  created_at: Date | string;
  updated_by: string | null;
};

function normalizeAction(value: string): PromptRevisionAction {
  if (value === "restore-original" || value === "restore-previous") {
    return value;
  }
  return "edit";
}

export function createPgPromptWorkbenchStorage(
  database: PromptWorkbenchDatabase,
): PromptWorkbenchStorage {
  const sql = database.$client;

  return {
    async ensure() {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS chisabot_prompt_overrides (
          role text PRIMARY KEY,
          original_content text NOT NULL,
          original_digest text NOT NULL,
          current_content text NOT NULL,
          current_revision integer NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now(),
          updated_by text
        );
        CREATE TABLE IF NOT EXISTS chisabot_prompt_revisions (
          role text NOT NULL,
          revision integer NOT NULL,
          content text NOT NULL,
          digest text NOT NULL,
          action text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_by text,
          PRIMARY KEY (role, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_chisabot_prompt_revisions_role_rev
          ON chisabot_prompt_revisions (role, revision DESC);
      `);
    },

    async getOverride(role) {
      const rows = await sql.unsafe<OverrideRow[]>(
        `SELECT role, original_content, original_digest, current_content,
                current_revision, updated_at, updated_by
         FROM chisabot_prompt_overrides
         WHERE role = $1`,
        [role],
      );
      const row = rows[0];
      if (!row || !isPromptRole(row.role)) return null;
      return {
        role: row.role,
        originalContent: row.original_content,
        originalDigest: row.original_digest,
        currentContent: row.current_content,
        currentRevision: Math.max(0, Number(row.current_revision) || 0),
        updatedAt: row.updated_at
          ? new Date(row.updated_at).toISOString()
          : null,
        updatedBy: row.updated_by ?? null,
      };
    },

    async listOverrides() {
      const rows = await sql.unsafe<OverrideRow[]>(
        `SELECT role, original_content, original_digest, current_content,
                current_revision, updated_at, updated_by
         FROM chisabot_prompt_overrides`,
      );
      const result: PromptOverrideState[] = [];
      for (const row of rows) {
        if (!isPromptRole(row.role)) continue;
        result.push({
          role: row.role,
          originalContent: row.original_content,
          originalDigest: row.original_digest,
          currentContent: row.current_content,
          currentRevision: Math.max(0, Number(row.current_revision) || 0),
          updatedAt: row.updated_at
            ? new Date(row.updated_at).toISOString()
            : null,
          updatedBy: row.updated_by ?? null,
        });
      }
      return result;
    },

    async upsertOverride(state) {
      await sql.unsafe(
        `INSERT INTO chisabot_prompt_overrides (
           role, original_content, original_digest, current_content,
           current_revision, updated_at, updated_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (role) DO UPDATE SET
           original_content = $2,
           original_digest = $3,
           current_content = $4,
           current_revision = $5,
           updated_at = $6,
           updated_by = $7`,
        [
          state.role,
          state.originalContent,
          state.originalDigest,
          state.currentContent,
          state.currentRevision,
          state.updatedAt ?? new Date().toISOString(),
          state.updatedBy,
        ],
      );
    },

    async listRevisions(role) {
      const rows = await sql.unsafe<RevisionRow[]>(
        `SELECT role, revision, content, digest, action, created_at, updated_by
         FROM chisabot_prompt_revisions
         WHERE role = $1
         ORDER BY revision ASC`,
        [role],
      );
      return rows.map((row) => ({
        number: Math.max(1, Number(row.revision) || 1),
        content: row.content,
        digest: row.digest,
        action: normalizeAction(row.action),
        createdAt: new Date(row.created_at).toISOString(),
        updatedBy: row.updated_by ?? null,
      }));
    },

    async appendRevision(role, revision, maxKeep) {
      await sql.unsafe(
        `INSERT INTO chisabot_prompt_revisions (
           role, revision, content, digest, action, created_at, updated_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (role, revision) DO UPDATE SET
           content = $3,
           digest = $4,
           action = $5,
           created_at = $6,
           updated_by = $7`,
        [
          role,
          revision.number,
          revision.content,
          revision.digest,
          revision.action,
          revision.createdAt,
          revision.updatedBy,
        ],
      );
      await sql.unsafe(
        `DELETE FROM chisabot_prompt_revisions
         WHERE role = $1
           AND revision NOT IN (
             SELECT revision FROM chisabot_prompt_revisions
             WHERE role = $1
             ORDER BY revision DESC
             LIMIT $2
           )`,
        [role, maxKeep],
      );
    },
  };
}

export function createMemoryPromptWorkbenchStorage(): PromptWorkbenchStorage {
  const overrides = new Map<PromptRole, PromptOverrideState>();
  const revisions = new Map<PromptRole, PromptRevisionFull[]>();

  return {
    async ensure() {},
    async getOverride(role) {
      const found = overrides.get(role);
      return found ? { ...found } : null;
    },
    async listOverrides() {
      return [...overrides.values()].map((item) => ({ ...item }));
    },
    async upsertOverride(state) {
      overrides.set(state.role, { ...state });
    },
    async listRevisions(role) {
      return (revisions.get(role) ?? []).map((item) => ({ ...item }));
    },
    async appendRevision(role, revision, maxKeep) {
      const list = [...(revisions.get(role) ?? [])];
      list.push({ ...revision });
      list.sort((left, right) => left.number - right.number);
      const trimmed = list.slice(-maxKeep);
      revisions.set(role, trimmed);
    },
  };
}

export function createPromptWorkbenchStore(
  storage: PromptWorkbenchStorage,
  options?: { now?: () => number },
): PromptWorkbenchStore {
  const nowFn = options?.now ?? Date.now;
  const assemblies = new Map<PromptRole, PromptAssemblySnapshot>();
  const toolsets = new Map<PromptRole, TurnToolsetSnapshot>();
  const roleLocks = new Map<PromptRole, Promise<void>>();

  async function withRoleLock<T>(
    role: PromptRole,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = roleLocks.get(role) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextChain = previous.then(() => current);
    roleLocks.set(role, nextChain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function defaultStateFor(role: PromptRole): PromptOverrideState {
    const descriptor = PROMPT_ROLE_DESCRIPTORS[role];
    const digest = promptDigest(descriptor.defaultPrompt);
    return {
      role,
      originalContent: descriptor.defaultPrompt,
      originalDigest: digest,
      currentContent: descriptor.defaultPrompt,
      currentRevision: 0,
      updatedAt: null,
      updatedBy: null,
    };
  }

  async function ensureRoleState(
    role: PromptRole,
  ): Promise<PromptOverrideState> {
    const existing = await storage.getOverride(role);
    if (existing) return existing;
    const initial = defaultStateFor(role);
    await storage.upsertOverride(initial);
    return initial;
  }

  async function ensure(): Promise<void> {
    await storage.ensure();
    for (const role of PROMPT_ROLES) {
      await ensureRoleState(role);
    }
  }

  async function registerOriginal(
    role: PromptRole,
    content: string,
  ): Promise<void> {
    const valid = validatePromptContent(content);
    const nextDigest = promptDigest(valid);
    await withRoleLock(role, async () => {
      const existing = await storage.getOverride(role);
      if (!existing) {
        await storage.upsertOverride({
          role,
          originalContent: valid,
          originalDigest: nextDigest,
          currentContent: valid,
          currentRevision: 0,
          updatedAt: null,
          updatedBy: null,
        });
        return;
      }
      if (existing.originalDigest === nextDigest) return;
      const unmodified =
        existing.currentRevision === 0 ||
        existing.currentContent === existing.originalContent;
      await storage.upsertOverride({
        ...existing,
        originalContent: valid,
        originalDigest: nextDigest,
        ...(unmodified ? { currentContent: valid } : {}),
      });
    });
  }

  function buildSummary(state: PromptOverrideState): PromptRoleSummary {
    const descriptor = PROMPT_ROLE_DESCRIPTORS[state.role];
    const assembly = assemblies.get(state.role);
    const toolset = toolsets.get(state.role);
    const observedAt = assembly?.recordedAt ?? toolset?.recordedAt ?? null;
    return {
      role: state.role,
      label: descriptor.label,
      description: descriptor.description,
      originalDigest: state.originalDigest,
      revision: state.currentRevision,
      modified: state.currentContent !== state.originalContent,
      updatedAt: state.updatedAt,
      hasObservation: Boolean(assembly || toolset),
      observedAt,
      toolCount: toolset?.tools.length ?? 0,
    };
  }

  async function list(): Promise<PromptRoleSummary[]> {
    const stored = await storage.listOverrides();
    const byRole = new Map(stored.map((item) => [item.role, item]));
    const summaries: PromptRoleSummary[] = [];
    for (const role of PROMPT_ROLES) {
      const state = byRole.get(role) ?? defaultStateFor(role);
      summaries.push(buildSummary(state));
    }
    return summaries;
  }

  async function get(rawRole: string): Promise<PromptRoleDetail> {
    if (!isPromptRole(rawRole)) {
      throw new PromptWorkbenchError(404, `未知的系统提示词角色：${rawRole}`);
    }
    const state = await ensureRoleState(rawRole);
    const revisions = await storage.listRevisions(rawRole);
    let previous: PromptPreviousVersion | null = null;
    if (revisions.length > 1) {
      const prev = revisions[revisions.length - 2];
      if (prev) {
        previous = {
          number: prev.number,
          content: prev.content,
          action: prev.action,
        };
      }
    } else if (revisions.length === 1 || state.currentRevision > 0) {
      previous = {
        number: 0,
        content: state.originalContent,
        action: "original",
      };
    }

    return {
      ...buildSummary(state),
      original: state.originalContent,
      content: state.currentContent,
      previous,
      revisions: revisions.map(({ content: _omit, ...meta }) => meta),
      assembly: assemblies.get(rawRole) ?? null,
      toolset: toolsets.get(rawRole) ?? null,
    };
  }

  async function save(
    rawRole: string,
    input: PromptSaveInput,
    actorId: string,
  ): Promise<PromptRoleDetail> {
    if (!isPromptRole(rawRole)) {
      throw new PromptWorkbenchError(404, `未知的系统提示词角色：${rawRole}`);
    }
    if (
      typeof input.digest !== "string" ||
      !input.digest.trim() ||
      typeof input.expectedRevision !== "number" ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      throw new PromptWorkbenchError(
        400,
        "保存提示词必须提供有效的 digest 与 expectedRevision 乐观锁字段。",
      );
    }

    await withRoleLock(rawRole, async () => {
      const state = await ensureRoleState(rawRole);
      if (input.digest !== state.originalDigest) {
        throw new PromptWorkbenchError(
          409,
          "原版基础提示词已更新，请重新加载后再保存。",
        );
      }
      if (input.expectedRevision !== state.currentRevision) {
        throw new PromptWorkbenchError(
          409,
          `提示词版本已变更为 v${state.currentRevision}（预期 v${input.expectedRevision}），请刷新后合并修改。`,
        );
      }

      const revisions = await storage.listRevisions(rawRole);
      let nextContent: string;
      let action: PromptRevisionAction = "edit";

      if (input.restore === "original") {
        nextContent = state.originalContent;
        action = "restore-original";
      } else if (input.restore === "previous") {
        if (state.currentRevision === 0) {
          throw new PromptWorkbenchError(
            409,
            "当前已是最初原版，没有上一版可恢复。",
          );
        }
        const prevRev =
          revisions.length > 1 ? revisions[revisions.length - 2] : undefined;
        nextContent = prevRev ? prevRev.content : state.originalContent;
        action = "restore-previous";
      } else if (input.restore !== undefined) {
        throw new PromptWorkbenchError(400, "无效的恢复目标。");
      } else {
        nextContent = validatePromptContent(input.content);
      }

      validatePromptContent(nextContent);

      if (nextContent === state.currentContent) {
        return;
      }

      const nextRevisionNumber = state.currentRevision + 1;
      const nowIso = new Date(nowFn()).toISOString();
      const revisionRecord: PromptRevisionFull = {
        number: nextRevisionNumber,
        createdAt: nowIso,
        digest: promptDigest(nextContent),
        action,
        content: nextContent,
        updatedBy: actorId,
      };
      await storage.appendRevision(
        rawRole,
        revisionRecord,
        MAX_PROMPT_REVISIONS,
      );
      await storage.upsertOverride({
        ...state,
        currentContent: nextContent,
        currentRevision: nextRevisionNumber,
        updatedAt: nowIso,
        updatedBy: actorId,
      });
    });

    return get(rawRole);
  }

  function recordAssembly(
    role: PromptRole,
    sectionsInput: readonly AssemblySectionInput[],
    options?: { basePrompt?: string; revision?: number },
  ): PromptAssemblySnapshot {
    const sections = normalizeAssemblySections(sectionsInput);
    const basePrompt =
      options?.basePrompt ?? PROMPT_ROLE_DESCRIPTORS[role].defaultPrompt;
    const previewBlocks = [
      basePrompt,
      ...sections.map((section) => `## ${section.label}\n${section.content}`),
    ];
    const snapshot: PromptAssemblySnapshot = {
      recordedAt: new Date(nowFn()).toISOString(),
      revision: options?.revision ?? 0,
      basePrompt,
      sections,
      assembledPreview: previewBlocks.join("\n\n"),
    };
    assemblies.set(role, snapshot);
    return structuredClone(snapshot);
  }

  function recordTools(
    role: PromptRole,
    toolsInput: readonly ObservedToolInput[],
  ): TurnToolsetSnapshot {
    const tools: EffectiveToolEntry[] = [];
    const seen = new Set<string>();
    for (const raw of toolsInput) {
      if (typeof raw.name !== "string") continue;
      const name = raw.name.trim().slice(0, 150);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const identifier = (raw.identifier ?? raw.ref ?? "").trim().slice(0, 150);
      tools.push({
        name,
        source: classifyToolSource(raw),
        identifier,
        placement: raw.placement === "dynamic" ? "dynamic" : "static",
        enabled: raw.enabled !== false,
      });
    }
    const snapshot: TurnToolsetSnapshot = {
      recordedAt: new Date(nowFn()).toISOString(),
      tools,
    };
    toolsets.set(role, snapshot);
    return structuredClone(snapshot);
  }

  async function snapshot(): Promise<PromptTurnSnapshot> {
    const stored = await storage.listOverrides();
    const frozen = new Map<
      PromptRole,
      { content: string; revision: number; originalContent: string }
    >();
    for (const role of PROMPT_ROLES) {
      const found = stored.find((item) => item.role === role);
      const fallback = defaultStateFor(role);
      const state = found ?? fallback;
      frozen.set(role, {
        content: state.currentContent,
        revision: state.currentRevision,
        originalContent: state.originalContent,
      });
    }

    return {
      resolve(role, fallbackOriginal) {
        const entry = frozen.get(role);
        if (!entry) {
          return (
            fallbackOriginal ?? PROMPT_ROLE_DESCRIPTORS[role].defaultPrompt
          );
        }
        // 若管理员覆盖过当前角色，使用冻结版本；未修改且调用方传入真实运行期原版时尊重调用方原版。
        if (entry.revision === 0 && fallbackOriginal) {
          return fallbackOriginal;
        }
        return entry.content;
      },
      revisionOf(role) {
        return frozen.get(role)?.revision ?? 0;
      },
      recordAssembly(role, sections, basePrompt) {
        const entry = frozen.get(role);
        return recordAssembly(role, sections, {
          basePrompt: basePrompt ?? entry?.content,
          revision: entry?.revision ?? 0,
        });
      },
      recordTools(role, tools) {
        return recordTools(role, tools);
      },
    };
  }

  return {
    ensure,
    registerOriginal,
    list,
    get,
    save,
    snapshot,
    recordAssembly,
    recordTools,
  };
}
