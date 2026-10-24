/**
 * Why the last turn ended without an answer, for a surface that has to say so itself.
 *
 * A run can end three ways. It finishes, which needs no explanation. It fails in the browser, which
 * arrives as an error. Or the Bot's own stream stops producing anything and this deployment ends the
 * turn for it, which arrives as a RUN_ERROR carrying the sentence the server wrote (see
 * server/src/channels/stall-guard.ts). The last two both leave the same hole on screen: the composer
 * unlocks, the spinner disappears, and nothing says what happened.
 *
 * The reason is kept as a sentence rather than a flag because the reasons are not interchangeable. A
 * Bot that refused, a Bot whose endpoint is down and a Bot that simply stopped talking are three
 * different things to be told, and only the thing that ended the turn knows which one it was.
 */

/**
 * The sentence to show, in the words of whatever ended the turn.
 *
 * Falls back only when there is genuinely nothing to pass on. Saying "the Bot stopped without saying
 * why" is honest about that; inventing a cause would not be, and this is the one moment a person has
 * no other way to find out what went wrong.
 */
export function stoppedReason(reported: unknown): string {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  return friendlyStopReason(said.trim()) || "机器人没有给出原因就停止了。";
}

/**
 * 模型 / 网关报错翻成人话（2026-10-15 成熟度扫查：额度用完时顶上是一整句英文
 * 「Failed after 3 attempts. Last error: ClinePass: Error 429: Daily free limit reached…」）。
 * 认得的错误给一句中文 + 下一步；不认得的英文前面加「这一轮出错了：」保留原文便于排查；已经是中文的原样。
 */
export function friendlyStopReason(said: string): string {
  if (!said) return "";
  const text = said.replace(/^Failed after \d+ attempts?\.\s*(Last error:\s*)?/i, "");
  const wait = /try again in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(text);
  const when =
    wait && (wait[1] || wait[2])
      ? `，约 ${[wait[1] ? `${Number(wait[1])} 小时` : "", wait[2] ? `${Number(wait[2])} 分钟` : ""].filter(Boolean).join(" ")}后恢复`
      : "";
  const stalled = /^(.+?) stopped responding\. Nothing arrived from it for (an? |\d+ )(second|minute)s?/i.exec(text);
  if (stalled) {
    const n = /^\d/.test(stalled[2]) ? Number.parseInt(stalled[2], 10) : 1;
    return `「${stalled[1]}」${n} ${/minute/i.test(stalled[3]) ? "分钟" : "秒"}没有任何回应，这一轮已结束。再发一次试试；一直这样就换一个模型。`;
  }
  if (/only be used from within OpenCode/i.test(text))
    return "这个模型只能在 OpenCode 客户端里用。点输入框右下角的模型名，换一个模型再发。";
  if (/daily (free )?limit|free (tier|limit)|quota|insufficient.*(credit|balance)|\b402\b/i.test(text))
    return `这个模型的额度用完了${when}。点输入框右下角的模型名，换一个模型再发。`;
  if (/\b429\b|rate.?limit|too many requests/i.test(text))
    return `模型请求太频繁，被暂时限流了${when}。稍等一会儿再发，或换一个模型。`;
  if (/\b401\b|unauthori[sz]ed|invalid.*api.?key|authentication/i.test(text))
    return "模型密钥无效或已过期。请管理员到 管理后台 → 模型 检查连接。";
  if (/context (length|window)|maximum context|too many tokens|prompt is too long/i.test(text))
    return "这段对话太长，超出了模型能读的范围。点 ⋯ → 新话题 重新开始。";
  if (/AI SDK stream error|stream error|connection lost|GOAWAY|server_shutting_down|premature close/i.test(text))
    return "模型的连接中途断开了，这一轮的回答没写完。再发一次试试；经常这样就换一个模型。";
  if (/timed? ?out|ETIMEDOUT|deadline/i.test(text)) return "模型太久没有回应。稍后再发，或换一个模型。";
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|network|\b50[234]\b|bad gateway|service unavailable|overloaded/i.test(text))
    return "暂时连不上模型服务。稍后再发，或换一个模型。";
  // 模型被服务商下线（2026-10-20 线上：space-bunny-free → 410「…has been deprecated」）。
  // 以前落到底下那句英文原样的「这一轮出错了：…」，看不出是模型没了。
  if (/deprecat|retired|已下线|不再提供/i.test(text))
    return "这个模型已经下线了（服务商不再提供）。点输入框右下角的模型名换一个再发。";
  // 浏览器 AbortError 或运行被取消的原话：这一轮是被中断的，不是模型出错，别让人以为是程序坏了。
  if (/aborted without reason|AbortError|signal is aborted|This run was stopped|HERMES_RUN_CANCELLED/i.test(text))
    return "这一轮被中断了（不是模型出错）。再发一次试试；一直这样就刷新一下页面。";
  if (/[\u4e00-\u9fff]/.test(said)) return said;
  return `这一轮出错了：${text}`;
}

