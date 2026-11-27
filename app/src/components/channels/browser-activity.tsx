import type { Message } from "@ag-ui/core";
import { QueryClientContext } from "@tanstack/react-query";
import { memo, useContext, useMemo } from "react";
import { PendingApprovals } from "@/components/approvals/inline-approval";
import { ToolCallConfirmCards } from "@/components/chat/confirm-card";
import {
  BrowserLiveCard,
  type BrowserLiveCardPayload,
  type BrowserLiveCardSource,
  type BrowserLiveStepItem,
  type BrowserOpenTabTarget,
  hostLabelOf,
  safeBrowserHref,
} from "@/components/computer/browser-live-card";
import { useConversationScope } from "@/lib/chat/conversation-scope";
import {
  type BrowserCompanionState,
  isBrowserCompanionOperation,
  isBrowserCompanionState,
} from "../../../../shared/browser-companion";
import type { VisibleChatItem } from "./chat-messages";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;
export type BrowserGroup = {
  kind: "browser";
  id: string;
  steps: BrowserStep[];
};
export type TranscriptItem = VisibleChatItem | BrowserGroup;

/** 双源浏览器工具集合（兼容云端 computer_* 与本机 Chrome 扩展 browser_*）。 */
const BROWSER_TOOL_LABELS: Record<string, string> = {
  // 云端 agent-computer 浏览器工具
  computer_navigate: "打开了页面",
  computer_read: "读取了页面",
  computer_snapshot: "检查了页面",
  computer_click: "点击了页面",
  computer_type: "填写了字段",
  computer_key: "按下了按键",
  computer_scroll: "滚动了页面",
  computer_screenshot: "截取了画面",
  computer_tabs: "管理了标签页",
  // 本机 Chrome / Edge 浏览器伴侣扩展工具
  browser_navigate: "打开了页面",
  browser_read: "读取了页面",
  browser_snapshot: "检查了页面",
  browser_click: "点击了页面",
  browser_hover: "悬停查看元素",
  browser_type: "填写了字段",
  browser_key: "按下了按键",
  browser_scroll: "滚动了页面",
  browser_screenshot: "截取了画面",
  browser_tabs: "管理了标签页",
  browser_control: "切换了接管状态",
};

const ACTIVE_STEP_LABELS: Record<string, string> = {
  computer_navigate: "正在打开页面",
  computer_read: "正在阅读页面内容",
  computer_snapshot: "正在分析页面结构与元素",
  computer_click: "正在点击页面元素",
  computer_type: "正在填写表单内容",
  computer_key: "正在发送按键操作",
  computer_scroll: "正在滚动浏览页面",
  computer_screenshot: "正在捕获页面实时画面",
  computer_tabs: "正在管理浏览器标签页",
  browser_navigate: "正在打开页面",
  browser_read: "正在阅读当前标签页",
  browser_snapshot: "正在读取页面无障碍快照",
  browser_click: "正在点击页面元素",
  browser_hover: "正在悬停查看页面图表与提示",
  browser_type: "正在填写输入框",
  browser_key: "正在发送按键操作",
  browser_scroll: "正在向下查看页面内容",
  browser_screenshot: "正在捕获当前标签页画面",
  browser_tabs: "正在查看或切换标签页",
  browser_control: "正在同步浏览器接管状态",
};

export function isBrowserToolName(name: string | undefined): boolean {
  return (
    typeof name === "string" &&
    (Object.hasOwn(BROWSER_TOOL_LABELS, name) ||
      isBrowserCompanionOperation(name))
  );
}

/** Group adjacent browsing steps without moving messages or hiding requests for human help. */
export function groupBrowserSteps(
  items: readonly VisibleChatItem[],
): TranscriptItem[] {
  const grouped: TranscriptItem[] = [];
  for (const item of items) {
    if (
      item.kind !== "tool" ||
      !isBrowserToolName(item.toolCall.function.name)
    ) {
      grouped.push(item);
      continue;
    }
    const last = grouped.at(-1);
    if (last?.kind === "browser") last.steps.push(item);
    else grouped.push({ kind: "browser", id: item.id, steps: [item] });
  }
  return grouped;
}

