import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type BotSharePackageManifest,
  SHARE_PACKAGE_SCHEMA_VERSION,
  type ShareBotProfile,
  type ShareExportDraft,
  type ShareExportZipRequest,
  type ShareImportCheckpoint,
  type ShareImportCheckpointStatus,
  type ShareImportCommitResult,
  type ShareImportDependencyStatus,
  type ShareImportPreview,
  type ShareMemoryCandidate,
  type ShareMemoryEntry,
  type SharePluginDependency,
  type ShareScheduleEntry,
  type ShareSkillEntry,
} from "../../../shared/sharing";
import type { Database } from "../db/client";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import {
  packSharePackage,
  SharePackageError,
  scanManifestSafety,
  selectMemoriesByIndices,
  unpackSharePackage,
} from "./package";

/**
 * Bot 配方与多文件技能分享服务：
 * - 组装脱敏导出草稿（记忆默认 selectedMemoryIndices = []，定时任务一律 enabled: false）；
 * - 校验并打包可下载 ZIP；
 * - 解析上传 ZIP，输出安全体检与依赖缺失报告；
 * - 基于 `chisabot_share_imports` 表实现 `(owner_user_id, import_id, package_digest)` 幂等断点续导；
 * - 提供 `export_bot_template` 技能工具，供 AI 在对话内引导用户组装配方草稿送入审阅页。
 */

export type SharingActor = {
  id: string;
  role: "admin" | "user";
};

export type SharingDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

export type ShareImportCheckpointStore = {
  ensure(): Promise<void>;
  findByImportId(
    ownerUserId: string,
    importId: string,
  ): Promise<ShareImportCheckpoint | null>;
  save(checkpoint: ShareImportCheckpoint): Promise<ShareImportCheckpoint>;
};

export type InstalledPluginInfo = {
  pluginId: string;
  name: string;
  tools: string[];
};

export type SharingAdapters = {
  getBot(actor: SharingActor, botId: string): Promise<ShareBotProfile | null>;
  createBot(
    actor: SharingActor,
    profile: ShareBotProfile,
  ): Promise<{ id: string; name: string }>;
  listSkills(actor: SharingActor): Promise<
    Array<
      ShareSkillEntry & {
        ownerUserId: string | null;
      }
    >
  >;
  skillOwner(slug: string): Promise<string | null | undefined>;
  installSkill(
    actor: SharingActor,
    skill: ShareSkillEntry,
    reason: string,
  ): Promise<void>;
  listSchedules(
    ownerUserId: string,
    botId: string,
  ): Promise<
    Array<{
      title: string;
      instruction: string;
      kind: "cron" | "once";
      cron?: string | null;
      timezone?: string;
    }>
  >;
  createPausedSchedule(
    actor: SharingActor,
    botId: string | null,
    schedule: ShareScheduleEntry,
  ): Promise<{ id: string; enabled: false }>;
  listCandidateMemories(
    ownerUserId: string,
    botId: string,
  ): Promise<Array<ShareMemoryEntry & { id?: string }>>;
  createMemory(
    actor: SharingActor,
    botId: string | null,
    memory: ShareMemoryEntry,
  ): Promise<{ id: string }>;
  listBotDependencies(
    actor: SharingActor,
    botId: string,
  ): Promise<SharePluginDependency[]>;
  listInstalledPlugins(actor: SharingActor): Promise<InstalledPluginInfo[]>;
};

type CheckpointRow = {
  owner_user_id: string;
  import_id: string;
  package_digest: string;
  status: string;
  bot_created: boolean;
  created_bot_id: string | null;
  skills_imported: string[] | string;
  schedules_imported: string[] | string;
  memories_imported: number[] | string;
  last_error: string | null;
  updated_at: Date | string;
};

function parseStringArray(raw: string[] | string | null | undefined): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string");
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseNumberArray(raw: number[] | string | null | undefined): number[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is number => Number.isInteger(v));
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is number => Number.isInteger(v))
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeStatus(raw: string): ShareImportCheckpointStatus {
  if (raw === "completed" || raw === "failed") return raw;
  return "pending";
}

