import { createContext, useContext } from "react";
import { CONFIRM_RESUME_MARKER } from "../../../../shared/confirmations";
import { SCHEDULE_MARKER } from "../../../../shared/schedules";
import { noteOwnRevision } from "./use-conversation-sync";
import { WORKER_RESULT_MARKER } from "./workers";

/**
 * 重新生成 / 编辑后重发（DESIGN.md §67，CB-042）。频道聊天用这里的几个小函数。
 *
 * 流程（两边一样）：先请服务器从那条用户消息起截掉（`POST /api/conversations/threads/<id>/truncate`，只认本人的
 * 对话、对话没在回答），成功后本机也截到同一处，再照常发一轮（重新生成 = 原内容换一个新 id；编辑 = 新内容）。
 * 服务器回的新「版本」先记下（`noteOwnRevision`），本机的同步看到这个版本不会再重建一次；别的设备的同步
 * 看到版本变了就按服务器回放重建（截掉的气泡、卡片一起消失）。
 */

type Content = unknown;
type Row = { id: string; role: string; content?: Content };

export type TruncateMode = "regenerate" | "edit" | "withdraw";

export type EditableAttachment = {
  partIndex: number;
  label: string;
};

/** 最后一条用户消息的位置；没有为 -1。 */
export function lastUserIndex(messages: readonly Row[]): number {
  for (let at = messages.length - 1; at >= 0; at -= 1)
    if (messages[at]?.role === "user") return at;
  return -1;
}

/** 用户角色但不是人发的（后台任务结果、定时任务、确认后接着做）：不给编辑。 */
export function isEditableUserText(text: string): boolean {
  return !(
    text.startsWith(WORKER_RESULT_MARKER) ||
    text.startsWith(SCHEDULE_MARKER) ||
    text.startsWith(CONFIRM_RESUME_MARKER)
  );
}

/** 消息里的文字（字符串，或分段里的 text 段拼起来）。 */
export function contentText(content: Content): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * 编辑后的内容：纯文字直接换；带附件的分段换文字段（第一段文字的位置放新文字，其余文字段去掉），
 * 未被 `removedPartIndices` 标记移除的附件原样保留。新文字为空且没有剩余附件时返回 null（不能发空消息）。
 */
export function withEditedText(
  content: Content,
  text: string,
  removedPartIndices?: ReadonlySet<number>,
): Content | null {
  const said = text.trim();
  if (!Array.isArray(content)) return said ? said : null;
  const parts: unknown[] = [];
  let placed = false;
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    const isText =
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text";
    if (!isText) {
      if (!removedPartIndices?.has(index)) parts.push(part);
      continue;
    }
    if (!placed && said) parts.push({ ...(part as object), text: said });
    placed = true;
  }
  if (!placed && said) parts.unshift({ type: "text", text: said });
  return parts.length ? parts : null;
}

export class TruncateFailed extends Error {}

/** 请服务器截断。失败时抛 TruncateFailed（带中文原因）。 */
export async function truncateConversation(
  threadId: string,
  fromMessageId: string,
  mode: TruncateMode,
): Promise<{ removed: string[]; revision: string }> {
  let response: Response;
  try {
    response = await fetch(
      `/api/conversations/threads/${encodeURIComponent(threadId)}/truncate`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromMessageId, mode }),
      },
    );
  } catch {
    throw new TruncateFailed("网络连不上，稍后再试。");
  }
  const body = (await response.json().catch(() => null)) as {
    removed?: unknown;
    revision?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    const reason =
      typeof body?.error === "string" && /[\u4e00-\u9fa5]/.test(body.error)
        ? body.error
        : null;
    if (response.status === 409)
      throw new TruncateFailed(reason ?? "机器人正在回答，等它说完再试。");
    if (response.status === 404)
      throw new TruncateFailed(
        reason ?? "这条消息已经不在了（可能在别的设备上改过），刷新看看。",
      );
    throw new TruncateFailed(reason ?? "没能重发，稍后再试。");
  }
  const removed = Array.isArray(body?.removed) ? body!.removed.map(String) : [];
  const revision =
    typeof body?.revision === "string"
      ? body.revision
      : String(body?.revision ?? "");
  if (revision) noteOwnRevision(threadId, revision);
  return { removed, revision };
}

/**
 * 聊天里「重新生成」「编辑」两个动作，由聊天组件提供、消息组件读（消息组件按值 memo，回调走 context 不让它重渲染）。
 * `canAct` = 现在能不能做（没在回答、对话已就绪）。
 */
export type MessageActions = {
  canAct: boolean;
  regenerate: () => Promise<void>;
  edit: (
    messageId: string,
    text: string,
    removedPartIndices?: ReadonlySet<number>,
  ) => Promise<void>;
  withdraw?: (messageId: string) => Promise<void>;
};

export const MessageActionsContext = createContext<MessageActions | null>(null);

export function useMessageActions(): MessageActions | null {
  return useContext(MessageActionsContext);
}
