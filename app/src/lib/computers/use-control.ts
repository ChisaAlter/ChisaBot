import { useCallback, useSyncExternalStore } from "react";
import { useKeptVisible } from "@/lib/kept-visible";
import {
  CONTROL_UNREACHABLE_ZH,
  type ComputerControlKind,
  cancelControl,
  type ControlState,
  onControlRequestOk,
  readControlStatus,
  releaseControl,
  takeControl,
} from "./control";
import {
  browserControlTabsEnv,
  type ControlTabMessage,
  type ControlTabs,
  type ControlTabsEnv,
  type ControlTabsHandlers,
  CONTROL_LEADER_TIMEOUT_MS,
  controlTabsScope,
  createControlTabs,
} from "./control-tabs";

type Action = "take" | "release" | "cancel";
type Snapshot = {
  control: ControlState | null;
  busy: boolean;
  problem: string | null;
  /** CB-103：无 / 直播 / 用户接管 / 连不上；还没读到过是 null。 */
  state: ComputerControlKind | null;
};
const EMPTY: Snapshot = { control: null, busy: false, problem: null, state: null };

/** 接管 / 交还之后的状态：以返回的 holder 为准，直播与否沿用上一次读到的。 */
function kindAfter(
  control: ControlState | null,
  previous: ComputerControlKind | null,
): ComputerControlKind | null {
  if (!control) return previous;
  if (control.holder === "human") return "user_control";
  return previous === "live" ? "live" : "none";
}

/** 连不上时的退避：1s、2s、4s，最长 5s（恢复后 5 秒内回到正常）。 */
export const CONTROL_RETRY_MAX_MS = 5000;
export function controlRetryDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(CONTROL_RETRY_MAX_MS, 1000 * 2 ** (failures - 1));
}
type ControlStore = {
  getSnapshot: () => Snapshot;
  refresh: () => Promise<void>;
  change: (action: Action) => Promise<boolean>;
  subscribe: (listener: () => void, active?: boolean) => () => void;
  /** 有理由相信电脑又连得上了（窗口回焦、online、同一 bot 的别的请求成功）：清掉退避，马上再读。 */
  wake: () => void;
  /** 从 bfcache（pagehide → pageshow）恢复时，若仍有订阅者则重建频道并恢复选主与轮询。 */
  sync?: () => void;
  /** CB-107：放下主标签身份、关掉频道（切账号 / 退出 / 关页面）。 */
  dispose: () => void;
};
const stores = new Map<string, ControlStore>();
/** 测试用：和 useComputerControl 同一张表。 */
export const controlStores = stores;

