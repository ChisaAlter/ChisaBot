/**
 * 活动页给人看的状态与短句（PRD-P2-01 / P2-02）。
 * 状态码仍是英文机读值（failed / running…），展示时走这里；与 RUN_STATUS_ZH 同套路。
 */
export const ACTIVITY_STATUS_ZH: Record<string, string> = {
  running: "运行中",
  queued: "排队中",
  succeeded: "已完成",
  ok: "已完成",
  failed: "失败",
  stopped: "已停止",
  delivered: "已送达",
  retrying: "重试中",
  scheduled: "已安排",
  active: "进行中",
  done: "已完成",
  waiting: "等待中",
  "waiting for you": "等你处理",
  skipped: "已跳过",
  error: "出错",
  cancelled: "已取消",
};

/** 展示用；未知码原样返回（新状态不至于空白）。 */
export function activityStatusZh(status: string): string {
  return ACTIVITY_STATUS_ZH[status] ?? status;
}

/** 失败 / 卡住类：活动列表要显眼，不能当普通「进行中」。 */
export function activityStatusIsFailure(status: string): boolean {
  return (
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "stopped"
  );
}

/** 定时 run 卡在 running 超过此时长 → 活动页按失败展示（与 reclaimStuckRuns 20min 对齐）。 */
export const ACTIVITY_STALE_RUN_MS = 20 * 60 * 1000;
