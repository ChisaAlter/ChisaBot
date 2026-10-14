import { RouteSkeleton } from "@/components/startup-status";
import { CopilotChat, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RegisterBotChat } from "@/components/agents/bot-chat-actions";
import { BotComposerContext, BotModelInput } from "@/components/agents/bot-model-input";
import { defaultAgentId } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentKeys,
  agentListQueryOptions,
} from "@/lib/agents/queries";
import { tryClient } from "@/lib/client";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { LazyBotThreadHistoryDialog } from "@/components/agents/bot-thread-history-lazy";
import { useConversationSync } from "@/lib/copilot/use-conversation-sync";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";
import { queueMessage } from "@/lib/copilot/thread-inbox";
import { useThreadInbox } from "@/lib/copilot/use-thread-inbox";
import { RICH_MESSAGE_VIEW } from "@/lib/copilot/rich-message-view";
import { useStoppedTurnIds, useTurnCompaction } from "@/lib/copilot/turn-compaction";
import { useComputerAutoWatch } from "@/lib/computers/auto-watch";

/** 机器人聊天里 CopilotChat 自带的英文文案，换成与频道聊天一致的中文。 */
const BOT_CHAT_LABELS = {
  // 输入框自己写占位文字（「给『机器人』发消息…」）和 Shift+Enter 提示（DESIGN.md §25）。
  chatInputPlaceholder: "输入消息…",
  chatInputToolbarAddButtonLabel: "添加附件",
  assistantMessageToolbarCopyMessageLabel: "复制",
  assistantMessageToolbarCopyCodeLabel: "复制",
  assistantMessageToolbarCopyCodeCopiedLabel: "已复制",
  assistantMessageToolbarRegenerateLabel: "重新生成",
  userMessageToolbarCopyMessageLabel: "复制",
  userMessageToolbarEditMessageLabel: "编辑",
};

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; watch?: boolean } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
    ...(search.watch === true ? { watch: true } : {}),
  }),
});

/**
 * Which Bot this screen is for.
 *
 * WHATEVER THIS DEPLOYMENT ACTUALLY HAS. The default used to be a hardcoded `risk-analyst`, a name
 * from a tenant package this one is not: on a clone that ships anything else, opening this screen
 * without naming a Bot took the whole page down to an unstyled error boundary, because the chat
 * throws when asked for an agent the runtime never synced. OpenBot exists to be forked, so a Bot
 * name written into a route is a defect on every fork but the one it came from.
 *
 * A named Bot that this deployment does not have is answered in a sentence rather than thrown,
 * for the same reason: a mistyped link is not a crash.
 */
type BotDetailLookup =
  | { bot: AgentProfile; status: "found" }
  | { status: "missing" };

function isAgentEnvelope(body: unknown): body is { agent: AgentProfile } {
  if (body === null || typeof body !== "object") return false;
  const agent = (body as { agent?: unknown }).agent;
  return (
    agent !== null &&
    typeof agent === "object" &&
    typeof (agent as { id?: unknown }).id === "string" &&
    typeof (agent as { name?: unknown }).name === "string"
  );
}

async function loadExplicitBot(agentId: string): Promise<BotDetailLookup> {
  const response = await tryClient(
    `/api/agents/${encodeURIComponent(agentId)}`,
  );
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) throw new Error("机器人无法加载。");

  const body: unknown = await response.json().catch(() => null);
  if (!isAgentEnvelope(body)) throw new Error("机器人无法加载。");
  return { bot: body.agent, status: "found" };
}

function RouteComponent() {
  const search = Route.useSearch();
  const agent = search.agent === "" ? undefined : search.agent;
  const {
    data: agents,
    isError,
    isPending,
  } = useQuery(agentListQueryOptions());
  const agentId = agent ?? defaultAgentId(agents);
  const listedBot = agents?.find((candidate) => candidate.id === agentId);
  const detailAgentId = agent ?? "";
  const shouldLoadExplicitBot =
    Boolean(agent) && agents !== undefined && listedBot === undefined;
  const {
    data: detail,
    isError: isDetailError,
    isPending: isDetailPending,
  } = useQuery({
    enabled: shouldLoadExplicitBot,
    queryKey: agentKeys.botRouteDetail(detailAgentId),
    queryFn: () => loadExplicitBot(detailAgentId),
    retry: false,
  });
  const bot =
    listedBot ?? (detail?.status === "found" ? detail.bot : undefined);
  const known = bot !== undefined;

  if (isPending || (shouldLoadExplicitBot && isDetailPending)) return <RouteSkeleton />;
  if (isError && agents === undefined) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-destructive text-sm" role="alert">
          {"机器人无法加载。"}
        </p>
      </div>
    );
  }
  if (shouldLoadExplicitBot && isDetailError) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-destructive text-sm" role="alert">
          {"机器人无法加载。"}
        </p>
      </div>
    );
  }
  if (!agentId || !known) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">
          {agent
            ? `此部署中没有名为 "${agent}" 的机器人。`
            : "此部署还没有机器人。"}
        </p>
      </div>
    );
  }

  /*
   * Keyed on the Bot, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run.
   */
  return <BotChat agentId={agentId} key={agentId} name={bot.name} />;
}

