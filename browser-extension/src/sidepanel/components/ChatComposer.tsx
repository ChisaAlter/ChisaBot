import { type FormEvent, type KeyboardEvent, useState } from "react";
import type { TabContextSummary } from "../../types/protocol";

interface ChatComposerProps {
  attached: boolean;
  activeTab: TabContextSummary | null;
  running: boolean;
  liveStepLabel: string | null;
  disabled: boolean;
  onToggleAttached: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

function summarizeTab(tab: TabContextSummary | null): string {
  if (!tab) return "未检测到可附着网页";
  if (tab.title.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).hostname;
  } catch {
    return tab.url || "当前标签页";
  }
}

export function ChatComposer({
  attached,
  activeTab,
  running,
  liveStepLabel,
  disabled,
  onToggleAttached,
  onSend,
  onStop,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("");

  function submitText() {
    const clean = draft.trim();
    if (!clean || disabled || running) return;
    setDraft("");
    onSend(clean);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submitText();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submitText();
    }
  }

  return (
    <div className="sp-bottom">
      {/* 输入框正上方实时状态横条 */}
      {liveStepLabel ? (
        <div className="sp-live-strip" data-surface="panel" role="status">
          <div className="sp-live-strip-main">
            <span aria-hidden="true">🌐</span>
            <span className="sp-live-strip-text">浏览器 · {liveStepLabel}</span>
          </div>
          {running ? (
            <span style={{ fontSize: 11, color: "var(--accent-ink)" }}>
              实时同步中
            </span>
          ) : null}
        </div>
      ) : null}

      <form
        className="sp-composer"
        data-surface="panel"
        onSubmit={handleSubmit}
      >
        <textarea
          className="sp-textarea"
          placeholder={
            attached
              ? "向助手提问，或让它查看并协作操作当前网页…（Enter 发送）"
              : "输入消息与助手对话…（当前页未附着）"
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={disabled}
        />

        <div className="sp-composer-bar">
          <button
            type="button"
            className="sp-attach-pill"
            data-attached={attached}
            title={
              attached
                ? `点击断开当前页附着（${summarizeTab(activeTab)}）`
                : "点击附着当前浏览器标签页"
            }
            onClick={onToggleAttached}
          >
            <span aria-hidden="true">{attached ? "●" : "○"}</span>
            <span className="sp-attach-label">
              {attached
                ? `当前页已附着 · ${summarizeTab(activeTab)}`
                : "当前页未附着"}
            </span>
          </button>

          {running ? (
            <button type="button" className="sp-stop-btn" onClick={onStop}>
              停止
            </button>
          ) : (
            <button
              type="submit"
              className="sp-send-btn"
              disabled={disabled || !draft.trim()}
            >
              发送
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
