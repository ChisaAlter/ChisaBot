// biome-ignore-all lint/style/noNonNullAssertion: indexes are bounded by the loop / length checks right above each access.
import { IconArrowUpRight, IconCheck, IconCopy } from "@tabler/icons-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cn } from "@/lib/utils";
import { canTween, easeOut, formatLike, parseNumeric, safeHttp } from "./rich-utils";

/**
 * 富组件的运行环境（DESIGN.md §32）：一张界面画在哪里（对话 / 右栏面板），点了以后做什么。
 *
 * 对话里：ask = 以用户身份发一句话（ConversationProvider），refresh 没有。
 * 面板里：ask = 发到当前机器人的对话（频道聊天 channel-chat.tsx 监听 chisabot-ask），refresh = 立即刷新这张面板。
 * 链接一律新标签页（rel=noopener noreferrer），只放行 http(s)。
 */
export type RichActions = {
  surface: "chat" | "panel";
  ask?: (text: string) => void;
  refresh?: () => void;
  openLink: (url: string) => void;
  copy: (text: string) => Promise<boolean>;
};

export function openInNewTab(url: string) {
  const safe = safeHttp(url);
  if (safe) window.open(safe, "_blank", "noopener,noreferrer");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 不安全上下文 / 没有权限：退回到选区复制。
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const DEFAULT_ACTIONS: RichActions = { surface: "chat", openLink: openInNewTab, copy: copyText };
const RichUiContext = createContext<RichActions>(DEFAULT_ACTIONS);

export function RichUiProvider({ value, children }: { value: Partial<RichActions>; children: ReactNode }) {
  return <RichUiContext.Provider value={{ ...DEFAULT_ACTIONS, ...value }}>{children}</RichUiContext.Provider>;
}

export function useRichActions(): RichActions {
  return useContext(RichUiContext);
}

/* ── 互斥选项（CB-090）：同一张对话界面里带 choice 的按钮只能选一个 ── */

export type ChoiceScope = {
  /** 已选那一项替用户说的话（`ask`，去掉首尾空白）；null = 还没选。 */
  picked: string | null;
  /** 选这一项：还没选过才发出去，返回是否真的发了（连点 / 双击只发一次）。 */
  pick: (ask: string) => boolean;
};

const ChoiceContext = createContext<ChoiceScope | null>(null);

/**
 * 一张对话界面的选项状态。`initial` 来自对话记录（这张界面之后用户说的第一句话），所以刷新、换设备后
 * 还认得选过哪一个；它不等于任何一个选项时（用户自己打了别的话）不算选过，按钮照常能点。
 * 右栏面板不挂这个：面板里的 ask 本来就可以反复问。
 */
export function ChoiceProvider({
  initial,
  options,
  ask,
  children,
}: {
  initial: string | null;
  /** 这张界面里所有 choice 按钮的 ask（去掉首尾空白）。 */
  options: readonly string[];
  ask: ((text: string) => void) | undefined;
  children: ReactNode;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(initial);
  const lock = useRef(false);
  const askRef = useRef(ask);
  askRef.current = ask;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const answeredRef = useRef(answered);
  answeredRef.current = answered;
  const pick = useCallback((text: string) => {
    const said = text.trim();
    if (!said || lock.current || !askRef.current) return false;
    // 对话记录里已经有答案（别的设备上选的）：同样不再发。
    if (answeredRef.current && optionsRef.current.includes(answeredRef.current)) return false;
    lock.current = true;
    setPicked(said);
    askRef.current(said);
    return true;
  }, []);
  // 对话记录后来才读到（恢复历史晚到）：补上，但不覆盖本机刚点的那一下。
  useEffect(() => {
    if (initial) setAnswered((current) => current ?? initial);
  }, [initial]);
  const effective = picked ?? (answered && options.includes(answered) ? answered : null);
  const value = useMemo<ChoiceScope>(() => ({ picked: effective, pick }), [effective, pick]);
  return <ChoiceContext.Provider value={value}>{children}</ChoiceContext.Provider>;
}

/** 这张界面的选项状态；不在对话里（右栏面板）是 null。 */
export function useChoiceScope(): ChoiceScope | null {
  return useContext(ChoiceContext);
}

/** 一个 choice 按钮此刻的样子：`picked` = 选的就是它，`locked` = 这张界面已经选过了，不能再点。 */
export function choiceState(
  scopePicked: string | null,
  ownAsk: string | null | undefined,
): { picked: boolean; locked: boolean } {
  if (!scopePicked) return { picked: false, locked: false };
  return { picked: (ownAsk?.trim() ?? "") === scopePicked, locked: true };
}

/** 从一份规范里收集所有 choice 按钮的 ask（去重、去掉首尾空白）。 */
export function choiceOptionsOf(
  elements: Record<string, { type?: string; props?: unknown } | undefined> | undefined,
): string[] {
  const found = new Set<string>();
  for (const element of Object.values(elements ?? {})) {
    if (element?.type !== "Button") continue;
    const props = element.props as { choice?: unknown; ask?: unknown } | undefined;
    if (props?.choice === true && typeof props.ask === "string" && props.ask.trim()) found.add(props.ask.trim());
  }
  return [...found];
}

/* ── 共用的时钟：整页一个 setInterval，倒计时 / 时钟 / 相对时间都订阅它，不各开各的定时器 ── */

const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;
let nowSecond = Math.floor(Date.now() / 1000);
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!ticker) {
    nowSecond = Math.floor(Date.now() / 1000);
    ticker = setInterval(() => {
      const next = Math.floor(Date.now() / 1000);
      if (next === nowSecond) return;
      nowSecond = next;
      for (const l of listeners) l();
    }, 250);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

/**
 * 当前时间（毫秒），按 granularity 秒取整后才触发重渲染：倒计时用 1，相对时间用 15 / 60。
 * 页面在后台时浏览器会放慢定时器，回到前台第一下就追上。
 */
export function useNow(granularitySeconds = 1): number {
  const second = useSyncExternalStore(
    subscribe,
    () => Math.floor(nowSecond / granularitySeconds),
    () => Math.floor(Date.now() / 1000 / granularitySeconds),
  );
  return second * granularitySeconds * 1000 || Date.now();
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(query.matches);
    query.addEventListener?.("change", on);
    return () => query.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/**
 * 刷新时的「值变了」：数字从旧值平滑滚到新值（300ms，先快后慢），同时整块短暂高亮一下
 * （.jr-flash，1.2 秒淡出）。第一次出现不滚动、不高亮；减少动态效果时直接换成新值，只留一个静态的淡底。
 *
 * 面板刷新时规范的元素 key 不变（刷新说明要求「保持同样的布局，只换数据」），React 复用同一个组件，
 * 所以这里能拿到上一次的值。
 */
export function useLiveValue(value: string): { shown: string; flash: boolean } {
  const reduced = usePrefersReducedMotion();
  const previous = useRef<string | null>(null);
  const [shown, setShown] = useState(value);
  const [flash, setFlash] = useState(false);
  const frame = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before === null || before === value) {
      setShown(value);
      return;
    }
    setFlash(true);
    const from = parseNumeric(before);
    const to = parseNumeric(value);
    if (reduced || !canTween(from, to) || typeof requestAnimationFrame !== "function") {
      setShown(value);
    } else {
      const start = performance.now();
      const duration = 300;
      const step = (time: number) => {
        const t = Math.min(1, (time - start) / duration);
        const current = from!.value + (to!.value - from!.value) * easeOut(t);
        setShown(t >= 1 ? value : formatLike(current, to!));
        if (t < 1) frame.current = requestAnimationFrame(step);
      };
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(step);
    }
    const timer = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(timer);
  }, [value, reduced]);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return { shown, flash };
}

