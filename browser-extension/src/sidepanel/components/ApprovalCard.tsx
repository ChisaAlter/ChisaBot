import { useState } from "react";
import type { PendingApprovalItem } from "../../types/protocol";

interface ApprovalCardProps {
  item: PendingApprovalItem;
  onDecide: (id: string, decision: "approve" | "deny") => Promise<void>;
}

export function ApprovalCard({ item, onDecide }: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);

  async function handle(decision: "approve" | "deny") {
    setSubmitting(decision);
    try {
      await onDecide(item.id, decision);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section
      className="sp-approval-card"
      data-surface="bubble"
      data-locked={item.locked === true}
      aria-label="敏感操作确认"
    >
      <div className="sp-approval-head">
        <span>
          {item.botName ? `${item.botName} 请求确认` : "请求确认浏览器操作"}
        </span>
        <span className="sp-approval-tag">
          {item.locked ? "付款 / 资金锁" : "敏感操作"}
        </span>
      </div>
      <p className="sp-approval-summary">{item.summary}</p>
      <div className="sp-approval-actions">
        <button
          type="button"
          className="sp-btn sp-btn-primary sp-btn-sm"
          disabled={submitting !== null}
          onClick={() => void handle("approve")}
          style={{ flex: 1 }}
        >
          {submitting === "approve" ? "已发送…" : "批准执行"}
        </button>
        <button
          type="button"
          className="sp-btn sp-btn-danger sp-btn-sm"
          disabled={submitting !== null}
          onClick={() => void handle("deny")}
          style={{ flex: 1 }}
        >
          {submitting === "deny" ? "已发送…" : "拒绝"}
        </button>
      </div>
    </section>
  );
}
