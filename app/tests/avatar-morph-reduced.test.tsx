import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";

/** 减少动态效果（DESIGN.md §81）：形象头像不登记变形，循环一帧都不跑。motion 第一次 import 时记下偏好，所以单独一个进程、先设好再加载。 */
let morph: typeof import("@/lib/agents/avatar-morph");
let shapeMod: typeof import("@/components/agents/shape-avatar");
const queue: ((now: number) => void)[] = [];
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  morph = await import("@/lib/agents/avatar-morph");
  shapeMod = await import("@/components/agents/shape-avatar");
  morph.setMorphSchedulerForTests({
    request: (cb) => queue.push(cb),
    cancel: () => {},
  });
});
afterAll(async () => {
  cleanup();
  morph.setMorphSchedulerForTests(null);
  await GlobalRegistrator.unregister();
});

test("reduced motion: a working avatar does not morph and schedules no frames", () => {
  const view = render(
    <shapeMod.ShapeAvatar color="blue" shape="round" size={32} working />,
  );
  expect(morph.morphActiveCount()).toBe(0);
  expect(queue.length).toBe(0);
  expect(
    view.container.querySelector("svg")?.getAttribute("data-morph"),
  ).toBeNull();
});
