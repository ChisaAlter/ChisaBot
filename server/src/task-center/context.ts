import type { TaskContext } from "../../../shared/task-center";

/** Each saved field is bounded by contextInputSchema (44,000 characters in total).
 * Keep all accepted text: a long project must not hide later preferences or exceptions. */
export function taskContextBrief(context: TaskContext): string {
  return [
    ["职责", context.responsibilities],
    ["进行中的项目", context.projects],
    ["目标", context.goals],
    ["技术兴趣", context.interests],
    ["日常习惯", context.habits],
    ["偏好与条件", context.preferences],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}：${value}`)
    .join("\n\n");
}