/**
 * Watch one Bot's runs and hold on to the reason the last one ended, if it ended badly.
 *
 * Bound by agent id rather than handed an agent, so a caller that only renders the packaged chat
 * does not have to reach for one: `useAgent` returns the same shared instance the chat itself binds
 * to, so this watches exactly the runs that chat starts.
 *
 * Cleared when the next run begins rather than on a timer. A sentence about a turn that is over
 * should stay until there is something newer to look at, and the person deciding when that is is the
 * one who sends the next message.
 */
let userStoppedAt = 0;
/**
 * 用户自己按了停止（2026-10-13 第四轮）。停止会以「运行失败（中止）」的形式回来，以前顶上就冒一条红色
 * 「…停止了」——可那不是出错，是人让它停的；对话里那一轮末尾已经挂了「已停止」。之后 15 秒内的失败不报。
 */
export function markUserStop(): void {
  userStoppedAt = Date.now();
}
const stoppedByUser = () => Date.now() - userStoppedAt < 15_000;

let approvalPausedAt = 0;
/**
 * 一步要用户批准，这一轮先停下等审批卡（approval-tools 里 stopAgent）。这是正常的暂停，不是出错：
 * 之后 15 秒内那次中止不报，也不当成「没说完就停了」（§100）。
 */
export function markApprovalPause(): void {
  approvalPausedAt = Date.now();
}
export const pausedForApproval = () => Date.now() - approvalPausedAt < 15_000;

/** 一个 run 失败是不是因为中止（停止 / 等审批），而不是出错。 */
export function isAbortFailure(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\babort(ed)?\b|This run was stopped|HERMES_RUN_CANCELLED/i.test(message);
}

/**
 * 这一轮做完一步之后没有接着做、也没有任何说明就结束了（§100）。
 *
 * 浏览器里的工具（点击、填写…）每做一步，CopilotKit 都要再发起一轮把结果交给模型。工具处理函数出错、
 * 续轮次数到上限，都会让它不再发起——最后一条是工具结果，后面什么都没有，界面上就是「做了 N 步」然后安静了。
 * 返回要显示的中文原因；这一轮正常结束（最后是回答，或是在等审批 / 等用户处理）返回 null。
 *
 * 只看这一轮新加的消息（`before` 是发送前已有的消息 id），不翻旧账。
 */
