import { useQuery } from "@tanstack/react-query";
import { approvalInboxOptions } from "@/lib/approvals";
import { recentConfirmationsQueryOptions } from "@/lib/confirmations";
import { useKeptVisibility } from "@/lib/kept-visible";

export type PendingApprovalsSlice = {
  requests?: readonly { status: string }[] | null;
  questions?: readonly unknown[] | null;
};

export type PendingConfirmSlice = readonly { status: string }[];

/**
 * 汇总「待处理」角标数量：未处理审批请求 + 待回答问题 + 待点确认卡片（DESIGN.md §71.1）。
 */
export function countPendingActions(
  approvals?: PendingApprovalsSlice | null,
  confirms?: PendingConfirmSlice | null,
): number {
  const requests = Array.isArray(approvals?.requests)
    ? approvals.requests.filter((r) => r.status === "pending").length
    : 0;
  const questions = Array.isArray(approvals?.questions)
    ? approvals.questions.length
    : 0;
  const pendingConfirms = Array.isArray(confirms)
    ? confirms.filter((r) => r.status === "pending").length
    : 0;
  return requests + questions + pendingConfirms;
}

/**
 * 订阅审批收件箱与近期确认卡片，返回当前待处理总数。
 */
export function usePendingActionCount(): number {
  const visibility = useKeptVisibility();
  const approvals = useQuery(
    approvalInboxOptions({ poll: () => visibility.get() }),
  );
  const confirms = useQuery(
    recentConfirmationsQueryOptions({ poll: () => visibility.get() }),
  );
  return countPendingActions(approvals.data, confirms.data);
}
