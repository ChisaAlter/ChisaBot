/**
 * delegate_task 参数还在流的时候任务卡上写什么（CB-023，DESIGN.md §38.3）：有任务名就用任务名；模型先写了
 * task（任务说明往往很长，任务名要等它写完）就先用说明的头一句（最多 18 字）；两样都还没有返回 undefined，
 * 卡片只写一行「正在安排后台任务…」。
 */
export function pendingWorkerTitle(given: { title?: unknown; task?: unknown } | undefined): string | undefined {
  const title = typeof given?.title === "string" ? given.title.trim() : "";
  if (title) return title;
  const task = typeof given?.task === "string" ? given.task.replace(/\s+/g, " ").trim() : "";
  if (!task) return undefined;
  const first = (task.split(/[。！？!?；;\n]/)[0] ?? "").trim() || task;
  const chars = Array.from(first);
  return chars.length > 18 ? `${chars.slice(0, 18).join("").trimEnd()}…` : first;
}