function toCheckpoint(row: CheckpointRow): ShareImportCheckpoint {
  return {
    ownerUserId: row.owner_user_id,
    importId: row.import_id,
    packageDigest: row.package_digest,
    status: normalizeStatus(row.status),
    botCreated: Boolean(row.bot_created),
    createdBotId: row.created_bot_id ?? null,
    skillsImported: parseStringArray(row.skills_imported),
    schedulesImported: parseStringArray(row.schedules_imported),
    memoriesImported: parseNumberArray(row.memories_imported),
    lastError: row.last_error ?? null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** 生产 PostgreSQL 断点续导幂等存储（表 `chisabot_share_imports`）。 */
export function createPgShareImportStore(
  database: SharingDatabase,
): ShareImportCheckpointStore {
  const sql = database.$client;

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_share_imports (
        owner_user_id text NOT NULL,
        import_id text NOT NULL,
        package_digest text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        bot_created boolean NOT NULL DEFAULT false,
        created_bot_id text,
        skills_imported jsonb NOT NULL DEFAULT '[]'::jsonb,
        schedules_imported jsonb NOT NULL DEFAULT '[]'::jsonb,
        memories_imported jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_user_id, import_id, package_digest)
      );
      CREATE INDEX IF NOT EXISTS chisabot_share_imports_owner_import_idx
        ON chisabot_share_imports (owner_user_id, import_id);
    `);
  }

  async function findByImportId(
    ownerUserId: string,
    importId: string,
  ): Promise<ShareImportCheckpoint | null> {
    const rows = await sql.unsafe<CheckpointRow[]>(
      `SELECT * FROM chisabot_share_imports
       WHERE owner_user_id = $1 AND import_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [ownerUserId, importId],
    );
    return rows[0] ? toCheckpoint(rows[0]) : null;
  }

  async function save(
    checkpoint: ShareImportCheckpoint,
  ): Promise<ShareImportCheckpoint> {
    const rows = await sql.unsafe<CheckpointRow[]>(
      `INSERT INTO chisabot_share_imports (
         owner_user_id,
         import_id,
         package_digest,
         status,
         bot_created,
         created_bot_id,
         skills_imported,
         schedules_imported,
         memories_imported,
         last_error,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, now())
       ON CONFLICT (owner_user_id, import_id, package_digest)
       DO UPDATE SET
         status = EXCLUDED.status,
         bot_created = EXCLUDED.bot_created,
         created_bot_id = EXCLUDED.created_bot_id,
         skills_imported = EXCLUDED.skills_imported,
         schedules_imported = EXCLUDED.schedules_imported,
         memories_imported = EXCLUDED.memories_imported,
         last_error = EXCLUDED.last_error,
         updated_at = now()
       RETURNING *`,
      [
        checkpoint.ownerUserId,
        checkpoint.importId,
        checkpoint.packageDigest,
        checkpoint.status,
        checkpoint.botCreated,
        checkpoint.createdBotId,
        JSON.stringify(checkpoint.skillsImported),
        JSON.stringify(checkpoint.schedulesImported),
        JSON.stringify(checkpoint.memoriesImported),
        checkpoint.lastError,
      ],
    );
    const saved = rows[0];
    return saved
      ? toCheckpoint(saved)
      : { ...checkpoint, updatedAt: new Date().toISOString() };
  }

  return { ensure, findByImportId, save };
}

/** 内存版断点续导幂等存储（供零数据库单测使用）。 */
export function createMemoryShareImportStore(): ShareImportCheckpointStore {
  const rows = new Map<string, ShareImportCheckpoint>();

  return {
    async ensure() {},

    async findByImportId(ownerUserId, importId) {
      for (const row of rows.values()) {
        if (row.ownerUserId === ownerUserId && row.importId === importId) {
          return structuredClone(row);
        }
      }
      return null;
    },

    async save(checkpoint) {
      const key = `${checkpoint.ownerUserId}\0${checkpoint.importId}\0${checkpoint.packageDigest}`;
      const next: ShareImportCheckpoint = {
        ...structuredClone(checkpoint),
        updatedAt: new Date().toISOString(),
      };
      rows.set(key, next);
      return structuredClone(next);
    },
  };
}

