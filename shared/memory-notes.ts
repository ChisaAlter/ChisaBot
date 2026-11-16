/**
 * 长期记忆（DESIGN.md §50，docs/memory.md）：机器人替你记住的笔记。
 *
 * 一条笔记 = 一种（kind）+ 一个主题（subject，人物 / 地点 / 项目的名字；资料、偏好、其它可空）+ 正文
 * + 适用情境（context：在哪、和谁、什么场合才成立）。日志（daily）一天一条，subject 是日期。
 * 笔记属于一个人，他的所有机器人共用；某个机器人可以在 设置 → 记忆 里关掉（不读也不写）。
 */
export const MEMORY_KINDS = [
  "profile",
  "preference",
  "person",
  "place",
  "project",
  "note",
  "daily",
] as const;
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

/** 四级记忆可见性：个人私密、单机器人专属私密、团队共享、公开只读。 */
export const MEMORY_VISIBILITIES = [
  "private",
  "bot_private",
  "team",
  "public",
] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const MEMORY_VISIBILITY_LABELS: Record<MemoryVisibility, string> = {
  private: "私人",
  bot_private: "机器人专属",
  team: "团队共享",
  public: "公开只读",
};

/** 主题必填的种类：同一主题只有一条，新内容并进去。 */
export const SUBJECT_KINDS: readonly MemoryKind[] = [
  "person",
  "place",
  "project",
];

