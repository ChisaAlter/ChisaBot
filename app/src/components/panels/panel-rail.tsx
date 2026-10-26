import { LivePanelList, useLivePanels } from "./live-panels";
import { useSegmentedKeys } from "@/components/ui/segmented";
import {
  IconDeviceDesktop,
  IconLayoutGrid,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useCurrentBotChat } from "@/lib/agents/bot-chat-context";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { usePanelBot } from "@/lib/panels/active-bot";
import { setBotUi } from "@/lib/chat/ui-memory";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";
import {
  PANEL_RAIL_HOTKEY,
  PANEL_RAIL_HOTKEY_LABEL,
  setPanelRailOpen,
  setPanelSheetOpen,
  showRailFor,
  togglePanelRail,
  usePanelRailOpen,
  usePanelSheetOpen,
  useWideForRail,
} from "@/lib/panels/rail-open";
import { matchesHotkey } from "@/lib/hotkeys/hotkeys";
import { ToggleTip } from "@/components/layout/glass-topbar";
import { cn } from "@/lib/utils";
import { lastHistoryEventWasPop, useBackDismiss } from "@/lib/overlay-back";

const WIDTH_KEY = "chisabot-panel-rail-width";
const MIN_WIDTH = 300;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 380;
/** 常驻栏两侧的内边距合计：卡片宽度 = 栏宽 − 它（拖动期两格一起写）。 */
const CARD_INSET = 24;
const PANEL_CARD_CLASS = "glass-card glass-rail-inner rail-card flex h-full min-h-0 flex-col";

export type PanelPreset = {
  label: string;
  prompt: string;
};

/** 右栏面板推荐预设（CB-094，DESIGN.md §114）：空态和栏头「＋」共用，支持按页轮换。 */
export const PANEL_PRESETS: readonly PanelPreset[] = [
  {
    label: "☀️ 今日晨报看板",
    prompt: "请帮我创建一个「今日晨报与待办概览」右侧实时面板，汇总天气、今日日程与待办事项",
  },
  {
    label: "📈 BTC 与黄金行情",
    prompt: "请帮我创建一个「比特币与黄金实时价格」右侧面板，每 15 分钟自动刷新",
  },
  {
    label: "🌤️ 天气与汇率",
    prompt: "请帮我创建一个「城市实时天气与主要汇率」右侧面板",
  },
  {
    label: "🖥️ 服务器状态监控",
    prompt: "请帮我创建一个「服务器 CPU / 内存 / 磁盘负载」右侧实时监控面板",
  },
  {
    label: "📰 科技热点速览",
    prompt: "请帮我创建一个「今日 AI 与科技头条」右侧面板，每小时自动刷新最新要闻",
  },
  {
    label: "📦 GitHub 仓库动态",
    prompt: "请帮我创建一个「GitHub 关注仓库最新提交与 Issue」右侧面板",
  },
  {
    label: "⏱️ 倒计时与纪念日",
    prompt: "请帮我创建一个「重要截止日与项目里程碑倒计时」右侧面板",
  },
  {
    label: "📬 邮件与日程摘要",
    prompt: "请帮我创建一个「今日未读重要邮件与接下来日程」右侧实时面板",
  },
  {
    label: "💹 美股与指数看板",
    prompt: "请帮我创建一个「纳斯达克、标普 500 与热门科技股行情」右侧面板",
  },
];

export function panelPresetBatch(batchIndex: number, pageSize = 3): PanelPreset[] {
  const total = PANEL_PRESETS.length;
  if (total === 0 || pageSize <= 0) return [];
  const batches = Math.ceil(total / pageSize);
  const normalized = ((batchIndex % batches) + batches) % batches;
  const start = normalized * pageSize;
  return PANEL_PRESETS.slice(start, start + pageSize);
}

function storedWidth() {
  const raw = Number(readStoredPreference(WIDTH_KEY));
  return Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH
    ? raw
    : DEFAULT_WIDTH;
}

