import {
  IconAlertTriangle,
  IconChevronDown,
  IconExternalLink,
  IconMaximize,
  IconWorld,
} from "@tabler/icons-react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { BotAvatar } from "@/components/agents/bot-avatar";
import { ActivityJumpButton } from "@/components/computer/activity-jump-button";
import { keepShot, shotFor } from "@/components/computer/screenshot-card";
import { Lightbox } from "@/components/rich-previews/lightbox";
import { SmoothCollapse } from "@/components/ui/motion-primitives";
import { useExternalConnection } from "@/hooks";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { readPageFrame, readScreenshot } from "@/lib/computers/screen";
import { useRetainedValue } from "@/lib/motion";
import {
  openPanelSheet,
  PANEL_RAIL_WIDE_QUERY,
  setPanelRailOpen,
} from "@/lib/panels/rail-open";
import { isSimpleModeEnabled } from "@/lib/simple-mode";
import { cn } from "@/lib/utils";
import { monogramOf } from "../../../../shared/bot-avatars";
import type {
  BrowserLiveCardPayload,
  BrowserLiveCardSource,
} from "../../../../shared/browser-companion";

export type { BrowserLiveCardPayload, BrowserLiveCardSource };

export type BrowserLiveStepItem = {
  id: string;
  toolName: string;
  toolCallId: string;
  label: string;
  href?: string;
  title?: string;
  failed: boolean;
  reason?: string;
  pending: boolean;
};

export type BrowserOpenTabTarget = {
  source: BrowserLiveCardSource;
  tabId?: number;
  url?: string;
  title?: string;
};

export type BrowserLiveCardProps = Omit<
  BrowserLiveCardPayload,
  "botId" | "botName" | "phaseBadge" | "tabTitle" | "tabUrl"
> &
  Partial<
    Pick<
      BrowserLiveCardPayload,
      "botId" | "botName" | "phaseBadge" | "tabTitle" | "tabUrl"
    >
  > & {
    /** chat-shots 持久化标识（用于复用本地缓存与服务端 /api/chat-shots/:id 回看）。 */
    shotId?: string;
    /** 可折叠展开的详细步骤列表。 */
    steps?: readonly BrowserLiveStepItem[];
    /** 出错步骤数量（> 0 时展示轻告警标签）。 */
    issues?: number;
    /** 外部覆盖「打开标签页」行为（如扩展侧栏直接聚焦真实 Chrome 标签页）。 */
    onOpenTab?: (target: BrowserOpenTabTarget) => void | Promise<void>;
    /** 高危待审批 / 确认卡挂接槽（位于卡片主体下方、永不被折叠隐藏）。 */
    approvalSlot?: ReactNode;
    /** 是否允许在缺少 shotUrl 时主动向服务端拉取云端页面帧（单测默认自动仅在存在 QueryClient 时启用）。 */
    enableCloudFrameFetch?: boolean;
    className?: string;
  };

const CLOUD_POLL_MS = 2500;
const MAX_CLOUD_POLL_TICKS = 48;

/** 仅放行 http / https 网址，彻底拒绝 javascript: / data: / file: 等危险协议。 */
export function safeBrowserHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.href;
    }
  } catch {
    // 忽略半截流式 URL 或非法地址
  }
  return undefined;
}

/** 仅允许同源相对路径、http(s) 或 data:image/(jpeg|png|webp) 缩略图地址。 */
function safeImageSrc(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/")) return trimmed;
  if (/^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
    return trimmed;
  }
  return safeBrowserHref(trimmed);
}

