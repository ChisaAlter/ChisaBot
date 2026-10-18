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
 *
 * DOG-01 实机 FAIL（v0.1.18）：sync 仍 200，上面的 unreachable 路径根本进不去；乐观气泡 ~40s 无停止 /
 * 无错误，刷新消失。根因是 `/run` 被同线程的超大 connect 回放拖住（或 run 本身挂起）而不是「断网」。
 * 所以另加 SEND_WATCHDOG_MS：发消息后若 run 既未落库也未结束，超时后可见失败并恢复草稿。
 */

/** 浏览器发起的请求 / 读流时连接断了（不是服务器发来的 RUN_ERROR，也不是用户按停止）。 */
export function isConnectionDrop(error: unknown): boolean {
  if (!error) return false;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (/^HTTP (502|503|504|520|521|522|523|524|525|530)\b/.test(message))
    return true;
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

/**
 * 发出去之后既没有 `/run` 落库、promise 也一直不结束（主线程被大 connect 拖住、请求排队、
 * 或 runAgent 在 detach/ensure 里挂起）。比「断网」更贴切：网络可能是通的，但这句就是没发出去。
 */
export const SEND_HANG_REASON =
  "这句迟迟没发出去。请再发一次；若反复如此，试试刷新页面。";

/**
 * 消息已落库，但这一轮的回答一直不结束（模型挂起 / 流卡住）。
 * CR-P1-03：若第二次等待也不封顶，composer 会永远 busy。
 */
export const SEND_REPLY_HANG_REASON =
  "这句已经发出去了，但回答迟迟没回来。可以点停止，或刷新后再看。";

/** 发消息后等多久还没结束 / 没落库就改报错。略长于常见模型首字，远短于 40s 假成功。 */
export const SEND_WATCHDOG_MS = 12_000;

/** 已落库后继续等回答的上限。比 SEND_WATCHDOG_MS 长（模型可能慢），但仍封顶以免永久卡住。 */
export const SEND_REPLY_WATCHDOG_MS = 180_000;

/**
 * 和 `run` 赛跑：超时返回 `"timeout"`，run 先结束返回 `"done"`。
 * 不取消 run——调用方决定要不要 stop / 查落库；测的是「有没有在时限内给出结果」。
 */
export function raceSendWatchdog<T>(
  run: Promise<T>,
  deps: { afterMs: (ms: number) => Promise<void>; timeoutMs?: number },
): Promise<"done" | "timeout"> {
  const timeoutMs = deps.timeoutMs ?? SEND_WATCHDOG_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: "done" | "timeout") => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    void run.then(
      () => finish("done"),
      () => finish("done"),
    );
    void deps.afterMs(timeoutMs).then(() => finish("timeout"));
  });
}

/**
 * Pure decision for the send watchdog (DOG-01 / CR-P1-03 honesty).
 *
 * Guarantees the UI never treats a timed-out / unpersisted send as success:
 * - first race done → proceed (run settled; error path owns failures)
 * - first timeout + not persisted → hang (message likely never left; restore draft)
 * - first timeout + persisted + reply timeout → reply_hang (sent, but answer stuck)
 * - first timeout + persisted + reply done → proceed
 *
 * Automated tests assert these branches; browser E2E is optional.
 */
export type SendWatchdogDecision =
  | { kind: "proceed" }
  | {
      kind: "hang";
      reason: typeof SEND_HANG_REASON;
      budget: "SEND_HANG";
    }
  | {
      kind: "reply_hang";
      reason: typeof SEND_REPLY_HANG_REASON;
      budget: "SEND_REPLY_HANG";
    };

export function decideSendWatchdogAction(input: {
  firstRace: "done" | "timeout";
  /** Whether the optimistic user message id is in the server thread. null = check failed. */
  persisted: boolean | null;
  replyRace?: "done" | "timeout";
}): SendWatchdogDecision {
  if (input.firstRace === "done") return { kind: "proceed" };
  // Timeout without a confirmed persist = fake-success risk. Treat null like not persisted.
  if (input.persisted !== true) {
    return {
      kind: "hang",
      reason: SEND_HANG_REASON,
      budget: "SEND_HANG",
    };
  }
  if (input.replyRace === "timeout") {
    return {
      kind: "reply_hang",
      reason: SEND_REPLY_HANG_REASON,
      budget: "SEND_REPLY_HANG",
    };
  }
  return { kind: "proceed" };
}

/** Reasons that must never be shown as a successful send (regression guard). */
export function isHonestSendFailureReason(reason: string): boolean {
  const hang =
    reason === SEND_HANG_REASON ||
    reason === SEND_REPLY_HANG_REASON ||
    reason === SEND_UNREACHABLE_REASON ||
    reason === CONNECTION_LOST_REASON;
  if (!hang) return false;
  // None of these may claim the turn succeeded.
  return !/已发送|发送成功|成功发出|sent successfully/i.test(reason);
}

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
export async function settleDroppedTurn(
  deps: SettleDeps,
): Promise<DropOutcome> {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
    const limit = sawServer
      ? deadline
      : Math.min(deadline, unreachableDeadline);
    if (now() + interval > limit) return sawServer ? "lost" : "unreachable";
    await sleep(interval);
  }
}

type StoredMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: unknown[];
};
const hasText = (content: unknown) =>
  typeof content === "string"
    ? content.trim().length > 0
    : Array.isArray(content) &&
      content.some(
        (part) =>
          typeof (part as { text?: unknown })?.text === "string" &&
          (part as { text: string }).text.trim(),
      );

/** 存下的对话里，`userMessageId` 之后最后一条是一段没有工具调用的回答 = 这一轮答完了。 */
export function storedTurnAnswered(
  messages: readonly StoredMessage[],
  userMessageId: string,
): boolean {
  const at = messages.findIndex((message) => message.id === userMessageId);
  if (at < 0) return false;
  const last = messages
    .slice(at + 1)
    .filter((message) => message.role !== "system")
    .at(-1);
  return (
    !!last &&
    last.role === "assistant" &&
    hasText(last.content) &&
    !(last.toolCalls?.length ?? 0)
  );
}

/**
 * Fire-and-forget budget beacon (PRD-P1-02). Server whitelists SEND_UNREACHABLE /
 * STREAM_DISCONNECT. Failures are ignored — we may already be offline.
 */
export function reportBudgetEvent(
  code:
    | "SEND_UNREACHABLE"
    | "STREAM_DISCONNECT"
    | "SEND_HANG"
    | "SEND_REPLY_HANG",
  fetchImpl: typeof fetch = fetch,
): void {
  try {
    void fetchImpl("/api/ops/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      credentials: "include",
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

/**
 * Track B：看门狗超时或用户点停止后，确保服务器端锁也放下。
 * CopilotKit stopAgent 管本进程 active run；这条补「无内存条目却仍占锁」的孤儿，
 * 以及 stop 竞态下没走到 finally 的边角。失败忽略——可能已离线。
 */
export function forceUnlockThread(
  threadId: string,
  fetchImpl: typeof fetch = fetch,
): void {
  if (!threadId) return;
  try {
    void fetchImpl(
      `/api/copilotkit/threads/${encodeURIComponent(threadId)}/unlock`,
      {
        method: "POST",
        credentials: "include",
        keepalive: true,
      },
    ).catch(() => {});
  } catch {
    /* ignore */
  }
}
