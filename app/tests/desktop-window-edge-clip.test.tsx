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
import type { DesktopWindowBridge } from "@/lib/desktop-window";

/**
 * 「面板」把手让位（--edge-clip-r，styles.css ~L4383）：拖窗口不触发 resize、
 * 桥没有 bounds 回调，0.1.161 只在挂载 + resize 时量越屏量，窗口被拖到右缘出屏
 * 后把手跟着出屏被裁半条（用户 2026-11-18 截图实测）。现在 250ms 轮询 screenX +
 * outerWidth，越过工作区右缘的量一变就重写变量；不变不写样式；最大化恒 0。
 */

let useDesktopWindow: typeof import("@/lib/desktop-window").useDesktopWindow;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  ({ useDesktopWindow } = await import("@/lib/desktop-window"));
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const clipVar = () =>
  document.documentElement.style.getPropertyValue("--edge-clip-r");

const clipWrites: string[] = [];
let restoreSetProperty: (() => void) | null = null;

/** 数 --edge-clip-r 的 setProperty 次数（轮询应只在值变化时写）。 */
type SetProperty = (
  property: string,
  value: string | null,
  priority?: string,
) => void;

function watchClipWrites() {
  const style = document.documentElement.style as CSSStyleDeclaration & {
    setProperty: SetProperty;
  };
  const original = style.setProperty.bind(style);
  style.setProperty = (name, value, priority) => {
    if (name === "--edge-clip-r") clipWrites.push(String(value));
    return original(name, value, priority);
  };
  restoreSetProperty = () => {
    style.setProperty = original;
    restoreSetProperty = null;
  };
}

type BridgeHandle = {
  /** 改 isMaximized() 的返回值并广播 onMaximizedChange。 */
  setMaximized: (value: boolean) => void;
};

function installBridge(initialMaximized: boolean): BridgeHandle {
  let maximized = initialMaximized;
  const callbacks = new Set<(value: boolean) => void>();
  const bridge: DesktopWindowBridge = {
    platform: "win32",
    minimize() {},
    toggleMaximize() {},
    close() {},
    isMaximized: () => Promise.resolve(maximized),
    onMaximizedChange: (callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  };
  window.chisabotWindow = bridge;
  return {
    setMaximized: (value) => {
      maximized = value;
      for (const callback of callbacks) callback(value);
    },
  };
}

/**
 * 摆一个右缘出屏的窗口：工作区 [0, 1920)，窗口 screenX + outerWidth = right。
 * happy-dom 的 screenX / screen.availWidth 是普通字段、outerWidth 有 setter，直接赋值即可。
 */
function setWindowAt(right: number) {
  const screen = window.screen as Screen & { availLeft?: number };
  screen.availLeft = 0;
  (screen as { availWidth: number }).availWidth = 1920;
  window.outerWidth = 1280;
  window.screenX = right - 1280;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const tick = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

afterEach(() => {
  cleanup();
  restoreSetProperty?.();
  window.chisabotWindow = undefined;
  clipWrites.length = 0;
  document.documentElement.style.removeProperty("--edge-clip-r");
});

describe("useDesktopWindow 的 --edge-clip-r 轮询", () => {
  test("挂载时写入越屏量；拖窗口不触发 resize 也在一个轮询周期内跟上", async () => {
    installBridge(false);
    setWindowAt(2280); // 越出 1920 工作区 360px
    const { result } = renderHook(() => useDesktopWindow());
    await flush();
    expect(result.current?.bridge.platform).toBe("win32");
    expect(result.current?.maximized).toBe(false);
    expect(clipVar()).toBe("360px");

    // 拖窗口右移：没有任何 DOM 事件，靠 250ms 轮询。
    setWindowAt(2780); // 越出 860px
    await tick(400);
    expect(clipVar()).toBe("860px");

    // 拖回屏内回到 0。
    setWindowAt(1200);
    await tick(400);
    expect(clipVar()).toBe("0px");
  });

  test("值不变时不重复写样式；onMaximizedChange 也驱动重算", async () => {
    const bridge = installBridge(false);
    setWindowAt(2280);
    watchClipWrites();
    renderHook(() => useDesktopWindow());
    await flush();
    expect(clipVar()).toBe("360px");
    expect(clipWrites).toEqual(["360px"]);

    // 多个轮询周期不动 → 不再写。
    await tick(600);
    expect(clipWrites).toEqual(["360px"]);

    // 窗口最大化 → 恒 0（恢复态的越屏量不算数）。
    act(() => bridge.setMaximized(true));
    expect(clipVar()).toBe("0px");
    expect(clipWrites).toEqual(["360px", "0px"]);
    await tick(400);
    expect(clipWrites).toEqual(["360px", "0px"]);

    // 还原回恢复态 → 回到当前越屏量。
    act(() => bridge.setMaximized(false));
    expect(clipVar()).toBe("360px");
    expect(clipWrites).toEqual(["360px", "0px", "360px"]);
  });

  test("isMaximized 初值为 true 时先落越屏量、随即被改写成 0px", async () => {
    installBridge(true);
    setWindowAt(2280);
    watchClipWrites();
    renderHook(() => useDesktopWindow());
    await flush();
    expect(clipVar()).toBe("0px");
    expect(clipWrites).toEqual(["360px", "0px"]);
    await tick(300);
    expect(clipWrites).toEqual(["360px", "0px"]);
  });

  test("卸载时移除变量并停轮询", async () => {
    installBridge(false);
    setWindowAt(2280);
    const { unmount } = renderHook(() => useDesktopWindow());
    await flush();
    expect(clipVar()).toBe("360px");
    unmount();
    expect(clipVar()).toBe("");
    setWindowAt(2780);
    await tick(400);
    expect(clipVar()).toBe("");
  });

  test("浏览器里没有窗口桥：返回 null、不设变量", async () => {
    window.chisabotWindow = undefined;
    const { result } = renderHook(() => useDesktopWindow());
    await flush();
    expect(result.current).toBeNull();
    expect(clipVar()).toBe("");
  });

  test("窄工作区下宿主外框最小宽度大于 innerWidth 但未拖出右缘时，--edge-clip-r 保持 0px", async () => {
    installBridge(false);
    const screen = window.screen as Screen & { availLeft?: number };
    const prevAvailWidth = screen.availWidth;
    const prevInnerWidth = window.innerWidth;
    try {
      screen.availLeft = 0;
      (screen as { availWidth: number }).availWidth = 390;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 390,
      });
      window.outerWidth = 535;
      window.screenX = 10;
      renderHook(() => useDesktopWindow());
      await flush();
      expect(clipVar()).toBe("0px");
    } finally {
      (screen as { availWidth: number }).availWidth = prevAvailWidth;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: prevInnerWidth,
      });
    }
  });
});
