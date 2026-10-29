import type { ActivityMessage, Message } from "@ag-ui/core";
import type { Attachment } from "@copilotkit/react-core/v2";
import {
  useCopilotChatConfiguration,
  useRenderActivityMessage,
  useRenderToolCall,
} from "@copilotkit/react-core/v2";
import {
  IconAlertTriangle,
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
import { Link } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import {
  cloneElement,
  isValidElement,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { BotBubbles, ReplyQuote, type ReplyTarget } from "@/components/chat/bot-bubbles";
import { dispatchComposerQuote } from "@/lib/chat/quote-event";
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
} from "@/components/chat/message-actions";
import { QueuedMessages } from "@/components/chat/queued-messages";
import { ScheduleFiredRow } from "@/components/chat/schedule-row";
import { SmoothStreamdown } from "@/components/chat/smooth-markdown";
import { knownWorkSeconds, WorkRow } from "@/components/chat/work-card";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  attachmentThumbUrl,
  attachmentUrl,
  pickAttachmentThumbWidth,
} from "@/lib/channels/attachments";
import { isMessageHeld } from "@/lib/channels/focus-message";
import { readResponsibilityTurn } from "@/lib/channels/responsibility-turn";
import { collapseScheduleRuns } from "@/lib/schedule-fired";
import { readFiring } from "@/lib/channels/routine-firing";
import { nextBlankHeight } from "@/lib/chat/blank-release";
import { friendlyError, UNANSWERED_TURN_REASON } from "@/lib/chat/friendly-error";
import { supersededPageCalls } from "@/lib/chat/page-cards";
import {
  previousSentAt,
  rememberSent,
  staysInSameTurn,
  takeSendWhileBusy,
  type SentAtReading,
} from "@/lib/chat/send-scroll";
import { STREAMDOWN_ZH } from "@/lib/chat/streamdown-zh";
import { useToolActivityVisible } from "@/lib/chat/tool-activity";
import { setThreadUi, threadUi } from "@/lib/chat/ui-memory";
import { useTailFirstMount } from "@/lib/chat/use-tail-first-mount";
import {
  isQuietWork,
  isWorkCall,
  summarizeDoneWork,
  type WorkCall,
  type WorkNote,
  workCallFailed,
} from "@/lib/chat/work-steps";
import { useThreadConfirmations } from "@/lib/confirmations";
import { isEditableUserText } from "@/lib/copilot/regenerate";
import { useReadMark } from "@/lib/copilot/thread-inbox";
import { WORKER_RESULT_MARKER } from "@/lib/copilot/workers";
import { markdownComponents } from "@/lib/markdown";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { readToolName } from "@/lib/plugins/tool-name";
import {
  asText,
  forDisplay,
  REFUSAL_MARKER,
  toolResultFailed,
} from "@/lib/plugins/tool-result";
import { cn } from "@/lib/utils";
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
import { splitChatOrigin } from "./chat-origin";
import type { QueuedMessage } from "./composer";
import { ToolRenderBoundary } from "./tool-boundary";
import { ToolLine } from "./tool-line";

