import { KeptVisibleContext } from "@/lib/kept-visible";
import {
  type CSSProperties,
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** 藏着的聊天留多久（之后卸载，回来走正常的打开：先画上次的样子，再接入）。按每一段分别计时。 */
export const KEPT_TTL_MS = 10 * 60_000;

/**
 * 最多同时留几段聊天（DESIGN.md §98.6，卡顿修复 P1-3）：A→B→A 切回最近看过的对话不再整页重挂、重新解析 markdown。
 * 超过就放掉最久没看的那段。
 */
export const KEPT_MAX = 4;

/**
 * 藏着的那几段合计最多留多少个 DOM 元素（藏起来那一刻数一次）。超了从最久没看的开始放，大会话因此会被提前放掉；
 * 看得见的那段不算、也永远不放。长对话虚拟化（P3-3）落地后每段元素数会降下来，同样的预算能留满 `KEPT_MAX` 段。
 */
export const KEPT_NODE_BUDGET = 24_000;

/**
 * 藏起来之后多久内「滚动位置钉住」（DESIGN.md §98.5）：离开那一刻浏览器会把藏着的滚动容器挪几十像素
 * （Chrome，1280 宽第一次去设置：设置页挂载时的强制布局，−68px，没有任何脚本改 scrollTop），回聊天位置就对不上。
 * 这段时间里藏着的容器一收到 scroll 就还原成离开前的位置；之后放开（藏着时贴底的回答照常往下走，§35 / §94）。
 */
export const KEPT_SCROLL_HOLD_MS = 1500;

export type KeptState = {
  /** 地址正停在留着的这一页上（或 `idleVisible`）。 */
  visible: boolean;
  /** 每次从藏着变回看得见时加一。 */
  epoch: number;
};

/**
 * 留着的一段自己的信息（给页面里的东西用，比如 P3-3 的虚拟列表）：
 * - `slotKey`：这一段的身份（`keyOf` 的结果），可以拿来给高度缓存之类分桶；
 * - `onEvict`：这段被 LRU / TTL / 预算放掉时回调（卸载之前），用来清掉按段存的缓存；
 * - `registerScroll`：页面自己接管滚动的保存 / 还原（虚拟列表用 `scrollToIndex` 而不是 scrollTop）。
 *   藏起来那一刻调 `save()`，变回看得见那一刻（同一次提交、绘制前）调 `restore(saved)`。注册了就不再按 DOM 还原这段。
 */
export type KeptScrollHandler<S = unknown> = {
  save: () => S;
  restore: (saved: S) => void;
};
export type KeptSlot = {
  slotKey: string;
  onEvict: (cb: () => void) => () => void;
  registerScroll: (handler: KeptScrollHandler) => () => void;
};
const KeptSlotContext = createContext<KeptSlot | null>(null);
/** 在 `KeepAliveStage` 留着的一页里读这一段的信息；不在里面时是 `null`。 */
export function useKeptSlot(): KeptSlot | null {
  return useContext(KeptSlotContext);
}

type Entry<T> = { id: number; key: string; value: T; hiddenAt: number | null; nodes: number };

let nextEntryId = 1;

/**
 * 主区里「留着的几段聊天（LRU）+ 当前路由」（DESIGN.md §98、§98.6）。
 *
 * - `address` 不为 null（地址正是某一段，比如 `/channel/:id`）：那段看得见，路由那一层不占位置。换一段对话时，
 *   原来那段不卸载，只是藏起来；最多留 `max` 段（按最近看过排序），多了放掉最久没看的。
 * - `address` 为 null（别的页面）：路由那一层盖在上面（`absolute inset-0`），留着的都藏在下面。
 * - 藏着的那段：`content-visibility: hidden`（跳过样式 / 布局 / 绘制，保留 DOM 和状态）+ `inert` + `aria-hidden`，
 *   宽高冻在离开时的样子、绝对定位叠在下面不占位。React 这边用 `memo` 挡住外壳的重渲（藏着不跟着重画），
 *   轮询和画面靠 `KeptVisibleContext=false` 停；**不用 `<Activity mode="hidden">`**：它会拆掉藏着那段的 effect，
 *   流式回答的订阅、收件箱、交付也跟着断（§98.3 要求它们不停），切回来还要重新接入、回放。
 * - 每段藏够 `ttlMs` 就放掉；藏着的合计元素数超过 `nodeBudget` 也从最久没看的开始放（大会话先走）。
 * - `idleVisible`：地址不是聊天，但正在跳过去（`/` → 最近的对话），最近看的那段先露着，不空一下。
 *
 * 同一段（`keyOf` 相同，没给就按 `same`）地址里的其他部分变了（比如 `?settings`）只更新那段，不重新挂载。
 * 路由那一层永远是同一个元素、只换样式，路由内容不会因为留没留着而重新挂载。
 */
export function KeepAliveStage<T>({
  address,
  idleVisible = false,
  same,
  keyOf,
  renderKept,
  ttlMs = KEPT_TTL_MS,
  max = KEPT_MAX,
  nodeBudget = KEPT_NODE_BUDGET,
  children,
}: {
  address: T | null;
  /** 布尔，或按留着的那页判断（`/` 正跳向的正是它时才露着）。 */
  idleVisible?: boolean | ((kept: T) => boolean);
  same: (a: T, b: T) => boolean;
  /** 一段的身份。地址变了但 key 相同 → 同一段（更新，不重挂）。没给时用 `same` 判断，一个地址一段。 */
  keyOf?: (a: T) => string;
  renderKept: (kept: T, state: KeptState) => ReactNode;
  ttlMs?: number;
  max?: number;
  nodeBudget?: number;
  children: ReactNode;
}) {
  // entries[0] 是最近看过的。
  const [entries, setEntries] = useState<Entry<T>[]>(() => (address === null ? [] : [makeEntry(address, keyOf)]));
  const head = entries[0] ?? null;
  if (address !== null) {
    const index = entries.findIndex((e) => (keyOf ? e.key === keyOf(address) : same(e.value, address)));
    if (index !== 0 || !same(entries[0].value, address) || entries[0].hiddenAt !== null) {
      setEntries(touch(entries, index, address, keyOf, max));
    }
  } else if (head && head.hiddenAt === null && !headIdle(head)) {
    // 离开聊天：最近那段也藏起来，开始计时。
    setEntries([{ ...head, hiddenAt: Date.now() }, ...entries.slice(1)]);
  }
  function headIdle(e: Entry<T>) {
    return typeof idleVisible === "function" ? idleVisible(e.value) : idleVisible;
  }
  const idle = address === null && head !== null && headIdle(head);
  const shown = address !== null || idle;

  // TTL：到点放掉藏着的那几段（每段自己计时）。
  useEffect(() => {
    const hidden = entries.filter((e, i) => e.hiddenAt !== null && !(i === 0 && shown));
    if (hidden.length === 0) return;
    const due = Math.min(...hidden.map((e) => (e.hiddenAt as number) + ttlMs));
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setEntries((list) => list.filter((e, i) => (i === 0 && shown) || e.hiddenAt === null || e.hiddenAt + ttlMs > now));
    }, Math.max(0, due - Date.now()));
    return () => window.clearTimeout(timer);
  }, [entries, ttlMs, shown]);

  // 元素预算：藏起来那一刻每段报一次自己的元素数；藏着的合计超了，从最久没看的开始放。
  const report = useRef((id: number, nodes: number) => {
    setEntries((list) => {
      const at = list.findIndex((e) => e.id === id);
      if (at < 0 || list[at].nodes === nodes) return list;
      const next = list.slice();
      next[at] = { ...list[at], nodes };
      return next;
    });
  });
  useEffect(() => {
    let total = 0;
    for (let i = 0; i < entries.length; i++) if (!(i === 0 && shown)) total += entries[i].nodes;
    if (total <= nodeBudget) return;
    const keep = entries.slice();
    for (let i = keep.length - 1; i >= 0 && total > nodeBudget; i--) {
      if (i === 0 && shown) break;
      total -= keep[i].nodes;
      keep.splice(i, 1);
    }
    setEntries(keep);
  }, [entries, nodeBudget, shown]);

  const renderRef = useRef(renderKept);
  renderRef.current = renderKept;

  return (
    <div className="keep-stage relative flex min-h-0 min-w-0 flex-1 flex-col" data-kept-visible={shown && head ? "true" : "false"}>
      {entries.map((e, i) => (
        <KeptSlotView
          entryId={e.id}
          key={e.id}
          render={renderRef}
          report={report}
          slotKey={e.key}
          value={e.value}
          visible={i === 0 && shown}
        />
      ))}
      <div
        className={shown ? "route-layer contents" : "route-layer absolute inset-0 z-[1] flex min-h-0 min-w-0 flex-col"}
        data-testid="route-layer"
      >
        {children}
      </div>
    </div>
  );
}