function BotChat({ agentId, name }: { agentId: string; name: string }) {
  // Tool calls here act on this Bot's own computer.
  useActiveBot(agentId);
  /*
   * Minted by this deployment rather than by the chat. `history` reports whether Intelligence
   * still recognised the thread this browser remembered from a previous visit; when it did not,
   * `useBotThread` has already swapped in a fresh id on its own; this flag exists only so the
   * page can say so instead of letting the Bot answer as if nothing were missing. `startNew`
   * mints another fresh thread on demand for the New chat control below.
   */
  const { threadId, history, startNew, switchTo, onActivity } = useBotThread(agentId);
  // 「历史对话」（DESIGN.md §42.6）：机器人 ⋯ 菜单打开，点一条切过去。
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  /*
   * A turn that ends without an answer has to be said out loud here, because the packaged chat says
   * nothing. It reports a failed run to an `onError` prop and otherwise carries on as though the
   * turn simply finished: the composer unlocks, the spinner goes, and the transcript keeps the
   * person's own message with nothing under it. The banner that would have explained it belongs to
   * a provider this app does not mount.
   */
  const stopped = useStoppedTurn(agentId);
  // 一轮收成「一句话 → 结果」：中间过程话变淡色小字，网页小条 / 思考只留最后一个（turn-compaction.ts）。
  const skyRef = useRef<HTMLDivElement | null>(null);
  const { agent: chatAgent } = useAgent({ agentId });
  const stoppedTurns = useStoppedTurnIds(threadId);
  useTurnCompaction(skyRef, `${agentId}:${threadId ?? ""}`, {
    messages: () => chatAgent.messages as never,
    stopped: stoppedTurns,
  });
  const { watch } = Route.useSearch();
  const navigate = Route.useNavigate();
  const showComputer = useCallback(
    (open: boolean) =>
      void navigate({
        search: (previous) => ({ ...previous, watch: open ? true : undefined }),
      }),
    [navigate],
  );
  // 计算机在右栏「面板 | 计算机」里（DESIGN.md §23）：机器人开始用计算机时自动切过去，停手后切回。
  useComputerAutoWatch(agentId, watch === true, showComputer);
  const composer = useMemo(() => ({ name, onNewTopic: startNew }), [name, startNew]);
  /*
   * 生成式界面里的「问一句」（DESIGN.md §29）：按钮的 send_message、列表行 / 磁贴的 ask。以前机器人
   * 对话里没有 ConversationProvider，这些点了没反应（只有频道聊天能用）。右栏面板不在这棵树里，
   * 它发 chisabot-ask 事件，这里接住，发到当前对话。正在回答时进收件箱（§38.1）。
   */
  const { copilotkit } = useCopilotKit();
  const askFromUi = useCallback(
    (text: string) => {
      const said = text.trim();
      if (!said) return;
      // 正在回答时：进收件箱，下一步读到（DESIGN.md §38.1），不再丢掉。
      if (chatAgent.isRunning) {
        if (threadId) void queueMessage(threadId, said).then((outcome) => {
          if (outcome !== "send") return;
          chatAgent.addMessage({ id: crypto.randomUUID(), role: "user", content: said });
          void copilotkit.runAgent({ agent: chatAgent }).catch(() => {});
        });
        return;
      }
      chatAgent.addMessage({ id: crypto.randomUUID(), role: "user", content: said });
      void copilotkit.runAgent({ agent: chatAgent }).catch(() => {});
    },
    [chatAgent, copilotkit, threadId],
  );
  // 回答期间发的消息、后台任务的结果和服务器自己起的那一轮（DESIGN.md §38）。
  const runChat = useCallback((options: { agent: typeof chatAgent }) => copilotkit.runAgent(options), [copilotkit]);
  useThreadInbox(threadId, chatAgent, runChat as never);
  // 全端同步（DESIGN.md §42）：别的设备发的消息、正在流式的回答、排队消息、任务卡片拉到这台。
  const connectChat = useCallback((options: { agent: typeof chatAgent }) => copilotkit.connectAgent(options), [copilotkit]);
  useConversationSync(threadId, chatAgent, connectChat as never, onActivity);
  useEffect(() => {
    const on = (event: Event) => {
      const text = (event as CustomEvent<unknown>).detail;
      if (typeof text === "string") askFromUi(text);
    };
    window.addEventListener("chisabot-ask", on);
    return () => window.removeEventListener("chisabot-ask", on);
  }, [askFromUi]);

  return (
      <div className="flex h-full min-h-0 flex-col">
        {/* DESIGN v4.1：聊天列没有头部；机器人「⋯」与计算机提示在左栏它那一行（新话题 Shift+T）。 */}
        <RegisterBotChat
          agentId={agentId}
          computerOpen={watch === true}
          onComputerChange={showComputer}
          fallbackName={name}
          onNewTopic={startNew}
          onHistory={openHistory}
        />
        <LazyBotThreadHistoryDialog
          agentId={agentId}
          currentThreadId={threadId}
          onOpenChange={setHistoryOpen}
          onPick={switchTo}
          open={historyOpen}
        />
        <div className="bot-chat-sky relative min-h-0 flex-1" ref={skyRef}>
          {/*
           * 两条提示浮在聊天上面，不占版面（2026-10-13，修「发送消息，聊天记录往回跳」；DESIGN.md §35.4）。
           * 以前它们是聊天列里的普通块，排在滚动区上面：发一条消息时「停止」提示消失，滚动区顶边一下子
           * 上移 137px（窄窗口 217px），scrollTop 不变，整段聊天记录在同一帧里跳一截；下一轮出错时提示
           * 又出现，滚动区变矮，最新一条被挤到视口外，眼前换成更早的记录。浮层不改变滚动区的大小和位置，
           * 出现 / 消失都不会让消息动。
           *
           * Under the header rather than at the end of the transcript, which is where the missing answer
           * was going to be: it is always on screen, whatever the transcript has been scrolled to, and it
           * survives the next release of the packaged chat (which owns the list and its scrolling).
           */}
          <BotChatNotices history={history} stopped={stopped} />
          {/*
           * Keyed on the thread as well as the agent. Switching agents was already handled by
           * `agentId`, but `startNew` changes only the thread while the agent stays put, and the
           * packaged chat's own `startNewThread`/`setActiveThreadId` are proven no-ops once
           * `threadId` is a controlled prop (node_modules/@copilotkit/react-core/dist/copilotkit-
           * C4RqjAba.mjs:226-254): asking it to start over does nothing while it still holds the
           * old id. A key that omits the thread would leave the previous conversation on screen
           * under a composer that silently posts to the new one.
           */}
          {threadId ? (
            <BotComposerContext.Provider value={composer}>
            <ConversationProvider ask={askFromUi}>
            <CopilotChat
              input={BotModelInput}
              agentId={agentId}
              labels={BOT_CHAT_LABELS}
              // 「正在思考… / 思考了 3 秒」中文，流式时不展开英文推理（reasoning-zh.tsx）；
              // 消息下面的链接卡 / 图片一摞 / 文件卡（rich-message-view.tsx，DESIGN.md §31）。
              messageView={RICH_MESSAGE_VIEW as never}
              // 贴底跟随时高度变化用瞬间对齐，不用弹簧（CB-005）：content-visibility / 重挂载若让上方
              // 高度抖一下，smooth 会先露出更早的记录再滑回来；instant 同一帧钉回底部。
              scrollView={{ resize: "instant", initial: "instant" } as never}
              key={`${agentId}:${threadId}`}
              threadId={threadId}
            />
            </ConversationProvider>
            </BotComposerContext.Provider>
          ) : null}
        </div>
      </div>
  );
}