/** 一个会滚动 + 高亮的数值（外层自己决定字号、颜色）。 */
export function LiveText({ value, className }: { value: string; className?: string }) {
  const { shown, flash } = useLiveValue(value);
  return <span className={cn("jr-live", flash && "jr-flash", className)}>{shown}</span>;
}

/* ── 可点的项：href → <a target=_blank>（↗），ask → 发一句话，copy → 复制（✓ 已复制）── */

export type ItemAction = { href?: string | null; ask?: string | null; copy?: string | null };

export function hasAction(item: ItemAction | null | undefined, actions: RichActions): boolean {
  if (!item) return false;
  return Boolean(safeHttp(item.href) || (item.ask && actions.ask) || item.copy);
}

/**
 * 把一块内容变成可点的：有 href 就是新标签页链接（右上角 ↗），有 ask 就替用户发一句话，有 copy 就复制。
 * 没有动作就是普通的 div，不显示任何可点的样子。键盘可达（Tab + Enter），按下有 0.98 缩放（减少动态时没有）。
 */
export function ActionArea({
  item,
  className,
  children,
  label,
  affordance = "corner",
}: {
  item: ItemAction | null | undefined;
  className?: string;
  children: ReactNode;
  /** 无障碍名称（默认用内容）。 */
  label?: string;
  /** ↗ 放在哪里：corner = 右上角浮出，inline = 跟在内容后面，none = 不画。 */
  affordance?: "corner" | "inline" | "none";
}) {
  const actions = useRichActions();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const href = safeHttp(item?.href);
  const onCopy = useCallback(async () => {
    if (item?.copy && (await actions.copy(item.copy))) setCopied(true);
  }, [actions, item?.copy]);

  if (href) {
    return (
      <a
        className={cn("jr-action is-link", className)}
        href={href}
        onClick={(event) => {
          // 保持原生链接（中键、⌘ 点击、右键复制地址都照常），只是强制新标签页。
          event.stopPropagation();
        }}
        rel="noopener noreferrer"
        target="_blank"
        title={href}
      >
        {children}
        {affordance === "none" ? null : (
          <IconArrowUpRight aria-hidden className={cn("jr-action-go", affordance === "inline" && "is-inline")} />
        )}
      </a>
    );
  }
  if (item?.ask && actions.ask) {
    const ask = actions.ask;
    const text = item.ask;
    return (
      <button className={cn("jr-action is-ask", className)} onClick={() => ask(text)} title={`发送：${text}`} type="button">
        {children}
      </button>
    );
  }
  if (item?.copy) {
    return (
      <button aria-label={label ? `复制 ${label}` : "复制"} className={cn("jr-action is-copy", copied && "is-copied", className)} onClick={onCopy} title={copied ? "已复制" : "点击复制"} type="button">
        {children}
        {affordance === "none" ? null : copied ? (
          <IconCheck aria-hidden className={cn("jr-action-go is-ok", affordance === "inline" && "is-inline")} />
        ) : (
          <IconCopy aria-hidden className={cn("jr-action-go", affordance === "inline" && "is-inline")} />
        )}
        <span aria-live="polite" className="sr-only">{copied ? "已复制" : ""}</span>
      </button>
    );
  }
  return <div className={className}>{children}</div>;
}