const IMPORT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function safeFilenameSlug(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return ascii || "bot-recipe";
}

function buildImportSlugForConflict(
  baseSlug: string,
  importId: string,
): string {
  const suffix =
    importId
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .slice(0, 8) || "imp";
  const prefix = baseSlug.slice(0, Math.max(2, 40 - suffix.length - 1));
  return `${prefix.replace(/-+$/, "")}-${suffix}`;
}

function evaluateDependencies(
  dependencies: readonly SharePluginDependency[],
  installed: readonly InstalledPluginInfo[],
): ShareImportDependencyStatus[] {
  const byId = new Map(installed.map((item) => [item.pluginId, item]));
  const allInstalledTools = new Set(installed.flatMap((item) => item.tools));

  return dependencies.map((dep) => {
    const matched = byId.get(dep.pluginId);
    const missingTools = dep.tools.filter((tool) => {
      if (matched?.tools.includes(tool)) return false;
      if (allInstalledTools.has(tool)) return false;
      return true;
    });
    return {
      ...dep,
      installed: Boolean(matched),
      missingTools,
    };
  });
}

export type SharingServiceOptions = {
  checkpoints: ShareImportCheckpointStore;
  adapters: SharingAdapters;
  actorFor?: (userId: string) => Promise<SharingActor>;
};

