import { normalizeMessageSearchParam } from "@/lib/channels/focus-message";

export type ChatSearch = {
  settings?: boolean;
  /** Opens the Bot's screen in the right column's 计算机 tab. */
  watch?: boolean;
  /** Opens the non-polluting /side drawer for the current channel thread. */
  side?: boolean;
  /** DOG-04：Ctrl+K 正文命中深链到这条消息（滚入并短暂高亮）。 */
  message?: string;
};

/*
 * 聊天地址的参数和路由 id，单独放一个轻文件（DESIGN.md §41.5）：路由文件（`/channel/$channelId`）和外壳只要这两样，
 * 以前从 `channel-page.tsx` 拿，等于把整个聊天（会话客户端 对话、Markdown、工具卡片……）静态拖进了入口包；
 * 改用纯函数校验后，也不再为了 4 个简单查询参数把整份 Zod 运行时拉入全站首屏入口。
 */
export function chatSearchSchema(search: Record<string, unknown>): ChatSearch {
  const out: ChatSearch = {};
  if (typeof search.settings === "boolean") out.settings = search.settings;
  if (typeof search.watch === "boolean") out.watch = search.watch;
  if (typeof search.side === "boolean") out.side = search.side;
  if (typeof search.message === "string") {
    const message = normalizeMessageSearchParam(search.message);
    if (message !== undefined) out.message = message;
  }
  return out;
}

/** 聊天路由的 id（外壳按它认出「地址是一段聊天」）。 */
export const CHANNEL_ROUTE_ID = "/_authed/_app/channel/$channelId";
