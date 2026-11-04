import { setBotUi } from "@/lib/chat/ui-memory";
import {
  type OverlayCloseReason,
  overlayHistoryMode,
} from "@/lib/overlay-back";

/**
 * 关右栏抽屉（CB-098 QA 第三轮的状态模型 + 收起语义修正）。
 *
 * - `user`（「关闭面板」按钮 / 遮罩 / Esc）：只是藏起抽屉，**不是**「不看计算机了」——地址里的
 *   `watch`、按机器人记的标签（§88.2）、计算机本身都留着，下次拉开还在「计算机」。和宽窗口
 *   「收起右栏」、Ctrl+Alt+B、缩窗口收抽屉、划手势关抽屉同一条规则：都只管藏，不动计算机。
 *   手机网页上抽屉自己的标记记录退掉后 `watch` 不在地址里了，`useBotComputerTab` 会照记忆
 *   replace 补回来，不需要这里写。
 * - `back`（popstate / 安卓返回键 `__chisabotBack`）：才算离开——关计算机、清掉这个机器人
 *   「计算机开着」的记忆，**不写地址**：浏览器已经退到抽屉下面那条记录了，再写就会截断前进
 *   历史、把 `watch` 推回去，形成死循环。
 */
export function closeRailSheet(
  // onClick={onCollapse} 这类绑定会把 MouseEvent 当 reason 传进来：只认显式 "back"，其余一律按用户收起处理。
  reason: OverlayCloseReason | unknown,
  {
    agentId,
    closeComputer,
    closeSheet,
  }: {
    agentId: string | undefined;
    closeComputer: () => void;
    closeSheet: () => void;
  },
): void {
  if (reason !== "back") {
    closeSheet();
    return;
  }
  if (!overlayHistoryMode()) {
    closeComputer();
    closeSheet();
    return;
  }
  if (agentId) setBotUi(agentId, { computer: false });
  closeSheet();
}
