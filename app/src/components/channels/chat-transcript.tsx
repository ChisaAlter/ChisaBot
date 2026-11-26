import type { ActivityMessage, Message } from "@ag-ui/core";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconBox,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconMessageReply,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import {
  cloneElement,
  createContext,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { VirtualizerHandle } from "virtua";
import {
  type VirtualCell,
  VirtualTranscriptControls,
  VirtualTranscriptRows,
} from "@/components/channels/virtual-transcript";
import {
  BotBubbles,
  ReplyQuote,
  type ReplyTarget,
} from "@/components/chat/bot-bubbles";
import {
  ConfirmResumeRow,
  confirmResumeId,
  isConfirmResume,
  LooseConfirmCards,
  ToolCallConfirmCards,
} from "@/components/chat/confirm-card";
import { LocalAgentResultRow } from "@/components/chat/local-agent-card";
import {
  EditAction,
  MessageEditor,
  RegenerateAction,
  SpeakAction,
  WithdrawAction,
} from "@/components/chat/message-actions";
import { QueuedMessages } from "@/components/chat/queued-messages";
import { ScheduleFiredRow } from "@/components/chat/schedule-row";
import {
  NoAnswerRow,
  PausedCapsule,
  StatusCapsule,
} from "@/components/chat/status-capsule";
import {
  markTurnRunEnded,
  turnStartedAt,
  WorkRow,
} from "@/components/chat/work-card";
import { WorkerResultRow } from "@/components/chat/worker-card";
import { JUMP_TO_TOOL_CALL } from "@/components/computer/activity-jump";
import { ActivityJumpButton } from "@/components/computer/activity-jump-button";
import {
  FileCard,
  HiddenMarkdownImage,
  ImagePile,
  MessageRichPreviews,
  RichBotStreamdown,
} from "@/components/rich-previews/rich-previews";
import { useAsyncAction } from "@/components/ui/async-action";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { StatusGlyph } from "@/components/ui/button";
import { writeClipboard } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  MessageContent,
  MessageFooter,
  Message as MessageRow,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { SmoothCollapse } from "@/components/ui/motion-primitives";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useExternalConnection,
  useWindowEvent,
} from "@/hooks";
import { approvalInboxOptions } from "@/lib/approvals";
import { speechStatusQueryOptions } from "@/lib/audio/speech";
import {
  attachmentThumbUrl,
  attachmentUrl,
  pickAttachmentThumbWidth,
} from "@/lib/channels/attachments";
import { isMessageHeld } from "@/lib/channels/focus-message";
import { readWakeUpTurn } from "@/lib/channels/follow-up-turn";
import { readResponsibilityTurn } from "@/lib/channels/responsibility-turn";
import { readFiring } from "@/lib/channels/routine-firing";
import type { Attachment } from "@/lib/chat/attachment-state";
import { useConversationScope } from "@/lib/chat/conversation-scope";
import {
  friendlyError,
  UNANSWERED_TURN_REASON,
} from "@/lib/chat/friendly-error";
import { supersededPageCalls } from "@/lib/chat/page-cards";
import { dispatchComposerQuote } from "@/lib/chat/quote-event";
import {
  useRenderActivityMessage,
  useRenderToolCall,
} from "@/lib/chat/renderers";
import {
  previousSentAt,
  rememberSent,
  type SentAtReading,
  staysInSameTurn,
  takeSendWhileBusy,
} from "@/lib/chat/send-scroll";
import { useLiveMessageText } from "@/lib/chat/session-client";
import {
  TAIL_ANCHOR_SLACK_EVENT,
  windowMarks,
} from "@/lib/chat/tail-first-paint";
import { useToolActivityVisible } from "@/lib/chat/tool-activity";
import type { TranscriptDataLayer } from "@/lib/chat/transcript-data-layer";
import { setThreadUi, threadUi } from "@/lib/chat/ui-memory";
import { useTailFirstMount } from "@/lib/chat/use-tail-first-mount";
import { splitVirtualTail } from "@/lib/chat/virtual-transcript";
import { useVirtualTranscript } from "@/lib/chat/virtual-transcript-flag";
import {
  isBlankNote,
  isWorkCall,
  summarizeWork,
  type WorkCall,
  type WorkNote,
  workCallFailed,
  workCallInterrupted,
} from "@/lib/chat/work-steps";
import { useThreadConfirmations } from "@/lib/confirmations";
import { objectConnectionKey } from "@/lib/connection-key";
import {
  type EditableAttachment,
  isEditableUserText,
} from "@/lib/conversations/regenerate";
import { useRenderUiPreload } from "@/lib/conversations/render-ui-preload";
import { useReadMark } from "@/lib/conversations/thread-inbox";
import {
  type CardChecks,
  getCardCheck,
  isLineOnlyRender,
  pickToolRenderer,
  registeredCardChecks,
  ToolTurnEndedContext,
  unfinishedToolText,
  useActivityRenderers,
  useToolRenderers,
} from "@/lib/conversations/tool-renderers";
import { WORKER_RESULT_MARKER } from "@/lib/conversations/workers";
import { useKeptVisibility } from "@/lib/kept-visible";
import { markdownComponents } from "@/lib/markdown";
import { forgetMemoryNote } from "@/lib/memory-notes";
import {
  DURATION_MS,
  EASE_OUT,
  ENTRANCE_SECONDS,
  smoothScrollIntoView,
  usePresenceMount,
  useRetainedValue,
  useSharedReducedMotion,
} from "@/lib/motion";
import { readToolName } from "@/lib/plugins/tool-name";
import {
  asText,
  forDisplay,
  REFUSAL_MARKER,
  toolResultFailed,
} from "@/lib/plugins/tool-result";
import { probeRemoteFile } from "@/lib/rich-previews/files";
import { collapseScheduleRuns } from "@/lib/schedule-fired";
import { cn } from "@/lib/utils";
import { CHAT_FILE_URL_PREFIX } from "../../../../shared/chat-files";
import { splitChatOrigin } from "../../../../shared/chat-origin";
import { LOCAL_AGENT_RESULT_MARKER } from "../../../../shared/local-agents";
import { SCHEDULE_MARKER } from "../../../../shared/schedules";
import {
  BrowserActivity,
  groupBrowserSteps,
  type TranscriptItem,
} from "./browser-activity";
import {
  attachmentModality,
  type SentAttachment,
  toVisibleChatItems,
} from "./chat-messages";
import type { QueuedMessage } from "./composer";
import { ToolRenderBoundary } from "./tool-boundary";
import { ToolLine } from "./tool-line";

type ChatTranscriptProps = {
  busy?: boolean;
  /**
   * 服务端说这一段对话还在跑（inbox running；用户停止 / 停滞留下的 paused 不算，等审批另看审批收件箱）。
   * 打开一段正在进行的对话时，历史往往先到、`busy` 后变 true：若只靠 busy 和列表形状，
   * 会把这一轮当成已结束，首帧挂「这一轮没有回答 / 重试」，要等下一条事件才出干活卡
   * （QA #519 P2-2）。服务端说还在跑时，首帧就按进行中画，绝不挂「没有回答」。
   */
  threadLive?: boolean;
  /**
   * 这段对话还在接入。接入期间 `busy` 为 false（connect 的 isRunning 不算在回答），
   * 不要把这时的列表记成「已结束」，否则接入结束、服务器其实还在跑时 live 会卡住。
   */
  joining?: boolean;
  reconnecting?: boolean;
  /** 这段对话的机器人：在想 / 在干活那一行用它的形象头像代替三个点（DESIGN.md §81）。 */
  agentId?: string;
  /** 滚动位置记在哪（DESIGN.md §88）：频道 id。 */
  scrollKey?: string;
  /** Comma-separated `/` command names, used to tell a skill chip from a leading slash. */
  commandNames?: string;
  messages: ReadonlyArray<Readonly<Message>>;
  /**
   * Typed while the Bot had the turn, and waiting for it to finish. Empty on a screen that does not
   * offer queueing at all.
   */
  queued?: readonly QueuedMessage[];
  /** Take one back before it runs. Without it a queued line is shown but cannot be undone. */
  onRemoveQueued?: (id: string) => void;
  /**
   * The drain the queue waited on failed and its messages came back. `held` marks every parked row
   * 没发出去 instead of 排队 — a queue that only ever says "waiting" would sit on screen promising
   * a send that has already been tried and lost — and `onRetryQueued` is the way to ask again.
   */
  queuedHeld?: boolean;
  onRetryQueued?: () => void;
  /** History has been asked for and has not arrived. Drawn only when there is nothing else to draw. */
  restoring?: boolean;
  /**
   * 打开对话后第一次恢复（接入 + 读存储）还没完成（DESIGN.md §83）。这期间以及完成后的一小段时间里，
   * 历史怎么到（回放一段段长出来、存储补进来、「已停止」/「换了备用模型」行晚到、图片撑高）都钉在最新一条，
   * 不当成刚发的新一轮去对齐，也不平滑滚动；人一动滚轮 / 手指 / 按键就不再钉。
   */
  hydrating?: boolean;
  /** 最新一条用户消息的服务器发送时刻（本机时钟）：决定下一条发出去时翻不翻页（DESIGN.md §94）。 */
  lastSentAt?: SentAtReading | null;
  /**
   * Why the last turn ended without an answer, if it did.
   *
   * A sentence rather than a flag, because the reasons are not interchangeable: a Bot that refused,
   * a Bot whose endpoint is down and a Bot that simply stopped talking are three different things to
   * be told, and only the thing that ended the turn knows which one happened.
   */
  stopped?: string;
  /** 用户按停止的那些轮次（开启那一轮的用户消息 id），末尾挂「已停止」，没有结果气泡。 */
  stoppedTurns?: ReadonlySet<string>;
  /** Re-run the turn that failed. Without it the error card has no retry button. */
  onRetry?: () => void;
  /**
   * 重发「发出去了但没有回答」的那一条（刷新后才认出来的那种，2026-10-20 P1）。
   * 和 `onRetry` 分开：那条消息已经在历史里，重试是「从它那里重发」，不是把草稿里的字再发一次。
   */
  onRetryUnanswered?: () => void;
  /** 撤回最后一轮没有收到回答的用户消息（尤其是图片被网关隐私策略拦截、重试无效时的一键逃生口）。 */
  onWithdraw?: () => Promise<void> | void;
  /** 会话最上方的一句提示（例如较早的消息读不到），在第一条消息之前。 */
  topNotice?: React.ReactNode;
  /** 换了备用模型的轮次（开启那一轮的用户消息 id → 一句说明），那一轮末尾一行淡色小字（DESIGN.md §61）。 */
  fallbacks?: ReadonlyMap<string, string>;
};

/**
 * 服务器放进对话、以 `role: "user"` 出现但不是人说的那几种消息（CB-046 从 `/bot` 搬来）：定时任务到点（§55）、
 * 后台任务交回结果（§38.2）、本地 agent 交回结果（§66）、后来才确认的那一步（§58）。画成一行，不是用户气泡，
 * 不能编辑；但它们各自开启一轮（服务器接着跑），所以收轮次时算一轮的开头。
 */
export function serverRowKind(
  text: string,
): "schedule" | "worker" | "local-agent" | "confirm" | null {
  if (text.startsWith(SCHEDULE_MARKER)) return "schedule";
  if (text.startsWith(LOCAL_AGENT_RESULT_MARKER)) return "local-agent";
  if (text.startsWith(WORKER_RESULT_MARKER)) return "worker";
  if (isConfirmResume(text)) return "confirm";
  return null;
}

function ServerRow({ messageId, text }: { messageId: string; text: string }) {
  const kind = serverRowKind(text);
  if (kind === "schedule")
    return (
      <div className="worker-result-msg" data-testid="schedule-fired-message">
        <ScheduleFiredRow messageId={messageId} text={text} />
      </div>
    );
  if (kind === "local-agent")
    return (
      <div
        className="worker-result-msg"
        data-testid="local-agent-result-message"
      >
        <LocalAgentResultRow messageId={messageId} text={text} />
      </div>
    );
  if (kind === "worker")
    return (
      <div className="worker-result-msg" data-testid="worker-result-message">
        <WorkerResultRow messageId={messageId} text={text} />
      </div>
    );
  return (
    <div className="confirm-resume-msg">
      <ConfirmResumeRow text={text} />
    </div>
  );
}

/**
 * 仅在当前 KeepAlive 页处于可见态时维持审批收件箱 10s 轮询（非重渲订阅 `useKeptVisibility()`），
 * 避免在 `ChatTranscriptImpl` 顶层消费 `KeptVisibleContext` 导致切换频道整树重渲，也不翻转 `enabled` 触发切页重拉。
 */
function VisibleApprovalPoll({ enabled }: { enabled: boolean }) {
  const keptVisibility = useKeptVisibility();
  const queryClient = useQueryClient();
  useExternalConnection(
    enabled ? `approval-poll:${objectConnectionKey(keptVisibility)}` : false,
    () => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const stop = () => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
      const sync = () => {
        if (!keptVisibility.get()) {
          stop();
          return;
        }
        if (timer === null) {
          timer = setInterval(() => {
            if (
              !keptVisibility.get() ||
              (typeof document !== "undefined" &&
                document.visibilityState === "hidden")
            ) {
              return;
            }
            void queryClient.invalidateQueries({
              queryKey: approvalInboxOptions().queryKey,
            });
          }, 10_000);
        }
      };
      sync();
      const unsubscribe = keptVisibility.subscribe(sync);
      return () => {
        unsubscribe();
        stop();
      };
    },
  );
  return null;
}

/** 回答期间发的这条刚被机器人读到（DESIGN.md §38.1），几秒后淡出。 */
function ReadMark({ messageId }: { messageId: string }) {
  return useReadMark(messageId) ? (
    <div className="flex justify-end">
      <span className="queued-read-mark" data-testid="queued-read">
        {"已读取"}
      </span>
    </div>
  ) : null;
}

/** One shared empty array, so a screen without a queue does not hand down a new one per render. */
const EMPTY_QUEUE: readonly QueuedMessage[] = [];

/**
 * 「回到底部」整个元素放模块级：transcript 每个 token 重渲，元素不变 React 就跳过它；按钮自己的滚动状态照常更新
 * （jank FIX-PLAN §5 / P2-1）。
 */
const BOTTOM_PILL = (
  <MessageScrollerButton className="chat-bottom-pill">
    <IconChevronDown className="size-4" />
    <span className="chat-bottom-pill-t">{"回到底部"}</span>
  </MessageScrollerButton>
);

/**
 * Split a person's message into the skill they invoked and the rest of what they typed.
 *
 * ONLY A KNOWN COMMAND COUNTS. "/etc/hosts is broken" is a sentence, not a skill, and drawing a chip
 * around it would invent a thing that never happened. The names come from the same list the `/` menu
 * was built from, so this stays true as skills are granted and revoked.
 *
 * The trigger only opens at the start of a line, so the chip is the first token or there is none.
 */
function splitSkillChip(
  text: string,
  commandNames: string,
): { chip: string; rest: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(\s|$)/.exec(text);
  if (!match) {
    return null;
  }
  const known = commandNames.split(",").filter(Boolean);
  if (!known.includes(match[1])) {
    return null;
  }
  return { chip: match[1], rest: text.slice(match[0].length) };
}

/**
 * The shape of a conversation, while it is still being fetched. Shaped like what is coming rather
 * than like a loading widget, on the same line pitch so the column does not jump when words land.
 */
const RESTORING_ANSWER_LINES = [
  { id: "line-1", width: "w-full" },
  { id: "line-2", width: "w-11/12" },
  { id: "line-3", width: "w-full" },
  { id: "line-4", width: "w-10/12" },
  { id: "line-5", width: "w-11/12" },
  { id: "line-6", width: "w-full" },
  { id: "line-7", width: "w-11/12" },
  { id: "line-8", width: "w-2/3" },
] as const;