export function createSharingService(options: SharingServiceOptions) {
  const { checkpoints, adapters } = options;
  const inFlightCommits = new Map<string, Promise<ShareImportCommitResult>>();

  async function ensure(): Promise<void> {
    await checkpoints.ensure();
  }

  /** 为指定 Bot 组装导出审阅草稿：记忆默认全空、定时任务强制暂停、依赖仅含元数据。 */
  async function buildExportDraft(
    actor: SharingActor,
    botId: string,
  ): Promise<ShareExportDraft> {
    const bot = await adapters.getBot(actor, botId);
    if (!bot) {
      throw new SharePackageError(
        "找不到指定的机器人，或无权导出该机器人。",
        404,
      );
    }

    const [rawSkills, rawSchedules, dependencies, rawMemories] =
      await Promise.all([
        adapters.listSkills(actor),
        adapters.listSchedules(actor.id, botId),
        adapters.listBotDependencies(actor, botId),
        adapters.listCandidateMemories(actor.id, botId),
      ]);

    const skills: ShareSkillEntry[] = rawSkills.map((skill) => ({
      slug: skill.slug,
      title: skill.title,
      summary: skill.summary,
      instructions: skill.instructions,
      ...(skill.requiresTools && skill.requiresTools.length > 0
        ? { requiresTools: [...skill.requiresTools] }
        : {}),
      ...(skill.files && skill.files.length > 0
        ? { files: skill.files.map((f) => ({ ...f })) }
        : {}),
    }));

    // 导出阶段强制将所有定时任务标记为暂停态 enabled: false
    const schedules: ShareScheduleEntry[] = rawSchedules.map((schedule) => ({
      title: schedule.title,
      instruction: schedule.instruction,
      kind: schedule.kind,
      ...(schedule.cron !== undefined ? { cron: schedule.cron } : {}),
      ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
      enabled: false,
    }));

    const candidateMemories: ShareMemoryCandidate[] = rawMemories.map(
      (memory, index) => ({
        index,
        ...(memory.id ? { id: memory.id } : {}),
        kind: memory.kind,
        ...(memory.subject !== undefined ? { subject: memory.subject } : {}),
        content: memory.content,
        ...(memory.context !== undefined ? { context: memory.context } : {}),
        ...(memory.createdAt ? { createdAt: memory.createdAt } : {}),
      }),
    );

    // 草稿体检针对默认导出项（不含未勾选的记忆）执行扫描
    const safety = scanManifestSafety({
      bot,
      skills,
      schedules,
      dependencies,
      memories: [],
    });

    return {
      botId,
      bot,
      skills,
      schedules,
      dependencies,
      candidateMemories,
      // 双端默认全空：必须用户逐条勾选 opt-in
      selectedMemoryIndices: [],
      selectedSkillSlugs: skills.map((s) => s.slug),
      selectedScheduleIndices: schedules.map((_, index) => index),
      safetyFindings: safety.findings,
      blocked: safety.blocked,
    };
  }

  /** 按用户确认的勾选清单校验脱敏并打包 `.zip`。 */
  async function exportZip(
    actor: SharingActor,
    request: ShareExportZipRequest,
  ): Promise<{
    bytes: Buffer;
    filename: string;
    digest: string;
    manifest: BotSharePackageManifest;
  }> {
    const draft = await buildExportDraft(actor, request.botId);

    const selectedSkillSet =
      request.selectedSkillSlugs !== undefined
        ? new Set(request.selectedSkillSlugs)
        : null;
    const skills = selectedSkillSet
      ? draft.skills.filter((skill) => selectedSkillSet.has(skill.slug))
      : draft.skills;

    const schedules =
      request.selectedScheduleIndices !== undefined
        ? selectMemoriesByIndices(
            draft.schedules,
            request.selectedScheduleIndices,
          )
        : draft.schedules;

    // 记忆严格按显式勾选索引过滤；未传或空数组则零条记忆导出
    const memories: ShareMemoryEntry[] = selectMemoriesByIndices(
      draft.candidateMemories,
      request.selectedMemoryIndices ?? [],
    ).map((item) => ({
      kind: item.kind,
      ...(item.subject !== undefined ? { subject: item.subject } : {}),
      content: item.content,
      ...(item.context !== undefined ? { context: item.context } : {}),
      ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    }));

    const bot: ShareBotProfile = {
      name: request.botOverrides?.name?.trim() || draft.bot.name,
      title: request.botOverrides?.title?.trim() || draft.bot.title,
      roleDescription:
        request.botOverrides?.roleDescription !== undefined
          ? request.botOverrides.roleDescription.trim()
          : draft.bot.roleDescription,
      ...(draft.bot.avatarSeed ? { avatarSeed: draft.bot.avatarSeed } : {}),
    };

    const manifest: BotSharePackageManifest = {
      schemaVersion: SHARE_PACKAGE_SCHEMA_VERSION,
      kind: "bot",
      exportedAt: new Date().toISOString(),
      bot,
      skills,
      schedules: schedules.map((s) => ({ ...s, enabled: false as const })),
      dependencies: draft.dependencies,
      memories,
    };

    const packed = packSharePackage(manifest);
    const filename = `${safeFilenameSlug(bot.name)}-recipe-${packed.digest.slice(0, 8)}.zip`;
    return {
      bytes: packed.bytes,
      filename,
      digest: packed.digest,
      manifest: packed.manifest,
    };
  }

  /** 解析上传 ZIP，输出审阅清单、缺失依赖标注、安全体检与默认空记忆勾选态。 */
  async function previewImport(
    actor: SharingActor,
    zipBytes: Uint8Array | Buffer,
  ): Promise<ShareImportPreview> {
    const unpacked = unpackSharePackage(zipBytes);
    const [installedPlugins, existingSkills] = await Promise.all([
      adapters.listInstalledPlugins(actor),
      adapters.listSkills(actor),
    ]);

    const existingSlugs = new Set(existingSkills.map((s) => s.slug));
    const conflictingSkillSlugs = unpacked.manifest.skills
      .map((s) => s.slug)
      .filter((slug) => existingSlugs.has(slug));

    const dependencies = evaluateDependencies(
      unpacked.manifest.dependencies,
      installedPlugins,
    );

    return {
      schemaVersion: unpacked.manifest.schemaVersion,
      kind: unpacked.manifest.kind,
      packageDigest: unpacked.digest,
      suggestedImportId: randomUUID(),
      ...(unpacked.manifest.bot ? { bot: unpacked.manifest.bot } : {}),
      skills: unpacked.manifest.skills,
      schedules: unpacked.manifest.schedules.map((s) => ({
        ...s,
        enabled: false as const,
      })),
      dependencies,
      candidateMemories: unpacked.candidateMemories,
      // 导入预览恒默认不选任何记忆
      selectedMemoryIndices: [],
      safetyFindings: unpacked.safetyFindings,
      blocked: unpacked.blocked,
      conflictingSkillSlugs,
      schedulesPaused: true,
    };
  }

  /** 执行幂等断点续导（按 `(owner_user_id, import_id, package_digest)` 记录逐项 checkpoint）。 */
  async function commitImport(
    actor: SharingActor,
    input: {
      zipBytes: Uint8Array | Buffer;
      importId: string;
      packageDigest?: string;
      selectedMemoryIndices?: number[];
    },
  ): Promise<ShareImportCommitResult> {
    const importId = input.importId.trim();
    if (!IMPORT_ID_RE.test(importId)) {
      throw new SharePackageError(
        "导入请求 ID（importId）格式无效，请重新预览。",
        400,
      );
    }

    const flightKey = `${actor.id}:${importId}`;
    const existingFlight = inFlightCommits.get(flightKey);
    if (existingFlight) return existingFlight;

    const run = performCommitImport(actor, {
      ...input,
      importId,
    });
    inFlightCommits.set(flightKey, run);
    try {
      return await run;
    } finally {
      inFlightCommits.delete(flightKey);
    }
  }

  async function performCommitImport(
    actor: SharingActor,
    input: {
      zipBytes: Uint8Array | Buffer;
      importId: string;
      packageDigest?: string;
      selectedMemoryIndices?: number[];
    },
  ): Promise<ShareImportCommitResult> {
    const unpacked = unpackSharePackage(input.zipBytes);
    if (unpacked.blocked) {
      const reasons = unpacked.safetyFindings
        .filter((f) => f.severity === "block")
        .map((f) => f.message)
        .join("；");
      throw new SharePackageError(
        `安全拦截：该配方包包含阻断级风险，禁止导入。${reasons}`,
        400,
        unpacked.safetyFindings,
      );
    }
    if (input.packageDigest && input.packageDigest !== unpacked.digest) {
      throw new SharePackageError(
        "配方包内容已变化，请重新上传并预览确认。",
        409,
      );
    }

    // 校验用户逐条勾选的记忆索引（未传则默认 []，绝不隐式导入记忆）
    const selectedIndices = [
      ...new Set(input.selectedMemoryIndices ?? []),
    ].sort((a, b) => a - b);
    // 利用 selectMemoriesByIndices 校验全部索引边界
    selectMemoriesByIndices(unpacked.manifest.memories, selectedIndices);

    const installedPlugins = await adapters.listInstalledPlugins(actor);
    const dependencies = evaluateDependencies(
      unpacked.manifest.dependencies,
      installedPlugins,
    );
    const missingDependencies = dependencies.filter(
      (dep) => !dep.installed || dep.missingTools.length > 0,
    );

    const existing = await checkpoints.findByImportId(actor.id, input.importId);
    if (existing && existing.packageDigest !== unpacked.digest) {
      throw new SharePackageError(
        "该 importId 已绑定另一份配方包，请重新预览生成新导入会话。",
        409,
      );
    }

    if (existing && existing.status === "completed") {
      return {
        importId: existing.importId,
        packageDigest: existing.packageDigest,
        reused: true,
        bot: existing.createdBotId
          ? {
              id: existing.createdBotId,
              name: unpacked.manifest.bot?.name ?? "已导入机器人",
            }
          : null,
        skillsImported: [...existing.skillsImported],
        schedulesImported: [...existing.schedulesImported],
        schedulesPaused: true,
        memoriesImportedCount: existing.memoriesImported.length,
        missingDependencies,
        checkpoint: existing,
      };
    }

    let checkpoint: ShareImportCheckpoint = existing
      ? {
          ...existing,
          status: "pending",
          lastError: null,
        }
      : {
          ownerUserId: actor.id,
          importId: input.importId,
          packageDigest: unpacked.digest,
          status: "pending",
          botCreated: false,
          createdBotId: null,
          skillsImported: [],
          schedulesImported: [],
          memoriesImported: [],
          lastError: null,
          updatedAt: new Date().toISOString(),
        };

    checkpoint = await checkpoints.save(checkpoint);

    try {
      // 1. 创建 Bot（若为 bot 配方且尚未创建）
      let botSummary: { id: string; name: string } | null =
        checkpoint.createdBotId
          ? {
              id: checkpoint.createdBotId,
              name: unpacked.manifest.bot?.name ?? "已导入机器人",
            }
          : null;

      if (unpacked.manifest.kind === "bot" && unpacked.manifest.bot) {
        if (!checkpoint.botCreated || !checkpoint.createdBotId) {
          const created = await adapters.createBot(
            actor,
            unpacked.manifest.bot,
          );
          checkpoint.botCreated = true;
          checkpoint.createdBotId = created.id;
          botSummary = created;
          checkpoint = await checkpoints.save(checkpoint);
        }
      }

      // 2. 逐个导入技能（已完成项直接跳过，避免重复写入）
      for (const skill of unpacked.manifest.skills) {
        const conflictSlug = buildImportSlugForConflict(
          skill.slug,
          input.importId,
        );
        if (
          checkpoint.skillsImported.includes(skill.slug) ||
          checkpoint.skillsImported.includes(conflictSlug)
        ) {
          continue;
        }
        const existingOwner = await adapters.skillOwner(skill.slug);
        const canWriteOriginal =
          existingOwner === undefined ||
          existingOwner === actor.id ||
          (actor.role === "admin" && existingOwner === null);
        const targetSlug = canWriteOriginal ? skill.slug : conflictSlug;

        await adapters.installSkill(
          actor,
          { ...skill, slug: targetSlug },
          `配方包导入 (${input.importId.slice(0, 8)})`,
        );
        checkpoint.skillsImported = [...checkpoint.skillsImported, targetSlug];
        checkpoint = await checkpoints.save(checkpoint);
      }

      // 3. 逐个导入定时任务（双端强制 enabled: false 暂停态）
      for (let i = 0; i < unpacked.manifest.schedules.length; i++) {
        if (i < checkpoint.schedulesImported.length) continue;
        const schedule = unpacked.manifest.schedules[i];
        if (!schedule) continue;
        const createdSchedule = await adapters.createPausedSchedule(
          actor,
          checkpoint.createdBotId,
          { ...schedule, enabled: false },
        );
        checkpoint.schedulesImported = [
          ...checkpoint.schedulesImported,
          createdSchedule.id,
        ];
        checkpoint = await checkpoints.save(checkpoint);
      }

      // 4. 逐条导入用户显式勾选的记忆（未勾选绝不导入）
      for (const memIndex of selectedIndices) {
        if (checkpoint.memoriesImported.includes(memIndex)) continue;
        const memory = unpacked.manifest.memories[memIndex];
        if (!memory) continue;
        await adapters.createMemory(actor, checkpoint.createdBotId, memory);
        checkpoint.memoriesImported = [
          ...checkpoint.memoriesImported,
          memIndex,
        ];
        checkpoint = await checkpoints.save(checkpoint);
      }

      checkpoint.status = "completed";
      checkpoint.lastError = null;
      checkpoint = await checkpoints.save(checkpoint);

      return {
        importId: checkpoint.importId,
        packageDigest: checkpoint.packageDigest,
        reused: Boolean(existing),
        bot: botSummary,
        skillsImported: [...checkpoint.skillsImported],
        schedulesImported: [...checkpoint.schedulesImported],
        schedulesPaused: true,
        memoriesImportedCount: checkpoint.memoriesImported.length,
        missingDependencies,
        checkpoint,
      };
    } catch (error) {
      checkpoint.status = "failed";
      checkpoint.lastError =
        error instanceof Error ? error.message.slice(0, 500) : "导入中途失败";
      await checkpoints.save(checkpoint).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 导出 `export_bot_template` 工具：供 AI 在对话内帮用户组装脱敏配方草稿，
   * 并引导用户前往「设置 → 分享给朋友」审阅、逐条决定是否附带记忆并下载 ZIP。
   */
  function tools(userId: string, currentBotId: string): GrantedTool[] {
    const parameters = z
      .object({
        botId: z
          .string()
          .max(128)
          .optional()
          .describe("要打包配方的机器人 ID；留空表示当前机器人"),
      })
      .strict();

    const exportTool: GrantedTool = {
      name: "export_bot_template",
      ref: "sharing/export_bot_template",
      description:
        "为当前或指定机器人组装脱敏配方导出草稿（含人设、多文件技能、强制暂停的定时任务和插件依赖元数据；默认零记忆，绝不含密钥或聊天记录），并引导用户到「设置 → 分享给朋友」逐条确认后下载 .zip。",
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} export_bot_template 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        }
        const actor = options.actorFor
          ? await options.actorFor(userId)
          : ({ id: userId, role: "user" } satisfies SharingActor);
        const targetBotId = parsed.data.botId?.trim() || currentBotId;
        try {
          const draft = await buildExportDraft(actor, targetBotId);
          const blocking = draft.safetyFindings.filter(
            (f) => f.severity === "block",
          );
          const warnings = draft.safetyFindings.filter(
            (f) => f.severity === "warn",
          );
          const lines = [
            `已为机器人「${draft.bot.name}」组装脱敏配方导出草稿：`,
            `- 技能：${draft.skills.length} 个${
              draft.skills.length
                ? `（${draft.skills
                    .slice(0, 8)
                    .map((s) => `/${s.slug}`)
                    .join("、")}${draft.skills.length > 8 ? "…" : ""}）`
                : ""
            }`,
            `- 定时任务：${draft.schedules.length} 个（导出与导入一律强制暂停 enabled: false）`,
            `- 依赖插件元数据：${draft.dependencies.length} 个（仅记录名称与工具名，不含任何密钥或登录态）`,
            `- 候选记忆：${draft.candidateMemories.length} 条（安全默认：已选中 0 条，必须用户在审阅页逐条勾选）`,
          ];
          if (blocking.length > 0) {
            lines.push(
              `⚠️ 检测到 ${blocking.length} 项阻断级安全风险，下载前需先清理：${blocking.map((b) => b.message).join("；")}`,
            );
          } else if (warnings.length > 0) {
            lines.push(
              `ℹ️ 安全提醒（${warnings.length} 项）：${warnings.map((w) => w.message).join("；")}`,
            );
          } else {
            lines.push("✅ 密钥与敏感文件体检通过。");
          }
          lines.push(
            "请引导用户打开「设置 → 分享给朋友」（/settings/share）中的「Bot 配方与多文件技能包导入 / 导出」区块审阅草稿、确认记忆勾选并下载 .zip。不要声称已完成导出或发布。",
          );
          return lines.join("\n");
        } catch (error) {
          return `${REFUSAL_MARKER} 组装配方草稿失败：${error instanceof Error ? error.message : "请重试"}`;
        }
      },
    };

    return [exportTool];
  }

  return {
    ensure,
    buildExportDraft,
    exportZip,
    previewImport,
    commitImport,
    tools,
  };
}

