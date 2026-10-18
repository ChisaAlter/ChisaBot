/**
 * 「有人接管着计算机」时机器人的动作被拒（2026-10-13 生产事故）。
 *
 * 以前任何回合碰到 HumanHasControlError 都会挂起成「等待交还」：工作流（定时任务）这样做是对的——
 * 交还后从同一步接着跑；但聊天里没有任何东西会在交还后把这一轮接上，用户看到的是机器人说了句
 * 「我来救回面板」就再也没有下文；后台刷新面板时则把英文报错原样写在卡片上，还按失败退避。
 *
 * 现在：只有能续跑的工作流（routine，且不是定时 schedule: / IM im: / 实时面板 lp_…）还挂起等待；聊天、定时、面板刷新拿到
 * 一个普通的、中文的工具结果（{ ok:false, humanHasControl:true, reason }），机器人照常把话说完。
 * 面板刷新在这里记一笔，刷新服务据此把卡片标成「等你交还」并很快重试，而不是算作失败。
 */
import type { AuditInitiator } from "../audit";

export const HUMAN_CONTROL_ZH =
  "没有执行：这台计算机现在由用户接管着（右栏「计算机」标签上有琥珀色圆点）。用户点「交还」之前，命令、写文件和网页操作都会被拒绝，重试也没用。" +
  "用一句话如实告诉用户：请在右栏「计算机」里点「交还」，然后再让你继续；不要说已经完成或已经修好。";

const blocks = new Map<string, number>();

/** 某个后台回合（用 initiator id 标识，例如面板 id）的计算机动作因有人接管被拒。 */
export function noteHumanControlBlock(initiatorId: string | undefined) {
  if (!initiatorId) return;
  blocks.delete(initiatorId);
  blocks.set(initiatorId, Date.now());
  while (blocks.size > 200) {
    const oldest = blocks.keys().next().value;
    if (oldest === undefined) break;
    blocks.delete(oldest);
  }
}

/** 读出并清掉：这个 initiator 从 since 起是否因有人接管而被拒过。 */
export function takeHumanControlBlock(initiatorId: string, since: number): boolean {
  const at = blocks.get(initiatorId);
  blocks.delete(initiatorId);
  return at !== undefined && at >= since;
}

/**
 * 只有能从同一步接着跑的工作流才挂起等交还。
 * 定时任务 / IM（用户不在场）挂起后确认卡或交还 UI 对不上，会挂死对话（FIX-02）；
 * 聊天、实时面板刷新（lp_…）也不挂起。
 */
export function suspendsOnHumanControl(initiator: AuditInitiator | undefined): boolean {
  if (initiator?.kind !== "routine") return false;
  const id = initiator.id;
  if (id.startsWith("lp_") || id.startsWith("schedule:") || id.startsWith("im:")) return false;
  return true;
}

/** 定时任务 / IM：用户不在场，不能弹确认 / 交还；需要人在场的步骤应快速失败。 */
export function isUnattendedInitiator(initiator: AuditInitiator | undefined): boolean {
  if (initiator?.kind !== "routine") return false;
  const id = initiator.id;
  return id.startsWith("schedule:") || id.startsWith("im:");
}

type ReleaseListener = (ownerUserId: string) => void;
const releaseListeners = new Set<ReleaseListener>();

/** 有人把计算机交还给机器人时通知（实时面板据此马上重刷因接管而推迟的卡片）。 */
export function onControlReleased(listener: ReleaseListener) {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

export function notifyControlReleased(ownerUserId: string) {
  for (const listener of releaseListeners) {
    try {
      listener(ownerUserId);
    } catch {}
  }
}
