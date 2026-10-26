import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  closeTopOverlay,
  openOverlayCount,
  useBackDismiss,
} from "@/lib/overlay-back";

/**
 * 「返回先关抽屉」（CB-098）：打开的抽屉按栈登记，`window.__chisabotBack()` 关最上面那个。
 * 浏览器 popstate / pushState 那一半在真浏览器里量（tests/mobile-portrait/mobile-portrait.mjs）。
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);

function drawer(initial: boolean) {
  const closes: number[] = [];
  const hook = renderHook(
    ({ open }: { open: boolean }) =>
      useBackDismiss(open, () => {
        closes.push(Date.now());
      }),
    { initialProps: { open: initial } },
  );
  return { hook, closes };
}

describe("useBackDismiss / __chisabotBack", () => {
  test("没有打开的抽屉时返回 false", () => {
    expect(closeTopOverlay()).toBe(false);
  });

  test("打开时登记并暴露 window.__chisabotBack，关上后注销", () => {
    const a = drawer(true);
    expect(openOverlayCount()).toBe(1);
    expect(typeof window.__chisabotBack).toBe("function");
    expect(window.__chisabotBack?.()).toBe(true);
    expect(a.closes.length).toBe(1);
    act(() => a.hook.rerender({ open: false }));
    expect(openOverlayCount()).toBe(0);
    expect(window.__chisabotBack?.()).toBe(false);
  });

  test("两个抽屉时先关后打开的那个", () => {
    const left = drawer(true);
    const right = drawer(true);
    expect(closeTopOverlay()).toBe(true);
    expect(right.closes.length).toBe(1);
    expect(left.closes.length).toBe(0);
    act(() => right.hook.rerender({ open: false }));
    expect(closeTopOverlay()).toBe(true);
    expect(left.closes.length).toBe(1);
    act(() => left.hook.rerender({ open: false }));
    expect(openOverlayCount()).toBe(0);
  });

  test("卸载也会注销", () => {
    const a = drawer(true);
    a.hook.unmount();
    expect(openOverlayCount()).toBe(0);
  });
});
