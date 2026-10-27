import { IconSearch, IconX } from "@tabler/icons-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { scrollIntoViewWithin } from "@/lib/scroll-within";
import { findEntry, type SettingsViewer } from "@/lib/settings/registry";
import { hitHash, type SettingsHit, searchSettings } from "@/lib/settings/search";
import { cn } from "@/lib/utils";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function typingIn(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** 设置搜索的状态（DESIGN.md §97）：输入、命中、键盘选中的那一条、跳转。Ctrl/⌘ K 或 / 聚焦。 */
export function useSettingsSearch(viewer: SettingsViewer) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const sidebar = useOptionalSidebar();
  const hits = useMemo(() => searchSettings(query, viewer), [query, viewer]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const modK = mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !typingIn(event.target);
      if (!modK && !slash) return;
      // 在设置里 Ctrl K 是「搜索设置」，不是顶栏的「搜索会话」。
      event.preventDefault();
      event.stopImmediatePropagation();
      if (sidebar?.isMobile) sidebar.setOpenMobile(true);
      else if (sidebar && sidebar.state === "collapsed") sidebar.setOpen(true);
      const focus = (tries = 0) => {
        const input = inputRef.current;
        if (input) {
          input.focus();
          input.select();
        } else if (tries < 10) requestAnimationFrame(() => focus(tries + 1));
      };
      focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sidebar]);

  function go(hit: SettingsHit) {
    const hash = hitHash(hit);
    void navigate({ to: hit.page.to, ...(hash ? { hash } : {}) });
    setQuery("");
    inputRef.current?.blur();
    if (sidebar?.isMobile) sidebar.setOpenMobile(false);
  }
  return { query, setQuery, hits, active, setActive, inputRef, go };
}
export type SettingsSearch = ReturnType<typeof useSettingsSearch>;

export function SettingsSearchBox({ search }: { search: SettingsSearch }) {
  const { query, setQuery, hits, active, setActive, inputRef, go } = search;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
    <div className="settings-search" role="search">
      <IconSearch aria-hidden className="settings-search-icon" />
      <input
        aria-activedescendant={query && hits[active] ? `settings-hit-${hits[active].id}` : undefined}
        aria-autocomplete="list"
        aria-controls="settings-search-results"
        aria-expanded={Boolean(query.trim())}
        aria-label="搜索设置"
        className="settings-search-input"
        data-testid="settings-search"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && hits.length) {
            setActive((active + 1) % hits.length);
            event.preventDefault();
          } else if (event.key === "ArrowUp" && hits.length) {
            setActive((active - 1 + hits.length) % hits.length);
            event.preventDefault();
          } else if (event.key === "Enter" && hits[active]) {
            go(hits[active]);
            event.preventDefault();
          } else if (event.key === "Escape") {
            if (query) setQuery("");
            else event.currentTarget.blur();
            event.preventDefault();
          }
        }}
        placeholder="搜索设置"
        ref={inputRef}
        role="combobox"
        type="text"
        value={query}
      />
      {query ? (
        <button aria-label="清空搜索" className="settings-search-clear" onClick={() => { setQuery(""); inputRef.current?.focus(); }} type="button">
          <IconX className="size-3.5" />
        </button>
      ) : (
        <kbd aria-hidden className="settings-search-kbd">{isMac ? "⌘K" : "Ctrl K"}</kbd>
      )}
    </div>
  );
}

export function SettingsSearchResults({ search }: { search: SettingsSearch }) {
  const { query, hits, active, setActive, go } = search;
  if (!hits.length)
    return (
      <div className="settings-search-empty" id="settings-search-results" role="status">
        <p className="settings-search-empty-t">没有找到「{query.trim()}」相关的设置</p>
        <p className="settings-search-empty-s">换个说法试试，比如「模型」「密钥」「电脑」「完全访问」。</p>
      </div>
    );
  return (
    <div aria-label="搜索结果" className="settings-search-list" id="settings-search-results" role="listbox">
      {hits.map((hit, index) => {
        const Icon = hit.page.icon;
        return (
          <button
            aria-selected={index === active}
            className={cn("nav-row settings-hit", index === active && "is-active")}
            id={`settings-hit-${hit.id}`}
            key={hit.id}
            onClick={() => go(hit)}
            onMouseMove={() => index !== active && setActive(index)}
            role="option"
            tabIndex={-1}
            type="button"
          >
            <span className="nav-row-ico">
              <Icon className="size-[17px]" />
            </span>
            <span className="nav-row-text">
              <span className="nav-row-t">{hit.title}</span>
              <span className="nav-row-s">{hit.path} · {hit.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 搜索跳过去之后：按 `#find=<页.项>` 找到页面上那一块（区块标题 / 设置行标题 / 卡片标题的文字），滚进来、闪一下；
 * 普通的 `#某个id` 也一样处理。页面的数据是异步来的，所以最多等 4 秒。
 */
export function SettingsFind() {
  const hash = useRouterState({ select: (state) => state.location.hash });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => {
    if (!hash) return;
    const raw = decodeURIComponent(hash.replace(/^#/, ""));
    const entry = raw.startsWith("find=") ? findEntry(raw.slice(5)) : null;
    const text = entry?.item?.find ?? null;
    if (raw.startsWith("find=") && !text) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const locate = (): HTMLElement | null => {
      if (!text) return document.getElementById(raw);
      const candidates = document.querySelectorAll<HTMLElement>(
        "main h2, main h3, main [data-slot=item-title], main .sg-srow-t, main label, main legend, [data-slot=page-section] h2",
      );
      for (const el of candidates) if (el.textContent?.trim() === text) return el;
      for (const el of candidates) if (el.textContent?.trim().startsWith(text)) return el;
      return null;
    };
    const attempt = () => {
      if (cancelled) return;
      const found = locate();
      if (!found) {
        if (Date.now() - started < 4000) timer = setTimeout(attempt, 150);
        return;
      }
      const target =
        found.closest<HTMLElement>("[data-slot=item], .sg-srow, .sg-card, [data-slot=page-section], section") ?? found;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      // 只滚设置页自己的滚动容器（§98.5）：原生 scrollIntoView 会连藏在下面的聊天一起挪。
      scrollIntoViewWithin(target, { block: "center", behavior: reduce ? "auto" : "smooth" });
      target.classList.remove("setting-flash");
      void target.offsetWidth;
      target.classList.add("setting-flash");
      target.setAttribute("data-setting-found", "");
      timer = setTimeout(() => {
        target.classList.remove("setting-flash");
        target.removeAttribute("data-setting-found");
      }, 2400);
    };
    timer = setTimeout(attempt, 60);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hash, pathname]);
  return null;
}
