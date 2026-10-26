import { setBotUi } from "@/lib/chat/ui-memory";
import { type OverlayCloseReason, overlayHistoryMode, whenOverlayHistorySettled } from "@/lib/overlay-back";

/**
 * 关右栏抽屉（CB-098 QA 第三轮的状态模型）。
 *
 * - 桌面 / PC 客户端（不用历史记录承载返回）：保持原来的行为，关计算机、关抽屉。
 * - 手机网页 / PWA：
 *   - `back`（popstate / 返回键）是唯一真相：关抽屉、清掉这个机器人「计算机开着」的记忆，**不写地址**——
 *     浏览器已经退到抽屉下面那条记录了，再写就会截断前进历史、把 `watch` 推回去，形成死循环。
 *   - `user`（按钮 / 遮罩 / Esc）：同样清记忆、关抽屉；等抽屉自己那条记录退完，再在下面那条记录上
 *     replace 去掉 `watch`。
 */
export function closeRailSheet(
  reason: OverlayCloseReason,
  {
    agentId,
    closeComputer,
    closeSheet,
  }: { agentId: string | undefined; closeComputer: () => void; closeSheet: () => void },
): void {
  if (!overlayHistoryMode()) {
    closeComputer();
    closeSheet();
    return;
  }
  if (agentId) setBotUi(agentId, { computer: false });
  closeSheet();
  if (reason === "back") return;
  whenOverlayHistorySettled(closeComputer);
}