/** One authoritative poll and mutation gate per visible Bot, shared by chat, sidebar and modal. */
/** 测试用：可注入假时钟。 */
export type ControlClock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};
const realClock: ControlClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};
/** CB-107：给 store 接上多标签协调；不给就是每个标签自己轮询。 */
export type ControlTabsFactory = (handlers: ControlTabsHandlers) => ControlTabs;
export function createControlStore(
  computerId: string,
  clock: ControlClock = realClock,
  makeTabs?: ControlTabsFactory,
): ControlStore {
  let snapshot = EMPTY;
  let tabs: ControlTabs | undefined;
  /** 只有主标签轮询；没有协调器时自己就是主。 */
  let leading = !makeTabs;
  /** CB-107 r3：最近一次收到主标签结果的时间；太久没收到（没主 / 主在后台被节流）就自己读。 */
  let lastSnapAt = Number.NEGATIVE_INFINITY;
  let watchdog: unknown;
  let version = 0;
  let timer: unknown;
  /** CB-103 r4：退避重试直接按 retryAt 排定时器，不等每秒那一拍（以前每次晚一拍：2→3→5→6s）。 */
  let retryTimer: unknown;
  const clearRetry = () => {
    if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  let reading: AbortController | undefined;
  const listeners = new Set<() => void>();
  /** 在屏幕上的订阅者。全都藏着（留着的聊天 / 右栏，DESIGN.md §98.3）时不轮询。 */
  let active = 0;
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  /** 主标签读到的结果（含退避 / 恢复 / 连不上）原样发给其他标签。 */
  const share = (withProblem = true) => {
    if (!tabs) return;
    tabs.post({
      k: "snap",
      snap: withProblem
        ? { control: snapshot.control, state: snapshot.state, problem: snapshot.problem }
        : { control: snapshot.control, state: snapshot.state },
    });
  };
  /** CB-103：连续连不上的次数和下一次能读的时间（退避）。 */
  let failures = 0;
  let retryAt = 0;
  const refresh = async () => {
    const mine = version;
    reading?.abort();
    const abort = new AbortController();
    reading = abort;
    const read = await readControlStatus(computerId, abort.signal).catch(
      () => ({ kind: "unreachable", reason: "network" }) as const,
    );
    if (reading === abort) reading = undefined;
    if (abort.signal.aborted || mine !== version || snapshot.busy) return;
    if (read.kind === "unreachable") {
      failures++;
      const delay = controlRetryDelay(failures);
      retryAt = clock.now() + delay;
      clearRetry();
      retryTimer = clock.setTimeout(() => {
        retryTimer = undefined;
        if (active > 0 && !snapshot.busy && !reading) void refresh();
      }, delay);
      publish({
        ...snapshot,
        control: null,
        state: "unreachable",
        problem: CONTROL_UNREACHABLE_ZH,
      });
      share();
      return;
    }
    failures = 0;
    retryAt = 0;
    clearRetry();
    const control = read.kind === "error" ? null : read.control;
    const stale =
      snapshot.problem?.startsWith("正在重连") ||
      snapshot.problem === CONTROL_UNREACHABLE_ZH;
    publish({
      ...snapshot,
      control,
      // 403 / 404 等：这台电脑没有控制权可言，按「无」处理——不提示重连，不暂停输入。
      state: read.kind === "error" ? "none" : read.kind,
      problem: stale ? null : snapshot.problem,
    });
    share();
  };
  // Keep the same store through Strict Mode resubscriptions and pending mutations.
  const disposeWhenUnused = () =>
    queueMicrotask(() => {
      if (!listeners.size && !snapshot.busy)
        for (const [key, value] of stores) if (value === store) stores.delete(key);
    });
  const change = async (action: Action): Promise<boolean> => {
    if (snapshot.busy || snapshot.control?.transitioning) return false;
    const control = snapshot.control;
    let requestId = control?.request?.id;
    // FIX-06：进程重启后 request 可能已 interrupted / 消失，holder 仍是 human。
    // 交还时若没有 requestId，先发起一次接管请求再立刻交还，清掉卡住的 holder。
    if (action === "release" && !requestId && control?.holder === "human") {
      version++;
      reading?.abort();
      publish({ ...snapshot, busy: true, problem: null });
      try {
        const taken = await takeControl(computerId);
        requestId = taken?.request?.id;
        const next = requestId ? await releaseControl(computerId, requestId) : null;
        publish({
          control: next ?? taken ?? control,
          state: kindAfter(next ?? taken ?? control, snapshot.state),
          busy: false,
          problem: next ? null : "控制权没改成功，请检查连接后重试。",
        });
        return next !== null;
      } catch {
        publish({
          ...snapshot,
          busy: false,
          problem: "连不上这台计算机，重连后再试。",
        });
        return false;
      } finally {
        share(false);
        disposeWhenUnused();
      }
    }
    if (action !== "take" && !requestId) {
      publish({
        ...snapshot,
        problem: "找不到这次交还请求，请重试连接。",
      });
      return false;
    }
    version++;
    reading?.abort();
    publish({ ...snapshot, busy: true, problem: null });
    try {
      const next =
        action === "take"
          ? await takeControl(
              computerId,
              control?.requested ? requestId : undefined,
            )
          : requestId
            ? action === "release"
              ? await releaseControl(computerId, requestId)
              : await cancelControl(computerId, requestId)
            : null;
      publish({
        control: next ?? control,
        state: kindAfter(next ?? control, snapshot.state),
        busy: false,
        problem: next ? null : "控制权没改成功，请检查连接后重试。",
      });
      return next !== null;
    } catch {
      publish({
        ...snapshot,
        busy: false,
        problem: "连不上这台计算机，重连后再试。",
      });
      return false;
    } finally {
      share(false);
      disposeWhenUnused();
    }
  };
  const wake = () => {
    if (active > 0 && ((makeTabs && !tabs) || (leading && timer === undefined))) {
      failures = 0;
      retryAt = 0;
      clearRetry();
      sync();
      return;
    }
    if (!leading) {
      tabs?.post({ k: "wake" });
      return;
    }
    if (!failures && snapshot.state !== "unreachable") return;
    failures = 0;
    retryAt = 0;
    clearRetry();
    if (active > 0 && !snapshot.busy && !reading) void refresh();
  };
  const startPolling = () => {
    if (timer !== undefined) return;
    if (!snapshot.busy && active > 0) void refresh();
    timer = clock.setInterval(() => {
      // 退避期间由 retryTimer 负责，这一拍不读；但告诉跟随标签主还活着（结果不旧）。
      if (failures > 0 && retryTimer !== undefined) {
        share();
        return;
      }
      if (active > 0 && !snapshot.busy && !reading && clock.now() >= retryAt)
        void refresh();
    }, 1000);
  };
  /** 跟随标签：没拿到主的结果，或结果超过 3 秒没更新，就自己读一次（选主照常进行）。 */
  const followerStale = () =>
    !leading &&
    active > 0 &&
    !snapshot.busy &&
    !reading &&
    clock.now() >= retryAt &&
    clock.now() - lastSnapAt >= CONTROL_LEADER_TIMEOUT_MS;
  const startWatchdog = () => {
    if (watchdog !== undefined || !tabs) return;
    watchdog = clock.setInterval(() => {
      if (followerStale()) void refresh();
    }, 1000);
  };
  const stopWatchdog = () => {
    if (watchdog !== undefined) clock.clearInterval(watchdog);
    watchdog = undefined;
  };
  const stopPolling = () => {
    if (timer !== undefined) clock.clearInterval(timer);
    timer = undefined;
    clearRetry();
    reading?.abort();
    version++;
  };
  const onTabMessage = (msg: ControlTabMessage) => {
    if (msg.k === "snap") {
      lastSnapAt = clock.now();
      // 主标签的结果说了算：本标签自己读失败留下的退避作废，免得跟着另起一套退避。
      if (!leading && (failures || retryTimer !== undefined)) {
        failures = 0;
        retryAt = 0;
        clearRetry();
      }
      // 跟随标签：直接用主标签的结果，不自己读；本标签的 busy 不被覆盖。
      if (snapshot.busy) return;
      const snap = msg.snap as Partial<Snapshot>;
      publish({
        ...snapshot,
        control: (snap.control ?? null) as ControlState | null,
        state: (snap.state ?? null) as ComputerControlKind | null,
        problem: "problem" in snap ? (snap.problem ?? null) : snapshot.problem,
      });
      return;
    }
    if (!leading) return;
    if (msg.k === "hello") share();
    else if (msg.k === "wake") wake();
    else if (msg.k === "refresh" && !snapshot.busy && !reading) void refresh();
  };
  const ensureTabs = () => {
    if (tabs || !makeTabs) return;
    tabs = makeTabs({
      onLeader: (next) => {
        leading = next;
        if (next) startPolling();
        else stopPolling();
      },
      onMessage: onTabMessage,
    });
  };
  const sync = () => {
    if (!listeners.size) return;
    const restoredTabs = !tabs && Boolean(makeTabs);
    ensureTabs();
    if (leading) startPolling();
    if (tabs && active > 0) {
      tabs.start();
      if (restoredTabs && followerStale()) void refresh();
      startWatchdog();
    }
  };
  const store: ControlStore = {
    getSnapshot: () => snapshot,
    refresh: async () => {
      if (leading) return refresh();
      tabs?.post({ k: "refresh" });
    },
    change,
    wake,
    sync,
    dispose: () => {
      tabs?.close();
      tabs = undefined;
      leading = !makeTabs;
      stopWatchdog();
      stopPolling();
    },
    subscribe: (listener: () => void, onScreen = true) => {
      listeners.add(listener);
      ensureTabs();
      if (onScreen) {
        active++;
        // 第一个看得见的订阅者（含藏着之后回来的）：马上补读一次，不等下一拍。
        if (leading && active === 1 && timer !== undefined && !snapshot.busy && !reading)
          void refresh();
      }
      if (leading) startPolling();
      // CB-107：有看得见的订阅者才去争主；跟随标签先问主标签要一份最新结果。
      if (tabs && active > 0) {
        tabs.start();
        // 启动 / 重新可见时还没有主的结果：先立刻读一次，不等选主（心跳模式要 300ms）。
        if (onScreen && active === 1 && followerStale()) void refresh();
        startWatchdog();
      }
      return () => {
        if (onScreen) active--;
        listeners.delete(listener);
        if (tabs && active <= 0) {
          tabs.stop();
          stopWatchdog();
        }
        if (listeners.size) return;
        stopWatchdog();
        stopPolling();
        tabs?.close();
        tabs = undefined;
        leading = !makeTabs;
        disposeWhenUnused();
      };
    },
  };
  return store;
}
/** CB-107：当前登录账号；锁名、频道名、store 都按它隔离。 */
let controlAccount: string | null = null;
let tabsEnv: ((clock: ControlClock) => ControlTabsEnv) | null = browserControlTabsEnv;
/** 测试用：换掉浏览器环境（假锁 / 假频道），传 null 等于不支持（每个标签自己轮询）。 */
export function setControlTabsEnv(env: ((clock: ControlClock) => ControlTabsEnv) | null) {
  tabsEnv = env;
}
/** 登录后 / 切账号 / 退出时调用：换账号就把上一个账号的 store 和频道全关掉。 */
export function setControlAccount(account: string | null) {
  if (account === controlAccount) return;
  controlAccount = account;
  for (const store of stores.values()) store.dispose();
  stores.clear();
}
export function getControlAccount() {
  return controlAccount;
}
function storeKey(computerId: string) {
  // 没登录信息（本机开发、测试）时键就是 computerId，和以前一样。
  return controlAccount ? `${controlAccount}:${computerId}` : computerId;
}
function makeStore(computerId: string) {
  const env = tabsEnv?.(realClock);
  const scope = controlTabsScope(controlAccount, computerId);
  return createControlStore(
    computerId,
    realClock,
    env ? (handlers) => createControlTabs(scope, handlers, env) : undefined,
  );
}
/** 窗口回焦 / 重新联网 / 同一 bot 别的请求成功：叫醒对应的 store。 */
export function wakeControl(computerId?: string) {
  if (computerId) {
    for (const [key, store] of stores)
      if (key === computerId || key.endsWith(`:${computerId}`)) store.wake();
  }
  else for (const store of stores.values()) store.wake();
}
let wakeListening = false;
function listenForWake() {
  if (wakeListening || typeof window === "undefined") return;
  wakeListening = true;
  window.addEventListener("focus", () => wakeControl());
  window.addEventListener("online", () => wakeControl());
  // CB-107：关页面时主动放下主标签身份，心跳模式下别的标签不用等 3 秒。
  window.addEventListener("pagehide", () => {
    for (const store of stores.values()) store.dispose();
  });
  window.addEventListener("pageshow", () => {
    for (const store of stores.values()) {
      store.sync?.();
      store.wake();
    }
  });
}
onControlRequestOk((computerId) => wakeControl(computerId));
const noSubscription = () => () => undefined;
const emptySnapshot = () => EMPTY;
export function useComputerControl(computerId: string, enabled = true) {
  const key = storeKey(computerId);
  let store = enabled ? stores.get(key) : undefined;
  if (enabled && !store) {
    listenForWake();
    store = makeStore(computerId);
    stores.set(key, store);
  } else if (enabled && store) {
    store.sync?.();
  }
  const onScreen = useKeptVisible();
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener, onScreen) : noSubscription()),
    [store, onScreen],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    store?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return { ...snapshot, change: store?.change, refresh: store?.refresh };
}