export type MemoryNoteView = {
  id: string;
  kind: MemoryKind;
  subject: string | null;
  content: string;
  context: string | null;
  /** 四级隔离级别；缺省时由 shared 兼容推导。 */
  visibility?: MemoryVisibility;
  /** 是否为管理员统一配置的公共知识库条目（全员与所有机器人共享）。 */
  shared?: boolean;
  /** 谁写的：「你」或机器人名字（服务器存 agent id，列表接口换成名字）。 */
  author: "you" | "bot";
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryVisibilityNote = {
  ownerUserId: string;
  agentId: string | null;
  visibility?: MemoryVisibility | null;
  shared?: boolean | null;
  teamId?: string | null;
};

export type MemoryViewer = {
  userId: string;
  /** 当前读/搜/整理作用域下的机器人 ID；个人设置页或无特定机器人时可省略或为 null。 */
  agentId?: string | null;
  /** 是否处于群聊上下文；群聊中绝对屏蔽 private 与 bot_private 记忆。 */
  isGroupChat?: boolean;
  /** 已删除机器人 ID 集合；命中时其 bot_private 记忆对任何主体不可见。 */
  deletedBotIds?: ReadonlySet<string>;
  teamId?: string | null;
  isTeamMember?: boolean;
  isAdmin?: boolean;
};

export function isMemoryVisibility(value: unknown): value is MemoryVisibility {
  return (
    typeof value === "string" &&
    (MEMORY_VISIBILITIES as readonly string[]).includes(value)
  );
}

/** `visibility IN ('team', 'public')` 与历史 `shared = true` 保持双向一致。 */
export function isSharedVisibility(visibility: MemoryVisibility): boolean {
  return visibility === "team" || visibility === "public";
}

/** 兼容历史 `shared` 布尔列与缺省列：仅传 `shared: true` 时映射为 `'team'`。 */
export function resolveMemoryVisibility(input: {
  visibility?: unknown;
  shared?: boolean | null;
}): MemoryVisibility {
  if (isMemoryVisibility(input.visibility)) {
    if (input.visibility === "private" && input.shared === true) {
      return "team";
    }
    return input.visibility;
  }
  return input.shared ? "team" : "private";
}

/** 纯函数可见性判定：统一约束 private / bot_private / team / public 四级读隔离。 */
export function canReadMemoryNote(
  note: MemoryVisibilityNote,
  viewer: MemoryViewer,
): boolean {
  const visibility = resolveMemoryVisibility(note);
  switch (visibility) {
    case "private": {
      if (!note.ownerUserId || !viewer.userId) return false;
      return note.ownerUserId === viewer.userId && !viewer.isGroupChat;
    }
    case "bot_private": {
      const agentId = note.agentId;
      if (!agentId || !viewer.agentId || !note.ownerUserId || !viewer.userId) {
        return false;
      }
      return (
        note.ownerUserId === viewer.userId &&
        agentId === viewer.agentId &&
        !viewer.isGroupChat &&
        !viewer.deletedBotIds?.has(agentId)
      );
    }
    case "team": {
      if (viewer.isTeamMember === false) return false;
      if (note.teamId && viewer.teamId && note.teamId !== viewer.teamId) {
        return false;
      }
      return true;
    }
    case "public":
      return true;
    default: {
      const _exhaustive: never = visibility;
      return _exhaustive;
    }
  }
}

/** 修改/删除权限判定：`public` 仅管理员可写；`bot_private` 严格绑定未删所属机器人与私聊。 */
export function canModifyMemoryNote(
  note: MemoryVisibilityNote,
  viewer: MemoryViewer,
): boolean {
  const visibility = resolveMemoryVisibility(note);
  switch (visibility) {
    case "private": {
      if (!note.ownerUserId || !viewer.userId) return false;
      return note.ownerUserId === viewer.userId && !viewer.isGroupChat;
    }
    case "bot_private": {
      const agentId = note.agentId;
      if (!agentId || !viewer.agentId || !note.ownerUserId || !viewer.userId) {
        return false;
      }
      return (
        note.ownerUserId === viewer.userId &&
        agentId === viewer.agentId &&
        !viewer.isGroupChat &&
        !viewer.deletedBotIds?.has(agentId)
      );
    }
    case "team": {
      if (viewer.isAdmin) return true;
      if (!note.ownerUserId || !viewer.userId || viewer.isGroupChat) {
        return false;
      }
      if (viewer.isTeamMember === false) return false;
      return note.ownerUserId === viewer.userId;
    }
    case "public":
      return Boolean(viewer.isAdmin);
    default: {
      const _exhaustive: never = visibility;
      return _exhaustive;
    }
  }
}

export type MemoryBotSetting = { agentId: string; enabled: boolean };

export const MEMORY_LIMITS = {
  content: 4000,
  subject: 80,
  context: 300,
  /** 稳定前缀缓存块的最大字符预算。 */
  prefixChars: 4000,
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
export type MemoryTidyResult = MemoryTidyPreview & {
  batchId: string | null;
  summary: string;
};
export type MemoryTidyUndoResult = { restored: number; skipped: number };
export type MemoryTidyLast = {
  batchId: string;
  createdAt: string;
  mergedCount: number;
  deduplicatedCount: number;
};

/** 撤销上次整理的入口（聊天消息里给的链接）：设置 → 记忆，带上这次整理的 batchId。 */
export const tidyUndoHref = (batchId: string) =>
  `/settings/memory?undoTidy=${encodeURIComponent(batchId)}`;

/** 整理建议里的一组，写清种类、主题、谁记的、几条并一条；太长的写明不合并。确认弹窗和审批卡片共用这份文案。 */
export function tidyGroupLine(group: MemoryTidyGroup, who: string): string {
  const head = `${MEMORY_KIND_LABELS[group.kind]}「${group.title || "（无主题）"}」（${who}记的${group.context ? `，${group.context}` : ""}）`;
  return group.skipped === "too_long"
    ? `${head}：${group.count} 条合并后有 ${group.length} 字，超过 ${MEMORY_LIMITS.content} 字，不合并`
    : `${head}：${group.count} 条合并为 1 条`;
}

/** 整理建议的条目：每组一行，最多 limit 组，其余合成「还有 N 组」，最后一行是只去重行的条数。 */
export function tidyItems(
  preview: MemoryTidyPreview,
  who: (agentId: string | null) => string,
  limit = 12,
): string[] {
  const lines = preview.groups.map((group) =>
    tidyGroupLine(group, who(group.agentId)),
  );
  const out = lines.slice(0, limit);
  if (lines.length > limit) out.push(`……还有 ${lines.length - limit} 组`);
  if (preview.deduplicatedCount)
    out.push(`另有 ${preview.deduplicatedCount} 条笔记去掉重复的行`);
  return out;
}

/** 有没有真要改的（只有「太长不合并」的组不算）。 */
export const tidyHasWork = (preview: MemoryTidyPreview) =>
  preview.groups.some((group) => !group.skipped) ||
  preview.deduplicatedCount > 0;
