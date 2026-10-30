import { IconArrowRight, IconChevronRight, IconExternalLink } from "@tabler/icons-react";
import { Link, type LinkOptions, useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { AccountCard, AccountMenu } from "@/components/layout/account-menu";
import { RosterToggle } from "@/components/layout/roster-toggle";
import { Sidebar, SidebarContent, SidebarRail, useOptionalSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { scrollIntoViewWithin } from "@/lib/scroll-within";
import { cn } from "@/lib/utils";

/**
 * The left column for settings and admin (DESIGN.md §11 左栏行 / §13).
 *
 * Same family as the chat roster: one L1 glass card (area title on top — no "返回应用" pill since v3)
 * holding grouped `nav-row`s, a footer, and — collapsed with Ctrl+B — the same 80px rail of icon
 * tiles the roster turns into. Only the rows differ: sections instead of Bots.
 */
export type RailItem = {
  title: string;
  /** Second line under the title (settings sections); admin rows are single-line. */
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Lights only on its own route — for an entry whose path prefixes the others'. */
  exact?: boolean;
} & ({ linkOptions: LinkOptions; href?: never } | { href: string; linkOptions?: never });

export type RailGroup = {
  label?: string;
  items: RailItem[];
  /**
   * 默认折叠的分组（设置 → 高级，DESIGN.md §57）：标题是一个开关，展开状态记在 localStorage；
   * 当前页在组里时总是展开。收起成图标栏时照常列出。
   */
  collapsible?: {
    storageKey: string;
    /**
     * 没记过开关时怎么摆（CB-058，DESIGN.md §71.7）：默认只展开当前页所在的组；当前页不在任何组里时，
     * `defaultOpen` 的组展开。记过就按记的来。
     */
    defaultOpen?: boolean;
    /** 只在桌面左栏折叠；手机抽屉里照常全部列出（抽屉本来就整屏滚动）。 */
    desktopOnly?: boolean;
  };
};

function inGroup(group: RailGroup, pathname: string) {
  return group.items.some((item) => {
    const to = item.linkOptions?.to;
    return typeof to === "string" && (pathname === to || pathname.startsWith(`${to}/`));
  });
}

export function SectionRail({
  ariaLabel,
  title,
  groups,
  footerLink,
  header,
  body,
  ...props
}: {
  ariaLabel: string;
  /** The area's name at the top of the card (偏好设置 / 管理后台). DESIGN-v3 §6.1. */
  title: string;
  groups: RailGroup[];
  /** The icon button in the footer: the way across to the other area (settings ↔ admin). */
  footerLink?: { label: string; to: string; search?: Record<string, unknown>; icon: React.ComponentType<{ className?: string }> };
  /** 标题下面、列表上面的东西（设置搜索框，DESIGN.md §97）。只在展开的左栏里画。 */
  header?: React.ReactNode;
  /** 给了就替换掉分组列表（设置搜索有结果 / 没结果时）。 */
  body?: React.ReactNode;
} & React.ComponentProps<typeof Sidebar>) {
  const sidebar = useOptionalSidebar();
  const collapsed = Boolean(sidebar && !sidebar.isMobile && sidebar.state === "collapsed");
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const scope = pathname === "/admin" || pathname.startsWith("/admin/") ? "admin" : "settings";
  // 只看可折叠的组：当前页在不折叠的组里（设置 →「通用」）时，照样展开 defaultOpen 的那一组。
  const anyHere = groups.some((group) => group.collapsible && inGroup(group, pathname));
  const scrollRef = useRef<HTMLDivElement>(null);
  // 当前页那一行在可视区外（矮屏、组都展开着）时，打开设置先把它滚进来。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => {
    // 只滚左栏自己（§98.5）：原生 scrollIntoView 会连藏在下面的聊天一起挪。
    const box = scrollRef.current;
    const row = box?.querySelector<HTMLElement>(".nav-row.is-on");
    if (!box || !row) return;
    // 放到下一帧再量（jank P1-6）：打开设置的那一帧不为它强制排版；行已在可视区内就不滚。
    const frame = requestAnimationFrame(() => {
      if (!rowOutOfView(row, box)) return;
      scrollIntoViewWithin(row, { container: box });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  if (collapsed) {
    return (
      <Sidebar collapsible="icon" variant="floating" {...props}>
        <nav aria-label={ariaLabel} className="glass-mini" id="chisabot-bot-list">
          <RosterToggle className="glass-mini-toggle" scope={scope} />
          <div className="glass-card glass-mini-card">
            <div className="glass-mini-scroll">
              {groups.map((group, gi) => (
                <div className="rail-mini-group" key={group.label ?? gi}>
                  {gi > 0 ? <span aria-hidden className="rail-mini-sep" /> : null}
                  {group.items.map((item) => (
                    <RailTip key={item.title} label={item.title}>
                      {item.href ? (
                        <a aria-label={item.title} className="glass-mini-bot rail-mini-item" href={item.href} rel="noopener noreferrer" target="_blank">
                          <item.icon className="size-[18px]" />
                        </a>
                      ) : (
                        <Link
                          {...item.linkOptions}
                          activeOptions={{ exact: item.exact ?? false }}
                          activeProps={{ className: "is-on" }}
                          aria-label={item.title}
                          className="glass-mini-bot rail-mini-item"
                        >
                          <item.icon className="size-[18px]" />
                        </Link>
                      )}
                    </RailTip>
                  ))}
                </div>
              ))}
            </div>
            {footerLink ? (
              <div className="glass-mini-links">
                <RailTip label={footerLink.label}>
                  <Link aria-label={footerLink.label} className="glass-mini-link" search={footerLink.search as never} to={footerLink.to}>
                    <footerLink.icon className="size-[18px]" />
                  </Link>
                </RailTip>
              </div>
            ) : null}
          </div>
          <div className="glass-card acct-mini-card">
            <AccountMenu compact />
          </div>
        </nav>
      </Sidebar>
    );
  }

  return (
    <Sidebar collapsible="icon" variant="floating" {...props}>
      <SidebarContent className="glass-side-full gap-3 overflow-hidden" id="chisabot-bot-list">
        <nav aria-label={ariaLabel} className="glass-card glass-side-card min-h-0 flex-1">
          {/* DESIGN-v3 §6.1：没有「返回应用」胶囊（顶栏主导航就是回去的路），卡片顶部是区域名。 */}
          <div className="rail-title rail-title-row">
            <span className="rail-title-text">{title}</span>
            <RosterToggle scope={scope} />
          </div>
          {header}
          <div className="glass-side-scroll rail-scroll" ref={scrollRef}>
            {body ?? groups.map((group, gi) =>
              group.collapsible && !(group.collapsible.desktopOnly && sidebar?.isMobile) ? (
                <CollapsibleGroup anyHere={anyHere} first={gi === 0} group={group} key={group.label ?? gi} />
              ) : (
                <div className={cn("rail-group", gi > 0 && "mt-2")} key={group.label ?? gi}>
                  {group.label ? (
                    <div className="glass-sec">
                      <span>{group.label}</span>
                    </div>
                  ) : null}
                  <div className="rail-list">
                    {group.items.map((item) => (
                      <NavRow item={item} key={item.title} />
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>
          <RailFooter link={footerLink} />
        </nav>
        {/* DESIGN-v4：账号在每个区域都在左栏最底下同一个位置。 */}
        <AccountCard />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

/** 记过的开关：true / false；没记过：null。 */
function readOpen(key: string): boolean | null {
  try {
    const v = window.localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function CollapsibleGroup({ group, anyHere, first }: { group: RailGroup; anyHere: boolean; first: boolean }) {
  const key = group.collapsible?.storageKey ?? "";
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [stored, setStored] = useState(() => readOpen(key));
  const here = inGroup(group, pathname);
  const open = here || (stored ?? (!anyHere && Boolean(group.collapsible?.defaultOpen)));
  const toggle = () => {
    const next = !open;
    setStored(next);
    try {
      window.localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* 隐私模式：只在本次会话里记住 */
    }
  };
  return (
    <div className={cn("rail-group", !first && "mt-2")}>
      <button
        aria-expanded={open}
        className="glass-sec rail-sec-toggle"
        disabled={here}
        onClick={toggle}
        type="button"
      >
        <span>{group.label}</span>
        <IconChevronRight aria-hidden className="rail-sec-chev size-3.5" data-open={open || undefined} />
      </button>
      {open ? (
        <div className="rail-list">
          {group.items.map((item) => (
            <NavRow item={item} key={item.title} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NavRow({ item }: { item: RailItem }) {
  const sidebar = useOptionalSidebar();
  const closeDrawer = () => sidebar?.isMobile && sidebar.setOpenMobile(false);
  const body = (
    <>
      <span className="nav-row-ico">
        <item.icon className="size-[17px]" />
      </span>
      <span className="nav-row-text">
        <span className="nav-row-t">{item.title}</span>
        {item.sub ? <span className="nav-row-s">{item.sub}</span> : null}
      </span>
      {item.href ? <IconExternalLink className="nav-row-ext size-3.5" /> : null}
    </>
  );
  if (item.href) {
    return (
      <a className="nav-row" href={item.href} onClick={closeDrawer} rel="noopener noreferrer" target="_blank">
        {body}
      </a>
    );
  }
  return (
    <Link
      {...item.linkOptions}
      activeOptions={{ exact: item.exact ?? false }}
      activeProps={{ className: "is-on" }}
      className="nav-row"
      onClick={closeDrawer}
    >
      {body}
    </Link>
  );
}

/**
 * 卡片底部只留一条「切换到另一个区域」（偏好设置 ⇄ 管理后台，只有管理员有）。账号在卡片下面单独的账号卡里
 * （DESIGN-v4，三个区域同一位置）。
 */
function RailFooter({ link }: { link?: { label: string; to: string; search?: Record<string, unknown>; icon: React.ComponentType<{ className?: string }> } }) {
  if (!link) return null;
  return (
    <div className="rail-foot">
      <Link className="rail-switch" search={link.search as never} to={link.to}>
        <link.icon className="size-[17px] shrink-0" />
        <span className="min-w-0 flex-1 truncate">{link.label}</span>
        <IconArrowRight className="rail-switch-arrow size-4" />
      </Link>
    </div>
  );
}

function RailTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** 行是否（部分）在滚动容器的可视区之外。 */
export function rowOutOfView(row: HTMLElement, box: HTMLElement): boolean {
  const r = row.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return r.top < b.top || r.bottom > b.bottom;
}
