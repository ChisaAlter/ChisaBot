import { useSyncExternalStore } from "react";
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
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...options, resolve };
    emit();
  });
}

/** 确认框正开着（别的弹窗据此忽略同一次点击 / Esc）。 */
export function isConfirmOpen(): boolean {
  // 刚关掉的那一下也算：同一次 Esc 可能先关确认框、再传到下面的弹窗。
  return current !== null || Date.now() - settledAt < 150;
}

let settledAt = 0;

function settle(ok: boolean) {
  settledAt = Date.now();
  const pending = current;
  current = null;
  emit();
  pending?.resolve(ok);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => current;

export function ConfirmHost() {
  const pending = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      open={pending !== null}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
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
