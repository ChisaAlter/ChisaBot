import { useEffect, useRef, useState } from "react";
import { initialReveal, pending, receive, type RevealState, step } from "./smooth-reveal";

/**
 * 把一路变长的流式文字按帧匀速放出来（规则见 smooth-reveal.ts）。
 *
 *  - 挂载时已有的内容（历史消息）直接显示，不重放；
 *  - 只在有积压时跑 requestAnimationFrame，追平就停，空闲时零开销；
 *  - 标签页在后台、或系统开了「减少动态效果」：立刻整段显示（后台标签页 rAF 本来也不跑，
 *    切回来时不能让人看着它慢慢补）；
 *  - 文字很长时（> LONG_TEXT 字）最多 30 帧/秒重画，Markdown 每帧整段重解析的开销减半。
 */
const LONG_TEXT = 6000;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/*
 * 「减少动态效果」的查询只建一次（审查 01 第 5 条：原来每次渲染、每一帧都 matchMedia 一次）。
 * MediaQueryList.matches 本身是实时的，系统设置改了这里立刻跟着变；换了 matchMedia（测试里会换）才重建。
 */
let reducedMotion: { query: MediaQueryList; from: typeof window.matchMedia } | null = null;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (reducedMotion?.from !== window.matchMedia) {
    reducedMotion = { query: window.matchMedia("(prefers-reduced-motion: reduce)"), from: window.matchMedia };
  }
  return reducedMotion.query.matches;
}

function instantMode(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  return prefersReducedMotion();
}

export function useSmoothText(text: string, enabled = true): string {
  const state = useRef<RevealState | null>(null);
  if (state.current === null) state.current = initialReveal(text, now());
  const [, force] = useState(0);
  const frame = useRef(0);
  const lastPaint = useRef(0);

  if (state.current.target !== text) {
    // 渲染期间同步记下新内容（不触发额外渲染）；放字由下面的帧循环做。
    state.current = !enabled || instantMode() ? initialReveal(text, now()) : receive(state.current, text, now());
  }

  useEffect(() => {
    const s = state.current;
    if (!s || !pending(s) || frame.current) return;
    const tick = () => {
      frame.current = 0;
      const cur = state.current;
      if (!cur) return;
      if (instantMode()) {
        state.current = initialReveal(cur.target, now());
        force((n) => n + 1);
        return;
      }
      const t = now();
      if (cur.target.length > LONG_TEXT && t - lastPaint.current < 32) {
        frame.current = requestAnimationFrame(tick);
        return;
      }
      const next = step(cur, t);
      state.current = next;
      if (next.cut !== cur.cut) {
        lastPaint.current = t;
        force((n) => n + 1);
      }
      if (pending(next)) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  });

  useEffect(() => {
    const flush = () => {
      const cur = state.current;
      if (cur && pending(cur) && instantMode()) {
        state.current = initialReveal(cur.target, now());
        force((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  const s = state.current;
  return s.cut >= s.target.length ? s.target : s.target.slice(0, s.cut);
}