export function unfinishedTurnReason(
  messages: readonly { id: string; role: string; content?: unknown; toolCallId?: string; toolCalls?: readonly { id: string; function?: { name?: string } }[] }[],
  before: ReadonlySet<string>,
): string | null {
  const last = messages[messages.length - 1];
  if (!last || before.has(last.id)) return null;
  if (last.role === "tool") {
    const content = typeof last.content === "string" ? last.content : "";
    // 在等审批卡 / 等用户处理（approval-tools 交回 { waiting: true }），之后会由服务器接上这一轮。
    if (/^\s*\{\s*"waiting"\s*:\s*true/.test(content)) return null;
    const call = messages
      .flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
      .find((toolCall) => toolCall.id === last.toolCallId);
    const step = stepName(call?.function?.name);
    if (content.startsWith("Error:")) {
      const detail = content.slice("Error:".length).trim();
      return `机器人在「${step}」这一步出错，这一轮没有做完${detail ? `：${friendlyToolError(detail)}` : "。"}点「重试」再来一次。`;
    }
    return `机器人做完「${step}」之后没有接着做，这一轮没有做完。点「重试」再来一次。`;
  }
  if (last.role === "assistant") {
    const text = typeof last.content === "string" ? last.content.trim() : "";
    const calls = last.toolCalls ?? [];
    if (!text && calls.length === 0) return "机器人这一轮没有给出任何回复。点「重试」再来一次；一直这样就换一个模型。";
  }
  return null;
}

const STEP_NAMES: Record<string, string> = {
  computer_navigate: "打开网页",
  computer_read: "读取页面",
  computer_snapshot: "查看页面上的按钮和输入框",
  computer_screenshot: "截图",
  computer_click: "点击",
  computer_type: "填写",
  computer_key: "按键",
  computer_scroll: "滚动",
  computer_tabs: "标签页",
  computer_bookmarks: "收藏夹",
  computer_run_command: "运行命令",
  computer_read_file: "读取文件",
  computer_write_file: "写入文件",
  computer_list_files: "查看文件",
};
function stepName(tool: string | undefined): string {
  return (tool && STEP_NAMES[tool]) || (tool ? tool : "上一步");
}
/** 工具报错多是英文的内部说法；认得的翻成人话，其余原样（保留原文便于排查）。 */
function friendlyToolError(detail: string): string {
  /*
   * 「signal is aborted without reason」是浏览器 AbortError 的原话（没有 reason 的 abort）。
   * 它说的是「这一轮被掐了」，不是「这条命令本身出错」：以前原样端到人面前，看着像程序坏了。
   * 中止本身的成因见 lib/copilot/frontend-tool-activity.ts（长命令被发送看门狗打断）。
   */
  if (/aborted without reason|AbortError|signal is aborted/i.test(detail))
    return "这一轮被中断了，这条命令没跑完（不是命令本身出错）。再让它跑一次试试。";
  if (/not on the page any more|Nothing on this page has the ref|out of date/i.test(detail))
    return "页面已经变了，它要找的元素不在了。";
  if (/could not be reached|unavailable|ECONNREFUSED|fetch failed/i.test(detail)) return "云端电脑暂时连不上。";
  return detail.length > 160 ? `${detail.slice(0, 160)}…` : detail;
}

/** 订阅者本身（纯函数，便于测试）：每一轮开始清掉，出错 / 失败记下原因（用户自己按停止的除外）。 */
export function stoppedTurnSubscriber(setStopped: (reason: string | null) => void) {
  return {
    onRunInitialized: () => setStopped(null),
    /*
     * 打开会话时，CopilotKit 把这条线程的历史事件（每一轮的 RUN_STARTED … RUN_ERROR / RUN_FINISHED）
     * 重放一遍，订阅者都会收到。以前只在本页自己发起的一轮开始时清掉提示，于是一小时前出过一次错、
     * 之后已经好好回答了几轮的会话，一打开顶上还挂着那条旧错误（2026-10-13 实测）。历史里后面又开始
     * 了一轮，那条错误就不是「上一轮」的了：任何一轮开始都清掉。
     */
    onRunStartedEvent: () => setStopped(null),
    onRunErrorEvent: ({ event }: { event?: { code?: unknown; message?: unknown } }) => {
      if (
        stoppedByUser() ||
        event?.code === "HERMES_RUN_CANCELLED" ||
        event?.message === "This run was stopped."
      ) {
        return;
      }
      setStopped(stoppedReason(event?.message));
    },
    onRunFailed: ({ error }: { error?: unknown }) => {
      if (!stoppedByUser()) setStopped(stoppedReason(error));
    },
  };
}
