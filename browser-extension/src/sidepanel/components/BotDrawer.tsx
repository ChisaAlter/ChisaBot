import type { BotSummary, ThreadSummary } from "../../types/protocol";

interface BotDrawerProps {
  open: boolean;
  bots: BotSummary[];
  selectedBotId: string | null;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onClose: () => void;
  onSelectBot: (bot: BotSummary) => void;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
}

export function BotDrawer({
  open,
  bots,
  selectedBotId,
  threads,
  activeThreadId,
  onClose,
  onSelectBot,
  onNewThread,
  onSelectThread,
}: BotDrawerProps) {
  if (!open) return null;

  return (
    <div
      className="sp-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="切换助手与历史会话"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <aside className="sp-drawer" data-surface="elevated">
        <div className="sp-drawer-head">
          <h2 className="sp-drawer-title">助手与会话</h2>
          <button
            type="button"
            className="sp-icon-btn"
            data-surface="control"
            aria-label="关闭抽屉"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <button
          type="button"
          className="sp-btn sp-btn-primary"
          onClick={() => {
            onNewThread();
            onClose();
          }}
        >
          ＋ 开启新对话
        </button>

        <div>
          <div className="sp-section-label">选择 Bot 助手</div>
          <div className="sp-list">
            {bots.map((bot) => (
              <button
                key={bot.id}
                type="button"
                className="sp-list-item"
                data-active={bot.id === selectedBotId}
                onClick={() => {
                  onSelectBot(bot);
                  onClose();
                }}
              >
                <span className="sp-role-avatar">
                  {bot.avatarUrl ? (
                    <img src={bot.avatarUrl} alt={bot.name} />
                  ) : (
                    bot.name.slice(0, 1)
                  )}
                </span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {bot.name}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="sp-section-label">历史会话（全端同步）</div>
          {threads.length === 0 ? (
            <p className="sp-tier-desc" style={{ margin: "4px 2px" }}>
              当前助手暂无其他历史对话
            </p>
          ) : (
            <div className="sp-list">
              {threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className="sp-list-item"
                  data-active={thread.id === activeThreadId}
                  onClick={() => {
                    onSelectThread(thread.id);
                    onClose();
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {thread.title}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
