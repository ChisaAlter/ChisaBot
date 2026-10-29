import { createFileRoute } from "@tanstack/react-router";
import { chatSearchSchema } from "@/components/channels/chat-search";

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  /*
   * 聊天本身不画在这里：它由外壳里的 `KeptChat`（components/layout/authed-shell.tsx）画（DESIGN.md §98），
   * 切到设置 / 待处理 / 设备再回来时还是同一个、没卸载过的聊天——不重新接入、不重读历史、正在写的回答不中断、
   * 滚动位置原样。这个路由只负责地址（参数和 `?settings` / `?watch`）。
   */
  component: () => null,
});