export type SharingService = ReturnType<typeof createSharingService>;

/** 内置导出配方指引技能预设（可在技能库中引用）。 */
export const EXPORT_BOT_TEMPLATE_SKILL_PRESET = {
  slug: "export-bot-template",
  title: "导出脱敏 Bot 配方包",
  category: "协作分享",
  summary:
    "当用户想把某个机器人和技能打包分享给朋友时，调用 export_bot_template 组装脱敏草稿并引导去分享页审阅下载 ZIP。",
  instructions: [
    "## 目标",
    "帮助用户安全、零凭据泄漏地将机器人人设、多文件技能、暂停态定时任务与插件依赖元数据打包为可移植 `.zip` 配方。",
    "",
    "## 安全守则",
    "1. 调用 `export_bot_template` 为目标机器人生成脱敏草稿，绝不读取历史聊天记录、数据库、私钥或 `.env` 文件拼装包体。",
    "2. 记忆默认全空（`selectedMemoryIndices = []`），如需附带少量背景事实，引导用户到「设置 → 分享给朋友」审阅页逐条勾选。",
    "3. 定时任务导出与导入一律保持暂停态（`enabled: false`），防止导入后立即产生意外外部动作。",
    "4. 不要在用户点击审阅页下载前声称配方包已导出或已分享。",
  ].join("\n"),
} as const;
