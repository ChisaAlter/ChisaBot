import { IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import {
  onSidebarSearchFocusRequest,
  setSidebarSearch,
  takeSidebarSearchFocus,
  useSidebarSearch,
} from "@/lib/sidebar-search";
import { clearSearchActive, moveSearchActive, openSearchActive, SEARCH_RESULTS_ID } from "@/lib/sidebar-search-nav";

const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * 左栏卡片顶部的「搜索会话」（DESIGN-v4）：输入框和结果在同一张卡片上。
 * 36px 高，宽度跟着卡片，聚焦只加深边框 + 轻阴影，不改变尺寸、不推动任何元素。
 * Ctrl K 由外壳统一处理（展开左栏 → 聚焦这里）。Esc 清空并离开。
 * ↑ / ↓ 在结果里移动高亮、Enter 打开（CB-106，lib/sidebar-search-nav.ts）；焦点一直留在输入框。
 *
 * `variant="topbar"`：Hark 风格顶栏右上角的搜索胶囊（电脑上）。同一个输入框、同一份搜索状态，
 * 结果仍画在左栏卡片里；左栏收起时一聚焦就展开，结果有地方显示。手机上搜索框留在左栏抽屉里。
 */
export function SidebarSearchField({ variant = "rail" }: { variant?: "rail" | "topbar" } = {}) {
  const c = variant === "topbar" ? TOPBAR_CLASSES : RAIL_CLASSES;
  const sidebar = useOptionalSidebar();
  const search = useSidebarSearch();
  const input = useRef<HTMLInputElement>(null);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  // 换了关键词，结果列表就换了：旧高亮作废。
  // biome-ignore lint/correctness/useExhaustiveDependencies: search 是触发条件，换关键词就要清高亮。
  useEffect(() => {
    clearSearchActive();
    setActiveId(undefined);
  }, [search]);
  useEffect(() => {
    const focus = () => {
      if (!takeSidebarSearchFocus()) return;
      // 左栏刚展开时输入框还在过渡里，下一帧再聚焦，光标不会落空。
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    };
    focus();
    return onSidebarSearchFocusRequest(focus);
  }, []);
  return (
    <label className={c.root}>
      <IconSearch aria-hidden className={c.ico} />
      <input
        aria-activedescendant={search && activeId ? activeId : undefined}
        aria-autocomplete="list"
        aria-controls={search ? SEARCH_RESULTS_ID : undefined}
        aria-expanded={Boolean(search)}
        aria-label={"搜索会话"}
        className={c.input}
        onChange={(event) => setSidebarSearch(event.target.value)}
        onFocus={() => {
          if (variant === "topbar" && sidebar && !sidebar.isMobile && !sidebar.open) sidebar.setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            // CB-106 r2：组字时的 Esc 是输入法在取消候选词，不是要关抽屉（360 宽左栏是抽屉）。
            if (event.key === "Escape") event.stopPropagation();
            return;
          }
          if (search && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setActiveId(moveSearchActive(event.key === "ArrowDown" ? 1 : -1));
            return;
          }
          if (search && event.key === "Enter") {
            if (openSearchActive()) {
              event.preventDefault();
              setActiveId(undefined);
            }
            return;
          }
          if (event.key === "Escape") {
            setSidebarSearch("");
            event.currentTarget.blur();
          }
        }}
        placeholder={"搜索会话"}
        ref={input}
        role="combobox"
        value={search}
      />
      {search ? (
        <button aria-label={"清除搜索"} className={c.clear} onClick={() => setSidebarSearch("")} type="button">
          <IconX className="size-3.5" />
        </button>
      ) : (
        <kbd aria-hidden className={c.kbd}>
          {MAC ? "⌘K" : "Ctrl K"}
        </kbd>
      )}
    </label>
  );
}

const RAIL_CLASSES = {
  root: "side-search",
  ico: "side-search-ico",
  input: "side-search-input",
  clear: "side-search-clear",
  kbd: "side-search-kbd",
};

/** 顶栏胶囊用新类名（hk-*），不吃旧层里压在 side-search 上的覆盖规则。 */
const TOPBAR_CLASSES = {
  root: "hk-search glass is-flat",
  ico: "hk-search-ico",
  input: "hk-search-input",
  clear: "hk-search-clear",
  kbd: "hk-search-kbd",
};
