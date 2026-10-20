/**
 * 正在跑的浏览器侧工具（`computer_*` 这些前端工具）——和它们最后一次有动静的时刻。
 *
 * 为什么需要它（2026-10-20 真机，「运行命令」一直失败，报 `signal is aborted without reason`）：
 *
 * 前端工具是浏览器执行的：模型说完话，这一轮的 SSE 就结束了，浏览器拿着 `computer_run_command`
 * 去 `POST /api/approvals/computer/<bot>`，在它自己的计算机上同步跑命令，可能跑满 600 秒。这段时间里
 * 聊天那头**一个字节的进展都没有**：没有模型输出、没有工具结果、`agent.messages` 也不动。
 *
 * `channel-chat.tsx` 的发送看门狗（DOG-01）只看「整轮多久没结束」，于是 12 秒一到就 `stopAgent()`：
 * CopilotKit 的 `abortCurrentRun()` 用的是**不带 reason 的** `AbortController.abort()`，正在跑的工具
 * 立刻收到一个 AbortError（Chromium 的文案就是 `signal is aborted without reason`），
 * `neverThrow` 见 signal 已中止就照原样抛回去 → 工具结果变成 `Error: signal is aborted without reason`
 * → 这一轮以「运行命令 这一步出错」收尾。安装、构建、任何超过十几秒的命令都必死。
 *
 * 这里的计数让看门狗能分清「一直没反应」和「一个长工具正在干活」：工具跑着，进展时刻就是现在。
 */

/**
 * 单个前端工具最多替它「作证」多久。
 *
 * 工具跑着就算有进展，但如果它自己挂死了（对端不回、fetch 永不 settle），看门狗就永远不响、输入框
 * 一直转。超过这个时长后不再当作有进展，让 180 秒的静默兜底重新生效。比命令上限（600 秒）宽松，
 * 因为一个工具里可能连着跑好几条命令。
 */
const MAX_TOOL_CREDIT_MS = 15 * 60_000;

let running = 0;
let startedAt = 0;
let touchedAt = 0;

/**
 * 一个前端工具开始执行。返回的函数在结束（成功 / 失败 / 中止）时必须调用一次——放在 `finally` 里。
 *
 * 幂等：同一个工具调用重复调用返回的结束函数只生效一次，异常路径重复调用不会把计数减成负数。
 */
export function beginFrontendTool(now = Date.now()): (at?: number) => void {
  if (running === 0) startedAt = now;
  running += 1;
  touchedAt = now;
  let done = false;
  return (at = Date.now()) => {
    if (done) return;
    done = true;
    running = Math.max(0, running - 1);
    touchedAt = at;
    if (running === 0) startedAt = 0;
  };
}

/** 工具内部有进展（例如命令的输出在回来）时手动打点；多数情况不需要，开始与结束已经够用。 */
export function noteFrontendToolActivity(now = Date.now()): void {
  touchedAt = now;
}

/** 有几个前端工具正在执行。 */
export function frontendToolsRunning(): number {
  return running;
}

/**
 * 看门狗问的「最近一次有进展是什么时候」。
 *
 * - 没有工具在跑：返回最后一次开始 / 结束的时刻（0 表示这次挂载里还没有过）。
 * - 有工具在跑且没超过 `MAX_TOOL_CREDIT_MS`：返回现在，也就是「一直在动」。
 * - 有工具在跑但已经超过上限：停在开始后 `MAX_TOOL_CREDIT_MS` 那一刻，让静默重新累计。
 */
export function frontendToolProgressAt(now = Date.now()): number {
  if (running === 0) return touchedAt;
  const capped = startedAt > 0 ? Math.min(now, startedAt + MAX_TOOL_CREDIT_MS) : now;
  return Math.max(touchedAt, capped);
}

/** 测试用：把登记表清干净，避免一个用例影响下一个。 */
export function resetFrontendToolActivity(): void {
  running = 0;
  startedAt = 0;
  touchedAt = 0;
}
