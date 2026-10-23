import { createStateStore, JSONUIProvider, Renderer, type Spec } from "@json-render/react";
import { useKeptVisible } from "@/lib/kept-visible";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconChevronRight,
  IconDatabase,
  IconDots,
  IconRefresh,
  IconTrash,
  IconWand,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lastWorkStep, WORK_STEP_EVENT, type WorkStepDetail } from "@/components/chat/work-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { parseRenderUiSpec, sanitizeRenderUiSpec } from "../../../../shared/json-render/catalog";
import { pruneEmptySections } from "../../../../shared/json-render/empty-sections";
import { dropDuplicateTitle } from "../../../../shared/json-render/panel-title";
import { client } from "@/lib/client";
import { isChatRunning } from "@/lib/copilot/computer-activity";
import { modelCatalogQueryOptions } from "@/lib/model-selection/queries";
import {
  everyText,
  liveFailures,
  liveKindText,
  type LiveSource,
  type LiveSourceReadings,
  useLiveValues,
} from "@/lib/panels/live-values";
import { buildStepText, groupSources, panelEditPrompt } from "./panel-meta";
import { PanelBoard } from "./panel-board";
import { jsonRenderRegistry } from "@/lib/copilot/json-render/registry";
import { copyText, openInNewTab, RichUiProvider, useNow } from "@/lib/copilot/json-render/rich-context";

/** 面板里的「问一句」发到当前机器人的对话（bot.tsx 监听）。 */
function askBot(text: string) {
  const said = text.trim();
  if (said) window.dispatchEvent(new CustomEvent("chisabot-ask", { detail: said }));
}

/**
 * ⋯ →「让 AI 修改…」：把这句话塞进输入框当草稿（`component/channels/composer/composer.tsx` 监听
 * `chisabot-prefill`），**不发送**——用户自己补完要改什么再按发送。
 */
function prefillPanelEdit(title: string) {
  window.dispatchEvent(new CustomEvent("chisabot-prefill", { detail: panelEditPrompt(title) }));
}

/**
 * 实时面板（server/src/live-panels，2026-10-13）：机器人用一句话的请求做出来、自己按计划刷新的卡片。
 *
 * 卡片只画结果：标题、内容（json-render，与对话里的 render_ui 同一套组件）、数据来源、更新时间。
 * 搭建中是骨架 + 机器人这一刻在做的那一步（§77.1）；刷新中底部「正在刷新…」；失败把原因用大白话写在卡片上。
 * ⋯ 菜单：立即刷新、刷新频率、撤销修改、删除（10 秒内可撤销）。没有 JSON、没有规范。
 */
export type LivePanel = {
  id: string;
  botId: string;
  title: string;
  status: "building" | "ready" | "failed";
  spec: string | null;
  sources: { name: string; url: string }[];
  instruction: string;
  refreshMinutes: number | null;
  /** 每天固定时刻刷新（「08:00」）；null = 按间隔。 */
  refreshAt?: string | null;
  refreshTimeZone?: string | null;
  /** 面板后台刷新使用的独立模型（CB-088）；null = 跟随机器人主模型。 */
  refreshModel?: string | null;
  /** 直连数据源（秒级，不靠机器人回合）：卡片可见时浏览器自己轮询。 */
  dataSources: LiveSource[];
  error: string | null;
  refreshedAt: string | null;
  nextRefreshAt: string | null;
  refreshing: boolean;
  canUndoEdit: boolean;
  createdAt: string;
};

export const livePanelKeys = { list: (botId: string) => ["live-panels", botId] as const };

/**
 * 聊天正在跑一轮（turn-compaction.ts 广播 chisabot-chat-running）。跑的时候 2.5 秒看一次面板：
 * 机器人 panel_create 之后卡片要马上出现在右栏，而不是等下一个 30 秒。
 */
