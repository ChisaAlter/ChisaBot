import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * `confirmDialog()` is the glass replacement for `window.confirm`: same promise-of-a-boolean shape,
 * drawn with the app's own Dialog so it gets the focus trap, Esc, click-outside and the theme.
 */
type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};
type Pending = ConfirmOptions & {
  resolve: (ok: boolean) => void;
  /** 打开确认框前有焦点的元素（通常是正在编辑的输入框），关掉后焦点还回去。 */
  returnFocus: HTMLElement | null;
};

let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    const active =
      typeof document === "undefined" ? null : document.activeElement;
    // 连着弹第二个确认框时，焦点该回到最早那个输入框，而不是上一个确认框里的按钮。
    const returnFocus =
      current?.returnFocus ??
      (active instanceof HTMLElement && active !== document.body
        ? active
        : null);
    current = { ...options, resolve, returnFocus };
    emit();
  });
}

/** 确认框正开着（别的弹窗据此忽略同一次点击）。Esc 由 ConfirmHost 在捕获阶段吃掉，不会传到下面的弹窗。 */
export function isConfirmOpen(): boolean {
  return current !== null;
}

function settle(ok: boolean) {
  const pending = current;
  current = null;
  emit();
  pending?.resolve(ok);
}

/** 关掉后把焦点还给原来的元素；它已经不在页面上（或被禁用）时交给 Base UI 的默认行为。 */
export function returnFocusTarget(
  pending: Pick<Pending, "returnFocus"> | null,
): HTMLElement | null {
  const el = pending?.returnFocus ?? null;
  if (!el?.isConnected) return null;
  if ((el as HTMLInputElement).disabled) return null;
  return el;
}

/**
 * 确认框开着时，Esc 在 window 捕获阶段就处理并停止传播：只关确认框，
 * 下面的弹窗（它在 document 上监听）收不到这次 Esc，不会跟着关。
 */
export function consumeConfirmEscape(event: KeyboardEvent): boolean {
  if (current === null || event.key !== "Escape" || event.isComposing)
    return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  settle(false);
  return true;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => current;

const stopBubble = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

function useLastPending(pending: Pending | null): Pending | null {
  const ref = useRef<Pending | null>(null);
  if (pending) ref.current = pending;
  return ref.current;
}

export function ConfirmHost() {
  const pending = useSyncExternalStore(subscribe, snapshot, snapshot);
  const open = pending !== null;
  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", consumeConfirmEscape, true);
    return () =>
      window.removeEventListener("keydown", consumeConfirmEscape, true);
  }, [open]);
  // 关闭动画期间 pending 已经是 null，所以记住最后一个。
  const last = useLastPending(pending);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      open={open}
    >
      <DialogContent
        className="max-w-sm"
        finalFocus={() => returnFocusTarget(last) ?? true}
        /* 点确认框里的按钮不往 document 冒泡：下面弹窗的「点外面关闭」收不到这次点击。 */
        onClick={stopBubble}
        onMouseDown={stopBubble}
        onPointerDown={stopBubble}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{pending?.title ?? ""}</DialogTitle>
          {pending?.description ? (
            <DialogDescription>{pending.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => settle(false)} variant="outline">
            {pending?.cancelLabel ?? "取消"}
          </Button>
          <Button
            autoFocus
            onClick={() => settle(true)}
            variant={pending?.destructive ? "destructive" : "default"}
          >
            {pending?.confirmLabel ?? "确定"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
