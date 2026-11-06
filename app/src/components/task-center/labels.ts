import type {
  TaskCategory,
  TaskRisk,
  TaskStatus,
} from "../../../../shared/task-center";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: "待安排",
  queued: "排队中",
  planning: "制定计划",
  running: "执行中",
  waiting_dependencies: "等待前序任务",
  waiting_approval: "等待确认",
  paused: "已暂停",
  succeeded: "已交付",
  failed: "执行失败",
  cancelled: "已取消",
};
export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  research: "信息研究",
  development: "研发",
  documents: "文档",
  project: "项目管理",
  schedule: "日程",
  communication: "沟通",
  decision: "决策",
  other: "其他",
};
export const RISK_LABELS: Record<TaskRisk, string> = {
  read: "只读",
  internal: "内部工作",
  external: "对外沟通",
  sensitive: "敏感操作",
  publish: "内容发布",
};
export const ACTIVE_STATUSES: TaskStatus[] = [
  "queued",
  "planning",
  "running",
  "waiting_dependencies",
];
export function taskDate(value: string | null): string {
  if (!value) return "尚未运行";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
export function safeTaskUrl(
  value: string | undefined | null,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
