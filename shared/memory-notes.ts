/**
 * 长期记忆（DESIGN.md §50，docs/memory.md）：机器人替你记住的笔记。
 *
 * 一条笔记 = 一种（kind）+ 一个主题（subject，人物 / 地点 / 项目的名字；资料、偏好、其它可空）+ 正文
 * + 适用情境（context：在哪、和谁、什么场合才成立）。日志（daily）一天一条，subject 是日期。
 * 笔记属于一个人，他的所有机器人共用；某个机器人可以在 设置 → 记忆 里关掉（不读也不写）。
 */
export const MEMORY_KINDS = ["profile", "preference", "person", "place", "project", "note", "daily"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  profile: "个人资料",
  preference: "偏好",
  person: "人物",
  place: "地点",
  project: "项目与事项",
  note: "其他",
  daily: "日志",
};

/** 主题必填的种类：同一主题只有一条，新内容并进去。 */
export const SUBJECT_KINDS: readonly MemoryKind[] = ["person", "place", "project"];

export type MemoryNoteView = {
  id: string;
  kind: MemoryKind;
  subject: string | null;
  content: string;
  context: string | null;
  /** 是否为管理员统一配置的公共知识库条目（全员与所有机器人共享）。 */
  shared?: boolean;
  /** 谁写的：「你」或机器人名字（服务器存 agent id，列表接口换成名字）。 */
  author: "you" | "bot";
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryBotSetting = { agentId: string; enabled: boolean };

export const MEMORY_LIMITS = {
  content: 4000,
  subject: 80,
  context: 300,
  /** 一个人最多存多少条（超过就拒绝新增，提示去设置里整理）。 */
  perUser: 3000,
} as const;

/** 整理记忆的一组（DESIGN.md §50，审计 12-settings 必修 1）：同种类、同机器人、同情境、同主题（或正文完全相同）。 */
export type MemoryTidyGroup = {
  kind: MemoryKind;
  /** 主题，没有就是正文第一行（截短）。 */
  title: string;
  agentId: string | null;
  context: string | null;
  /** 这组有几条（合并后剩 1 条）。 */
  count: number;
  ids: string[];
  /** 合并（并去掉重复行）后的字数。 */
  length: number;
  /** too_long：合并后会超过 MEMORY_LIMITS.content，整组不合并。 */
  skipped: "too_long" | null;
};

/** 整理前的预览：确认弹窗列出将合并的组；确认时把 token 带回去，库里变了就不做。 */
export type MemoryTidyPreview = {
  token: string;
  groups: MemoryTidyGroup[];
  mergedCount: number;
  deduplicatedCount: number;
  totalRemaining: number;
};

/** batchId：这次整理的原文备份，撤销用；什么都没改时为 null。 */
export type MemoryTidyResult = MemoryTidyPreview & { batchId: string | null; summary: string };
export type MemoryTidyUndoResult = { restored: number; skipped: number };
export type MemoryTidyLast = { batchId: string; createdAt: string; mergedCount: number; deduplicatedCount: number };
