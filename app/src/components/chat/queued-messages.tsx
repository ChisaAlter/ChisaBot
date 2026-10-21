import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { IconClockHour4, IconRefresh, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { queueMessage, sendPausedMessage, useQueuedMessages, withdrawMessage } from "@/lib/copilot/thread-inbox";

/**
 * 消息列表末尾的「已排队」气泡（DESIGN.md §38.1）：机器人回答期间发的消息，在它被读进去之前画在这里，
 * 和用户气泡同一个位置、同一个圆角，只是淡一点、下面一行小字「已排队 · 当前步骤结束后读取」。
 * 被读到时这一条从这里消失，同一条消息出现在对话记录里它被读到的位置（服务器推的快照），不重复。
 */
export function QueuedMessages() {
  const chat = useCopilotChatConfiguration();
  const threadId = chat?.threadId;
  const items = useQueuedMessages(threadId);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const send = async (id: string) => {
    if (!threadId) return;
    setSending(id);
    setError(null);
    try { await sendPausedMessage(threadId, id); }
    catch (reason) { setError({ id, text: reason instanceof Error ? reason.message : "发送失败，请稍后重试。" }); }
    finally { setSending(null); }
  };
  const withdraw = async (id: string) => {
    if (!threadId) return;
    setSending(id);
    setError(null);
    try {
      if (!await withdrawMessage(threadId, id)) setError({ id, text: "还未确认撤回，请稍后重试。" });
    } finally { setSending(null); }
  };
  if (!threadId || !items.length) return null;
  return (
    <div className="queued-stack" data-testid="queued-messages">
      {items.map((item) => (
        <div className="queued-msg" data-queued-id={item.id} data-status={item.status} key={item.id}>
          <div className="queued-bubble">{item.text}</div>
          <div className="queued-meta">
            {item.status === "paused" ? (
              <>
                <span className="queued-state">{item.kind === "worker_result" ? "后台结果已暂停 · 等待你发送" : "已暂停 · 等待你发送"}</span>
                <button className="queued-action" type="button" disabled={sending !== null} onClick={() => void send(item.id)}
                  title="只发送这条补充，其他保留消息继续暂停">
                  {sending === item.id ? "发送中…" : "发送这条"}
                </button>
              </>
            ) : item.status === "failed" ? (
              <>
                <span className="queued-state is-failed">{"没发出去"}</span>
                <button
                  className="queued-action"
                  onClick={() => void queueMessage(threadId, item.text, item.id)}
                  title={"重新发送"}
                  type="button"
                >
                  <IconRefresh className="size-3" />
                  {"重试"}
                </button>
              </>
            ) : (
              <span className="queued-state">
                <IconClockHour4 className="size-3" />
                {item.status === "sending" ? "发送中…" : "已排队 · 当前步骤结束后读取"}
              </span>
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
          {error?.id === item.id && <div role="alert" className="text-destructive text-xs">{error.text}</div>}
        </div>
      ))}
    </div>
  );
}
