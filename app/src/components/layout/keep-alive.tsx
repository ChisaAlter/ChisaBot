import { createKeptVisibility, KeptVisibilityContext, KeptVisibleContext } from "@/lib/kept-visible";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 藏着的聊天留多久（之后卸载，回来走正常的打开：先画上次的样子，再接入）。 */
export const KEPT_TTL_MS = 10 * 60_000;

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
 * 主区里「留着的一页 + 当前路由」（DESIGN.md §98）。
 *
 * - `address` 不为 null（地址正是那一页，比如 `/channel/:id`）：留着的那页看得见，路由那一层不占位置
 *   （那条路由自己什么都不画）。`address` 换了（换了一段对话）就换成新的那页。
 * - `address` 为 null（别的页面）：路由那一层盖在上面（`absolute inset-0`，和主区一样的 flex 列），留着的那页
 *   藏在下面——不卸载，`visibility: hidden` + `inert` + `aria-hidden`，宽高冻在离开时的样子（右栏、横幅没了主区
 *   会变宽变高，不冻的话整段对话要重排，回来时滚动位置就对不上）。藏够 `ttlMs` 就卸载。
 * - `idleVisible`：地址不是那一页，但正在跳过去（`/` → 最近的对话），留着的那页先露着，不空一下。
 *
 * 路由那一层永远是同一个元素、只换样式，路由内容不会因为留没留着而重新挂载。
 */
export function KeepAliveStage<T>({
  address,
  idleVisible = false,
  same,
  renderKept,
  ttlMs = KEPT_TTL_MS,
  children,
}: {
  address: T | null;
  /** 布尔，或按留着的那页判断（`/` 正跳向的正是它时才露着）。 */
  idleVisible?: boolean | ((kept: T) => boolean);
  same: (a: T, b: T) => boolean;
  renderKept: (kept: T, state: KeptState) => ReactNode;
  ttlMs?: number;
  children: ReactNode;
}) {
  const [kept, setKept] = useState<T | null>(address);
  if (address !== null && (kept === null || !same(address, kept))) setKept(address);
  const idle = kept !== null && (typeof idleVisible === "function" ? idleVisible(kept) : idleVisible);
  const shown = address !== null || idle;
  const visible = kept !== null && shown;

  // 不让读的组件重画的那份「看不看得见」（`useKeptVisibility`）：同一个对象，提交后改值、通知订阅者。
  const [visibility] = useState(() => createKeptVisibility(visible));
  useEffect(() => visibility.set(visible), [visibility, visible]);

  const [epoch, setEpoch] = useState(0);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setEpoch((n) => n + 1);
  }

  useEffect(() => {
    if (visible || kept === null) return;
    const timer = window.setTimeout(() => setKept(null), ttlMs);
    return () => window.clearTimeout(timer);
  }, [visible, kept, ttlMs]);

  // 看得见时一直记着尺寸；藏起来那一刻（同一次提交、新页面画出来之前）用记下的尺寸冻住。
  // 尺寸只从 ResizeObserver 拿（浏览器排完版后给，开始观察时也会先给一次）：以前变回看得见的那次提交里
  // 当场 getBoundingClientRect，关设置时逼浏览器在提交中途把整段对话排一遍版（4× 降速 60ms+，§41 ④）。
  const box = useRef<HTMLDivElement>(null);
  const size = useRef<{ width: number; height: number } | null>(null);
  const hasKept = kept !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => {
    const el = box.current;
    if (!el || !visible) return;
    const remember = (width: number, height: number) => {
      if (width > 0 && height > 0) size.current = { width, height };
    };
    if (typeof ResizeObserver === "undefined") {
      const rect = el.getBoundingClientRect();
      remember(rect.width, rect.height);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const border = entry?.borderBoxSize?.[0];
      if (border) remember(border.inlineSize, border.blockSize);
      else {
        const rect = el.getBoundingClientRect();
        remember(rect.width, rect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, hasKept]);

  // 看得见时记着每个滚动容器最后的位置；藏起来后 KEPT_SCROLL_HOLD_MS 内被挪了就还原（§98.5）。
  const tops = useRef(new WeakMap<Element, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => {
    const el = box.current;
    if (!el || !visible) return;
    const remember = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && el.contains(target)) tops.current.set(target, target.scrollTop);
    };
    el.addEventListener("scroll", remember, { capture: true, passive: true });
    return () => el.removeEventListener("scroll", remember, { capture: true });
  }, [visible, hasKept]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
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
  }, [visible, hasKept]);

  const frozen = visible ? null : size.current;
  const keptStyle: CSSProperties | undefined = visible
    ? undefined
    : {
        visibility: "hidden",
        pointerEvents: "none",
        ...(frozen ? { flex: "none", width: frozen.width, height: frozen.height } : {}),
      };

  return (
    <div className="keep-stage relative flex min-h-0 min-w-0 flex-1 flex-col" data-kept-visible={visible ? "true" : "false"}>
      {kept !== null ? (
        <div
          aria-hidden={visible ? undefined : true}
          className="kept-chat flex min-h-0 min-w-0 flex-1 flex-col"
          data-testid="kept-page"
          data-visible={visible ? "true" : "false"}
          inert={!visible}
          ref={box}
          style={keptStyle}
        >
          <KeptVisibleContext.Provider value={visible}>
            <KeptVisibilityContext.Provider value={visibility}>{renderKept(kept, { visible, epoch })}</KeptVisibilityContext.Provider>
          </KeptVisibleContext.Provider>
        </div>
      ) : null}
      <div
        className={shown ? "route-layer contents" : "route-layer absolute inset-0 z-[1] flex min-h-0 min-w-0 flex-col"}
        data-testid="route-layer"
      >
        {children}
      </div>
    </div>
  );
}
