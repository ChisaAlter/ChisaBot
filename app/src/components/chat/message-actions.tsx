import {
  IconArrowBackUp,
  IconPencil,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, StatusGlyph } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type EditableAttachment,
  useMessageActions,
} from "@/lib/conversations/regenerate";

/**
 * 消息下面的「重新生成」「编辑」和原地编辑框（DESIGN.md §67，CB-042）。频道聊天用。
 *
 * 样式跟「复制」一样是消息下面的淡色小胶囊（`.chat-msg-action`，悬停 / 聚焦才显，触屏常显），
 * 异步的那个走按钮状态机：重新生成 → 圈「生成中…」→ 成功时这条回答本来就被换掉了；失败 ✕ + toast 原因。
 */

const FAILED = (error: Error) => error.message || "没能重发，稍后再试。";

/** 一个淡色小胶囊动作；`run` 返回 Promise 时走状态机。 */
function PillAction({
  icon,
  label,
  pending,
  run,
  testId,
  held = false,
}: {
  /** 现在不能做（在回答）：按钮留着位置但看不见、点不到——拿掉它，每条消息矮 30px，发送那一刻整页跳（§68.4）。 */
  held?: boolean;
  icon: ReactNode;
  label: string;
  pending: string;
  run: () => Promise<unknown> | void;
  testId: string;
}) {
  const action = useAsyncAction(
    async () => {
      await run();
    },
    { errorToast: FAILED },
  );
  const state = action.state;
  return (
    <button
      aria-label={state === "pending" ? pending : label}
      aria-hidden={held || undefined}
      className="chat-msg-action"
      data-btn-state={state}
      data-held={held || undefined}
      data-testid={held ? undefined : testId}
      disabled={held || state === "pending"}
      tabIndex={held ? -1 : undefined}
      onClick={() => void action.run()}
      type="button"
    >
      <span className="btn-stack" data-state={state}>
        <span className="btn-face" data-face="idle">
          {icon}
        </span>
        <span className="btn-face" data-face="status">
          <StatusGlyph />
        </span>
      </span>
      {/* Visual stack only — accessible name is the single live aria-label on the button. */}
      <span aria-hidden="true" className="btn-labels">
        {(["idle", "pending", "error"] as const).map((key) => (
          <span
            data-for={key}
            key={key}
            style={{
              opacity: (state === "success" ? "idle" : state) === key ? 1 : 0,
            }}
          >
            {{ idle: label, pending, error: "失败" }[key]}
          </span>
        ))}
      </span>
    </button>
  );
}

/** 最后一条回答下面的「重新生成」。没有 context（别的页面）时不画；现在不能做时占位不显示。 */
export function RegenerateAction() {
  const actions = useMessageActions();
  if (!actions) return null;
  return (
    <PillAction
      held={!actions.canAct}
      icon={<IconRefresh className="size-3.5" />}
      label="重新生成"
      pending="生成中…"
      run={() => actions.regenerate()}
      testId="msg-regenerate"
    />
  );
}

/** 用户消息下面的「编辑」：只是打开编辑框（同步）。 */
export function EditAction({ onEdit }: { onEdit: () => void }) {
  const actions = useMessageActions();
  if (!actions) return null;
  // 在回答时占位不显示（同 PillAction 的 held）：发送那一刻每条用户消息不能矮一截。
  const held = !actions.canAct;
  return (
    <button
      aria-hidden={held || undefined}
      aria-label="编辑这条消息"
      className="chat-msg-action"
      data-held={held || undefined}
      data-testid={held ? undefined : "msg-edit"}
      disabled={held}
      onClick={onEdit}
      tabIndex={held ? -1 : undefined}
      type="button"
    >
      <IconPencil className="size-3.5" />
      <span>{"编辑"}</span>
    </button>
  );
}

/** 用户消息下面的「撤回」：从这条消息起撤掉，不立即重发。 */
export function WithdrawAction({ messageId }: { messageId: string }) {
  const actions = useMessageActions();
  if (!actions?.withdraw) return null;
  const withdraw = actions.withdraw;
  return (
    <PillAction
      held={!actions.canAct}
      icon={<IconArrowBackUp className="size-3.5" />}
      label="撤回"
      pending="撤回中…"
      run={() => withdraw(messageId)}
      testId="msg-withdraw"
    />
  );
}

/**
 * 用户气泡原地变成的编辑框：文字框（自动长高）+ 已有附件移除条 + 一行说明 + 取消 / 发送（§2 状态机：发送中… → 成功后这条
 * 就被新的一条替换，编辑框随之卸载）。Enter 发送、Shift+Enter 换行、Esc 取消；输入法组字时 Enter 不发。
 */
export function MessageEditor({
  attachments,
  initial,
  messageId,
  onClose,
}: {
  attachments?: readonly EditableAttachment[] | undefined;
  initial: string;
  messageId: string;
  onClose: () => void;
}) {
  const actions = useMessageActions();
  const [text, setText] = useState(initial);
  const [removedIndices, setRemovedIndices] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const keptAttachments = (attachments ?? []).filter(
    (item) => !removedIndices.has(item.partIndex),
  );
  const send = useAsyncAction(
    async () => {
      if (!actions) throw new Error("现在不能重发。");
      await actions.edit(
        messageId,
        text,
        removedIndices.size > 0 ? removedIndices : undefined,
      );
      onClose();
    },
    { errorToast: FAILED },
  );
  const hasContent = Boolean(text.trim()) || keptAttachments.length > 0;
  const hasChanges = text.trim() !== initial.trim() || removedIndices.size > 0;
  const blocked = !hasContent || !hasChanges || !actions?.canAct;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (!blocked) void send.run();
    }
  };
  return (
    <div className="chat-msg-editor" data-testid="msg-editor">
      {keptAttachments.length > 0 ? (
        <div
          className="chat-msg-editor-attachments"
          data-testid="msg-editor-attachments"
        >
          {keptAttachments.map((item) => (
            <span className="chat-msg-editor-chip" key={item.partIndex}>
              <span className="truncate">{item.label}</span>
              <button
                aria-label={`移除附件 ${item.label}`}
                className="chat-msg-editor-chip-remove"
                data-testid="msg-editor-remove-attachment"
                onClick={() =>
                  setRemovedIndices((previous) => {
                    const next = new Set(previous);
                    next.add(item.partIndex);
                    return next;
                  })
                }
                type="button"
              >
                <IconX className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {/* 刷新会丢掉正在改的这一版：`lib/activity.ts` 的「有新版本」确认只认带这个标记的输入。 */}
      <Textarea
        aria-label="编辑消息"
        className="chat-msg-editor-input"
        data-unsent-watch
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          keptAttachments.length === 0 && (attachments?.length ?? 0) > 0
            ? "输入文字后发送，或取消后点「撤回」…"
            : undefined
        }
        ref={ref}
        rows={2}
        value={text}
      />
      <div className="chat-msg-editor-bar">
        <span className="chat-msg-editor-hint">
          {!hasContent && (attachments?.length ?? 0) > 0
            ? "补一句文字后发送，或取消后点「撤回」删除整条消息"
            : "发送后，这条之后的对话会换成新的回答"}
        </span>
        <Button
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
          disabled={send.state === "pending"}
        >
          {"取消"}
        </Button>
        <Button
          data-testid="msg-editor-send"
          disabled={blocked}
          feedback="send"
          onClick={() => void send.run()}
          size="sm"
          state={send.state}
          type="button"
        >
          {"发送"}
        </Button>
      </div>
    </div>
  );
}