type ChatTranscriptProps = {
  busy?: boolean;
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
function Thinking() {
  return (
    <div
      className="chat-thinking"
      data-testid="transcript-thinking"
      // `status` rather than `alert`: this is progress, not something that interrupts what somebody
      // is doing. The text says it, so a screen reader is told the same thing the dots imply.
      role="status"
    >
      <span aria-hidden="true" className="chat-thinking-dots">
        <i />
        <i />
        <i />
      </span>
      <span className="tool-line-running">{"思考中"}</span>
    </div>
  );
}

/**
 * 开场一句写完、第一个工具还没出来的那一两秒（DESIGN.md §78.2）：以前屏幕上什么都没有，像是停了。
 * 机器人的最后一段字停住 0.9 秒还没有下文时，在它下面淡入三个跳动的小点（不写字、不占一行药丸）；
 * 有新字或工具一来就收起。回答写完到这一轮真正结束通常不到 0.9 秒，所以不会在答案后面闪一下。
 */
function PauseDots({ watch }: { watch: string }) {
  const [shown, setShown] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => {
    setShown(false);
    const timer = window.setTimeout(() => setShown(true), 900);
    return () => window.clearTimeout(timer);
  }, [watch]);
  if (!shown) return null;
  return (
    <div
      aria-hidden="true"
      className="chat-pause-dots"
      data-testid="transcript-pause-dots"
    >
      <span className="chat-thinking-dots">
        <i />
        <i />
        <i />
      </span>
    </div>
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
  reason,
}: {
  onRetry?: () => void;
  reason: string;
}) {
  const friendly = friendlyError(reason);
  const [open, setOpen] = useState(false);
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
            {open ? (
              <pre className="chat-error-detail">{friendly.detail}</pre>
            ) : null}
          </>
        ) : null}
      </div>
      {onRetry ? (
        <button className="chat-error-retry" onClick={onRetry} type="button">
          <IconRefresh className="size-3.5" />
          {"重试"}
        </button>
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
function parkedTiles(attachments: readonly Attachment[]): SentAttachment[] {
  return attachments.map((attachment) => {
    const attachmentId = (attachment.metadata as { attachmentId?: unknown })
      ?.attachmentId;
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
      attachmentId:
        typeof attachmentId === "string" ? attachmentId : attachment.id,
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

  return named.length > 0 ? named.join(", ") : "attachment";
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
  text,
  onRemove,
}: {
  attachments: readonly Attachment[];
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
          <span role="status">{"排队"}</span>
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

  useEffect(() => {
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
    scrollToEnd();
  }, [newest, scrollToEnd, viewport]);

  return null;
}

/** 消息列的行距（px）。 */
function rowGapOf(content: HTMLElement): number {
  const gap = Number.parseFloat(getComputedStyle(content).rowGap);
  return Number.isFinite(gap) ? gap : 0;
}

/**
 * 两块留白（滚动容器的 spacer、我们的 slack）在这一列里实际占的高度：各自的高度减去被负上边距抵掉的那道行距。
 * 消息行本身的高度 = 列高 − 这个数（§94 用它算新那一行吃掉多少空白）。
 */
function blankArea(content: HTMLElement, slack: number): number {
  const gap = rowGapOf(content);
  const spacer = content.querySelector<HTMLElement>(
    "[data-message-scroller-spacer]",
  );
  const spacerHeight = spacer && !spacer.hidden ? spacer.offsetHeight : 0;
  return (
    (spacerHeight > 0 ? spacerHeight - gap : 0) + (slack > 0 ? slack - gap : 0)
  );
}

/** 恢复完成后还钉在底部多久（毫秒）：晚到的「已停止」行、图片撑高、存储补进来的几轮都在这段时间里。 */
export const SETTLE_AFTER_HYDRATE_MS = 2500;

/**
 * 打开对话时落在最新一条，而且不跳（DESIGN.md §83）。
 *
 * 为什么需要它：滚动容器（`@shadcn/react` message-scroller）只看「行数变多了」——从旧的行数往后找第一个
 * 用户消息行（`data-scroll-anchor`），把它对齐到顶上（这是「刚发出一句，它滑到顶上、下面留地方给回答」的
 * 设计）。可打开一段长对话时，历史不是一次到齐的：接入回放一段段长出来（网速慢时 1 → 3 → 5 → 8 行），
 * 存储读完再补进 20 多行，「已停止」/「换了备用模型」的小行晚一点插进中间。每一次行数变多，它都当成
 * 「刚发了一句」，把中间某一条用户消息对齐到顶上——人就停在半截历史里（实测离底部 7322px），而且
 * 一路平滑滚着过去（`useSmoothSendScroll` 把那几次当成刚发的）。
 *
 * 所以：从打开到恢复完成后 SETTLE_AFTER_HYDRATE_MS 之内，内容每变一次（行增减、高度变化），在下一帧
 * 绘制之前直接回到底部（`scrollToEnd`，不平滑），并把滚动容器切回「跟着底部」。人自己滚了（滚轮、手指、
 * 翻页键、拖滚动条）或者发了新消息，马上停手，交回滚动容器原来的规则。
 */
function SettleAtEnd({
  busy = false,
  hydrating,
  opening = false,
  newestUserMessageId,
  viewport,
  scrollKey,
  slack,
  sendMode,
}: {
  /** 这一段对话正在回答（§93.3：一轮结束时把底下留的空收掉）。 */
  busy?: boolean;
  /** 刚出现的那条用户消息是不是连续聊天里发的（§94）：是就不翻页，底部跟着长。 */
  sendMode?: React.RefObject<SendMode>;
  hydrating: boolean;
  /** 还在「打开」这段对话的窗口里（`useOpeningWindow`）：历史补齐不是新的一轮。 */
  opening?: boolean;
  newestUserMessageId: string | null;
  viewport: React.RefObject<HTMLDivElement | null>;
  /** 滚动位置记在哪（DESIGN.md §88）；没有就只管钉在底部。 */
  scrollKey?: string;
  /** 最后一条下面的留白（§88.1），在 `contents` 那一格里，不算一行。 */
  slack: React.RefObject<HTMLDivElement | null>;
}) {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  /*
   * 上次离开这段对话时的位置（§88.3）：不在底部 → 回到那一条、离顶边一样远；在底部 → 钉在底部，最后一条下面
   * 照样留出当时的空白（新一轮对齐到顶上时滚动容器留的），画面和离开时一样。只在打开时读一次。
   */
  const [memo] = useState(() =>
    scrollKey ? (threadUi(scrollKey)?.scroll ?? null) : null,
  );
  const state = useRef({
    // 一打开就不在恢复（从新建对话页带着第一条消息来的）：不需要钉。
    until: hydrating ? Number.POSITIVE_INFINITY : 0,
    baseline: newestUserMessageId,
    wasHydrating: hydrating,
    released: false,
    /** 还要回到上次那一条（找不到就在恢复完成时放弃，改钉底部）。 */
    restore: memo && !memo.atBottom && memo.anchor ? memo : null,
    hydrating,
    /** 底下的留白（px）：固定高度时是设的值；「跟着变」（§94.6，floor 不是 null）时是它现在实际的高度。 */
    get slack(): number {
      const floor = this.floor;
      if (floor === null) return this.slackPx;
      const el = slack.current;
      const content = el?.parentElement?.parentElement;
      if (!el || !content) return 0;
      const own = el.offsetHeight;
      // 对话比一屏短时（min-h-full）它还会多撑出一截填满视口：那一截不算留白。
      return Math.max(0, Math.min(own, floor - (content.offsetHeight - own)));
    },
    slackPx: 0,
    /**
     * §94.6「跟着变」的留白：这一列的最小高度钉在 floor（px），留白 flex-grow 填满「floor − 消息行」。消息行变矮 / 变高
     * 在同一次布局里由留白补上 / 让出——总高度不变，浏览器不夹 scrollTop，不用等到下一帧的 ResizeObserver。null = 不在用。
     */
    floor: null as number | null,
    /** 正在把留白收掉（§93.3）：这段时间里变矮不再补留白。 */
    releasing: false,
    busy,
    /** 上一次量到的位置（§94 连续发消息时用）：scrollTop、是不是在底部、消息行本身的高度（不算两块留白）。 */
    lastTop: 0,
    lastAtBottom: true,
    lastRows: 0,
  });
  state.current.busy = busy;
  const reduceMotion = useReducedMotion();
  /** §93.3：一轮结束后收掉底下留的空（由下面的 effect 填上；没挂上时什么都不做）。 */
  const releaseRef = useRef<(() => boolean) | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 滚动位置状态机：状态放在 ref 里，只在 hydrating / 最新用户消息等输入变化时重跑；ref 与 setter 不用列
  useLayoutEffect(() => {
    const s = state.current;
    s.hydrating = hydrating;
    if (hydrating) {
      if (!s.wasHydrating) s.until = Number.POSITIVE_INFINITY;
      s.baseline = newestUserMessageId;
    } else if (s.wasHydrating) {
      s.until = performance.now() + SETTLE_AFTER_HYDRATE_MS;
      s.baseline = newestUserMessageId;
      /*
       * §93.3：恢复完了、这一段没在回答——上次离开时底下留的空（新一轮对齐到顶上时滚动容器留的）不再放回去：
       * 做完的一轮只要正常的底边距。还在回答时照旧放回去（§88.3，接着写的回答先填那块空，画面不跳）。
       */
      if (!s.busy && s.slack > 0) setSlack(0);
    } else if (newestUserMessageId !== s.baseline) {
      // 恢复完成后又多了一条用户消息：人发的（或别的设备发的），交回「新一轮对齐到顶上」。
      s.baseline = newestUserMessageId;
      /*
       * 还在「打开」的窗口里（`opening`，DESIGN.md §83）：历史是分几段到的（上次看到的样子 → 存下的整段 →
       * 晚到的「已停止」/备用说明），最新一条用户消息变了只说明这一段补进来了，不是有人刚发了一句——
       * 垫 2/3 屏空白、翻页、把位置交回滚动容器，都会让刚打开 / 刚切回来的对话像发了一次消息。
       * 基线已经跟着走了，窗口过后的第一条才算新的一轮。
       */
      if (opening) {
        // 打开窗口里：只把「跟着变」的留白冻成固定高度（§94.6），不垫空白、不翻页、不动位置。
        if (s.floor !== null) setSlack(s.slack);
      } else if (
        sendMode?.current.continuous &&
        sendMode.current.id === newestUserMessageId
      ) {
        /*
         * §94 连续聊天：这一条不带对齐标记，不翻页。滚动容器可能还停在上一轮的「对齐到顶上」状态（下面有它的
         * spacer）——不处理的话它会继续把上一轮钉在顶上，新内容长到视口下面去。这里同一次提交里把它切回「跟着
         * 底部」（scrollToEnd 会把 spacer 清零），清掉的那块空白改成我们的留白，先让新那一行吃掉；人在底部时
         * scrollTop 正好落回原处，画面不动，之后内容先填留白、填满了再由滚动容器跟着底部往上长。人不在底部
         * （往上翻着）时不留白，直接回到底部（发了一句就该看到它）。
         */
        const element = viewport.current;
        const content = element?.querySelector<HTMLElement>(
          '[data-slot="message-scroller-content"]',
        );
        if (element && content) {
          const before = s.lastTop;
          const wasAtBottom = s.lastAtBottom;
          const gap = rowGapOf(content);
          const blank = wasAtBottom ? blankArea(content, s.slack) : 0;
          // 新那一行（连同前面的行距）已经在 DOM 里：它比空白矮多少，就留多少（两块留白都用负的上边距抵掉一道行距）。
          const growth =
            content.offsetHeight - blankArea(content, s.slack) - s.lastRows;
          const keep = blank - Math.max(0, growth);
          setSlack(keep > 0 ? keep + gap : 0);
          element.style.scrollBehavior = "auto";
          scrollToEnd({ behavior: "auto" });
          if (
            wasAtBottom &&
            blank > 0 &&
            Math.abs(element.scrollTop - before) <= 2
          )
            element.scrollTop = before;
          element.style.scrollBehavior = "";
        } else {
          setSlack(0);
          scrollToEnd({ behavior: "auto" });
        }
      } else {
        s.until = 0;
        s.restore = null;
        // 「跟着变」的留白先按现在的高度冻成固定的（§94.6）：下面两条路（连续 / 翻页）都按固定高度算，滚动容器对齐时也不受影响。
        if (s.floor !== null) setSlack(s.slack);
        /*
         * 新的一轮：滚动容器要把问题对齐到视口上 1/3（§94.7 的 scrollMargin），它的对齐在**这次提交后的微任务**
         * 里算目标再滚。可回答还没开始，问题下面是空的——它算出的目标比能滚到的更远，会被夹回最底（实测目标
         * 194px、落在 114px）。这里赶在它之前（layout effect 早于那次微任务）把我们的留白垫到「问题下面有
         * 2/3 视口」：它算 spacer 时内容已经够高，算出 0，不会叠成两块空白；回答开始长出来时照旧先吃这块留白。
         */
        const element = viewport.current;
        const column = element?.querySelector<HTMLElement>(
          '[data-slot="message-scroller-content"]',
        );
        const row = column?.querySelector<HTMLElement>(
          '[data-scroll-anchor="true"]',
        );
        if (element && column && row) {
          const blank = blankArea(column, s.slack);
          const below =
            column.getBoundingClientRect().bottom -
            row.getBoundingClientRect().bottom -
            blank;
          const want = Math.round((element.clientHeight * 2) / 3) - below;
          setSlack(want > 0 ? want : 0);
        } else if (s.slack > 0) {
          /*
           * 没有可以垫的目标（标记不在这批 DOM 里）：照旧把留白让给滚动容器的 spacer。等它对齐完（微任务之后）
           * 再拿掉——当场拿掉的话总高度先变矮，浏览器把 scrollTop 夹小，平滑滚动从夹过的位置出发，先往回跳一截
           * （实测 193px / 238px）再往前滚。
           */
          queueMicrotask(() => setSlack(0));
        }
      }
    }
    s.wasHydrating = hydrating;
  }, [hydrating, newestUserMessageId, opening]);

  function setSlack(px: number) {
    const el = slack.current;
    const next = Math.max(0, Math.round(px));
    state.current.slackPx = next;
    // 设固定高度：先退出「跟着变」（§94.6）。
    state.current.floor = null;
    if (el?.parentElement?.parentElement)
      el.parentElement.parentElement.style.minHeight = "";
    if (el) el.style.flex = "";
    if (!el) return;
    if (next === 0) {
      el.style.display = "none";
      return;
    }
    // 它是这一列的一项，前面会多出一道行距（gap）：用负的上边距抵掉，加上的正好是 `next`。
    const gap = el.parentElement?.parentElement
      ? getComputedStyle(el.parentElement.parentElement).rowGap
      : "0px";
    el.style.display = "block";
    el.style.marginTop = gap && gap !== "normal" ? `calc(-1 * ${gap})` : "0px";
    el.style.height = `${next}px`;
  }

  /*
   * §93.3 一轮结束后收掉底下的空（用户 2026-10-16「下面还有额外的空白」）。
   *
   * 根因：新一轮发出去时，滚动容器把那条用户消息对齐到顶上，回答比一屏短时在下面垫一块空（它自己的 spacer，
   * 「anchored-to-message」）；这一轮结束了它也不收——人看着回答下面一大块空。变矮时 §88.1 又把少掉的高度
   * 补成留白（slack），刷新后 §88.3 还把它原样放回去。
   *
   * 现在：回答结束（busy 变 false）的那一次提交里（和收起动画同时开始），人还在底部、没动过滚动：先把滚动容器的空
   * 原样挪进我们的留白（总高度不变，画面不动），让滚动容器改成「跟着底部」（scrollToEnd 把它的 spacer 清零），
   * 再按实际绘制帧逐步收掉留白——浏览器把 scrollTop 一点点夹小，整段对话平滑地往下落到正常的底边距。
   * 人往上翻过、或者又开始回答了：不动。`prefers-reduced-motion` 发新消息时直接贴底，不制造翻页留白。
   */
  const wasBusy = useRef(busy);
  useLayoutEffect(() => {
    const was = wasBusy.current;
    wasBusy.current = busy;
    if (busy || !was || hydrating) return;
    // 和这一轮结束时的收起（§82.9 过程话 / §93 干活卡）同一次提交、绘制之前开始：收起和收空一起往下落，
    // 不会先被收起夹一下、滚动容器再把那条消息拉回顶上（预览实测：等收起走完再收，中间往回跳 67px）。
    if (releaseRef.current?.() !== false) return;
    // 这一帧还不行（滚动容器还在对齐、最后几个字刚进来）：接下来几帧再试，最多 ~0.5 秒。
    let tries = 0;
    let frame = 0;
    const retry = () => {
      if (releaseRef.current?.() !== false || ++tries > 30) return;
      frame = window.requestAnimationFrame(retry);
    };
    frame = window.requestAnimationFrame(retry);
    return () => window.cancelAnimationFrame(frame);
  }, [busy, hydrating]);

  // 离开对话：最后记一次位置。用 layout 的清理——那时 DOM 还在页面上，量得出来（普通 effect 的清理时已经拿掉了）。
  const finalWrite = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => finalWrite.current?.(), []);

  // 回来时在底部、底下有留白：第一帧之前就把留白放回去（§88.3）。没在恢复、也没在回答：不放（§93.3）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!memo?.atBottom || memo.spacer <= 0 || !element) return;
    if (!hydrating && !busy) return;
    setSlack(Math.min(memo.spacer, Math.max(0, element.clientHeight - 96)));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 挂载时建立观察器；里面读的都是 ref，不随渲染变化
  useEffect(() => {
    const element = viewport.current;
    const content = element?.querySelector<HTMLElement>(
      '[data-slot="message-scroller-content"]',
    );
    if (!element || !content) return;
    const s = state.current;
    // CB-106 r2：定位到 ?message= 那条后（data-message-hold），打开时的落点 / 贴底都让路，直到人滚动或发消息。
    const held = () => isMessageHeld(element);
    const active = () => !s.released && performance.now() < s.until && !held();
    let frame = 0;
    /** 回到上次那一条；找到了返回 true。 */
    const toRemembered = () => {
      const r = s.restore;
      if (!r?.anchor) return false;
      const row = content.querySelector(
        `[data-message-id="${CSS.escape(r.anchor)}"]`,
      );
      if (!row) return false;
      element.style.scrollBehavior = "auto";
      const ok = scrollToMessage(r.anchor, {
        align: "start",
        behavior: "auto",
        scrollMargin: r.offset,
      });
      // 滚动容器对齐时会算上行距 / 内边距，差那么一点：量一下，补齐到离开时的那个像素。
      const off =
        row.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        r.offset;
      if (Math.abs(off) > 1) element.scrollTop += off;
      element.style.scrollBehavior = "";
      return ok;
    };
    const settle = () => {
      if (s.restore) {
        if (toRemembered()) return;
        // 恢复完成了还找不到那一条（被删了 / 太旧不在了）：不再找，钉在底部。
        if (!s.hydrating) s.restore = null;
        else return;
      }
      element.style.scrollBehavior = "auto";
      scrollToEnd({ behavior: "auto" });
      element.style.scrollBehavior = "";
    };
    const pin = () => {
      if (!active()) return;
      window.cancelAnimationFrame(frame);
      // 下一帧、绘制之前：滚动容器自己的处理（微任务里）已经跑完，这里最后说了算，屏幕上看不到中间那一跳。
      frame = window.requestAnimationFrame(() => {
        if (!active()) return;
        settle();
      });
    };
    /** 人最近动过滚动（滚轮 / 手指 / 键盘 / 拖滚动条）。 */
    let touchedAt = Number.NEGATIVE_INFINITY;
    const release = () => {
      s.released = true;
      s.restore = null;
      touchedAt = performance.now();
      window.cancelAnimationFrame(frame);
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        release();
    };
    const onPointer = (event: PointerEvent) => {
      // 按在滚动条上（视口自己，不是里面的消息）= 要拖着翻。
      if (event.target === element) release();
    };
    /*
     * 上一次看到的位置：滚动事件、每次 ResizeObserver 回调之后更新。内容变矮被浏览器夹回去的那一帧，这里还是
     * 夹之前的数（滚动事件要到下一帧才来）。
     */
    const seen = { top: element.scrollTop, atBottom: true };
    let lastHeight = content.offsetHeight;
    /*
     * 上一次量到的列宽。宽度变了 = 整列重新换行（拖右栏把手、收左栏、缩窗口、开详情列），§94.6 的「总高度不变」
     * 就不成立了（DESIGN.md §106）。
     *
     * floor / 留白按的是**上一次换行**的高度：拖窄几像素，文字多折两行，floor 抬上去；拖回来，行数回到原样，
     * floor 却降不下来（min-height 撑着，offsetHeight 永远等于 floor，elastic 里 `s.floor === height` 直接返回），
     * 差额全变成最后一条下面的留白，滚动容器又按「跟着底部」把 scrollTop 落在新的最底——人看到的是一整屏空白
     * 被当成「底部」（1280 宽、右栏 380→500→380 实测：内容 6362 → 7749px、留白 1388px、视口里一条消息都没有）。
     *
     * 换行不是「内容多了 / 少了」，不该由留白来接：把 floor 与留白一起收掉、同步 lastHeight（下一帧的 grew
     * 才不会算错），位置交回「贴底 / 浏览器的滚动锚定」。返回 true 表示这一帧的高度差来自换行，不是内容增减。
     */
    let layoutWidth = content.clientWidth;
    /*
     * 新的一轮刚对齐（标记还在）：这一刻的宽度变化不是「拖把手 / 缩窗口」，是滚动条出现 / 消失那几像素。
     * 拿掉留白会把刚对齐好的位置顶回去（§94.7：目标 1/3 会被夹回底部），所以标记在的时候只同步宽度。
     */
    const anchoring = () =>
      content.querySelector('[data-scroll-anchor="true"]') !== null;
    const reflowed = () => {
      const width = content.clientWidth;
      if (width === layoutWidth) return false;
      layoutWidth = width;
      if (!anchoring() && (s.floor !== null || s.slack > 0)) setSlack(0);
      lastHeight = content.offsetHeight;
      return true;
    };
    /*
     * 换行之后人还贴着底部：同一帧就贴回去。滚动容器自己也会贴（它的 handleResize → scrollToEnd），但排在
     * 下一帧的 rAF 里，中间那一帧会先画「最后一条掉到折线下面」。只在本来就在底部、不在恢复 / 对齐某一轮时动手。
     */
    const stickToBottom = () => {
      if (held()) return;
      const max = element.scrollHeight - element.clientHeight;
      if (element.scrollTop >= max - 1) return;
      element.style.scrollBehavior = "auto";
      element.scrollTop = max;
      element.style.scrollBehavior = "";
    };
    const look = () => {
      reflowed();
      seen.top = element.scrollTop;
      seen.atBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight <= 4;
      s.lastTop = seen.top;
      s.lastAtBottom = seen.atBottom;
      s.lastRows = content.offsetHeight - blankArea(content, s.slack);
      elastic();
    };
    /*
     * §94.6 钉在底部、没人动、不在恢复 / 收留白时，留白改成「跟着变」：这一列最小高度 = 现在的总高度，留白 flex-grow
     * 填满。之后消息行变矮（干活卡收起、工具那一行换成结果、开场一句收进卡片）、变高（回答多出一行、新的一行进来）都在
     * 同一次布局里由留白补上 / 让出，不管那次布局是在一帧里还是被谁在任务里量出来的——总高度不变，scrollTop 不被夹，
     * 画面不动。行长到超出这块地方时这一列照常变高，滚动容器跟着底部往上长，下一次 look 再把最小高度抬上去。
     * 条件一不满足（人往上翻了、在恢复、在收留白）：按现在的实际高度冻成固定的（画面不变），交回原来的规则。
     */
    const elastic = () => {
      const el = slack.current;
      if (!el || el.parentElement?.parentElement !== content) return;
      const spacer = content.querySelector<HTMLElement>(
        "[data-message-scroller-spacer]",
      );
      const ok =
        seen.atBottom &&
        !s.releasing &&
        !active() &&
        !s.restore &&
        performance.now() - touchedAt > 400 &&
        element.scrollHeight > element.clientHeight &&
        // 滚动容器正把某一轮对齐在顶上（有它的 spacer）：它自己算高度，这里不插手。
        (!spacer || spacer.hidden);
      if (!ok) {
        if (s.floor !== null) setSlack(s.slack);
        return;
      }
      const height = content.offsetHeight;
      if (s.floor === height) return;
      if (s.floor === null) {
        // 固定 → 跟着变：留白现在多高，跟着变以后还是多高（floor = 现在的总高度）。
        const gap = rowGapOf(content);
        el.style.display = "block";
        el.style.marginTop = `${-gap}px`;
        el.style.height = "0px";
        el.style.flex = "1 0 0px";
      }
      s.floor = height;
      content.style.minHeight = `max(100%, ${height}px)`;
      lastHeight = content.offsetHeight;
    };
    s.lastTop = element.scrollTop;
    /*
     * 高度变了（图片加载完撑高、晚到的小行）：ResizeObserver 的回调在布局之后、绘制之前跑，这里当场回到底部，
     * 这一帧画出来就已经在底部。等到下一帧（requestAnimationFrame）再回去，慢设备上会先画一帧「被顶上去」
     * ——实测切到带图片的长对话，图片加载那一下离底部 488px 停了一两帧。
     *
     * 钉底部的那段时间过了以后（§88.1）：人在底部看着，底下的东西变矮了（干活卡收起、工具那一行换成结果、
     * 「思考中」先走一帧、下一条还没到），浏览器把 scrollTop 夹小——整段聊天往下挪一截，下一帧滚动容器再滚回来，
     * 看着就是「往回跳一下」。这里在同一帧把少掉的高度放到最后一条下面当留白、scrollTop 放回去，屏幕上不动；
     * 后来长出来的内容先填这块留白，人往上翻到看不见它时悄悄收掉。
     */
    const pinNow = () => {
      /*
       * 换行（宽度变了）：这一帧的高度差是整列重新折行算出来的，不是内容长了 / 少了——不补留白、不写 scrollTop，
       * 只把「原来贴在底部」这件事接着做完（§106）。翻在中间那一半交给浏览器的滚动锚定（`.chat-tail` 不参与，
       * 见 §82.10 上面那一段），实测第一条可见消息位移 0px。
       */
      if (reflowed()) {
        if (active()) {
          // 打开对话的那几秒（§83）：照旧由 settle 决定落点（回到底部 / 回到上次那一条）。
          window.cancelAnimationFrame(frame);
          settle();
        } else if (seen.atBottom && !s.restore && !anchoring()) {
          stickToBottom();
        }
        look();
        return;
      }
      const height = content.offsetHeight;
      const grew = height - lastHeight;
      lastHeight = height;
      if (active()) {
        window.cancelAnimationFrame(frame);
        settle();
        look();
        return;
      }
      const max = element.scrollHeight - element.clientHeight;
      const recentlyTouched = performance.now() - touchedAt < 400;
      if (s.releasing) {
        // 正在收留白（§93.3）：变矮是我们自己收的，不补回去。
      } else if (grew > 0 && s.slack > 0) {
        // 长出来的先填留白：总高度不变，画面不动。
        const use = Math.min(s.slack, grew);
        setSlack(s.slack - use);
        lastHeight -= use;
        // 全吃进去了：滚动容器要是已经先「跟着底部」滚了这一截（它比我们早动），放回去，画面不动（§94）。
        if (use === grew && seen.atBottom && element.scrollTop !== seen.top) {
          element.style.scrollBehavior = "auto";
          element.scrollTop = seen.top;
          element.style.scrollBehavior = "";
        } else if (
          grew > use &&
          seen.atBottom &&
          !s.restore &&
          !anchoring()
        ) {
          stickToBottom();
        }
      } else if (
        grew > 0 &&
        seen.atBottom &&
        !s.restore &&
        !anchoring()
      ) {
        stickToBottom();
      } else if (
        grew < 0 &&
        !recentlyTouched &&
        seen.atBottom &&
        seen.top > max + 1 &&
        element.scrollTop >= max - 1
      ) {
        const lost = Math.min(seen.top - max, element.clientHeight);
        setSlack(s.slack + lost);
        lastHeight += lost;
        element.scrollTop = seen.top;
      }
      look();
    };
    const onScroll = () => {
      /*
       * 换行引起的那一下（浏览器夹小 scrollTop / 内容变矮）不是「内容变少了」：留白已经收掉、位置由
       * pinNow 的贴底负责，这里不能再按 §88.1 补一块回去（§106）。
       */
      if (reflowed()) {
        look();
        save();
        return;
      }
      /*
       * 浏览器自己夹小 scrollTop 的那一下（§88.1）：钉在底部、没人动，内容变矮被夹回去——有时 React 提交里有人量了
       * 一下布局，夹在 ResizeObserver 之前就发生了，等它来时「上一次的位置」已经是夹过的数。滚动事件在下一次绘制
       * 之前到：在这里把少掉的高度放到最后一条下面当留白、scrollTop 放回去，画出来的那一帧不动。
       */
      const max = element.scrollHeight - element.clientHeight;
      if (
        seen.atBottom &&
        !s.releasing &&
        !active() &&
        !s.restore &&
        performance.now() - touchedAt > 400 &&
        element.scrollTop < seen.top - 1 &&
        element.scrollTop >= max - 1
      ) {
        const back = seen.top;
        setSlack(
          s.slack + Math.min(back - element.scrollTop, element.clientHeight),
        );
        element.scrollTop = back;
        lastHeight = content.offsetHeight;
      }
      look();
      // 留白整个在视口下面（人往上翻了）：收掉，看得见的东西一点都不动。
      if (
        s.slack > 0 &&
        element.scrollTop + element.clientHeight <
          element.scrollHeight - s.slack - 1
      ) {
        setSlack(0);
        lastHeight = content.offsetHeight;
      }
      save();
    };
    /*
     * 记下现在的位置（§88.3）：恢复完成之后才记（恢复中的样子是过渡的）；在底部记「在底部」+ 底下的空白，
     * 不在底部记第一条看得见的消息和它离顶边多远。滚动时合并 200ms 记一次，离开对话时再记一次。
     */
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const write = () => {
      saveTimer = null;
      // 已经从页面上拿掉了（量出来全是 0）：不记，留着上一次记的。
      if (
        !scrollKey ||
        s.hydrating ||
        !element.isConnected ||
        element.clientHeight === 0
      )
        return;
      const gap =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      if (gap <= 4) {
        const spacer = content.querySelector<HTMLElement>(
          "[data-message-scroller-spacer]",
        );
        const spacerHeight = spacer && !spacer.hidden ? spacer.offsetHeight : 0;
        setThreadUi(scrollKey, {
          scroll: {
            atBottom: true,
            spacer: spacerHeight + s.slack,
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
    let releaseFrame = 0;
    releaseRef.current = () => {
      const why = (reason: string) => {
        element.dataset.cbRelease = reason;
        return false;
      };
      if (s.busy || s.releasing || s.restore || active())
        return why(
          `skip:${s.busy ? "busy" : s.releasing ? "releasing" : s.restore ? "restore" : "settling"}`,
        );
      if (performance.now() - touchedAt < 400) return why("touched");
      const gap =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      if (gap > 4) return why(`gap:${Math.round(gap)}`); // 人不在底部：留白在视口外，§88.1 自己会收
      const spacer = content.querySelector<HTMLElement>(
        "[data-message-scroller-spacer]",
      );
      const spacerHeight = spacer && !spacer.hidden ? spacer.offsetHeight : 0;
      const total = spacerHeight + s.slack;
      if (total <= 1) return why("none");
      s.releasing = true;
      element.dataset.cbRelease = `release:${Math.round(total)}`;
      // 1) 滚动容器的空挪进留白（同一帧），2) 让它改成跟着底部（spacer 清零，位置不变）。
      setSlack(total);
      const top = element.scrollTop;
      element.style.scrollBehavior = "auto";
      scrollToEnd({ behavior: "auto" });
      element.scrollTop = top;
      element.style.scrollBehavior = "";
      const finish = (remaining = 0) => {
        setSlack(remaining);
        lastHeight = content.offsetHeight;
        s.releasing = false;
        look();
        save();
      };
      if (reduceMotion) {
        finish();
        return true;
      }
      // 3) Integrate each rendered frame. Catching up to a 300ms wall-clock ease after a slow
      // Markdown/layout frame used to remove 70–120px at once and clamp scrollTop backwards.
      let remaining = total;
      let previous = performance.now();
      const step = (now: number) => {
        if (s.busy || performance.now() - touchedAt < 400) {
          // A new reply or the reader scrolling owns the viewport now. Preserve this frame's
          // remaining blank rather than snapping it to zero underneath them.
          finish(s.slack);
          return;
        }
        remaining = nextBlankHeight(remaining, now - previous);
        previous = now;
        if (remaining === 0) {
          finish();
          return;
        }
        setSlack(remaining);
        lastHeight = content.offsetHeight;
        releaseFrame = window.requestAnimationFrame(step);
      };
      releaseFrame = window.requestAnimationFrame(step);
      return true;
    };
    /*
     * 行进来 / 出去（新的一行、开场一句收进卡片、「思考中」换成回答）：React 提交后的微任务里就量一次（§94），
     * 比滚动容器的 ResizeObserver → requestAnimationFrame 早，留白当场吃掉 / 补上，不等下一帧。
     */
    const mutations = new MutationObserver(() => {
      if (!active() && !s.restore && content.offsetHeight !== lastHeight)
        pinNow();
      pin();
    });
    // characterData：回答一个字一个字往外冒时改的是文字节点本身（不是加减节点）——多出一行也要当场吃留白（§94.6，390 实测 20px）。
    mutations.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const sizes =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(pinNow);
    sizes?.observe(content);
    /*
     * 视口变矮（输入框打字长高、加了小块 / 附件、手机键盘弹出）时人在底部看着：同一帧把 scrollTop 加上变矮的量，
     * 最后一行留在输入框上面（§94）。滚动容器自己也会回到底部，但要等到下一帧——中间那一帧最后一行被盖住一截。
     * 只在它「跟着底部」（没有 spacer）时做：对齐着某一轮时它会把那一轮留在顶上，这里不插手。
     */
    let lastClient = element.clientHeight;
    const viewportSizes =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const height = element.clientHeight;
            const shrink = lastClient - height;
            lastClient = height;
            const spacer = content.querySelector<HTMLElement>(
              "[data-message-scroller-spacer]",
            );
            if (
              shrink > 0 &&
              seen.atBottom &&
              !active() &&
              !s.restore &&
              (!spacer || spacer.hidden)
            ) {
              element.style.scrollBehavior = "auto";
              element.scrollTop += shrink;
              element.style.scrollBehavior = "";
            }
            look();
          });
    viewportSizes?.observe(element);
    element.addEventListener("wheel", release, { passive: true });
    element.addEventListener("touchmove", release, { passive: true });
    element.addEventListener("keydown", onKey);
    element.addEventListener("pointerdown", onPointer);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (s.floor !== null) setSlack(s.slack);
      if (saveTimer !== null) clearTimeout(saveTimer);
      window.cancelAnimationFrame(releaseFrame);
      releaseRef.current = null;
      s.releasing = false;
      finalWrite.current = null;
      window.cancelAnimationFrame(frame);
      mutations.disconnect();
      sizes?.disconnect();
      viewportSizes?.disconnect();
      element.removeEventListener("wheel", release);
      element.removeEventListener("touchmove", release);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("pointerdown", onPointer);
      element.removeEventListener("scroll", onScroll);
    };
  }, [scrollToEnd, scrollToMessage, viewport, scrollKey, reduceMotion]);

  return null;
}

/**
 * How many of the newest turns cascade when a channel is opened, and how far apart.
 *
 * The tail rather than the head: opening a channel lands you at the bottom, so these are the ones
 * actually on screen. Staggering from the top of a long history would spend the whole budget on
 * messages nobody can see and leave the visible ones arriving last.
 *
 * Twelve at 40ms is 440ms of cascade before the last one starts. Past roughly half a second this
 * stops reading as settling and starts reading as waiting.
 */
const FIRST_PAINT_STAGGER_COUNT = 12;
const FIRST_PAINT_STAGGER_SECONDS = 0.04;

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
function Arriving({
  animate = false,
  children,
  delay = 0,
}: {
  animate?: boolean | undefined;
  children: React.ReactNode;
  delay?: number;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      /*
       * `data-slot` IS LOAD-BEARING, NOT DECORATION. `MessageContent` right-aligns a person's own
       * message with `group-data-[align=end]/message:*:data-slot:self-end` — a selector that reaches
       * DIRECT CHILDREN CARRYING A data-slot. Wrapping the bubble in a plain div made this the direct
       * child, the selector matched nothing, and every message a person sent quietly moved to the
       * left column and read as though the Bot had said it.
       */
      data-slot="message-arriving"
      /*
       * FULL WIDTH, AND A FLEX COLUMN, because that is what it displaced. `Bubble` is
       * `w-fit max-w-[80%]` and aligns itself with `group-data-[align=end]/message:self-end`. Both
       * need the parent this wrapper replaced: against a shrink-to-fit box the 80% resolves against
       * the bubble's own width and short messages wrap for no reason, and `self-end` does nothing at
       * all outside a flex container.
       */
      className="flex w-full flex-col"
      initial={
        animate
          ? {
              opacity: 0,
              // Reduced motion keeps the fade and drops the movement: gentler, not absent.
              transform: shouldReduceMotion ? "none" : "translateY(8px)",
            }
          : false
      }
      transition={{
        // Reduced motion gets the fade with no queue: a cascade is movement too, just spread over
        // time, and somebody who asked for less of it should not wait for their history to arrive.
        delay: !animate || shouldReduceMotion ? 0 : delay,
        duration: ENTRANCE_SECONDS,
        ease: EASE_OUT,
      }}
    >
      {children}
    </motion.div>
  );
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
 */
function RoutineFiring({ instruction }: { instruction: string }) {
  const responsibility = readResponsibilityTurn(instruction);
  if (responsibility) {
    return <ResponsibilityFiring raw={instruction} turn={responsibility} />;
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

function splitUserQuote(raw: string): { quote?: string | undefined; body: string } {
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
  const [undoneIds, setUndoneIds] = useState<Record<string, boolean>>({});
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  if (items.length === 0) return null;

  const handleUndo = async (item: MemoryPillItem) => {
    setUndoBusy(true);
    setUndoError(null);
    try {
      if (item.noteId && item.noteId.startsWith("mem_")) {
        const response = await fetch(`/api/memory-notes/${encodeURIComponent(item.noteId)}`, {
          method: "DELETE",
          credentials: "include",
        });
        // 删除失败（网络、权限、已被删）不能显示「已撤销」，否则用户以为记忆没了，其实还在。
        if (!response.ok && response.status !== 404) throw new Error(`撤销失败（${response.status}）`);
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
              <IconSparkles aria-hidden="true" className="size-3.5 shrink-0 text-amber-400" />
              <span className="chat-memory-pill-text truncate">
                {isUndone ? `已撤销记忆：${item.summary}` : `已记住：${item.summary}`}
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
        {active ? (
          <DialogContent className="max-w-md" data-testid="memory-pill-dialog">
            <div className="flex items-center gap-2 pb-2">
              <IconSparkles aria-hidden="true" className="size-4 text-amber-400" />
              <DialogTitle className="text-base">{"记忆写入详情"}</DialogTitle>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-2 py-0.5 font-medium text-foreground">
                  {KIND_LABELS[active.kind ?? "fact"] ?? "记忆"}
                </span>
                {active.subject ? (
                  <span className="rounded-md bg-muted/60 px-2 py-0.5">
                    {`对象：${active.subject}`}
                  </span>
                ) : null}

              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5 leading-relaxed text-foreground">
                {active.summary}
              </div>
              <div className="flex items-center justify-between pt-2">
                {/*
                 * 用路由内跳转，并先关掉弹窗（CB-106）。原来是 <a href>：在打开的模态弹窗里整页重载，
                 * 整个应用（对话、CopilotKit 连接、几千条记忆）从头再来一遍，s2 里这一下把标签页拖崩过。
                 */}
                <Link
                  className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  data-testid="memory-manage-link"
                  onClick={() => setActive(null)}
                  to="/settings/memory"
                >
                  {"管理全部长期记忆 →"}
                </Link>
                {undoneIds[active.id] ? (
                  <span className="text-xs font-medium text-emerald-400" data-testid="memory-undone-status">
                    {"✓ 已从长期记忆中撤销"}
                  </span>
                ) : (
                  <button
                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50"
                    data-testid="memory-undo-btn"
                    disabled={undoBusy}
                    onClick={() => void handleUndo(active)}
                    type="button"
                  >
                    <IconTrash className="size-3.5" />
                    <span>{undoBusy ? "正在撤销…" : "撤销此记忆"}</span>
                  </button>
                )}
              </div>
              {undoError ? (
                <p className="text-xs text-destructive" data-testid="memory-undo-error" role="alert">
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
    sameMemories(prev.memories, next.memories)
  );
}

const TranscriptMessage = memo(function TranscriptMessage({
  animate = false,
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
  if (!isUser && tone === "step") {
    return (
      <MessageRow align="start">
        <MessageContent>
          <Arriving animate={animate} delay={delay}>
            <div className="chat-step-line" data-cb-turn="step">
              <SmoothStreamdown components={markdownComponents}>
                {text}
              </SmoothStreamdown>
            </div>
          </Arriving>
        </MessageContent>
      </MessageRow>
    );
  }
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
            <BotBubbles
              animate={animate}
              components={richMarkdownComponents}
              delay={delay}
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
                    <span className="whitespace-pre-wrap">
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
                            <IconBox className="size-3 shrink-0" />/{invoked.chip}
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
          {/* 链接卡 / 图片一摞（DESIGN.md §31）；开场一句不带。 */}
          {tone === "lead" ? null : (
            <MessageRichPreviews align={align} text={isUser ? said : text} />
          )}
          {!isUser && memories && memories.length > 0 ? (
            <MemoryPills items={memories} />
          ) : null}
          {isUser && messageId ? <ReadMark messageId={messageId} /> : null}
          {isUser ? (
            editable && messageId ? (
              <div className="chat-msg-actions" data-align="end">
                {/* biome-ignore lint/a11y/useValidAriaRole: role 是组件自己的 prop（消息作者），不是 ARIA role */}
                <QuoteReplyAction messageId={messageId} role="user" text={said} />
                <EditAction onEdit={() => setEditing(true)} />
              </div>
            ) : null
          ) : !text.trim() ? null : tone === "lead" ? (
            canRegenerate ? (
              <div className="chat-msg-actions">
                {/* biome-ignore lint/a11y/useValidAriaRole: role 是组件自己的 prop（消息作者），不是 ARIA role */}
                <QuoteReplyAction messageId={messageId} role="assistant" text={text} />
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
  if (previous.delay !== next.delay) {
    return false;
  }
  if (previous.attachments.length !== next.attachments.length) {
    return false;
  }

  return previous.attachments.every((attachment, index) => {
    const other = next.attachments[index];
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

export const TranscriptAttachments = memo(function TranscriptAttachments({
  attachments,
  delay,
}: AttachmentRowProps) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <Arriving delay={delay}>
          <AttachmentTiles attachments={attachments} />
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
        "flex w-fit max-w-full flex-wrap items-start justify-end gap-2 self-end",
        className,
      )}
    >
      {pictures.length > 0 ? (
        <li key="pictures">
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
  const probe = fetch(url, { method: "HEAD", credentials: "include" })
    .then((response) => {
      const length = Number(response.headers.get("content-length"));
      return {
        missing: response.status === 404,
        size:
          response.ok && Number.isFinite(length) && length > 0 ? length : null,
      };
    })
    .finally(() => {
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

  useEffect(() => {
    if (!ask) {
      return;
    }
    // A tile reused at the same position for a different file starts the question over rather than
    // inheriting the previous file's answer.
    setGone(false);

    let cancelled = false;
    void probeDocument(url)
      .then(({ missing, size: bytes }) => {
        if (!cancelled && missing) {
          setGone(true);
        }
        if (!cancelled && bytes !== null) setSize(bytes);
      })
      .catch(() => {
        // Deliberately nothing: see above. Not knowing is not the same as knowing it is gone.
      });

    return () => {
      cancelled = true;
    };
  }, [ask, url]);

  return { gone, size };
}

function SentAttachmentTile({ attachment }: { attachment: SentAttachment }) {
  const [failedToLoad, setFailedToLoad] = useState(false);
  const { filename, modality, url } = attachment;
  /*
   * An off-site url is treated as a missing file, whatever kind of file it says it is.
   *
   * `toVisibleChatItems` passes on whatever a `url` source carried, and nothing between here and
   * the wire narrows it. A sent message only ever carries the relative form — `shared/attachments.ts`
   * says the url "is never fetched by a provider", and `copilot.ts` swaps the source for the bytes
   * as the run is built — so an absolute url arriving here did not come from this app's composer,
   * and putting it in `src` would have the reader's browser fetch a third party the instant the
   * transcript drew, announcing to whoever owns it that this person opened this channel.
   */
  const servable = url.startsWith(ATTACHMENT_URL_PREFIX);
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
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        overlayClassName="bg-black/80 supports-backdrop-filter:backdrop-blur-sm"
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
}: {
  delay: number;
  toolCallId: string;
  name: string;
  args: string;
  result?: string;
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
        {drawn ?? <ServerToolLine name={name} result={result} />}
      </ToolRenderBoundary>
    </Arriving>
  );
});

/**
 * A tool the runtime executed, drawn for the person watching.
 *
 * Named from the reader's side: what was done, against which server, with the server's own words
 * behind a disclosure. The identifier the model was offered never reaches the screen.
 */
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
  if (refused && name.startsWith("host_")) return <HostAccessHint />;
  return (
    <ToolLine
      {...(detail ? { detail } : {})}
      label={label}
      refused={refused}
      failed={failed}
      running={result === undefined}
    >
      {body ? (
        <Streamdown
          components={markdownComponents}
          translations={STREAMDOWN_ZH}
        >
          {forDisplay(body)}
        </Streamdown>
      ) : null}
    </ToolLine>
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

const SEND_SCROLL_MS = 700;

function useSmoothSendScroll(
  _viewport: React.RefObject<HTMLDivElement | null>,
  newestUserMessageId: string | null,
  opening = false,
) {
  const seenRef = useRef<string | null>(null);
  const wasOpening = useRef(opening);

  useLayoutEffect(() => {
    seenRef.current = newestUserMessageId;
    wasOpening.current = opening;
  }, [newestUserMessageId, opening]);
}

/**
 * 历史晚到、补在上面时，正在看底部的人画面不动（CB-047）。
 *
 * 打开很长的对话时，先画的是接入快照里的尾巴（常常不满一屏，scrollTop 停在 0）；存下的整段历史晚几秒到
 * （`readThreadMessages` 4 秒截止后后台重试），并进来是补在最上面——浏览器的滚动锚定在 scrollTop 为 0 时
 * 不起作用，画面就停在最上面，离底部两万 px。这里记着「人是不是在底部」（滚动时更新），
 * 第一行换了（前面补进来了 / 换了对话）而人在底部时，画完那一刻直接回到底部（不平滑，不算跳）。
 * 人往上翻着看的时候不动，交给浏览器的滚动锚定。
 *
 * 两个「别动手」的时机（2026-10-22）：
 * - 还没收到过任何滚动事件时不知道人在哪，就不动——以前一开始就算「在底部」，打开一段上次停在中间的对话，
 *   第一批补上来的行（长对话首屏分几帧补齐）会把位置钉到底部一下，再被 §88.3 的恢复拽回去，闪一下；
 * - 还在「打开」窗口里（`opening`）时位置归 `SettleAtEnd`（回到底部 / 回到上次那一条），这里再钉一次是抢。
 */
function useKeepBottomOnPrepend(
  viewport: React.RefObject<HTMLDivElement | null>,
  firstId: string | null,
  opening = false,
) {
  const atBottom = useRef<boolean | null>(null);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onScroll = () => {
      atBottom.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [viewport]);
  useLayoutEffect(() => {
    const element = viewport.current;
    const previous = seen.current;
    seen.current = firstId;
    if (
      !element ||
      opening ||
      previous === null ||
      firstId === null ||
      previous === firstId ||
      atBottom.current !== true
    )
      return;
    const behavior = element.style.scrollBehavior;
    element.style.scrollBehavior = "auto";
    element.scrollTop = element.scrollHeight;
    element.style.scrollBehavior = behavior;
  }, [firstId, viewport, opening]);
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
  if (!last || last.kind !== "text" || last.role !== "user") return null;
  if (!isPersonSentMessage(last.role, last.text)) return null;
  if (stoppedTurns?.has(last.id)) return null;
  return last;
}

export function ChatTranscript({
  busy = false,
  scrollKey,
  commandNames = "",
  messages,
  onRemoveQueued,
  queued = EMPTY_QUEUE,
  restoring = false,
  hydrating = false,
  stopped,
  stoppedTurns,
  onRetry,
  onRetryUnanswered,
  topNotice,
  fallbacks,
  lastSentAt = null,
}: ChatTranscriptProps) {
  /*
   * NOT MEMOISED, AND THAT IS DELIBERATE. `useMemo` keyed on `messages` looks obviously right and
   * silently broke the transcript: the agent hands back the SAME array and mutates it, so the
   * dependency never changed, the cached items were kept forever and a reply never appeared. A Bot
   * that answered looked like a Bot that had not.
   *
   * It was never the expensive part either. Rebuilding this list is a flatMap over messages; the
   * cost was markdown parsing and chart SVGs, and those are skipped by the memoised children below,
   * which is where the 25x came from. This runs per render and is not worth guarding.
   */
  const items = groupBrowserSteps(toVisibleChatItems(collapseScheduleRuns(messages)));
  /*
   * 「最后一轮还在跑」只从列表真的变了算起（§68.4）。按下发送的那一刻 busy 先变 true，人发的那条要再过
   * 几十毫秒才进列表；这几十毫秒里如果把「最后一轮」（上一轮，早就答完了）当成正在跑，它的结果气泡会变回
   * 开场一句、丢掉下面那行按钮，整页矮一截、往下一跳。所以：空闲时记下列表的样子，busy 之后列表没变就还算答完。
   * 重新生成 / 编辑重发会先截断列表，长度变了，照样算正在跑。
   */
  const settledRef = useRef<{ length: number; last: string | null } | null>(
    null,
  );
  const shape = { length: items.length, last: items.at(-1)?.id ?? null };
  if (!busy) settledRef.current = shape;
  const settled = settledRef.current;
  const live =
    busy &&
    !(
      settled !== null &&
      settled.length === shape.length &&
      settled.last === shape.last
    );
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
  // 一轮收成「开场一句 → 结果」，与机器人聊天同一规则（compactTurns，2026-10-13 第四轮）。
  const compact = compactTurns(
    items,
    live,
    stoppedTurns ?? EMPTY_STOPS,
    fallbacks,
  );
  const showToolActivity = useToolActivityVisible();
  /*
   * 简单回合（DESIGN.md §93）：做完了、只读的一两步、有结果——干活卡那一行整行收起，只留结果。结构上的判断在
   * compactTurns（`quiet`）；有确认卡的调用、这一页知道用时超过 15 秒的，照常显示。确认列表和确认卡片用同一份
   * 缓存（同一个 queryKey），不多发请求。打开「调试：显示工具调用」时不收（每一步本来就画着）。
   */
  const chatConfig = useCopilotChatConfiguration();
  const hasQuiet =
    !showToolActivity && [...compact.work.values()].some((work) => work.quiet);
  const confirmations = useThreadConfirmations(
    hasQuiet ? (chatConfig?.threadId ?? null) : null,
    false,
  );
  const confirmed = new Set<string>();
  for (const request of confirmations.data ?? [])
    if (request.toolCallId) confirmed.add(request.toolCallId);
  // 没绑到工具调用的确认卡片（§101.9）画在最下面；「用户确认了」那条已经进来的不再画（那一行就是记录）。
  const resumedCards = new Set<string>();
  for (const item of items) {
    if (item.kind !== "text" || item.role !== "user") continue;
    const id = confirmResumeId(item.text);
    if (id) resumedCards.add(id);
  }
  const quietRows = new Set<string>();
  if (hasQuiet) {
    for (const [anchor, work] of compact.work) {
      if (!work.quiet) continue;
      if (
        isQuietWork({
          calls: work.calls,
          live: work.live,
          hasFinal: true,
          confirmed,
          seconds: knownWorkSeconds(work.key),
          // 除了「做了 N 步」什么也说不出的行：成功做完就整行收起（2026-10-20 用户要求）。
          genericSummary: summarizeDoneWork(work.calls)?.generic === true,
        })
      ) {
        quietRows.add(anchor);
      }
    }
  }
  /** 这一行不画（收起的过程话、旧的浏览小条、简单回合的干活卡那一行）。 */
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
  useLayoutEffect(() => {
    const ids = new Set(items.map((item) => item.id));
    const shown = new Set<string>();
    for (const id of ids) if (!rowHidden(id)) shown.add(id);
    shownRef.current = shown;
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
  useSmoothSendScroll(viewportRef, newestUserMessageId, opening);
  /*
   * CB-025：长对话首屏只挂尾巴再分批往前补。keep-bottom 盯的是「当前挂着的第一行」——
   * 窗口上沿往前挪时 firstId 变了，人还在底部就立刻钉回底（与历史 prepend 同一条路）。
   */
  const { startIndex: tailStart, pending: tailPending } = useTailFirstMount(
    items.length,
    scrollKey,
    viewportRef,
    items[0]?.id,
  );
  useKeepBottomOnPrepend(viewportRef, items[tailStart]?.id ?? null, opening);

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
  useEffect(() => {
    if (hasItems && !opening) {
      delays.settle();
    }
  }, [hasItems, opening, delays]);

  /*
   * 翻页对齐落在视口上 1/3，而不是顶到最上（DESIGN.md §94.7）：上面留着上一轮、下面留 2/3 给回答，
   * 不会一发出就剩一整屏空白。滚动容器把「上一句露 48px」加在 scrollMargin 上，所以这里减掉它。
   * 只影响「新的一轮对齐」这一条路：恢复位置（§88.3）自己带着 scrollMargin，不受影响。
   */
  // CB-101：活动记录里点「在对话里看这一步」，滚到发起那次工具调用的消息并闪一下。
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    const onJump = (event: Event) => {
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
      const row = owner
        ? viewportRef.current?.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(owner.id)}"]`,
          )
        : null;
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("is-activity-jump");
      setTimeout(() => row.classList.remove("is-activity-jump"), 1600);
    };
    window.addEventListener(JUMP_TO_TOOL_CALL, onJump);
    return () => window.removeEventListener(JUMP_TO_TOOL_CALL, onJump);
  }, []);

  const [paneHeight, setPaneHeight] = useState(0);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setPaneHeight(Math.round(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const anchorOffset = paneHeight > 0 ? Math.max(0, Math.round(paneHeight / 3) - 48) : 0;

  return (
    <MessageScrollerProvider
      autoScroll
      scrollMargin={anchorOffset}
      scrollPreviousItemPeek={48}
    >
      <MessageScroller>
        <MessageScrollerViewport ref={viewportRef}>
          <MessageScrollerContent
            aria-busy={busy}
            data-testid="chat-transcript"
            data-tail-first-pending={tailPending ? "" : undefined}
            className="mx-auto w-full max-w-2xl px-4 py-6"
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
              {tailStop ? (
                <Stopped
                  onRetry={stopped ? onRetry : onRetryUnanswered}
                  reason={tailStop}
                />
              ) : waitingOnFirstToken ? (
                // 这一轮已经在调工具：换成干活卡（当前步骤 · 第几步 · 用时，DESIGN.md §70），同一位置、同样一行高。
                // 这一轮已经在干活：干活卡在第一个干活的工具那一行里（DESIGN.md §75.1），这里不再画「思考中」。
                liveWorking ? null : (
                  <Thinking />
                )
              ) : pausedAfterText !== null ? (
                <PauseDots watch={pausedAfterText} />
              ) : null}
              <LooseConfirmCards
                resumed={resumedCards}
                version={items.length}
              />
              {queued.map((message) => (
                <Queued
                  attachments={message.attachments}
                  key={message.id}
                  onRemove={
                    onRemoveQueued
                      ? () => onRemoveQueued(message.id)
                      : undefined
                  }
                  text={message.text}
                />
              ))}
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
            {items.length === 0 && restoring ? <RestoringTranscript /> : null}
            {(tailStart > 0 ? items.slice(tailStart) : items).flatMap(
              (item, offset) => {
                const index = tailStart + offset;
                const stoppedHere = compact.stoppedAfter.has(item.id);
                const fallback = compact.fallbackAfter.get(item.id);
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
                if (!stoppedHere && !fallback) return [row];
                return [
                  row,
                  stoppedHere ? (
                    <MessageScrollerItem
                      key={`${item.id}:stopped`}
                      messageId={`${item.id}:stopped`}
                    >
                      <div
                        className="chat-stopped-mark"
                        data-testid="turn-stopped"
                      >
                        {"◼ 已停止"}
                      </div>
                    </MessageScrollerItem>
                  ) : null,
                  fallback ? (
                    <MessageScrollerItem
                      key={`${item.id}:fallback`}
                      messageId={`${item.id}:fallback`}
                    >
                      <div
                        className="chat-fallback-note"
                        data-testid="turn-fallback"
                      >
                        {fallback}
                      </div>
                    </MessageScrollerItem>
                  ) : null,
                ];
              },
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="chat-bottom-pill">
          <IconChevronDown className="size-4" />
          <span className="chat-bottom-pill-t">{"回到底部"}</span>
        </MessageScrollerButton>
        <ScrollNewestQueuedIntoView
          newest={queued.at(-1)?.id ?? null}
          viewport={viewportRef}
        />
        <SettleAtEnd
          busy={busy}
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
  );

  /** 这一轮的干活卡 / 收成的一行，画在这一轮第一个干活的工具那一行里（DESIGN.md §75.1）。打开「调试：显示工具调用」时不画（每一步本来就画着）。 */
  function workRowFor(id: string) {
    if (showToolActivity) return null;
    const work = compact.work.get(id);
    return work ? (
      <WorkRow
        calls={work.calls}
        live={work.live}
        notes={work.notes}
        turnKey={work.key}
      />
    ) : null;
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
        <TranscriptAttachments
          attachments={item.attachments}
          delay={delays.delayFor(item.id, index, items.length)}
        />
      </MessageScrollerItem>
    ) : (
      // Every member of the union is handled above. `assertNever` types `item` as
      // `never` here, so a future addition to `VisibleChatItem` fails to typecheck at
      // this call instead of silently falling into this branch and rendering nothing.
      assertNever(item)
    );
  }
}

const EMPTY_STOPS: ReadonlySet<string> = new Set();
const EMPTY_ANCHORS: ReadonlySet<string> = new Set();

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
  const reducedMotion = useReducedMotion();
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
  useEffect(() => {
    if (!fresh) return;
    const timer = window.setTimeout(
      () => expire((n) => n + 1),
      FRESH_ANCHOR_MS - (Date.now() - memo.at) + 20,
    );
    return () => window.clearTimeout(timer);
  }, [fresh, memo]);
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
    const item = items[at]!;
    if (item.kind === "attachments") return null;
    if (item.kind !== "text") continue;
    if (isPersonSentMessage(item.role, item.text)) return null;
    if (item.role === "assistant" && item.text.trim() && !hidden.has(item.id))
      return item.id;
  }
  return null;
}

/**
 * 一轮收成「开场一句 → 结果」（频道聊天版，规则与 lib/copilot/turn-compaction.ts 相同，2026-10-13 第四轮）。
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
  /** 简单回合（只读的一两步、做完了、有结果）：结构上可以整行收起（§93）。 */
  quiet: boolean;
};

export function compactTurns(
  items: readonly TranscriptItem[],
  busy: boolean,
  stopped: ReadonlySet<string>,
  fallbacks?: ReadonlyMap<string, string>,
): {
  tone: Map<string, "lead" | "step" | "final">;
  hidden: Set<string>;
  /** 被停掉的轮次：最后一个看得见的行（后面挂「已停止」）。 */
  stoppedAfter: Set<string>;
  /** 换了备用模型的轮次：最后一个看得见的行 → 说明（§61）。 */
  fallbackAfter: Map<string, string>;
  /**
   * 干活卡（§75.1）：这一轮第一个干活的工具那一行 → 这一轮的全部调用、是否还在跑；key = 这一轮开头那条消息（记用时用）。
   * 还在跑时画实时卡，结束后同一个位置收成「搜索 2 次 · 12 秒 ⌄」。
   */
  work: Map<string, WorkEntry>;
  /** Hark 式回复引用（`╭─`）：当用户连发多条或中途插话时，助手回复自动挂上所回应的用户原话与消息 id。 */
  replyTo: Map<string, ReplyTarget>;
  /** 记忆写入微胶囊提示（Memory Pill）：本轮调用了 memory_save / memory_update / memory_log 时挂在回复气泡下方。 */
  memories: Map<string, MemoryPillItem[]>;
} {
  const tone = new Map<string, "lead" | "step" | "final">();
  const hidden = new Set<string>();
  const stoppedAfter = new Set<string>();
  const fallbackAfter = new Map<string, string>();
  const work = new Map<string, WorkEntry>();
  const replyTo = new Map<string, ReplyTarget>();
  const memories = new Map<string, MemoryPillItem[]>();
  const formatQuoteText = (raw: string): string => {
    const clean = (splitChatOrigin(raw)?.text ?? raw).replace(/\s+/g, " ").trim();
    return clean.length > 64 ? `${clean.slice(0, 63)}…` : clean;
  };
  // 一轮的开头：人发的消息，或服务器放进来、接着跑一轮的那几种（定时任务 / 任务结果 / 后来确认，CB-046）。
  const sent = (item: TranscriptItem) =>
    item.kind === "attachments" ||
    (item.kind === "text" &&
      (isPersonSentMessage(item.role, item.text) ||
        (item.role === "user" && serverRowKind(item.text) !== null)));
  const turns: { users: TranscriptItem[]; rest: TranscriptItem[] }[] = [
    { users: [], rest: [] },
  ];
  for (const item of items) {
    const current = turns[turns.length - 1]!;
    if (sent(item)) {
      if (current.rest.length === 0 && current.users.length > 0)
        current.users.push(item);
      else turns.push({ users: [item], rest: [] });
    } else current.rest.push(item);
  }
  const personTextsOf = (list: readonly TranscriptItem[]) =>
    list.filter(
      (u): u is Extract<TranscriptItem, { kind: "text" }> =>
        u.kind === "text" && isPersonSentMessage(u.role, u.text) && u.text.trim().length > 0,
    );
  turns.forEach((turn, index) => {
    const live = busy && index === turns.length - 1;
    const isStopped =
      !live && turn.users.some((user) => stopped.has(turnOf(user)));
    const callsTool = (item: TranscriptItem) =>
      item.kind === "tool" || item.kind === "browser";
    const texts = turn.rest.filter(
      (item): item is Extract<TranscriptItem, { kind: "text" }> =>
        item.kind === "text" &&
        item.role === "assistant" &&
        item.text.trim().length > 0,
    );
    let final: string | null = null;
    texts.forEach((item, i) => {
      const at = turn.rest.indexOf(item);
      const toolAfter = turn.rest.slice(at + 1).some(callsTool);
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
      const lastRest = [...turn.rest]
        .reverse()
        .find(
          (item) =>
            item.kind !== "text" ||
            item.role !== "assistant" ||
            item.text.trim(),
        );
      if (
        lastRest?.kind === "tool" &&
        lastRest.toolCall.function.name === "render_ui"
      ) {
        const promoted = texts[texts.length - 1]!;
        final = promoted.id;
        tone.set(promoted.id, "final");
      }
    }
    const personUsers = personTextsOf(turn.users);
    const prevTurn = index > 0 ? turns[index - 1] : undefined;
    const prevUsers = prevTurn ? personTextsOf(prevTurn.users) : [];
    const prevTurnStopped =
      prevTurn !== undefined &&
      prevTurn.users.some((user) => stopped.has(turnOf(user)));
    const prevInterjected =
      prevTurn !== undefined &&
      !prevTurnStopped &&
      prevUsers.length > 0 &&
      prevTurn.rest.length > 0 &&
      !prevTurn.rest.some((r) => r.kind === "text" && tone.get(r.id) === "final");
    const multiReplyTurn = (personUsers.length > 1 || prevInterjected) && texts.length > 1;
    if (final)
      for (const item of texts)
        if (tone.get(item.id) === "step" && !(multiReplyTurn && item.id === texts[0]?.id))
          hidden.add(item.id);
    const browsers = turn.rest.filter((item) => item.kind === "browser");
    for (const item of browsers.slice(0, -1)) hidden.add(item.id);
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
          calls.push({
            name,
            arguments: tool.toolCall.function.arguments,
            done: tool.result !== undefined,
            id: tool.toolCall.id,
            failed: tool.result !== undefined && workCallFailed(tool.result),
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
            !(multiReplyTurn && item.id === texts[0]?.id) &&
            !/^\s*>\s+\S/.test(item.text)
          ) {
            const workAfter = turn.rest
              .slice(at + 1)
              .some(
                (next) =>
                  next.kind === "browser" ||
                  (next.kind === "tool" &&
                    isWorkCall(next.toolCall.function.name)),
              );
            if (!live || workAfter) {
              hidden.add(item.id);
              notes.push({ at: seen, text: item.text });
            }
          }
        });
        // 简单回合（§93）：结构上的判断在这里；确认卡、用时只有渲染时知道，ChatTranscript 再看一遍。
        const quiet = isQuietWork({
          calls,
          live,
          stopped: isStopped,
          hasFinal: final !== null,
          // 只说得出「做了 N 步」的一轮（例如跑了几条命令）：收起这一行，只留回答（2026-10-20 用户要求）。
          genericSummary: summarizeDoneWork(calls)?.generic === true,
        });
        work.set(anchor, { calls, key, live, notes, quiet });
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
      const firstUser = prevInterjected ? prevUsers[prevUsers.length - 1] : personUsers[0];
      const lastUser = personUsers[personUsers.length - 1];
      const firstBot = visibleBotTexts[0]!;
      const lastBot = visibleBotTexts[visibleBotTexts.length - 1]!;
      if (firstUser) {
        const q1 = formatQuoteText(firstUser.text);
        if (q1) replyTo.set(firstBot.id, { id: firstUser.id, text: q1 });
      }
      if (lastUser) {
        const q2 = formatQuoteText(lastUser.text);
        if (q2) replyTo.set(lastBot.id, { id: lastUser.id, text: q2 });
      }
    } else {
      const replyTargetId = final ?? visibleBotTexts[0]?.id ?? null;
      if (replyTargetId && personUsers.length > 0 && (personUsers.length > 1 || prevInterjected)) {
        const targetUser = personUsers[personUsers.length - 1]!;
        const quoteText = formatQuoteText(targetUser.text);
        if (quoteText) replyTo.set(replyTargetId, { id: targetUser.id, text: quoteText });
      }
    }
    const visible = [...turn.users, ...turn.rest].filter(
      (item) => !hidden.has(item.id),
    );
    const last = visible[visible.length - 1]?.id;
    if (isStopped && last) stoppedAfter.add(last);
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
      if (
        fnName !== "memory_save" &&
        fnName !== "memory_update" &&
        fnName !== "memory_log"
      ) {
        continue;
      }
      if (item.result !== undefined && workCallFailed(item.result)) continue;
      let parsedArgs: Record<string, unknown> = {};
      try {
        const raw = JSON.parse(item.toolCall.function.arguments || "{}");
        if (raw && typeof raw === "object") parsedArgs = raw as Record<string, unknown>;
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
        resStr.replace(/^已(?:记下|并入|更新)[：:]\s*(?:\[mem_[^\]]+\]\s*)?/, "").trim();
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
        subject: typeof parsedArgs.subject === "string" ? parsedArgs.subject : undefined,
        action:
          fnName === "memory_save"
            ? "save"
            : fnName === "memory_update"
              ? "update"
              : "log",
      });
    }
    const memTargetId = final ?? visibleBotTexts[visibleBotTexts.length - 1]?.id ?? null;
    if (memTargetId && turnMemories.length > 0) {
      memories.set(memTargetId, turnMemories);
    }
  });
  return { tone, hidden, stoppedAfter, fallbackAfter, work, replyTo, memories };
}