/**
 * The right-hand column: the current Bot's live panels (and its computer). Resizable from its left
 * edge; the width is kept in localStorage.
 */
export function PanelRail({ className }: { className?: string }) {
  const [width, setWidth] = useState(storedWidth);
  const [dragging, setDragging] = useState(false);
  const open = usePanelRailOpen();
  const start = useRef<{ x: number; width: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  /** 拖动期真正生效的宽度：指针事件只改它和 DOM，不动 state（见下）。 */
  const liveWidth = useRef(width);

  /*
   * 拖动期不经过 React。面板栏里挂着实时面板、计算机卡和它们各自的轮询 / 查询，
   * 每帧 setWidth 会把整栏 reconciliation 一遍，正好和聊天列「重新换行 + 贴底」抢同一帧；而宽度真的
   * 要改的只有两格 inline style（栏 = width，卡 = width − 24）。这里直接写 DOM，松手才 setWidth +
   * 落盘：一次拖动从 ~60–120 次渲染降到 2 次（开始那一下的 dragging 覆盖层 + 松手）。
   *
   * 不会被 React 覆盖回去：state 在拖动期不变，React 按自己上一次渲染的值 diff inline style，不会重写。
   */
  const applyWidth = (next: number) => {
    liveWidth.current = next;
    if (railRef.current) railRef.current.style.width = `${next}px`;
    if (cardRef.current) cardRef.current.style.width = `${next - CARD_INSET}px`;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    start.current = { x: event.clientX, width };
    liveWidth.current = width;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const next = Math.round(
      Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, start.current.width + start.current.x - event.clientX),
      ),
    );
    if (next !== liveWidth.current) applyWidth(next);
  };
  /*
   * 右栏宽度和展开 / 收起按机器人记（DESIGN.md §88）：换了机器人，在绘制之前换成它上次的样子；
   * 没记过的机器人用全局最后一次的宽度。
   */
  const { botId: widthBot } = usePanelBot();
  const widthBotRef = useRef(widthBot);
  widthBotRef.current = widthBot;
  useLayoutEffect(() => {
    const remembered = showRailFor(widthBot);
    const next =
      remembered !== undefined && remembered >= MIN_WIDTH && remembered <= MAX_WIDTH ? remembered : storedWidth();
    liveWidth.current = next;
    setWidth(next);
  }, [widthBot]);
  const keepWidth = (w: number) => {
    writeStoredPreference(WIDTH_KEY, String(w));
    setBotUi(widthBotRef.current, { railWidth: w });
  };

  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    // 拖动期只写了 DOM：到这里才把最终宽度交给 React + localStorage / 按机器人记的那份。
    const next = liveWidth.current;
    setWidth(next);
    keepWidth(next);
  };

  // Ctrl+Alt+B（⌘⌥B）收起 / 展开面板卡。只在面板栏存在的宽度（≥1280px）生效。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!matchesHotkey(event, PANEL_RAIL_HOTKEY)) return;
      if (!window.matchMedia("(min-width: 1280px)").matches) return;
      event.preventDefault();
      togglePanelRail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const wide = useWideForRail();
  const sheetOpen = usePanelSheetOpen();
  // 关掉抽屉后窗口又变宽：抽屉的状态不带过去。
  useEffect(() => {
    if (wide) setPanelSheetOpen(false);
  }, [wide]);

  /*
   * 右栏 = 「面板 | 计算机」两个标签（DESIGN.md §23）。计算机是否打开仍由聊天页的 `watch` 参数决定，
   * 这里只负责：它一打开就把右栏亮出来（宽窗口展开面板卡，窄窗口拉出抽屉）；收起右栏时顺手关掉计算机，
   * 免得地址栏说开着、屏幕上却看不见。
   */
  const chat = useCurrentBotChat();
  const computerOn = Boolean(chat?.canComputer && chat.computerOpen);
  useEffect(() => {
    if (!computerOn) return;
    // 浏览器后退回到 `watch=true` 的旧记录：那是在离开，不是要看计算机，别把抽屉重新拉出来（CB-098 QA）。
    // 只看事件先后，不看时间：最近一次是浏览器后退 / 前进（不是用户切标签）才算恢复。
    if (!wide && lastHistoryEventWasPop()) return;
    if (wide) setPanelRailOpen(true);
    else setPanelSheetOpen(true);
  }, [computerOn, wide]);
  const latestChat = useRef(chat);
  latestChat.current = chat;
  /*
   * 机器人刚建了一张面板（新 id、正在搭建）：右栏切到「面板」并亮出来，像 Hark 一样让人看着它搭起来。
   * 第一次加载时已有的卡片不算。
   */
  const railBotId = widthBot;
  const live = useLivePanels(railBotId);
  const seenPanels = useRef<{ bot?: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    const items = live.data;
    if (!items || !railBotId) return;
    const seen = seenPanels.current;
    if (!seen || seen.bot !== railBotId) {
      seenPanels.current = { bot: railBotId, ids: new Set(items.map((p) => p.id)) };
      return;
    }
    const fresh = items.filter((p) => !seen.ids.has(p.id));
    for (const p of items) seen.ids.add(p.id);
    if (!fresh.some((p) => p.status === "building")) return;
    const current = latestChat.current;
    if (current?.canComputer && current.computerOpen) current.toggleComputer();
    if (wide) setPanelRailOpen(true);
    else setPanelSheetOpen(true);
  }, [live.data, railBotId, wide]);
  const closeComputer = useCallback(() => {
    const current = latestChat.current;
    if (current?.canComputer && current.computerOpen) current.toggleComputer();
  }, []);
  const collapseWide = useCallback(() => {
    closeComputer();
    setPanelRailOpen(false);
  }, [closeComputer]);
  const closeSheet = useCallback(() => {
    closeComputer();
    setPanelSheetOpen(false);
  }, [closeComputer]);
  // 返回键 / 浏览器返回先关面板抽屉（CB-098）。
  useBackDismiss(!wide && sheetOpen, closeSheet);
  // 抽屉和常驻栏用同一张卡片、同一个内容宽度；24px 是常驻栏左右的留边。
  const cardWidth = width - CARD_INSET;
  const panelBody = (
    <PanelRailBody
      controlsId={wide ? "chisabot-panel-rail" : "chisabot-panel-sheet"}
      drawer={!wide}
      onCollapse={wide ? collapseWide : closeSheet}
      showHotkey={wide}
      width={width}
    />
  );

  if (!wide) {
    // 窄窗口（< 1280px）：没有右侧栏的位置，面板改成右边缘把手 + 滑出的抽屉，入口一直在。
    return (
      <>
        {sheetOpen ? null : (
          <ToggleTip label={"打开面板"} side="left">
            <button
              aria-controls={"chisabot-panel-sheet"}
              aria-expanded={false}
              aria-label={"打开面板"}
              className="rail-tab is-narrow"
              onClick={() => setPanelSheetOpen(true)}
              type="button"
            >
              <IconLayoutSidebarRightExpand className="size-4" />
              <span className="rail-tab-t">{"面板"}</span>
            </button>
          </ToggleTip>
        )}
        <Sheet
          onOpenChange={(next) => (next ? setPanelSheetOpen(true) : closeSheet())}
          open={sheetOpen}
        >
          <SheetContent
            className={cn(PANEL_CARD_CLASS, "rail-sheet")}
            id="chisabot-panel-sheet"
            showCloseButton={false}
            side="right"
            style={{ width: cardWidth }}
          >
            <SheetTitle className="sr-only">{computerOn ? "计算机" : "自定义面板"}</SheetTitle>
            <SheetDescription className="sr-only">{"当前机器人的自定义面板和计算机"}</SheetDescription>
            {panelBody}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <>
    <PanelRailHandle open={open} />
    <aside
      aria-hidden={open ? undefined : true}
      aria-label={"自定义面板栏"}
      className={cn(
        "glass-rail relative hidden h-full min-h-0 shrink-0 flex-col pr-4 pb-4 pl-2 xl:flex",
        dragging && "select-none is-dragging",
        !open && "is-collapsed",
        className,
      )}
      data-state={open ? "expanded" : "collapsed"}
      id="chisabot-panel-rail"
      inert={!open}
      // Collapsed = zero width and no side padding; the inner column keeps its width, so it slides
      // off the right edge (clipped by .glass-body) instead of reflowing while it narrows.
      ref={railRef}
      style={open ? { width } : { width: 0, paddingLeft: 0, paddingRight: 0 }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element. */}
      <div
        aria-label={"拖动调整面板栏宽度"}
        aria-orientation="vertical"
        aria-valuemax={MAX_WIDTH}
        aria-valuemin={MIN_WIDTH}
        aria-valuenow={width}
        className={cn("glass-rail-handle", dragging && "is-dragging")}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          keepWidth(DEFAULT_WIDTH);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const next = Math.min(
            MAX_WIDTH,
            Math.max(MIN_WIDTH, width + (event.key === "ArrowLeft" ? 20 : -20)),
          );
          setWidth(next);
          keepWidth(next);
        }}
        onPointerCancel={onPointerUp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="separator"
        tabIndex={0}
      />
      {dragging ? <div className="fixed inset-0 z-40 cursor-col-resize" /> : null}
      {/* DESIGN-v4：面板栏是一张独立的玻璃卡；标题和收起在卡片自己的头部里。 */}
      <section className={PANEL_CARD_CLASS} ref={cardRef} style={{ width: cardWidth }}>
        {panelBody}
      </section>
    </aside>
    </>
  );
}