function makeEntry<T>(value: T, keyOf?: (a: T) => string): Entry<T> {
  const id = nextEntryId++;
  return { id, key: keyOf ? keyOf(value) : `kept-${id}`, value, hiddenAt: null, nodes: 0 };
}

/** 把 `address` 那段移到最前面（没有就新建），其余的都标成藏着；超过 `max` 放掉最后面的。 */
function touch<T>(list: Entry<T>[], index: number, address: T, keyOf: ((a: T) => string) | undefined, max: number): Entry<T>[] {
  const now = Date.now();
  const front: Entry<T> = index >= 0 ? { ...list[index], value: address, hiddenAt: null } : makeEntry(address, keyOf);
  const rest = list.filter((_, i) => i !== index).map((e) => (e.hiddenAt === null ? { ...e, hiddenAt: now } : e));
  return [front, ...rest].slice(0, Math.max(1, max));
}

type SlotProps<T> = {
  entryId: number;
  slotKey: string;
  value: T;
  visible: boolean;
  render: { current: (kept: T, state: KeptState) => ReactNode };
  report: { current: (id: number, nodes: number) => void };
};

/**
 * 一段留着的聊天。藏着时外壳重渲不会传进来（`memo`：值和可见性都没变就跳过），看得见时照常跟着外壳画。
 */