function useChatRunning() {
  // 卡片可能在这一轮开始之后才挂上（新建的面板）：先读当前状态，不等下一次广播。
  const [running, setRunning] = useState(() => isChatRunning());
  useEffect(() => {
    const on = (event: Event) => setRunning(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("chisabot-chat-running", on);
    return () => window.removeEventListener("chisabot-chat-running", on);
  }, []);
  return running;
}

export function useLivePanels(botId: string | undefined) {
  const running = useChatRunning();
  // 右栏藏着（设置 / 管理 / Claude Code，DESIGN.md §98.3）时不轮询；回来时窗口聚焦 / 下一拍照常。
  const onScreen = useKeptVisible();
  const queryClient = useQueryClient();
  // 一轮刚结束：再看一次（面板可能在最后一步才填好）。
  useEffect(() => {
    if (!running && botId) void queryClient.invalidateQueries({ queryKey: livePanelKeys.list(botId) });
  }, [running, botId, queryClient]);
  return useQuery({
    enabled: Boolean(botId),
    queryKey: livePanelKeys.list(botId ?? ""),
    queryFn: () => client<LivePanel[]>(`/api/live-panels?botId=${encodeURIComponent(botId ?? "")}`, "items", { fallback: "面板无法加载" }),
    // 有卡片在搭建 / 刷新时 3 秒看一次，平时 30 秒（机器人在对话里建的卡片要马上出现）。
    refetchInterval: (query) => {
      if (!onScreen) return false;
      const items = query.state.data;
      if (running) return 2500;
      return items?.some((p) => p.status === "building" || p.refreshing) ? 3000 : 30_000;
    },
    refetchOnWindowFocus: true,
  });
}

function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "刚刚更新";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前更新`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前更新`;
  return `${new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} 更新`;
}
function cadence(minutes: number | null, at?: string | null, zone?: string | null): string {
  // 固定时刻：北京时间以外的时区才写出来。
  if (at) return `每天 ${at} 刷新${zone && zone !== "Asia/Shanghai" ? `（${zone}）` : ""}`;
  if (!minutes) return "不自动刷新";
  if (minutes % 1440 === 0) return minutes === 1440 ? "每天刷新" : `每 ${minutes / 1440} 天刷新`;
  if (minutes % 60 === 0) return minutes === 60 ? "每小时刷新" : `每 ${minutes / 60} 小时刷新`;
  return `每 ${minutes} 分钟刷新`;
}

const LiveBody = memo(function LiveBody({
  spec: source,
  title,
  live,
  onRefresh,
}: {
  spec: string;
  title: string;
  /** 直连数据源的最新值：`{ [sourceId]: value }`，规范里绑 `/live/<id>` 的地方读它。 */
  live: Record<string, unknown>;
  onRefresh?: () => void;
}) {
  // 空列表 / 空重复区块不画，免得只剩一个孤零零的小标题（shared/json-render/empty-sections.ts）；
  // 和卡片头同名的标题也不再画第二遍（shared/json-render/panel-title.ts）。
  const spec = useMemo(
    () => dropDuplicateTitle(pruneEmptySections(sanitizeRenderUiSpec(parseRenderUiSpec(source, false))?.spec ?? null), title),
    [source, title],
  );
  /*
   * 刷新只换数据（DESIGN.md §32）：新规范到了也不重新挂载——元素 key 没变，React 复用同一批组件，
   * 数字从旧值滚到新值并闪一下（rich-context useLiveValue）。state 仓库按规范版本换新，表格 / 列表直接用字面值。
   *
   * 直连数据源：服务端会把最近一次的好值塞进 `spec.state.live`（手机 / 第一帧也有数字），这里用
   * 轮询拿到的更快的值按来源覆盖同名项；之后用 store.update 写 `/live/<id>`：仓库不重建、组件不重挂。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: one store per spec version.
  const store = useMemo(() => {
    const baked = ((spec as Spec | null)?.state?.live ?? {}) as Record<string, unknown>;
    return createStateStore({ ...((spec as Spec | null)?.state ?? {}), live: { ...baked, ...live } });
  }, [source]);
  /*
   * 读数变化只写变化的路径。先比一次当前值：同一个值重复 update 会让订阅它的组件白闪一下；
   * 规范换新时新仓库第一帧就带着 live，这里也不会重复写。
   */
  useEffect(() => {
    const updates: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(live)) {
      const path = `/live/${id}`;
      if (store.get(path) !== value) updates[path] = value;
    }
    if (Object.keys(updates).length > 0) store.update(updates);
  }, [live, store]);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const handlers = useMemo(
    () => ({
      open_link: (params: Record<string, unknown>) => {
        const url = typeof params.url === "string" ? params.url : "";
        if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
      },
      send_message: (params: Record<string, unknown>) => {
        if (typeof params.text === "string") askBot(params.text);
      },
      copy_text: (params: Record<string, unknown>) => {
        if (typeof params.text === "string" && params.text) void copyText(params.text);
      },
      refresh_panel: () => refreshRef.current?.(),
    }),
    [],
  );
  const rich = useMemo(
    () => ({ surface: "panel" as const, ask: askBot, openLink: openInNewTab, copy: copyText, refresh: () => refreshRef.current?.() }),
    [],
  );
  if (!spec?.root || !spec.elements?.[spec.root]) return <p className="live-panel-note">{"内容无法显示，下次刷新会重画。"}</p>;
  return (
    <div className="jr-surface live-panel-body">
      <RichUiProvider value={rich}>
        <JSONUIProvider handlers={handlers} registry={jsonRenderRegistry} store={store}>
          <Renderer registry={jsonRenderRegistry} spec={spec as Spec} />
        </JSONUIProvider>
      </RichUiProvider>
    </div>
  );
});

