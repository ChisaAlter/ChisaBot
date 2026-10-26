import { useCallback, useSyncExternalStore } from "react";
import { useKeptVisible } from "@/lib/kept-visible";
import {
  CONTROL_UNREACHABLE_ZH,
  type ComputerControlKind,
  cancelControl,
  type ControlState,
  readControlStatus,
  releaseControl,
  takeControl,
} from "./control";

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

/** 连不上时的退避：1s、2s、4s、8s，最长 15s。 */
export function controlRetryDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(15_000, 1000 * 2 ** (failures - 1));
}
type ControlStore = {
  getSnapshot: () => Snapshot;
  refresh: () => Promise<void>;
  change: (action: Action) => Promise<boolean>;
  subscribe: (listener: () => void, active?: boolean) => () => void;
};
const stores = new Map<string, ControlStore>();

/** One authoritative poll and mutation gate per visible Bot, shared by chat, sidebar and modal. */
export function createControlStore(computerId: string): ControlStore {
  let snapshot = EMPTY;
  let version = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reading: AbortController | undefined;
  const listeners = new Set<() => void>();
  /** 在屏幕上的订阅者。全都藏着（留着的聊天 / 右栏，DESIGN.md §98.3）时不轮询。 */
  let active = 0;
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
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
      retryAt = Date.now() + controlRetryDelay(failures);
      publish({
        ...snapshot,
        control: null,
        state: "unreachable",
        problem: CONTROL_UNREACHABLE_ZH,
      });
      return;
    }
    failures = 0;
    retryAt = 0;
    const control = read.kind === "error" ? null : read.control;
    publish({
      ...snapshot,
      control,
      // 读到意外的错误（403 / 404 等）不挡截图：回到旧行为，按「无」处理。
      state: read.kind === "error" ? (snapshot.state ?? "none") : read.kind,
      problem: control
        ? snapshot.problem?.startsWith("正在重连") ||
          snapshot.problem === CONTROL_UNREACHABLE_ZH
          ? null
          : snapshot.problem
        : "正在重连：暂时查不到谁有控制权，输入已暂停。",
    });
  };
  // Keep the same store through Strict Mode resubscriptions and pending mutations.
  const disposeWhenUnused = () =>
    queueMicrotask(() => {
      if (!listeners.size && !snapshot.busy && stores.get(computerId) === store)
        stores.delete(computerId);
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
      disposeWhenUnused();
    }
  };
  const store: ControlStore = {
    getSnapshot: () => snapshot,
    refresh,
    change,
    subscribe: (listener: () => void, onScreen = true) => {
      listeners.add(listener);
      if (onScreen) {
        active++;
        // 第一个看得见的订阅者（含藏着之后回来的）：马上补读一次，不等下一拍。
        if (active === 1 && timer !== undefined && !snapshot.busy && !reading) void refresh();
      }
      if (timer === undefined) {
        if (!snapshot.busy && active > 0) void refresh();
        timer = setInterval(() => {
          if (active > 0 && !snapshot.busy && !reading && Date.now() >= retryAt)
            void refresh();
        }, 1000);
      }
      return () => {
        if (onScreen) active--;
        listeners.delete(listener);
        if (listeners.size) return;
        clearInterval(timer);
        timer = undefined;
        reading?.abort();
        version++;
        disposeWhenUnused();
      };
    },
  };
  return store;
}
const noSubscription = () => () => undefined;
const emptySnapshot = () => EMPTY;
export function useComputerControl(computerId: string, enabled = true) {
  let store = enabled ? stores.get(computerId) : undefined;
  if (enabled && !store) {
    store = createControlStore(computerId);
    stores.set(computerId, store);
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
