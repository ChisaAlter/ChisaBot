/**
 * 这一轮的流在浏览器这头断了，而不是模型出错（DESIGN.md §89，2026-10-16「模型老断」）。
 *
 * 线上实测（FRA 网关日志 + openbot_local_runs）：两次「暂时连不上模型服务」里没有一次是模型的错——
 * 一次是部署重启了服务（nginx「upstream prematurely closed」），一次是用户电脑到 Cloudflare 的连接整条断了
 * （同一秒 /run 流和频道 WebSocket 一起断，2 秒后换了个边缘节点重连），服务器那一轮照常跑完。浏览器拿到的是
 * `TypeError: network error`，旧代码按关键词「network」翻成「暂时连不上模型服务」，还把发出去的话放回输入框。
 *
 * 现在：浏览器这头的连接断了，先问服务器这一轮还在不在跑——
 *   - 还在跑：什么都不报，接入同步（useConversationSync，§64）会自己接上、接着往下写；
 *   - 已经答完：把存下的回答读回来，也不报错；
 *   - 都不是（服务器重启了 / 一直连不上）：报「和 ChisaBot 的连接断了」，不再冤枉模型。
 *
 * DOG-01（2026-10-18 狗粮）：隧道 / 代理整段挂掉时，`/run`、sync、WebSocket 一起失败。旧逻辑按「服务重启」
 * 最多干等 75 秒——期间气泡在、无「停止」、无错误；一刷新气泡没了（根本没落到服务器）。所以：
 * 一旦连变化戳都问不到，用更短的「完全连不上」时限尽快报错并把字放回输入框；只有至少成功问到过一次
 * 服务器之后，才继续用长时限等重启。
 */

/** 浏览器发起的请求 / 读流时连接断了（不是服务器发来的 RUN_ERROR，也不是用户按停止）。 */
export function isConnectionDrop(error: unknown): boolean {
  if (!error) return false;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") return false;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/^HTTP (502|503|504|520|521|522|523|524|525|530)\b/.test(message)) return true;
  if (/^HTTP \d{3}/.test(message)) return false;
  return /network ?error|failed to fetch|load failed|networkerror|network connection was lost|internet connection appears to be offline|err_([a-z]+_)*(network|connection|http2|quic|internet|tunnel|proxy|ssl|cert|timed_out|name_not_resolved)|tunnel_connection|bodystreambuffer|terminated|connection (reset|closed|lost)|socket hang up|econnreset|premature close|incomplete chunked/i.test(
    message,
  );
}

/** 断线后服务器那一轮也没了（多半是服务重启）时显示的话。 */
export const CONNECTION_LOST_REASON =
  "和 ChisaBot 服务器的连接断了，这一轮没做完（服务器可能刚重启）。再发一次，机器人会接着做。";

/**
 * 变化戳一路问不到（隧道 / 断网）：这句很可能根本没到服务器。比 CONNECTION_LOST_REASON 更直白，
 * 好让人重发而不是干等。
 */
export const SEND_UNREACHABLE_REASON =
  "连不上 ChisaBot 服务器，这句可能没发出去。请检查网络后重新发送。";

export type DropOutcome = "continuing" | "finished" | "lost" | "unreachable";

export type SettleDeps = {
  /** 服务器说这条对话现在是否还在回答；连不上返回 null，不支持返回 "unsupported"。 */
  running: () => Promise<boolean | null | "unsupported">;
  /** 存下的对话里这一轮是不是已经有了完整回答；读不到返回 null。 */
  answered: () => Promise<boolean | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 最多等多久（服务重启要 30–60 秒才回来）。已成功问到过服务器之后才用这个。 */
  deadlineMs?: number;
  intervalMs?: number;
  /**
   * 变化戳一路问不到时最多等多久。比 deadline 短：隧道挂掉时不该按重启干等 75 秒。
   * 默认 10 秒（约 5 次探测）；已经成功问到过服务器后不再受这个限制。
   */
  unreachableMs?: number;
};

/** 断线之后，这一轮到底怎么样了。只读，不重发任何东西（设备命令绝不会因此再跑一遍）。 */
export async function settleDroppedTurn(deps: SettleDeps): Promise<DropOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const start = now();
  const deadline = start + (deps.deadlineMs ?? 75_000);
  const unreachableDeadline = start + (deps.unreachableMs ?? 10_000);
  const interval = deps.intervalMs ?? 2_000;
  /** 至少成功问到过一次变化戳（true/false）之后，才按重启长等。 */
  let sawServer = false;
  for (;;) {
    const running = await deps.running().catch(() => null);
    if (running === "unsupported") return "lost";
    if (running === true) {
      sawServer = true;
      return "continuing";
    }
    if (running === false) {
      sawServer = true;
      const answered = await deps.answered().catch(() => null);
      if (answered === true) return "finished";
      if (answered === false) return "lost";
      // answered === null：历史也读不到，当作短暂连不上，继续等。
    }
    const limit = sawServer ? deadline : Math.min(deadline, unreachableDeadline);
    if (now() + interval > limit) return sawServer ? "lost" : "unreachable";
    await sleep(interval);
  }
}

type StoredMessage = { id: string; role: string; content?: unknown; toolCalls?: unknown[] };
const hasText = (content: unknown) =>
  typeof content === "string"
    ? content.trim().length > 0
    : Array.isArray(content) && content.some((part) => typeof (part as { text?: unknown })?.text === "string" && (part as { text: string }).text.trim());

/** 存下的对话里，`userMessageId` 之后最后一条是一段没有工具调用的回答 = 这一轮答完了。 */
export function storedTurnAnswered(messages: readonly StoredMessage[], userMessageId: string): boolean {
  const at = messages.findIndex((message) => message.id === userMessageId);
  if (at < 0) return false;
  const last = messages.slice(at + 1).filter((message) => message.role !== "system").at(-1);
  return !!last && last.role === "assistant" && hasText(last.content) && !(last.toolCalls?.length ?? 0);
}
