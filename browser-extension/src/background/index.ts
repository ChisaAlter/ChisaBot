import type { ChromeApi, ChromePort } from "../types/chrome";
import type {
  BrowserCompanionOperation,
  BrowserLiveCardState,
  CompanionAuthRecord,
  CompanionLocalSettings,
  CompanionStateReport,
  HudInboundMessage,
  HudOutboundMessage,
  PanelPushMessage,
  PanelRequestMessage,
  PendingApprovalItem,
} from "../types/protocol";
import { createExtensionAuth } from "./auth";
import {
  checkExplicitTabScope,
  evaluateLocalCallRisk,
  planSafeNavigationTarget,
} from "./call-guard";
import { createCdpDriver } from "./cdp-driver";
import { createCompanionApi } from "./companion-api";
import {
  type BrowserCompanionEvent,
  type BrowserCompanionSession,
  canCompanionBotAct,
  createInitialBrowserCompanionSession,
  getBlockedUrlReason,
  reduceBrowserCompanionSession,
} from "./security-bridge";
import {
  createCompanionStorage,
  defaultSettings,
  normalizeSettings,
} from "./storage";
import { createTabGroupManager } from "./tab-group-manager";
import {
  createCompanionWsClient,
  type WebSocketFactory,
  type WsCallPayload,
  type WsConnectionState,
} from "./ws-client";

/**
 * ChisaBot 浏览器伴侣 MV3 Service Worker 主入口。
 *
 * MV3 生命周期红线：
 * - 所有 Chrome 事件监听器（action.onClicked / tabs.* / webNavigation.* / debugger.onDetach /
 *   runtime.onConnect / runtime.onMessage）必须在顶层同步注册，严禁位于任何 `await` 之后；
 * - 异步状态恢复（storage.loadAuth / loadSettings / setPanelBehavior）放入 `readyPromise`，
 *   所有回调在消费持久化状态前统一 `await readyPromise`，确保冷启动与休眠唤醒零丢事件。
 */

const HUD_SCRIPT_PATH = "content/hud.js";

const MUTATING_OPERATIONS = new Set<string>([
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_key",
]);

function humanReadableStep(
  operation: string,
  args: Record<string, unknown>,
): string {
  if (typeof args.stepLabel === "string" && args.stepLabel.trim()) {
    return args.stepLabel.trim();
  }
  switch (operation) {
    case "browser_tabs":
      return "查看当前浏览器标签页";
    case "browser_snapshot":
      return "分析页面交互控件结构";
    case "browser_read":
      return "读取当前页面正文内容";
    case "browser_navigate":
      return typeof args.url === "string"
        ? `打开网页 ${args.url}`
        : "正在跳转页面";
    case "browser_click":
      return "点击页面控件";
    case "browser_hover":
      return "悬停查看图表或元素详情";
    case "browser_type":
      return "填写表单内容";
    case "browser_key":
      return typeof args.key === "string"
        ? `按下按键 ${args.key}`
        : "发送按键操作";
    case "browser_scroll":
      return typeof args.deltaY === "number" && args.deltaY < 0
        ? "向上滚动浏览页面"
        : "向下滚动查看更多内容";
    case "browser_screenshot":
      return "捕获当前页面画面";
    default:
      return "正在协作浏览页面";
  }
}

export interface BackgroundRuntimeDeps {
  chromeApi?: ChromeApi;
  fetchImpl?: typeof fetch;
  createWebSocket?: WebSocketFactory;
}