/**
 * 机器人聊天顶上的提示（较早消息没加载到 / 上一轮没有回答的原因）：浮层，不占版面（DESIGN.md §35.4）。
 * 可以手动关掉；同一句话关掉后不再出现，换了一句（新的一轮又出错）才再显示。
 */
function BotChatNotices({
  history,
  stopped,
}: {
  history: "ready" | "unavailable";
  stopped: string | null;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const dismiss = useCallback(
    (key: string) => setDismissed((previous) => new Set(previous).add(key)),
    [],
  );
  const historyKey = "history";
  const stoppedKey = stopped ? `stopped:${stopped}` : "";
  const showHistory = history === "unavailable" && !dismissed.has(historyKey);
  const showStopped = Boolean(stopped) && !dismissed.has(stoppedKey);
  if (!showHistory && !showStopped) return null;
  return (
    <div className="bot-chat-notices">
      {showHistory ? (
        <div className="bot-chat-notice" data-testid="bot-chat-history-unavailable" role="alert">
          <p className="bot-chat-notice-text">
            {"此会话中的较早消息无法加载，机器人正在没有它们的情况下回答。"}
          </p>
          <button
            aria-label="关闭提示"
            className="bot-chat-notice-x"
            onClick={() => dismiss(historyKey)}
            type="button"
          >
            {"×"}
          </button>
        </div>
      ) : null}
      {showStopped ? (
        <div className="bot-chat-notice" data-testid="bot-chat-stopped" role="alert">
          <p className="bot-chat-notice-text">{stopped}</p>
          <button
            aria-label="关闭提示"
            className="bot-chat-notice-x"
            onClick={() => dismiss(stoppedKey)}
            type="button"
          >
            {"×"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