function objectOf(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") {
      const inner: unknown = JSON.parse(parsed);
      return inner && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : {};
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericTabId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function inferStepActionText(
  name: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  pending: boolean,
  href?: string,
  title?: string,
): string {
  const explicit =
    nonEmptyString(result.stepLabel) ??
    nonEmptyString(args.stepLabel) ??
    nonEmptyString(args.reason) ??
    nonEmptyString(args.description);
  if (explicit) return explicit;

  const host = hostLabelOf(href);
  const elementObj =
    result.element && typeof result.element === "object"
      ? (result.element as { name?: unknown })
      : null;
  const elementName = nonEmptyString(elementObj?.name);

  if (name === "computer_navigate" || name === "browser_navigate") {
    const target = title || host || "页面";
    return pending ? `正在打开 ${target}` : `已打开 ${target}`;
  }
  if (name === "computer_scroll" || name === "browser_scroll") {
    const deltaY = typeof args.deltaY === "number" ? args.deltaY : 600;
    if (deltaY < 0) return pending ? "正在向上滚动查看页面" : "已向上滚动页面";
    return pending ? "正在向下滚动查看页面" : "已向下滚动查看页面";
  }
  if (name === "browser_hover") {
    return elementName
      ? pending
        ? `正在悬停查看「${elementName}」`
        : `已悬停查看「${elementName}」`
      : pending
        ? "正在悬停查看页面元素"
        : "已悬停查看页面元素";
  }
  if (name === "computer_click" || name === "browser_click") {
    return elementName
      ? pending
        ? `正在点击「${elementName}」`
        : `已点击「${elementName}」`
      : pending
        ? "正在点击页面元素"
        : "已点击页面元素";
  }
  if (name === "computer_type" || name === "browser_type") {
    return elementName
      ? pending
        ? `正在填写「${elementName}」`
        : `已填写「${elementName}」`
      : pending
        ? "正在填写输入框"
        : "已填写表单字段";
  }
  if (name === "computer_key" || name === "browser_key") {
    const keyName = nonEmptyString(args.key);
    return keyName
      ? pending
        ? `正在按下 ${keyName}`
        : `已按下 ${keyName}`
      : pending
        ? "正在按键"
        : "已发送按键";
  }
  if (name === "computer_tabs" || name === "browser_tabs") {
    const action = nonEmptyString(args.action);
    if (action === "new") {
      return host
        ? pending
          ? `正在新标签页打开 ${host}`
          : `已在新标签页打开 ${host}`
        : pending
          ? "正在新建标签页"
          : "已新建标签页";
    }
    if (action === "switch" || action === "activate") {
      return pending ? "正在切换标签页" : "已切换标签页";
    }
    if (action === "close") {
      return pending ? "正在关闭标签页" : "已关闭标签页";
    }
    return pending ? "正在查看标签页列表" : "已查看标签页列表";
  }

  return pending
    ? (ACTIVE_STEP_LABELS[name] ?? "正在操作浏览器")
    : (BROWSER_TOOL_LABELS[name] ?? "浏览器活动");
}

export function browserStepDetails(step: BrowserStep) {
  const name = step.toolCall.function.name;
  const result = objectOf(step.result);
  const args = objectOf(step.toolCall.function.arguments);
  const pageObj =
    result.page && typeof result.page === "object"
      ? (result.page as { url?: unknown; title?: unknown })
      : null;
  const navigation =
    name === "computer_navigate" ||
    name === "browser_navigate" ||
    ((name === "computer_tabs" || name === "browser_tabs") &&
      args.action === "new");
  const rawUrl =
    nonEmptyString(result.url) ??
    nonEmptyString(result.tabUrl) ??
    nonEmptyString(pageObj?.url) ??
    (navigation ? nonEmptyString(args.url) : undefined);
  const safeHref = safeBrowserHref(rawUrl);
  let url: URL | undefined;
  if (safeHref) {
    try {
      url = new URL(safeHref);
    } catch {
      url = undefined;
    }
  }
  const rawTitle =
    nonEmptyString(result.title) ??
    nonEmptyString(result.tabTitle) ??
    nonEmptyString(pageObj?.title);
  const failed =
    result.ok === false ||
    result.refused === true ||
    step.result?.startsWith("Error:") === true;
  const pending = step.result === undefined;
  const source: BrowserLiveCardSource =
    name.startsWith("browser_") || result.source === "extension"
      ? "extension"
      : "cloud";
  const shotId =
    nonEmptyString(result.shotId) ??
    ((name === "computer_screenshot" || name === "browser_screenshot") &&
    !pending &&
    !failed
      ? step.toolCall.id
      : undefined);
  const explicitShotUrl =
    nonEmptyString(result.shotUrl) ??
    nonEmptyString(result.screenshotUrl) ??
    nonEmptyString(result.dataUrl) ??
    (shotId ? `/api/chat-shots/${encodeURIComponent(shotId)}` : undefined);
  const tabId = numericTabId(result.tabId) ?? numericTabId(args.tabId);
  const companionState: BrowserCompanionState | undefined =
    isBrowserCompanionState(result.state)
      ? result.state
      : result.yielded === true
        ? "yielded_to_human"
        : result.awaitingApproval === true
          ? "awaiting_approval"
          : undefined;
  const label = BROWSER_TOOL_LABELS[name] ?? "浏览器活动";
  const stepText = inferStepActionText(
    name,
    args,
    result,
    pending,
    navigation ? url?.href : safeHref,
    rawTitle,
  );
  return {
    label,
    stepText,
    source,
    href: navigation ? url?.href : undefined,
    pageUrl: url?.href,
    title: navigation
      ? (rawTitle ?? url?.hostname)
      : (rawTitle ?? url?.hostname),
    pageTitle: rawTitle,
    tabId,
    shotId,
    shotUrl: explicitShotUrl,
    companionState,
    failed,
    reason: nonEmptyString(result.reason),
    visited: navigation && result.ok === true,
    pending,
  };
}

export type ProjectedBrowserGroup = {
  payload: BrowserLiveCardPayload;
  steps: BrowserLiveStepItem[];
  shotId?: string;
  issues: number;
  visitedPages: number;
  toolCallIds: string[];
};

/** 将连续浏览器工具组投影为全端共用的 BrowserLiveCard 数据模型。 */
export function projectBrowserGroup(
  group: BrowserGroup,
  options: {
    active: boolean;
    botId?: string;
    botName?: string;
    phaseBadge?: string;
  },
): ProjectedBrowserGroup {
  const detailed = group.steps.map((step) => ({
    id: step.id,
    toolCall: step.toolCall,
    ...browserStepDetails(step),
  }));

  const visitedPages = detailed.filter((step) => step.visited).length;
  const issues = detailed.filter((step) => step.failed).length;
  const running = options.active && detailed.some((step) => step.pending);

  let source: BrowserLiveCardSource = "cloud";
  let latestUrl: string | undefined;
  let latestTitle: string | undefined;
  let latestTabId: number | undefined;
  let latestShotUrl: string | undefined;
  let latestShotId: string | undefined;
  let latestNavCallId: string | undefined;
  let latestCompletedCallId: string | undefined;
  let latestState: BrowserCompanionState | undefined;

  for (const step of detailed) {
    if (step.source === "extension") source = "extension";
    if (step.pageUrl) latestUrl = step.pageUrl;
    if (step.pageTitle) latestTitle = step.pageTitle;
    if (step.tabId !== undefined) latestTabId = step.tabId;
    if (step.shotUrl) latestShotUrl = step.shotUrl;
    if (step.shotId) latestShotId = step.shotId;
    if (step.companionState) latestState = step.companionState;
    if (!step.pending && !step.failed) {
      latestCompletedCallId = step.toolCall.id;
      if (
        step.toolCall.function.name === "computer_navigate" ||
        step.toolCall.function.name === "browser_navigate"
      ) {
        latestNavCallId = step.toolCall.id;
      }
    }
  }

  const activeStep =
    [...detailed].reverse().find((step) => step.pending) ?? detailed.at(-1);
  const stepLabel =
    activeStep?.stepText ||
    (running
      ? "正在操作浏览器…"
      : visitedPages > 0
        ? `浏览了 ${visitedPages} 页`
        : "浏览器活动");

  const host = hostLabelOf(latestUrl);
  const phaseBadge =
    options.phaseBadge?.trim() ||
    (latestTitle
      ? latestTitle.slice(0, 18)
      : host
        ? `查看 ${host}`
        : source === "extension"
          ? "操作本机浏览器"
          : "浏览器任务");

  const steps: BrowserLiveStepItem[] = detailed.map((step) => ({
    id: step.id,
    toolName: step.toolCall.function.name,
    toolCallId: step.toolCall.id,
    label: step.label,
    ...(step.href ? { href: step.href } : {}),
    ...(step.title ? { title: step.title } : {}),
    failed: step.failed,
    ...(step.reason ? { reason: step.reason } : {}),
    pending: step.pending,
  }));

  return {
    payload: {
      runKey: group.id,
      source,
      botId: options.botId ?? "",
      botName: options.botName ?? "",
      phaseBadge,
      stepLabel,
      tabTitle: latestTitle ?? "",
      tabUrl: latestUrl ?? "",
      ...(latestTabId !== undefined ? { tabId: latestTabId } : {}),
      ...(latestShotUrl ? { shotUrl: latestShotUrl } : {}),
      ...(latestState ? { state: latestState } : {}),
      running,
    },
    steps,
    shotId: latestShotId ?? latestNavCallId ?? latestCompletedCallId,
    issues,
    visitedPages,
    toolCallIds: group.steps.map((step) => step.toolCall.id),
  };
}

export type ActiveBrowserStatus = {
  active: boolean;
  source: BrowserLiveCardSource;
  stepLabel: string;
  tabUrl?: string;
  tabTitle?: string;
  tabId?: number;
};

/**
 * 仅扫描最后一轮消息，高效派生输入框上方单行状态横条数据。
 * 回合结束或最后一个活跃步骤不再是浏览器工具时返回 null，避免流式文本每 token 引起抖动。
 */
export function deriveActiveBrowserStatus(
  messages: ReadonlyArray<Readonly<Message>>,
  active: boolean,
): ActiveBrowserStatus | null {
  if (!active || messages.length === 0) return null;

  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      turnStart = i + 1;
      break;
    }
  }

  const results = new Map<string, string | undefined>();
  for (let i = turnStart; i < messages.length; i += 1) {
    const msg = messages[i];
    if (
      msg?.role === "tool" &&
      "toolCallId" in msg &&
      typeof msg.toolCallId === "string"
    ) {
      results.set(
        msg.toolCallId,
        typeof msg.content === "string" ? msg.content : undefined,
      );
    }
  }

  let latestPendingBrowser: BrowserStep | null = null;
  let latestBrowser: BrowserStep | null = null;
  let latestUrl: string | undefined;
  let latestTitle: string | undefined;
  let latestTabId: number | undefined;
  let hasLaterNonBrowserTool = false;
  let hasFinalAssistantTextAfterBrowser = false;

  for (let i = turnStart; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const calls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
    for (const call of calls) {
      if (!call?.id || !call.function?.name) continue;
      if (isBrowserToolName(call.function.name)) {
        const step: BrowserStep = {
          kind: "tool",
          id: call.id,
          toolCall: call,
          ...(results.has(call.id) ? { result: results.get(call.id) } : {}),
        };
        const stepInfo = browserStepDetails(step);
        if (stepInfo.pageUrl) latestUrl = stepInfo.pageUrl;
        if (stepInfo.pageTitle) latestTitle = stepInfo.pageTitle;
        if (stepInfo.tabId !== undefined) latestTabId = stepInfo.tabId;
        latestBrowser = step;
        hasLaterNonBrowserTool = false;
        hasFinalAssistantTextAfterBrowser = false;
        if (!results.has(call.id)) latestPendingBrowser = step;
      } else {
        hasLaterNonBrowserTool = true;
      }
    }
    if (
      latestBrowser &&
      calls.length === 0 &&
      typeof msg.content === "string" &&
      msg.content.trim().length > 0 &&
      !latestPendingBrowser
    ) {
      hasFinalAssistantTextAfterBrowser = true;
    }
  }

  const target =
    latestPendingBrowser ??
    (!hasLaterNonBrowserTool && !hasFinalAssistantTextAfterBrowser
      ? latestBrowser
      : null);
  if (!target) return null;

  const details = browserStepDetails(target);
  const tabUrl = details.pageUrl ?? latestUrl;
  const tabTitle = details.pageTitle ?? latestTitle;
  const tabId = details.tabId ?? latestTabId;
  return {
    active: true,
    source: details.source,
    stepLabel: details.stepText,
    ...(tabUrl ? { tabUrl } : {}),
    ...(tabTitle ? { tabTitle } : {}),
    ...(tabId !== undefined ? { tabId } : {}),
  };
}

