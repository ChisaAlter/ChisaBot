/**
 * 当前这次前端工具调用的归属（CB-101），随计算机请求作为请求头发给服务端。
 *
 * 工具 handler 由 approval-tools 的包装统一调用，那里设置、结束时释放。同一时刻一般只有一个计算机
 * 工具在跑；真有并发时取最近设置的那个（最坏只是把一步挂到同一轮的另一个工具调用上，不会跨对话）。
 */
export type ComputerCallMeta = {
  threadId?: string;
  runId?: string;
  toolCallId?: string;
};

const stack: ComputerCallMeta[] = [];

export function setComputerCallMeta(
  meta: ComputerCallMeta | undefined,
): () => void {
  if (!meta) return () => undefined;
  stack.push(meta);
  return () => {
    const index = stack.lastIndexOf(meta);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function computerCallHeaders(): Record<string, string> | undefined {
  const meta = stack.at(-1);
  if (!meta) return undefined;
  const headers: Record<string, string> = {};
  if (meta.threadId) headers["x-chisabot-thread"] = meta.threadId;
  if (meta.runId) headers["x-chisabot-run"] = meta.runId;
  if (meta.toolCallId) headers["x-chisabot-tool-call"] = meta.toolCallId;
  return headers;
}
