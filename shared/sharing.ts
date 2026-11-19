/**
 * Bot 配方与多文件技能脱敏分享 ZIP 生态及技能治理共享类型（app ↔ server 共用）。
 *
 * 安全红线：
 * - 记忆双端默认全空（selectedMemoryIndices = []），必须用户逐条显式勾选 opt-in；
 * - 定时任务双端强制暂停（enabled: false）；
 * - 严格有界：单包最多 200 文件、压缩包上限 20 MiB、解压总字节上限 50 MiB、单辅助文件上限 256 KiB。
 */

export const SHARE_PACKAGE_SCHEMA_VERSION = 1 as const;

export const SHARE_LIMITS = {
  maxZipFiles: 200,
  maxZipArchiveBytes: 20 * 1024 * 1024,
  maxZipUncompressedBytes: 50 * 1024 * 1024,
  maxSkillAuxFiles: 50,
  maxSkillAuxFileBytes: 256 * 1024,
  maxSkills: 100,
  maxSchedules: 100,
  maxMemories: 500,
  maxPlugins: 100,
  maxPathLength: 240,
} as const;

export type SharePackageKind = "bot" | "skill";

export type ShareBotProfile = {
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed?: string;
};

export type ShareSkillFile = {
  /** 安全相对路径（POSIX 分隔符，不含前导斜杠或 `..`） */
  path: string;
  /** UTF-8 文本正文 */
  content: string;
  /** 内容 SHA-256（打包入 ZIP 时写入清单，解包时强制校验） */
  sha256?: string;
  bytes?: number;
};

export type ShareSkillEntry = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  /** 动态工具依赖声明：缺少任意一项时该技能对模型自动隐身 */
  requiresTools?: string[];
  /** 除 SKILL.md 外的只读辅助模板/脚本文件 */
  files?: ShareSkillFile[];
  /** 导入时自动剥离的自动触发器/特权 frontmatter 键名（显式审核元数据） */
  strippedFrontmatterKeys?: string[];
};

export type ShareScheduleEntry = {
  title: string;
  instruction: string;
  kind: "cron" | "once";
  cron?: string | null;
  timezone?: string;
  /** 导出与导入两端一律强制 false（暂停态） */
  enabled: false;
};

export type SharePluginDependency = {
  pluginId: string;
  name: string;
  vendor?: string;
  summary?: string;
  tools: string[];
};

export type ShareMemoryEntry = {
  kind: string;
  subject?: string | null;
  content: string;
  context?: string | null;
  createdAt?: string;
};

export type ShareMemoryCandidate = ShareMemoryEntry & {
  /** 候选索引（供逐条 opt-in 勾选） */
  index: number;
  id?: string;
};

export type BotSharePackageManifest = {
  schemaVersion: typeof SHARE_PACKAGE_SCHEMA_VERSION;
  kind: SharePackageKind;
  exportedAt: string;
  bot?: ShareBotProfile;
  skills: ShareSkillEntry[];
  schedules: ShareScheduleEntry[];
  dependencies: SharePluginDependency[];
  memories: ShareMemoryEntry[];
};

export type ShareSafetySeverity = "block" | "warn";

export type ShareSafetyFinding = {
  severity: ShareSafetySeverity;
  rule: string;
  message: string;
  location?: string;
  /** 已脱敏的片段摘要（永不回显完整明文密钥） */
  excerpt?: string;
};

export type ShareExportDraft = {
  botId: string;
  bot: ShareBotProfile;
  skills: ShareSkillEntry[];
  schedules: ShareScheduleEntry[];
  dependencies: SharePluginDependency[];
  /** 候选记忆列表（只读展示，默认全不选） */
  candidateMemories: ShareMemoryCandidate[];
  /** 默认恒为 []，需用户逐条勾选 opt-in */
  selectedMemoryIndices: number[];
  selectedSkillSlugs: string[];
  selectedScheduleIndices: number[];
  safetyFindings: ShareSafetyFinding[];
  blocked: boolean;
};

export type ShareExportZipRequest = {
  botId: string;
  selectedSkillSlugs?: string[];
  selectedScheduleIndices?: number[];
  /** 必须显式传入勾选的索引，缺省时严格为空 [] */
  selectedMemoryIndices?: number[];
  /** 允许审阅页微调导出人设文案 */
  botOverrides?: Partial<
    Pick<ShareBotProfile, "name" | "title" | "roleDescription">
  >;
};

export type ShareImportDependencyStatus = SharePluginDependency & {
  installed: boolean;
  missingTools: string[];
};

export type ShareImportPreview = {
  schemaVersion: typeof SHARE_PACKAGE_SCHEMA_VERSION;
  kind: SharePackageKind;
  packageDigest: string;
  suggestedImportId: string;
  bot?: ShareBotProfile;
  skills: ShareSkillEntry[];
  schedules: ShareScheduleEntry[];
  dependencies: ShareImportDependencyStatus[];
  /** 源包携带的候选记忆；默认全不选，需用户逐条勾选才导入 */
  candidateMemories: ShareMemoryCandidate[];
  /** 恒默认 [] */
  selectedMemoryIndices: number[];
  safetyFindings: ShareSafetyFinding[];
  blocked: boolean;
  conflictingSkillSlugs: string[];
  schedulesPaused: true;
};

export type ShareImportCheckpointStatus = "pending" | "completed" | "failed";

export type ShareImportCheckpoint = {
  importId: string;
  ownerUserId: string;
  packageDigest: string;
  status: ShareImportCheckpointStatus;
  botCreated: boolean;
  createdBotId: string | null;
  skillsImported: string[];
  schedulesImported: string[];
  memoriesImported: number[];
  lastError: string | null;
  updatedAt: string;
};

export type ShareImportCommitResult = {
  importId: string;
  packageDigest: string;
  reused: boolean;
  bot: { id: string; name: string } | null;
  skillsImported: string[];
  schedulesImported: string[];
  schedulesPaused: true;
  memoriesImportedCount: number;
  missingDependencies: ShareImportDependencyStatus[];
  checkpoint: ShareImportCheckpoint;
};

// ── 技能版本治理与多文件只读包 ──────────────────────────────────────────────

export type SkillRevisionView = {
  revisionId: string;
  skillSlug: string;
  contentSha256: string;
  title: string;
  summary: string;
  instructions: string;
  requiresTools: string[];
  author: string;
  reason: string;
  createdAt: string;
  isCurrent?: boolean;
};

export type SkillDiffLine = {
  type: "context" | "add" | "remove";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type SkillDiffResult = {
  fromRevisionId: string;
  toRevisionId: string;
  addedLines: number;
  removedLines: number;
  lines: SkillDiffLine[];
};

export type SkillAuxFileView = {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
  readOnly: true;
  updatedAt?: string;
};