/** 仅在存在 QueryClient 和 ConversationScope 时渲染工具确认卡，保证独立单测零崩溃。 */
function BrowserApprovalCluster({
  steps,
  toolCallIds,
  recent,
}: {
  steps: readonly BrowserStep[];
  toolCallIds: readonly string[];
  recent: boolean;
}) {
  const queryClient = useContext(QueryClientContext);
  const scope = useConversationScope();
  if (!queryClient) return null;
  return (
    <>
      <PendingApprovals toolCallIds={toolCallIds} />
      {scope?.threadId
        ? steps.map((step) => (
            <ToolCallConfirmCards
              answered={step.result !== undefined}
              key={step.toolCall.id}
              recent={recent}
              toolCallId={step.toolCall.id}
            />
          ))
        : null}
    </>
  );
}

function BrowserActivityImpl({
  group,
  active,
  agentId,
  botName,
  phaseBadge,
  onOpenTab,
  recent = true,
}: {
  group: BrowserGroup;
  active: boolean;
  agentId?: string;
  botName?: string;
  phaseBadge?: string;
  onOpenTab?: (target: BrowserOpenTabTarget) => void | Promise<void>;
  recent?: boolean;
}) {
  const projected = useMemo(
    () =>
      projectBrowserGroup(group, {
        active,
        botId: agentId,
        botName,
        phaseBadge,
      }),
    [active, agentId, botName, group, phaseBadge],
  );

  const approvalSlot = useMemo(
    () => (
      <BrowserApprovalCluster
        recent={recent}
        steps={group.steps}
        toolCallIds={projected.toolCallIds}
      />
    ),
    [group.steps, projected.toolCallIds, recent],
  );

  return (
    <BrowserLiveCard
      {...projected.payload}
      approvalSlot={approvalSlot}
      issues={projected.issues}
      onOpenTab={onOpenTab}
      shotId={projected.shotId}
      steps={projected.steps}
    />
  );
}

BrowserActivityImpl.displayName = "BrowserActivity";
export const BrowserActivity = memo(BrowserActivityImpl);
