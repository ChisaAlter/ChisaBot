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

/**
 * CB-098 QA 回归：390 宽在 /channel/new 打开右栏抽屉，切「计算机」再切回「面板」，之后连续返回会死循环。
 * 这里用真实的 history + popstate 模拟那条链路：切标签走 `useBotComputerTab` 的规则（抽屉压着历史时
 * replace），地址回到 `watch=true` 时右栏会想把抽屉拉出来（panel-rail 的 computerOn 效果）。
 */
describe("切标签后连续返回（CB-098 QA）", () => {
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

  test("抽屉里切「计算机」再切回「面板」，最多 2 次返回就离开页面", async () => {
    const { lastHistoryEventWasPop, noteUserIntent, overlayHistoryActive, restampOverlayMarker } = await import(
      "@/lib/overlay-back"
    );
    document.documentElement.setAttribute("data-phone", "");
    try {
      window.history.replaceState({ outside: true }, "", "/before");
      window.history.pushState({ page: true }, "", "/channel/new");

      let open = false;
      let watch = false;
      const rerenders: Array<() => void> = [];
      const hook = renderHook(
        ({ o }: { o: boolean }) =>
          useBackDismiss(o, () => {
            open = false;
            rerenders[0]?.();
          }),
        { initialProps: { o: open } },
      );
      rerenders.push(() => act(() => hook.rerender({ o: open })));
      // 路由：地址的 watch 变化 = 「计算机」开关；回到 watch=true 时右栏想把抽屉拉出来。
      const onPop = () => {
        const nextWatch = new URL(window.location.href).searchParams.get("watch") === "true";
        const was = watch;
        watch = nextWatch;
        if (nextWatch && !was && !lastHistoryEventWasPop() && !open) {
          open = true;
          rerenders[0]?.();
        }
      };
      window.addEventListener("popstate", onPop);
      const writeWatch = (next: boolean) => {
        noteUserIntent();
        watch = next;
        const url = next ? "/channel/new?watch=true" : "/channel/new";
        // 路由的 replace 会换掉 state（不带标记），之后由 restampOverlayMarker 补回。
        if (overlayHistoryActive()) {
          window.history.replaceState({ page: true }, "", url);
          restampOverlayMarker();
        } else window.history.pushState({ page: true }, "", url);
      };

      open = true;
      rerenders[0]?.();
      await tick();
      expect(overlayHistoryActive()).toBe(true);
      writeWatch(true);
      writeWatch(false);

      let backs = 0;
      for (; backs < 10; ) {
        window.history.back();
        backs += 1;
        await tick(50);
        if ((window.history.state as { outside?: boolean } | null)?.outside) break;
      }
      window.removeEventListener("popstate", onPop);
      expect((window.history.state as { outside?: boolean } | null)?.outside).toBe(true);
      expect(backs).toBeLessThanOrEqual(2);
      expect(open).toBe(false);
    } finally {
      document.documentElement.removeAttribute("data-phone");
    }
  });
});

/**
 * CB-098 QA 第二轮：用返回关掉抽屉后马上（150ms / 400ms）又点开，必须照样压记录；
 * 下一次返回先关抽屉、不离开页面。左栏和右栏抽屉都是 useBackDismiss，各跑一遍。
 */
describe("返回关抽屉后立即重开（CB-098 QA 第二轮）", () => {
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
  const outside = () => (window.history.state as { outside?: boolean } | null)?.outside === true;

  for (const side of ["左栏", "右栏"]) {
    for (const delay of [150, 400]) {
      test(`${side}：返回后 ${delay}ms 重开，再返回只关抽屉`, async () => {
        document.documentElement.setAttribute("data-phone", "");
        try {
          window.history.replaceState({ outside: true }, "", "/before");
          window.history.pushState({ page: true }, "", "/channel/new");
          let open = false;
          const hook = renderHook(
            ({ o }: { o: boolean }) =>
              useBackDismiss(o, () => {
                open = false;
                act(() => hook.rerender({ o: false }));
              }),
            { initialProps: { o: false } },
          );
          const userOpen = async () => {
            open = true;
            act(() => hook.rerender({ o: true }));
            await tick();
          };
          await userOpen();
          window.history.back();
          await tick(30);
          expect(open).toBe(false);
          expect(outside()).toBe(false);
          await tick(Math.max(0, delay - 30));
          await userOpen();
          expect(openOverlayCount()).toBe(1);
          window.history.back();
          await tick(50);
          expect(open).toBe(false);
          expect(outside()).toBe(false);
          window.history.back();
          await tick(50);
          expect(outside()).toBe(true);
          hook.unmount();
        } finally {
          document.documentElement.removeAttribute("data-phone");
        }
      });
    }
  }

  test("source=restore 打开不压记录，user 打开压", async () => {
    document.documentElement.setAttribute("data-phone", "");
    try {
      window.history.replaceState({ page: true }, "", "/channel/new");
      const before = window.history.length;
      const r = renderHook(() => useBackDismiss(true, () => {}, "restore"));
      await tick();
      expect(window.history.length).toBe(before);
      r.unmount();
      const u = renderHook(() => useBackDismiss(true, () => {}, "user"));
      await tick();
      expect(window.history.length).toBe(before + 1);
      u.unmount();
    } finally {
      document.documentElement.removeAttribute("data-phone");
    }
  });
});
