import {
  IconBolt,
  IconCheck,
  IconClockHour4,
  IconPaperclip,
  IconPencil,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useState } from "react";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import {
  ContentEnter,
  SmoothCollapse,
} from "@/components/ui/motion-primitives";
import { useConversationScope } from "@/lib/chat/conversation-scope";
import {
  patchInboxMessage,
  queueMessage,
  sendPausedMessage,
  useQueuedMessages,
  withdrawMessage,
} from "@/lib/conversations/thread-inbox";
import { useRetainedValue } from "@/lib/motion";

/**
 * 消息列表末尾的「已排队」气泡（DESIGN.md §38.1）：机器人回答期间发的消息，在它被读进去之前画在这里，
 * 和用户气泡同一个位置、同一个圆角，只是淡一点、下面一行小字「已排队 · 当前步骤结束后读取」。
 * 被读到时这一条从这里消失，同一条消息出现在对话记录里它被读到的位置（服务器推的快照），不重复。
 */
export function QueuedMessages() {
  const chat = useConversationScope();
  const threadId = chat?.threadId;
  const items = useQueuedMessages(threadId);
  const [sending, setSending] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const steer = async (id: string) => {
    if (!threadId) return;
    setSending(id);
    setError(null);
    try {
      const res = await patchInboxMessage(threadId, { id, action: "steer" });
      if (!res.ok) setError({ id, text: "无法引导这条消息，请稍后重试。" });
    } finally {
      setSending(null);
    }
  };
  const saveEdit = async (id: string) => {
    if (!threadId) return;
    const trimmed = editText.trim();
    if (!trimmed) {
      setError({ id, text: "内容不能为空。" });
      return;
    }
    setSending(id);
    setError(null);
    try {
      const res = await patchInboxMessage(threadId, {
        id,
        action: "edit",
        text: trimmed,
      });
      if (res.ok) setEditingId(null);
      else setError({ id, text: "修改失败，该消息可能已被读取。" });
    } finally {
      setSending(null);
    }
  };
  const send = async (id: string) => {
    if (!threadId) return;
    setSending(id);
    setError(null);
    try {
      await sendPausedMessage(threadId, id);
    } catch (reason) {
      setError({
        id,
        text:
          reason instanceof Error ? reason.message : "发送失败，请稍后重试。",
      });
    } finally {
      setSending(null);
    }
  };
  const withdraw = async (id: string) => {
    if (!threadId) return;
    setSending(id);
    setError(null);
    try {
      if (!(await withdrawMessage(threadId, id)))
        setError({ id, text: "还未确认撤回，请稍后重试。" });
    } finally {
      setSending(null);
    }
  };
  // CB-104: everything Stop held, sent in order (each as its own turn), with one press.
  const held = items.filter((item) => item.status === "paused");
  const sendAll = async () => {
    if (!threadId) return;
    setSending("*");
    setError(null);
    let current = "";
    try {
      for (const item of held) {
        current = item.id;
        await sendPausedMessage(threadId, item.id);
      }
    } catch (reason) {
      setError({
        id: current,
        text:
          reason instanceof Error ? reason.message : "发送失败，请稍后重试。",
      });
    } finally {
      setSending(null);
    }
  };
  const retainedError = useRetainedValue(error);
  if (!threadId || !items.length) return null;
  return (
    <div className="queued-stack ch-content-enter" data-testid="queued-messages">
      <SmoothCollapse open={held.length > 1} unmountOnExit>
        <div className="queued-meta">
          <span className="queued-state">{`${held.length} 条已暂停 · 等待你发送`}</span>
          <button
            className="queued-action"
            data-testid="queued-send-all"
            type="button"
            disabled={sending !== null}
            onClick={() => void sendAll()}
            title="按顺序发送全部保留的消息"
          >
            {sending === "*" ? "发送中…" : "全部发送"}
          </button>
        </div>
      </SmoothCollapse>
      {items.map((item) => {
          const itemErrorOpen = error?.id === item.id;
          const itemErrorText =
            error?.id === item.id
              ? error.text
              : retainedError?.id === item.id
                ? retainedError.text
                : null;
          return (
            <div
              className="queued-msg"
              data-queued-id={item.id}
              data-status={item.status}
              key={item.id}
            >
              <div className="queued-bubble">
                {item.message &&
                  toVisibleChatItems([item.message])
                    .flatMap((row) =>
                      row.kind === "attachments" ? row.attachments : [],
                    )
                    .map((file) => (
                      <a
                        className="flex items-center gap-1.5 py-1 text-sm underline-offset-2 hover:underline"
                        href={file.url}
                        target="_blank"
                        rel="noreferrer"
                        key={file.id}
                      >
                        <IconPaperclip className="size-4 shrink-0" />
                        {file.filename || "附件"}
                      </a>
                    ))}
                {editingId === item.id ? (
                  <ContentEnter key="edit">
                    <form
                      className="flex flex-col gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveEdit(item.id);
                      }}
                    >
                      <input
                        aria-label={"编辑排队消息内容"}
                        className="w-full rounded-md border border-border/60 bg-background/80 px-2 py-1 text-sm text-foreground outline-none focus:border-ring"
                        data-testid="queued-edit-input"
                        onChange={(e) => setEditText(e.target.value)}
                        value={editText}
                      />
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          className="queued-action"
                          data-testid="queued-edit-cancel"
                          onClick={() => setEditingId(null)}
                          type="button"
                        >
                          {"取消"}
                        </button>
                        <button
                          className="queued-action"
                          data-testid="queued-edit-save"
                          disabled={sending !== null}
                          type="submit"
                        >
                          <IconCheck className="size-3" />
                          {"保存"}
                        </button>
                      </div>
                    </form>
                  </ContentEnter>
                ) : (
                  <ContentEnter key="read">{item.text}</ContentEnter>
                )}
              </div>
              <div className="queued-meta">
                {item.status === "paused" ? (
                  <>
                    <span className="queued-state">
                      {item.kind === "worker_result"
                        ? "后台结果已暂停 · 等待你发送"
                        : "已暂停 · 等待你发送"}
                    </span>
                    <button
                      className="queued-action"
                      type="button"
                      disabled={sending !== null}
                      onClick={() => void send(item.id)}
                      title="只发送这条补充，其他保留消息继续暂停"
                    >
                      {sending === item.id ? "发送中…" : "发送这条"}
                    </button>
                  </>
                ) : item.status === "failed" ? (
                  <>
                    <span className="queued-state is-failed">{"没发出去"}</span>
                    <button
                      className="queued-action"
                      onClick={() =>
                        void queueMessage(
                          threadId,
                          item.message
                            ? { message: item.message, skillIds: item.skillIds }
                            : item.text,
                          item.id,
                          item.deliveryMode ? { mode: item.deliveryMode } : {},
                        )
                      }
                      title={"重新发送"}
                      type="button"
                    >
                      <IconRefresh className="size-3" />
                      {"重试"}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="queued-state">
                      <IconClockHour4 className="size-3" />
                      {item.status === "sending"
                        ? "发送中…"
                        : item.steerAction === "next-step"
                          ? "已插话 · 当前操作后接管"
                          : item.deliveryMode === "steer"
                            ? "已引导 · 正在切入当前回复"
                            : "已排队 · 当前步骤结束后读取"}
                    </span>
                    {item.status === "queued" &&
                      item.kind !== "worker_result" && (
                        <>
                          <button
                            aria-label={"立即引导这条消息"}
                            className="queued-action"
                            data-testid="queued-steer-btn"
                            disabled={sending !== null}
                            onClick={() => void steer(item.id)}
                            title={"立即插话引导"}
                            type="button"
                          >
                            <IconBolt className="size-3" />
                            {"立即引导"}
                          </button>
                          <button
                            aria-label={"编辑这条排队消息"}
                            className="queued-action"
                            data-testid="queued-edit-btn"
                            disabled={sending !== null}
                            onClick={() => {
                              setError(null);
                              setEditingId(item.id);
                              setEditText(item.text);
                            }}
                            title={"编辑"}
                            type="button"
                          >
                            <IconPencil className="size-3" />
                            {"编辑"}
                          </button>
                        </>
                      )}
                  </>
                )}
                <button
                  aria-label={"撤回这条排队的消息"}
                  className="queued-action"
                  disabled={sending !== null}
                  onClick={() => void withdraw(item.id)}
                  title={"撤回"}
                  type="button"
                >
                  <IconX className="size-3" />
                  {"撤回"}
                </button>
              </div>
              <SmoothCollapse open={itemErrorOpen} unmountOnExit>
                {itemErrorText ? (
                  <div
                    role={itemErrorOpen ? "alert" : undefined}
                    className="text-destructive text-xs"
                  >
                    {itemErrorText}
                  </div>
                ) : null}
              </SmoothCollapse>
            </div>
          );
        })}
      </div>
  );
}