/** 聊天里干活卡正在做的那一步（§77.1）。 */
function useWorkStep(): WorkStepDetail {
  const [step, setStep] = useState<WorkStepDetail>(() => lastWorkStep());
  useEffect(() => {
    const on = (event: Event) => setStep((event as CustomEvent<WorkStepDetail>).detail ?? null);
    window.addEventListener(WORK_STEP_EVENT, on);
    return () => window.removeEventListener(WORK_STEP_EVENT, on);
  }, []);
  return step;
}

/**
 * 搭建中的卡片（§77.1）：骨架 + 一行「正在搜索「东京天气」」——机器人这一刻在做的事，跟着聊天里的干活卡换，
 * 180ms 淡入淡出（只有一行字在换，高度不变）。聊天没在跑（刷新页面、别的设备在建）时写「正在搭建…」。
 */
function BuildingSkeleton() {
  const running = useChatRunning();
  const step = useWorkStep();
  const reduce = useReducedMotion();
  // 这一轮刚结束、卡片还没换成内容的那一下：留着最后一步，不闪回「正在搭建…」。
  const lastText = useRef<string | null>(null);
  if (running) lastText.current = buildStepText(step);
  const text = running ? buildStepText(step) : (lastText.current ?? "正在搭建…");
  return (
    <div className="live-panel-skeleton" data-testid="live-panel-building">
      <span className="jr-skel-title" />
      <span className="jr-skel-line" />
      <span className="jr-skel-line is-short" />
      <span className="live-panel-step" role="status">
        <span aria-hidden="true" className="chat-thinking-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="live-panel-step-slot">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              animate={{ opacity: 1, y: 0 }}
              className="live-panel-step-text"
              // 换字：旧的往上淡出、新的从下面淡入（§78.3），两行不在同一处叠着，读起来不像两段字。
              exit={{ opacity: 0, y: reduce ? 0 : -8 }}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              key={text}
              transition={{ duration: reduce ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }}
            >
              {text}
            </motion.span>
          </AnimatePresence>
        </span>
      </span>
    </div>
  );
}

/** 底部一行里的频率去掉「刷新」两个字（「每小时」）；「不自动刷新」照写。 */
function shortCadence(text: string): string {
  return text === "不自动刷新" ? text : text.replace(/\s*刷新(?=（|$)/u, "");
}

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 数据来源弹层里「最近一次结果」的时间说法：10 秒内「刚刚」，一分钟内「N 秒前」，再久写时刻。 */
function readingAgo(iso: string, now = Date.now()): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${Math.floor(seconds)} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return clock(iso);
}

