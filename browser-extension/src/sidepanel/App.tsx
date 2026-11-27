import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CompanionBootstrapResponse,
  CompanionThreadResponse,
} from "../background/companion-api";
import { defaultSettings } from "../background/storage";
import type { ChromePort } from "../types/chrome";
import type {
  AppearancePrefs,
  BotSummary,
  BrowserLiveCardState,
  ChatMessageItem,
  CompanionLocalSettings,
  CompanionRuntimeState,
  DetectedChisaBotTab,
  PanelPushMessage,
  PanelRequestMessage,
  ThreadSummary,
} from "../types/protocol";
import { ApprovalCard } from "./components/ApprovalCard";
import { BotDrawer } from "./components/BotDrawer";
import { BrowserLiveCard } from "./components/BrowserLiveCard";
import { ChatComposer } from "./components/ChatComposer";
import { LoginView } from "./components/LoginView";
import { SettingsPopover } from "./components/SettingsPopover";
import { TopBar } from "./components/TopBar";
import { SimpleMarkdown } from "./markdown";

const INITIAL_RUNTIME: CompanionRuntimeState = {
  auth: null,
  wsState: "offline",
  wsError: null,
  sessionState: "idle",
  attached: true,
  activeTab: null,
  controlledTabIds: [],
  tabGroupId: null,
  tabGroupBotName: null,
  activeBotId: null,
  activeBotName: "ChisaBot",
  activeBotAvatarUrl: null,
  currentStepLabel: null,
  currentPhaseBadge: null,
  latestScreenshotDataUrl: null,
  latestScreenshotTabId: null,
  latestScreenshotUrl: null,
  latestScreenshotTitle: null,
  yieldReason: null,
  yieldReasonCode: null,
  pendingApprovals: [],
  settings: defaultSettings(),
};

const QUICK_PROMPTS = [
  "总结当前网页的核心内容",
  "检查这个页面上的异常或告警",
  "帮我提取当前页面的关键数据表格",
];

function applyAppearanceToDocument(appearance: AppearancePrefs) {
  const root = document.documentElement;
  root.setAttribute("data-theme", appearance.theme);
  root.setAttribute("data-material", appearance.material);

  const prefersDark =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark =
    appearance.colorMode === "dark" ||
    (appearance.colorMode === "system" && prefersDark);
  root.classList.toggle("dark", isDark);
}

async function rpc<T = { ok: boolean; error?: string }>(
  message: PanelRequestMessage,
): Promise<T> {
  return chrome.runtime.sendMessage<T>(message);
}

function normalizeHistoryMessages(
  rawMessages: Array<Record<string, unknown>>,
): ChatMessageItem[] {
  const out: ChatMessageItem[] = [];
  for (let i = 0; i < rawMessages.length; i += 1) {
    const item = rawMessages[i];
    if (!item) continue;
    const roleRaw = String(item.role ?? "");
    if (roleRaw !== "user" && roleRaw !== "assistant") continue;
    let content = "";
    if (typeof item.content === "string") {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      content = item.content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) {
            return String((part as { text?: unknown }).text ?? "");
          }
          return "";
        })
        .join("");
    }
    if (!content.trim()) continue;
    out.push({
      id:
        typeof item.id === "string" && item.id
          ? item.id
          : `hist-${roleRaw}-${i}-${content.slice(0, 8)}`,
      role: roleRaw,
      content,
      createdAt:
        typeof item.createdAt === "string"
          ? item.createdAt
          : new Date().toISOString(),
    });
  }
  return out;
}

