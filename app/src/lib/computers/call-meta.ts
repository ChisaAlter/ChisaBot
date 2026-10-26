/**
 * 这次前端工具调用的归属（CB-101），随计算机请求作为请求头发给服务端。
 *
 * 归属绑在这次调用自己的 AbortSignal 上：approval-tools 的包装给每次调用派生一个独立的 signal 并登记它的
 * 对话 / 轮次 / 工具调用 id，handler 把这个 signal 传给 callComputer，请求头就从这里取。
 * 几个工具并发时各拿各的，不会串；没有 signal（或 signal 没登记）的请求不带归属，服务端记为未归属，不去猜。
 */
export type ComputerCallMeta = {
  threadId?: string;
  runId?: string;
  toolCallId?: string;
};

const bySignal = new WeakMap<AbortSignal, ComputerCallMeta>();

/** 给这次调用派生一个独立的 signal（跟随 parent 中止），并把归属登记在它上面。 */
export function bindComputerCallMeta(
  meta: ComputerCallMeta | undefined,
  parent?: AbortSignal,
): AbortSignal {
  const controller = new AbortController();
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else
      parent.addEventListener("abort", () => controller.abort(parent.reason), {
        once: true,
      });
  }
  if (meta) bySignal.set(controller.signal, meta);
  return controller.signal;
}

export function computerCallHeaders(
  signal?: AbortSignal,
): Record<string, string> | undefined {
  const meta = signal ? bySignal.get(signal) : undefined;
  if (!meta) return undefined;
  const headers: Record<string, string> = {};
  if (meta.threadId) headers["x-chisabot-thread"] = meta.threadId;
  if (meta.runId) headers["x-chisabot-run"] = meta.runId;
  if (meta.toolCallId) headers["x-chisabot-tool-call"] = meta.toolCallId;
  return headers;
}
