import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { SHAPES, shapePath } from "@/lib/agents/avatar-shapes";

/**
 * 性能模式下形象头像只留静态形状（DESIGN.md §81、§10.3.1）：
 * - JS：不登记变形（avatar-morph 的全局 rAF 一帧都不排），换形状也不起 motion 的弹簧（不碰 requestAnimationFrame）；
 * - CSS：html[data-perf="on"] 下 .sa 的表情动画和过渡全停（规则在顶层、优先级压过所有 .sa 表情规则、不用 !important）；
 * - 关掉性能模式就恢复原来的变形。
 * motion 第一次 import 时记下 requestAnimationFrame，所以单独一个进程，先装好计数再加载组件。
 */
let morph: typeof import("@/lib/agents/avatar-morph");
let shapeMod: typeof import("@/components/agents/shape-avatar");
let perf: typeof import("@/lib/perf-mode");
const morphQueue: ((now: number) => void)[] = [];
let rafCalls = 0;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // motion 的帧循环走全局 requestAnimationFrame：只计数，不推进。
  window.requestAnimationFrame = (() => {
    rafCalls++;
    return rafCalls;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = () => {};
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  morph = await import("@/lib/agents/avatar-morph");
  shapeMod = await import("@/components/agents/shape-avatar");
  perf = await import("@/lib/perf-mode");
  morph.setMorphSchedulerForTests({
    request: (cb) => morphQueue.push(cb),
    cancel: () => {},
  });
});
afterAll(async () => {
  cleanup();
  perf.setPerfMode(false);
  morph.setMorphSchedulerForTests(null);
  await GlobalRegistrator.unregister();
});

describe("performance mode: JS", () => {
  test("on: no morph, no frames, shape change paints at once without a spring; off restores; on again stops", () => {
    perf.setPerfMode(true);
    expect(document.documentElement.getAttribute("data-perf")).toBe("on");
    const view = render(
      <shapeMod.ShapeAvatar
        color="blue"
        selected
        shape="round"
        size={32}
        thinking
        working
      />,
    );
    const svg = () => view.container.querySelector("svg");
    const d = () => view.container.querySelector("path")?.getAttribute("d");
    expect(svg()?.getAttribute("data-morph")).toBeNull();
    expect(morph.morphActiveCount()).toBe(0);
    expect(morph.morphLoopRunning()).toBe(false);
    expect(morphQueue.length).toBe(0);

    const before = rafCalls;
    view.rerender(
      <shapeMod.ShapeAvatar color="blue" shape="bean" size={32} working />,
    );
    expect(d()).toBe(shapePath(SHAPES.bean));
    expect(rafCalls).toBe(before);
    expect(morphQueue.length).toBe(0);

    // 关掉：恢复原来的变形，循环排上帧。
    act(() => perf.setPerfMode(false));
    expect(svg()?.getAttribute("data-morph")).toBe("on");
    expect(morph.morphActiveCount()).toBe(1);
    expect(morph.morphLoopRunning()).toBe(true);
    expect(morphQueue.length).toBeGreaterThan(0);
    // 换形状又走弹簧（motion 请求了帧）。
    const springBefore = rafCalls;
    view.rerender(
      <shapeMod.ShapeAvatar color="blue" shape="round" size={32} working />,
    );
    expect(rafCalls).toBeGreaterThan(springBefore);

    // 再打开：立刻摘掉变形、循环停、画回自己的形状。
    act(() => perf.setPerfMode(true));
    expect(svg()?.getAttribute("data-morph")).toBeNull();
    expect(morph.morphActiveCount()).toBe(0);
    expect(morph.morphLoopRunning()).toBe(false);
    view.unmount();
  });
});

describe("performance mode: CSS", () => {
  const css = readFileSync(
    path.join(import.meta.dir, "../src/styles.css"),
    "utf8",
  ).replace(
    // 注释换成空白；字符串原样留着（@source "…/dist/*.js" 里的 /* 不是注释）。
    /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\//g,
    (token) => (token.startsWith("/*") ? token.replace(/[^\n]/g, " ") : token),
  );
  const PERF_RULE =
    'html[data-perf="on"] svg.sa :is(.sa-body, .sa-eyes, .sa-open, .sa-happy)';

  /** 顶层（不在 @media / @supports 里）的规则：选择器 → 声明。 */
  function topLevelRules() {
    const out: { selector: string; body: string }[] = [];
    let depth = 0;
    let start = 0;
    let selector = "";
    for (let i = 0; i < css.length; i++) {
      const ch = css[i];
      if (ch === '"' || ch === "'") {
        const end = css.indexOf(ch, i + 1);
        i = end < 0 ? i : end;
      } else if (ch === "{") {
        if (depth === 0) selector = css.slice(start, i).trim();
        depth++;
        start = i + 1;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) out.push({ selector, body: css.slice(start, i) });
        start = i + 1;
      }
    }
    expect(depth).toBe(0);
    return out;
  }

  /** 很粗的优先级 [id, 类 / 属性 / 伪类, 元素]；:is(…) 里都是单个类，按 1 个类算。 */
  function specificity(selector: string): [number, number, number] {
    let isParts = 0;
    const rest = selector.replace(/:is\([^)]*\)/g, () => {
      isParts++;
      return "";
    });
    const ids = (rest.match(/#[\w-]+/g) ?? []).length;
    const classes =
      (rest.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length + isParts;
    const elements = (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
    return [ids, classes, elements];
  }
  const beats = (a: number[], b: number[]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

  test("a top-level rule stops every avatar animation and transition, without !important", () => {
    const rule = topLevelRules().find((r) => r.selector === PERF_RULE);
    expect(rule).toBeDefined();
    expect(rule?.body).toMatch(/animation:\s*none;/);
    expect(rule?.body).toMatch(/transition:\s*none;/);
    expect(rule?.body).not.toContain("!important");
  });

  test("it outranks every .sa expression rule that animates or transitions", () => {
    // 先确认这条规则真的在 styles.css 顶层：没有它时下面的优先级比较只是在比一个常量字符串，旧样式也会过。
    expect(topLevelRules().some((r) => r.selector === PERF_RULE)).toBe(true);
    const perfSpec = specificity(PERF_RULE);
    expect(perfSpec).toEqual([0, 3, 2]);
    const animated = topLevelRules().filter(
      (r) =>
        r.selector !== PERF_RULE &&
        /^\.sa\b/.test(r.selector) &&
        /animation|transition/.test(r.body),
    );
    expect(animated.length).toBeGreaterThanOrEqual(5);
    for (const r of animated)
      for (const sel of r.selector.split(",")) {
        expect({
          sel: sel.trim(),
          beats: beats(perfSpec, specificity(sel.trim())),
        }).toEqual({ sel: sel.trim(), beats: true });
      }
  });
});
