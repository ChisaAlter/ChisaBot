import { IconPencil, IconRefresh } from "@tabler/icons-react";
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
import { useMessageActions } from "@/lib/copilot/regenerate";

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

/**
 * 用户气泡原地变成的编辑框：文字框（自动长高）+ 一行说明 + 取消 / 发送（§2 状态机：发送中… → 成功后这条
 * 就被新的一条替换，编辑框随之卸载）。Enter 发送、Shift+Enter 换行、Esc 取消；输入法组字时 Enter 不发。
 */
export function MessageEditor({
  initial,
  messageId,
  onClose,
}: {
  initial: string;
  messageId: string;
  onClose: () => void;
}) {
  const actions = useMessageActions();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const send = useAsyncAction(
    async () => {
      if (!actions) throw new Error("现在不能重发。");
      await actions.edit(messageId, text);
      onClose();
    },
    { errorToast: FAILED },
  );
  const blocked =
    !text.trim() || text.trim() === initial.trim() || !actions?.canAct;
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
      <Textarea
        aria-label="编辑消息"
        className="chat-msg-editor-input"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        ref={ref}
        rows={2}
        value={text}
      />
      <div className="chat-msg-editor-bar">
        <span className="chat-msg-editor-hint">
          {"发送后，这条之后的对话会换成新的回答"}
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
