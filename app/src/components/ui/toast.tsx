import {
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import { useSyncExternalStore } from "react";

/**
 * A small glass toast stack. Module-level so any handler can say "已保存" without threading a
 * context through; `<Toaster />` is mounted once at the root.
 */
type ToastKind = "success" | "error" | "info";
type ToastAction = { label: string; onClick: () => void };
type ToastItem = { id: number; kind: ToastKind; text: string; leaving?: boolean; action?: ToastAction };

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function dismiss(id: number) {
  items = items.map((item) => (item.id === id ? { ...item, leaving: true } : item));
  emit();
  window.setTimeout(() => {
    items = items.filter((item) => item.id !== id);
    emit();
  }, 180);
}

function push(kind: ToastKind, text: string, duration = kind === "error" ? 5200 : 2600, action?: ToastAction) {
  const id = nextId++;
  // Same sentence twice in a row is one toast, not a stack of identical ones. 带按钮的提示（撤销等）
  // 每条各自对应一次操作，不参与文案去重，也不会被挤掉——否则还在倒计时的删除就没法撤销了。
  const kept = action ? items : items.filter((item) => item.action || item.text !== text);
  const next = [...kept, { id, kind, text, action }];
  const plain = next.filter((item) => !item.action);
  const dropPlain = new Set(plain.slice(0, Math.max(0, plain.length - 4)).map((item) => item.id));
  items = next.filter((item) => !dropPlain.has(item.id));
  emit();
  // duration 为 Infinity：不自动消失，由调用方 dismiss（合并的「全部撤销」提示，CB-111）。
  if (Number.isFinite(duration)) window.setTimeout(() => dismiss(id), duration);
  return id;
}

/** 改一条还在的提示的文案（合并提示里的条数变化，CB-111）。 */
function update(id: number, text: string) {
  if (!items.some((item) => item.id === id)) return;
  items = items.map((item) => (item.id === id ? { ...item, text } : item));
  emit();
}

/** 这条提示还在屏幕上（没关、没在退场）。 */
function isOpen(id: number) {
  return items.some((item) => item.id === id && !item.leaving);
}

export const toast = {
  success: (text: string) => push("success", text),
  error: (text: string) => push("error", text),
  info: (text: string) => push("info", text),
  /**
   * 撤销型提示（DESIGN.md §34.6）：删除等操作先在界面上完成，再给一个带「撤销」的提示，默认 8 秒。
   * 不往列表里插一张「已删除」卡片——那会把下面的内容整体挤下去。
   */
  undo: (text: string, onUndo: () => void, duration = 8000) => {
    let id = 0;
    id = push("info", text, duration, {
      label: "撤销",
      onClick: () => {
        dismiss(id);
        onUndo();
      },
    });
    return id;
  },
  /** 带一个按钮的提示（定时任务结果的「查看」，DESIGN.md §55）。 */
  action: (text: string, label: string, onClick: () => void, duration = 8000) => {
    let id = 0;
    id = push("info", text, duration, {
      label,
      onClick: () => {
        dismiss(id);
        onClick();
      },
    });
    return id;
  },
  dismiss,
  update,
  isOpen,
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => items;

const ICONS = {
  success: IconCircleCheck,
  error: IconAlertTriangle,
  info: IconInfoCircle,
} as const;

export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div aria-live="polite" className="glass-toaster" role="region" aria-label={"通知"}>
      {list.map((item) => {
        const Icon = ICONS[item.kind];
        return (
          <div
            className="glass-toast"
            data-kind={item.kind}
            data-leaving={item.leaving ? "true" : undefined}
            key={item.id}
            role={item.kind === "error" ? "alert" : "status"}
          >
            <Icon className="glass-toast-icon size-4 shrink-0" />
            <span className="min-w-0 flex-1">{item.text}</span>
            {item.action ? (
              <button className="glass-toast-action" onClick={item.action.onClick} type="button">
                {item.action.label}
              </button>
            ) : null}
            <button
              aria-label={"关闭通知"}
              className="glass-toast-close"
              onClick={() => dismiss(item.id)}
              type="button"
            >
              <IconX className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
