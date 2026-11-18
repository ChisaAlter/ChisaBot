import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  UPDATE_AUTO_RELOAD_MS,
  UpdateBanner,
} from "@/components/update-banner";
import { setBusy, setPendingAttachments } from "@/lib/activity";
import type { PcBridge, PcLocalState } from "@/lib/pc-bridge";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-135：有新构建时页面空闲（refreshWouldInterrupt() === null）会自动换到新构建，
 * 不必等用户点；忙 / 有未发内容时横幅留着继续等；点 ✕ 关掉或 PC 客户端更新在进行时
 * 都不自动刷。
 */

const SERVED = {
  version: "0.1.164",
  commit: "abc1234",
  buildId: "srv-new-build",
  builtAt: "2026-11-18T00:00:00Z",
};

let originalFetch: typeof fetch;

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const settle = async () => {
  await act(async () => {
    await flush();
  });
};
/** 走假定时器并让随之解决的 fetch / React 更新都落在 act 里。 */
const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await flush();
  });
};

/** 走完全部的「首次版本检查」（挂载后 20s）并等横幅上屏。 */
const reachBanner = async (view: ReturnType<typeof render>) => {
  await advance(20_000);
  expect(view.getByText("有新版本，点此刷新")).toBeTruthy();
};

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("/api/version")) return Response.json(SERVED);
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  jest.useFakeTimers();
});
afterEach(() => {
  setBusy("chat", false);
  setPendingAttachments("composer", 0);
  delete window.chisabotPC;
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  cleanup();
});

describe("自动刷新（CB-135）", () => {
  test("服务端构建更新且页面空闲：到点自动刷新一次", async () => {
    const reload = jest.fn();
    const view = render(
      <UpdateBanner bundled="old-build" reload={reload} />,
    );
    await reachBanner(view);
    expect(reload).not.toHaveBeenCalled();

    await advance(UPDATE_AUTO_RELOAD_MS - 1);
    expect(reload).not.toHaveBeenCalled();

    await advance(1);
    expect(reload).toHaveBeenCalledTimes(1);

    // 刷新已发出后不重复：计时器已停。
    await advance(UPDATE_AUTO_RELOAD_MS * 3);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("登记为忙时不刷，忙清掉后下一轮才刷", async () => {
    const reload = jest.fn();
    const view = render(
      <UpdateBanner bundled="old-build" reload={reload} />,
    );
    await reachBanner(view);

    setBusy("chat", true);
    await advance(UPDATE_AUTO_RELOAD_MS * 3);
    expect(reload).not.toHaveBeenCalled();
    // 横幅还在，用户照旧可以点。
    expect(view.getByText("有新版本，点此刷新")).toBeTruthy();

    setBusy("chat", false);
    await advance(UPDATE_AUTO_RELOAD_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await advance(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("点 ✕ 关掉提示：明确不换，自动刷新一并取消", async () => {
    const reload = jest.fn();
    const view = render(
      <UpdateBanner bundled="old-build" reload={reload} />,
    );
    await reachBanner(view);

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: "关闭新版本提示" }),
      );
    });
    await settle();
    expect(view.queryByText("有新版本，点此刷新")).toBeNull();

    await advance(UPDATE_AUTO_RELOAD_MS * 5);
    expect(reload).not.toHaveBeenCalled();
  });

  test("PC 客户端正在下载 / 已下载更新：不显示横幅也不自动刷", async () => {
    const state: PcLocalState = {
      version: "0.1.163",
      platform: "win32",
      hostname: "pc",
      serverUrl: "http://localhost",
      deviceId: "dev1",
      agentState: "online",
      statusText: "online",
      tokenProtected: false,
      localPaused: false,
      forceLocalApproval: false,
      autoStart: false,
      startHidden: false,
      update: { supported: true, status: "downloading", percent: 40 },
    };
    const listeners = new Set<() => void>();
    window.chisabotPC = {
      state: async () => state,
      setLocal: async () => state,
      pickFolders: async () => [],
      logout: async () => true,
      onChange: (callback: () => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    } as PcBridge;

    const reload = jest.fn();
    const view = render(
      <UpdateBanner bundled="old-build" reload={reload} />,
    );
    await advance(20_000);
    expect(view.queryByText("有新版本，点此刷新")).toBeNull();

    await advance(UPDATE_AUTO_RELOAD_MS * 5);
    expect(reload).not.toHaveBeenCalled();
  });
});
