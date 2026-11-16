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
import { useRef } from "react";

let hooks: typeof import("@/hooks");

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  hooks = await import("@/hooks");
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const restoreHooks: (() => void)[] = [];

afterEach(() => {
  cleanup();
  while (restoreHooks.length > 0) {
    restoreHooks.pop()?.();
  }
});

describe("app/src/hooks 外部同步原语", () => {
  test("useWindowEvent / useDocumentEvent / useElementEvent 按激活状态绑解并在回调变更时不丢新闭包", () => {
    const windowCalls: number[] = [];
    const docCalls: number[] = [];
    const div = document.createElement("div");
    const elemCalls: number[] = [];

    const { rerender, unmount } = renderHook(
      ({ factor, active }: { factor: number; active: boolean }) => {
        const ref = useRef<HTMLDivElement | null>(div);
        hooks.useWindowEvent(
          "custom:ping",
          active ? () => windowCalls.push(factor) : null,
        );
        hooks.useDocumentEvent(
          "custom:doc",
          active ? () => docCalls.push(factor * 2) : null,
        );
        hooks.useElementEvent(
          ref,
          "custom:el",
          active ? () => elemCalls.push(factor * 3) : null,
        );
      },
      { initialProps: { factor: 1, active: true } },
    );

    window.dispatchEvent(new Event("custom:ping"));
    document.dispatchEvent(new Event("custom:doc"));
    div.dispatchEvent(new Event("custom:el"));
    expect(windowCalls).toEqual([1]);
    expect(docCalls).toEqual([2]);
    expect(elemCalls).toEqual([3]);

    rerender({ factor: 5, active: true });
    window.dispatchEvent(new Event("custom:ping"));
    expect(windowCalls).toEqual([1, 5]);

    rerender({ factor: 5, active: false });
    window.dispatchEvent(new Event("custom:ping"));
    document.dispatchEvent(new Event("custom:doc"));
    div.dispatchEvent(new Event("custom:el"));
    expect(windowCalls).toEqual([1, 5]);
    expect(docCalls).toEqual([2]);
    expect(elemCalls).toEqual([3]);

    unmount();
  });

  test("useTimeout 与 useInterval 支持暂停与 resetKey 重新计时并在卸载时清理", async () => {
    let timeouts = 0;
    let intervals = 0;
    const { rerender, unmount } = renderHook(
      ({ delay, epoch }: { delay: number | null; epoch: number }) => {
        hooks.useTimeout(
          () => {
            timeouts++;
          },
          delay,
          epoch,
        );
        hooks.useInterval(
          () => {
            intervals++;
          },
          delay,
          epoch,
        );
      },
      {
        initialProps: { delay: 15, epoch: 1 } as {
          delay: number | null;
          epoch: number;
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(timeouts).toBe(1);
    expect(intervals).toBeGreaterThanOrEqual(2);

    rerender({ delay: 15, epoch: 2 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(timeouts).toBe(2);

    rerender({ delay: null, epoch: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterPause = intervals;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(intervals).toBe(afterPause);

    unmount();
  });

  test("useAnimationFrame / useIdleTask 在 active 变更与卸载时取消调度", () => {
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCancelRaf = globalThis.cancelAnimationFrame;
    const prevIdle = (globalThis as { requestIdleCallback?: unknown })
      .requestIdleCallback;
    const prevCancelIdle = (globalThis as { cancelIdleCallback?: unknown })
      .cancelIdleCallback;

    const rafQueue = new Map<number, (t: number) => void>();
    const idleQueue = new Map<number, () => void>();
    let nextId = 1;
    globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
      const id = nextId++;
      rafQueue.set(id, cb);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (id: number) => {
      rafQueue.delete(id);
    };
    (
      globalThis as { requestIdleCallback?: (cb: () => void) => number }
    ).requestIdleCallback = (cb) => {
      const id = nextId++;
      idleQueue.set(id, cb);
      return id;
    };
    (
      globalThis as { cancelIdleCallback?: (id: number) => void }
    ).cancelIdleCallback = (id) => {
      idleQueue.delete(id);
    };
    restoreHooks.push(() => {
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCancelRaf;
      (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback =
        prevIdle;
      (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback =
        prevCancelIdle;
    });

    const frames: number[] = [];
    let idles = 0;
    const { rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) => {
        hooks.useAnimationFrame((t) => frames.push(t), active);
        hooks.useIdleTask(() => {
          idles++;
        }, active);
      },
      { initialProps: { active: true } },
    );

    expect(rafQueue.size).toBe(1);
    expect(idleQueue.size).toBe(1);
    const firstRaf = [...rafQueue.entries()][0];
    if (firstRaf) {
      rafQueue.delete(firstRaf[0]);
      firstRaf[1](16);
    }
    const firstIdle = [...idleQueue.entries()][0];
    if (firstIdle) {
      idleQueue.delete(firstIdle[0]);
      firstIdle[1]();
    }
    expect(frames).toEqual([16]);
    expect(idles).toBe(1);

    rerender({ active: false });
    expect(rafQueue.size).toBe(0);
    unmount();
  });

  test("useResizeObserver / useIntersectionObserver / useMutationObserver 连接并在卸载时断开", () => {
    const prevResize = globalThis.ResizeObserver;
    const prevIntersect = globalThis.IntersectionObserver;
    let resizeDisconnected = 0;
    let intersectDisconnected = 0;
    let resizeCb: ResizeObserverCallback | null = null;
    let intersectCb: IntersectionObserverCallback | null = null;

    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        resizeCb = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeDisconnected++;
      }
    } as unknown as typeof ResizeObserver;

    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) {
        intersectCb = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        intersectDisconnected++;
      }
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    } as unknown as typeof IntersectionObserver;

    restoreHooks.push(() => {
      globalThis.ResizeObserver = prevResize;
      globalThis.IntersectionObserver = prevIntersect;
    });

    const el = document.createElement("div");
    let resized = 0;
    let intersected = 0;
    const { unmount } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(el);
      hooks.useResizeObserver(ref, () => {
        resized++;
      });
      hooks.useIntersectionObserver(ref, () => {
        intersected++;
      });
    });

    (resizeCb as ResizeObserverCallback | null)?.(
      [{ target: el } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    (intersectCb as IntersectionObserverCallback | null)?.(
      [{ target: el } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(resized).toBe(1);
    expect(intersected).toBe(1);

    unmount();
    expect(resizeDisconnected).toBe(1);
    expect(intersectDisconnected).toBe(1);
  });

  test("useAutoFocus / useElementSync / useDocumentSync 按激活与浅比较精确同步并卸载清理", () => {
    const el = document.createElement("input");
    document.body.appendChild(el);
    let focusedCount = 0;
    const origFocus = el.focus.bind(el);
    el.focus = (opts?: FocusOptions) => {
      focusedCount++;
      origFocus(opts);
    };
    const runs: string[] = [];
    const cleanups: string[] = [];

    const { rerender, unmount } = renderHook(
      ({ a, b, focus }: { a: number; b: string; focus: boolean }) => {
        const ref = useRef<HTMLInputElement | null>(el);
        hooks.useAutoFocus(ref, focus);
        hooks.useElementSync(ref, { a, b }, (node, val) => {
          runs.push(`${node.tagName}:${val.a}:${val.b}`);
          return () => cleanups.push(`el:${val.a}:${val.b}`);
        });
        hooks.useDocumentSync(a, (doc, val) => {
          doc.title = `T-${val}`;
          return () => cleanups.push(`doc:${val}`);
        });
      },
      { initialProps: { a: 1, b: "one", focus: true } },
    );

    expect(focusedCount).toBe(1);
    expect(runs).toEqual(["INPUT:1:one"]);
    expect(document.title).toBe("T-1");

    // 等价的新对象字面量不应重新触发 sync
    rerender({ a: 1, b: "one", focus: false });
    expect(runs).toEqual(["INPUT:1:one"]);
    expect(cleanups).toEqual([]);

    rerender({ a: 2, b: "two", focus: true });
    expect(focusedCount).toBe(2);
    expect(runs).toEqual(["INPUT:1:one", "INPUT:2:two"]);
    expect(cleanups).toEqual(["el:1:one", "doc:1"]);
    expect(document.title).toBe("T-2");

    unmount();
    expect(cleanups).toEqual(["el:1:one", "doc:1", "el:2:two", "doc:2"]);
    el.remove();
  });

  test("useAbortScope 卸载时自动中止根信号与所有 fork 出的子控制器", () => {
    const { result, unmount } = renderHook(() => hooks.useAbortScope());
    expect(result.current.alive()).toBe(true);
    const child1 = result.current.fork();
    const child2 = result.current.fork(child1);
    expect(child1.signal.aborted).toBe(true);
    expect(child2.signal.aborted).toBe(false);

    unmount();
    expect(result.current.alive()).toBe(false);
    expect(result.current.signal.aborted).toBe(true);
    expect(child2.signal.aborted).toBe(true);
  });

  test("useExternalConnection 切换 key 时中止旧连接并执行异步 cleanup，假键不连接", async () => {
    const events: string[] = [];
    const { rerender, unmount } = renderHook(
      ({ key }: { key: string | null | false }) => {
        hooks.useExternalConnection(key, async (activeKey, signal) => {
          events.push(`connect:${activeKey}`);
          signal.addEventListener("abort", () => events.push(`abort:${activeKey}`));
          await Promise.resolve();
          return () => events.push(`cleanup:${activeKey}`);
        });
      },
      { initialProps: { key: false as string | null | false } },
    );

    expect(events).toEqual([]);

    rerender({ key: "k1" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toEqual(["connect:k1"]);

    rerender({ key: "k2" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toEqual([
      "connect:k1",
      "abort:k1",
      "cleanup:k1",
      "connect:k2",
    ]);

    unmount();
    expect(events).toEqual([
      "connect:k1",
      "abort:k1",
      "cleanup:k1",
      "connect:k2",
      "abort:k2",
      "cleanup:k2",
    ]);
  });

  test("useElementEvent 与 useResizeObserver 支持 rebindKey 在同 ref 替换 DOM 后重绑", () => {
    const prevResize = globalThis.ResizeObserver;
    const observed: Element[] = [];
    let disconnects = 0;
    globalThis.ResizeObserver = class {
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {
        disconnects++;
      }
    } as unknown as typeof ResizeObserver;
    restoreHooks.push(() => {
      globalThis.ResizeObserver = prevResize;
    });

    const el1 = document.createElement("div");
    const el2 = document.createElement("div");
    const clicks: string[] = [];

    const { rerender, unmount } = renderHook(
      ({ targetEl, epoch }: { targetEl: HTMLDivElement; epoch: string }) => {
        const ref = useRef<HTMLDivElement | null>(targetEl);
        ref.current = targetEl;
        hooks.useElementEvent(
          ref,
          "custom:rebind",
          () => clicks.push(epoch),
          undefined,
          epoch,
        );
        hooks.useResizeObserver(ref, () => {}, true, epoch);
      },
      { initialProps: { targetEl: el1, epoch: "c1" } },
    );

    el1.dispatchEvent(new Event("custom:rebind"));
    expect(clicks).toEqual(["c1"]);
    expect(observed).toEqual([el1]);

    rerender({ targetEl: el2, epoch: "c2" });
    el1.dispatchEvent(new Event("custom:rebind"));
    el2.dispatchEvent(new Event("custom:rebind"));
    expect(clicks).toEqual(["c1", "c2"]);
    expect(observed).toEqual([el1, el2]);
    expect(disconnects).toBe(1);

    unmount();
    expect(disconnects).toBe(2);
  });
});