export function hostLabelOf(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === "workspace.local") {
      return `工作区 · ${decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "页面"}`;
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 仅在存在 QueryClient 时从机器人列表缓存读取机器人名，不破坏无 Provider 的独立测试。 */
function ResolvedBotBadgeAvatar({
  botId,
  botName,
  botAvatarUrl,
  running,
}: {
  botId?: string;
  botName?: string;
  botAvatarUrl?: string | null;
  running: boolean;
}) {
  const queryClient = useContext(QueryClientContext);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const safeAvatar = !avatarFailed ? safeImageSrc(botAvatarUrl) : undefined;
  if (safeAvatar) {
    return (
      <span aria-hidden="true" className="browser-live-badge-ava">
        <img
          alt=""
          className="size-full object-cover"
          decoding="async"
          onError={() => setAvatarFailed(true)}
          src={safeAvatar}
        />
      </span>
    );
  }
  if (queryClient && botId) {
    return (
      <BotAvatar
        agentId={botId}
        decorative
        name={botName}
        size={22}
        working={running}
      />
    );
  }
  const initial = monogramOf(botName || "助手");
  return (
    <span aria-hidden="true" className="browser-live-badge-ava">
      {initial}
    </span>
  );
}

/** 有 QueryClient 时从机器人缓存解析真实 Bot 名。 */
function BotNameFromRoster({
  botId,
  fallback,
}: {
  botId: string;
  fallback: string;
}) {
  const roster = useQuery({
    ...agentListQueryOptions(),
    enabled: Boolean(botId),
  });
  const matched = roster.data?.find((agent) => agent.id === botId)?.name;
  return <>{matched || fallback}</>;
}

/**
 * 全端共用「浏览器实时预览大卡 + 角色头像动作徽章」。
 *
 * 视觉层级严格遵循纯 CSS 5 层单通道令牌与 `[data-surface]`（卡片主体 `bubble` 轻模糊、
 * 悬浮角色徽章 `control` 零模糊、缩略图预览区与步骤列表 `inset` 零模糊），自动适配
 * 六套主题（sky / aurora / porcelain / deepseek / claude / cossui）与深浅色及三档材质。
 */
function BrowserLiveCardImpl({
  runKey,
  source,
  botId,
  botName,
  botAvatarUrl,
  phaseBadge,
  stepLabel,
  tabTitle,
  tabUrl,
  tabId,
  shotUrl,
  running,
  state,
  shotId,
  steps,
  issues = 0,
  onOpenTab,
  approvalSlot,
  enableCloudFrameFetch,
  className,
}: BrowserLiveCardProps) {
  const queryClient = useContext(QueryClientContext);
  const router = useRouter({ warn: false });
  const [stepsOpen, setStepsOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [failedSrcs, setFailedSrcs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [cloudFrameSrc, setCloudFrameSrc] = useState<string | null>(null);
  const lastRunKeyRef = useRef<string>(runKey);
  const lastGoodSrcRef = useRef<string | null>(null);
  if (lastRunKeyRef.current !== runKey) {
    lastRunKeyRef.current = runKey;
    lastGoodSrcRef.current = null;
  }

  const safeUrl = safeBrowserHref(tabUrl);
  const host = hostLabelOf(safeUrl ?? tabUrl);
  const displayPageTitle = tabTitle?.trim() || host || "";

  // 帧来源优先级：显式 shotUrl > chat-shots 本地缓存 > 运行期拉取的云端帧 > chat-shots 服务端持久地址
  const explicitSrc = safeImageSrc(shotUrl);
  const localShot = shotId ? shotFor(shotId) : undefined;
  const serverShotSrc =
    shotId && !explicitSrc && !localShot
      ? `/api/chat-shots/${encodeURIComponent(shotId)}`
      : undefined;

  const candidateSrc = useMemo(() => {
    const candidates = [
      explicitSrc,
      safeImageSrc(localShot?.src),
      cloudFrameSrc ?? undefined,
      serverShotSrc,
    ];
    for (const candidate of candidates) {
      if (candidate && !failedSrcs.has(candidate)) return candidate;
    }
    return undefined;
  }, [explicitSrc, localShot?.src, cloudFrameSrc, serverShotSrc, failedSrcs]);

  if (candidateSrc && !failedSrcs.has(candidateSrc)) {
    lastGoodSrcRef.current = candidateSrc;
  }
  const activeSrc =
    candidateSrc ??
    (lastGoodSrcRef.current && !failedSrcs.has(lastGoodSrcRef.current)
      ? lastGoodSrcRef.current
      : undefined);

  // 云端浏览器无显式帧时，运行期按可见性节流拉取最新画面并复用 chat-shots 持久化；已结束回合按 shotId 读页面历史帧。
  const allowCloudFetch =
    (enableCloudFrameFetch ?? Boolean(queryClient)) &&
    source === "cloud" &&
    Boolean(botId) &&
    !explicitSrc &&
    !localShot;

  const cloudFetchKey = allowCloudFetch
    ? `${botId}\0${shotId ?? runKey}\0${running ? "live" : "done"}`
    : false;

  useExternalConnection(cloudFetchKey, (_key, signal) => {
    if (!botId) return;
    let alive = true;
    const targetShotId = shotId || runKey;

    if (!running) {
      if (!shotId) return;
      void readPageFrame(botId, shotId).then((frame) => {
        if (!alive || signal.aborted || !frame?.frame) return;
        const dataUrl = frame.frame.startsWith("data:")
          ? frame.frame
          : `data:image/png;base64,${frame.frame}`;
        setCloudFrameSrc(dataUrl);
        keepShot(targetShotId, dataUrl, frame.url || safeUrl, botId);
      });
      return () => {
        alive = false;
      };
    }

    let ticks = 0;
    let timer = 0;
    const poll = async () => {
      if (!alive || signal.aborted || ticks >= MAX_CLOUD_POLL_TICKS) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        timer = window.setTimeout(() => void poll(), CLOUD_POLL_MS);
        return;
      }
      ticks += 1;
      const res = await readScreenshot(botId);
      if (!alive || signal.aborted) return;
      if (res.frame?.base64) {
        const dataUrl = `data:image/png;base64,${res.frame.base64}`;
        setCloudFrameSrc(dataUrl);
        keepShot(targetShotId, dataUrl, res.frame.url || safeUrl, botId);
      }
      if (alive && !signal.aborted && ticks < MAX_CLOUD_POLL_TICKS) {
        timer = window.setTimeout(() => void poll(), CLOUD_POLL_MS);
      }
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  });

  const handleImageError = useCallback(() => {
    if (!activeSrc) return;
    setFailedSrcs((prev) => {
      if (prev.has(activeSrc)) return prev;
      const next = new Set(prev);
      next.add(activeSrc);
      return next;
    });
  }, [activeSrc]);

  const handleOpenTab = useCallback(() => {
    const target: BrowserOpenTabTarget = {
      source,
      ...(typeof tabId === "number" ? { tabId } : {}),
      ...(safeUrl ? { url: safeUrl } : {}),
      ...(displayPageTitle ? { title: displayPageTitle } : {}),
    };
    if (onOpenTab) {
      void onOpenTab(target);
      return;
    }
    // 本机扩展记录在网页/PC 端查看时，若有安全网址则直接打开对应网页；云端浏览器优先跳右栏「计算机」。
    if (source === "extension" && safeUrl) {
      window.open(safeUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (router && !isSimpleModeEnabled()) {
      const wide =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia(PANEL_RAIL_WIDE_QUERY).matches;
      if (wide) setPanelRailOpen(true);
      else openPanelSheet("user");
      void router.navigate({
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          watch: true,
        })) as never,
      });
      return;
    }
    if (safeUrl) {
      window.open(safeUrl, "_blank", "noopener,noreferrer");
    }
  }, [displayPageTitle, onOpenTab, router, safeUrl, source, tabId]);

  const canOpenTab = Boolean(
    onOpenTab || safeUrl || (router && !isSimpleModeEnabled()),
  );
  const resolvedPhase =
    phaseBadge?.trim() ||
    (running
      ? host
        ? `查看 ${host}`
        : "正在操作浏览器"
      : host
        ? `浏览 ${host}`
        : "浏览器任务");
  const fallbackBotName = botName?.trim() || "助手";
  const stepCount = steps?.length ?? 0;
  const openTabTooltip = safeUrl
    ? `${safeUrl}\n点击打开标签页`
    : source === "extension"
      ? "点击聚焦对应的浏览器标签页"
      : "点击在右栏「计算机」查看浏览器";

  return (
    <div
      className={cn("browser-live-wrap", className)}
      data-run-key={runKey}
      data-testid="browser-live-wrap"
    >
      {/* 卡片上方悬浮「角色头像动作徽章」 */}
      <div
        className="browser-live-badge"
        data-surface="control"
        data-testid="browser-live-badge"
      >
        <ResolvedBotBadgeAvatar
          botAvatarUrl={botAvatarUrl}
          botId={botId}
          botName={botName}
          running={running}
        />
        <span className="browser-live-badge-name">
          {!botName && queryClient && botId ? (
            <BotNameFromRoster botId={botId} fallback={fallbackBotName} />
          ) : (
            fallbackBotName
          )}
        </span>
        <span aria-hidden="true" className="browser-live-badge-sep">
          {"·"}
        </span>
        <span className="browser-live-badge-phase">{resolvedPhase}</span>
        {running ? (
          <span
            aria-hidden="true"
            className="browser-live-dot"
            data-testid="browser-live-running-dot"
          />
        ) : null}
      </div>

      {/* 卡片主体（bubble 单通道轻模糊） */}
      <section
        aria-label={`浏览器实时预览：${stepLabel}`}
        className="browser-live-card"
        data-running={running ? "true" : "false"}
        data-source={source}
        data-surface="bubble"
        data-testid="browser-live-card"
      >
        <header className="browser-live-head">
          <span aria-hidden="true" className="browser-live-icon">
            <IconWorld className="size-4" />
          </span>
          <div className="browser-live-head-main">
            <div className="browser-live-title-row">
              <span className="browser-live-title">{"浏览器"}</span>
              <span className="browser-live-source-tag">
                {source === "extension" ? "Chrome 扩展" : "云端"}
              </span>
              {state === "yielded_to_human" ? (
                <span className="browser-live-source-tag is-issue">
                  {"已礼让暂停"}
                </span>
              ) : state === "awaiting_approval" ? (
                <span className="browser-live-source-tag is-issue">
                  {"等待确认"}
                </span>
              ) : null}
              {issues > 0 ? (
                <span className="browser-live-source-tag is-issue">
                  <IconAlertTriangle className="size-3" />
                  {`${issues} 项问题`}
                </span>
              ) : null}
            </div>
            <p
              className="browser-live-step"
              data-testid="browser-live-step"
              title={stepLabel}
            >
              {stepLabel}
            </p>
          </div>
          {stepCount > 0 ? (
            <button
              aria-expanded={stepsOpen}
              aria-label={stepsOpen ? "收起详细步骤" : "展开详细步骤"}
              className="browser-live-toggle"
              data-testid="browser-live-steps-toggle"
              onClick={() => setStepsOpen((open) => !open)}
              type="button"
            >
              <span>{`${stepCount} 步`}</span>
              <IconChevronDown
                aria-hidden="true"
                className="browser-live-toggle-chevron size-3.5"
              />
            </button>
          ) : null}
        </header>

        {/* 中部 16:10 圆角实时网页缩略图预览区 */}
        <div
          className="browser-live-stage"
          data-surface="inset"
          data-testid="browser-live-stage"
        >
          {activeSrc ? (
            <button
              aria-label={`放大查看${displayPageTitle || "网页"}预览图`}
              className="browser-live-stage-btn"
              data-testid="browser-live-thumb-btn"
              onClick={() => setLightboxOpen(true)}
              title="点击放大查看网页画面"
              type="button"
            >
              <img
                alt={`${displayPageTitle || "浏览器页面"}实时预览`}
                className="browser-live-img"
                data-testid="browser-live-thumb"
                decoding="async"
                onError={handleImageError}
                src={activeSrc}
              />
              <span aria-hidden="true" className="browser-live-zoom-hint">
                <IconMaximize className="size-3.5" />
              </span>
              {displayPageTitle ? (
                <span className="browser-live-page-pill">
                  <IconWorld aria-hidden="true" className="size-3 shrink-0" />
                  <span>{displayPageTitle}</span>
                </span>
              ) : null}
            </button>
          ) : running ? (
            <div
              aria-label="正在加载实时网页画面"
              className="browser-live-skel"
              data-testid="browser-live-skeleton"
              role="status"
            >
              <div className="browser-live-skel-bar w-2/5" />
              <div className="browser-live-skel-block" />
              <div className="browser-live-skel-bar w-3/4" />
            </div>
          ) : (
            <div
              className="browser-live-placeholder"
              data-testid="browser-live-placeholder"
            >
              <IconWorld aria-hidden="true" className="size-6 opacity-60" />
              <span className="browser-live-placeholder-title">
                {displayPageTitle || "浏览器活动已完成"}
              </span>
              {safeUrl ? (
                <span className="browser-live-placeholder-sub">{safeUrl}</span>
              ) : null}
            </div>
          )}
        </div>

        {/* 可折叠详细步骤列表 */}
        {stepCount > 0 ? (
          <SmoothCollapse open={stepsOpen} unmountOnExit>
            <ol
              className="browser-live-steps"
              data-surface="inset"
              data-testid="browser-live-steps"
            >
              {steps?.map((step) => (
                <li className="browser-live-step-item" key={step.id}>
                  <div className="browser-live-step-row">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "browser-live-step-dot",
                        step.failed
                          ? "is-failed"
                          : step.pending
                            ? "is-pending"
                            : undefined,
                      )}
                    />
                    <span className="browser-live-step-label">{step.label}</span>
                    {step.href ? (
                      <a
                        className="browser-live-step-link"
                        href={step.href}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {step.title ?? step.href}
                      </a>
                    ) : null}
                    <ActivityJumpButton
                      name={step.toolName}
                      toolCallId={step.toolCallId}
                    />
                    {step.pending ? (
                      <span className="browser-live-step-state">
                        {running ? "进行中" : "未完成"}
                      </span>
                    ) : null}
                  </div>
                  {step.failed ? (
                    <p className="browser-live-step-err">
                      {step.reason ?? "此步骤无法完成。"}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </SmoothCollapse>
        ) : null}

        {/* 底部全宽「打开标签页」按钮 */}
        <button
          className="browser-live-open-btn"
          data-testid="browser-live-open-tab"
          disabled={!canOpenTab}
          onClick={handleOpenTab}
          title={openTabTooltip}
          type="button"
        >
          <IconExternalLink aria-hidden="true" className="size-4" />
          <span>{"打开标签页"}</span>
        </button>
      </section>

      {/* 高危待审批 / 确认卡片挂接区（永远外露，不随步骤折叠） */}
      {approvalSlot}

      {/* 点击实时缩略图放大看大图（复用全局 Lightbox） */}
      {lightboxOpen && activeSrc ? (
        <Lightbox
          images={[
            {
              src: activeSrc,
              alt: `${displayPageTitle || "浏览器页面"}预览`,
              name: `浏览器预览${host ? `-${host}` : ""}.jpg`,
            },
          ]}
          onClose={() => setLightboxOpen(false)}
          startIndex={0}
        />
      ) : null}
    </div>
  );
}

BrowserLiveCardImpl.displayName = "BrowserLiveCard";
export const BrowserLiveCard = memo(BrowserLiveCardImpl);

export type BrowserStatusBarProps = {
  active: boolean;
  stepLabel?: string;
  source?: BrowserLiveCardSource;
  tabUrl?: string;
  tabTitle?: string;
  tabId?: number;
  onOpenTab?: (target: BrowserOpenTabTarget) => void | Promise<void>;
};

/**
 * 输入框正上方运行期单行实时状态横条：`🌐 浏览器 · <当前动作文案>`，运行结束平滑收起。
 */
function BrowserStatusBarImpl({
  active,
  stepLabel,
  source = "cloud",
  tabUrl,
  tabTitle,
  tabId,
  onOpenTab,
}: BrowserStatusBarProps) {
  const retainedLabel = useRetainedValue(
    active ? (stepLabel?.trim() || "正在操作页面…") : null,
  );
  const safeUrl = safeBrowserHref(tabUrl);
  const handleOpen = useCallback(() => {
    if (onOpenTab) {
      void onOpenTab({
        source,
        ...(tabId !== undefined ? { tabId } : {}),
        ...(safeUrl ? { url: safeUrl } : {}),
        ...(tabTitle ? { title: tabTitle } : {}),
      });
      return;
    }
    if (safeUrl) {
      window.open(safeUrl, "_blank", "noopener,noreferrer");
    }
  }, [onOpenTab, safeUrl, source, tabId, tabTitle]);

  return (
    <SmoothCollapse open={active} unmountOnExit>
      <div className="browser-status-slot">
        <div
          aria-live="polite"
          className="browser-status-bar"
          data-source={source}
          data-surface="bubble"
          data-testid="browser-status-bar"
          role="status"
        >
          <span aria-hidden="true" className="browser-live-dot" />
          <span aria-hidden="true" className="browser-status-icon">
            <IconWorld className="size-4" />
          </span>
          <span className="browser-status-prefix">{"浏览器"}</span>
          <span aria-hidden="true" className="browser-status-sep">
            {"·"}
          </span>
          <span
            className="browser-status-text"
            data-testid="browser-status-text"
          >
            {retainedLabel ?? "正在操作页面…"}
          </span>
          {onOpenTab || safeUrl ? (
            <button
              className="browser-status-action"
              data-testid="browser-status-open-tab"
              onClick={handleOpen}
              type="button"
            >
              {"打开标签页"}
            </button>
          ) : null}
        </div>
      </div>
    </SmoothCollapse>
  );
}

BrowserStatusBarImpl.displayName = "BrowserStatusBar";
export const BrowserStatusBar = memo(BrowserStatusBarImpl);
