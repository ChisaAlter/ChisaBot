import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { ConfirmCardView } from "@/components/chat/confirm-card";
import { SmoothCollapse } from "@/components/ui/motion-primitives";
import {
  type ApprovalDecision,
  approvalInboxOptions,
  decideApproval,
} from "@/lib/approvals";
import { DURATION_MS, usePresenceMount, useRetainedValue } from "@/lib/motion";

/**
 * A pending approval, drawn in the conversation where the action it holds would have been.
 *
 * The same request as the Approvals page, read from the same owner-scoped inbox, so a decision made
 * in either place is the one decision. Once decided the server runs the action exactly once and
 * continues the conversation, and this gives the line back to the tool's own renderer.
 */
export function InlineApproval({
  toolCallId,
  fallback,
}: {
  toolCallId?: string;
  fallback: ReactNode;
}) {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const [decidedStatus, setDecidedStatus] = useState<
    "approved" | "denied" | null
  >(null);
  const request = toolCallId
    ? inbox.data?.requests.find(
        (candidate) => candidate.action.toolCallId === toolCallId,
      )
    : undefined;
  const pending = request?.status === "pending";
  const retainedRequest = useRetainedValue(pending ? request : null);
  const cardPresence = usePresenceMount(pending, DURATION_MS.collapse);
  const decision = useMutation({
    mutationFn: (choice: ApprovalDecision) =>
      decideApproval(request?.id ?? "", choice),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const shownRequest = pending ? request : retainedRequest;
  const showingCard = Boolean(
    shownRequest && (pending || (cardPresence.mounted && decidedStatus)),
  );
  if (!showingCard || !shownRequest) return <>{fallback}</>;
  const handOff = shownRequest.action.policy?.behaviour === "hand_off";
  const decide = async (choice: ApprovalDecision) => {
    setDecidedStatus(choice === "deny" ? "denied" : "approved");
    await decision.mutateAsync(choice);
  };
  // 上游审批（云端浏览器的安全规则、规则「先问」等）也用 ChisaBot 的确认卡片外观（DESIGN.md §58）。
  const what = shownRequest.action.toolRef
    .replace(/^computer_|^host\//, "")
    .replaceAll("_", " ");
  const payment = /pay|checkout|purchase|付款|支付|下单/i.test(
    `${shownRequest.action.policy?.reason ?? ""} ${shownRequest.action.scope}`,
  );
  const reason = zhReason(shownRequest.action.policy?.reason);
  return (
    <SmoothCollapse open={pending} unmountOnExit>
      <ConfirmCardView
        approveLabel={handOff ? "我已自己完成" : "确认"}
        denyLabel={handOff ? "不要执行" : "取消"}
        model={{
          category: payment ? "purchase" : "device",
          eyebrow: handOff ? "这一步要你亲自完成" : undefined,
          title: handOff
            ? (reason ?? `${what}：${shownRequest.action.scope}`)
            : `云端浏览器：${what}`,
          target: shownRequest.action.scope,
          details:
            reason && !handOff ? [{ label: "原因", value: reason }] : [],
          status: pending ? "pending" : (decidedStatus ?? "approved"),
        }}
        onApprove={() => decide(handOff ? "handled" : "allow_once")}
        onDeny={() => decide("deny")}
        testId={pending ? "upstream-approval-card" : undefined}
      />
    </SmoothCollapse>
  );
}

/** 上游的英文原因换成中文（界面文字一律简体中文）。 */
function zhReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  if (/pay|purchas|money/i.test(reason)) return "付款、购买、转账要你亲自完成";
  if (/password|passcode|credential|two-factor|recovery/i.test(reason)) return "改密码、验证码等登录凭据要你亲自完成";
  if (/security|sharing|access settings/i.test(reason)) return "改安全、共享或权限设置要你亲自完成";
  if (/rule asks/i.test(reason)) return "你的规则要求先问你";
  if (/review changes/i.test(reason)) return "你设置了改动前先问你";
  if (/[\u4e00-\u9fff]/.test(reason)) return reason;
  return "这一步需要你确认";
}

/**
 * The pending approvals for a group of tool calls, for a transcript that draws those calls itself
 * rather than through each tool's renderer: the browser-activity group folds every click and field
 * into one collapsed line, so a card inside a step would never be seen. Drawn beside the group,
 * outside the fold, one card per waiting call; nothing at all when none is waiting.
 */
export function PendingApprovals({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const inbox = useQuery(approvalInboxOptions());
  const waiting = new Set(
    (inbox.data?.requests ?? [])
      .filter((request) => request.status === "pending")
      .flatMap((request) =>
        request.action.toolCallId ? [request.action.toolCallId] : [],
      ),
  );
  const ids = toolCallIds.filter((id) => waiting.has(id));
  const hasWaiting = ids.length > 0;
  const lastIds = useRef<string[]>([]);
  if (hasWaiting) {
    lastIds.current = ids;
  }
  const presence = usePresenceMount(hasWaiting, DURATION_MS.collapse);
  const shownIds = hasWaiting ? ids : lastIds.current;
  if (!presence.mounted || shownIds.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {shownIds.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}