/**
 * 面板卡收起后留在右边缘的小把手（竖排「面板」）：收起的东西在它原来的位置留下痕迹，点它展开。
 * 面板卡展开时不渲染。
 */
function PanelRailHandle({ open }: { open: boolean }) {
  if (open) return null;
  return (
    <ToggleTip keys={PANEL_RAIL_HOTKEY_LABEL} label={"展开面板"} side="left">
      <button
        aria-controls={"chisabot-panel-rail"}
        aria-expanded={false}
        aria-label={"展开面板"}
        className="rail-tab hidden xl:flex"
        onClick={() => setPanelRailOpen(true)}
        type="button"
      >
        <IconLayoutSidebarRightExpand className="size-4" />
        <span className="rail-tab-t">{"面板"}</span>
      </button>
    </ToggleTip>
  );
}

function PanelRailBody({
  onCollapse,
  controlsId,
  showHotkey,
  width,
  drawer,
}: {
  onCollapse: () => void;
  controlsId: string;
  showHotkey: boolean;
  /** 右栏实测宽度（栏宽，不是卡片内容宽）：看板据此决定能不能并排。 */
  width: number;
  /** 窄窗口抽屉：面板看板永远单列。 */
  drawer: boolean;
}) {
  const { botId } = usePanelBot();
  const chat = useCurrentBotChat();
  const canComputer = Boolean(chat?.canComputer);
  const tab: RailTab = canComputer && chat?.computerOpen ? "computer" : "panels";
  const liveList = useLivePanels(botId);

  /*
   * 右栏只放实时面板（live_panels，DESIGN.md §29/§43）。上游旧面板系统（沙箱 HTML 面板、面板库、「新建」创作会话、
   * bot_panel_instances）的卡片已从右栏去掉（DESIGN.md §57 导航收敛）；数据还在库里，合并 / 清理在后续阶段。
   * 新面板在对话里说一句就行。
   */
  return (
    <>
      <header className="rail-head">
        {canComputer && chat ? (
          <RailSwitch
            needsYou={chat.needsYou && tab !== "computer"}
            onChange={(next) => {
              if (next !== tab) chat.toggleComputer();
            }}
            tab={tab}
          />
        ) : (
          <h2 className="rail-head-t">{"面板"}</h2>
        )}
        <span className="flex-1" />
        {tab === "panels" && botId ? (
          <RailAddPanelMenu drawer={drawer} onCloseDrawer={drawer ? onCollapse : undefined} />
        ) : null}
        <span aria-hidden className="rail-head-div" />
        <ToggleTip keys={showHotkey ? PANEL_RAIL_HOTKEY_LABEL : undefined} label={drawer ? "关闭面板" : "收起右栏"} side="bottom">
          <button
            aria-controls={controlsId}
            aria-expanded={true}
            aria-label={drawer ? "关闭面板" : "收起右栏"}
            data-testid={drawer ? "panel-sheet-close" : undefined}
            className="rail-head-icon"
            onClick={onCollapse}
            type="button"
          >
            <IconLayoutSidebarRightCollapse className="size-[18px]" />
          </button>
        </ToggleTip>
      </header>

      <div
        aria-hidden={tab !== "panels" || undefined}
        className="rail-pane flex min-h-0 flex-1 flex-col gap-[10px]"
        data-active={tab === "panels"}
        hidden={tab !== "panels"}
      >
        <div className="glass-rail-scroll relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {!botId ? (
            <RailNote>{"还没有可用的机器人。"}</RailNote>
          ) : (
            <>
              <LivePanelList botId={botId} drawer={drawer} width={width} />
              {liveList.isSuccess && (liveList.data?.length ?? 0) === 0 ? (
                <div className="rail-empty flex flex-col items-center gap-2.5">
                  <p>
                    {"还没有面板。在对话里说一句，比如「帮我做一个比特币价格面板」，机器人会做好放在这里并按时刷新。"}
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
                    {panelPresetBatch(0).map((preset) => (
                      <button
                        className="rounded-full border border-border/60 bg-background/60 px-2.5 py-1 text-[11.5px] font-medium text-foreground/85 transition-colors hover:bg-muted hover:text-foreground"
                        data-testid={`rail-empty-preset-${preset.label.slice(0, 2)}`}
                        key={preset.label}
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent("chisabot-prefill", {
                              detail: preset.prompt,
                            }),
                          );
                          if (drawer) onCollapse();
                        }}
                        type="button"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {canComputer && chat ? (
        <RailComputerPane active={tab === "computer"} agentId={chat.agentId} fallbackName={chat.fallbackName} />
      ) : null}
    </>
  );
}

type RailTab = "panels" | "computer";

/** 右栏顶部的「面板 | 计算机」分段切换（sg-segmented，与设置页同一套）。 */
function RailSwitch({
  tab,
  onChange,
  needsYou,
}: {
  tab: RailTab;
  onChange: (tab: RailTab) => void;
  needsYou: boolean;
}) {
  // 键盘约定走共用的 `useSegmentedKeys`（2026-10-20）：以前这里手写了一份，方向键换了项但焦点留在原处。
  const keys = useSegmentedKeys<RailTab>({ value: tab, values: ["panels", "computer"], onChange });
  const item = (value: RailTab, label: string, icon: React.ReactNode) => (
    <button
      aria-checked={tab === value}
      className="sg-segmented-item rail-tabs-item"
      onClick={() => onChange(value)}
      role="radio"
      tabIndex={keys.itemTabIndex(value)}
      type="button"
    >
      {icon}
      {label}
      {value === "computer" && needsYou ? (
        <span aria-label={"需要你"} className="rail-tabs-dot" role="img" />
      ) : null}
    </button>
  );
  return (
    <div aria-label={"右栏内容"} className="sg-segmented rail-tabs" data-tab={tab} {...keys.groupProps} ref={keys.groupRef} role="radiogroup">
      <span aria-hidden className="rail-tabs-thumb" />
      {item("panels", "面板", <IconLayoutGrid className="size-[15px]" />)}
      {item("computer", "计算机", <IconDeviceDesktop className="size-[15px]" />)}
    </div>
  );
}

/**
 * 「计算机」标签的内容。第一次切过来才挂载，之后切回「面板」只是隐藏、不卸载：接管状态、
 * 展开的大屏、活动列表都还在；隐藏时画面不可见，截图轮询会自己停（useElementVisible）。
 * 换了机器人就换一份。
 */
function RailComputerPane({
  active,
  agentId,
  fallbackName,
}: {
  active: boolean;
  agentId: string;
  fallbackName?: string;
}) {
  const agents = useQuery(agentListQueryOptions());
  const name = agents.data?.find((a) => a.id === agentId)?.name ?? fallbackName;
  const [mountedFor, setMountedFor] = useState<string | null>(active ? agentId : null);
  useEffect(() => {
    if (active) setMountedFor(agentId);
  }, [active, agentId]);
  if (mountedFor !== agentId) return null;
  return (
    <div
      aria-hidden={!active || undefined}
      className="rail-pane glass-rail-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-active={active}
      hidden={!active}
    >
      <ComputerViewPanel agentId={agentId} name={name} variant="rail" />
    </div>
  );
}

function RailNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="glass-card p-4 text-muted-foreground text-sm">{children}</p>
  );
}