const KeptSlotView = memo(KeptSlotInner, (a, b) => !b.visible && !a.visible && a.value === b.value && a.slotKey === b.slotKey) as <T>(
  p: SlotProps<T>,
) => ReactNode;

function KeptSlotInner<T>({ entryId, slotKey, value, visible, render, report }: SlotProps<T>) {
  const [epoch, setEpoch] = useState(0);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setEpoch((n) => n + 1);
  }

  // 给页面里用的这一段的信息（P3-3 接口）。
  const evictCbs = useRef(new Set<() => void>());
  const scrollHandlers = useRef(new Set<KeptScrollHandler>());
  const [slot] = useState<KeptSlot>(() => ({
    slotKey,
    onEvict: (cb) => {
      evictCbs.current.add(cb);
      return () => evictCbs.current.delete(cb);
    },
    registerScroll: (handler) => {
      scrollHandlers.current.add(handler);
      return () => scrollHandlers.current.delete(handler);
    },
  }));
  useEffect(
    () => () => {
      for (const cb of evictCbs.current) cb();
    },
    [],
  );

  // 看得见时一直记着尺寸；藏起来那一刻（同一次提交、新页面画出来之前）用记下的尺寸冻住。
  const box = useRef<HTMLDivElement>(null);
  const size = useRef<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !visible) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) size.current = { width: rect.width, height: rect.height };
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // 看得见时记着每个滚动容器最后的位置；藏起来后 KEPT_SCROLL_HOLD_MS 内被挪了就还原（§98.5）。
  const tops = useRef(new WeakMap<Element, number>());
  const pinned = useRef(new WeakSet<Element>());
  const scrollers = useRef(new Set<Element>());
  useEffect(() => {
    const el = box.current;
    if (!el || !visible) return;
    const remember = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && el.contains(target)) {
        // 和读 scrollTop 是同一次（已经干净的）布局，不多一次强制重算。
        tops.current.set(target, target.scrollTop);
        if (target.scrollHeight > 0 && target.scrollHeight - target.scrollTop - target.clientHeight <= 2) pinned.current.add(target);
        else pinned.current.delete(target);
        scrollers.current.add(target);
      }
    };
    el.addEventListener("scroll", remember, { capture: true, passive: true });
    return () => el.removeEventListener("scroll", remember, { capture: true });
  }, [visible]);

  // 藏起来那一刻：交给页面自己的 save()、数一下元素数（不读布局）。贴没贴底在滚动时已经记下了。
  const savedScroll = useRef(new Map<KeptScrollHandler, unknown>());
  const firstLayout = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    const first = firstLayout.current;
    firstLayout.current = false;
    if (!el) return;
    if (!visible) {
      if (first) return;
      savedScroll.current.clear();
      for (const h of scrollHandlers.current) savedScroll.current.set(h, h.save());
      report.current(entryId, el.getElementsByTagName("*").length);
      return;
    }
    if (first) return;
    // 变回看得见（绘制前）：页面自己接管的交给它；否则离开时贴底的追到底（藏着期间流进来的回答），没贴底的回到离开时的位置。
    if (scrollHandlers.current.size > 0) {
      for (const [h, saved] of savedScroll.current) if (scrollHandlers.current.has(h)) h.restore(saved);
      return;
    }
    for (const s of scrollers.current) {
      if (!s.isConnected) continue;
      if (pinned.current.has(s)) s.scrollTop = s.scrollHeight;
      else {
        const saved = tops.current.get(s);
        if (saved !== undefined && Math.abs(s.scrollTop - saved) >= 1) s.scrollTop = saved;
      }
    }
  }, [visible]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || visible) return;
    const hold = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !el.contains(target)) return;
      const saved = tops.current.get(target);
      if (saved !== undefined && Math.abs(target.scrollTop - saved) >= 1) target.scrollTop = saved;
    };
    el.addEventListener("scroll", hold, { capture: true, passive: true });
    const timer = window.setTimeout(() => el.removeEventListener("scroll", hold, { capture: true }), KEPT_SCROLL_HOLD_MS);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("scroll", hold, { capture: true });
    };
  }, [visible]);

  const frozen = visible ? null : size.current;
  const keptStyle: CSSProperties | undefined = visible
    ? undefined
    : {
        visibility: "hidden",
        contentVisibility: "hidden",
        overflowAnchor: "none",
        pointerEvents: "none",
        position: "absolute",
        top: 0,
        left: 0,
        ...(frozen ? { flex: "none", width: frozen.width, height: frozen.height } : { width: "100%", height: "100%" }),
      };

  return (
    <div
      aria-hidden={visible ? undefined : true}
      className="kept-chat flex min-h-0 min-w-0 flex-1 flex-col"
      data-kept-key={slotKey}
      data-testid="kept-page"
      data-visible={visible ? "true" : "false"}
      inert={!visible}
      ref={box}
      style={keptStyle}
    >
      <KeptSlotContext.Provider value={slot}>
        <KeptVisibleContext.Provider value={visible}>{render.current(value, { visible, epoch })}</KeptVisibleContext.Provider>
      </KeptSlotContext.Provider>
    </div>
  );
}
