import type { CompanionRuntimeState } from "../../types/protocol";

interface TopBarProps {
  runtime: CompanionRuntimeState;
  botName: string;
  onOpenDrawer: () => void;
  onOpenVoice: () => void;
  onOpenSettings: () => void;
}

export function TopBar({
  runtime,
  botName,
  onOpenDrawer,
  onOpenVoice,
  onOpenSettings,
}: TopBarProps) {
  const tabCount = Math.max(
    runtime.controlledTabIds.length,
    runtime.sessionState === "controlling" ? 1 : 0,
  );

  let tone: "online" | "running" | "warn" | "danger" = "online";
  let statusText = `${botName}已就绪`;

  if (runtime.wsState === "revoked") {
    tone = "danger";
    statusText = "设备令牌已撤销";
  } else if (
    runtime.wsState === "offline" ||
    runtime.wsState === "connecting"
  ) {
    tone = "warn";
    statusText =
      runtime.wsState === "connecting" ? "正在连接服务器…" : "离线 · 等待重连";
  } else if (runtime.sessionState === "controlling") {
    tone = "running";
    statusText = `${botName}正在 ${tabCount} 个标签页中运行`;
  } else if (runtime.sessionState === "yielded_to_human") {
    tone = "warn";
    statusText = `${botName}已礼让暂停（${tabCount || 1} 个标签页）`;
  } else if (runtime.sessionState === "awaiting_approval") {
    tone = "warn";
    statusText = `${botName}正在等待你的确认`;
  } else if (runtime.attached && runtime.activeTab) {
    tone = "online";
    statusText = `${botName}已附着当前标签页`;
  }

  return (
    <header className="sp-topbar" data-surface="panel">
      <div className="sp-topbar-left">
        <button
          type="button"
          className="sp-icon-btn"
          data-surface="control"
          aria-label="切换助手与历史会话"
          title="切换助手与历史会话"
          onClick={onOpenDrawer}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h12" />
          </svg>
        </button>
      </div>

      <div className="sp-status-pill" data-surface="inset" title={statusText}>
        <span className="sp-status-dot" data-tone={tone} />
        <span className="sp-status-text">{statusText}</span>
      </div>

      <div className="sp-topbar-right">
        <button
          type="button"
          className="sp-icon-btn"
          data-surface="control"
          aria-label="打开语音通话"
          title="语音通话"
          onClick={onOpenVoice}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <path d="M12 19v3" />
          </svg>
        </button>

        <button
          type="button"
          className="sp-icon-btn"
          data-surface="control"
          aria-label="打开权限与外观设置"
          title="设置"
          onClick={onOpenSettings}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
