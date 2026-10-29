import { useBlocker } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { confirmDialog, isConfirmOpen } from "@/components/ui/confirm";
import { DISCARD_CONFIRM, LEAVE_CONFIRM, shouldConfirmDismiss } from "@/lib/unsaved";

/**
 * 页面级未保存拦截（DESIGN.md §11 未保存栏的另一半）：SaveBar 显示时，
 * 点左栏别的页、浏览器后退先弹确认；刷新、关标签交给浏览器自己的 beforeunload 提示。
 */
export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useBlocker({
    shouldBlockFn: async () => {
      if (!dirtyRef.current) return false;
      const leave = await confirmDialog(LEAVE_CONFIRM);
      return !leave;
    },
    enableBeforeUnload: () => dirtyRef.current,
  });
}

type OpenChangeDetails = { reason?: string } | undefined;

/**
 * 弹窗级拦截：有改动时按 Esc、点遮罩、点右上角关闭先确认；「取消」按钮直接关。
 * 确认框自己开着时（它和弹窗是两个 Dialog）忽略弹窗收到的关闭事件，免得点确认框被当成「点了外面」。
 */
export function useGuardedOpenChange(dirty: boolean, onOpenChange: (open: boolean) => void) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  return useCallback(
    (open: boolean, details?: OpenChangeDetails) => {
      if (open) return onOpenChange(true);
      if (isConfirmOpen()) return;
      if (!shouldConfirmDismiss(dirtyRef.current, details?.reason)) return onOpenChange(false);
      void confirmDialog(DISCARD_CONFIRM).then((discard) => {
        if (discard) onOpenChange(false);
      });
    },
    [onOpenChange],
  );
}
