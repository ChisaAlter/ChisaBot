import { useCallback, useEffect, useRef } from "react";
import { botUi, setBotUi } from "./ui-memory";
import { lastHistoryEventWasPop, noteUserIntent, overlayHistoryActive, overlayHistoryMode } from "@/lib/overlay-back";

/**
 * 右栏「面板 | 计算机」按机器人记住（DESIGN.md §88.2）。
 *
 * 地址里的 `watch` 照旧（§23 / §79：刷新还在、后退能关、能发链接），但地址里没有它时（从左栏点回来、从设置 /
 * 管理回来、刷新了一个不带参数的地址），用这个机器人上次的选择——第一帧就画对，然后把地址补上
 * （replace，不多一条历史）。打开 / 关上（不管是人点的还是 `useComputerAutoWatch` 自动切的）都记下来。
 * 浏览器后退把 `watch` 去掉 = 关上，也记下来，所以后退仍然能关。
 *
 * @param writeUrl 改地址：`open` 是否打开，`replace` 只替换当前这条历史。
 * @returns `[打开着吗, 打开 / 关上]`
 */
export function useBotComputerTab(
  agentId: string | undefined,
  watch: boolean | undefined,
  writeUrl: (open: boolean, replace: boolean) => void,
  /** 聊天从藏着变回看得见时加一（DESIGN.md §98）：这期间地址的变化不是「浏览器后退关上」。 */
  epoch = 0,
): [boolean, (open: boolean) => void] {
  const remembered = botUi(agentId)?.computer === true;
  const open = watch === true ? true : watch === false ? false : remembered;

  const latest = useRef({ agentId, writeUrl });
  latest.current = { agentId, writeUrl };

  // 地址说开着、记的是关着（例如别人发来的链接、旧版本留下的地址）：以地址为准记下来。
  useEffect(() => {
    if (agentId && watch === true && !remembered) setBotUi(agentId, { computer: true });
  }, [agentId, watch, remembered]);

  // 用记下的选择打开的：把地址补上，地址和屏幕说同一件事。
  useEffect(() => {
    if (!agentId || !open || watch !== undefined) return;
    // 返回（popstate）带出来的这一帧不许写地址（CB-098 QA 第三轮）：那是在离开，不是在打开。
    if (overlayHistoryMode() && lastHistoryEventWasPop()) return;
    writeUrl(true, true);
  }, [agentId, open, watch, writeUrl]);

  // 同一个机器人页里，地址从「开着」变成没有（浏览器后退）= 关上。
  const previous = useRef<{ agentId: string | undefined; watch: boolean | undefined; epoch: number }>({ agentId, watch, epoch });
  useEffect(() => {
    const was = previous.current;
    previous.current = { agentId, watch, epoch };
    if (agentId && was.agentId === agentId && was.epoch === epoch && was.watch === true && watch !== true) {
      setBotUi(agentId, { computer: false });
    }
  }, [agentId, watch, epoch]);

  const setOpen = useCallback((next: boolean) => {
    const { agentId: id, writeUrl: write } = latest.current;
    noteUserIntent();
    setBotUi(id, { computer: next });
    // 手机上右栏抽屉开着时切标签只换地址不加历史（CB-098 QA）：否则后退会在「面板 / 计算机」之间来回，
    // 抽屉被地址重新拉开、又压一条记录，永远退不出页面。
    // 手机网页 / PWA 上 `watch` 一律 replace（CB-098 QA 第三轮）：整个右栏抽屉只占它自己那一条历史记录，
    // 切「面板 | 计算机」永远不加历史。桌面保持原来的 push（后退能关计算机）。
    write(next, overlayHistoryMode() || overlayHistoryActive());
  }, []);

  return [open, setOpen];
}