export function App() {
  const [runtime, setRuntime] =
    useState<CompanionRuntimeState>(INITIAL_RUNTIME);
  const [detectedTabs, setDetectedTabs] = useState<DetectedChisaBotTab[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selectedBot, setSelectedBot] = useState<BotSummary | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [liveCard, setLiveCard] = useState<BrowserLiveCardState | null>(null);
  const [running, setRunning] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const bootstrappedRef = useRef<string | null>(null);

  const refreshDetectedTabs = useCallback(async () => {
    setDetecting(true);
    try {
      const resp = await rpc<{ ok: boolean; tabs?: DetectedChisaBotTab[] }>({
        type: "PANEL_DETECT_TABS",
      });
      if (resp.ok && Array.isArray(resp.tabs)) {
        setDetectedTabs(resp.tabs);
      }
    } finally {
      setDetecting(false);
    }
  }, []);

  const openBotThread = useCallback(
    async (bot: BotSummary, channelId?: string) => {
      setSelectedBot(bot);
      await rpc({
        type: "PANEL_SELECT_BOT",
        botId: bot.id,
        botName: bot.name,
        botAvatarUrl: bot.avatarUrl ?? null,
      });
      const resp = await rpc<{
        ok: boolean;
        thread?: CompanionThreadResponse;
      }>({
        type: "PANEL_OPEN_THREAD",
        botId: bot.id,
        ...(channelId ? { channelId } : {}),
      });
      if (resp.ok && resp.thread) {
        setActiveThreadId(resp.thread.threadId || resp.thread.channelId);
        setThreads(resp.thread.history ?? []);
        setMessages(normalizeHistoryMessages(resp.thread.messages ?? []));
        setRunning(resp.thread.running);
      }
    },
    [],
  );

  const loadBootstrap = useCallback(async () => {
    const resp = await rpc<{
      ok: boolean;
      data?: CompanionBootstrapResponse;
    }>({ type: "PANEL_BOOTSTRAP" });
    if (!resp.ok || !resp.data) return;
    const list = resp.data.bots;
    setBots(list);
    const chosen =
      list.find((b) => b.id === runtime.settings.selectedBotId) ??
      list.find((b) => b.id === resp.data?.defaultBotId) ??
      list[0] ??
      null;
    if (chosen) {
      await openBotThread(chosen);
    }
  }, [openBotThread, runtime.settings.selectedBotId]);

  const handleStreamEvent = useCallback((event: Record<string, unknown>) => {
    const type = String(event.type ?? "");
    if (type === "TEXT_MESSAGE_CONTENT") {
      const delta = String(event.delta ?? "");
      const msgId = String(event.messageId ?? `assistant-${Date.now()}`);
      if (!delta) return;
      setMessages((prev) => {
        const existingIdx = prev.findIndex((m) => m.id === msgId);
        if (existingIdx >= 0) {
          return prev.map((m, idx) =>
            idx === existingIdx
              ? { ...m, content: m.content + delta, streaming: true }
              : m,
          );
        }
        return [
          ...prev,
          {
            id: msgId,
            role: "assistant",
            content: delta,
            createdAt: new Date().toISOString(),
            streaming: true,
          },
        ];
      });
      return;
    }

    if (type === "TEXT_MESSAGE_END") {
      const msgId = String(event.messageId ?? "");
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, streaming: false } : m)),
      );
      return;
    }

    if (type === "RUN_FINISHED") {
      setRunning(false);
      setMessages((prev) => prev.map((m) => ({ ...m, streaming: false })));
      return;
    }

    if (type === "RUN_ERROR") {
      setRunning(false);
      const errMsg = String(event.message ?? "执行出错，请稍后重试。");
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: errMsg,
          createdAt: new Date().toISOString(),
          error: errMsg,
        },
      ]);
    }
  }, []);

  // 建立与 Service Worker 的长连接，接收状态同步与实时事件
  useEffect(() => {
    let port: ChromePort | null = null;
    try {
      port = chrome.runtime.connect({ name: "sidepanel" });
    } catch {
      return undefined;
    }

    const onMessage = (raw: unknown) => {
      const msg = raw as PanelPushMessage | null;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "STATE_SNAPSHOT") {
        setRuntime(msg.state);
      } else if (msg.type === "LIVE_CARD_UPDATE") {
        setLiveCard(msg.card);
      } else if (msg.type === "CHAT_STREAM_EVENT") {
        handleStreamEvent(msg.event);
      }
    };

    port.onMessage.addListener(onMessage);
    void rpc<{ ok: boolean; state?: CompanionRuntimeState }>({
      type: "PANEL_GET_STATE",
    }).then((res) => {
      if (res.ok && res.state) setRuntime(res.state);
    });

    return () => {
      port?.onMessage.removeListener(onMessage);
      port?.disconnect();
    };
  }, [handleStreamEvent]);

  // 应用 ChisaBot 六套主题 × 深浅色 × 三档材质
  useEffect(() => {
    applyAppearanceToDocument(runtime.settings.appearance);
    const mq =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    if (!mq || runtime.settings.appearance.colorMode !== "system") {
      return undefined;
    }
    const listener = () =>
      applyAppearanceToDocument(runtime.settings.appearance);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, [runtime.settings.appearance]);

  // 未登录时探测已打开的 ChisaBot 标签；已登录时自动拉取 bootstrap
  useEffect(() => {
    if (!runtime.auth) {
      bootstrappedRef.current = null;
      void refreshDetectedTabs();
      return;
    }
    const tokenKey = `${runtime.auth.serverUrl}:${runtime.auth.deviceId}`;
    if (bootstrappedRef.current === tokenKey) return;
    bootstrappedRef.current = tokenKey;
    void loadBootstrap();
  }, [runtime.auth, loadBootstrap, refreshDetectedTabs]);

  // 新消息或实时进度变化时自动贴底（使用 instant 禁止平滑滚抖动）
  const scrollSignal = `${messages.length}:${liveCard?.stepLabel ?? ""}:${runtime.pendingApprovals.length}`;
  useEffect(() => {
    if (!scrollSignal) return;
    feedEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [scrollSignal]);

  const handleSend = useCallback(
    async (text: string) => {
      const botId = selectedBot?.id ?? bots[0]?.id;
      if (!botId) return;
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: text,
          createdAt: new Date().toISOString(),
        },
      ]);
      setRunning(true);
      await rpc({
        type: "PANEL_SEND_MESSAGE",
        botId,
        ...(activeThreadId ? { channelId: activeThreadId } : {}),
        text,
      });
    },
    [selectedBot, bots, activeThreadId],
  );

  const handleStop = useCallback(async () => {
    const botId = selectedBot?.id ?? bots[0]?.id ?? "";
    setRunning(false);
    await rpc({
      type: "PANEL_STOP_RUN",
      botId,
      ...(activeThreadId ? { channelId: activeThreadId } : {}),
    });
  }, [selectedBot, bots, activeThreadId]);

  const handleUpdateSettings = useCallback(
    (patch: Partial<CompanionLocalSettings>) => {
      setRuntime((prev) => ({
        ...prev,
        settings: {
          ...prev.settings,
          ...patch,
          appearance: patch.appearance
            ? { ...prev.settings.appearance, ...patch.appearance }
            : prev.settings.appearance,
        },
      }));
      void rpc({ type: "PANEL_UPDATE_SETTINGS", patch });
    },
    [],
  );

  const handleOpenTab = useCallback((tabId?: number, url?: string) => {
    if (typeof tabId === "number") {
      void rpc({ type: "PANEL_FOCUS_TAB", tabId });
      return;
    }
    if (url && /^https?:\/\//i.test(url)) {
      void chrome.tabs.create({ url, active: true });
    }
  }, []);

  if (!runtime.auth) {
    return (
      <div className="sp-shell">
        <LoginView
          detectedTabs={detectedTabs}
          detecting={detecting}
          onRefreshDetect={() => void refreshDetectedTabs()}
          onClaimTab={async (tab) => {
            const resp = await rpc<{ ok: boolean; error?: string }>({
              type: "PANEL_CLAIM_TAB",
              tabId: tab.tabId,
              origin: tab.origin,
            });
            if (!resp.ok) throw new Error(resp.error || "免密认领失败。");
          }}
          onLoginPassword={async (input) => {
            const resp = await rpc<{ ok: boolean; error?: string }>({
              type: "PANEL_LOGIN_PASSWORD",
              ...input,
            });
            if (!resp.ok) throw new Error(resp.error || "账号密码登录失败。");
          }}
          onLoginPairing={async (input) => {
            const resp = await rpc<{ ok: boolean; error?: string }>({
              type: "PANEL_LOGIN_PAIRING",
              ...input,
            });
            if (!resp.ok) throw new Error(resp.error || "配对码绑定失败。");
          }}
        />
      </div>
    );
  }

  const botName = selectedBot?.name || runtime.activeBotName || "ChisaBot";
  const liveStripLabel =
    runtime.currentStepLabel || (liveCard?.running ? liveCard.stepLabel : null);

  return (
    <div className="sp-shell">
      <TopBar
        runtime={runtime}
        botName={botName}
        onOpenDrawer={() => setDrawerOpen(true)}
        onOpenVoice={() =>
          void rpc({ type: "PANEL_OPEN_VOICE", botId: selectedBot?.id })
        }
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {runtime.sessionState === "yielded_to_human" ? (
        <div className="sp-yield-banner" role="status">
          <span>
            {runtime.yieldReason || `已暂停接管，完成操作后可交还给 ${botName}`}
          </span>
          <div className="sp-yield-actions">
            <button
              type="button"
              className="sp-btn sp-btn-primary sp-btn-sm"
              onClick={() => void rpc({ type: "PANEL_RESUME_CONTROL" })}
            >
              继续交给 {botName}
            </button>
            <button
              type="button"
              className="sp-btn sp-btn-sm"
              onClick={() => void rpc({ type: "PANEL_ABORT_CONTROL" })}
            >
              结束接管
            </button>
          </div>
        </div>
      ) : null}

      <main className="sp-feed">
        {messages.length === 0 && !liveCard ? (
          <section className="sp-empty" data-surface="panel">
            <div className="sp-empty-avatar">
              {selectedBot?.avatarUrl ? (
                <img src={selectedBot.avatarUrl} alt={botName} />
              ) : (
                botName.slice(0, 1)
              )}
            </div>
            <h2 className="sp-empty-title">你好，我是 {botName}</h2>
            <p className="sp-empty-desc">
              {runtime.attached
                ? "已附着当前浏览器页面。直接提问，我会在专属标签组中与你协作浏览。"
                : "当前未附着网页。打开下方附着开关即可让我读取或操作当前标签页。"}
            </p>
            <div className="sp-quick-prompts">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="sp-quick-chip"
                  data-surface="control"
                  onClick={() => void handleSend(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {messages.map((msg) => (
          <div key={msg.id} className="sp-msg-row" data-role={msg.role}>
            {msg.role === "user" ? (
              <div className="sp-bubble sp-bubble-user">{msg.content}</div>
            ) : (
              <div
                className={`sp-bubble${msg.error ? " sp-bubble-error" : ""}`}
                data-surface="bubble"
              >
                <SimpleMarkdown content={msg.content} />
              </div>
            )}
          </div>
        ))}

        {liveCard ? (
          <BrowserLiveCard card={liveCard} onOpenTab={handleOpenTab} />
        ) : null}

        {runtime.pendingApprovals.map((item) => (
          <ApprovalCard
            key={item.id}
            item={item}
            onDecide={async (id, decision) => {
              await rpc({ type: "PANEL_DECIDE_APPROVAL", id, decision });
            }}
          />
        ))}

        <div ref={feedEndRef} />
      </main>

      <ChatComposer
        attached={runtime.attached}
        activeTab={runtime.activeTab}
        running={running}
        liveStepLabel={liveStripLabel}
        disabled={runtime.wsState === "revoked"}
        onToggleAttached={() =>
          void rpc({ type: "PANEL_SET_ATTACHED", attached: !runtime.attached })
        }
        onSend={(text) => void handleSend(text)}
        onStop={() => void handleStop()}
      />

      <BotDrawer
        open={drawerOpen}
        bots={bots}
        selectedBotId={selectedBot?.id ?? null}
        threads={threads}
        activeThreadId={activeThreadId}
        onClose={() => setDrawerOpen(false)}
        onSelectBot={(bot) => void openBotThread(bot)}
        onNewThread={() => {
          setActiveThreadId(null);
          setMessages([]);
          setLiveCard(null);
        }}
        onSelectThread={(threadId) => {
          if (selectedBot) void openBotThread(selectedBot, threadId);
        }}
      />

      <SettingsPopover
        open={settingsOpen}
        auth={runtime.auth}
        settings={runtime.settings}
        onClose={() => setSettingsOpen(false)}
        onUpdateSettings={handleUpdateSettings}
        onLogout={() => {
          setSettingsOpen(false);
          setMessages([]);
          setLiveCard(null);
          void rpc({ type: "PANEL_LOGOUT" });
        }}
      />
    </div>
  );
}
