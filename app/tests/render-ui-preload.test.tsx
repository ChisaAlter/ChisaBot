import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, renderHook } from "@testing-library/react";

/** render_ui 渲染面预载：有 render_ui 历史立即，没有就只在浏览器空闲时（不在 RenderUiTool 挂载时）。 */
let mod: typeof import("@/lib/copilot/render-ui-preload");
type IdleCb = () => void;
let idleQueue: IdleCb[] = [];
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  mod = await import("@/lib/copilot/render-ui-preload");
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  idleQueue = [];
  delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
});

function fakeIdle() {
  (window as unknown as { requestIdleCallback: (cb: IdleCb) => number }).requestIdleCallback = (cb) => {
    idleQueue.push(cb);
    return idleQueue.length;
  };
  (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback = (id) => {
    idleQueue[id - 1] = () => {};
  };
}

const renderUiHistory = [
  { role: "user", content: "画个表" },
  { role: "assistant", toolCalls: [{ id: "t1", type: "function", function: { name: "render_ui", arguments: "{}" } }] },
];
const plainHistory = [
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好！", toolCalls: [{ function: { name: "web_fetch" } }] },
];

describe("hasRenderUiCall", () => {
  test("detects render_ui tool calls only", () => {
    expect(mod.hasRenderUiCall(renderUiHistory)).toBe(true);
    expect(mod.hasRenderUiCall(plainHistory)).toBe(false);
    expect(mod.hasRenderUiCall([])).toBe(false);
    expect(mod.hasRenderUiCall(undefined)).toBe(false);
  });
});

describe("useRenderUiPreload", () => {
  test("history with render_ui preloads immediately, without waiting for idle", () => {
    fakeIdle();
    const preload = mock(() => {});
    renderHook(() => mod.useRenderUiPreload(renderUiHistory, preload));
    expect(preload).toHaveBeenCalledTimes(1);
    expect(idleQueue.length).toBe(0);
  });

  test("no render_ui history: nothing on mount, preloads once the browser is idle", () => {
    fakeIdle();
    const preload = mock(() => {});
    renderHook(() => mod.useRenderUiPreload(plainHistory, preload));
    expect(preload).toHaveBeenCalledTimes(0);
    expect(idleQueue.length).toBe(1);
    idleQueue[0]!();
    expect(preload).toHaveBeenCalledTimes(1);
  });

  test("a render_ui card arriving later preloads right away", () => {
    fakeIdle();
    const preload = mock(() => {});
    const { rerender } = renderHook(({ m }) => mod.useRenderUiPreload(m, preload), {
      initialProps: { m: plainHistory as typeof renderUiHistory },
    });
    expect(preload).toHaveBeenCalledTimes(0);
    rerender({ m: renderUiHistory });
    expect(preload).toHaveBeenCalledTimes(1);
  });

  test("unmount before idle cancels the idle preload", () => {
    fakeIdle();
    const preload = mock(() => {});
    const { unmount } = renderHook(() => mod.useRenderUiPreload(plainHistory, preload));
    unmount();
    idleQueue[0]!();
    expect(preload).toHaveBeenCalledTimes(0);
  });

  test("falls back to setTimeout when requestIdleCallback is missing", async () => {
    delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
    const preload = mock(() => {});
    renderHook(() => mod.useRenderUiPreload(plainHistory, preload));
    expect(preload).toHaveBeenCalledTimes(0);
    await new Promise((r) => setTimeout(r, 1700));
    expect(preload).toHaveBeenCalledTimes(1);
  });
});