/**
 * 右栏头部的「＋」新建面板入口（CB-094，DESIGN.md §114）：
 * 已有面板以后也能随时挑一个预设填进聊天输入框（chisabot-prefill，不自动发送），点「换一批」轮换预设。
 */
function RailAddPanelMenu({
  drawer,
  onCloseDrawer,
}: {
  drawer: boolean;
  onCloseDrawer?: () => void;
}) {
  const [batch, setBatch] = useState(0);
  const presets = panelPresetBatch(batch);
  const prefill = (prompt: string) => {
    window.dispatchEvent(new CustomEvent("chisabot-prefill", { detail: prompt }));
    if (drawer && onCloseDrawer) onCloseDrawer();
  };
  return (
    <DropdownMenu>
      <ToggleTip label={"新建面板"} side="bottom">
        <DropdownMenuTrigger
          render={
            <button
              aria-label={"新建面板"}
              className="rail-head-icon"
              data-testid="rail-add-panel-btn"
              type="button"
            />
          }
        >
          <IconPlus className="size-[18px]" />
        </DropdownMenuTrigger>
      </ToggleTip>
      <DropdownMenuContent align="end" className="glass-pop w-[256px] p-1.5">
        <div className="flex items-center justify-between px-2.5 py-1 text-xs text-muted-foreground">
          <span>{"新建右侧面板（填入输入框）"}</span>
          <button
            aria-label={"换一批预设"}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-foreground/80 hover:bg-muted"
            data-testid="rail-preset-shuffle"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setBatch((n) => n + 1);
            }}
            type="button"
          >
            <IconRefresh className="size-3" />
            {"换一批"}
          </button>
        </div>
        <DropdownMenuSeparator className="glass-sep" />
        {presets.map((preset) => (
          <DropdownMenuItem
            className="glass-mi"
            data-testid={`rail-add-preset-${preset.label.slice(0, 2)}`}
            key={preset.label}
            onClick={() => prefill(preset.prompt)}
          >
            <span className="min-w-0 flex-1 truncate">{preset.label}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="glass-sep" />
        <DropdownMenuItem
          className="glass-mi text-muted-foreground"
          data-testid="rail-add-custom"
          onClick={() => prefill("请帮我创建一个右侧实时面板：")}
        >
          <span className="min-w-0 flex-1 truncate">{"✍️ 自定义面板要求…"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