export function initializeBackgroundRuntime(deps: BackgroundRuntimeDeps = {}) {
  const api = deps.chromeApi ?? chrome;
  const storage = createCompanionStorage(api.storage.local);
  const authService = createExtensionAuth({
    chromeApi: api,
    fetchImpl: deps.fetchImpl,
  });
  const companionApi = createCompanionApi({ fetchImpl: deps.fetchImpl });

  let auth: CompanionAuthRecord | null = null;
  let settings: CompanionLocalSettings = defaultSettings();
  let session: BrowserCompanionSession = createInitialBrowserCompanionSession({
    sessionId: `ext-${Date.now()}`,
    deviceId: null,
    botId: null,
    botName: "ChisaBot",
    attached: settings.attachedByDefault,
    allowRemoteDispatch: settings.allowRemoteDispatch,
    updatedAt: Date.now(),
  });

  let wsState: WsConnectionState = "offline";
  let wsError: string | null = null;
  let activeBotAvatarUrl: string | null = null;
  let currentPhaseBadge: string | null = null;
  let latestScreenshotDataUrl: string | null = null;
  let latestScreenshotTabId: number | null = null;
  let latestScreenshotUrl: string | null = null;
  let latestScreenshotTitle: string | null = null;
  let yieldNotice: string | null = null;
  let pendingApprovals: PendingApprovalItem[] = [];
  let activeChatAbort: AbortController | null = null;
  let activeThreadId: string | null = null;
  let liveCard: BrowserLiveCardState | null = null;

  const panelPorts = new Set<ChromePort>();
  const hudInjectedTabs = new Set<number>();
  const yieldWaiters = new Set<{
    resolve: (resumed: boolean) => void;
  }>();

  function getExtensionVersion(): string {
    try {
      return api.runtime.getManifest().version || "0.1.0";
    } catch {
      return "0.1.0";
    }
  }

  function buildRuntimeState() {
    const tabSnap = tabGroups.snapshot();
    return {
      auth,
      wsState,
      wsError,
      sessionState: session.state,
      attached: tabSnap.attached && session.attached,
      activeTab: tabSnap.activeTab,
      controlledTabIds: tabSnap.controlledTabIds,
      tabGroupId: tabSnap.tabGroupId,
      tabGroupBotName: tabSnap.tabGroupBotName,
      activeBotId: session.botId,
      activeBotName: session.botName,
      activeBotAvatarUrl,
      currentStepLabel: session.currentStepLabel,
      currentPhaseBadge,
      latestScreenshotDataUrl,
      latestScreenshotTabId,
      latestScreenshotUrl,
      latestScreenshotTitle,
      yieldReason: yieldNotice,
      yieldReasonCode: session.yieldReason,
      pendingApprovals: [...pendingApprovals],
      settings,
    };
  }

  function buildCompanionStateReport(): CompanionStateReport {
    const tabSnap = tabGroups.snapshot();
    return {
      sessionId: session.sessionId,
      state: session.state,
      tier: settings.tier,
      blockedDomains: settings.blockedDomains,
      allowRemoteDispatch: settings.allowRemoteDispatch,
      attached: tabSnap.attached && session.attached,
      attachedTabId: tabSnap.activeTab?.tabId ?? session.activeTabId,
      activeTabId: tabSnap.activeTab?.tabId ?? session.activeTabId,
      activeTabTitle: tabSnap.activeTab?.title ?? null,
      activeTabUrl: tabSnap.activeTab?.url ?? null,
      tabGroupId: tabSnap.tabGroupId ?? session.tabGroupId,
      tabCount: tabSnap.controlledTabIds.length,
      botId: session.botId,
      botName: session.botName,
      currentStepLabel: session.currentStepLabel,
      yieldReason: session.yieldReason,
      updatedAt: new Date(session.updatedAt || Date.now()).toISOString(),
    };
  }

  function broadcastToPanels(message: PanelPushMessage) {
    for (const port of panelPorts) {
      try {
        port.postMessage(message);
      } catch {
        panelPorts.delete(port);
      }
    }
  }

  function pushStateSnapshot() {
    broadcastToPanels({
      type: "STATE_SNAPSHOT",
      state: buildRuntimeState(),
    });
    wsClient.sendCompanionState(buildCompanionStateReport());
  }

  function dispatchSession(event: BrowserCompanionEvent) {
    const prev = session;
    session = reduceBrowserCompanionSession(session, {
      ...event,
      timestamp: event.timestamp ?? Date.now(),
    });
    if (session.state !== "yielded_to_human") {
      yieldNotice = null;
    }
    if (
      session.state !== prev.state ||
      session.currentStepLabel !== prev.currentStepLabel ||
      session.attached !== prev.attached ||
      session.tabCount !== prev.tabCount
    ) {
      pushStateSnapshot();
    }
  }

  function wakeYieldWaiters(resumed: boolean) {
    const waiters = [...yieldWaiters];
    yieldWaiters.clear();
    for (const w of waiters) {
      w.resolve(resumed);
    }
  }

  function waitForHumanResume(signal: AbortSignal): Promise<boolean> {
    if (session.state !== "yielded_to_human") return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = { resolve };
      yieldWaiters.add(waiter);
      const onAbort = () => {
        yieldWaiters.delete(waiter);
        resolve(false);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function ensureHudInjected(tabId: number): Promise<boolean> {
    try {
      const tab = await api.tabs.get(tabId);
      const url = tab.url ?? tab.pendingUrl ?? "";
      if (!/^https?:\/\//i.test(url)) return false;
      if (getBlockedUrlReason(url, settings.blockedDomains)) return false;

      if (!hudInjectedTabs.has(tabId)) {
        await api.scripting.executeScript({
          target: { tabId },
          files: [HUD_SCRIPT_PATH],
        });
        hudInjectedTabs.add(tabId);
      }
      return true;
    } catch {
      hudInjectedTabs.delete(tabId);
      return false;
    }
  }

  async function sendHudMessage(
    tabId: number,
    message: HudInboundMessage,
  ): Promise<void> {
    if (message.type !== "HUD_REMOVE") {
      const ready = await ensureHudInjected(tabId);
      if (!ready) return;
    }
    try {
      await api.tabs.sendMessage(tabId, message);
    } catch {
      hudInjectedTabs.delete(tabId);
      if (message.type !== "HUD_REMOVE") {
        const retried = await ensureHudInjected(tabId);
        if (retried) {
          await api.tabs.sendMessage(tabId, message).catch(() => {});
        }
      }
    }
  }

  async function syncHudOnTabs(stepText?: string) {
    const targets = new Set<number>(tabGroups.snapshot().controlledTabIds);
    for (const tabId of targets) {
      if (session.hudVisible) {
        await sendHudMessage(tabId, {
          type: "HUD_UPDATE",
          payload: {
            state: session.state,
            botName: session.botName || "ChisaBot",
            botAvatarUrl: activeBotAvatarUrl,
            stepLabel: stepText ?? session.currentStepLabel ?? "正在浏览页面…",
            yieldReason: yieldNotice,
          },
        });
      } else {
        await sendHudMessage(tabId, { type: "HUD_REMOVE" });
      }
    }
  }

  async function detachAllAndClearHud(
    options: { stopRemoteRun?: boolean; event?: BrowserCompanionEvent } = {},
  ) {
    wakeYieldWaiters(false);
    const controlled = tabGroups.snapshot().controlledTabIds;
    await Promise.all(
      controlled.map((tabId) => sendHudMessage(tabId, { type: "HUD_REMOVE" })),
    );
    await cdp.detachAll();
    tabGroups.clearSessionGroupState();
    dispatchSession(
      options.event ?? { type: "detach", reason: "user_close_hud" },
    );

    if (options.stopRemoteRun && auth) {
      activeChatAbort?.abort();
      activeChatAbort = null;
      await companionApi.stopRun(auth, {
        ...(activeThreadId ? { threadId: activeThreadId } : {}),
        detach: true,
      });
    }
  }

  // ---- 同步注册所有标签组与 CDP 监听器（零 await 前置） ----

  const tabGroups = createTabGroupManager({
    chromeApi: api,
    initialAttached: settings.attachedByDefault,
    onChange: () => {
      pushStateSnapshot();
    },
    onControlledTabRemoved: (tabId) => {
      hudInjectedTabs.delete(tabId);
      void cdp.detach(tabId);
    },
  });

  const cdp = createCdpDriver({
    chromeApi: api,
    onBeforeSyntheticInput: async (tabId, durationMs) => {
      await sendHudMessage(tabId, {
        type: "HUD_SYNTHETIC_WINDOW",
        durationMs,
      });
    },
    onBeforeScreenshot: async (tabId) => {
      await sendHudMessage(tabId, { type: "HUD_HIDE_FOR_CAPTURE" });
    },
    onAfterScreenshot: async (tabId) => {
      await sendHudMessage(tabId, { type: "HUD_RESTORE_AFTER_CAPTURE" });
    },
    onExternalDetach: (tabId, reason) => {
      void sendHudMessage(tabId, { type: "HUD_REMOVE" });
      if (cdp.getAttachedTabIds().length === 0) {
        wakeYieldWaiters(false);
        dispatchSession({ type: "detach", reason: "debugger_cancelled" });
      }
      if (reason === "canceled_by_user" && auth) {
        void companionApi.stopRun(auth, {
          ...(activeThreadId ? { threadId: activeThreadId } : {}),
          detach: true,
        });
      }
    },
  });

  function extractExplicitTabId(args: Record<string, unknown>): number | null {
    if (typeof args.tabId === "number" && Number.isInteger(args.tabId)) {
      return args.tabId;
    }
    return null;
  }

  function resolveCandidateTabId(args: Record<string, unknown>): number | null {
    const explicit = extractExplicitTabId(args);
    if (explicit !== null) return explicit;
    const snap = tabGroups.snapshot();
    if (snap.controlledTabIds.length > 0) {
      const lastControlled = snap.controlledTabIds.at(-1);
      if (typeof lastControlled === "number") return lastControlled;
    }
    if (snap.attached && snap.activeTab) {
      return snap.activeTab.tabId;
    }
    return null;
  }

  function updateLiveCardProgress(patch: {
    botName: string;
    operation: string;
    stepLabel: string;
    tabId?: number;
    url?: string;
    title?: string;
    shotDataUrl?: string;
    running: boolean;
    status?: "running" | "done" | "error";
  }) {
    const runKey = liveCard?.runKey || `ext-${Date.now()}`;
    const stepId = `${patch.operation}-${Date.now()}`;
    const prevSteps = liveCard?.steps ?? [];
    const nextSteps =
      patch.status === "running"
        ? [
            ...prevSteps.slice(-14),
            {
              id: stepId,
              toolName: patch.operation,
              label: patch.stepLabel,
              status: "running" as const,
              url: patch.url,
              tabId: patch.tabId,
              at: Date.now(),
            },
          ]
        : prevSteps.map((s, idx) =>
            idx === prevSteps.length - 1
              ? {
                  ...s,
                  status: (patch.status ?? "done") as "done" | "error",
                  url: patch.url ?? s.url,
                  tabId: patch.tabId ?? s.tabId,
                }
              : s,
          );

    liveCard = {
      runKey,
      source: "extension",
      botId: session.botId ?? "default",
      botName: patch.botName,
      botAvatarUrl: activeBotAvatarUrl,
      phaseBadge: currentPhaseBadge || "查看网页",
      stepLabel: patch.stepLabel,
      tabTitle: patch.title ?? liveCard?.tabTitle ?? "",
      tabUrl: patch.url ?? liveCard?.tabUrl ?? "",
      tabId: patch.tabId ?? liveCard?.tabId,
      shotDataUrl: patch.shotDataUrl ?? liveCard?.shotDataUrl,
      running: patch.running,
      steps: nextSteps,
    };

    if (patch.shotDataUrl) {
      latestScreenshotDataUrl = patch.shotDataUrl;
      latestScreenshotTabId = patch.tabId ?? latestScreenshotTabId;
      latestScreenshotUrl = patch.url ?? latestScreenshotUrl;
      latestScreenshotTitle = patch.title ?? latestScreenshotTitle;
    }
    broadcastToPanels({ type: "LIVE_CARD_UPDATE", card: liveCard });
  }

  async function captureSilentPreview(
    tabId: number,
  ): Promise<string | undefined> {
    try {
      const shot = await cdp.screenshot(tabId, 72);
      latestScreenshotDataUrl = shot.dataUrl;
      latestScreenshotTabId = tabId;
      latestScreenshotUrl = shot.url;
      latestScreenshotTitle = shot.title;
      return shot.base64;
    } catch {
      return undefined;
    }
  }

  async function executeBrowserCall(
    call: WsCallPayload,
    signal: AbortSignal,
  ): Promise<unknown> {
    await readyPromise;

    const botName =
      (typeof call.args.botName === "string" && call.args.botName.trim()) ||
      call.botName ||
      session.botName ||
      "ChisaBot";
    const stepLabel = humanReadableStep(call.operation, call.args);

    if (call.operation === "browser_control") {
      const action = String(call.args.action ?? "");
      if (action === "detach") {
        await detachAllAndClearHud({
          stopRemoteRun: false,
          event: { type: "detach", reason: "user_close_hud" },
        });
        return { ok: true, state: session.state };
      }
      if (action === "resume") {
        dispatchSession({ type: "resume", stepLabel });
        wakeYieldWaiters(true);
        await syncHudOnTabs(stepLabel);
        return { ok: true, state: session.state };
      }
      if (action === "focus_tab" && typeof call.args.tabId === "number") {
        const scope = checkExplicitTabScope(
          call.args.tabId,
          tabGroups.snapshot(),
        );
        if (!scope.allowed) {
          throw new Error(scope.reason ?? "禁止聚焦组外用户标签页。");
        }
        const focused = await tabGroups.focusTab(call.args.tabId);
        return { ok: focused, activeTabId: call.args.tabId };
      }
      if (action === "hud_update") {
        if (typeof call.args.botAvatar === "string") {
          activeBotAvatarUrl = call.args.botAvatar;
        }
        dispatchSession({
          type: "tool_step",
          stepLabel,
          operation: "browser_control",
        });
        await syncHudOnTabs(stepLabel);
        pushStateSnapshot();
        return { ok: true, state: session.state };
      }
      if (action === "attach") {
        tabGroups.setAttached(true);
        await tabGroups.refreshActiveTab();
        const snap = tabGroups.snapshot();
        dispatchSession({
          type: "attach",
          tabId: snap.activeTab?.tabId ?? null,
          botName,
          allowRemoteDispatch: settings.allowRemoteDispatch,
        });
        return {
          ok: true,
          state: session.state,
          activeTabId: snap.activeTab?.tabId ?? null,
          tabGroupId: snap.tabGroupId,
          tabCount: snap.controlledTabIds.length,
        };
      }
      return { ok: true, state: session.state };
    }

    if (session.killSwitched) {
      throw new Error(
        "设备当前处于紧急停止状态，请在侧边栏重新开启附着后再继续。",
      );
    }

    if (call.operation === "browser_tabs") {
      const action = String(call.args.action ?? "list");
      if (action === "new") {
        const url =
          typeof call.args.url === "string" && call.args.url.trim()
            ? call.args.url.trim()
            : "about:blank";
        if (url !== "about:blank") {
          const blocked = getBlockedUrlReason(url, settings.blockedDomains);
          if (blocked) throw new Error(blocked);
        }
        const created = await tabGroups.openTabInBotGroup(url, botName, {
          active: false,
        });
        const tabs = await tabGroups.listControlledTabs();
        return {
          tabs: tabs.map((t) => ({
            id: t.tabId,
            url: t.url,
            title: t.title,
            active: t.active,
            groupId: tabGroups.snapshot().tabGroupId ?? undefined,
          })),
          activeTabId: created.id ?? tabs[0]?.tabId ?? null,
          tabGroupId: tabGroups.snapshot().tabGroupId,
        };
      }
      if (action === "activate" && typeof call.args.tabId === "number") {
        const scope = checkExplicitTabScope(
          call.args.tabId,
          tabGroups.snapshot(),
        );
        if (!scope.allowed) {
          throw new Error(
            scope.reason ?? "安全限制：不能激活 Bot 标签组外的用户标签页。",
          );
        }
        await tabGroups.focusTab(call.args.tabId);
      } else if (action === "close" && typeof call.args.tabId === "number") {
        if (!tabGroups.isControlledTab(call.args.tabId)) {
          throw new Error("安全限制：不能关闭 Bot 标签组外的用户标签页。");
        }
        await cdp.detach(call.args.tabId);
        await api.tabs.remove(call.args.tabId);
      }
      const tabs = await tabGroups.listControlledTabs();
      return {
        tabs: tabs.map((t) => ({
          id: t.tabId,
          url: t.url,
          title: t.title,
          active: t.active,
          groupId: tabGroups.snapshot().tabGroupId ?? undefined,
        })),
        activeTabId:
          tabs.find((t) => t.active)?.tabId ?? tabs[0]?.tabId ?? null,
        tabGroupId: tabGroups.snapshot().tabGroupId,
      };
    }

    // 若当前处于真人礼让暂停态，挂起等待用户点击「继续」或中止
    if (session.state === "yielded_to_human") {
      const resumed = await waitForHumanResume(signal);
      if (!resumed || signal.aborted) {
        throw new Error("用户已停止本轮浏览器接管。");
      }
    }

    if (session.state === "detached") {
      if (!settings.allowRemoteDispatch && !tabGroups.snapshot().attached) {
        throw new Error("当前扩展未附着网页且未开启远程调度。");
      }
      dispatchSession({
        type: "attach",
        botName,
        allowRemoteDispatch: settings.allowRemoteDispatch,
      });
    }

    // 显式指定 tabId 时必须满足严格标签组/附着页隔离
    const explicitTabId = extractExplicitTabId(call.args);
    let targetTabId: number | null = null;
    let currentUrl = "";
    let currentTitle = "";

    if (call.operation === "browser_navigate") {
      const targetUrl = String(call.args.url ?? "").trim();
      let candidateTabId = resolveCandidateTabId(call.args);
      if (candidateTabId === null && explicitTabId === null) {
        await tabGroups.refreshActiveTab();
        candidateTabId = resolveCandidateTabId(call.args);
      }
      let candidateCurrentUrl: string | null = null;
      if (candidateTabId !== null) {
        try {
          const tab = await api.tabs.get(candidateTabId);
          candidateCurrentUrl = tab.url ?? tab.pendingUrl ?? null;
        } catch {
          candidateCurrentUrl = null;
        }
      }

      const plan = planSafeNavigationTarget({
        targetUrl,
        newTab: call.args.newTab === true,
        explicitTabId,
        candidateTabId,
        candidateCurrentUrl,
        tabGroupSnapshot: tabGroups.snapshot(),
        blockedDomains: settings.blockedDomains,
      });

      if (!plan.ok || plan.mode === "deny") {
        throw new Error(plan.reason || "该页面地址或目标标签页禁止导航。");
      }

      if (plan.mode === "open_new_tab") {
        // 新建空白受控标签页再导航，绝不对原黑名单标签页收组或挂接 CDP
        const created = await tabGroups.openTabInBotGroup(
          "about:blank",
          botName,
          { active: false },
        );
        if (typeof created.id !== "number") {
          throw new Error("无法创建受控标签页以完成导航。");
        }
        targetTabId = created.id;
        currentUrl = created.url ?? "about:blank";
        currentTitle = created.title ?? "";
      } else {
        targetTabId = plan.targetTabId ?? null;
      }
    } else {
      if (explicitTabId !== null) {
        const scope = checkExplicitTabScope(
          explicitTabId,
          tabGroups.snapshot(),
        );
        if (!scope.allowed) {
          throw new Error(scope.reason ?? "安全隔离：禁止访问组外标签页。");
        }
        targetTabId = explicitTabId;
      } else {
        targetTabId = resolveCandidateTabId(call.args);
        if (targetTabId === null) {
          await tabGroups.refreshActiveTab();
          targetTabId = resolveCandidateTabId(call.args);
        }
      }
    }

    if (targetTabId === null) {
      throw new Error("未找到可操作的浏览器标签页，请先在侧边栏附着一个网页。");
    }

    const currentTab = await api.tabs.get(targetTabId);
    currentUrl = currentTab.url ?? currentTab.pendingUrl ?? currentUrl;
    currentTitle = currentTab.title ?? currentTitle;

    if (call.operation !== "browser_navigate") {
      const blocked = getBlockedUrlReason(currentUrl, settings.blockedDomains);
      if (blocked) throw new Error(blocked);
    }

    // 首次开始操控时归入 Bot 彩色标签组 + 进入 controlling + 显示页内 HUD
    const grouped = await tabGroups.ensureTabInBotGroup(targetTabId, botName);
    const tabSnap = tabGroups.snapshot();
    dispatchSession({
      type: "tool_start",
      botName,
      tabId: targetTabId,
      tabGroupId: grouped.groupId,
      tabCount: tabSnap.controlledTabIds.length,
      stepLabel,
    });

    const isMutating = MUTATING_OPERATIONS.has(call.operation);
    const gate = canCompanionBotAct(session, { mutating: isMutating });
    if (!gate.allowed) {
      if (gate.reason === "snapshot_required") {
        throw new Error(
          "用户刚手动操作过页面，请先重新调用 browser_snapshot 获取最新控件快照后再执行点击或输入。",
        );
      }
      throw new Error(`当前会话状态（${gate.reason}）不允许执行浏览器操作。`);
    }

    await syncHudOnTabs(stepLabel);
    updateLiveCardProgress({
      botName,
      operation: call.operation,
      stepLabel,
      tabId: targetTabId,
      url: currentUrl,
      title: currentTitle,
      running: true,
      status: "running",
    });

    try {
      switch (call.operation) {
        case "browser_snapshot": {
          const snap = await cdp.snapshot(targetTabId);
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            tabGroupId: grouped.groupId,
            tabCount: tabGroups.snapshot().controlledTabIds.length,
            snapshotTaken: true,
            operation: "browser_snapshot",
          });
          const screenshotBase64 = await captureSilentPreview(targetTabId);
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: snap.url,
            title: snap.title,
            shotDataUrl: screenshotBase64
              ? `data:image/jpeg;base64,${screenshotBase64}`
              : undefined,
            running: true,
            status: "done",
          });
          return { ...snap, ...(screenshotBase64 ? { screenshotBase64 } : {}) };
        }

        case "browser_read": {
          const maxChars =
            typeof call.args.maxChars === "number"
              ? call.args.maxChars
              : undefined;
          const result = await cdp.read(targetTabId, maxChars);
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            operation: "browser_read",
          });
          const screenshotBase64 = await captureSilentPreview(targetTabId);
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: result.url,
            title: result.title,
            shotDataUrl: screenshotBase64
              ? `data:image/jpeg;base64,${screenshotBase64}`
              : undefined,
            running: true,
            status: "done",
          });
          return {
            ...result,
            ...(screenshotBase64 ? { screenshotBase64 } : {}),
          };
        }

        case "browser_navigate": {
          const url = String(call.args.url ?? "").trim();
          const blocked = getBlockedUrlReason(url, settings.blockedDomains);
          if (blocked) throw new Error(blocked);
          const result = await cdp.navigate(targetTabId, url);
          hudInjectedTabs.delete(targetTabId);
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            operation: "browser_navigate",
          });
          await syncHudOnTabs(stepLabel);
          const screenshotBase64 = await captureSilentPreview(targetTabId);
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: result.url,
            title: result.title,
            shotDataUrl: screenshotBase64
              ? `data:image/jpeg;base64,${screenshotBase64}`
              : undefined,
            running: true,
            status: "done",
          });
          return {
            ...result,
            ...(screenshotBase64 ? { screenshotBase64 } : {}),
          };
        }

        case "browser_click": {
          const snapshotId = Number(call.args.snapshotId);
          const ref = String(call.args.ref ?? "");
          const result = await cdp.click(targetTabId, snapshotId, ref);
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            operation: "browser_click",
          });
          const screenshotBase64 = await captureSilentPreview(targetTabId);
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: result.url,
            title: result.title,
            shotDataUrl: screenshotBase64
              ? `data:image/jpeg;base64,${screenshotBase64}`
              : undefined,
            running: true,
            status: "done",
          });
          return {
            ...result,
            ...(screenshotBase64 ? { screenshotBase64 } : {}),
          };
        }

        case "browser_hover": {
          const hasRef =
            typeof call.args.ref === "string" &&
            call.args.ref.trim().length > 0 &&
            typeof call.args.snapshotId === "number";
          const result = hasRef
            ? await cdp.hover(
                targetTabId,
                Number(call.args.snapshotId),
                String(call.args.ref),
              )
            : await cdp.hoverAt(
                targetTabId,
                Number(call.args.x ?? 640),
                Number(call.args.y ?? 360),
              );
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            operation: "browser_hover",
          });
          const screenshotBase64 = await captureSilentPreview(targetTabId);
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: result.url,
            title: result.title,
            shotDataUrl: screenshotBase64
              ? `data:image/jpeg;base64,${screenshotBase64}`
              : undefined,
            running: true,
            status: "done",
          });
          return {
            ...result,
            ...(screenshotBase64 ? { screenshotBase64 } : {}),
          };
        }

        case "browser_type": {
          const snapshotId = Number(call.args.snapshotId);
          const ref = String(call.args.ref ?? "");
          const text = String(call.args.text ?? "");
          const submit = call.args.submit === true;
          const result = await cdp.type(
            targetTabId,
            snapshotId,
            ref,
            text,
            submit,
          );
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            operation: "browser_type",
          });
          const screenshotBase64 = await captureSilentPreview(targetTabId);
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: result.url,
            title: result.title,
            shotDataUrl: screenshotBase64
              ? `data:image/jpeg;base64,${screenshotBase64}`
              : undefined,
            running: true,
            status: "done",
          });
          return {
            ...result,
            ...(screenshotBase64 ? { screenshotBase64 } : {}),
          };
        }

        case "browser_key": {
          const rawKey = String(call.args.key ?? "");
          const snapshotId =
            typeof call.args.snapshotId === "number"
              ? call.args.snapshotId
              : undefined;
          const ref =
            typeof call.args.ref === "string" ? call.args.ref : undefined;
          const result = await cdp.key(targetTabId, rawKey, snapshotId, ref);
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            operation: "browser_key",
          });
          const screenshotBase64 = await captureSilentPreview(targetTabId);
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: result.url,
            title: result.title,
            shotDataUrl: screenshotBase64
              ? `data:image/jpeg;base64,${screenshotBase64}`
              : undefined,
            running: true,
            status: "done",
          });
          return {
            ...result,
            ...(screenshotBase64 ? { screenshotBase64 } : {}),
          };
        }

        case "browser_scroll": {
          const deltaY =
            typeof call.args.deltaY === "number" ? call.args.deltaY : 540;
          const deltaX =
            typeof call.args.deltaX === "number" ? call.args.deltaX : 0;
          const result = await cdp.scroll(targetTabId, deltaY, deltaX);
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            operation: "browser_scroll",
          });
          const screenshotBase64 = await captureSilentPreview(targetTabId);
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: result.url,
            title: result.title,
            shotDataUrl: screenshotBase64
              ? `data:image/jpeg;base64,${screenshotBase64}`
              : undefined,
            running: true,
            status: "done",
          });
          return {
            ...result,
            ...(screenshotBase64 ? { screenshotBase64 } : {}),
          };
        }

        case "browser_screenshot": {
          const quality =
            typeof call.args.quality === "number" ? call.args.quality : 78;
          const shot = await cdp.screenshot(targetTabId, quality);
          dispatchSession({
            type: "tool_step",
            stepLabel,
            tabId: targetTabId,
            operation: "browser_screenshot",
          });
          updateLiveCardProgress({
            botName,
            operation: call.operation,
            stepLabel,
            tabId: targetTabId,
            url: shot.url,
            title: shot.title,
            shotDataUrl: shot.dataUrl,
            running: true,
            status: "done",
          });
          return {
            base64: shot.base64,
            mimeType: shot.mimeType,
            width: shot.width,
            height: shot.height,
            tabId: shot.tabId,
            url: shot.url,
            title: shot.title,
            capturedAt: shot.capturedAt,
          };
        }

        default:
          throw new Error(`不支持的浏览器扩展指令：${call.operation}`);
      }
    } catch (error) {
      updateLiveCardProgress({
        botName,
        operation: call.operation,
        stepLabel,
        tabId: targetTabId,
        running: false,
        status: "error",
      });
      throw error;
    }
  }

  const wsClient = createCompanionWsClient({
    getAuth: () => auth,
    getClientVersion: getExtensionVersion,
    getCompanionState: buildCompanionStateReport,
    createWebSocket: deps.createWebSocket,
    evaluateLocalRisk: async (call) => {
      await readyPromise;
      const explicitTabId = extractExplicitTabId(call.args);
      const candidateTabId = resolveCandidateTabId(call.args);
      const targetUrl =
        typeof call.args.url === "string" ? call.args.url : undefined;
      let currentTabUrl: string | undefined;

      if (candidateTabId !== null) {
        try {
          const tab = await api.tabs.get(candidateTabId);
          currentTabUrl = tab.url ?? tab.pendingUrl;
        } catch {
          // 忽略读取失败
        }
      }
      const element =
        candidateTabId !== null &&
        typeof call.args.snapshotId === "number" &&
        typeof call.args.ref === "string"
          ? cdp.lookupElement(
              candidateTabId,
              call.args.snapshotId,
              call.args.ref,
            )
          : null;

      return evaluateLocalCallRisk({
        tier: settings.tier,
        operation: call.operation,
        action:
          typeof call.args.action === "string" ? call.args.action : undefined,
        targetUrl,
        currentTabUrl,
        explicitTabId,
        element,
        key: typeof call.args.key === "string" ? call.args.key : undefined,
        submit: call.args.submit === true,
        blockedDomains: settings.blockedDomains,
      });
    },
    onCall: executeBrowserCall,
    onCompanionCommand: (cmd) => {
      void readyPromise.then(() => {
        if (cmd.command === "kill_switch") {
          void detachAllAndClearHud({
            stopRemoteRun: true,
            event: { type: "kill_switch" },
          });
          return;
        }
        if (cmd.command === "detach") {
          void detachAllAndClearHud({
            stopRemoteRun: false,
            event: { type: "detach", reason: "user_close_hud" },
          });
          return;
        }
        if (cmd.command === "pause") {
          yieldNotice = cmd.reason || "服务端已暂停浏览器操控";
          dispatchSession({ type: "human_input", reason: yieldNotice });
          void syncHudOnTabs();
          return;
        }
        if (cmd.command === "resume") {
          dispatchSession({ type: "resume" });
          wakeYieldWaiters(true);
          void syncHudOnTabs();
          return;
        }
        if (cmd.command === "focus_tab" && typeof cmd.tabId === "number") {
          const scope = checkExplicitTabScope(cmd.tabId, tabGroups.snapshot());
          if (scope.allowed) {
            void tabGroups.focusTab(cmd.tabId);
          }
          return;
        }
        if (cmd.command === "sync_config" && cmd.config) {
          settings = normalizeSettings({
            ...settings,
            ...(cmd.config.tier ? { tier: cmd.config.tier } : {}),
            ...(cmd.config.blockedDomains
              ? { blockedDomains: cmd.config.blockedDomains }
              : {}),
            ...(typeof cmd.config.allowRemoteDispatch === "boolean"
              ? { allowRemoteDispatch: cmd.config.allowRemoteDispatch }
              : {}),
          });
          void storage.saveSettings(settings);
          pushStateSnapshot();
        }
      });
    },
    onStateChange: (nextState, error) => {
      wsState = nextState;
      wsError = error;
      if (nextState === "offline" && session.state === "controlling") {
        void detachAllAndClearHud({
          stopRemoteRun: false,
          event: { type: "remote_disconnect" },
        });
      }
      pushStateSnapshot();
    },
    onApprovalRequest: (item) => {
      pendingApprovals = [
        ...pendingApprovals.filter((a) => a.id !== item.id),
        item,
      ];
      dispatchSession({
        type: "approval_requested",
        approval: {
          approvalId: item.id,
          operation: (item.operation ||
            "browser_click") as BrowserCompanionOperation,
          summary: item.summary,
          category: item.locked ? "purchase" : "high_risk",
          locked: item.locked,
        },
        stepLabel: item.summary,
      });
      void syncHudOnTabs(item.summary);
      pushStateSnapshot();
    },
    onApprovalClosed: (id, decision) => {
      pendingApprovals = pendingApprovals.filter((a) => a.id !== id);
      if (session.state === "awaiting_approval") {
        dispatchSession({
          type: "approval_resolved",
          approvalId: id,
          approved: decision === "approve",
        });
        void syncHudOnTabs();
      }
      pushStateSnapshot();
    },
    onRemoteConfig: (device) => {
      if (device.paused === true) {
        void detachAllAndClearHud({
          stopRemoteRun: true,
          event: { type: "kill_switch" },
        });
      }
    },
    onRevoked: () => {
      void detachAllAndClearHud({
        stopRemoteRun: false,
        event: { type: "remote_disconnect" },
      });
      pushStateSnapshot();
    },
  });

  // ---- 顶层同步注册 Action / Port / Runtime 监听器（零 await 前置，MV3 唤醒不丢事件） ----

  const handleActionClick = (tab: { windowId?: number }) => {
    if (typeof tab.windowId === "number") {
      void api.sidePanel?.open({ windowId: tab.windowId }).catch(() => {});
    }
  };
  api.action?.onClicked.addListener(handleActionClick);

  const handleConnect = (port: ChromePort) => {
    if (port.name !== "sidepanel") return;
    panelPorts.add(port);

    port.onDisconnect.addListener(() => {
      panelPorts.delete(port);
      if (panelPorts.size === 0 && cdp.getAttachedTabIds().length > 0) {
        void detachAllAndClearHud({
          stopRemoteRun: false,
          event: { type: "detach", reason: "sidepanel_closed" },
        });
      }
    });

    void readyPromise
      .then(() => tabGroups.refreshActiveTab())
      .then(() => {
        if (!panelPorts.has(port)) return;
        port.postMessage({
          type: "STATE_SNAPSHOT",
          state: buildRuntimeState(),
        } satisfies PanelPushMessage);
        if (liveCard) {
          port.postMessage({
            type: "LIVE_CARD_UPDATE",
            card: liveCard,
          } satisfies PanelPushMessage);
        }
      })
      .catch(() => {});
  };
  api.runtime.onConnect.addListener(handleConnect);

  const handleRuntimeMessage = (
    rawMessage: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    const msg = rawMessage as (HudOutboundMessage | PanelRequestMessage) | null;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return undefined;
    }

    const handleAsync = async (): Promise<unknown> => {
      await readyPromise;

      switch (msg.type) {
        case "HUD_HUMAN_INTERVENTION": {
          yieldNotice = "检测到你在操作页面，已自动礼让暂停";
          dispatchSession({ type: "human_input", reason: yieldNotice });
          await syncHudOnTabs();
          return { ok: true };
        }
        case "HUD_USER_RESUME":
        case "PANEL_RESUME_CONTROL": {
          dispatchSession({ type: "resume" });
          wakeYieldWaiters(true);
          await syncHudOnTabs();
          return { ok: true };
        }
        case "HUD_USER_ABORT":
        case "PANEL_ABORT_CONTROL": {
          await detachAllAndClearHud({
            stopRemoteRun: true,
            event: { type: "detach", reason: "user_close_hud" },
          });
          return { ok: true };
        }
        case "PANEL_GET_STATE": {
          await tabGroups.refreshActiveTab();
          return { ok: true, state: buildRuntimeState() };
        }
        case "PANEL_DETECT_TABS": {
          const tabs = await authService.detectSignedInChisaBotTabs();
          return { ok: true, tabs };
        }
        case "PANEL_CLAIM_TAB": {
          const nextAuth = await authService.claimFromChisaBotTab(
            msg.tabId,
            msg.origin,
          );
          auth = nextAuth;
          await storage.saveAuth(nextAuth);
          dispatchSession({
            type: "attach",
            deviceId: nextAuth.deviceId,
            allowRemoteDispatch: settings.allowRemoteDispatch,
          });
          wsClient.start();
          pushStateSnapshot();
          return { ok: true, auth: nextAuth };
        }
        case "PANEL_LOGIN_PASSWORD": {
          const nextAuth = await authService.loginWithPassword({
            serverUrl: msg.serverUrl,
            username: msg.username,
            password: msg.password,
            remember: msg.remember,
          });
          auth = nextAuth;
          await storage.saveAuth(nextAuth);
          dispatchSession({
            type: "attach",
            deviceId: nextAuth.deviceId,
            allowRemoteDispatch: settings.allowRemoteDispatch,
          });
          wsClient.start();
          pushStateSnapshot();
          return { ok: true, auth: nextAuth };
        }
        case "PANEL_LOGIN_PAIRING": {
          const nextAuth = await authService.loginWithPairingCode({
            serverUrl: msg.serverUrl,
            code: msg.code,
          });
          auth = nextAuth;
          await storage.saveAuth(nextAuth);
          dispatchSession({
            type: "attach",
            deviceId: nextAuth.deviceId,
            allowRemoteDispatch: settings.allowRemoteDispatch,
          });
          wsClient.start();
          pushStateSnapshot();
          return { ok: true, auth: nextAuth };
        }
        case "PANEL_LOGOUT": {
          const old = auth;
          await detachAllAndClearHud({
            stopRemoteRun: true,
            event: { type: "detach", reason: "user_toggle_off" },
          });
          wsClient.stop();
          auth = null;
          activeThreadId = null;
          pendingApprovals = [];
          liveCard = null;
          await storage.saveAuth(null);
          if (old) {
            await authService.unenroll(old);
          }
          pushStateSnapshot();
          return { ok: true };
        }
        case "PANEL_SET_ATTACHED": {
          tabGroups.setAttached(msg.attached);
          if (!msg.attached) {
            await detachAllAndClearHud({
              stopRemoteRun: false,
              event: { type: "detach", reason: "user_toggle_off" },
            });
          } else {
            await tabGroups.refreshActiveTab();
            dispatchSession({
              type: "attach",
              tabId: tabGroups.snapshot().activeTab?.tabId ?? null,
              allowRemoteDispatch: settings.allowRemoteDispatch,
            });
          }
          return { ok: true };
        }
        case "PANEL_FOCUS_TAB": {
          const ok = await tabGroups.focusTab(msg.tabId);
          return { ok };
        }
        case "PANEL_UPDATE_SETTINGS": {
          settings = normalizeSettings({
            ...settings,
            ...msg.patch,
            appearance: msg.patch.appearance
              ? { ...settings.appearance, ...msg.patch.appearance }
              : settings.appearance,
          });
          await storage.saveSettings(settings);
          dispatchSession({
            type: "attach",
            allowRemoteDispatch: settings.allowRemoteDispatch,
          });
          pushStateSnapshot();
          if (auth) {
            await companionApi
              .updateSettings(auth, {
                tier: settings.tier,
                blockedDomains: settings.blockedDomains,
                allowRemoteDispatch: settings.allowRemoteDispatch,
                attachedTabId: tabGroups.snapshot().activeTab?.tabId ?? null,
                tabGroupId: tabGroups.snapshot().tabGroupId,
              })
              .catch(() => {});
          }
          return { ok: true, settings };
        }
        case "PANEL_SELECT_BOT": {
          activeBotAvatarUrl = msg.botAvatarUrl ?? null;
          settings = normalizeSettings({
            ...settings,
            selectedBotId: msg.botId,
          });
          await storage.saveSettings(settings);
          dispatchSession({
            type: "attach",
            botId: msg.botId,
            botName: msg.botName,
          });
          pushStateSnapshot();
          return { ok: true };
        }
        case "PANEL_DECIDE_APPROVAL": {
          const target = pendingApprovals.find((a) => a.id === msg.id);
          if (target?.source === "ws") {
            wsClient.sendApprovalDecision(msg.id, msg.decision);
          }
          if (auth) {
            await companionApi
              .decideApproval(auth, msg.id, msg.decision)
              .catch(() => {});
          }
          pendingApprovals = pendingApprovals.filter((a) => a.id !== msg.id);
          if (session.state === "awaiting_approval") {
            dispatchSession({
              type: "approval_resolved",
              approvalId: msg.id,
              approved: msg.decision === "approve",
            });
            await syncHudOnTabs();
          }
          pushStateSnapshot();
          return { ok: true };
        }
        case "PANEL_BOOTSTRAP": {
          if (!auth) return { ok: false, error: "尚未登录。" };
          const data = await companionApi.bootstrap(auth);
          if (data.user.name || data.user.email) {
            auth = {
              ...auth,
              userId: data.user.id || auth.userId,
              userName: data.user.name ?? auth.userName,
              userEmail: data.user.email ?? auth.userEmail,
            };
            await storage.saveAuth(auth);
          }
          if (data.companionConfig || data.appearance) {
            settings = normalizeSettings({
              ...settings,
              ...(data.companionConfig?.tier
                ? { tier: data.companionConfig.tier }
                : {}),
              ...(Array.isArray(data.companionConfig?.blockedDomains)
                ? { blockedDomains: data.companionConfig.blockedDomains }
                : {}),
              ...(typeof data.companionConfig?.allowRemoteDispatch === "boolean"
                ? {
                    allowRemoteDispatch:
                      data.companionConfig.allowRemoteDispatch,
                  }
                : {}),
              ...(data.appearance
                ? { appearance: { ...settings.appearance, ...data.appearance } }
                : {}),
            });
            await storage.saveSettings(settings);
          }
          if (data.pendingApprovals && data.pendingApprovals.length > 0) {
            const existing = new Map(pendingApprovals.map((a) => [a.id, a]));
            for (const item of data.pendingApprovals) {
              existing.set(item.id, item);
            }
            pendingApprovals = [...existing.values()];
          }
          pushStateSnapshot();
          return { ok: true, data };
        }
        case "PANEL_OPEN_THREAD": {
          if (!auth) return { ok: false, error: "尚未登录。" };
          if (msg.fresh === true) {
            activeThreadId = null;
            liveCard = null;
          }
          const thread = await companionApi.openThread(auth, {
            botId: msg.botId,
            ...(msg.channelId && msg.fresh !== true
              ? { threadId: msg.channelId }
              : {}),
            ...(msg.fresh === true ? { fresh: true } : {}),
          });
          activeThreadId = thread.threadId || thread.channelId || null;
          return { ok: true, thread };
        }
        case "PANEL_SEND_MESSAGE": {
          if (!auth) return { ok: false, error: "尚未登录。" };
          activeChatAbort?.abort();
          const controller = new AbortController();
          activeChatAbort = controller;
          currentPhaseBadge = msg.text.slice(0, 14);
          liveCard = null;
          const snap = tabGroups.snapshot();
          const targetThreadId = msg.channelId || activeThreadId || undefined;
          const channelKey = targetThreadId || msg.botId;

          void companionApi
            .sendMessageStream(
              auth,
              {
                botId: msg.botId,
                threadId: targetThreadId,
                text: msg.text,
                attached: snap.attached && session.attached,
                attachedTab: snap.activeTab,
              },
              (event) => {
                if (typeof event.threadId === "string" && event.threadId) {
                  activeThreadId = event.threadId;
                }
                broadcastToPanels({
                  type: "CHAT_STREAM_EVENT",
                  channelId: channelKey,
                  event,
                });
              },
              controller.signal,
            )
            .catch((error) => {
              if (controller.signal.aborted) return;
              broadcastToPanels({
                type: "CHAT_STREAM_EVENT",
                channelId: channelKey,
                event: {
                  type: "RUN_ERROR",
                  message:
                    error instanceof Error ? error.message : "发送消息失败。",
                },
              });
            })
            .finally(() => {
              if (activeChatAbort === controller) {
                activeChatAbort = null;
              }
              if (liveCard) {
                liveCard = { ...liveCard, running: false };
                broadcastToPanels({ type: "LIVE_CARD_UPDATE", card: liveCard });
              }
              if (session.state === "controlling") {
                dispatchSession({ type: "turn_complete" });
                void syncHudOnTabs();
              }
            });

          return { ok: true };
        }
        case "PANEL_STOP_RUN": {
          activeChatAbort?.abort();
          activeChatAbort = null;
          if (auth) {
            await companionApi.stopRun(auth, {
              threadId: msg.channelId || activeThreadId || undefined,
              detach: false,
            });
          }
          if (liveCard) {
            liveCard = { ...liveCard, running: false };
            broadcastToPanels({ type: "LIVE_CARD_UPDATE", card: liveCard });
          }
          return { ok: true };
        }
        case "PANEL_OPEN_VOICE": {
          if (!auth) return { ok: false, error: "尚未登录。" };
          const botQuery = msg.botId
            ? `?agent=${encodeURIComponent(msg.botId)}&voice=1`
            : "?voice=1";
          await api.tabs.create({
            url: `${auth.serverUrl}/channel/new${botQuery}`,
            active: true,
          });
          return { ok: true };
        }
        default:
          return { ok: false, error: "未知消息类型。" };
      }
    };

    void handleAsync()
      .then((res) => sendResponse(res))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  };
  api.runtime.onMessage.addListener(handleRuntimeMessage);

  // ---- 后台异步恢复状态（不阻塞上述同步监听器注册） ----

  const readyPromise = (async () => {
    const [loadedAuth, loadedSettings] = await Promise.all([
      storage.loadAuth().catch(() => null),
      storage.loadSettings().catch(() => defaultSettings()),
    ]);
    auth = loadedAuth;
    settings = loadedSettings;
    tabGroups.setAttached(settings.attachedByDefault);
    session = createInitialBrowserCompanionSession({
      sessionId: session.sessionId,
      deviceId: auth?.deviceId ?? null,
      botId: settings.selectedBotId,
      botName: session.botName ?? "ChisaBot",
      attached: settings.attachedByDefault,
      allowRemoteDispatch: settings.allowRemoteDispatch,
      updatedAt: Date.now(),
    });

    try {
      await api.sidePanel?.setPanelBehavior?.({
        openPanelOnActionClick: true,
      });
    } catch {
      // 某些旧版 Chromium 回退至 action.onClicked
    }

    await tabGroups.refreshActiveTab();
    if (auth) {
      wsClient.start();
    }
    pushStateSnapshot();
  })();

  function dispose() {
    wsClient.stop();
    tabGroups.dispose();
    cdp.dispose();
    api.action?.onClicked.removeListener(handleActionClick);
    api.runtime.onConnect.removeListener(handleConnect);
    api.runtime.onMessage.removeListener(handleRuntimeMessage);
  }

  return {
    readyPromise,
    dispose,
    getRuntimeState: buildRuntimeState,
    getActiveThreadId: () => activeThreadId,
  };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  initializeBackgroundRuntime();
}
