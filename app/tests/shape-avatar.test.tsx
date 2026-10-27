import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { SHAPES, shapePath } from "@/lib/agents/avatar-shapes";

/** 形象头像的表情（DESIGN.md §81）：在跑 > 刚做完 > 被选中 > 待机。 */
// motion 在第一次 import 时就看环境里有没有 requestAnimationFrame：所以先注册 DOM，再动态引入组件。
let mod: typeof import("@/components/agents/shape-avatar");
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  mod = await import("@/components/agents/shape-avatar");
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("useShapeMood", () => {
  test("idle by default, selected when selected", () => {
    expect(renderHook(() => mod.useShapeMood(false, false)).result.current).toBe("idle");
    expect(renderHook(() => mod.useShapeMood(true, false)).result.current).toBe("selected");
  });

  test("working wins over selected", () => {
    expect(renderHook(() => mod.useShapeMood(true, true)).result.current).toBe("working");
  });

  test("finishing a run shows done for a moment, then falls back to the resting mood", async () => {
    const hook = renderHook(({ selected, working }) => mod.useShapeMood(selected, working, 40), { initialProps: { selected: true, working: true } });
    expect(hook.result.current).toBe("working");
    hook.rerender({ selected: true, working: false });
    expect(hook.result.current).toBe("done");
    await act(async () => {
      await wait(80);
    });
    expect(hook.result.current).toBe("selected");
  });

  test("a bot that was never running does not flash done, and starting again cancels it", async () => {
    const hook = renderHook(({ working }) => mod.useShapeMood(false, working, 40), { initialProps: { working: false } });
    hook.rerender({ working: false });
    expect(hook.result.current).toBe("idle");
    hook.rerender({ working: true });
    hook.rerender({ working: false });
    expect(hook.result.current).toBe("done");
    hook.rerender({ working: true });
    expect(hook.result.current).toBe("working");
    await act(async () => {
      await wait(80);
    });
    expect(hook.result.current).toBe("working");
  });
});

describe("ShapeAvatar", () => {
  test("draws the chosen shape and colour and exposes the mood for CSS", () => {
    const { container, rerender } = render(<mod.ShapeAvatar color="blue" shape="pill" size={40} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("data-mood")).toBe("idle");
    expect(svg.getAttribute("data-color")).toBe("blue");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("width")).toBe("40");
    expect(svg.style.getPropertyValue("--sa-fill")).toBe("#2188ff");
    rerender(<mod.ShapeAvatar color="blue" selected shape="pill" size={40} />);
    expect(container.querySelector("svg")!.getAttribute("data-mood")).toBe("selected");
  });

  test("changing the shape morphs the path and ends exactly on the target", async () => {
    const { container, rerender } = render(<mod.ShapeAvatar color="violet" shape="round" size={64} />);
    const before = container.querySelector("path")!.getAttribute("d");
    rerender(<mod.ShapeAvatar color="violet" shape="tile" size={64} />);
    await act(async () => {
      await wait(1500);
    });
    const after = container.querySelector("path")!.getAttribute("d");
    expect(after).not.toBe(before);
    expect(after).toBe(shapePath(SHAPES.tile));
  });
});