const NO_LIVE_SOURCES: LiveSource[] = [];

/**
 * 卡片底部一行（§77.2）：左边来源（按网站合并，写第一个，其余「+N」，点开看全部），右边更新时间 + 频率（「每小时」），
 * 刷新中换成小圈 +「正在刷新…」。不换行；窄卡里来源先省略。
 *
 * 直连数据源（2026-10-22）也写在这一行：「名字 · 每 5 秒」，和网页来源一起按第一个 +「+N」收起；
 * 时间位优先写最近一次取数的时刻（`liveAt`），没有直连来源时仍是机器人刷新的「更新于… · 每小时」。
 */
function PanelFoot({ panel, busy, liveAt }: { panel: LivePanel; busy: boolean; liveAt: string | null }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupSources(panel.sources), [panel.sources]);
  const direct = panel.dataSources ?? NO_LIVE_SOURCES;
  const items = useMemo(() => {
    const rows: { key: string; label: string; url?: string; hint?: string }[] = direct.map((source) => ({
      key: `live-${source.id}`,
      label: `${source.name} · ${everyText(source.intervalSec)}`,
      hint: source.label,
    }));
    for (const group of groups) {
      rows.push({
        key: `src-${group.label}-${group.url}`,
        label: group.label,
        ...(group.url ? { url: group.url } : {}),
        hint: group.names.join("\n"),
      });
    }
    return rows;
  }, [direct, groups]);
  // 窄卡（300px 左右）一行只放得下一个来源名 + 时间：第一个写出来，其余「+N」。
  const shown = open ? items : items.slice(0, 1);
  const more = items.length - shown.length;
  const next = clock(panel.nextRefreshAt);
  const shortest = direct.length ? Math.min(...direct.map((source) => source.intervalSec)) : null;
  const cadenceText =
    shortest !== null ? everyText(shortest) : shortCadence(cadence(panel.refreshMinutes, panel.refreshAt, panel.refreshTimeZone));
  const stampAt = liveAt ?? panel.refreshedAt;
  const stampTitle = [
    liveAt ? `最近取数 ${new Date(liveAt).toLocaleString("zh-CN", { hour12: false })}` : "",
    stampAt && stampAt !== liveAt ? `更新于 ${new Date(stampAt).toLocaleString("zh-CN", { hour12: false })}` : "",
    next && !busy ? `下次刷新 ${next}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <footer className="live-panel-foot" data-open={open || undefined}>
      {items.length ? (
        <span className="live-panel-sources" data-testid="live-panel-sources">
          <span className="live-panel-sources-k">{"来源"}</span>
          {shown.map((item) =>
            item.url ? (
              <a
                className="live-panel-src"
                href={item.url}
                key={item.key}
                rel="noopener noreferrer"
                target="_blank"
                title={item.hint}
              >
                {item.label}
              </a>
            ) : (
              // 没有网址的来源（本机命令、直连数据源）：只写名字，不做成点不开的链接。
              <span className="live-panel-src is-plain" key={item.key} title={item.hint}>
                {item.label}
              </span>
            ),
          )}
          {more > 0 ? (
            <button aria-label={`还有 ${more} 个来源`} className="live-panel-src-more" onClick={() => setOpen(true)} type="button">
              {`+${more}`}
            </button>
          ) : open && items.length > 1 ? (
            <button className="live-panel-src-more" onClick={() => setOpen(false)} type="button">
              {"收起"}
            </button>
          ) : null}
        </span>
      ) : (
        <span />
      )}
      <span className="live-panel-time" data-state={busy ? "refreshing" : undefined} title={stampTitle || undefined}>
        {busy ? (
          <>
            <IconRefresh aria-hidden className="live-panel-spin size-3" />
            {"正在刷新…"}
          </>
        ) : (
          <>
            <UpdatedAgo at={stampAt} />
            {`${stampAt ? " · " : ""}${cadenceText}`}
          </>
        )}
      </span>
    </footer>
  );
}

/** 「3 分钟前更新」会自己走（一分钟内每 15 秒，之后每分钟）。 */
function UpdatedAgo({ at }: { at: string | null }) {
  const now = useNow(at && Date.now() - new Date(at).getTime() < 90_000 ? 15 : 60);
  return <>{ago(at, now)}</>;
}

/**
 * ⋯ →「数据来源…」的小弹层（docs/live-panel-sources.md 第 3 节）：每个直连来源的名字、种类
 * （网址 / 本机命令）、间隔、最近一次取数结果（成功「刚刚 · 12 ms」，失败写原因并标红），底部
 * 「立即取数」强制重取一次。点外面 / Esc 关闭。
 */
function DataSourcePanel({
  panel,
  readings,
  error,
  refreshing,
  onRefresh,
  onClose,
}: {
  panel: LivePanel;
  readings: LiveSourceReadings;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointer = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && box.current && !box.current.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const sources = panel.dataSources ?? NO_LIVE_SOURCES;
  return (
    <div
      aria-label={`「${panel.title}」的数据来源`}
      className="live-panel-src-pop"
      ref={box}
      role="dialog"
    >
      <div className="live-panel-src-pop-head">
        <span className="live-panel-src-pop-title">{"数据来源"}</span>
        <button aria-label={"关闭"} className="live-panel-src-pop-x" onClick={onClose} type="button">
          <IconX aria-hidden className="size-3.5" />
        </button>
      </div>
      {sources.length === 0 ? (
        <p className="live-panel-src-empty">{"这张面板没有直连数据源，内容按机器人的刷新频率更新。"}</p>
      ) : (
        <ul className="live-panel-src-list">
          {sources.map((source) => {
            const reading = readings[source.id];
            const failed = Boolean(reading && !reading.ok);
            return (
              <li className="live-panel-src-row" data-failed={failed || undefined} key={source.id}>
                <div className="live-panel-src-row-h">
                  <span className="live-panel-src-name">{source.name}</span>
                  <span className="live-panel-src-kind">{liveKindText(source.kind)}</span>
                  <span className="live-panel-src-every">{everyText(source.intervalSec)}</span>
                </div>
                <div className="live-panel-src-label" title={source.label}>
                  {source.label}
                </div>
                <div className="live-panel-src-state">
                  {reading ? (
                    reading.ok ? (
                      <span className="live-panel-src-ok">{`${readingAgo(reading.at)} · ${reading.ms} ms`}</span>
                    ) : (
                      // 失败原因服务器已经写成中文并抹掉密钥；这里原样说清楚。
                      <span className="live-panel-src-bad">{reading.error ?? "取数失败。"}</span>
                    )
                  ) : (
                    <span className="live-panel-src-wait">{"还没有取数。"}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error ? <p className="live-panel-src-bad live-panel-src-bad-block">{error}</p> : null}
      <div className="live-panel-src-pop-foot">
        <button
          className="live-panel-src-refresh"
          disabled={refreshing || sources.length === 0}
          onClick={onRefresh}
          type="button"
        >
          <IconRefresh aria-hidden className={refreshing ? "live-panel-spin size-3" : "size-3"} />
          {refreshing ? "正在取数…" : "立即取数"}
        </button>
      </div>
    </div>
  );
}

function LivePanelCard({
  panel,
  onRemove,
  collapsed,
  onToggleCollapse,
  grip,
}: {
  panel: LivePanel;
  onRemove: (p: LivePanel) => void;
  /** 折叠只留标题行：不渲染内容、不取数（看板把状态存在 panelLayout 里）。 */
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 标题左边的拖动握把（PanelBoard 给的）。 */
  grip: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const closeSources = useCallback(() => setSourcesOpen(false), []);
  const dataSources = panel.dataSources ?? NO_LIVE_SOURCES;
  // 折叠就收起「数据来源…」小弹层：只留标题行。
  useEffect(() => {
    if (collapsed) setSourcesOpen(false);
  }, [collapsed]);
  // 直连数据源：卡片可见且没折叠时轮询；折叠时 active=false，一次请求都不发。
  const live = useLiveValues(panel, !collapsed);
  const key = livePanelKeys.list(panel.botId);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });
  // 乐观更新（DESIGN.md §34.6）：先改界面，请求失败再退回并说明原因。
  const patchLocal = (patch: Partial<LivePanel>) =>
    queryClient.setQueryData<LivePanel[]>(key, (old) => old?.map((p) => (p.id === panel.id ? { ...p, ...patch } : p)));
  const refresh = useMutation({
    mutationFn: () => client(`/api/live-panels/${panel.id}/refresh`, { method: "POST", fallback: "刷新失败" }),
    onMutate: () => {
      setProblem(null);
      patchLocal({ refreshing: true });
    },
    onSettled: invalidate,
    onError: (e) => setProblem(e instanceof Error ? e.message : "刷新失败"),
  });
  const undoEdit = useMutation({
    mutationFn: () => client(`/api/live-panels/${panel.id}/undo-edit`, { method: "POST", fallback: "撤销失败" }),
    onSuccess: invalidate,
    onError: (e) => setProblem(e instanceof Error ? e.message : "撤销失败"),
  });
  const setCadence = useMutation({
    mutationFn: (minutes: number | null) => client(`/api/live-panels/${panel.id}`, { method: "PATCH", body: { refreshMinutes: minutes }, fallback: "修改失败" }),
    onMutate: (minutes) => {
      const before = panel.refreshMinutes;
      patchLocal({ refreshMinutes: minutes });
      return { before };
    },
    onError: (e, _m, ctx) => {
      if (ctx) patchLocal({ refreshMinutes: ctx.before });
      setProblem(e instanceof Error ? e.message : "修改失败");
    },
    onSettled: invalidate,
  });
  const catalog = useQuery(modelCatalogQueryOptions());
  const modelChoices = useMemo(() => {
    const all = catalog.data?.models ?? [];
    const fast = all.filter((m) => /flash|haiku|mini|lite|nano|fast|small/i.test(`${m.id} ${m.label}`));
    const rest = all.filter((m) => !fast.includes(m));
    const picked = [...fast, ...rest].slice(0, 6);
    if (panel.refreshModel && !picked.some((m) => m.id === panel.refreshModel)) {
      const found = all.find((m) => m.id === panel.refreshModel);
      picked.unshift(found ?? { id: panel.refreshModel, label: panel.refreshModel, provider: "" });
    }
    return picked;
  }, [catalog.data, panel.refreshModel]);
  const setPanelModel = useMutation({
    mutationFn: (model: string | null) =>
      client(`/api/live-panels/${panel.id}`, {
        method: "PATCH",
        body: { refreshModel: model },
        fallback: "修改刷新模型失败",
      }),
    onMutate: (model) => {
      const before = panel.refreshModel ?? null;
      patchLocal({ refreshModel: model });
      return { before };
    },
    onError: (e, _m, ctx) => {
      if (ctx) patchLocal({ refreshModel: ctx.before });
      setProblem(e instanceof Error ? e.message : "修改刷新模型失败");
    },
    onSettled: invalidate,
  });
  const icon = "size-[18px] shrink-0";

  const busy = panel.refreshing || refresh.isPending;
  const building = panel.status === "building" || (!panel.spec && busy);
  /*
   * 有内容但最近一次刷新 / 取数失败：内容照常显示，标成「可能已过期」（DESIGN.md §32）。
   * 直连来源的错误由「数据来源…」说清原因；单个源失败也把这张卡标成可能过期。
   */
  const liveError = liveFailures(live.readings)[0]?.error ?? live.error ?? null;
  const staleReason = panel.error ?? liveError;
  const stale = Boolean(staleReason && panel.spec && !building);

  return (
    <article
      aria-busy={building || busy || undefined}
      className="glass-card live-panel"
      data-collapsed={collapsed || undefined}
      data-has-live={dataSources.length > 0 || undefined}
      data-live-panel={panel.id}
      data-refreshing={(busy && !building) || undefined}
      data-stale={stale || undefined}
      data-status={panel.status}
    >
      <header className="live-panel-head">
        {grip}
        <h3 className="live-panel-heading">
          <button
            aria-expanded={!collapsed}
            className="live-panel-collapse"
            onClick={onToggleCollapse}
            title={collapsed ? "展开面板" : "折叠面板"}
            type="button"
          >
            <IconChevronRight aria-hidden className="live-panel-caret size-3.5" />
            <span className="live-panel-title">{panel.title}</span>
          </button>
        </h3>
        {stale && !busy ? (
          <span className="live-panel-stale" title={staleReason ?? undefined}>
            <IconAlertTriangle aria-hidden className="size-3" />
            {"可能已过期"}
          </span>
        ) : null}
            {panel.refreshModel ? (
              <span
                className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary/90 truncate max-w-[96px]"
                data-testid="panel-model-badge"
                title={`后台刷新模型：${panel.refreshModel}`}
              >
                {`⚡ ${panel.refreshModel.split("/").pop()}`}
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<button aria-label={`「${panel.title}」的更多操作`} className="rail-head-icon live-panel-more ml-auto" type="button" />}
              >
                <IconDots className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-pop sg-menu w-[224px]" side="bottom" sideOffset={6}>
                <DropdownMenuItem className="glass-mi" disabled={busy} onClick={() => refresh.mutate()}>
                  <IconRefresh className={icon} />
                  <span className="min-w-0 flex-1">{busy ? "正在刷新…" : "立即刷新"}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator className="glass-sep" />
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="glass-mi-label">{"自动刷新"}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    onValueChange={(v) => {
                      if (v !== "at") setCadence.mutate(v === "off" ? null : Number(v));
                    }}
                    value={panel.refreshAt ? "at" : panel.refreshMinutes == null ? "off" : String(panel.refreshMinutes)}
                  >
                    {(
                      [
                        // 机器人按用户说的「每天几点」设的固定时刻；选别的频率就取消它。
                        ...(panel.refreshAt ? ([["at", `每天 ${panel.refreshAt}`]] as const) : []),
                        ["60", "每小时"],
                        ["360", "每 6 小时"],
                        ["1440", "每天"],
                        ["off", "不自动刷新"],
                      ] as const
                    ).map(([value, label]) => (
                      <DropdownMenuRadioItem className="glass-mi" closeOnClick key={value} value={value}>
                        {label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="glass-sep" />
                <DropdownMenuGroup data-testid="panel-model-group">
                  <DropdownMenuLabel className="glass-mi-label">{"刷新模型（省配额）"}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    onValueChange={(v) => {
                      setPanelModel.mutate(v === "__default__" ? null : v);
                    }}
                    value={panel.refreshModel || "__default__"}
                  >
                    <DropdownMenuRadioItem className="glass-mi" closeOnClick value="__default__">
                      {"跟随机器人主模型"}
                    </DropdownMenuRadioItem>
                    {modelChoices.map((m) => (
                      <DropdownMenuRadioItem className="glass-mi" closeOnClick key={m.id} value={m.id}>
                        <span className="truncate">{m.label || m.id}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
            <DropdownMenuSeparator className="glass-sep" />
            <DropdownMenuItem className="glass-mi" onClick={() => prefillPanelEdit(panel.title)}>
              <IconWand className={icon} />
              <span className="min-w-0 flex-1">{"让 AI 修改…"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="glass-mi"
              disabled={dataSources.length === 0}
              onClick={() => setSourcesOpen(true)}
            >
              <IconDatabase className={icon} />
              <span className="min-w-0 flex-1">{"数据来源…"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="glass-sep" />
            {panel.canUndoEdit ? (
              <DropdownMenuItem className="glass-mi" onClick={() => undoEdit.mutate()}>
                <IconArrowBackUp className={icon} />
                <span className="min-w-0 flex-1">{"撤销上次修改"}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem className="glass-mi is-danger" onClick={() => onRemove(panel)} variant="destructive">
              <IconTrash className={icon} />
              <span className="min-w-0 flex-1">{"删除面板"}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {sourcesOpen ? (
        <DataSourcePanel
          error={live.error}
          onClose={closeSources}
          onRefresh={live.refresh}
          panel={panel}
          readings={live.readings}
          refreshing={live.refreshing}
        />
      ) : null}

      {collapsed ? null : (
        <>
          {building ? (
            <BuildingSkeleton />
          ) : panel.spec ? (
            <LiveBody live={live.values} onRefresh={() => refresh.mutate()} spec={panel.spec} title={panel.title} />
          ) : null}

          {panel.error && !building ? (
            <p className="live-panel-error" role="alert">
              <IconAlertTriangle className="size-3.5 shrink-0" />
              <span>{panel.error}</span>
            </p>
          ) : null}
          {problem ? <p className="live-panel-error" role="alert">{problem}</p> : null}

          {!building ? <PanelFoot busy={busy} liveAt={live.at} panel={panel} /> : null}
        </>
      )}
    </article>
  );
}

/**
 * 右栏面板标签里的实时面板列表。删除是乐观的（DESIGN.md §34.6）：点「删除面板」卡片立刻淡出、
 * 下面的卡片补位，同时底部弹出带「撤销」的提示；请求失败就把卡片放回去并提示原因。
 *
 * 卡片怎么摆（并排 / 单独一行、分隔条比例、拖高、折叠）由 `PanelBoard` 按机器人的 `panelLayout` 决定；
 * `width` 是右栏实测内容宽度，`drawer` 是窄窗口抽屉（永远单列）。
 */
export function LivePanelList({
  botId,
  width = 0,
  drawer = false,
}: {
  botId: string;
  width?: number;
  drawer?: boolean;
}) {
  const list = useLivePanels(botId);
  const queryClient = useQueryClient();
  const key = livePanelKeys.list(botId);
  // 撤销可能在删除请求回来之前就点了：先等删除落地，再恢复，服务端顺序不会反。
  const deleting = useRef(new Map<string, Promise<unknown>>());
  const restore = useMutation({
    mutationFn: async ({ panel }: { panel: LivePanel; index: number }) => {
      await deleting.current.get(panel.id);
      return client(`/api/live-panels/${panel.id}/restore`, { method: "POST", fallback: "撤销失败" });
    },
    onMutate: async ({ panel, index }) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<LivePanel[]>(key, (old = []) =>
        old.some((o) => o.id === panel.id) ? old : [...old.slice(0, index), panel, ...old.slice(index)],
      );
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "撤销失败"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (p: LivePanel) => {
      const request = client(`/api/live-panels/${p.id}`, { method: "DELETE", fallback: "删除失败" });
      deleting.current.set(p.id, request.catch(() => undefined));
      return request;
    },
    onMutate: async (p) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<LivePanel[]>(key);
      const index = Math.max(0, before?.findIndex((o) => o.id === p.id) ?? 0);
      queryClient.setQueryData<LivePanel[]>(key, (old) => old?.filter((o) => o.id !== p.id));
      toast.undo(`已删除「${p.title}」`, () => restore.mutate({ panel: p, index }));
      return { before };
    },
    onError: (e, p, ctx) => {
      if (ctx?.before) queryClient.setQueryData(key, ctx.before);
      toast.error(e instanceof Error ? e.message : `「${p.title}」删除失败`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return (
    <PanelBoard
      botId={botId}
      drawer={drawer}
      key={botId}
      panels={list.data ?? []}
      width={width}
      renderCard={(panel, chrome) => (
        <LivePanelCard
          collapsed={chrome.collapsed}
          grip={chrome.grip}
          onRemove={(p) => remove.mutate(p)}
          onToggleCollapse={chrome.toggleCollapsed}
          panel={panel}
        />
      )}
    />
  );
}
