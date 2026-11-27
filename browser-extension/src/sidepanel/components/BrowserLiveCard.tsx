import { memo, useState } from "react";
import type { BrowserLiveCardState } from "../../types/protocol";

interface BrowserLiveCardProps {
  card: BrowserLiveCardState;
  onOpenTab: (tabId?: number, url?: string) => void;
}

export const BrowserLiveCard = memo(function BrowserLiveCard({
  card,
  onOpenTab,
}: BrowserLiveCardProps) {
  const [expanded, setExpanded] = useState(false);
  const imageSrc = card.shotDataUrl || card.shotUrl || "";

  return (
    <div className="sp-live-wrap">
      {/* 角色头像动作徽章 */}
      <div className="sp-role-badge" data-surface="control">
        <span className="sp-role-avatar">
          {card.botAvatarUrl ? (
            <img src={card.botAvatarUrl} alt={card.botName} />
          ) : (
            card.botName.slice(0, 1)
          )}
        </span>
        <span className="sp-role-name">{card.botName}</span>
        <span className="sp-role-sep">·</span>
        <span className="sp-role-phase">{card.phaseBadge}</span>
      </div>

      {/* 浏览器实时预览大卡 */}
      <article className="sp-live-card" data-surface="bubble">
        <div className="sp-live-head">
          <div className="sp-live-title-group">
            <span className="sp-live-brand">
              <span aria-hidden="true">🌐</span>
              <span>浏览器</span>
            </span>
            <span className="sp-live-step" title={card.stepLabel}>
              {card.stepLabel}
            </span>
          </div>
          {card.steps.length > 0 ? (
            <button
              type="button"
              className="sp-live-toggle"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? "收起步骤" : `${card.steps.length} 步`}
            </button>
          ) : null}
        </div>

        <div className="sp-live-viewport">
          {imageSrc ? (
            <img
              className="sp-live-img"
              src={imageSrc}
              alt={card.tabTitle || "网页实时画面"}
            />
          ) : (
            <div className="sp-live-placeholder">
              <span>
                {card.running ? "正在捕获实时网页画面…" : "网页预览已就绪"}
              </span>
            </div>
          )}
          {card.tabTitle || card.tabUrl ? (
            <div className="sp-live-url-bar" title={card.tabUrl}>
              {card.tabTitle || card.tabUrl}
            </div>
          ) : null}
        </div>

        {expanded && card.steps.length > 0 ? (
          <ol className="sp-live-steps-list" data-surface="inset">
            {card.steps.map((step) => (
              <li key={step.id} className="sp-live-steps-item">
                <span>
                  {step.status === "error"
                    ? "✕"
                    : step.status === "running"
                      ? "◌"
                      : "✓"}
                </span>
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        ) : null}

        <div className="sp-live-foot">
          <button
            type="button"
            className="sp-open-tab-btn"
            data-surface="control"
            onClick={() => onOpenTab(card.tabId, card.tabUrl)}
          >
            打开标签页
          </button>
        </div>
      </article>
    </div>
  );
});
