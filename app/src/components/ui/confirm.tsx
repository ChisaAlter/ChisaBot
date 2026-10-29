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
  /** 要列给用户看的条目（比如整理记忆将合并的组），描述下面一行一条，太多时可滚动。 */
  items?: readonly string[];
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

function settle(ok: boolean) {
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
        {pending?.items?.length ? (
          <ul className="max-h-56 list-disc space-y-1 overflow-y-auto pl-5 text-sm" data-testid="confirm-items">
            {pending.items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        ) : null}
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
