import { z } from "zod";
import { normalizeMessageSearchParam } from "@/lib/channels/focus-message";

/*
 * 聊天地址的参数和路由 id，单独放一个轻文件（DESIGN.md §41.5）：路由文件（`/channel/$channelId`）和外壳只要这两样，
 * 以前从 `channel-page.tsx` 拿，等于把整个聊天（CopilotKit 对话、Markdown、工具卡片……）静态拖进了入口包。
 */
export const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the right column's 计算机 tab. */
  watch: z.boolean().optional(),
  /** DOG-04：Ctrl+K 正文命中深链到这条消息（滚入并短暂高亮）。 */
  message: z
    .string()
    .optional()
    .transform((v) => normalizeMessageSearchParam(v)),
});

/** 聊天路由的 id（外壳按它认出「地址是一段聊天」）。 */
export const CHANNEL_ROUTE_ID = "/_authed/_app/channel/$channelId";