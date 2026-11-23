import { useRef, useSyncExternalStore } from "react";
import { useExternalConnection, useWindowEvent } from "@/hooks";
import { createPortal } from "react-dom";

import { MIN_PENDING_MS } from "@/components/ui/async-action";
import { Button, StatusGlyph } from "@/components/ui/button";

/**
 * Full-page glass loader — DESIGN.md §1 tier ③, for big or blocking work only (reset, import,
 * bulk delete, deploy-like). Everything smaller uses the button's own state.
 *
 *   await runWithPageLoader({ title: "正在重置…", steps: ["清理数据", "重建"] }, async (ctl) => {
 *     ctl.step(1);
 *     return doIt();
 *   });
 *
 * Success shows ✓ + `successText` in the card, then fades and resolves. Failure keeps the card
 * open with ✕, the reason and 重试 / 关闭: 重试 re-runs `fn`, 关闭 rejects with the error.
 * Mounted once at the root as `<PageLoaderHost />`.
 */
export type PageLoaderOptions = {
  title: string;
  description?: string;
  steps?: string[];
  successText?: string;
  /** Title shown under ✕; defaults to "操作失败". */
  errorTitle?: string;
  /** Turn a thrown error into the sentence shown under ✕. */
  errorText?: (error: Error) => string;
};

export type PageLoaderControl = {
  step: (index: number) => void;
  progress: (fraction: number) => void;
  describe: (text: string) => void;
};

type LoaderView = {
  phase: "pending" | "success" | "error";
  title: string;
  description?: string;
  steps?: string[];
  step: number;
  progress?: number;
  message?: string;
  errorTitle?: string;
  leaving?: boolean;
  onRetry?: () => void;
  onClose?: () => void;
};

let view: LoaderView | null = null;
const listeners = new Set<() => void>();
const set = (next: LoaderView | null) => {
  view = next;
  for (const listener of listeners) listener();
};
const patch = (partial: Partial<LoaderView>) => {
  if (view) set({ ...view, ...partial });
};
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

let running = false;

export function isPageLoaderOpen() {
  return running;
}

export function runWithPageLoader<T>(
  options: string | PageLoaderOptions,
  fn: (control: PageLoaderControl) => Promise<T>,
): Promise<T> {
  const opts = typeof options === "string" ? { title: options } : options;
  if (running) return Promise.reject(new Error("另一个操作正在进行中"));
  running = true;

  const control: PageLoaderControl = {
    step: (index) => patch({ step: index }),
    progress: (fraction) => patch({ progress: Math.max(0, Math.min(1, fraction)) }),
    describe: (text) => patch({ description: text }),
  };

  return new Promise<T>((resolve, reject) => {
    const attempt = async () => {
      set({
        phase: "pending",
        title: opts.title,
        description: opts.description,
        steps: opts.steps,
        step: 0,
      });
      const started = performance.now();
      try {
        const value = await fn(control);
        await sleep(Math.max(0, MIN_PENDING_MS + 100 - (performance.now() - started)));
        patch({
          phase: "success",
          title: opts.successText ?? "已完成",
          step: opts.steps?.length ?? 0,
          progress: view?.progress === undefined ? undefined : 1,
        });
        await sleep(1200);
        patch({ leaving: true });
        await sleep(220);
        set(null);
        running = false;
        resolve(value);
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        await sleep(Math.max(0, MIN_PENDING_MS - (performance.now() - started)));
        patch({
          phase: "error",
          errorTitle: opts.errorTitle ?? "操作失败",
          message: opts.errorText?.(error) ?? error.message,
          onRetry: () => void attempt(),
          onClose: () => {
            patch({ leaving: true });
            window.setTimeout(() => {
              set(null);
              running = false;
              reject(error);
            }, 220);
          },
        });
      }
    };
    void attempt();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => view;

export function PageLoaderHost() {
  const current = useSyncExternalStore(subscribe, snapshot, () => null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const open = current !== null;
  const phase = current?.phase;

  // Focus lands in the card while it is up, on 重试 once there is something to press, and the
  // page behind is inert so Tab cannot wander under the overlay.
  useExternalConnection(open, () => {
    const root = document.getElementById("root") ?? document.body.firstElementChild;
    const previous = document.activeElement as HTMLElement | null;
    root?.setAttribute("inert", "");
    return () => {
      root?.removeAttribute("inert");
      previous?.focus?.();
    };
  });
  useExternalConnection(phase || false, (activePhase) => {
    if (activePhase === "error") retryRef.current?.focus();
    else cardRef.current?.focus();
  });
  useWindowEvent(
    "keydown",
    phase === "error"
      ? (event) => {
          if (event.key === "Escape") view?.onClose?.();
        }
      : null,
  );

  if (!current) return null;
  const steps = current.steps ?? [];
  return createPortal(
    <div className="page-loader-overlay" data-leaving={current.leaving ? "true" : undefined}>
      <div
        aria-busy={current.phase === "pending" || undefined}
        aria-labelledby="page-loader-title"
        aria-modal="true"
        className="page-loader-card"
        data-btn-state={current.phase}
        data-surface="elevated"
        ref={cardRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <div className="page-loader-glyph">
          <StatusGlyph />
        </div>
        <div className="page-loader-title" id="page-loader-title" role="status">
          {current.phase === "error" ? current.errorTitle : current.title}
        </div>
        {current.phase === "error" ? (
          <div className="page-loader-desc">{current.message || "出了点问题，请重试。"}</div>
        ) : current.description && current.phase === "pending" ? (
          <div className="page-loader-desc">{current.description}</div>
        ) : null}
        {current.progress !== undefined && current.phase !== "error" ? (
          <div className="page-loader-progress">
            <i style={{ width: `${Math.round(current.progress * 100)}%` }} />
          </div>
        ) : null}
        {steps.length > 0 && current.phase !== "error" ? (
          <ol className="page-loader-steps">
            {steps.map((label, index) => (
              <li
                data-step={index < current.step ? "done" : index === current.step ? "active" : "todo"}
                key={label}
              >
                <b />
                {label}
              </li>
            ))}
          </ol>
        ) : null}
        {current.phase === "error" ? (
          <div className="page-loader-actions">
            <Button onClick={() => current.onClose?.()} variant="outline">
              {"关闭"}
            </Button>
            <Button onClick={() => current.onRetry?.()} ref={retryRef}>
              {"重试"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
