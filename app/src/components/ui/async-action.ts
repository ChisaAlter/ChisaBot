import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "@/components/ui/toast";

/**
 * The async-button state machine from DESIGN.md §2:
 *
 *   idle ──click──▶ pending ──ok──▶ success ──1.5s──▶ idle
 *                          └─fail─▶ error   ──2s────▶ idle
 *
 * `Button` draws whichever state it is handed (`state` + `feedback`); these hooks are the two ways
 * a page produces that state — `useMutationFeedback` watches a TanStack mutation, `useAsyncAction`
 * wraps any async handler (clipboard, a mutateAsync chain, a fetch).
 */
export type AsyncState = "idle" | "pending" | "success" | "error";

export type FeedbackLabels = { pending: string; success: string; error: string };

/** Copy for the verbs DESIGN.md names; pass an object for anything else. */
export const FEEDBACK_PRESETS = {
  save: { pending: "保存中…", success: "已保存", error: "保存失败" },
  create: { pending: "创建中…", success: "已创建", error: "创建失败" },
  delete: { pending: "删除中…", success: "已删除", error: "删除失败" },
  send: { pending: "发送中…", success: "已发送", error: "发送失败" },
  copy: { pending: "复制中…", success: "已复制", error: "复制失败" },
  add: { pending: "添加中…", success: "已添加", error: "添加失败" },
  submit: { pending: "提交中…", success: "已提交", error: "提交失败" },
  refresh: { pending: "刷新中…", success: "已刷新", error: "刷新失败" },
  test: { pending: "测试中…", success: "连接正常", error: "测试失败" },
  stop: { pending: "停止中…", success: "已停止", error: "停止失败" },
  cancel: { pending: "取消中…", success: "已取消", error: "取消失败" },
  resume: { pending: "恢复中…", success: "已恢复", error: "恢复失败" },
  reset: { pending: "重置中…", success: "已重置", error: "重置失败" },
  generate: { pending: "生成中…", success: "已生成", error: "生成失败" },
  revoke: { pending: "撤销中…", success: "已撤销", error: "撤销失败" },
  signin: { pending: "登录中…", success: "已登录", error: "登录失败" },
  signout: { pending: "退出中…", success: "已退出", error: "退出失败" },
  generic: { pending: "处理中…", success: "已完成", error: "操作失败" },
} satisfies Record<string, FeedbackLabels>;

export type FeedbackPreset = keyof typeof FEEDBACK_PRESETS;
export type Feedback = FeedbackPreset | FeedbackLabels;

export function resolveFeedback(feedback: Feedback | undefined): FeedbackLabels | null {
  if (!feedback) return null;
  return typeof feedback === "string" ? FEEDBACK_PRESETS[feedback] : feedback;
}

export const MIN_PENDING_MS = 300;
export const SUCCESS_HOLD_MS = 1500;
export const ERROR_HOLD_MS = 2000;

/** The bare machine: `begin()` on start, `settle(ok)` on finish; timing rules live here once. */
export function useFeedbackMachine() {
  const [state, setState] = useState<AsyncState>("idle");
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const clear = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => clear, [clear]);

  const begin = useCallback(() => {
    clear();
    startedAt.current = performance.now();
    setState("pending");
  }, [clear]);

  const settle = useCallback((ok: boolean) => {
    clear();
    const wait = Math.max(0, MIN_PENDING_MS - (performance.now() - startedAt.current));
    timer.current = window.setTimeout(() => {
      setState(ok ? "success" : "error");
      timer.current = window.setTimeout(
        () => setState("idle"),
        ok ? SUCCESS_HOLD_MS : ERROR_HOLD_MS,
      );
    }, wait);
  }, [clear]);

  const reset = useCallback(() => {
    clear();
    setState("idle");
  }, [clear]);

  return { state, begin, settle, reset };
}

export type MutationLike = { status: "idle" | "pending" | "success" | "error"; submittedAt: number };

/**
 * Button state for a TanStack mutation: `<Button state={useMutationFeedback(save)} feedback="save">`.
 * Only a run this hook saw start counts, so a mutation that already settled before mount (or was
 * reset) stays idle. `when` narrows a shared mutation to one row (e.g. `variables?.id === row.id`).
 */
export function useMutationFeedback(mutation: MutationLike, when = true): AsyncState {
  const machine = useFeedbackMachine();
  const watching = useRef(false);
  const { begin, settle, reset } = machine;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => {
    if (mutation.status === "pending") {
      if (when) {
        watching.current = true;
        begin();
      }
      return;
    }
    if (!watching.current) return;
    watching.current = false;
    if (mutation.status === "success") settle(true);
    else if (mutation.status === "error") settle(false);
    else reset();
    // `submittedAt` makes a second run of the same mutation register as a new start.
  }, [mutation.status, mutation.submittedAt, when, begin, settle, reset]);
  return machine.state;
}

type AsyncActionOptions = {
  /** Toast shown on failure. A function gets the thrown error; `false` stays silent. */
  errorToast?: string | ((error: Error) => string) | false;
};

/**
 * Wrap an async handler: `const copy = useAsyncAction(() => navigator.clipboard.writeText(v));`
 * then `<Button state={copy.state} feedback="copy" onClick={() => void copy.run()}>`.
 * Re-entry while pending is ignored. `run` resolves to the handler's value, or `undefined` if it threw.
 */
export function useAsyncAction<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R> | R,
  options: AsyncActionOptions = {},
) {
  const machine = useFeedbackMachine();
  const busy = useRef(false);
  const latest = useRef({ fn, options });
  latest.current = { fn, options };
  const { begin, settle } = machine;

  const run = useCallback(
    async (...args: Args): Promise<R | undefined> => {
      if (busy.current) return undefined;
      busy.current = true;
      begin();
      try {
        const value = await latest.current.fn(...args);
        settle(true);
        return value;
      } catch (thrown) {
        settle(false);
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        const { errorToast } = latest.current.options;
        if (errorToast !== false) {
          toast.error(
            typeof errorToast === "function"
              ? errorToast(error)
              : (errorToast ?? `操作失败：${error.message}`),
          );
        }
        return undefined;
      } finally {
        busy.current = false;
      }
    },
    [begin, settle],
  );

  return { run, state: machine.state, reset: machine.reset };
}
