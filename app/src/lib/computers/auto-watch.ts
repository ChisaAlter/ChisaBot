import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { JUMP_TO_ACTIVITY } from "@/components/computer/activity-jump";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { showPanels } from "@/lib/panels/rail-open";

/**
 * 右栏「面板 | 计算机」的自动切换（DESIGN.md §23）。
 *
 * - 机器人开始用计算机（这一轮第一次浏览器动作）→ 自动切到「计算机」。每轮只自动打开一次；
 *   这一轮里用户自己切回「面板」，就当作关掉了，本轮不再抢回来。
 * - 自动打开的，在机器人停手 {@link RETURN_AFTER_MS} 后自动切回「面板」——除非用户在计算机里
 *   动过手（点了画面、接管、输入密钥），那就留在计算机，等用户自己切。
 * - 用户手动打开的计算机永远不会被自动关掉。
 *
 * 状态本身仍是路由里的 `watch` 搜索参数：打开计算机是一次真正的导航，刷新还在、后退能关。
 */
export const RETURN_AFTER_MS = 12_000;

const engagedListeners = new Set<(botId: string) => void>();

/** 用户在计算机里动了手（点画面、接管、输入）。自动切回就此取消。 */
export function markComputerEngaged(botId: string): void {
  for (const listener of engagedListeners) listener(botId);
}

export function useComputerAutoWatch(
  agentId: string | undefined,
  watching: boolean,
  setWatching: (open: boolean) => void,
): void {
  const runEpoch = useRef<number | null>(null);
  const dismissedEpoch = useRef<number | null>(null);
  /** 当前这次打开是不是自动打开的。 */
  const auto = useRef(false);
  /** 自动打开后用户有没有在计算机里动过手。 */
  const engaged = useRef(false);
  /** 下一次 watching 变成 true 是我们自己设的。 */
  const opening = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigate = useNavigate();
  const latest = useRef({ watching, setWatching, navigate });
  latest.current = { watching, setWatching, navigate };

  // 打开 / 关闭的来源：我们设的是自动，其余都是用户手动。
  const previous = useRef(watching);
  useEffect(() => {
    const was = previous.current;
    previous.current = watching;
    if (!was && watching) {
      auto.current = opening.current;
      engaged.current = false;
      opening.current = false;
    } else if (was && !watching) {
      // 机器人还在这一轮里时关掉 = 这一轮不再自动打开。
      if (!opening.current) dismissedEpoch.current = runEpoch.current;
      auto.current = false;
      clearTimeout(timer.current);
    }
  }, [watching]);

  useEffect(() => {
    if (!agentId) return;
    const offEngaged = (botId: string) => {
      if (botId === agentId) engaged.current = true;
    };
    engagedListeners.add(offEngaged);
    const offActivity = onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      clearTimeout(timer.current);
      if (!latest.current.watching && dismissedEpoch.current !== activity.epoch) {
        opening.current = true;
        latest.current.setWatching(true);
      }
      timer.current = setTimeout(() => {
        if (!auto.current || engaged.current || !latest.current.watching) return;
        auto.current = false;
        latest.current.setWatching(false);
      }, RETURN_AFTER_MS);
    });
    // CB-101：聊天里点「在活动里看」= 用户手动打开计算机（不是自动打开，之后不会自动关掉）。
    const onJump = () => openForActivityJump(latest.current);
    window.addEventListener(JUMP_TO_ACTIVITY, onJump);
    return () => {
      window.removeEventListener(JUMP_TO_ACTIVITY, onJump);
      engagedListeners.delete(offEngaged);
      offActivity();
      clearTimeout(timer.current);
    };
  }, [agentId]);
}

/**
 * 「在活动里看」怎么把计算机亮出来（CB-101）：**不多压 history**。
 *
 * - 右栏 / 抽屉用 {@link showPanels} 打开：和人点「打开面板」走同一个入口（窄窗口 = `setPanelSheetOpen(true)`）。
 *   返回栈（#315 的 overlay-back）挂在这个入口上，所以跳转压的 marker 和手动打开完全一样，只有一个，
 *   按一次返回就关掉抽屉。#315 重做时如果换了打开抽屉的入口，这里跟着换。
 * - 切到「计算机」标签用 replace 改地址里的 `watch`：抽屉已经开着时，切标签不写 history。
 * - 已经在「计算机」上：什么都不做，移动端由 ComputerPanel 切到「活动」（也不走路由）。
 */
export function openForActivityJump(current: {
  watching: boolean;
  navigate: ReturnType<typeof useNavigate>;
}): void {
  showPanels();
  if (current.watching) return;
  void current.navigate({
    search: ((previous: Record<string, unknown>) => ({
      ...previous,
      watch: true,
    })) as never,
    replace: true,
  });
}
