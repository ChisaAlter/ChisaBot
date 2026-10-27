/**
 * CB-107：同一浏览器、同一账号、同一台电脑，只让一个标签页轮询 /control。
 *
 * - 有 Web Locks：谁拿到锁谁轮询；主标签关掉，浏览器立刻放锁，排队的标签马上接管。
 * - 没有 Web Locks、有 BroadcastChannel：心跳选举。主标签每秒发心跳，3 秒没听到就接管；
 *   两个标签同时当主时，id 大的退下。最坏接管时间 ≈ 3s + 1 拍 + 抢占窗口，< 5s。
 * - 两个都没有：每个标签自己轮询（和以前一样）。
 *
 * 结果、退避、恢复都经同一个 BroadcastChannel 发给其他标签。锁名和频道名都带账号 id，切账号不串。
 */
import type { ControlClock } from "./use-control";

export type ControlTabMessage =
  | { k: "hello" }
  | { k: "hb" }
  | { k: "bye" }
  | { k: "wake" }
  | { k: "refresh" }
  | { k: "snap"; snap: Record<string, unknown> };
type Envelope = { from: string; scope: string; msg: ControlTabMessage };

export type ChannelLike = {
  postMessage: (data: unknown) => void;
  close: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
};
export type LocksLike = {
  request: (
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<unknown>,
  ) => Promise<unknown>;
};
export type ControlTabsEnv = {
  locks?: LocksLike | null;
  channel?: ((name: string) => ChannelLike) | null;
  clock: ControlClock;
  id?: string;
};
export type ControlTabsHandlers = {
  onLeader: (leading: boolean) => void;
  onMessage: (msg: ControlTabMessage) => void;
};
export type ControlTabs = {
  /** 想当主（有看得见的订阅者）。可重复调用。 */
  start: () => void;
  /** 不想当主了（全藏起来了）：放锁 / 停心跳，仍然收消息。 */
  stop: () => void;
  isLeader: () => boolean;
  post: (msg: ControlTabMessage) => void;
  close: () => void;
  readonly mode: "locks" | "heartbeat" | "solo";
};

export const CONTROL_HEARTBEAT_MS = 1000;
export const CONTROL_LEADER_TIMEOUT_MS = 3000;
export const CONTROL_CLAIM_MS = 300;

export function controlTabsScope(account: string | null, computerId: string) {
  return `chisabot-control:${account ?? "anon"}:${computerId}`;
}

export function createControlTabs(
  scope: string,
  handlers: ControlTabsHandlers,
  env: ControlTabsEnv,
): ControlTabs {
  const id =
    env.id ??
    `${env.clock.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const { clock } = env;
  let channel: ChannelLike | null = null;
  try {
    channel = env.channel ? env.channel(scope) : null;
  } catch {
    channel = null;
  }
  const mode: ControlTabs["mode"] = !channel
    ? "solo"
    : env.locks
      ? "locks"
      : "heartbeat";
  let leading = false;
  let wanted = false;
  let closed = false;
  const setLeading = (next: boolean) => {
    if (leading === next) return;
    leading = next;
    handlers.onLeader(next);
  };
  const post = (msg: ControlTabMessage) => {
    if (!channel || closed) return;
    try {
      channel.postMessage({ from: id, scope, msg } satisfies Envelope);
    } catch {
      // 频道坏了：至少本标签照常工作。
    }
  };

  // —— Web Locks ——
  let lockAbort: AbortController | undefined;
  let releaseLock: (() => void) | undefined;
  // —— 心跳 ——
  let lastHeard = Number.NEGATIVE_INFINITY;
  let beat: unknown;
  let claim: unknown;

  const stopHeartbeat = () => {
    if (beat !== undefined) clock.clearInterval(beat);
    if (claim !== undefined) clock.clearTimeout(claim);
    beat = undefined;
    claim = undefined;
  };
  const tick = () => {
    if (!wanted || closed) return;
    if (leading) post({ k: "hb" });
    else if (clock.now() - lastHeard >= CONTROL_LEADER_TIMEOUT_MS) {
      setLeading(true);
      post({ k: "hb" });
    }
  };

  if (channel)
    channel.onmessage = (event) => {
      const data = event.data as Envelope | null;
      if (
        closed ||
        !data ||
        data.scope !== scope ||
        data.from === id ||
        !data.msg
      )
        return;
      if (data.msg.k === "hb") {
        lastHeard = clock.now();
        if (mode === "heartbeat") {
          if (claim !== undefined) {
            clock.clearTimeout(claim);
            claim = undefined;
          }
          // 同时有两个主：id 大的退下。
          if (leading && data.from < id) setLeading(false);
        }
        return;
      }
      if (data.msg.k === "bye") {
        // 主标签主动退下（藏起来 / 关掉）：下一拍就接管，不等 3 秒。
        lastHeard = Number.NEGATIVE_INFINITY;
        return;
      }
      if (data.msg.k === "hello" && leading && mode === "heartbeat")
        post({ k: "hb" });
      handlers.onMessage(data.msg);
    };

  const start = () => {
    if (closed || wanted) return;
    wanted = true;
    if (mode === "solo") {
      setLeading(true);
      return;
    }
    post({ k: "hello" });
    if (mode === "locks" && env.locks) {
      const abort = new AbortController();
      lockAbort = abort;
      env.locks
        .request(scope, { signal: abort.signal }, () => {
          if (abort.signal.aborted || closed) return Promise.resolve();
          return new Promise<void>((resolve) => {
            releaseLock = resolve;
            setLeading(true);
          });
        })
        .catch(() => undefined);
      return;
    }
    // 心跳：先等一小会儿看有没有主，没有就自己当。
    claim = clock.setTimeout(() => {
      claim = undefined;
      if (
        wanted &&
        !closed &&
        clock.now() - lastHeard >= CONTROL_LEADER_TIMEOUT_MS
      ) {
        setLeading(true);
        post({ k: "hb" });
      }
    }, CONTROL_CLAIM_MS);
    beat = clock.setInterval(tick, CONTROL_HEARTBEAT_MS);
  };
  const stop = () => {
    if (!wanted) return;
    wanted = false;
    lockAbort?.abort();
    lockAbort = undefined;
    releaseLock?.();
    releaseLock = undefined;
    stopHeartbeat();
    // 主动退下：让别人别等 3 秒。
    if (leading && mode === "heartbeat") post({ k: "bye" });
    setLeading(false);
  };
  return {
    mode,
    start,
    stop,
    isLeader: () => leading,
    post,
    close: () => {
      stop();
      closed = true;
      if (channel) {
        channel.onmessage = null;
        try {
          channel.close();
        } catch {
          // ignore
        }
      }
    },
  };
}

/** 浏览器里的真实环境；拿不到就返回 null（每个标签自己轮询）。 */
export function browserControlTabsEnv(clock: ControlClock): ControlTabsEnv {
  const g = globalThis as {
    navigator?: { locks?: LocksLike };
    BroadcastChannel?: new (name: string) => ChannelLike;
  };
  const Channel = g.BroadcastChannel;
  const locks = g.navigator?.locks;
  return {
    clock,
    locks: locks && typeof locks.request === "function" ? locks : null,
    channel: typeof Channel === "function" ? (name) => new Channel(name) : null,
  };
}
