import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { client } from "@/lib/client";
import { isChatRunning } from "@/lib/copilot/computer-activity";
import { useKeptVisible } from "@/lib/kept-visible";
import type { LiveSource } from "@/lib/panels/live-values";

/*
 * 实时面板的数据层（类型、查询键、轮询）。从 live-panels.tsx 拆出来，是为了让右栏外壳只为了一个
 * useLivePanels 就把整套卡片渲染（json-render、注册表、图表……）拖进每个页面的首屏（DESIGN.md §41.5）。
 * 卡片列表本身在 panel-rail.tsx 里按需加载。
 */

/**
 * 实时面板（server/src/live-panels，2026-10-13）：机器人用一句话的请求做出来、自己按计划刷新的卡片。
 *
 * 卡片只画结果：标题、内容（json-render，与对话里的 render_ui 同一套组件）、数据来源、更新时间。
 * 搭建中是骨架 + 机器人这一刻在做的那一步（§77.1）；刷新中底部「正在刷新…」；失败把原因用大白话写在卡片上。
 * ⋯ 菜单：立即刷新、刷新频率、撤销修改、删除（10 秒内可撤销）。没有 JSON、没有规范。
 */
export type LivePanel = {
  id: string;
  botId: string;
  title: string;
  status: "building" | "ready" | "failed";
  spec: string | null;
  sources: { name: string; url: string }[];
  instruction: string;
  refreshMinutes: number | null;
  /** 每天固定时刻刷新（「08:00」）；null = 按间隔。 */
  refreshAt?: string | null;
  refreshTimeZone?: string | null;
  /** 面板后台刷新使用的独立模型（CB-088）；null = 跟随机器人主模型。 */
  refreshModel?: string | null;
  /** 直连数据源（秒级，不靠机器人回合）：卡片可见时浏览器自己轮询。 */
  dataSources: LiveSource[];
  error: string | null;
  refreshedAt: string | null;
  nextRefreshAt: string | null;
  refreshing: boolean;
  canUndoEdit: boolean;
  createdAt: string;
};

export const livePanelKeys = { list: (botId: string) => ["live-panels", botId] as const };

/**
 * 聊天正在跑一轮（turn-compaction.ts 广播 chisabot-chat-running）。跑的时候 2.5 秒看一次面板：
 * 机器人 panel_create 之后卡片要马上出现在右栏，而不是等下一个 30 秒。
 */
export function useChatRunning() {
  // 卡片可能在这一轮开始之后才挂上（新建的面板）：先读当前状态，不等下一次广播。
  const [running, setRunning] = useState(() => isChatRunning());
  useEffect(() => {
    const on = (event: Event) => setRunning(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("chisabot-chat-running", on);
    return () => window.removeEventListener("chisabot-chat-running", on);
  }, []);
  return running;
}

export function useLivePanels(botId: string | undefined) {
  const running = useChatRunning();
  // 右栏藏着（设置 / 管理，DESIGN.md §98.3）时不轮询；回来时窗口聚焦 / 下一拍照常。
  const onScreen = useKeptVisible();
  const queryClient = useQueryClient();
  // 一轮刚结束：再看一次（面板可能在最后一步才填好）。
  useEffect(() => {
    if (!running && botId) void queryClient.invalidateQueries({ queryKey: livePanelKeys.list(botId) });
  }, [running, botId, queryClient]);
  return useQuery({
    enabled: Boolean(botId),
    queryKey: livePanelKeys.list(botId ?? ""),
    queryFn: () => client<LivePanel[]>(`/api/live-panels?botId=${encodeURIComponent(botId ?? "")}`, "items", { fallback: "面板无法加载" }),
    // 有卡片在搭建 / 刷新时 3 秒看一次，平时 30 秒（机器人在对话里建的卡片要马上出现）。
    refetchInterval: (query) => {
      if (!onScreen) return false;
      const items = query.state.data;
      if (running) return 2500;
      return items?.some((p) => p.status === "building" || p.refreshing) ? 3000 : 30_000;
    },
    refetchOnWindowFocus: true,
  });
}