function RestoringTranscript() {
  return (
    // One announcement, with every bar hidden from it: nine empty shapes read aloud is worse.
    <div aria-label={"正在加载此会话"} role="status">
      <div aria-hidden="true" className="flex justify-end pb-7">
        <Skeleton className="h-10 w-64 rounded-xl bg-muted/40 motion-reduce:animate-none" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        {RESTORING_ANSWER_LINES.map((line) => (
          <Skeleton
            className={`h-4 bg-muted/40 motion-reduce:animate-none ${line.width}`}
            key={line.id}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The Bot has the turn and has produced nothing yet.
 *
 * THE GAP THIS FILLS IS THE WORST ONE IN THE CONVERSATION. Between pressing send and the first token
 * there was `aria-busy` and nothing else: announced to a screen reader, invisible to everybody else.
 * A person who has just asked something watches their own message sit there, and a Bot that is
 * thinking is indistinguishable from a Bot that failed silently — which this app has shipped before.
 *
 * It borrows the shimmer a running tool line uses, so "working on it" reads the same whether the
 * work is a tool call or a model that has not spoken yet.
 */
function Thinking({ since, label }: { since: number; label: string }) {
  // 回复显示①：不再是带三个跳点的「思考中」气泡，而是和干活卡同一个状态胶囊（转圈 + 动作 + 已用秒数）。
  // 读屏读到的「思考中」在对话末尾那个一直挂着的 role=status 里（transcript-live-status），胶囊自己不带。
  return (
    <StatusCapsule label={label} since={since} testId="transcript-thinking" />
  );
}

/** 固定 38px 状态槽的轻量退场淡出替身：胶囊消失时原地 150ms 淡出，零高度变化与零滚动跳动。 */
function StatusSlotExitGhost({
  active,
  snapshot,
}: {
  active: boolean;
  snapshot: { label: string; since: number; variant?: "pause" } | null;
}) {
  const lastSnapshot = useRef(snapshot);
  if (snapshot) {
    lastSnapshot.current = snapshot;
  }
  const retained = snapshot ?? lastSnapshot.current;
  const { mounted } = usePresenceMount(active, DURATION_MS.exit);
  if (active || !mounted || !retained) return null;
  return (
    <StatusCapsule
      label={retained.label}
      leaving
      since={retained.since}
      {...(retained.variant ? { variant: retained.variant } : {})}
    />
  );
}

/**
 * The turn ended and no answer came.
 *
 * In the same slot as `Thinking`, and for the same reason it is there: the person is looking at the
 * bottom of the transcript, immediately under their own message, because that is where the answer
 * was going to appear. Saying so above the composer put the explanation in a different part of the
 * screen from the gap it explains, and left the last thing in the conversation looking unfinished.
 *
 * NOT A MESSAGE, deliberately. It has no id, is never anchored, and is gone the moment the next turn
 * starts. Making it a transcript row would put a sentence into the conversation that nobody said,
 * and the conversation is sent back to the model on the next turn, so the Bot would then read its
 * own obituary as something it had written.
 */
function Stopped({
  onRetry,
  onWithdraw,
  reason,
}: {
  onRetry?: () => void;
  onWithdraw?: () => Promise<void> | void;
  reason: string;
}) {
  const friendly = friendlyError(reason);
  const [open, setOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const showRetry = Boolean(onRetry && friendly.retryable);
  const handleWithdraw = () => {
    if (!onWithdraw || withdrawing) return;
    const result = onWithdraw();
    if (result && typeof (result as Promise<unknown>).finally === "function") {
      setWithdrawing(true);
      void (result as Promise<unknown>).finally(() => setWithdrawing(false));
    }
  };
  return (
    <div
      className="chat-error-card"
      data-testid="transcript-stopped"
      role="alert"
    >
      <span aria-hidden="true" className="chat-error-icon">
        <IconAlertTriangle className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="chat-error-title">{friendly.title}</p>
        {friendly.hint ? (
          <p className="chat-error-hint">{friendly.hint}</p>
        ) : null}
        {friendly.detail ? (
          <>
            <button
              aria-expanded={open}
              className="chat-error-toggle"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              {open ? "收起详情" : "查看详情"}
            </button>
            <SmoothCollapse open={open} unmountOnExit>
              <pre className="chat-error-detail">{friendly.detail}</pre>
            </SmoothCollapse>
          </>
        ) : null}
      </div>
      {onWithdraw || showRetry ? (
        <div className="chat-error-actions">
          {onWithdraw ? (
            <button
              className={showRetry ? "chat-error-withdraw" : "chat-error-retry"}
              data-testid="transcript-withdraw"
              disabled={withdrawing}
              onClick={handleWithdraw}
              type="button"
            >
              <IconArrowBackUp className="size-3.5" />
              {withdrawing ? "撤回中…" : showRetry ? "撤回" : "撤回这条消息"}
            </button>
          ) : null}
          {showRetry ? (
            <button
              className="chat-error-retry"
              onClick={onRetry}
              type="button"
            >
              <IconRefresh className="size-3.5" />
              {"重试"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A file staged on the composer, described the way a sent one is.
 *
 * So that a parked message draws the SAME tiles the turn will draw once it runs, rather than a
 * second rendering of an attachment that has to be kept in step with this one. The composer's
 * `onUpload` has already put the row on the server and handed back its url — `canSendDraft` refuses
 * to send, and therefore to park, anything still uploading — so there is always something to point
 * at by the time one of these reaches here.
 *
 * Anything that is not a picture becomes a document tile, which is what the sent row does with the
 * modalities it has no preview for: a card naming the file is the honest drawing of "this came
 * along", and the alternative is a broken thumbnail.
 *
 * WHICH ONES ARE PICTURES IS ASKED OF THE SERVER'S ANSWER, NOT OF `attachment.type`, and this is
 * the one surface in the browser where that answer is actually in hand. `attachment.type` is the
 * SDK's `getModalityFromMimeType(file.type)` from before the upload, never revisited when the
 * upload replies; `attachment.source.mimeType` is what OUR `onUpload` put there, and that is
 * `body.mimeType` — the type the server earned from `sniffMimeType` over the bytes
 * (`composer/attachments.ts`). A PNG the browser called `text/plain` has `type: "document"` and
 * `source.mimeType: "image/png"`, and this used to draw a grey card over it.
 *
 * A PARKED MESSAGE HOLDS THE LIVE `Attachment`, WHICH IS WHY THIS CAN BE PUT RIGHT AND THE SENT ROW
 * CANNOT. `QueuedMessage.attachments` is `Attachment[]` — the staged object itself, source and all
 * — whereas a sent turn has been through `toAttachmentPart` (`channel-chat.tsx`), which rebuilds
 * the source as `{ type: "url", value }` and drops the `mimeType` on the floor. So the two tiles
 * genuinely can disagree for as long as that line stands: a mislabelled picture draws correctly
 * here and reverts to a file card the moment the turn runs.
 *
 * That flip is a real cost and it is still the right way round. It is the symptom of the missing
 * line rather than a reason to keep this tile wrong on purpose, and the alternative — throwing away
 * an answer we hold so that both surfaces are wrong together — is the kind of consistency that
 * hides the defect instead of paying it down. `attachmentModality` is shared with the sent path
 * precisely so that fixing the source there needs no second change here.
 */
export function parkedTiles(
  attachments: readonly Attachment[],
): SentAttachment[] {
  return attachments.map((attachment) => {
    const metadata = attachment.metadata as
      | { attachmentId?: unknown; chatFileId?: unknown }
      | undefined;
    const attachmentId = metadata?.attachmentId;
    const chatFileId = metadata?.chatFileId;
    const resolvedId =
      typeof attachmentId === "string" && attachmentId
        ? attachmentId
        : typeof chatFileId === "string" && chatFileId
          ? chatFileId
          : attachment.id;
    /*
     * Narrowed rather than read straight through, for the reason the sent path narrows the same
     * field: `Attachment["source"]` is a union whose `data` member REQUIRES `mimeType` and whose
     * `url` member does not, and a `data` source here carries `file.type` — the browser's claim,
     * which is the very thing this is refusing to trust. Only a url source has been near the
     * server. A staged attachment still uploading is exactly that case (`{ type: "data", value: "",
     * mimeType: file.type }`), and while `canSendDraft` refuses to park one, this costs nothing and
     * means the guard does not depend on that staying true.
     */
    const { source } = attachment;
    const mimeType =
      source.type === "url" && source.mimeType ? source.mimeType : undefined;

    return {
      id: attachment.id,
      attachmentId: resolvedId,
      url: source.value,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      modality: attachmentModality(attachment.type, mimeType),
    };
  });
}

/** What a parked message is called, for somebody who cannot see it: its words, or else its files. */
function describeParked(
  text: string,
  files: readonly SentAttachment[],
): string {
  if (text) {
    return text;
  }
  const named = files
    .map((file) => file.filename)
    .filter((filename) => filename !== undefined);

  return named.length > 0 ? named.join(", ") : "附件";
}

/**
 * Something the person said while the Bot was working, waiting its turn.
 *
 * IT IS DRAWN AS THEIR MESSAGE, NOT AS A NOTICE ABOUT ONE. The whole point of letting somebody type
 * mid-turn is that they can see their words landed, and a status line saying "1 message queued"
 * does not do that — they would still be wondering whether the sentence they typed is the sentence
 * that will run. So it is the same bubble, in the same column, with the same wrapping, and only two
 * things say it has not run yet: it is faded, and it says so underneath.
 *
 * The footer carries the taking-back too, because that is where the reader's eye already is once
 * they have decided this was a mistake, and because a control on the bubble itself would have to
 * hover over the words it is offering to delete.
 */
function Queued({
  attachments,
  held,
  text,
  onRemove,
}: {
  attachments: readonly Attachment[];
  /** The send this row was waiting on failed. Still parked — but「排队」would be a lie. */
  held?: boolean;
  text: string;
  onRemove?: (() => void) | undefined;
}) {
  /*
   * THE FILES COME WITH IT, and until they did they were on NO SURFACE IN THE APP AT ALL. Parking
   * consumes the draft, so the composer's strip empties in the same beat this line appears; drawing
   * only `text` meant somebody who attached a screenshot mid-turn watched it vanish from the
   * composer and never show up anywhere else. Same tiles as a sent turn, in the same order —
   * pictures above the words — because this IS their message, just not yet run.
   */
  const files = parkedTiles(attachments);

  return (
    <MessageRow align="end">
      <MessageContent>
        {files.length > 0 ? (
          <AttachmentTiles attachments={files} className="opacity-60" />
        ) : null}
        {/*
         * NO WORDS, NO BUBBLE. A screenshot pasted mid-turn with nothing typed is the ordinary way
         * this gets used, and it drew an empty muted bubble above the footer — which reads as a
         * message sent by mistake rather than as a file waiting its turn.
         */}
        {text ? (
          <Bubble align="end" className="opacity-60" variant="muted">
            <BubbleContent>
              {/* Shown exactly as typed, for the same reason a sent message is. */}
              <span className="whitespace-pre-wrap">{text}</span>
            </BubbleContent>
          </Bubble>
        ) : null}
        <MessageFooter>
          {/*
           * `status` rather than `alert`, matching the thinking line: a person who has just chosen
           * to queue something is not being interrupted by the news that it is queued.
           */}
          <span role="status">{held ? "没发出去" : "排队"}</span>
          {onRemove ? (
            <button
              /*
               * The sentence it deletes, in the name. Three parked corrections put three buttons
               * called "Remove" in a row, and somebody reading by name alone is told what they can
               * do and nothing about which one it would happen to. The visible word stays short
               * because the bubble it sits under is the answer for everybody who can see it.
               *
               * With no sentence to name it by, the FILES are what it deletes — see
               * `describeParked`. An attachment-only message named the label after an empty string
               * and read as "Remove queued message:", which is the same nothing three times over.
               */
              aria-label={`移除队列消息：${describeParked(text, files)}`}
              className="ml-2 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={onRemove}
              type="button"
            >
              {"移除"}
            </button>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </MessageRow>
  );
}

/**
 * Put the newest queued message where the person who just typed it can see it.
 *
 * WITHOUT THIS THE AFFORDANCE IS INVISIBLE EXACTLY WHEN IT MATTERS. The scroller holds its anchor on
 * the turn being answered rather than following the bottom, so during a long streamed answer the
 * transcript sits a screen or so above the end — and a line appended below it lands off screen.
 * Measured at the point somebody would actually use this: eighty-odd pixels under the fold, with
 * the composer emptying at the same moment. They would have watched their correction vanish.
 *
 * Keyed on the newest queued id rather than on the list, so it does not fire again for every chunk
 * of the answer still streaming above it. It does fire when the bottom-most queued line is taken
 * back, which is a scroll nobody asked for and which lands on the end of the conversation anyway,
 * and it stays quiet on a drain, when the id goes to null.
 *
 * IT COSTS THE ANCHOR, AND THAT IS THE PRICE OF THE SCROLL RATHER THAN A SIDE EFFECT OF IT.
 * `scrollToEnd` drops whatever turn the scroller was holding its position against and starts
 * following the bottom instead, so the rest of that answer streams past under the reader rather
 * than staying put beneath the question. Somebody who has just typed at the bottom of the
 * conversation has asked to be at the bottom of the conversation, so following it is the reading
 * they chose; but they chose it for the whole turn and not only for the moment, and the button
 * back to the anchored view is the scroller's own, not ours to restore.
 *
 * Rendering nothing and living inside the provider is what buys access to the scroller at all; the
 * alternative is threading a ref out through three components with no other reason to know a
 * scroller exists.
 */
function ScrollNewestQueuedIntoView({
  newest,
  viewport,
}: {
  newest: string | null;
  viewport?: React.RefObject<HTMLDivElement | null>;
}) {
  const { scrollToEnd } = useMessageScroller();

  useExternalConnection(
    newest !== null
      ? `${newest}\0${objectConnectionKey(scrollToEnd)}\0${viewport ? objectConnectionKey(viewport) : ""}`
      : false,
    () => {
      if (newest === null) {
        return;
      }
      /*
       * 只有本来就在底部（或几乎在底部）才跟下去：往上翻着读的人排了一句补充，不该被拽回底部——
       * 那一行在列表末尾，翻回去看得到，而且「它已经排上了」由输入框清空 + 末尾那一行一起说清楚。
       * 关掉也走这里（`newest` 换成上一条 / null）：同样不拽人。
       */
      const element = viewport?.current;
      if (element) {
        const fromBottom =
          element.scrollHeight - element.scrollTop - element.clientHeight;
        if (fromBottom > 80) return;
      }
      scrollToEnd({ behavior: "instant" });
    },
  );

  return null;
}

/** 恢复完成后还钉在底部多久（毫秒）：晚到的「已停止」行、图片撑高、存储补进来的几轮都在这段时间里。 */
export const SETTLE_AFTER_HYDRATE_MS = 2500;

/** 外部触发跳转到历史消息时通知 SettleAtEnd 退出 pinned。 */
const DETACH_PIN_EVENT = "chisabot:scroll-detach-pin";
/** ComposerDock 同步写完 padding-bottom 后通知 SettleAtEnd 同步贴底，绕开 ResizeObserver 深度推迟。 */
const COMPOSER_INSET_SYNC_EVENT = "chisabot:composer-inset-sync";

/**
 * 对话滚动单一事实源（Single Source of Truth）：
 * - 仅维护单一 `pinned` 状态不变量：
 *   1. 仅由真实用户输入（wheel 向上 deltaY < 0、touchmove、ArrowUp/PageUp/Home/Shift+Space、pointerdown 拖滚动条、
 *      或外部 scrollToMessage 跳转）退出 `pinned`；绝不因内容增减或收缩 clamp 翻转。
 *   2. 仅由用户发送新消息、点击「回到底部」、或主动滚回底缘 `<= 4px` 重新进入 `pinned`。
 * - `pinned` 下在视口同步维护 `data-cb-pinned="true"`（带脏检查），由 CSS 关闭浏览器原生 `overflow-anchor` 防互搏；
 *   唯一 `ResizeObserver(content & viewport, { box: "border-box" })` 的 `pinNow` 在绘制前同步瞬时落底（`behavior: "instant"`）。
 * - 保留 `TAIL_ANCHOR_SLACK_EVENT` 对不足一屏历史补全（`tail-first-prepend-anchor`）的锚点垫高支持。
 */
function SettleAtEnd({
  hydrating,
  opening = false,
  newestUserMessageId,
  viewport,
  scrollKey,
  slack,
}: {
  /** 这一段对话正在回答。 */
  busy?: boolean;
  /** 刚出现的那条用户消息是不是连续聊天里发的（§94）。 */
  sendMode?: React.RefObject<SendMode>;
  hydrating: boolean;
  /** 还在「打开」这段对话的窗口里（`useOpeningWindow`）：历史补齐不是新的一轮。 */
  opening?: boolean;
  newestUserMessageId: string | null;
  viewport: React.RefObject<HTMLDivElement | null>;
  /** 滚动位置记在哪（DESIGN.md §88）；没有就只管钉在底部。 */
  scrollKey?: string;
  /** 最后一条下面的锚点垫高（仅用于 TAIL_ANCHOR_SLACK_EVENT）。 */
  slack: React.RefObject<HTMLDivElement | null>;
}) {
  const { scrollToMessage } = useMessageScroller();
  const [memo] = useState(() =>
    scrollKey ? (threadUi(scrollKey)?.scroll ?? null) : null,
  );
  const state = useRef({
    pinned: !(memo && !memo.atBottom && memo.anchor),
    restore: memo && !memo.atBottom && memo.anchor ? memo : null,
    hydrating,
    baseline: newestUserMessageId,
    wasHydrating: hydrating,
    slackPx: 0,
    anchorHold: false,
  });

  const setSlack = (px: number) => {
    const el = slack.current;
    const next = Math.max(0, Math.round(px));
    state.current.slackPx = next;
    state.current.anchorHold = false;
    if (!el) return;
    if (next === 0) {
      el.style.display = "none";
      el.style.height = "";
      el.style.marginTop = "";
      return;
    }
    const column = el.parentElement?.parentElement;
    const gap = column ? getComputedStyle(column).rowGap : "0px";
    el.style.display = "block";
    el.style.marginTop = gap && gap !== "normal" ? `calc(-1 * ${gap})` : "0px";
    el.style.height = `${next}px`;
  };

  const pinActionRef = useRef<(() => void) | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 滚动位置状态机：状态放在 ref 里，只在 hydrating / 最新用户消息 / opening 变化时同步
  useLayoutEffect(() => {
    const s = state.current;
    s.hydrating = hydrating;
    if (hydrating) {
      s.baseline = newestUserMessageId;
    } else if (s.wasHydrating) {
      s.baseline = newestUserMessageId;
      if (!s.restore && s.pinned) {
        pinActionRef.current?.();
      }
    } else if (newestUserMessageId !== s.baseline) {
      s.baseline = newestUserMessageId;
      if (!opening && newestUserMessageId !== null) {
        // 用户发送新消息：清除历史锚点垫高，进入 pinned 并同步瞬时落底。
        s.restore = null;
        s.anchorHold = false;
        if (s.slackPx > 0) setSlack(0);
        s.pinned = true;
        pinActionRef.current?.();
      }
    }
    s.wasHydrating = hydrating;
  }, [hydrating, newestUserMessageId, opening]);

  // 流式增量或行高变更提交后，在进入下一帧 rAF / 绘制前同步校齐底部，消除 1 帧滞后。
  useLayoutEffect(() => {
    const s = state.current;
    if (!s.hydrating && s.pinned && !s.restore && !s.anchorHold) {
      pinActionRef.current?.();
    }
  });

  // 离开对话：最后记一次位置。用 layout 的清理——那时 DOM 还在页面上，量得出来。
  const finalWrite = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => finalWrite.current?.(), []);

  useExternalConnection(
    `${scrollKey ?? ""}\0${objectConnectionKey(scrollToMessage)}\0${objectConnectionKey(viewport)}`,
    () => {
      const element = viewport.current;
      const content = element?.querySelector<HTMLElement>(
        '[data-slot="message-scroller-content"]',
      );
      if (!element || !content) return;
      const s = state.current;
      const held = () => isMessageHeld(element);

      const syncPinnedAttr = () => {
        const activePin = s.pinned && !s.restore && !s.anchorHold && !held();
        if (activePin) {
          if (element.getAttribute("data-cb-pinned") !== "true") {
            element.setAttribute("data-cb-pinned", "true");
          }
        } else if (element.hasAttribute("data-cb-pinned")) {
          element.removeAttribute("data-cb-pinned");
        }
        return activePin;
      };

      /** 瞬时滚动到指定位置而不改写视口内联 style.scrollBehavior。 */
      const scrollTopInstant = (top: number) => {
        const clamped = Math.max(0, top);
        if (typeof element.scrollTo === "function") {
          element.scrollTo({ top: clamped, behavior: "instant" });
          return;
        }
        element.scrollTop = clamped;
      };

      /** 回到上次那一条；找到了返回 true。 */
      const toRemembered = () => {
        const r = s.restore;
        if (!r?.anchor) return false;
        const row = content.querySelector(
          `[data-message-id="${CSS.escape(r.anchor)}"]`,
        );
        if (!row) return false;
        const ok = scrollToMessage(r.anchor, {
          align: "start",
          behavior: "instant",
          scrollMargin: r.offset,
        });
        const off =
          row.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          r.offset;
        if (Math.abs(off) > 1) scrollTopInstant(element.scrollTop + off);
        return ok;
      };

      const pinNow = () => {
        syncPinnedAttr();
        if (held()) return;
        if (s.restore) {
          if (toRemembered()) {
            if (!s.hydrating) s.restore = null;
            return;
          }
          if (!s.hydrating) {
            s.restore = null;
            s.pinned = true;
          } else {
            return;
          }
        }
        if (!syncPinnedAttr()) return;
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
        if (Math.abs(element.scrollTop - max) > 0.5) {
          scrollTopInstant(max);
        }
      };

      pinActionRef.current = pinNow;

      let lastScrollInputAt = Number.NEGATIVE_INFINITY;
      let touchLastY: number | null = null;
      let seenTop = element.scrollTop;

      const detach = () => {
        s.pinned = false;
        s.restore = null;
        s.anchorHold = false;
        syncPinnedAttr();
      };

      const onWheel = (event: WheelEvent) => {
        lastScrollInputAt = performance.now();
        if (event.deltaY < 0) detach();
      };
      const onTouchStart = (event: TouchEvent) => {
        touchLastY = event.touches?.[0]?.clientY ?? null;
        lastScrollInputAt = performance.now();
      };
      const onTouchMove = (event: TouchEvent) => {
        lastScrollInputAt = performance.now();
        const y = event.touches?.[0]?.clientY;
        if (typeof y === "number" && touchLastY !== null) {
          const dy = y - touchLastY;
          touchLastY = y;
          // 手指向下拖 = 内容向上滚，脱离底部；手指向紧缩向上拖（滑向底部）不退出 pinned。
          if (dy > 2) detach();
          return;
        }
        detach();
      };
      const onTouchEnd = () => {
        touchLastY = null;
      };
      const onKey = (event: KeyboardEvent) => {
        lastScrollInputAt = performance.now();
        if (
          event.key === "ArrowUp" ||
          event.key === "PageUp" ||
          event.key === "Home" ||
          (event.key === " " && event.shiftKey)
        ) {
          detach();
        }
      };
      const onPointer = (event: PointerEvent) => {
        lastScrollInputAt = performance.now();
        // 按在滚动条上（视口自己，不是里面的消息）= 拖动滚动条脱离底部。
        if (event.target === element) detach();
      };
      const onDetachEvent = () => {
        detach();
      };
      const rootEl = element.parentElement;
      const onRootClick = (event: Event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(
            '[data-slot="message-scroller-button"][data-direction="end"]',
          )
        ) {
          s.restore = null;
          s.anchorHold = false;
          if (s.slackPx > 0) setSlack(0);
          s.pinned = true;
          lastScrollInputAt = performance.now();
          syncPinnedAttr();
        }
      };

      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const write = () => {
        saveTimer = null;
        if (
          !scrollKey ||
          s.hydrating ||
          !element.isConnected ||
          element.clientHeight === 0
        ) {
          return;
        }
        const gap =
          element.scrollHeight - element.scrollTop - element.clientHeight;
        if (gap <= 4) {
          setThreadUi(scrollKey, {
            scroll: {
              atBottom: true,
              spacer: s.slackPx,
              anchor: null,
              offset: 0,
              at: Date.now(),
            },
          });
          return;
        }
        const top = element.getBoundingClientRect().top;
        for (const row of content.querySelectorAll<HTMLElement>(
          "[data-message-id]",
        )) {
          const box = row.getBoundingClientRect();
          if (box.bottom > top + 1) {
            setThreadUi(scrollKey, {
              scroll: {
                atBottom: false,
                spacer: 0,
                anchor: row.dataset.messageId ?? null,
                offset: Math.round(box.top - top),
                at: Date.now(),
              },
            });
            return;
          }
        }
      };
      const save = () => {
        if (!scrollKey || saveTimer !== null) return;
        saveTimer = setTimeout(write, 200);
      };
      finalWrite.current = () => {
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = null;
        write();
      };

      const onScroll = () => {
        const currentTop = element.scrollTop;
        const gap = element.scrollHeight - currentTop - element.clientHeight;
        if (
          s.slackPx > 0 &&
          currentTop + element.clientHeight <
            element.scrollHeight - s.slackPx - 1
        ) {
          setSlack(0);
        }
        if (
          !s.pinned &&
          !s.restore &&
          !s.anchorHold &&
          !held() &&
          gap <= 4 &&
          (currentTop > seenTop + 0.5 ||
            performance.now() - lastScrollInputAt < 1500)
        ) {
          s.pinned = true;
        }
        seenTop = currentTop;
        syncPinnedAttr();
        save();
      };

      const sizes =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(pinNow);
      if (sizes) {
        try {
          sizes.observe(content, { box: "border-box" });
          sizes.observe(element, { box: "border-box" });
        } catch {
          sizes.observe(content);
          sizes.observe(element);
        }
      }

      /*
       * 「显示更早的消息」恢复锚点时底下不够滚（内容原本不够一屏）：在最后一条下面垫出差的那一截，
       * 「最底」就正好是正在看的行原来的位置（QA #519 r2 P2-1）。同步处理：补行方马上再恢复一次锚点。
       */
      const onAnchorSlack = (event: Event) => {
        const px = (event as CustomEvent<number>).detail;
        if (!(typeof px === "number" && px > 0)) return;
        event.preventDefault();
        setSlack(s.slackPx + px);
        s.anchorHold = true;
        s.pinned = false;
        syncPinnedAttr();
      };

      element.addEventListener("wheel", onWheel, { passive: true });
      element.addEventListener("touchstart", onTouchStart, { passive: true });
      element.addEventListener("touchmove", onTouchMove, { passive: true });
      element.addEventListener("touchend", onTouchEnd, { passive: true });
      element.addEventListener("touchcancel", onTouchEnd, { passive: true });
      element.addEventListener("keydown", onKey);
      element.addEventListener("pointerdown", onPointer);
      element.addEventListener("scroll", onScroll, { passive: true });
      element.addEventListener(TAIL_ANCHOR_SLACK_EVENT, onAnchorSlack);
      element.addEventListener(DETACH_PIN_EVENT, onDetachEvent);
      element.addEventListener(COMPOSER_INSET_SYNC_EVENT, pinNow);
      rootEl?.addEventListener("click", onRootClick);

      pinNow();

      return () => {
        pinActionRef.current = null;
        if (saveTimer !== null) clearTimeout(saveTimer);
        finalWrite.current = null;
        sizes?.disconnect();
        element.removeEventListener("wheel", onWheel);
        element.removeEventListener("touchstart", onTouchStart);
        element.removeEventListener("touchmove", onTouchMove);
        element.removeEventListener("touchend", onTouchEnd);
        element.removeEventListener("touchcancel", onTouchEnd);
        element.removeEventListener("keydown", onKey);
        element.removeEventListener("pointerdown", onPointer);
        element.removeEventListener("scroll", onScroll);
        element.removeEventListener(TAIL_ANCHOR_SLACK_EVENT, onAnchorSlack);
        element.removeEventListener(DETACH_PIN_EVENT, onDetachEvent);
        element.removeEventListener(COMPOSER_INSET_SYNC_EVENT, pinNow);
        rootEl?.removeEventListener("click", onRootClick);
      };
    },
  );

  return null;
}

/**
 * Decide, once per message, whether it waits its turn.
 *
 * FROZEN PER ID ON PURPOSE. `delay` is a prop on a memoised component, so a value that changed
 * between renders would break the memo that makes the streaming path cheap — and worse, a message
 * whose delay changed could replay its entrance mid-stream. Each id is decided the first time it is
 * seen and never revisited.
 *
 * `settled` flips after the first render that has any items, which is NOT the first render: history
 * is restored asynchronously, so a channel's transcript is empty for a beat. Anything appearing
 * after that is a live turn and is given no delay at all.
 */
function createFirstPaintDelays() {
  const decided = new Map<string, number>();
  const animated = new Map<string, boolean>();
  let settled = false;

  return {
    seedHistory(items: readonly { id: string }[], isOpening: boolean) {
      if (!settled || isOpening) {
        for (const item of items) {
          if (!decided.has(item.id)) {
            decided.set(item.id, 0);
            animated.set(item.id, false);
          }
        }
      }
    },
    settle() {
      settled = true;
    },
    delayFor(id: string, _index: number, _total: number): number {
      const known = decided.get(id);
      if (known !== undefined) {
        return known;
      }
      decided.set(id, 0);
      animated.set(id, settled);
      return 0;
    },
    animateFor(id: string): boolean {
      return animated.get(id) ?? false;
    },
  };
}

/**
 * A turn arriving in the transcript.
 *
 * WHY IT ANIMATES AT ALL: a message currently pops into existence at full opacity, and the eye has
 * nothing to follow from the composer to the transcript. This bridges that, and nothing more — it
 * is not decoration on something the reader is trying to read.
 *
 * IT RUNS ONCE, ON MOUNT. `initial`/`animate` fire when the element mounts, and the memoised parents
 * mean a streaming answer re-renders without remounting — so the fade plays when the message first
 * appears and never again while its text is still arriving. Animating per chunk would strobe.
 *
 * TRANSFORM AND OPACITY ONLY, so the scroller can still measure. `MessageScroller` sizes items and
 * places its anchor and spacer from layout; a transform is composited and changes no layout box, so
 * a message can fade in without moving the thing the scroller just measured.
 *
 * The full transform string rather than motion's `y` shorthand: the shorthand is not hardware
 * accelerated and drops frames exactly when the main thread is busy, which here is while a reply is
 * streaming.
 *
 * STAGGERED ONLY ON THE FIRST PAINT OF A CHANNEL. A turn sent mid-conversation arrives alone and
 * must not wait behind anything, so `delay` is zero for it. Opening a channel is the one moment the
 * whole history mounts at once, and cascading the last few reads as the conversation settling
 * rather than as a page appearing all at once. `createFirstPaintDelays` decides which is which.
 */
const ARRIVING_ANIMATE = { opacity: 1, y: 0 } as const;
const ARRIVING_INITIAL_PLAIN = { opacity: 0, y: 0 } as const;
const ARRIVING_INITIAL_SLIDE = { opacity: 0, y: 8 } as const;
const ARRIVING_ZERO_TRANSITION = {
  delay: 0,
  duration: ENTRANCE_SECONDS,
  ease: EASE_OUT,
} as const;

function ArrivingMotion({
  children,
  delay,
}: {
  children: React.ReactNode;
  delay: number;
}) {
  const shouldReduceMotion = useSharedReducedMotion();
  const transition = useMemo(
    () =>
      shouldReduceMotion || delay === 0
        ? ARRIVING_ZERO_TRANSITION
        : {
            delay,
            duration: ENTRANCE_SECONDS,
            ease: EASE_OUT,
          },
    [shouldReduceMotion, delay],
  );
  return (
    <motion.div
      animate={ARRIVING_ANIMATE}
      data-slot="message-arriving"
      className="flex w-full flex-col"
      initial={
        shouldReduceMotion ? ARRIVING_INITIAL_PLAIN : ARRIVING_INITIAL_SLIDE
      }
      transition={transition}
    >
      {children}
    </motion.div>
  );
}

function Arriving({
  animate = false,
  children,
  delay = 0,
}: {
  animate?: boolean | undefined;
  children: React.ReactNode;
  delay?: number;
}) {
  // 锁定首次挂载时的入场动画开关（同 bot-bubbles.tsx SegmentRow）：
  // 历史消息直接渲染普通 div（保留 data-slot="message-arriving" 维持右对齐选择器），
  // 消除数百条历史行的常驻 motion.div 实例、matchMedia 订阅与永久 translateY(0px) 合成层；
  // 实时新到消息走数值 y: 0 入场动画（动画结束后自动还原 transform: none），且不因后续 animate 变化重挂载正文。
  const useMotionRef = useRef(animate);
  if (!useMotionRef.current) {
    return (
      <div className="flex w-full flex-col" data-slot="message-arriving">
        {children}
      </div>
    );
  }
  return <ArrivingMotion delay={delay}>{children}</ArrivingMotion>;
}

/**
 * A turn a schedule asked for, drawn as the event it is.
 *
 * The frame around a firing is addressed to the model — see `shared/routine-firing.ts` — and it
 * reached the transcript wearing `role: "user"`, which drew it as a muted bubble on the right, in
 * the exact style of something the person typed. Somebody reading back through a channel found
 * three sentences of instructions to a model in their own voice, telling their Bot what it may not
 * do. For a product whose whole claim is that a Bot is a coworker you can hold to account, a record
 * that misattributes who said what is the one thing it cannot afford.
 *
 * So: start-aligned and muted, because this is not the person speaking; the clock, because that is
 * what a routine already is everywhere else in the app; and the instruction ALONE, because that is
 * the part a person wrote and the only part addressed to them.
 *
 * Two of the instructions a firing can carry are themselves model-facing envelopes — a
 * responsibility's turn (`shared/responsibility-turn.ts`) and a follow-up's wake message
 * (`shared/follow-up-turn.ts`). Those get their own folded rows: the part a person reads on the
 * line, the scaffolding behind "详情".
 */
function RoutineFiring({ instruction }: { instruction: string }) {
  const responsibility = readResponsibilityTurn(instruction);
  if (responsibility) {
    return <ResponsibilityFiring raw={instruction} turn={responsibility} />;
  }
  const followUp = readWakeUpTurn(instruction);
  if (followUp) {
    return <FollowUpFiring raw={instruction} turn={followUp} />;
  }
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-muted-foreground text-sm">
      <IconClock aria-hidden className="size-4 shrink-0 translate-y-0.5" />
      <span className="min-w-0">
        <span className="font-medium">{"定时任务已运行"}</span>{" "}
        <span className="whitespace-pre-wrap">{instruction}</span>
      </span>
    </div>
  );
}

/** `manual/requested` reads as "manual"; anything else keeps its event type beside the source. */
function describeTrigger(trigger: string): string {
  const [source, type] = trigger.split("/", 2);
  if (!type || type === "requested") return source ?? trigger;
  return `${source} · ${type}`;
}

/**
 * A responsibility's turn, drawn as the event it is.
 *
 * The message a responsibility sends its Bot carries the success criteria, the progress so far, the
 * trigger, the event payload in its untrusted envelope and a reminder naming the report tool — all
 * of it addressed to the model. Drawn inline, a person scrolling their conversation read a page of
 * scaffolding every time the responsibility ran. So the line says what happened and what the person
 * asked for, and the whole message sits behind "Details" for anyone checking what the Bot was told.
 */
function ResponsibilityFiring({
  raw,
  turn,
}: {
  raw: string;
  turn: { instruction: string; trigger: string };
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-muted-foreground text-sm">
      <IconClock aria-hidden className="size-4 shrink-0 translate-y-0.5" />
      <div className="min-w-0">
        <p>
          <span className="font-medium">{"长期任务已运行。"}</span> {"触发："}{" "}
          {describeTrigger(turn.trigger)}
        </p>
        <p className="whitespace-pre-wrap">{turn.instruction}</p>
        <details className="group mt-1">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {"详情"}
            <IconChevronDown
              aria-hidden
              className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs">{raw}</p>
        </details>
      </div>
    </div>
  );
}

/**
 * A follow-up the Bot scheduled for itself, fired — same folded shape as a responsibility's turn.
 *
 * The wake message is written to the model ("You scheduled this follow-up for yourself on
 * 2026-11-04T06:42Z. Your reason: … Pick it up now…"), so drawn inline a person read a page of
 * English scaffolding every time a reminder went off. The line keeps the two parts a person can
 * use — why the Bot wanted to come back and what it meant to do — and the whole message sits
 * behind "详情".
 */
function FollowUpFiring({
  raw,
  turn,
}: {
  raw: string;
  turn: { scheduledAt: string; reason: string; instruction: string };
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-muted-foreground text-sm">
      <IconClock aria-hidden className="size-4 shrink-0 translate-y-0.5" />
      <div className="min-w-0">
        <p>
          <span className="font-medium">{"定时任务已运行。"}</span>{" "}
          {turn.reason}
        </p>
        {turn.instruction ? (
          <p className="whitespace-pre-wrap">{turn.instruction}</p>
        ) : null}
        <details className="group mt-1">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {"详情"}
            <IconChevronDown
              aria-hidden
              className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs">{raw}</p>
        </details>
      </div>
    </div>
  );
}

/**
 * One drawn message, and it is memoised on PRIMITIVES ON PURPOSE.
 *
 * A streamed answer changes `messages` on every chunk, and `toVisibleChatItems` builds fresh objects
 * from it each time — so a memo comparing item objects would miss on every single one and buy
 * nothing. Passing role and text means an untouched message compares equal and is skipped.
 *
 * MEASURED, BEFORE AND AFTER. One reply into a 25-message thread cost 76 transcript renders and
 * 1,890 message renders, because every message in the history re-parsed its markdown on every
 * chunk. That is the jank: the scroll was following a list that rebuilt itself 76 times.
 *
 * It is also what keeps the entrance honest — no remount means no replay of the fade.
 */
/** 正文里的 Markdown 图片不内联画，统一进气泡下面的图片卡 / 一摞（DESIGN.md §31）。 */
const richMarkdownComponents = {
  ...markdownComponents,
  img: HiddenMarkdownImage,
};

export type MemoryPillItem = {
  id: string;
  noteId?: string | undefined;
  summary: string;
  kind?: string | undefined;
  subject?: string | undefined;
  action: "save" | "update" | "log";
};

function splitUserQuote(raw: string): {
  quote?: string | undefined;
  body: string;
} {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let q = 0;
  while (q < lines.length && /^\s{0,3}>\s?/.test(lines[q] ?? "")) q++;
  if (q > 0 && q < lines.length) {
    const quote = lines
      .slice(0, q)
      .map((l) => l.replace(/^\s{0,3}>\s?/, ""))
      .join(" ")
      .trim();
    const rest = lines.slice(q);
    while (rest.length && !rest[0]?.trim()) rest.shift();
    if (quote && rest.length) {
      return { quote: quote.slice(0, 140), body: rest.join("\n") };
    }
  }
  return { body: raw };
}

function QuoteReplyAction({
  text,
  messageId,
  role,
}: {
  text: string;
  messageId?: string | undefined;
  role: "user" | "assistant";
}) {
  return (
    <button
      aria-label="引用追问"
      className="chat-msg-action"
      data-testid="msg-quote-reply"
      onClick={() => {
        const clean = text
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 110);
        if (!clean) return;
        dispatchComposerQuote({
          text: clean,
          messageId,
          source: role === "user" ? "我的消息" : "机器人回复",
        });
      }}
      title="引用此消息继续追问"
      type="button"
    >
      <IconMessageReply className="size-3.5" />
      <span>{"引用"}</span>
    </button>
  );
}

const KIND_LABELS: Record<string, string> = {
  preference: "偏好",
  fact: "事实",
  decision: "决定",
  todo: "待办",
  log: "日志",
};

function MemoryPills({ items }: { items: readonly MemoryPillItem[] }) {
  const [active, setActive] = useState<MemoryPillItem | null>(null);
  const shownActive = useRetainedValue(active);
  const [undoneIds, setUndoneIds] = useState<Record<string, boolean>>({});
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  if (items.length === 0) return null;

  const handleUndo = async (item: MemoryPillItem) => {
    setUndoBusy(true);
    setUndoError(null);
    try {
      if (item.noteId?.startsWith("mem_")) {
        await forgetMemoryNote(item.noteId);
      }
      setUndoneIds((prev) => ({ ...prev, [item.id]: true }));
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : "撤销失败");
    } finally {
      setUndoBusy(false);
    }
  };

  return (
    <>
      <div className="chat-memory-pills" data-testid="memory-pills">
        {items.map((item) => {
          const isUndone = Boolean(undoneIds[item.id]);
          return (
            <button
              className="chat-memory-pill"
              data-testid="memory-pill"
              data-undone={isUndone || undefined}
              key={item.id}
              onClick={() => setActive(item)}
              type="button"
            >
              <IconSparkles
                aria-hidden="true"
                className="size-3.5 shrink-0 text-amber-400"
              />
              <span className="chat-memory-pill-text truncate">
                {isUndone
                  ? `已撤销记忆：${item.summary}`
                  : `已记住：${item.summary}`}
              </span>
              <span className="chat-memory-pill-cta">
                {isUndone ? "已撤销" : "点击查看/撤销"}
              </span>
            </button>
          );
        })}
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setActive(null);
            setUndoError(null);
          }
        }}
        open={active !== null}
      >
        {shownActive ? (
          <DialogContent className="max-w-md" data-testid="memory-pill-dialog">
            <div className="flex items-center gap-2 pb-2">
              <IconSparkles
                aria-hidden="true"
                className="size-4 text-amber-400"
              />
              <DialogTitle className="text-base">{"记忆写入详情"}</DialogTitle>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-2 py-0.5 font-medium text-foreground">
                  {KIND_LABELS[shownActive.kind ?? "fact"] ?? "记忆"}
                </span>
                {shownActive.subject ? (
                  <span className="rounded-md bg-muted/60 px-2 py-0.5">
                    {`对象：${shownActive.subject}`}
                  </span>
                ) : null}
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5 leading-relaxed text-foreground">
                {shownActive.summary}
              </div>
              <div className="flex items-center justify-between pt-2">
                {/*
                 * 用路由内跳转，并先关掉弹窗（CB-106）。原来是 <a href>：在打开的模态弹窗里整页重载，
                 * 整个应用（对话、会话客户端 连接、几千条记忆）从头再来一遍，s2 里这一下把标签页拖崩过。
                 */}
                <Link
                  className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  data-testid="memory-manage-link"
                  onClick={() => setActive(null)}
                  to="/settings/memory"
                >
                  {"管理全部长期记忆 →"}
                </Link>
                {undoneIds[shownActive.id] ? (
                  <span
                    className="text-xs font-medium text-emerald-400"
                    data-testid="memory-undone-status"
                  >
                    {"✓ 已从长期记忆中撤销"}
                  </span>
                ) : (
                  <button
                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50"
                    data-testid="memory-undo-btn"
                    disabled={undoBusy}
                    onClick={() => void handleUndo(shownActive)}
                    type="button"
                  >
                    <IconTrash className="size-3.5" />
                    <span>{undoBusy ? "正在撤销…" : "撤销此记忆"}</span>
                  </button>
                )}
              </div>
              {undoError ? (
                <p
                  className="text-xs text-destructive"
                  data-testid="memory-undo-error"
                  role="alert"
                >
                  {undoError}
                </p>
              ) : null}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

type TranscriptMessageProps = {
  animate?: boolean | undefined;
  /** 这是最后一轮的回答：下面带「重新生成」（DESIGN.md §67）。 */
  canRegenerate?: boolean;
  commandNames?: string;
  delay: number;
  /** 用户自己发的一条：下面带「编辑」，点了气泡原地变编辑框（DESIGN.md §67）。 */
  editable?: boolean;
  attachments?: readonly SentAttachment[] | undefined;
  memories?: readonly MemoryPillItem[] | undefined;
  messageId?: string;
  /** Hark 式回复引用（`╭─` + 原话胶囊）：多条消息插话或跨步骤回应时指向对应的用户消息。 */
  replyToId?: string | undefined;
  replyToText?: string | undefined;
  role: "user" | "assistant";
  text: string;
  /** compactTurns：开场一句 / 过程话 / 结果。过程话画成一行淡色小字，开场和过程都没有复制。 */
  tone?: "lead" | "step" | "final" | undefined;
};

function sameSentAttachments(
  a: readonly SentAttachment[] | undefined,
  b: readonly SentAttachment[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  return a.every((attachment, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      attachment.id === other.id &&
      attachment.attachmentId === other.attachmentId &&
      attachment.url === other.url &&
      attachment.filename === other.filename &&
      attachment.modality === other.modality &&
      attachment.width === other.width &&
      attachment.height === other.height
    );
  });
}

function toEditableAttachments(
  attachments: readonly SentAttachment[] | undefined,
): EditableAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const items: EditableAttachment[] = [];
  for (const attachment of attachments) {
    const colon = attachment.id.lastIndexOf(":");
    const partIndex = colon >= 0 ? Number(attachment.id.slice(colon + 1)) : NaN;
    if (!Number.isInteger(partIndex) || partIndex < 0) continue;
    items.push({
      partIndex,
      label:
        attachment.filename ??
        (attachment.modality === "image" ? "图片附件" : "文件附件"),
    });
  }
  return items.length > 0 ? items : undefined;
}

function sameMemories(
  a: readonly MemoryPillItem[] | undefined,
  b: readonly MemoryPillItem[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      item.id === other.id &&
      item.noteId === other.noteId &&
      item.summary === other.summary &&
      item.kind === other.kind &&
      item.subject === other.subject &&
      item.action === other.action
    );
  });
}

function sameTranscriptMessage(
  prev: TranscriptMessageProps,
  next: TranscriptMessageProps,
): boolean {
  return (
    prev.animate === next.animate &&
    prev.canRegenerate === next.canRegenerate &&
    prev.commandNames === next.commandNames &&
    prev.delay === next.delay &&
    prev.editable === next.editable &&
    prev.messageId === next.messageId &&
    prev.replyToId === next.replyToId &&
    prev.replyToText === next.replyToText &&
    prev.role === next.role &&
    prev.text === next.text &&
    prev.tone === next.tone &&
    sameSentAttachments(prev.attachments, next.attachments) &&
    sameMemories(prev.memories, next.memories)
  );
}

const LiveBotBubbles = memo(function LiveBotBubbles({
  animate,
  delay,
  messageId,
  replyToId,
  replyToText,
  text,
  tone,
}: {
  animate?: boolean | undefined;
  delay?: number | undefined;
  messageId?: string | undefined;
  replyToId?: string | undefined;
  replyToText?: string | undefined;
  text: string;
  tone?: "lead" | "final" | undefined;
}) {
  const scope = useConversationScope();
  const live = useLiveMessageText(scope?.threadId, messageId, text);
  return (
    <BotBubbles
      animate={animate}
      components={richMarkdownComponents}
      delay={delay}
      replyToId={replyToId}
      replyToText={replyToText}
      streaming={live.streaming}
      text={live.text}
      tone={tone}
    />
  );
});

const TranscriptMessage = memo(function TranscriptMessage({
  animate = false,
  attachments,
  canRegenerate = false,
  commandNames = "",
  delay,
  editable = false,
  memories,
  messageId,
  replyToId,
  replyToText,
  role,
  text,
  tone,
}: TranscriptMessageProps) {
  const [editing, setEditing] = useState(false);
  const isUser = role === "user";
  // Visible assistant text always uses the same bubbles, including a live or interrupted
  // intermediate message. compactTurns owns whether narration is folded into the work row.
  /*
   * Checked before anything else a person's message gets. A firing is not a person's message: the
   * chip split, the end alignment and the bubble are all wrong for it, and each one of them would
   * have to learn about firings separately if this branched any later.
   */
  if (isUser && serverRowKind(text) !== null) {
    return (
      <MessageRow align="start">
        <MessageContent className="w-full">
          <Arriving animate={animate} delay={delay}>
            <ServerRow messageId={messageId ?? ""} text={text} />
          </Arriving>
        </MessageContent>
      </MessageRow>
    );
  }
  const firing = isUser ? readFiring(text) : null;
  if (firing !== null) {
    return (
      <MessageRow align="start">
        <MessageContent>
          <Arriving animate={animate} delay={delay}>
            <RoutineFiring instruction={firing} />
          </Arriving>
        </MessageContent>
      </MessageRow>
    );
  }
  const align = isUser ? "end" : "start";
  // Slack/Teams turns carry a model-facing participant line; show a marker instead of the line.
  const origin = isUser ? splitChatOrigin(text) : null;
  const rawSaid = origin ? origin.text : text;
  const userQuoteSplit = isUser ? splitUserQuote(rawSaid) : { body: rawSaid };
  const said = userQuoteSplit.body;
  const invoked = isUser ? splitSkillChip(said, commandNames) : null;

  if (isUser && editing && messageId) {
    return (
      <MessageRow align={align}>
        <MessageContent className="w-full">
          <MessageEditor
            attachments={toEditableAttachments(attachments)}
            initial={rawSaid}
            messageId={messageId}
            onClose={() => setEditing(false)}
          />
        </MessageContent>
      </MessageRow>
    );
  }

  return (
    <MessageRow align={align}>
      <MessageContent>
        <Arriving animate={animate} delay={delay}>
          {/*
            A Bot's message takes the whole column, not the width of its words: block content
            inside it — a fenced code block, a table — should span the transcript rather than
            shrink to its own text. A person's bubble keeps fitting what they said.
          */}
          {/*
            机器人的回复按段画成几个短气泡（DESIGN.md §69 BotBubbles）：短段落贴着文字宽度，表格 / 代码 /
            清单 / 草稿整列宽。下面这个 Bubble 现在只画人的消息。
          */}
          {!isUser ? (
            <LiveBotBubbles
              animate={animate}
              delay={delay}
              messageId={messageId}
              replyToId={replyToId}
              replyToText={replyToText}
              text={text}
              tone={tone === "lead" ? "lead" : "final"}
            />
          ) : (
            <>
              {userQuoteSplit.quote ? (
                <ReplyQuote align="end" text={userQuoteSplit.quote} />
              ) : null}
              <Bubble
                data-cb-turn={isUser ? undefined : tone}
                align={align}
                variant={isUser ? "muted" : "ghost"}
                className={isUser ? undefined : "w-full"}
              >
                <BubbleContent className={isUser ? undefined : "w-full"}>
                  {isUser ? (
                    // A person's own message is shown exactly as they typed it. Rendering it as markdown
                    // would silently reformat what they said, and an asterisk in a sentence is not
                    // emphasis. The chip is the one exception, and it is not reformatting: it is drawing
                    // the thing that was already a chip in the composer as a chip here too, so the
                    // transcript shows a skill was used rather than a slash that was typed.
                    // "Exactly as typed" includes the glyphs: Inter's contextual alternates (calt) would
                    // draw the "x" in an id like BV1GJ411x7h7 as a multiplication sign.
                    <span className="whitespace-pre-wrap [font-feature-settings:'calt'_0]">
                      {origin && (
                        <span className="mr-1.5 inline-flex items-center rounded bg-foreground/10 px-1.5 py-0.5 align-middle text-foreground/70 text-xs">
                          {"通过"}
                          {origin.via}
                        </span>
                      )}
                      {invoked ? (
                        <>
                          {/*
                           * The same icon the sidebar uses for Skills, so the badge says WHAT KIND of
                           * thing was invoked before it says which one. `inline-flex` with
                           * `align-middle` rather than a block: this sits mid-sentence, and a badge that
                           * breaks the line it is in reads as a separate message.
                           */}
                          <span className="mr-1 inline-flex items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 align-middle font-mono text-foreground/80 text-xs">
                            <IconBox className="size-3 shrink-0" />/
                            {invoked.chip}
                          </span>
                          {invoked.rest}
                        </>
                      ) : (
                        said
                      )}
                    </span>
                  ) : (
                    <RichBotStreamdown
                      components={richMarkdownComponents}
                      text={text}
                    />
                  )}
                </BubbleContent>
              </Bubble>
            </>
          )}
          {/*
            链接卡 / 图片一摞（DESIGN.md §31）。开场一句也要带：正文里出卡的链接行已经拿掉了（useDisplayText），
            不画卡这行链接就没了；流式时第一段一直是「开场」，以前要等写完才一下子冒出卡片。
          */}
          <MessageRichPreviews align={align} text={isUser ? said : text} />
          {!isUser && memories && memories.length > 0 ? (
            <MemoryPills items={memories} />
          ) : null}
          {isUser && messageId ? <ReadMark messageId={messageId} /> : null}
          {isUser ? (
            editable && messageId ? (
              <div className="chat-msg-actions" data-align="end">
                {/* biome-ignore lint/a11y/useValidAriaRole: role 是组件自己的 prop（消息作者），不是 ARIA role */}
                <QuoteReplyAction
                  messageId={messageId}
                  role="user"
                  text={said}
                />
                <EditAction onEdit={() => setEditing(true)} />
                <WithdrawAction messageId={messageId} />
              </div>
            ) : null
          ) : !text.trim() ? null : tone === "lead" ? (
            canRegenerate ? (
              <div className="chat-msg-actions">
                {/* biome-ignore lint/a11y/useValidAriaRole: role 是组件自己的 prop（消息作者），不是 ARIA role */}
                <QuoteReplyAction
                  messageId={messageId}
                  role="assistant"
                  text={text}
                />
                <RegenerateAction />
              </div>
            ) : null
          ) : (
            <CopyMessage
              messageId={messageId}
              text={text}
              extra={canRegenerate ? <RegenerateAction /> : null}
            />
          )}
        </Arriving>
      </MessageContent>
    </MessageRow>
  );
}, sameTranscriptMessage);

/** 由 ChatTranscript 顶层单次查询下发 TTS 可用态，避免每条助手消息各自挂独立 QueryObserver。 */
const TtsReadyContext = createContext(false);

/** A quiet copy action under a Bot's answer; shows on hover, always reachable by keyboard. */
function CopyMessage({
  text,
  messageId,
  extra,
}: {
  text: string;
  messageId?: string | undefined;
  extra?: React.ReactNode;
}) {
  const ttsReady = useContext(TtsReadyContext);
  const copy = useAsyncAction(() => writeClipboard(text), {
    errorToast: "复制失败，请手动选择文本复制。",
  });
  const label = {
    idle: "复制",
    pending: "复制",
    success: "已复制",
    error: "复制失败",
  }[copy.state];
  return (
    <div className="chat-msg-actions">
      <button
        aria-label={copy.state === "idle" ? "复制回答" : label}
        className="chat-msg-action"
        data-btn-state={copy.state}
        onClick={() => void copy.run()}
        type="button"
      >
        {/* Same morphing glyph as Button: the copy icon gives way to ring → ✓ / ✕. */}
        <span className="btn-stack" data-state={copy.state}>
          <span className="btn-face" data-face="idle">
            <IconCopy className="size-3.5" />
          </span>
          <span className="btn-face" data-face="status">
            <StatusGlyph />
          </span>
        </span>
        {/* Visual stack only — accessible name is the single live aria-label above. */}
        <span aria-hidden="true" className="btn-labels">
          {(["idle", "success", "error"] as const).map((key) => (
            <span
              data-for={key}
              key={key}
              style={{
                opacity:
                  (copy.state === "pending" ? "idle" : copy.state) === key
                    ? 1
                    : 0,
              }}
            >
              {{ idle: "复制", success: "已复制", error: "复制失败" }[key]}
            </span>
          ))}
        </span>
      </button>
      {/* biome-ignore lint/a11y/useValidAriaRole: role 是组件自己的 prop（消息作者），不是 ARIA role */}
      <QuoteReplyAction messageId={messageId} role="assistant" text={text} />
      {ttsReady ? (
        <SpeakAction messageId={messageId ?? "msg"} text={text} />
      ) : null}
      {extra}
    </div>
  );
}

/**
 * The one shape an attachment url is allowed to have, taken from the helper that builds it rather
 * than written out again, so the check cannot drift from the route that serves the file.
 */
const ATTACHMENT_URL_PREFIX = attachmentUrl("");

/**
 * THE FILES A PERSON ATTACHED TO ONE TURN, drawn as a row where their own message would be.
 *
 * ALWAYS THE PERSON'S OWN, so it aligns end like their bubble does — `toVisibleChatItems` only ever
 * produces this kind from a user turn's content, and there is no assistant equivalent to confuse it
 * with. `justify-end` is what actually puts a short row against the right edge; `align="end"` gets
 * the row there, not the tiles inside it.
 *
 * SQUARE, AND ALL THE SAME SIZE. Three photos of different shapes drawn at their own aspect ratios
 * make a ragged row whose only signal is which camera took what, and a single tall screenshot drawn
 * at its own aspect pushed the rest of the turn off the screen. A grid of equal tiles says "three
 * files" at a glance, which is the thing worth saying here; the picture itself is one click away.
 */
type AttachmentRowProps = {
  attachments: readonly SentAttachment[];
  delay: number;
  messageId?: string | undefined;
  standalone?: boolean | undefined;
};

/**
 * Whether two renders of this row are the same row, compared BY VALUE because identity says no
 * every time.
 *
 * `toVisibleChatItems` runs on every render of the transcript — deliberately, and the comment on
 * that call says why: the agent hands back the same array and mutates it, so a `useMemo` over it
 * never invalidates and a reply never appears. The price is that `attachments` is a fresh array of
 * fresh objects on every chunk of a streaming answer, and `memo`'s default `Object.is` on two
 * different arrays is false however identical they are. So this memo missed EVERY time, and every
 * tile in a channel's history — each one carrying an image `Dialog` — re-rendered on every token
 * of an answer being typed further down. The memoised message rows above it were paying for this
 * one's misses.
 *
 * Field by field, because the fields are what the tiles draw: a row whose files have the same ids,
 * urls, names and kinds in the same order draws exactly the same pixels.
 *
 * Exported so it can be checked without mounting anything, the same reason `isPersonSentMessage`
 * is.
 */
export function sameAttachmentRow(
  previous: AttachmentRowProps,
  next: AttachmentRowProps,
): boolean {
  if (
    previous.delay !== next.delay ||
    previous.messageId !== next.messageId ||
    previous.standalone !== next.standalone
  ) {
    return false;
  }
  return sameSentAttachments(previous.attachments, next.attachments);
}

export const TranscriptAttachments = memo(function TranscriptAttachments({
  attachments,
  delay,
  messageId,
  standalone = false,
}: AttachmentRowProps) {
  const [editing, setEditing] = useState(false);
  if (standalone && editing && messageId) {
    return (
      <MessageRow align="end">
        <MessageContent className="w-full">
          <MessageEditor
            attachments={toEditableAttachments(attachments)}
            initial=""
            messageId={messageId}
            onClose={() => setEditing(false)}
          />
        </MessageContent>
      </MessageRow>
    );
  }
  return (
    <MessageRow align="end">
      <MessageContent>
        <Arriving delay={delay}>
          <AttachmentTiles attachments={attachments} />
          {standalone && messageId ? (
            <>
              <ReadMark messageId={messageId} />
              <div className="chat-msg-actions" data-align="end">
                <EditAction onEdit={() => setEditing(true)} />
                <WithdrawAction messageId={messageId} />
              </div>
            </>
          ) : null}
        </Arriving>
      </MessageContent>
    </MessageRow>
  );
}, sameAttachmentRow);

/**
 * The tiles themselves, as one row.
 *
 * Its own component because the QUEUE draws this row too, faded, for a message parked mid-turn —
 * and two copies of a list of tiles is two places for the alignment below to be got right.
 *
 * `self-end` because `align="end"` does not reach this far on its own: both callers put this
 * inside a `flex w-full flex-col` — `Arriving` for a sent turn, `MessageContent` for a parked one —
 * so a block child stretches to the transcript's full width and its contents draw hard against the
 * LEFT edge, under the person's own right-aligned bubble, reading as though the Bot had sent them.
 * `Bubble` escapes this because it carries its own `group-data-[align=end]/message:self-end`.
 */
function AttachmentTiles({
  attachments,
  className,
}: {
  attachments: readonly SentAttachment[];
  className?: string;
}) {
  /*
   * 本站的图片收成一张图卡 / 一摞（点开看大图：左右切换、缩放、下载，DESIGN.md §31）；文件和不可用的
   * 附件仍是一格一格。哪张图读不出来，它自己从一摞里退出。
   */
  const pictures = attachments.filter(
    (attachment) =>
      attachment.modality === "image" &&
      attachment.url.startsWith(ATTACHMENT_URL_PREFIX),
  );
  const rest = attachments.filter(
    (attachment) => !pictures.includes(attachment),
  );
  /*
   * 一摞 / 单张里画的是缩略图（`?w=` 档位，服务器用 sharp 缩成 WebP），点开看大图仍是原图（`src`）。
   * 单张最宽 320px、一摞里的卡片 220px（styles.css「图片：单张 / 一摞」），按屏幕像素密度挑够清楚的最小一档。
   */
  const thumbWidth = pickAttachmentThumbWidth(
    pictures.length === 1 ? 320 : 220,
    typeof window === "undefined" ? 1 : window.devicePixelRatio,
  );
  return (
    <ul
      className={cn(
        "flex w-full max-w-full flex-wrap items-start justify-end gap-2 self-end [container-type:inline-size]",
        className,
      )}
    >
      {pictures.length > 0 ? (
        <li className="w-full max-w-full" key="pictures">
          <ImagePile
            align="end"
            images={pictures.map((picture) => ({
              src: picture.url,
              thumb: attachmentThumbUrl(picture.url, thumbWidth),
              ...(picture.filename
                ? { name: picture.filename, alt: `附件：${picture.filename}` }
                : { alt: "附件" }),
              ...(picture.width && picture.height
                ? { width: picture.width, height: picture.height }
                : {}),
            }))}
          />
        </li>
      ) : null}
      {rest.map((attachment) => (
        <li key={attachment.id}>
          <SentAttachmentTile attachment={attachment} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One tile in that row, and all three shapes are the same size on purpose.
 *
 * A document used to draw as a `ToolLine`, which was the right call while an attachment was a row
 * of its own: that component is one line for one thing a Bot did, and a filename beside a label is
 * exactly that shape. It is the wrong thing inside a ROW. `ToolLine` has no width of its own, so
 * two documents and a photo came out as a pair of bare sentences stretched across the empty half of
 * the line with the picture stranded at the end — the same tiles, laid out as if they were prose.
 *
 * So a document gets a card the height of a thumbnail instead. What the row is saying is "these
 * files came with this message", and it can only say it if every tile in it reads as a file.
 *
 * A BROKEN-IMAGE GLYPH SAYS NOTHING TO THE READER — the browser's placeholder tells them a box
 * failed to load, not that a file is gone. `onError` catches that and swaps it for a sentence in the
 * file's own name, in the same destructive vocabulary `Stopped` already uses for "the thing that was
 * supposed to be here isn't." It borrows the LOOK and not the urgency: see the missing tile below
 * for why the same absence is a note here and an alert there.
 */
/**
 * The probes currently outstanding, so that two tiles asking the same question ask it once.
 *
 * ONE TURN CAN CARRY THE SAME FILE TWICE — `toVisibleChatItems` keys tiles on the PART index
 * precisely so that it can — and a message parked mid-turn draws its files a second time beside the
 * sent row while the queue holds it. Each of those tiles mounts its own effect, and each one used
 * to send its own request for an answer that is the same by construction.
 *
 * WHAT THAT SHARING IS WORTH, CORRECTED. This comment used to say a duplicate probe was "a
 * duplicate megabyte read, not a duplicate status line", because at the time a HEAD reached a
 * handler whose single statement selected `attachments.bytes`. It does not any more: the route
 * grew a branch that answers a HEAD from `name, mimeType, sizeBytes` and never touches the bytes.
 * A duplicate probe is now exactly the duplicate status line this once said it was not.
 *
 * IT STILL EARNS ITS KEEP, FOR A REASON THAT DOES NOT DEPEND ON THE OLD COST. Nothing else in the
 * stack will coalesce these: the route serves `private, no-cache`, so the browser's HTTP cache is
 * required to revalidate every probe rather than answer one from the other, and two tiles for one
 * file are two components with two effects and no knowledge of each other. Without this map the
 * same question goes over the wire once per tile, every time the transcript mounts. It is a dozen
 * lines to ask it once, and cheap-per-answer is not the same as free-per-answer.
 *
 * IN FLIGHT ONLY, AND DELIBERATELY NOT A CACHE OF THE ANSWERS — and THIS is the half the old cost
 * model was never holding up. Holding onto "this file is still there" across remounts is exactly
 * the lie this hook exists to stop: a file deleted while the reader has the app open would go on
 * drawing as an intact card for as long as the tab lived, which is the "worse of the two lies" the
 * comment below names. That was the argument then and it is the whole argument now. Holding onto
 * "this file is GONE" is sound, deletion being terminal, but it buys nothing worth the branch.
 */
type DocumentProbe = { missing: boolean; size: number | null };
const probesInFlight = new Map<string, Promise<DocumentProbe>>();

/**
 * Asks the route whether this file is missing, and answers the SAME question only once at a time.
 *
 * Resolves true for 404 and false for every other answer; a fetch that never arrives rejects, and
 * the caller declines to draw a conclusion from it.
 */
function probeDocument(url: string): Promise<DocumentProbe> {
  const existing = probesInFlight.get(url);
  if (existing) return existing;

  // 同一个 HEAD 顺便读 content-length，文件卡显示大小，不再另发一次请求（DESIGN.md §31）。
  const probe = probeRemoteFile(url).finally(() => {
    // Cleared however it settled, so the next mount asks again rather than inheriting an answer
    // that has had time to stop being true.
    probesInFlight.delete(url);
  });

  probesInFlight.set(url, probe);
  return probe;
}

/**
 * Whether the row behind a document has been deleted, asked of the server that serves it.
 *
 * A DOCUMENT HAS NO OTHER WAY TO FIND OUT. The picture beside it learns its file is gone by
 * fetching it: the `<img>` requests the url, the route answers 404, and `onError` fires. A document
 * tile is a filename and a label — it requests nothing, so no event about the file can ever reach
 * it — and `failedToLoad` was the only thing feeding the absent branch. A deleted document
 * therefore kept drawing as an intact card naming a file the server was answering 404 for, which
 * is the worse of the two lies: a broken picture at least looks broken.
 *
 * `HEAD` because the question is whether the row exists and the status line is the whole answer, so
 * the reader is not made to download a PDF to learn it is still there. AND IT IS NOW CHEAP ON THE
 * SERVER TOO, WHICH IT ONCE WAS NOT AND WHICH THIS COMMENT WENT ON ASSERTING AFTER IT STOPPED BEING
 * TRUE. The old paragraph was right about the mechanism — Hono does answer a HEAD by dispatching
 * the GET handler in full and dropping the body at the last step — and it concluded that the server
 * therefore still read the whole file out of Postgres, and that a route which could answer "is it
 * there" without the bytes "is not this file's to write". Somebody wrote it. The attachment route
 * now branches on the method INSIDE the handler Hono actually dispatches, selects `sizeBytes`
 * instead of `bytes`, and sets `Content-Length` by hand; the access join, the statuses and the
 * revalidation are the GET's exactly, so a probe still learns nothing a fetch would not tell you.
 *
 * That is recorded here rather than quietly deleted because this file spent two review rounds being
 * read as evidence that the cheap probe did not exist. A comment describing a path as broken, about
 * a path that works, costs more than no comment at all.
 *
 * A REQUEST THAT NEVER ARRIVED IS NOT A DELETED FILE, so a rejected fetch — offline, a dropped
 * connection, a proxy in the way — leaves the card alone rather than accusing the server of having
 * lost somebody's file.
 *
 * AND NEITHER IS A REQUEST THE SERVER REFUSED, which is the same rule and was the bug. This asked
 * `!response.ok`, which is every status outside 200-299, when exactly one of them means what the
 * tile then says. The route collapses "no such row", "channel deleted" and "not a channel of
 * yours" into 404 precisely so that probing ids learns nothing — that is the one status that means
 * "there is no file here for you". Everything else is a fact about the request:
 *
 *   - 401 is a session that expired while the channel sat open, and it turned EVERY document tile
 *     in the transcript into a red card asserting, in each file's own name, that somebody's files
 *     had been deleted. Nothing had been; they need to sign in again.
 *   - 500 is a bad moment on the server, and it stuck: the deps below are stable, so nothing asks
 *     again and the accusation stands until the component remounts.
 *   - 304 is the strongest proof of PRESENCE this route can give — the row was found AND the
 *     membership join passed — and `Response.ok` is false for it.
 *
 * That is the same lie this hook exists to stop, pointing the other way, and it is the louder one:
 * drawn in the destructive vocabulary, naming the file. So absence is claimed on 404 alone, which
 * also puts a document back in step with the picture beside it — an `<img>` handed a 401 shows a
 * broken image, not a sentence swearing the file was deleted.
 */
function useDocumentIsGone(
  url: string,
  ask: boolean,
): { gone: boolean; size: number | null } {
  const [gone, setGone] = useState(false);
  const [size, setSize] = useState<number | null>(null);

  useExternalConnection(
    ask ? url || "__empty__" : false,
    (_activeKey, signal) => {
      // A tile reused at the same position for a different file starts the question over rather than
      // inheriting the previous file's answer.
      setGone(false);

      void probeDocument(url)
        .then(({ missing, size: bytes }) => {
          if (!signal.aborted && missing) {
            setGone(true);
          }
          if (!signal.aborted && bytes !== null) setSize(bytes);
        })
        .catch(() => {
          // Deliberately nothing: see above. Not knowing is not the same as knowing it is gone.
        });
    },
  );

  return { gone, size };
}

export function isServableAttachmentUrl(url: string): boolean {
  return (
    url.startsWith(ATTACHMENT_URL_PREFIX) ||
    url.startsWith(CHAT_FILE_URL_PREFIX)
  );
}

function SentAttachmentTile({ attachment }: { attachment: SentAttachment }) {
  const [failedToLoad, setFailedToLoad] = useState(false);
  const { filename, modality, url } = attachment;
  /*
   * An off-site url is treated as a missing file, whatever kind of file it says it is.
   *
   * `toVisibleChatItems` passes on whatever a `url` source carried, and nothing between here and
   * the wire narrows it. A sent message only ever carries the relative form — `shared/attachments.ts`
   * says the url "is never fetched by a provider", and 服务端的附件解析器 swaps the source for the bytes
   * as the run is built — so an absolute url arriving here did not come from this app's composer,
   * and putting it in `src` would have the reader's browser fetch a third party the instant the
   * transcript drew, announcing to whoever owns it that this person opened this channel.
   */
  const servable = isServableAttachmentUrl(url);
  /*
   * ONLY OURS IS EVER ASKED ABOUT, and that is the same rule as the line above rather than a second
   * one: a probe is a request like any other, so asking a third party whether a file is still there
   * announces the reader exactly as fetching it would. An off-site url is already unavailable
   * without anybody being asked.
   */
  const { gone, size } = useDocumentIsGone(
    url,
    servable && modality === "document",
  );
  const unavailable = failedToLoad || gone || !servable;

  /*
   * ABSENCE IS DECIDED BEFORE MODALITY IS, and that ordering is the whole point of this block
   * sitting above the document card rather than below it. A document whose url is not ours to
   * serve, or whose row `useDocumentIsGone` found deleted, drew as an intact card naming a file
   * that is not there. A missing picture at least looked missing; a missing document looked
   * present. Whether the file can be shown at all is the first question either kind asks.
   */
  if (unavailable) {
    return (
      /*
       * `note`, NOT `alert`, AND THE DIFFERENCE IS WHO IS INTERRUPTED. An alert is an assertive
       * live region: it cuts across whatever a screen reader is saying the moment it appears. That
       * is right for `Stopped`, which reports something that just happened in answer to what
       * somebody did, and wrong for every one of these — a transcript with three deleted files
       * fired three interruptions on mount, before the reader had heard a word of the conversation,
       * to report absences that predate their opening the channel.
       *
       * `note` is not a live region at all, so nothing is announced over anything; it still marks
       * the tile as a thing to stop on, and the sentence inside it — unchanged, in the file's own
       * name — is what says the file is gone when the reader reaches it.
       */
      <div
        className="flex h-32 w-44 flex-col justify-center gap-2 rounded-xl border border-destructive border-dashed p-3 text-destructive"
        role="note"
      >
        <IconAlertTriangle className="size-6" />
        <p className="text-sm">{unavailableSentence(filename)}</p>
      </div>
    );
  }

  if (modality === "document") {
    // 文件卡：图标 + 文件名 + 类型 · 大小 + 下载（DESIGN.md §31）。
    return <FileCard name={filename} probeSize={false} size={size} url={url} />;
  }

  return (
    <AttachmentLightbox filename={filename} url={url}>
      <img
        alt={filename ? `附件：${filename}` : "附件"}
        className="size-32 rounded-xl object-cover"
        decoding="async"
        onError={() => setFailedToLoad(true)}
        src={url}
      />
    </AttachmentLightbox>
  );
}

/**
 * What an absent file is called, in one place, because two surfaces now say it.
 *
 * The tile said it and the lightbox behind the tile said nothing at all. Sharing the wording rather
 * than writing it twice is what keeps them from drifting into two different accounts of the same
 * absence — the tile naming the file and the dialog saying something vaguer, or worse, later.
 *
 * A file with no name still gets a sentence rather than a blank: the reader clicked on something,
 * and "this attachment" is the honest way to refer to a thing whose name we never had.
 */
function unavailableSentence(filename?: string): string {
  return filename ? `看不到「${filename}」了。` : "此附件不可用。";
}

/**
 * The full-size picture inside the lightbox, and what it draws when the file will not load.
 *
 * IT NEEDED A FAILURE STATE AND HAD NONE. The tile in front of it has had one from the start — an
 * `onError` swapping the broken-image box for a sentence, with a comment above it about why the
 * browser's own placeholder "says nothing to the reader" — and this `<img>`, the one drawn at full
 * size against a dark backdrop with the reader's whole attention on it, had no `onError` at all. A
 * file deleted between the tile painting and the reader clicking it opened a dialog containing
 * exactly the placeholder the tile path exists to avoid.
 *
 * THE TILE CANNOT COVER THIS ONE. Its own `<img>` has already loaded by the time there is anything
 * to click, and a loaded image does not fire `error` again because the file behind it went away; the
 * request that finds out is this one. Nor can the probe beside it: `useDocumentIsGone` deliberately
 * never asks about a picture, because a picture's own load is supposed to be the answer — and this
 * is the load it meant.
 *
 * IT STAYS OPEN AND SAYS SO, rather than closing itself. The reader opened this deliberately, and a
 * dialog that vanishes on its own leaves them looking at the transcript with no idea what happened
 * and their focus wherever the close put it. The sentence in place answers the question they
 * actually asked. Escape and the close button still work, and the state resets when the popup
 * unmounts, so reopening genuinely tries again rather than remembering a failure.
 *
 * ITS OWN COMPONENT, AND EXPORTED, SO THE FAILURE CAN BE TESTED AT ALL: Base UI portals this popup
 * and under happy-dom the portal never mounts — checked, and recorded in the test named "a thumbnail
 * is a crop" — so there is no way to reach this `<img>` through the trigger. Same reason
 * `sameAttachmentRow` is exported: the behaviour is worth pinning and the thing it lives inside
 * cannot be mounted here.
 */
export function LightboxPicture({
  filename,
  url,
}: {
  filename?: string;
  url: string;
}) {
  const [failedToLoad, setFailedToLoad] = useState(false);

  if (failedToLoad) {
    return (
      /*
       * `note` rather than `alert`, for the reason the tile's own missing card gives at length: an
       * assertive live region cuts across whatever a screen reader is saying, and this is an answer
       * to something the reader just did rather than an emergency. Light-on-dark because it is
       * drawn against the lightbox's own backdrop, where `text-destructive` is unreadable.
       */
      <div
        className="flex flex-col items-center gap-3 p-8 text-center text-white"
        role="note"
      >
        <IconAlertTriangle className="size-8" />
        <p className="text-sm">{unavailableSentence(filename)}</p>
      </div>
    );
  }

  return (
    <img
      alt={filename ?? "附件"}
      className="max-h-[88svh] max-w-[92vw] rounded-lg object-contain"
      decoding="async"
      onError={() => setFailedToLoad(true)}
      src={url}
    />
  );
}

/**
 * The square, opened.
 *
 * The tile is a crop — that is the price of a tidy row — so there has to be a way to see the whole
 * picture, and it used to be `target="_blank"`. A new tab is a worse answer than it looks: it drops
 * the reader out of the conversation they were reading, the browser shows the raw file against its
 * own chrome with no way back but the back button, and on a phone it is a context switch away from
 * the channel entirely. A dialog closes on Escape and puts them back exactly where they were.
 *
 * Built on the app's `Dialog` so focus trapping, scroll locking and Escape behave the way they do
 * everywhere else, but with its card stripped off: `max-w-none border-0 bg-transparent p-0
 * shadow-none` leaves the picture as the only lit thing against a dark backdrop.
 *
 * THE CLOSE BUTTON IS FIXED TO THE VIEWPORT, not to the popup, which is why `showCloseButton` is
 * off and this draws its own. Pinned to the popup it would sit on the picture — invisible over a
 * pale one, and moving with every image's shape.
 */
function AttachmentLightbox({
  children,
  filename,
  url,
}: {
  children: React.ReactNode;
  filename?: string;
  url: string;
}) {
  const label = filename ?? "附件";
  /*
   * Controlled only so that clicking the dark space around the picture closes it, the way every
   * lightbox a reader has used does. The popup covers the viewport (see below), so it — not the
   * backdrop underneath — is what receives that click, and Base UI's own dismiss never fires.
   */
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        // A button, not a link: it opens something on this page, and a middle-click offering a new
        // tab to a raw image file is not the promise this makes. `block` so the tile is not sitting
        // on a text baseline with a stray gap under it.
        className="block cursor-zoom-in overflow-hidden rounded-xl"
        render={<button aria-label={`打开 ${label}`} type="button" />}
      >
        {children}
      </DialogTrigger>
      <DialogContent
        /*
         * THE CARD IS STRIPPED OFF AND THE POPUP IS MADE FULL-SCREEN, and the second half is not
         * cosmetic. `DialogContent` centres itself with `-translate-x-1/2 -translate-y-1/2`, and a
         * transform on an ancestor is what `position: fixed` resolves against — so a close button
         * "fixed to the viewport" inside it landed 72px down and 30px in from the corner instead of
         * at it. Measured, not guessed. A popup that already IS the viewport has no transform, and
         * `absolute` in it means the corner it looks like it means.
         *
         * Centring by flex rather than by width also lets the picture keep its own shape: as a
         * stretched flex child it was drawn 1012px wide for a 644px image, letterboxed inside a box
         * far bigger than itself.
         */
        className="inset-0 top-0 left-0 h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none border-0 bg-transparent p-0 shadow-none"
        data-surface="bare"
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        overlayClassName="bg-black/80"
        showCloseButton={false}
      >
        {/* Named for a screen reader; the picture carries the same name in its alt text. */}
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <LightboxPicture filename={filename} url={url} />
        <DialogClose
          render={
            <button
              aria-label={"关闭"}
              className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              type="button"
            />
          }
        >
          <IconX className="size-5" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What a failed activity is called on screen.
 *
 * An `activityType` is a protocol name and reads like one, so the boundary's sentence gets a phrase
 * a person can read instead. An unknown type falls back to its own name rather than to something
 * vague: whoever registered it will recognise it, and nobody else can act on either wording.
 */
function activityName(activityType: string): string {
  return activityType === "open-generative-ui"
    ? "此机器人生成的界面"
    : activityType;
}

/**
 * One activity, drawn by whichever renderer claims its type.
 *
 * The renderer comes from the SDK's registry, so an activity nobody registered draws nothing and
 * this returns null rather than an empty row — unlike a tool call, which always has a line to fall
 * back to because a call that happened is worth reporting even undrawn. An activity is the drawing;
 * with no renderer there is nothing to say about it.
 *
 * The memo boundary earns its place differently here than on a tool call. It cannot spare this
 * component its own churn — a generated interface streams, and `content` is a new object on every
 * chunk, which is exactly when it must re-render — but it does stop the sentence being typed after it
 * from re-rendering a mounted iframe.
 */
const TranscriptActivity = memo(function TranscriptActivity({
  delay,
  message,
}: {
  delay: number;
  message: ActivityMessage;
}) {
  const { renderActivityMessage } = useRenderActivityMessage();
  const drawn = renderActivityMessage(message);
  if (!drawn) return null;

  return (
    <Arriving delay={delay}>
      <ToolRenderBoundary name={activityName(message.activityType)}>
        {drawn}
      </ToolRenderBoundary>
    </Arriving>
  );
});

/**
 * One drawn tool call, memoised on the same terms.
 *
 * The `toolCall` object is rebuilt here from its parts rather than passed down, because the one on
 * the message is a new object on every chunk and would defeat the memo exactly as the text items
 * did. A finished chart re-rendering on every token of the sentence after it is not free.
 *
 * `useRenderToolCall` is called HERE rather than passed in as a prop: a function whose identity the
 * parent cannot guarantee is the classic way to make a memo boundary useless.
 */
const TranscriptToolCall = memo(function TranscriptToolCall({
  delay,
  toolCallId,
  name,
  args,
  result,
  turnEnded = false,
}: {
  delay: number;
  toolCallId: string;
  name: string;
  args: string;
  result?: string;
  /** 这个调用所在的那一轮已经结束（不再 live）。 */
  turnEnded?: boolean;
}) {
  const renderToolCall = useRenderToolCall();
  const toolCall = useMemo(
    () => ({
      id: toolCallId,
      type: "function" as const,
      function: { name, arguments: args },
    }),
    [toolCallId, name, args],
  );

  const drawn = renderToolCall({
    toolCall,
    ...(result === undefined
      ? {}
      : {
          toolMessage: {
            id: `${toolCallId}-result`,
            role: "tool",
            toolCallId,
            content: result,
          },
        }),
  });

  return (
    <Arriving delay={delay}>
      <ToolRenderBoundary name={name}>
        {/*
         * A TOOL WITH NO REGISTERED RENDERER STILL HAPPENED, and since tools moved to the server
         * that is now the ordinary case rather than the exception: MCP tools execute in the runtime
         * and register no renderer here at all. `renderToolCall` still draws the components the app
         * registers, and everything else lands below.
         *
         * What was called, shimmering until its result arrives, and then the server's own words
         * drawn the way a Bot's prose is drawn.
         */}
        <ToolTurnEndedContext.Provider value={turnEnded}>
          {turnEnded &&
          result === undefined &&
          getCardCheck(registeredCardChecks, name) ? (
            <UnfinishedTool name={name} />
          ) : (
            (drawn ?? <ServerToolLine name={name} result={result} />)
          )}
        </ToolTurnEndedContext.Provider>
      </ToolRenderBoundary>
    </Arriving>
  );
});

/**
 * 这一轮结束了（没按停止），画骨架的工具却一直没有结果（复审 #404 第四轮）：骨架会一直转「正在画图…」，下面又挂着
 * 「这一轮没有回答」和重试，两边矛盾。换成一句不动的「画图没有完成」；toolDrawsCard 同样不把它算作卡片。
 */
export function UnfinishedTool({ name }: { name: string }) {
  return (
    <p
      className="my-1.5 text-muted-foreground text-xs"
      data-testid="tool-unfinished"
    >
      {unfinishedToolText(name)}
    </p>
  );
}

/**
 * A tool the runtime executed, drawn for the person watching.
 *
 * Named from the reader's side: what was done, against which server, with the server's own words
 * behind a disclosure. The identifier the model was offered never reaches the screen.
 */
/** 桌面宿主（host_*）工具被拒：没有渲染器时 `ServerToolLine` 不画过程行，画成一句看得见的提示。 */
export function isHostAccessRefusal(name: string, result?: string): boolean {
  if (result === undefined || !name.startsWith("host_")) return false;
  return asText(result).startsWith(REFUSAL_MARKER);
}

function ServerToolLine({ name, result }: { name: string; result?: string }) {
  const { label, detail } = readToolName(name);
  /*
   * A refusal is not a result, and must not read like one.
   *
   * The server says which it is rather than the browser inferring it from the wording, because the
   * wording is a policy message an administrator can rewrite and the first rephrasing would break
   * any guess made here. See REFUSAL_MARKER in server/src/plugins/tools.ts.
   */
  const answer = result === undefined ? undefined : asText(result);
  const refused = answer?.startsWith(REFUSAL_MARKER) ?? false;
  const failed = !refused && toolResultFailed(result);
  /*
   * The marker is for this component, not for the reader. Left in, a refusal reads "Blocked" in the
   * label and then "Refused." again in the first two words of the body, which is the same fact three
   * times over by the end of the sentence. Stripped here rather than on the server, because the
   * server's copy is what the model is told and "Refused." in front of a reason is right for it.
   */
  const body = refused ? answer?.slice(REFUSAL_MARKER.length).trim() : answer;
  /*
   * 桌面宿主（host_*）工具被拒绝，几乎都是因为电脑没连上 / 没授权文件夹。这是用户能处理的事，
   * 所以不当成过程行藏起来，而是一句中文提示，告诉他去哪里处理。
   */
  if (isHostAccessRefusal(name, result)) return <HostAccessHint />;
  // 工具原样的输出交给 ToolLine 用纯文本画、过长截断（审查模块 7：以前当 markdown 画，一万字点开要卡 1.5 秒）。
  return (
    <ToolLine
      {...(detail ? { detail } : {})}
      label={label}
      refused={refused}
      failed={failed}
      running={result === undefined}
      {...(body ? { output: forDisplay(body) } : {})}
    />
  );
}

function HostAccessHint() {
  return (
    <p className="chat-host-hint" role="note">
      {
        "机器人想读取这台电脑上的文件夹，但电脑还没有连接或没有授权。可以在机器人「⋯」菜单 → "
      }
      <strong>{"电脑操作"}</strong>
      {" 里连接电脑并授权文件夹。"}
    </p>
  );
}

/**
 * Whether a text item is the person actually sending something, as opposed to a routine firing that
 * merely arrived wearing `role: "user"`.
 *
 * A FIRING IS NOT THE PERSON SPEAKING — `TranscriptMessage` already knows that and draws it as
 * `RoutineFiring` rather than as their bubble, via the same `readFiring` check used here. The scroll
 * machinery below was the one place left that had not caught up: it smooth-scrolled and anchored on
 * `role === "user"` alone, so a routine firing while somebody was reading back through the channel
 * yanked their viewport to the bottom as though they had just typed and sent something. They hadn't;
 * the schedule had. Exported so this can be checked without mounting anything.
 */
export function isPersonSentMessage(
  role: "user" | "assistant",
  text: string,
): boolean {
  return (
    role === "user" && readFiring(text) === null && serverRowKind(text) === null
  );
}

/**
 * The turn a row belongs to.
 *
 * The attachments row is identified as `${messageId}:attachments` by `toVisibleChatItems`, so that
 * it and the caption beneath it can be told apart while still belonging to one turn. The id of the
 * message they were sent in is the part before the last colon.
 */
function turnOf(item: TranscriptItem): string {
  if (item.kind !== "attachments") {
    return item.id;
  }
  const separator = item.id.lastIndexOf(":");
  return separator === -1 ? item.id : item.id.slice(0, separator);
}

/**
 * Which rows the scroller may lift to the top of the viewport: THE FIRST ROW OF EACH TURN THE
 * PERSON SENT, and only that one.
 *
 * The scroller reads `data-scroll-anchor` off the rows appended in one go, takes the first it finds
 * and scrolls it to the top with a peek of the answer above it — but finding MORE THAN ONE among
 * that same batch it gives up on the ambiguity and jumps to the end instead. One turn is very often
 * several rows: a caption and its screenshot, or three files pasted together, all arrive at once.
 * So "every row a person sent" is not the rule; "the first row of every turn a person sent" is, and
 * the difference between them is the whole anchoring behaviour of an ordinary captioned message.
 *
 * A Bot's prose is never an anchor — the anchor exists to hold the QUESTION at the top while the
 * answer streams in underneath it — and neither is a routine firing, which arrived wearing
 * `role: "user"` without anybody having typed anything.
 *
 * Order is `toVisibleChatItems`' order, which puts a turn's attachments before its caption, so a
 * turn carrying a file is anchored on the first file and a plain one on its text. That is the right
 * end to hold: the picture is the top of what the person sent, and anchoring on the caption
 * underneath it would scroll the picture off the top of the pane.
 */
export function anchorRowIds(items: readonly TranscriptItem[]): Set<string> {
  const anchors = new Set<string>();
  const claimed = new Set<string>();

  for (const item of items) {
    const sent =
      item.kind === "attachments" ||
      (item.kind === "text" && isPersonSentMessage(item.role, item.text));
    if (!sent) continue;

    const turn = turnOf(item);
    if (claimed.has(turn)) continue;
    claimed.add(turn);
    anchors.add(item.id);
  }

  return anchors;
}

/**
 * The only way to actually enforce exhaustiveness over `VisibleChatItem`: the
 * `item` parameter is typed `never`, so a branch that reaches here with a
 * member of the union still unhandled fails to compile, rather than a
 * trailing `: null` that accepts anything and renders nothing for it.
 */
function assertNever(_item: never): null {
  return null;
}

/**
 * 历史里最后一轮是不是「人说了、后面什么都没有」——刷新之后错误卡和「重试」据此重建（P1，2026-10-20）。
 *
 * 只认最后一条：中间那些「人发了、没人回」的老消息不逐条弹卡（那是历史，重发从最后一条开始）。
 * 还在跑、有排队消息、有「已停止」标记、或者这一轮本来是服务器放的（定时任务 / 任务结果）都不算。
 * 纯函数，单测直接喂列表。
 */
export function unansweredTurn(
  items: readonly TranscriptItem[],
  busy: boolean,
  stoppedTurns: ReadonlySet<string> | undefined,
  queued = 0,
): TranscriptItem | null {
  if (busy || queued > 0) return null;
  const last = items.at(-1);
  if (last?.kind !== "text" || last.role !== "user") return null;
  if (!isPersonSentMessage(last.role, last.text)) return null;
  if (stoppedTurns?.has(last.id)) return null;
  return last;
}

/**
 * 这一轮是不是还在进行。`threadLive` 来自服务端（running）或正在等人审批 / 确认；
 * 没有它时仍用 §68.4：busy 之后列表还没变，不算正在跑（避免发送键刚亮、人那条还没进列表时，
 * 上一轮已完成的结果气泡被当成进行中）。
 */
export function turnIsLive(
  busy: boolean,
  shape: { length: number; last: string | null },
  settled: { length: number; last: string | null } | null,
  threadLive = false,
): boolean {
  if (threadLive) return true;
  if (!busy) return false;
  return !(
    settled !== null &&
    settled.length === shape.length &&
    settled.last === shape.last
  );
}

type ToolCallSnapshot = {
  id: string;
  name: string;
  args: string;
};

type MessageEntrySnapshot = {
  ref: Readonly<Message>;
  id: string;
  role: Message["role"];
  content: unknown;
  extra: unknown;
  tools: ToolCallSnapshot[] | null;
};

function readMessageExtra(message: Readonly<Message>): unknown {
  if ("error" in message) return message.error;
  if ("activityType" in message) return message.activityType;
  return undefined;
}

function captureMessagesSnapshot(
  messages: ReadonlyArray<Readonly<Message>>,
): MessageEntrySnapshot[] {
  const out = new Array<MessageEntrySnapshot>(messages.length);
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    let tools: ToolCallSnapshot[] | null = null;
    if (
      "toolCalls" in message &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.length > 0
    ) {
      tools = message.toolCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        args: call.function.arguments,
      }));
    }
    out[i] = {
      ref: message,
      id: message.id,
      role: message.role,
      content: "content" in message ? message.content : undefined,
      extra: readMessageExtra(message),
      tools,
    };
  }
  return out;
}

function messagesMatchSnapshot(
  messages: ReadonlyArray<Readonly<Message>>,
  snapshot: readonly MessageEntrySnapshot[] | undefined,
): boolean {
  if (!snapshot || messages.length !== snapshot.length) return false;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const entry = snapshot[i];
    if (!message || !entry) return false;
    if (
      message !== entry.ref ||
      message.id !== entry.id ||
      message.role !== entry.role ||
      ("content" in message ? message.content : undefined) !== entry.content ||
      readMessageExtra(message) !== entry.extra
    ) {
      return false;
    }
    const calls =
      "toolCalls" in message && Array.isArray(message.toolCalls)
        ? message.toolCalls
        : null;
    const toolCount = calls?.length ?? 0;
    const prevCount = entry.tools?.length ?? 0;
    if (toolCount !== prevCount) return false;
    if (calls && entry.tools) {
      for (let j = 0; j < toolCount; j += 1) {
        const call = calls[j];
        const prev = entry.tools[j];
        if (
          !call ||
          !prev ||
          call.id !== prev.id ||
          call.function.name !== prev.name ||
          call.function.arguments !== prev.args
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * 记录每个 `messages` 数组引用上次被 `ChatTranscriptImpl` 渲染时的字段快照：
 * AG-UI 的 `agent.messages` 存在就地 push / 修改 content 的路径，外层 `memo` 若仅比对数组引用会吞掉新消息，
 * 借助该快照既可在无变更时跳过整棵聊天树重渲，又能 100% 捕获就地变更。
 */
const lastRenderedMessages = new WeakMap<
  ReadonlyArray<Readonly<Message>>,
  MessageEntrySnapshot[]
>();

function areChatTranscriptPropsEqual(
  prev: ChatTranscriptProps,
  next: ChatTranscriptProps,
): boolean {
  if (
    prev.agentId !== next.agentId ||
    prev.busy !== next.busy ||
    prev.threadLive !== next.threadLive ||
    prev.joining !== next.joining ||
    prev.reconnecting !== next.reconnecting ||
    prev.scrollKey !== next.scrollKey ||
    prev.commandNames !== next.commandNames ||
    prev.onRemoveQueued !== next.onRemoveQueued ||
    prev.onRetryQueued !== next.onRetryQueued ||
    prev.queued !== next.queued ||
    prev.queuedHeld !== next.queuedHeld ||
    prev.restoring !== next.restoring ||
    prev.hydrating !== next.hydrating ||
    prev.stopped !== next.stopped ||
    prev.stoppedTurns !== next.stoppedTurns ||
    prev.onRetry !== next.onRetry ||
    prev.onRetryUnanswered !== next.onRetryUnanswered ||
    prev.onWithdraw !== next.onWithdraw ||
    prev.topNotice !== next.topNotice ||
    prev.fallbacks !== next.fallbacks ||
    prev.lastSentAt !== next.lastSentAt
  ) {
    return false;
  }
  if (prev.messages !== next.messages) return false;
  return messagesMatchSnapshot(
    next.messages,
    lastRenderedMessages.get(next.messages),
  );
}

function ChatTranscriptImpl({
  agentId,
  busy = false,
  threadLive = false,
  joining = false,
  reconnecting = false,
  scrollKey,
  commandNames = "",
  messages,
  onRemoveQueued,
  onRetryQueued,
  queued = EMPTY_QUEUE,
  queuedHeld = false,
  restoring = false,
  hydrating = false,
  stopped,
  stoppedTurns,
  onRetry,
  onRetryUnanswered,
  onWithdraw,
  topNotice,
  fallbacks,
  lastSentAt = null,
}: ChatTranscriptProps) {
  // 以内容快照而非纯数组引用驱动消息管线缓存：兼顾就地变更安全性与非消息重渲零重算。
  const itemsCacheRef = useRef<{
    snapshot: MessageEntrySnapshot[];
    items: TranscriptItem[];
  } | null>(null);
  let items: TranscriptItem[];
  if (
    itemsCacheRef.current &&
    messagesMatchSnapshot(messages, itemsCacheRef.current.snapshot)
  ) {
    items = itemsCacheRef.current.items;
    lastRenderedMessages.set(messages, itemsCacheRef.current.snapshot);
  } else {
    const snapshot = captureMessagesSnapshot(messages);
    items = groupBrowserSteps(
      toVisibleChatItems(collapseScheduleRuns(messages)),
    );
    itemsCacheRef.current = { snapshot, items };
    lastRenderedMessages.set(messages, snapshot);
  }
  const hasAssistantText = useMemo(
    () =>
      items.some(
        (item) =>
          item.kind === "text" &&
          item.role === "assistant" &&
          item.text.trim().length > 0,
      ),
    [items],
  );
  const speechStatus = useQuery({
    ...speechStatusQueryOptions(),
    enabled: hasAssistantText,
  });
  const ttsReady = Boolean(speechStatus.data?.ttsReady);
  // render_ui 渲染面：历史里已有卡片就立即预载（不等 capabilities）；其余情况 RenderUiTool 空闲时预载。
  useRenderUiPreload(messages);
  /*
   * 「最后一轮还在跑」只从列表真的变了算起（§68.4）。按下发送的那一刻 busy 先变 true，人发的那条要再过
   * 几十毫秒才进列表；这几十毫秒里如果把「最后一轮」（上一轮，早就答完了）当成正在跑，它的结果气泡会变回
   * 开场一句、丢掉下面那行按钮，整页矮一截、往下一跳。所以：空闲时记下列表的样子，busy 之后列表没变就还算答完。
   * 重新生成 / 编辑重发会先截断列表，长度变了，照样算正在跑。
   */
  const settledRef = useRef<{ length: number; last: string | null } | null>(
    null,
  );
  const settledKeyRef = useRef(scrollKey);
  if (settledKeyRef.current !== scrollKey) {
    settledKeyRef.current = scrollKey;
    settledRef.current = null;
  }
  const shape = { length: items.length, last: items.at(-1)?.id ?? null };
  // 服务端还在跑、或还在接入时不要把当前形状记成「已结束」：否则随后 busy 变 true、列表没变，live 会一直是 false。
  if (!busy && !threadLive && !joining) settledRef.current = shape;
  const settled = settledRef.current;
  /*
   * 刷新后照样认得出「发出去但没人回答」的那一轮（P1，2026-10-20）：重开对话时 RUN_ERROR 早没了，
   * 只剩人那条消息。卡片跟着这一条重建，别让它凭空消失、也没有重试的入口。
   * 恢复历史期间先不判（列表还是半截），认的是 `restoring` / `hydrating` 两个标记。
   */
  const unanswered =
    !stopped && !restoring && !hydrating
      ? unansweredTurn(items, busy, stoppedTurns, queued.length)
      : null;
  const tailStop = stopped ?? (unanswered ? UNANSWERED_TURN_REASON : undefined);
  /*
   * 确认卡 / 审批卡挂在哪些工具调用上：简单回合（下面）和「这一轮有没有回答」都要用。确认列表和确认卡片用同一份
   * 缓存（同一个 queryKey），审批收件箱和行内审批卡也是同一份，不多发请求。
   */
  const chatConfig = useConversationScope();
  const chatThreadId = chatConfig?.threadId ?? null;
  const hasTools = useMemo(
    () => items.some((item) => item.kind === "tool"),
    [items],
  );
  const confirmations = useThreadConfirmations(
    hasTools ? chatThreadId : null,
    false,
  );
  const approvalsEnabled = hasTools && chatThreadId !== null;
  const approvals = useQuery({
    ...approvalInboxOptions(),
    enabled: approvalsEnabled,
    // 10s 周期刷新交由 VisibleApprovalPoll 按 useKeptVisibility() 门控，隐藏态零后台轮询且切换不翻转 enabled。
    refetchInterval: false,
    refetchIntervalInBackground: false,
    select: (data) => {
      let pending = false;
      const toolCallIds: string[] = [];
      for (const request of data.requests) {
        if (request.status === "pending") {
          pending = true;
          if (request.action.toolCallId) {
            toolCallIds.push(request.action.toolCallId);
          }
        }
      }
      return { pending, toolCallIds };
    },
  });
  const confirmed = useMemo(() => {
    const set = new Set<string>();
    for (const request of confirmations.data ?? [])
      if (request.toolCallId) set.add(request.toolCallId);
    for (const toolCallId of approvals.data?.toolCallIds ?? [])
      set.add(toolCallId);
    return set;
  }, [confirmations.data, approvals.data]);
  /*
   * 以卡片收尾的一轮也是回答了（回复显示①复审）：生成的图片、分享的文件、问人、确认卡、宿主提示……后面没有字，
   * 也不挂「这一轮没有回答」和重试（点了会重新生成图片、重新建 issue）。和真正画卡片用同一份渲染器表
   * （toolDrawsCard）；确认 / 审批还没读到时先当有卡片，读到再判，免得先闪一下重试。
   */
  const toolRenderers = useToolRenderers();
  const activityRenderers = useActivityRenderers();
  const asking = confirmations.isLoading || approvals.isLoading;
  const awaitingPerson =
    (confirmations.data ?? []).some(
      (request) => request.status === "pending",
    ) || Boolean(approvals.data?.pending);
  const live = turnIsLive(busy, shape, settled, threadLive || awaitingPerson);
  // 这一轮从什么时候开始（状态胶囊的「已用秒数」从这里算；「思考中」换成干活卡后接着算，不归零）。
  // 认不出这一轮的 key 时才用这个（只活在这次挂载里）。
  const liveSinceRef = useRef<number | null>(null);
  if (!live) liveSinceRef.current = null;
  else if (liveSinceRef.current === null) liveSinceRef.current = Date.now();
  const scopeAgentId = chatConfig?.agentId;
  // 一轮收成「开场一句 → 结果」，与机器人聊天同一规则（compactTurns，2026-10-13 第四轮）。
  const compact = useMemo(() => {
    const drawsCard: DrawsCard = (item, turnLive) =>
      (asking && item.kind === "tool") ||
      toolDrawsCard(item, {
        renderers: toolRenderers,
        activities: activityRenderers,
        ...(scopeAgentId ? { agentId: scopeAgentId } : {}),
        asked: confirmed,
        live: turnLive,
      });
    return compactTurns(
      items,
      live,
      stoppedTurns ?? EMPTY_STOPS,
      fallbacks,
      drawsCard,
    );
  }, [
    items,
    live,
    stoppedTurns,
    fallbacks,
    asking,
    toolRenderers,
    activityRenderers,
    scopeAgentId,
    confirmed,
  ]);
  /*
   * 和干活卡同一个开始时间（按这一轮的 key 记在 work-card 的模块里）：切到别的频道再回来，胶囊重新挂上，
   * 秒数接着算，不再从 0 开始（以前记在这个组件的 ref 里，卸载就丢）。
   */
  const liveSince = live
    ? compact.liveKey
      ? turnStartedAt(compact.liveKey)
      : (liveSinceRef.current ?? Date.now())
    : 0;
  /*
   * 同一轮又跑一次（重试、确认后接着跑……）要从 0 重新计时：这一页亲眼看着上一次跑停下来时记一笔，
   * 下次再开始跑时 turnStartedAt 就重新记开始时间、清掉上次的用时。只认这次挂载里看到的「跑着 → 停了」，
   * 所以切到别的频道再回来（重挂时还在跑）秒数接着算，不归零。
   */
  const runningKey = live ? compact.liveKey : null;
  const runningKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = runningKeyRef.current;
    if (previous !== null && previous !== runningKey)
      markTurnRunEnded(previous);
    runningKeyRef.current = runningKey;
  }, [runningKey]);
  const showToolActivity = useToolActivityVisible();
  /*
   * 干活胶囊只在思考和干活时出现（回复显示②，DESIGN.md §123，2026-11-04）：这一轮一结束，干活那一行整行收起——
   * 不再留「✓ N 步 · N 秒 ⌄」那行（「◼ 已停止」「这一轮没有回答」是另外的行，不受影响）。结构上的判断在
   * compactTurns（`quiet`）。确认列表和确认卡片用同一份缓存（同一个 queryKey），不多发请求。
   * 打开「调试：显示工具调用」时不收（每一步本来就画着）。
   */
  const hasQuiet =
    !showToolActivity && [...compact.work.values()].some((work) => work.quiet);
  const resumedCards = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      if (item.kind !== "text" || item.role !== "user") continue;
      const id = confirmResumeId(item.text);
      if (id) ids.add(id);
    }
    return ids;
  }, [items]);
  const { quietRows, quietWorkOnly } = useMemo(() => {
    const rows = new Set<string>();
    /*
     * 收起的锚点行自己画着卡片（审查模块 7）：问人、建定时任务、交给后台……这种调用当了这一轮干活卡的锚点时，
     * 收起的只能是干活那一行，不能把卡片一起收掉（以前后台任务卡就是这样在任务还在跑时消失的，刷新后也不画）。
     * 用和画卡片同一份判断（toolDrawsCard），确认 / 审批还没读到时不先当卡片：先收、读到了再露出来，不会先画后收。
     */
    const workOnly = new Set<string>();
    if (!hasQuiet) return { quietRows: rows, quietWorkOnly: workOnly };
    const rowItems = new Map(items.map((item) => [item.id, item] as const));
    for (const [anchor, work] of compact.work) {
      if (!work.quiet) continue;
      const item = rowItems.get(anchor);
      const draws =
        (item?.kind === "tool" || item?.kind === "activity") &&
        toolDrawsCard(item, {
          renderers: toolRenderers,
          activities: activityRenderers,
          ...(scopeAgentId ? { agentId: scopeAgentId } : {}),
          asked: confirmed,
        });
      if (draws) workOnly.add(anchor);
      else rows.add(anchor);
    }
    return { quietRows: rows, quietWorkOnly: workOnly };
  }, [
    hasQuiet,
    items,
    compact.work,
    toolRenderers,
    activityRenderers,
    scopeAgentId,
    confirmed,
  ]);
  /** 这一行不画（收起的过程话、旧的浏览小条、结束那轮的干活卡那一行）。 */
  const rowHidden = (id: string) => compact.hidden.has(id) || quietRows.has(id);
  /*
   * 收起而不是拔掉（DESIGN §82.9）：一轮结束时过程话 / 旧的浏览小条被收起（compact.hidden），以前那一帧直接卸载，
   * 下面的结果往上一跳。这一页上亲眼看着它可见过的行，变成 hidden 后留在原处、用 220ms 收成 0 高 + 淡出
   * （`data-folded`，styles.css），之后作为看不见、不可聚焦的 0 高行留在列表里；重新打开对话时本来就不画它们。
   */
  const shownRef = useRef<Set<string>>(new Set());
  const foldedRef = useRef<Set<string>>(new Set());
  for (const item of items) {
    if (rowHidden(item.id) && shownRef.current.has(item.id))
      foldedRef.current.add(item.id);
  }
  const shownIdsRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    shownRef.current = shownIdsRef.current;
    const ids = new Set(items.map((item) => item.id));
    for (const id of foldedRef.current)
      if (!ids.has(id)) foldedRef.current.delete(id);
  });

  /*
   * ONLY WHILE THERE IS NOTHING ELSE TO LOOK AT. Once a reply starts streaming, or a tool line
   * appears, the transcript is already saying the Bot is working — a second indicator under a
   * half-written answer would claim it had stopped and started again.
   *
   * So: the turn is in flight AND the last thing in the conversation is still the person's own
   * message. A tool call that is running shimmers on its own line and needs nothing from here.
   */
  const lastItem = items.at(-1);
  const waitingOnFirstToken =
    live &&
    ((lastItem?.kind === "text" && lastItem.role === "user") ||
      /*
       * A screenshot pasted with no caption is still a person sending something, and they are
       * watching the same spot under it for the Bot's answer as they would under a typed question.
       * `toVisibleChatItems` only ever produces an `attachment` item from a user turn, so seeing one
       * last means the person went last — without this an attachment-only turn silently swallowed
       * the Thinking indicator.
       */
      lastItem?.kind === "attachments" ||
      /*
       * 过程行默认隐藏（lib/chat/tool-activity.ts）：工具在跑时那一行不再闪烁，所以最后一项是工具 /
       * 浏览步骤时也由这里显示「正在思考」，否则机器人干活的那几秒屏幕上什么都没有。
       */
      (!showToolActivity &&
        (lastItem?.kind === "tool" || lastItem?.kind === "browser")));

  // 这一轮已经有干活卡（在第一个干活的工具那一行里，DESIGN.md §75.1）：末尾不再画「思考中」。
  const liveWorking =
    live &&
    !showToolActivity &&
    [...compact.work.values()].some((work) => work.live);
  /*
   * 读屏（回复显示①）：一轮里只有这一个 role=status，挂在对话末尾一直不卸载。「思考中」胶囊换成干活卡时
   * 两个胶囊一个卸载一个新挂，新挂上的 live region 有的读屏不播；这里同一个节点里换字，换成「正在搜索…」照样读出来。
   * 胶囊、干活卡自己不再带 role=status（不然一句话读两遍）。
   */
  const liveWork = live
    ? [...compact.work.values()].find((work) => work.live)
    : undefined;
  // 正在进行的这一轮：干活卡所在行 id。
  const liveAnchorId = live
    ? [...compact.work].find(([, work]) => work.live)?.[0]
    : undefined;
  /*
   * 实时干活胶囊与「思考中」始终共用末尾固定槽 `.chat-status-slot`（§94.8 / §123）：
   * 整轮进行中都不再在底部槽与首个工具行之间来回迁移（避免中间过程话与下一步工具之间 ±62px 跳动、
   * 避免展开中的步骤列表被卸载、也避免 `rowShows(liveAnchorId)` 翻转引发尾窗补行）；
   * 所有工具已返回且正在流式输出文字时（streamingAfterWork），在同一胶囊内平滑切为「正在整理回复」，
   * 回合结束（live=false）由 `.chat-status-slot` 原地清空、列高不变。
   */
  const streamingAfterWork =
    liveWork !== undefined &&
    lastItem?.kind === "text" &&
    lastItem.role === "assistant" &&
    !rowHidden(lastItem.id) &&
    liveWork.calls.every((call) => call.done);
  const liveWorkInTail = liveWorking && liveWork !== undefined;
  const connectionLabel = reconnecting ? "正在恢复连接" : undefined;
  const workStatusLabel =
    connectionLabel ?? (streamingAfterWork ? "正在整理回复" : undefined);
  const liveStatus = !live
    ? ""
    : (workStatusLabel ??
      (liveWork
        ? (summarizeWork(liveWork.calls)?.current ?? "")
        : waitingOnFirstToken
          ? "思考中"
          : ""));
  // 机器人说了一句、还在想下一步（还没有干活卡）：§78.2 的小点。
  const pausedAfterText =
    live &&
    !liveWorking &&
    lastItem?.kind === "text" &&
    lastItem.role === "assistant"
      ? lastItem.text
      : null;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const newestUserMessageId =
    items.findLast(
      (item) =>
        (item.kind === "text" && isPersonSentMessage(item.role, item.text)) ||
        /*
         * Same reasoning as `waitingOnFirstToken` above: an attachment is always the person's own,
         * so a turn that is only a file still counts as them sending something. This id decides
         * nothing but whether the viewport scrolls smoothly for a beat; where it lands is
         * `anchoredTurns` below.
         */
        item.kind === "attachments",
    )?.id ?? null;
  /*
   * 打开这段对话的这段窗口（DESIGN.md §83）：`hydrating` 加上恢复完成后的 SETTLE_AFTER_HYDRATE_MS。
   *
   * 为什么要多这 2.5 秒：历史不是一次到的（这台设备上次看到的样子 → 存下的整段 → 晚到的「已停止」/备用说明），
   * 而且 `hydrating` 在**同一次提交里**就和恢复好的消息一起变 false。只看 `hydrating` 的话，恢复那一刻出现的
   * 最新一条用户消息会被当成「人刚发的」：带上对齐标记、平滑滚一下、下面垫 2/3 屏空白——用户看到的就是
   * 「切个机器人 / 从设置回来，整段对话像发了一次消息一样刷新一次」。
   */
  const opening = useOpeningWindow(hydrating);
  /*
   * CB-025：长对话首屏只挂尾巴再分批往前补。补行时的贴底 / 不跳由 useTailFirstMount 自己管
   * （原生 overflow-anchor，补完钉一次底；jank P1-2）。keep-bottom 只盯真正的历史 prepend
   * （整段数组的第一条变了）——以前盯「当前挂着的第一行」，每补一批就读一次 scrollHeight。
   */
  /*
   * jank P3-3：flag `virtualTranscript` 打开时整段交给 virtua（见 virtual-transcript.tsx），tail-first 不再补行
   * （传 0 行进去，它什么都不挂、不读布局）。关着时这里和以前一模一样。
   */
  const virtual = useVirtualTranscript();
  // 上次停在中间（有待恢复的锚点）：那一条可能比封顶的窗口还旧，这次打开把历史全挂上。
  const needsHistory = useMemo(() => {
    const memo = scrollKey ? threadUi(scrollKey)?.scroll : null;
    return Boolean(memo && !memo.atBottom && memo.anchor);
  }, [scrollKey]);
  /*
   * 聊天记录消失（2026-11-10）：尾窗按看得见的行计数（windowMarks），不再按条数。过程行默认整格不画，
   * 一轮里调几十次工具时，按条数挂的尾巴全是看不见的行——打开对话一片空白。看不见的行照样挂（卡片异步出现时
   * 由 CSS 露出来），只按 HIDDEN_ROW_WEIGHT 折算名额。判断和真正画的同一套：收起的行、干活卡那一行、
   * 画卡片的工具（toolDrawsCard，确认还没读到时不先当卡片）；判漏了由 useTailFirstMount 在 DOM 上兜底。
   * 预计算 `shownFlags` 供 windowMarks / nextShown / firstVisible / keepRow 四处 O(1) 复用。
   */
  const { shownFlags, firstVisibleIndex, tailMarks, nextShown } =
    useMemo(() => {
      const flags = new Array<boolean>(items.length);
      let firstVisible = -1;
      const shown = new Set<string>();
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        let visible = false;
        if (item) {
          const hidden = compact.hidden.has(item.id) || quietRows.has(item.id);
          // 挂着「已停止」/ 备用说明 / 「这一轮没有回答」的行：标记跟着它画（rowsFor），它本身看不见也得挂上，
          // 不然用户停止的一轮刷新后只剩人那条消息，「◼ 已停止」跟着隐藏的工具行一起没了（QA #519 r3 自测）。
          if (
            compact.stoppedAfter.has(item.id) ||
            compact.fallbackAfter.has(item.id) ||
            compact.noAnswerAfter.has(item.id)
          ) {
            visible = true;
          } else if (hidden) {
            visible = false;
          } else if (item.kind === "text" || item.kind === "attachments") {
            visible = true;
          } else if (showToolActivity) {
            visible = true;
          } else if (
            compact.work.has(item.id) &&
            !quietWorkOnly.has(item.id) &&
            !(liveWorkInTail && item.id === liveAnchorId)
          ) {
            visible = true;
          } else if (item.kind === "browser") {
            visible = false;
          } else {
            visible = toolDrawsCard(item, {
              renderers: toolRenderers,
              activities: activityRenderers,
              ...(scopeAgentId ? { agentId: scopeAgentId } : {}),
              asked: confirmed,
              live: item.kind !== "tool" || compact.liveTools.has(item.id),
            });
          }
          if (visible && !hidden) shown.add(item.id);
        }
        flags[index] = visible;
        if (visible && firstVisible < 0) firstVisible = index;
      }
      const marks = virtual
        ? EMPTY_MARKS
        : windowMarks(items.length, (index) => flags[index] === true);
      return {
        shownFlags: flags,
        firstVisibleIndex: firstVisible,
        tailMarks: marks,
        nextShown: shown,
      };
    }, [
      items,
      compact,
      quietRows,
      quietWorkOnly,
      showToolActivity,
      liveWorkInTail,
      liveAnchorId,
      toolRenderers,
      activityRenderers,
      scopeAgentId,
      confirmed,
      virtual,
    ]);
  shownIdsRef.current = nextShown;
  // 正在进行的这一轮：开头那条（人发的）→ 干活卡所在的行，一定挂上（不然干活提示和问题都不在屏幕上）。
  const livePin = live
    ? Math.min(
        ...[
          // 这一轮的开头（人发的那条，或定时任务等接着跑一轮的那条）：compactTurns 的 liveKey。
          compact.liveKey
            ? items.findIndex((item) => item.id === compact.liveKey)
            : -1,
          liveAnchorId
            ? items.findIndex((item) => item.id === liveAnchorId)
            : -1,
        ].filter((index) => index >= 0),
      )
    : Number.POSITIVE_INFINITY;
  const {
    startIndex: tailStart,
    pending: tailPending,
    truncated: tailTruncated,
    mountAll,
    prependHistory,
  } = useTailFirstMount(
    tailMarks.length,
    scrollKey,
    viewportRef,
    items[0]?.id,
    {
      uncapped: needsHistory,
      followBottom: !needsHistory,
      marks: tailMarks,
      itemCount: virtual ? 0 : items.length,
      firstVisible: virtual ? 0 : firstVisibleIndex,
      ...(Number.isFinite(livePin) ? { pin: livePin } : {}),
    },
  );
  /*
   * 已结束的超长工具轮（QA #519 P3）：尾窗往往只挂到最后的回答，「这一轮的问题」在窗口上面。
   * 不要为了它把中间几百条看不见的过程行全部挂上（那会拉长首帧任务）；只把这一轮看得见的行
   * （问题、卡片）缝在尾巴前面。进行中的一轮仍靠 pin 保证干活卡所在的行在窗口里。
   */
  const lastTurnStart =
    !live && newestUserMessageId
      ? items.findIndex((item) => item.id === newestUserMessageId)
      : -1;
  const mountedRows: [TranscriptItem, number][] = [];
  if (!virtual) {
    const from = Math.max(0, tailStart);
    const keepRow = (index: number) => {
      const item = items[index];
      return (
        !!item &&
        (showToolActivity ||
          shownFlags[index] === true ||
          // 这一页亲眼见过、后来收起的行留在 DOM 里做 0 高折叠（§82.9），不能卸掉。
          foldedRef.current.has(item.id))
      );
    };
    // 这一轮看得见、但还在尾巴上面的行（已结束轮次的问题 / 卡片）。
    if (lastTurnStart >= 0 && lastTurnStart < from) {
      for (let index = lastTurnStart; index < from; index++) {
        const item = items[index];
        if (item && keepRow(index)) mountedRows.push([item, index]);
      }
    }
    for (let index = from; index < items.length; index++) {
      // 从没见过的过程行不进 DOM：它们本来就是 display:none，挂上千百条只会拉长首帧。
      // 调试「显示工具调用」时全部挂上；活的干活卡、卡片仍由 rowShows 留着。
      const item = items[index];
      if (item && keepRow(index)) mountedRows.push([item, index]);
    }
  }
  const firstMountedVisible = mountedRows.length > 0;

  /* One rule for both kinds of row — see `anchorRowIds`, which is where it is written down. */
  /*
   * 只有「刚发出去的那一条」带 `data-scroll-anchor`（DESIGN.md §88.1）。
   *
   * 滚动容器按位置找新行：行数变多时从旧行数往后找第一个带标记的行，行数不变但有行换了元素时找第一个
   * 「没对齐过」的带标记的行，把它对齐到顶上。历史里每一轮的第一条用户消息以前都带标记——于是回答结束时某一行
   * 换了个元素（行数不变），它就去对齐整段对话里第一条没对齐过的用户消息（最早的那一轮）；历史从中间 / 上面
   * 补进来时，位置往后挪，落在旧行数后面的用户消息也会被当成「刚发的」对齐到顶上。两种都是往回跳。
   * 现在只有恢复完成后新出现的那一条用户消息带标记，而且只带 FRESH_ANCHOR_MS：对齐它是 §35 要的，
   * 别的行一概不会被拉到顶上。
   */
  /*
   * §94：上一条用户消息发出不到 30 分钟（连续聊天）**或者这一轮还在跑**（§94.7）→ 这一条不带对齐标记，
   * SettleAtEnd 让底部跟着长，不翻页。
   * sendMode 在渲染时定（滚动容器在这次提交后的微任务里读标记），SettleAtEnd 的 layout effect 读同一个 ref。
   */
  const sendMode = useRef<SendMode>({ id: null, continuous: false });
  const freshAnchor = useFreshAnchor(
    newestUserMessageId,
    opening,
    lastSentAt,
    sendMode,
  );
  const newestAnchor =
    freshAnchor === null ? undefined : [...anchorRowIds(items)].at(-1);
  const anchorRows = newestAnchor ? new Set([newestAnchor]) : EMPTY_ANCHORS;
  const slackRef = useRef<HTMLDivElement | null>(null);
  // 重新生成挂在最后一轮最后一段看得见的回答下面；回答进行中谁都不挂（DESIGN.md §67）。
  // 在回答时按钮自己占位不显示（message-actions.tsx 的 held），所以这里只在新一轮真的开始后才不挂。
  const regenerateId = live ? null : lastAnswerId(items, compact.hidden);

  /*
   * One decider per mounted transcript, so opening a different channel starts the cascade over and
   * a message never inherits a delay from a conversation it was not in.
   */
  const delaysRef = useRef<ReturnType<typeof createFirstPaintDelays> | null>(
    null,
  );
  if (delaysRef.current === null) {
    delaysRef.current = createFirstPaintDelays();
  }
  const delays = delaysRef.current;
  delays.seedHistory(items, opening);

  /*
   * Settled AFTER the render that first had items, not on mount: history arrives asynchronously, so
   * on mount there is nothing to stagger yet and marking it settled then would mean the history
   * cascade never happens.
   */
  const hasItems = items.length > 0;
  useExternalConnection(
    hasItems && !opening ? objectConnectionKey(delays) : false,
    () => {
      delays.settle();
    },
  );

  /*
   * 翻页对齐落在视口上 1/3，而不是顶到最上（DESIGN.md §94.7）：上面留着上一轮、下面留 2/3 给回答，
   * 不会一发出就剩一整屏空白。滚动容器把「上一句露 48px」加在 scrollMargin 上，所以这里减掉它。
   * 只影响「新的一轮对齐」这一条路：恢复位置（§88.3）自己带着 scrollMargin，不受影响。
   */
  // CB-101：活动记录里点「在对话里看这一步」，滚到发起那次工具调用的消息并闪一下。
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const mountAllRef = useRef(mountAll);
  mountAllRef.current = mountAll;
  const jumpFrameRef = useRef(0);
  useWindowEvent(JUMP_TO_TOOL_CALL, (event) => {
    const toolCallId = (event as CustomEvent<{ toolCallId?: string }>).detail
      ?.toolCallId;
    if (!toolCallId) return;
    const owner = messagesRef.current.find(
      (message) =>
        (message as { toolCallId?: string }).toolCallId === toolCallId ||
        ((message as { toolCalls?: { id?: string }[] }).toolCalls ?? []).some(
          (call) => call.id === toolCallId,
        ),
    );
    if (!owner) return;
    const flash = () => {
      const row = viewportRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(owner.id)}"]`,
      );
      if (!row) return false;
      viewportRef.current?.dispatchEvent(new Event(DETACH_PIN_EVENT));
      smoothScrollIntoView(row, { block: "center" });
      row.classList.add("is-activity-jump");
      setTimeout(() => row.classList.remove("is-activity-jump"), 1600);
      return true;
    };
    if (flash()) return;
    if (virtualRef.current) {
      // 虚拟化下那一行可能没挂：先经数据层滚过去，挂上后再闪。
      if (dataLayerRef.current?.scrollToMessage(owner.id, { align: "center" }))
        requestAnimationFrame(() => requestAnimationFrame(flash));
      return;
    }
    // 比挂着的窗口还旧：要求把历史全挂上，每帧看一次，最多等 1.5 秒。
    mountAllRef.current();
    const started = performance.now();
    const wait = () => {
      if (flash()) return;
      if (performance.now() - started < 1500)
        jumpFrameRef.current = requestAnimationFrame(wait);
    };
    cancelAnimationFrame(jumpFrameRef.current);
    jumpFrameRef.current = requestAnimationFrame(wait);
  });
  useExternalConnection(true, () => () => {
    cancelAnimationFrame(jumpFrameRef.current);
  });

  /*
   * jank P3-3 虚拟化：除了末尾常驻的几行（流式中的回答、刚发的那条），其余按「每条消息一格」交给 virtua。
   * 每格里是这条消息自己那一行加上跟着它的「已停止」/备用说明，和旧路径同一份 rowsFor。
   */
  const virtualHandle = useRef<VirtualizerHandle | null>(null);
  const virtualCells: VirtualCell[] = [];
  const tailNodes: ReactNode[] = [];
  if (virtual) {
    const all: VirtualCell[] = [];
    items.forEach((item, index) => {
      const nodes = rowsFor(item, index).filter((node) => node != null);
      if (nodes.length > 0) all.push({ id: item.id, node: nodes });
    });
    const { head } = splitVirtualTail(all.length);
    for (const cell of all.slice(0, head)) virtualCells.push(cell);
    for (const cell of all.slice(head))
      for (const node of cell.node as ReactNode[]) tailNodes.push(node);
  }
  // 数据层只能在 MessageScrollerProvider 里面拿（#446），由 VirtualTranscriptControls 填进来。
  const dataLayerRef = useRef<TranscriptDataLayer<TranscriptItem> | null>(null);
  const virtualRef = useRef(virtual);
  virtualRef.current = virtual;

  const [paneHeight, setPaneHeight] = useState(0);
  useExternalConnection(true, () => {
    const element = viewportRef.current;
    if (!element) return;
    /*
     * 切到设置等页面时聊天被 KeepAlive 藏起来，量到的高度是 0；回来又变回原值。两次都 setState
     * 会让整段聊天列表白白重渲染一遍（锚点偏移其实没变），所以藏起来时不记 0，保留上次的高度。
     */
    const measure = () => {
      const height = Math.round(element.getBoundingClientRect().height);
      if (height > 0) setPaneHeight(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });
  const anchorOffset =
    paneHeight > 0 ? Math.max(0, Math.round(paneHeight / 3) - 48) : 0;

  return (
    <TtsReadyContext.Provider value={ttsReady}>
      <MessageScrollerProvider
        autoScroll={false}
        scrollMargin={anchorOffset}
        scrollPreviousItemPeek={48}
      >
        <MessageScroller>
          <MessageScrollerViewport
            ref={viewportRef}
            preserveScrollOnPrepend={false}
            // 补历史时靠浏览器原生滚动锚定保位（jank P1-2）；贴底态由 SettleAtEnd 维护 data-cb-pinned="true" 关闭原生锚定。
            className="[overflow-anchor:auto]"
          >
            <MessageScrollerContent
              aria-busy={busy}
              data-testid="chat-transcript"
              data-tail-first-pending={tailPending ? "" : undefined}
              data-tail-first-truncated={tailTruncated ? "" : undefined}
              className="mx-auto w-full max-w-2xl px-4 pt-6 chat-scroll-pad"
              spacerClassName="order-2"
            >
              {/*
               * DRAWN LAST, WRITTEN FIRST, AND THE SCROLLER IS WHY. Three reviewers have now arrived
               * at this block, worked the mechanism out from the library's bundle, and reached the
               * same place; it had no comment for any of them to read. This is that comment.
               *
               * `MessageScrollerContent` is `flex flex-col`, so `order` is live: the spacer takes
               * `order-2`, these children take `order-1`, and the transcript rows below keep the
               * default `0`. Visual order is therefore items, then anything parked or in flight, then
               * the spacer — while DOM order puts this block first.
               *
               * IT CANNOT SIMPLY BE MOVED DOWN. The scroller finds a newly appended row POSITIONALLY.
               * On every content change it takes `Array.from(content.children)` minus the spacer,
               * compares the length against the previous length, and when it grew scans FROM THE OLD
               * LENGTH FORWARD for the next `data-scroll-anchor="true"` (`je(a, T)` in
               * `@shadcn/react/dist/message-scroller`). A new row is only found when it lands at the
               * very end of that list. Put this block after `items.map` and every appended row lands
               * one slot short of the end, the scan finds this div instead, returns null, and the
               * caller falls through to its follow-the-bottom branch — so a new turn stops aligning
               * to the top of the viewport with a peek of the previous one, silently, with no test
               * failing.
               *
               * `display: contents` IS LOAD-BEARING FOR THE SAME REASON, and not a layout trick. It
               * promotes these children to flex items of the column so they can carry `order`, while
               * the div itself stays a single, always-present entry in `content.children` — one
               * stable slot the row count can be offset by. Wrapping `items.map` the same way would
               * be the natural symmetry and is fatal: the rows would leave `content.children`
               * entirely and the scroller would see a transcript of two elements, neither carrying a
               * `data-message-id`, so nothing would register, be tracked as visible, or anchor.
               *
               * WHAT THIS COSTS, STATED RATHER THAN LEFT TO BE REDISCOVERED. `order` moves paint and
               * not the DOM, so it moves neither focus order nor the reading order of the enclosing
               * `role="log"`. A keyboard user tabbing in reaches the "Remove queued message: …"
               * button of every parked message before any control in the conversation, though those
               * lines are drawn at the very bottom (WCAG 2.4.3); a screen reader reading the log
               * linearly hears the parked messages, and `Stopped`, ahead of the conversation they
               * follow on screen (WCAG 1.3.2).
               *
               * THAT IS A KNOWN, UNPAID DEBT AND NOT AN OVERSIGHT. The fixes available from inside
               * this file were each tried on paper and each breaks something worse: `aria-owns` needs
               * a generated id per row and re-sequences only the accessibility tree, leaving tab
               * order inverted; positive `tabIndex` hijacks the tab sequence of the whole page;
               * hoisting the queue out of `MessageScrollerContent` into a sibling region — the
               * cleanest END STATE, since a parked message is genuinely not a log entry — puts it
               * outside a column that is `min-h-full`, so it lands below the fold on a short
               * transcript, outside the `gap-6` rhythm, and outside the spacer's height arithmetic.
               * Paying it properly means the scroller identifying new rows by identity rather than by
               * position, which is the library's to change and is worth asking for.
               */}
              {/*
               * chat-tail：这一格在 DOM 里排在所有消息前面、画在最下面（order-1）。浏览器的滚动锚定（overflow-anchor）按 DOM 顺序
               * 挑第一个看得见的元素当锚——总挑中这里的留白 /「思考中」。上面的行一长，浏览器为了让锚不动先把 scrollTop 往下推，
               * 下一帧留白吃掉了再夹回来 = 往回挪一下（§94.6，1280 实测 5–8px）。这一格不参与锚定，锚落在看得见的第一条消息上。
               */}
              <div className="chat-tail contents [&>*]:order-1">
                <span
                  className="sr-only"
                  data-testid="transcript-live-status"
                  role="status"
                >
                  {liveStatus}
                </span>
                {/*
                 * 状态行固定槽（§94.7）：「思考中」/ 干活胶囊 / 暂停 /「已停止」在 38px 高的格子里出现、换样、收起，
                 * 格子一直占着那 38px，列高不变。以前这一行从 0 长出来，钉在底部时 scrollTop 跟着整列 +38px，
                 * 每一轮开始整段对话都往上挪一下；§88.1 的留白只能吃「变矮」，吃不下「从 0 长高」。
                 * 38px = 胶囊实际高（status-capsule.css：9 + 20 行高 + 9）；「已停止」更高的部分仍会长列，
                 * 但最常见的「每轮开始出胶囊」完全不画面。
                 */}
                <div className="chat-status-slot">
                  {tailStop ? (
                    <Stopped
                      onRetry={stopped ? onRetry : onRetryUnanswered}
                      onWithdraw={onWithdraw}
                      reason={tailStop}
                    />
                  ) : liveWorkInTail && liveWork ? (
                    <WorkRow
                      calls={liveWork.calls}
                      agentId={agentId}
                      live
                      notes={liveWork.notes}
                      since={liveSince}
                      statusLabel={workStatusLabel}
                      turnKey={liveWork.key}
                    />
                  ) : waitingOnFirstToken ? (
                    <Thinking
                      since={liveSince}
                      label={connectionLabel ?? "思考中"}
                    />
                  ) : pausedAfterText !== null ? (
                    <PausedCapsule
                      since={liveSince}
                      watch={pausedAfterText}
                      label={connectionLabel}
                    />
                  ) : null}
                  {!tailStop ? (
                    <StatusSlotExitGhost
                      active={Boolean(
                        (liveWorkInTail && liveWork) ||
                          waitingOnFirstToken ||
                          pausedAfterText !== null,
                      )}
                      snapshot={
                        liveWorkInTail && liveWork
                          ? {
                              label:
                                workStatusLabel ??
                                summarizeWork(liveWork.calls)?.current ??
                                "处理中",
                              since: liveSince,
                            }
                          : waitingOnFirstToken
                            ? {
                                label: connectionLabel ?? "思考中",
                                since: liveSince,
                              }
                            : null
                      }
                    />
                  ) : null}
                </div>
                <LooseConfirmCards
                  resumed={resumedCards}
                  version={items.length}
                />
                {queued.map((message) => (
                  <Queued
                    attachments={message.attachments}
                    held={queuedHeld}
                    key={message.id}
                    onRemove={
                      onRemoveQueued
                        ? () => onRemoveQueued(message.id)
                        : undefined
                    }
                    text={message.text}
                  />
                ))}
                {/*
                 * The retry is one row for the whole stack: `settle` sends every parked message as one
                 * turn, so a button per row would offer several names for the same send.
                 */}
                {queuedHeld && onRetryQueued && queued.length > 0 ? (
                  <MessageRow align="end">
                    <MessageContent>
                      <MessageFooter>
                        <button
                          aria-label={"重试发送排队的消息"}
                          className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                          onClick={onRetryQueued}
                          type="button"
                        >
                          {"重试"}
                        </button>
                      </MessageFooter>
                    </MessageContent>
                  </MessageRow>
                ) : null}
                {/* 回答期间发的、进了服务器收件箱的（DESIGN.md §38.1）：读到之前画在这里，读到后出现在它被读到的位置。 */}
                <QueuedMessages />
                {/* 最后一条下面的留白（§88.1）：在这一格里，不算一行；高度由 SettleAtEnd 直接改。 */}
                <div
                  aria-hidden
                  className="chat-slack"
                  data-chat-slack=""
                  ref={slackRef}
                  style={{ display: "none" }}
                />
              </div>
              {topNotice ? (
                <div className="chat-top-notice">{topNotice}</div>
              ) : null}
              {/*
               * 「显示更早的消息」（聊天记录消失，2026-11-10）：上面还有没挂的历史时一直在。以前只靠滚到顶附近补，
               * 挂着的内容不够一屏高时根本滚不动，上面的历史就再也出不来。外层 `contents` 的 div 一直在
               * （content.children 里固定占一格，滚动容器按位置找新行，见上面 chat-tail 的说明）；
               * 按钮自己不参与滚动锚定，补上来的行出现在它下面、看着的那一行不动。
               */}
              <div className="contents" data-testid="transcript-history-more">
                {tailTruncated && !virtual && firstMountedVisible ? (
                  <button
                    className="chat-history-more"
                    data-surface="bubble"
                    onClick={prependHistory}
                    type="button"
                  >
                    {"显示更早的消息"}
                  </button>
                ) : null}
              </div>
              {items.length === 0 && restoring ? <RestoringTranscript /> : null}
              {virtual ? (
                <VirtualTranscriptRows
                  cells={virtualCells}
                  handleRef={virtualHandle}
                  layoutKey={topNotice ? 1 : 0}
                  scrollKey={scrollKey ?? ""}
                  viewportRef={viewportRef}
                />
              ) : null}
              {virtual
                ? tailNodes
                : mountedRows.flatMap(([item, index]) => rowsFor(item, index))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          {virtual ? (
            <VirtualTranscriptControls
              handleRef={virtualHandle}
              items={items}
              layerRef={dataLayerRef}
              textOf={findTextOf}
              viewportRef={viewportRef}
              virtualIds={virtualCells.map((cell) => cell.id)}
            />
          ) : null}
          {BOTTOM_PILL}
          <ScrollNewestQueuedIntoView
            newest={queued.at(-1)?.id ?? null}
            viewport={viewportRef}
          />
          <VisibleApprovalPoll enabled={approvalsEnabled} />
          <SettleAtEnd
            busy={busy || live}
            hydrating={hydrating}
            newestUserMessageId={newestUserMessageId}
            opening={opening}
            viewport={viewportRef}
            slack={slackRef}
            sendMode={sendMode}
            {...(scrollKey ? { scrollKey } : {})}
          />
        </MessageScroller>
      </MessageScrollerProvider>
    </TtsReadyContext.Provider>
  );

  /** 一条消息对应的那几行（它自己 + 跟着它的「已停止」/备用说明）。旧路径和虚拟化共用。 */
  function rowsFor(item: TranscriptItem, index: number): ReactNode[] {
    const stoppedHere = compact.stoppedAfter.has(item.id);
    const fallback = compact.fallbackAfter.get(item.id);
    // 「这一轮没有回答」：最后一轮已经有错误卡（带重试）时不再挂一遍。
    const noAnswer = compact.noAnswerAfter.get(item.id);
    const noAnswerHere = noAnswer !== undefined && !(noAnswer.last && tailStop);
    const hidden = rowHidden(item.id);
    const row = hidden
      ? foldedRef.current.has(item.id)
        ? renderFolded(item, index)
        : null
      : renderRow(item, index);
    // 「已停止」/备用说明必须跟着 compact 锚点画出来：锚点行若因 quiet/fold 卸掉，
    // 以前连标记一起 return null，刷新后只剩服务器误锚时就像挂在上一轮回答下面。
    // Keep every keyed row in one flat sibling list. Returning a nested array only
    // when a marker appears changes the anchor row's React parent and remounts it.
    if (!stoppedHere && !fallback && !noAnswerHere) return [row];
    return [
      row,
      noAnswerHere ? (
        <MessageScrollerItem
          key={`${item.id}:no-answer`}
          messageId={`${item.id}:no-answer`}
        >
          <NoAnswerRow
            onRetry={noAnswer?.last && !live ? onRetryUnanswered : undefined}
          />
        </MessageScrollerItem>
      ) : null,
      stoppedHere ? (
        <MessageScrollerItem
          key={`${item.id}:stopped`}
          messageId={`${item.id}:stopped`}
        >
          <div className="chat-stopped-mark" data-testid="turn-stopped">
            {"◼ 已停止"}
          </div>
        </MessageScrollerItem>
      ) : null,
      fallback ? (
        <MessageScrollerItem
          key={`${item.id}:fallback`}
          messageId={`${item.id}:fallback`}
        >
          <div className="chat-fallback-note" data-testid="turn-fallback">
            {fallback}
          </div>
        </MessageScrollerItem>
      ) : null,
    ];
  }

  /** 干活胶囊行：进行中固定画在末尾 `.chat-status-slot` 里，其余时机留在第一个工具行。打开「调试：显示工具调用」时不画。 */
  function workRowFor(id: string) {
    if (showToolActivity || quietWorkOnly.has(id)) return null;
    const work = compact.work.get(id);
    if (!work || (work.live && liveWorkInTail)) return null;
    return (
      <WorkRow
        calls={work.calls}
        agentId={agentId}
        live={work.live}
        statusLabel={work.live ? connectionLabel : undefined}
        notes={work.notes}
        since={work.live ? liveSince : undefined}
        turnKey={work.key}
        unanswered={!work.live && !work.stopped && !work.answered}
      />
    );
  }

  /** 刚被收起的一行：原样画着，外层 `data-folded` 收成 0 高（§82.9）；读屏和 Tab 都跳过它。 */
  function renderFolded(item: TranscriptItem, index: number) {
    const row = renderRow(item, index);
    if (!isValidElement<Record<string, unknown>>(row)) return null;
    return cloneElement(row, {
      "aria-hidden": true,
      "data-folded": "",
      inert: true,
      scrollAnchor: false,
    });
  }

  function renderRow(item: TranscriptItem, index: number) {
    return item.kind === "browser" ? (
      <MessageScrollerItem
        data-row="activity"
        key={item.id}
        messageId={item.id}
      >
        <Arriving delay={delays.delayFor(item.id, index, items.length)}>
          <BrowserActivity
            group={item}
            active={busy && index === items.length - 1}
          />
        </Arriving>
        {workRowFor(item.id)}
      </MessageScrollerItem>
    ) : item.kind === "tool" ? (
      <MessageScrollerItem
        data-row="activity"
        key={item.id}
        messageId={item.id}
      >
        <TranscriptToolCall
          args={item.toolCall.function.arguments}
          delay={delays.delayFor(item.id, index, items.length)}
          name={item.toolCall.function.name}
          result={item.result}
          toolCallId={item.toolCall.id}
          turnEnded={!compact.liveTools.has(item.id)}
        />
        <ActivityJumpButton
          name={item.toolCall.function.name}
          toolCallId={item.toolCall.id}
        />
        {/* 确认卡片（DESIGN.md §58）：画在这个工具调用下面；设备改文件时带 diff（§62）。 */}
        <ToolCallConfirmCards
          answered={item.result !== undefined}
          recent={index >= items.length - 8}
          toolCallId={item.toolCall.id}
        />
        {workRowFor(item.id)}
      </MessageScrollerItem>
    ) : item.kind === "activity" ? (
      <MessageScrollerItem key={item.id} messageId={item.id}>
        <TranscriptActivity
          delay={delays.delayFor(item.id, index, items.length)}
          message={item.message}
        />
      </MessageScrollerItem>
    ) : item.kind === "text" ? (
      <MessageScrollerItem
        key={item.id}
        messageId={item.id}
        scrollAnchor={anchorRows.has(item.id)}
      >
        <TranscriptMessage
          animate={delays.animateFor(item.id)}
          attachments={
            index > 0 &&
            items[index - 1]?.kind === "attachments" &&
            items[index - 1]?.id === `${item.id}:attachments`
              ? (
                  items[index - 1] as Extract<
                    TranscriptItem,
                    { kind: "attachments" }
                  >
                ).attachments
              : undefined
          }
          canRegenerate={item.id === regenerateId}
          commandNames={commandNames}
          delay={delays.delayFor(item.id, index, items.length)}
          editable={
            isPersonSentMessage(item.role, item.text) &&
            isEditableUserText(item.text)
          }
          memories={compact.memories.get(item.id)}
          messageId={item.id}
          replyToId={compact.replyTo.get(item.id)?.id}
          replyToText={compact.replyTo.get(item.id)?.text}
          role={item.role}
          text={item.text}
          tone={compact.tone.get(item.id)}
        />
      </MessageScrollerItem>
    ) : item.kind === "attachments" ? (
      <MessageScrollerItem
        key={item.id}
        messageId={item.id}
        scrollAnchor={anchorRows.has(item.id)}
      >
        {(() => {
          const parentId = item.id.endsWith(":attachments")
            ? item.id.slice(0, -":attachments".length)
            : undefined;
          const next = items[index + 1];
          const standalone = Boolean(
            parentId && !(next?.kind === "text" && next.id === parentId),
          );
          return (
            <TranscriptAttachments
              attachments={item.attachments}
              delay={delays.delayFor(item.id, index, items.length)}
              messageId={parentId}
              standalone={standalone}
            />
          );
        })()}
      </MessageScrollerItem>
    ) : (
      // Every member of the union is handled above. `assertNever` types `item` as
      // `never` here, so a future addition to `VisibleChatItem` fails to typecheck at
      // this call instead of silently falling into this branch and rendering nothing.
      assertNever(item)
    );
  }
}

export const ChatTranscript = memo(
  ChatTranscriptImpl,
  areChatTranscriptPropsEqual,
);

const EMPTY_STOPS: ReadonlySet<string> = new Set();

/** 应用内搜索（jank P3-3）搜的文字：只搜对话里的正文（人说的、机器人说的）。 */
export function findTextOf(item: TranscriptItem): string | null {
  return item.kind === "text" ? item.text : null;
}
const EMPTY_ANCHORS: ReadonlySet<string> = new Set();
const EMPTY_MARKS: readonly number[] = [];

/** 刚发出去的那条用户消息带对齐标记多久（毫秒）。对齐在它出现的那一刻就做完了，之后留着只会被误用。 */
export const FRESH_ANCHOR_MS = 3000;

/** 最近一次新出现的用户消息是不是「连续聊天」里发的（§94）。 */
type SendMode = { id: string | null; continuous: boolean };

/**
 * 这段对话还在「打开」：`hydrating`，以及恢复完成后 SETTLE_AFTER_HYDRATE_MS 之内（DESIGN.md §83）。
 *
 * 恢复完成的那一刻 `hydrating` 就和恢复好的消息一起变 false，所以只看它不够：那一次提交里最先出现的最新一条
 * 用户消息是历史，不是「人刚发的」。这段时间里到的消息一律按「历史补齐」处理——不带对齐标记、不平滑滚、
 * 不记成本机发出的时刻。这段时间里人真的发了消息（少见，刚打开就发）也按贴底处理，不翻页。
 */
function useOpeningWindow(hydrating: boolean): boolean {
  /*
   * 不用 state：恢复完成的那一次提交里就要算对。用 state 的话那一次渲染拿到的还是旧值（`setUntil` 要等下一次
   * 渲染），那一次提交里出现的用户消息已经先被当成「刚发的」处理过了——滚动容器正是在那一次提交后的微任务里
   * 读标记的。
   *
   * 只有「确实恢复过」（`hydrating` 真为 true 过）才有这个窗口：从新建对话页带着第一条消息挂上来的（`hydrating`
   * 一直是 false）没有历史要补，第一句话照旧翻页到视口上 1/3。
   */
  const recovered = useRef(hydrating);
  const startedAt = useRef(0);
  if (hydrating) {
    recovered.current = true;
    startedAt.current = 0;
  } else if (recovered.current && startedAt.current === 0) {
    startedAt.current = performance.now();
  }
  return (
    hydrating ||
    (startedAt.current > 0 &&
      performance.now() < startedAt.current + SETTLE_AFTER_HYDRATE_MS)
  );
}

/**
 * 恢复完成之后新出现的最新一条用户消息（人刚发的，或者别的设备发来的）；出现 FRESH_ANCHOR_MS 之后就没了。
 * 打开这段对话的窗口里（`opening`）到的都不是新消息：那时最新一条变了只说明历史补齐了，只重新记基线。
 * 在渲染时算出来：滚动容器在这一次提交后的微任务里读标记，晚一拍（effect 里再 setState）就错过了。
 */
function useFreshAnchor(
  newestUserMessageId: string | null,
  opening: boolean,
  lastSentAt: SentAtReading | null = null,
  sendMode?: React.RefObject<SendMode>,
): string | null {
  const reducedMotion = useSharedReducedMotion();
  const seen = useRef<{
    baseline: string | null;
    id: string | null;
    at: number;
    last: string | null;
    continuous: boolean;
  } | null>(null);
  if (seen.current === null)
    seen.current = {
      baseline: newestUserMessageId,
      id: null,
      at: 0,
      last: newestUserMessageId,
      continuous: false,
    };
  const memo = seen.current;
  if (opening) {
    /*
     * 历史到的每一段都只是「这一段原来是这样」：最新一条换了就重新记基线，不当成新的一轮。
     * `memo.last` 照常跟着走，下一个真的发送才能拿服务器读数算出「上一条多久之前」。
     */
    if (newestUserMessageId !== memo.baseline)
      memo.baseline = newestUserMessageId;
    memo.id = null;
    memo.continuous = false;
    if (sendMode) sendMode.current = { id: null, continuous: false };
  } else if (
    newestUserMessageId !== null &&
    newestUserMessageId !== memo.baseline &&
    newestUserMessageId !== memo.id
  ) {
    const now = Date.now();
    // 发消息一律走「连续跟底」模式（continuous = true），不再触发「把用户消息翻到视口上 1/3 + 底部垫 2/3 屏空白」的翻页跳动。
    void staysInSameTurn(
      previousSentAt(memo.last, lastSentAt),
      now,
      takeSendWhileBusy(now),
    );
    void reducedMotion;
    memo.continuous = true;
    memo.id = newestUserMessageId;
    memo.at = now;
    rememberSent(newestUserMessageId, now);
    if (sendMode)
      sendMode.current = {
        id: newestUserMessageId,
        continuous: memo.continuous,
      };
  }
  memo.last = newestUserMessageId;
  const fresh =
    !opening &&
    !memo.continuous &&
    memo.id !== null &&
    memo.id === newestUserMessageId &&
    Date.now() - memo.at < FRESH_ANCHOR_MS;
  // 过期后重画一次，把标记拿掉。
  const [, expire] = useState(0);
  useExternalConnection(
    fresh ? `${objectConnectionKey(memo)}\0${memo.at}` : false,
    () => {
      const timer = window.setTimeout(
        () => expire((n) => n + 1),
        FRESH_ANCHOR_MS - (Date.now() - memo.at) + 20,
      );
      return () => window.clearTimeout(timer);
    },
  );
  return fresh ? memo.id : null;
}

/**
 * 最后一轮（最后一条用户自己发的消息之后）最后一段看得见的回答文字；没有为 null。重新生成挂在它下面。
 */
export function lastAnswerId(
  items: readonly TranscriptItem[],
  hidden: ReadonlySet<string>,
): string | null {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at];
    if (!item) continue;
    if (item.kind === "attachments") return null;
    if (item.kind !== "text") continue;
    if (isPersonSentMessage(item.role, item.text)) return null;
    if (item.role === "assistant" && item.text.trim() && !hidden.has(item.id))
      return item.id;
  }
  return null;
}

/**
 * 一轮收成「开场一句 → 结果」（频道聊天版，规则与 lib/conversations/turn-compaction.ts 相同，2026-10-13 第四轮）。
 *
 *  - 每轮第一段助手文字 = 开场一句（气泡，没有复制）；
 *  - 结果 = 最后一段文字，且它后面没有再调工具 / 开网页；这一轮还在跑或被用户停掉时没有结果；
 *  - 中间的过程话：没结果时一行淡色小字；有了结果就收起；
 *  - 开网页的小条每轮只留最后一组；
 *  - 被停掉的一轮：最后一个看得见的行后面挂「已停止」。
 *  - 有干活卡的一轮（§90）：过程话收进卡片（点开在步骤之间按顺序列出），不再在卡片下面散成一段淡色字——
 *    后面又调了工具的那段马上收；这一轮结束了（有结果 / 出错 / 停止 / 中断）剩下的过程话也收。
 *    还在跑、后面还没调工具的最后一段照旧露在外面（它可能就是正在写的结果）。
 */
/** 一轮的干活卡（§75.1 / §90 / §93）。 */
export type WorkEntry = {
  calls: WorkCall[];
  key: string;
  live: boolean;
  notes: WorkNote[];
  /** 这一轮结束了（不在跑）：干活那一行整行收起，胶囊只在干活时画（§123）。 */
  quiet: boolean;
  /** 这一轮有看得见的回答（结果气泡、卡片、留着的气泡）。没有时挂「这一轮没有回答」（回复显示①）。 */
  answered: boolean;
  /** 这一轮被用户停掉了。 */
  stopped: boolean;
};

/** 记忆写入（Memory Pill）：挂在回复气泡下面，不算干活，不把一段回答切成「过程话 + 结果」。 */
const MEMORY_WRITES = new Set(["memory_save", "memory_update", "memory_log"]);

export type CardItem = Extract<TranscriptItem, { kind: "tool" | "activity" }>;
/** `live`：这个调用所在的那一轮还在跑（compactTurns 按轮给）。 */
export type DrawsCard = (item: CardItem, live: boolean) => boolean;
const drawsRenderUi: DrawsCard = (item) =>
  item.kind === "tool" && item.toolCall.function.name === "render_ui";

/**
 * 一个工具调用画没画用户看得见的卡片（回复显示①复审）：和 `TranscriptToolCall` 画什么同一套判断——
 * 有渲染器就画渲染器（只画一行过程 / 什么都不画的、注册时标了 `lineOnlyRender` 的不算卡片；工具有了结果以后，
 * 渲染器登记过判断的（`registerCardCheck`：图片 / 文件工具没拿到文件、定时任务被拒、render_ui 画不出东西时返回 null）
 * 问它自己，和它决定画不画用同一个函数），
 * 没有就是 `ServerToolLine`（只有宿主被拒是看得见的提示）；另外有确认卡 / 审批卡挂着（`asked`）的也算。
 */
export function toolDrawsCard(
  tool: CardItem,
  {
    renderers,
    activities = [],
    agentId,
    asked,
    checks = registeredCardChecks,
    live = true,
  }: {
    renderers: Parameters<typeof pickToolRenderer>[0];
    /** 活动消息的渲染器（`renderActivityMessage` 只有找到渲染器才画）。 */
    activities?: readonly { activityType: string }[];
    agentId?: string;
    asked: ReadonlySet<string>;
    /** 渲染器登记的「画没画出卡片」判断（按工具名）；默认用渲染器模块登记的那一份。 */
    checks?: CardChecks;
    /** 这个调用所在的那一轮还在跑（默认 true）。结束了、结果一直没来时，骨架换成「没有完成」，不算卡片。 */
    live?: boolean;
  },
): boolean {
  if (tool.kind === "activity")
    return activities.some(
      (renderer) =>
        renderer.activityType === tool.message.activityType ||
        renderer.activityType === "*",
    );
  if (asked.has(tool.toolCall.id)) return true;
  const name = tool.toolCall.function.name;
  const renderer = pickToolRenderer(renderers, name, agentId);
  if (renderer) {
    if (isLineOnlyRender(renderer.render)) return false;
    // 失败时会返回 null 的渲染器由它自己的判断说了算。还没有结果：这一轮还在跑时画骨架，算卡片；
    // 这一轮结束了（没按停止，工具也一直没回）骨架换成「没有完成」（TranscriptToolCall），不算卡片（复审 #404 第四轮）。
    const check =
      renderer.name === name || renderer.match?.(name)
        ? getCardCheck(checks, name)
        : undefined;
    if (!check) return true;
    if (tool.result === undefined) return live;
    return check({
      args: tool.toolCall.function.arguments,
      result: tool.result,
    });
  }
  return isHostAccessRefusal(tool.toolCall.function.name, tool.result);
}

export function compactTurns(
  items: readonly TranscriptItem[],
  busy: boolean,
  stopped: ReadonlySet<string>,
  fallbacks?: ReadonlyMap<string, string>,
  /**
   * 这个工具调用在对话里画了看得见的卡片（或正在等确认）：以它收尾的一轮算有回答。ChatTranscript 传
   * `useToolCardCheck` 的结果（和真正画卡片用同一份渲染器 / 确认 / 宿主提示）；不传时只认 render_ui。
   */
  drawsCard: DrawsCard = drawsRenderUi,
): {
  tone: Map<string, "lead" | "step" | "final">;
  hidden: Set<string>;
  /** 被停掉的轮次：最后一个看得见的行（后面挂「已停止」）。 */
  stoppedAfter: Set<string>;
  /** 换了备用模型的轮次：最后一个看得见的行 → 说明（§61）。 */
  fallbackAfter: Map<string, string>;
  /**
   * 干活卡（§75.1）：这一轮第一个干活的工具那一行 → 这一轮的全部调用、是否还在跑；key = 这一轮开头那条消息（记用时用）。
   * 还在跑时画实时卡；这一轮一结束，那一行整行收起（§123：胶囊只在思考和干活时出现）。
   */
  work: Map<string, WorkEntry>;
  /** Hark 式回复引用（`╭─`）：当用户连发多条或中途插话时，助手回复自动挂上所回应的用户原话与消息 id。 */
  replyTo: Map<string, ReplyTarget>;
  /** 记忆写入微胶囊提示（Memory Pill）：本轮调用了 memory_save / memory_update / memory_log 时挂在回复气泡下方。 */
  memories: Map<string, MemoryPillItem[]>;
  /**
   * 结束了、没被停掉、却一个看得见的回答都没有的轮次（工具失败后没有字、只回了「---」，回复显示①）：
   * 最后一个看得见的行 → 后面挂「这一轮没有回答」；`last` = 这是最后一轮（只有它带重试）。
   */
  noAnswerAfter: Map<string, { last: boolean }>;
  /** 正在跑的那一轮里的工具调用 id：其余的调用所在的那一轮都已经结束（TranscriptToolCall 据此把卡住的骨架换成「没有完成」）。 */
  liveTools: Set<string>;
  /** 正在跑的那一轮的 key（开启它的那条消息 id，同干活卡的 `key`）；不在跑为 null。胶囊的秒数按它记开始时间。 */
  liveKey: string | null;
} {
  const tone = new Map<string, "lead" | "step" | "final">();
  const hidden = new Set<string>();
  const stoppedAfter = new Set<string>();
  const fallbackAfter = new Map<string, string>();
  const work = new Map<string, WorkEntry>();
  const replyTo = new Map<string, ReplyTarget>();
  const memories = new Map<string, MemoryPillItem[]>();
  const noAnswerAfter = new Map<string, { last: boolean }>();
  const liveTools = new Set<string>();
  let liveKey: string | null = null;
  const formatQuoteText = (raw: string): string => {
    const clean = (splitChatOrigin(raw)?.text ?? raw)
      .replace(/\s+/g, " ")
      .trim();
    return clean.length > 64 ? `${clean.slice(0, 63)}…` : clean;
  };
  // 一轮的开头：人发的消息，或服务器放进来、接着跑一轮的那几种（定时任务 / 任务结果 / 后来确认，CB-046）。
  const sent = (item: TranscriptItem) =>
    item.kind === "attachments" ||
    (item.kind === "text" &&
      (isPersonSentMessage(item.role, item.text) ||
        (item.role === "user" && serverRowKind(item.text) !== null)));
  let current: { users: TranscriptItem[]; rest: TranscriptItem[] } = {
    users: [],
    rest: [],
  };
  const turns: { users: TranscriptItem[]; rest: TranscriptItem[] }[] = [
    current,
  ];
  for (const item of items) {
    if (sent(item)) {
      if (current.rest.length === 0 && current.users.length > 0)
        current.users.push(item);
      else {
        current = { users: [item], rest: [] };
        turns.push(current);
      }
    } else current.rest.push(item);
  }
  const personTextsOf = (list: readonly TranscriptItem[]) =>
    list.filter(
      (u): u is Extract<TranscriptItem, { kind: "text" }> =>
        u.kind === "text" &&
        isPersonSentMessage(u.role, u.text) &&
        u.text.trim().length > 0,
    );
  turns.forEach((turn, index) => {
    const live = busy && index === turns.length - 1;
    if (live)
      for (const item of turn.rest)
        if (item.kind === "tool") liveTools.add(item.id);
    const isStopped =
      !live && turn.users.some((user) => stopped.has(turnOf(user)));
    // 真的在干活的一步（同干活卡 isWorkCall，再去掉记忆写入）：回答和过程话以最后一个这样的步骤为界。
    const doesWork = (item: TranscriptItem) =>
      item.kind === "browser" ||
      (item.kind === "tool" &&
        isWorkCall(item.toolCall.function.name) &&
        !MEMORY_WRITES.has(item.toolCall.function.name));
    const texts = turn.rest.filter(
      (item): item is Extract<TranscriptItem, { kind: "text" }> =>
        item.kind === "text" &&
        item.role === "assistant" &&
        !isBlankNote(item.text),
    );
    // 回复显示①：只有「---」这类分隔线、一个字都没有的一段不画（以前画成一个空的分隔线气泡，或干活卡里空的一步）。
    for (const item of turn.rest)
      if (
        item.kind === "text" &&
        item.role === "assistant" &&
        item.text.trim().length > 0 &&
        isBlankNote(item.text)
      )
        hidden.add(item.id);
    // 单次逆序扫描定位最后一个「干活」步骤的下标（O(N) 替代循环内 indexOf + slice().some 的 O(N²)）。
    let lastWorkAt = -1;
    for (let at = turn.rest.length - 1; at >= 0; at -= 1) {
      const candidate = turn.rest[at];
      if (candidate && doesWork(candidate)) {
        lastWorkAt = at;
        break;
      }
    }
    const restIndex = new Map<TranscriptItem, number>();
    for (let at = 0; at < turn.rest.length; at += 1) {
      const entry = turn.rest[at];
      if (entry) restIndex.set(entry, at);
    }
    let final: string | null = null;
    texts.forEach((item, i) => {
      const at = restIndex.get(item) ?? -1;
      const toolAfter = at >= 0 && at < lastWorkAt;
      if (i === texts.length - 1 && !live && !isStopped && !toolAfter) {
        final = item.id;
        tone.set(item.id, "final");
      } else tone.set(item.id, i === 0 ? "lead" : "step");
    });
    /*
     * 以卡片收尾的一轮（最后一个看得见的是 render_ui 画的卡片，后面没有文字，§75.3）：卡片就是结果。
     * 卡片前最后一段话当结果那句话（气泡，带复制），更早的过程话收起——以前它们一直是一行行淡色小字，
     * 把「我再核对一下深圳」这种过程留在了答案上面。
     */
    if (!final && !live && !isStopped && texts.length > 1) {
      let lastRest: TranscriptItem | undefined;
      for (let at = turn.rest.length - 1; at >= 0; at -= 1) {
        const candidate = turn.rest[at];
        if (
          candidate &&
          (candidate.kind !== "text" ||
            candidate.role !== "assistant" ||
            candidate.text.trim())
        ) {
          lastRest = candidate;
          break;
        }
      }
      if (
        lastRest?.kind === "tool" &&
        lastRest.toolCall.function.name === "render_ui"
      ) {
        const promoted = texts[texts.length - 1];
        if (promoted) {
          final = promoted.id;
          tone.set(promoted.id, "final");
        }
      }
    }
    /*
     * 最后一个干活的步骤之后的全部文字（一直到结果）都是回答，不是过程话：照旧是气泡，不收起、不进卡片，
     * 和结果一样画（tone 为 final：带链接卡、复制按钮；重新生成仍只挂在最后一条回答上）。
     * 以前只认最后一条是结果，连发三条中间那条被当过程话藏起来，有干活卡时第一段也进了卡片，只剩最后一条。
     * 记忆写入这类不算干活的工具夹在回答中间，不当分界。干活之前的开场一句规则不变（§93）。
     */
    const replies = new Set<string>();
    if (final) {
      for (const item of texts)
        if (
          (restIndex.get(item) ?? -1) > lastWorkAt &&
          tone.get(item.id) !== "final"
        ) {
          tone.set(item.id, "final");
          replies.add(item.id);
        }
    }
    const personUsers = personTextsOf(turn.users);
    const prevTurn = index > 0 ? turns[index - 1] : undefined;
    const prevUsers = prevTurn ? personTextsOf(prevTurn.users) : [];
    const prevTurnStopped = prevTurn?.users.some((user) =>
      stopped.has(turnOf(user)),
    );
    const prevInterjected =
      prevTurn !== undefined &&
      !prevTurnStopped &&
      prevUsers.length > 0 &&
      prevTurn.rest.length > 0 &&
      !prevTurn.rest.some(
        (r) => r.kind === "text" && tone.get(r.id) === "final",
      );
    const multiReplyTurn =
      (personUsers.length > 1 || prevInterjected) && texts.length > 1;
    if (final)
      for (const item of texts)
        if (
          tone.get(item.id) === "step" &&
          !(multiReplyTurn && item.id === texts[0]?.id)
        )
          hidden.add(item.id);
    const browsers = turn.rest.filter((item) => item.kind === "browser");
    for (const item of browsers.slice(0, -1)) hidden.add(item.id);
    if (live) liveKey = turn.users[turn.users.length - 1]?.id ?? null;
    let workAnchor: string | null = null;
    // 干活卡（§75.1）：这一轮全部调用；画在第一个干活的工具那一行（浏览只留最后一组，所以落在浏览上时用最后那一组）。
    {
      const calls: WorkCall[] = [];
      let anchor: string | null = null;
      for (const item of turn.rest) {
        const tools =
          item.kind === "tool"
            ? [item]
            : item.kind === "browser"
              ? item.steps
              : [];
        for (const tool of tools) {
          const name = tool.toolCall.function.name;
          // 被停掉的一轮里没返回的那几步：「已停止」，不算失败（审查模块 7）。
          const stoppedCall = isStopped && workCallInterrupted(tool.result);
          calls.push({
            name,
            arguments: tool.toolCall.function.arguments,
            done: tool.result !== undefined && !stoppedCall,
            id: tool.toolCall.id,
            failed:
              !stoppedCall &&
              tool.result !== undefined &&
              workCallFailed(tool.result),
            ...(stoppedCall ? { stopped: true } : {}),
          });
          if (anchor === null && isWorkCall(name)) anchor = item.id;
        }
      }
      if (anchor !== null && hidden.has(anchor))
        anchor = browsers.at(-1)?.id ?? null;
      const key = turn.users[turn.users.length - 1]?.id;
      if (anchor !== null && key) {
        /*
         * 过程话收进卡片（§90）。出错收尾、最后一段后面没有工具的那段照旧当结果：本机看到的「出错」常常只是
         * 本机的流断了，服务器接着把真正的回答写完了（§90.4），按出错把最后一段收起会把回答藏起来。
         */
        const notes: WorkNote[] = [];
        let seen = 0;
        turn.rest.forEach((item, at) => {
          if (item.kind === "tool") seen += 1;
          else if (item.kind === "browser") seen += item.steps.length;
          /*
           * 开场一句也是过程话（§93，改 §90 的「卡片之前的开场一句照旧是气泡」）：有干活卡的一轮里，
           * 「我来查看你当前在线电脑的屏幕…」后面就是干活的工具，和两步之间的话一样收进卡片（实时时下一步一开始就收）。
           * 出现在卡片之后的开场一句（先干活后说话）同理。
           * 例外：当用户连发多条或中途插话（multiReplyTurn）且第一段是在回应前一条消息时，保留该气泡不折叠。
           */ else if (
            item.kind === "text" &&
            (tone.get(item.id) === "step" || tone.get(item.id) === "lead") &&
            !replies.has(item.id) &&
            !(multiReplyTurn && item.id === texts[0]?.id) &&
            !/^\s*>\s+\S/.test(item.text)
          ) {
            const workAfter = at < lastWorkAt;
            if (!live || workAfter) {
              hidden.add(item.id);
              notes.push({ at: seen, text: item.text });
            }
          }
        });
        // 胶囊只在思考和干活时出现（回复显示②，§123）：这一轮一结束，干活那一行整行收起——
        // 做完的、被停的、没回答的都一样收起（「◼ 已停止」「这一轮没有回答」是另外的行）。还在跑的照旧画着。
        const quiet = !live;
        workAnchor = anchor;
        work.set(anchor, {
          calls,
          key,
          live,
          notes,
          quiet,
          answered: true,
          stopped: isStopped,
        });
      }
    }
    // CB-021：同一轮里同一个页面只留一张卡（§54「同一轮同一页面一张卡」）。
    const pageCalls = turn.rest.flatMap((item) =>
      item.kind === "tool"
        ? [
            {
              id: item.id,
              name: item.toolCall.function.name,
              args: item.toolCall.function.arguments,
              result: item.result,
            },
          ]
        : [],
    );
    for (const id of supersededPageCalls(pageCalls)) hidden.add(id);
    // Hark 式回复引用（`╭─`）：当用户连发了多条消息，或上一轮干活期间用户插话开启了新轮次时，
    // 为助手可见的回复气泡自动附上所回应的用户原话胶囊。
    const visibleBotTexts = texts.filter((t) => !hidden.has(t.id));
    if (multiReplyTurn && visibleBotTexts.length >= 2) {
      const firstUser = prevInterjected
        ? prevUsers[prevUsers.length - 1]
        : personUsers[0];
      const lastUser = personUsers[personUsers.length - 1];
      const firstBot = visibleBotTexts[0];
      const lastBot = visibleBotTexts[visibleBotTexts.length - 1];
      if (firstUser && firstBot) {
        const q1 = formatQuoteText(firstUser.text);
        if (q1) replyTo.set(firstBot.id, { id: firstUser.id, text: q1 });
      }
      if (lastUser && lastBot) {
        const q2 = formatQuoteText(lastUser.text);
        if (q2) replyTo.set(lastBot.id, { id: lastUser.id, text: q2 });
      }
    } else {
      const replyTargetId = final ?? visibleBotTexts[0]?.id ?? null;
      if (
        replyTargetId &&
        personUsers.length > 0 &&
        (personUsers.length > 1 || prevInterjected)
      ) {
        const targetUser = personUsers[personUsers.length - 1];
        if (targetUser) {
          const quoteText = formatQuoteText(targetUser.text);
          if (quoteText)
            replyTo.set(replyTargetId, { id: targetUser.id, text: quoteText });
        }
      }
    }
    /*
     * 回复显示①（2026-10-29）：这一轮有没有看得见的回答——结果气泡、以卡片收尾（`drawsCard`：自定义渲染器、确认卡、宿主提示、活动卡）、或者留着没收的气泡。
     * 工具失败后没有字、或只回了「---」时都没有：最后挂「这一轮没有回答」（干活那一行现在也收，§123；答案的位置上不能一片空白）。
     */
    const answered =
      final !== null ||
      turn.rest.some(
        (item) =>
          !hidden.has(item.id) &&
          (item.kind === "tool" || item.kind === "activity") &&
          drawsCard(item, live),
      ) ||
      texts.some((item) => !hidden.has(item.id));
    const entry = workAnchor === null ? undefined : work.get(workAnchor);
    if (entry) entry.answered = answered;
    const visible = [...turn.users, ...turn.rest].filter(
      (item) => !hidden.has(item.id),
    );
    const last = visible[visible.length - 1]?.id;
    if (isStopped && last) stoppedAfter.add(last);
    if (!live && !isStopped && !answered && turn.rest.length > 0 && last)
      noAnswerAfter.set(last, { last: index === turns.length - 1 });
    if (!live && last && fallbacks?.size) {
      const notice = turn.users
        .map((user) => fallbacks.get(turnOf(user)))
        .find(Boolean);
      if (notice) fallbackAfter.set(last, notice);
    }
    // 采集本轮的记忆写入调用（memory_save / memory_update / memory_log），挂在可见的助手回复气泡下方。
    const turnMemories: MemoryPillItem[] = [];
    for (const item of turn.rest) {
      if (item.kind !== "tool") continue;
      const fnName = item.toolCall.function.name;
      if (!MEMORY_WRITES.has(fnName)) continue;
      if (item.result !== undefined && workCallFailed(item.result)) continue;
      let parsedArgs: Record<string, unknown> = {};
      try {
        const raw = JSON.parse(item.toolCall.function.arguments || "{}");
        if (raw && typeof raw === "object")
          parsedArgs = raw as Record<string, unknown>;
      } catch {
        // ignore
      }
      const resStr = typeof item.result === "string" ? item.result : "";
      const idMatch = /\[(mem_[A-Za-z0-9_-]+)\]/.exec(resStr);
      const noteId =
        idMatch?.[1] ??
        (typeof parsedArgs.id === "string" && parsedArgs.id.startsWith("mem_")
          ? parsedArgs.id
          : undefined);
      const rawSummary =
        (typeof parsedArgs.content === "string" && parsedArgs.content.trim()) ||
        (typeof parsedArgs.entry === "string" && parsedArgs.entry.trim()) ||
        resStr
          .replace(/^已(?:记下|并入|更新)[：:]\s*(?:\[mem_[^\]]+\]\s*)?/, "")
          .trim();
      if (!rawSummary) continue;
      turnMemories.push({
        id: item.toolCall.id || item.id,
        noteId,
        summary: rawSummary.slice(0, 120),
        kind:
          fnName === "memory_log"
            ? "log"
            : typeof parsedArgs.kind === "string"
              ? parsedArgs.kind
              : "fact",
        subject:
          typeof parsedArgs.subject === "string"
            ? parsedArgs.subject
            : undefined,
        action:
          fnName === "memory_save"
            ? "save"
            : fnName === "memory_update"
              ? "update"
              : "log",
      });
    }
    const memTargetId =
      final ?? visibleBotTexts[visibleBotTexts.length - 1]?.id ?? null;
    if (memTargetId && turnMemories.length > 0) {
      memories.set(memTargetId, turnMemories);
    }
  });
  return {
    tone,
    hidden,
    stoppedAfter,
    fallbackAfter,
    work,
    replyTo,
    memories,
    noAnswerAfter,
    liveTools,
    liveKey,
  };
}
