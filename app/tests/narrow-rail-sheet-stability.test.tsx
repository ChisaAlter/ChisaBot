import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { PanelRail } from "@/components/panels/panel-rail";
import { TaskCenterProvider } from "@/components/task-center/task-center-provider";
import { agentKeys } from "@/lib/agents/queries";
import { setPanelSheetOpen } from "@/lib/panels/rail-open";
import {
  taskCenterKeys,
  taskCenterSnapshotOptions,
} from "@/lib/task-center-api";
import { workflowKeys, workflowLibraryQueryOptions } from "@/lib/workflows";
import { settleReactWork } from "./settle-react-work";

/**
 * 竖屏 / 窄窗（< 1280px）打开与关闭右侧面板抽屉时，`body[data-has-narrow-rail]` 必须保持恒定：
 * 以前该属性通过 ref={presenceRef("has-narrow-rail")} 绑在条件渲染的 .rail-tab.is-narrow 按钮上，
 * 开合抽屉反复删加属性导致 [data-testid="chat-transcript"] 的 padding-right 跳变 14–22px，
 * 抑制 Blink overflow-anchor 并触发整列回跳与平滑下滑。
 */

let wideMatches = false;
const mqlListeners = new Set<() => void>();
const realFetch = globalThis.fetch;
let realMatchMedia: typeof window.matchMedia | undefined;

function setWideViewport(wide: boolean) {
  wideMatches = wide;
  for (const listener of mqlListeners) listener();
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("1280px") ? wideMatches : false;
    },
    media: query,
    onchange: null,
    addListener(cb: () => void) {
      mqlListeners.add(cb);
    },
    removeListener(cb: () => void) {
      mqlListeners.delete(cb);
    },
    addEventListener(_type: string, cb: EventListenerOrEventListenerObject) {
      if (typeof cb === "function") mqlListeners.add(cb as () => void);
    },
    removeEventListener(_type: string, cb: EventListenerOrEventListenerObject) {
      if (typeof cb === "function") mqlListeners.delete(cb as () => void);
    },
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
});

afterEach(async () => {
  setPanelSheetOpen(false);
  wideMatches = false;
  mqlListeners.clear();
  cleanup();
  await settleReactWork();
  document.body.removeAttribute("data-has-narrow-rail");
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  if (realMatchMedia) window.matchMedia = realMatchMedia;
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function createTestClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  client.setQueryData(agentKeys.list(), [{ id: "bot-1", name: "千纱" }]);
  client.setQueryData(["live-panels", "bot-1"], []);
  client.setQueryData(taskCenterKeys.snapshot, {
    running: true,
    concurrency: 2,
    counts: {
      inbox: 0,
      queued: 0,
      planning: 0,
      running: 0,
      waiting_dependencies: 0,
      waiting_approval: 0,
      paused: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    tasks: [],
    outbox: [],
    sources: [],
  });
  client.setQueryData(workflowKeys.library, {
    presets: [],
    mine: [],
    runs: [],
  });
  return client;
}

describe("窄窗面板抽屉与右栏轮询门控", () => {
  test("窄窗开关面板抽屉全程保持 body[data-has-narrow-rail]，仅切宽屏或卸载时移除", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          user: { id: "u1", email: "test@example.com", name: "测试" },
          preferences: {},
          items: [],
          presets: [],
          mine: [],
          runs: [],
        }),
      { preconnect() {} },
    ) as typeof fetch;

    wideMatches = false;
    const queryClient = createTestClient();
    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <TaskCenterProvider>
            <PanelRail />
          </TaskCenterProvider>
        </QueryClientProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<RouterProvider router={router} />);
    });
    await settleReactWork();

    // 1. 窄窗初始挂载：挂着把手与 body[data-has-narrow-rail]
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(true);
    const opener = view?.container.querySelector(".rail-tab.is-narrow");
    expect(opener).not.toBeNull();

    // 2. 点击把手打开抽屉：把手通过 data-hidden 平滑退场，body[data-has-narrow-rail] 必须保持 true
    await act(async () => {
      if (opener) fireEvent.click(opener);
    });
    await settleReactWork();
    const openerWhileOpen = view?.container.querySelector(
      ".rail-tab.is-narrow",
    );
    expect(openerWhileOpen?.getAttribute("data-hidden")).toBe("true");
    expect(openerWhileOpen?.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(true);

    // 3. 关闭抽屉：把手恢复可见，body[data-has-narrow-rail] 依然保持 true
    await act(async () => {
      setPanelSheetOpen(false);
    });
    await settleReactWork();
    const openerAfterClose = view?.container.querySelector(
      ".rail-tab.is-narrow",
    );
    expect(openerAfterClose).not.toBeNull();
    expect(openerAfterClose?.getAttribute("data-hidden")).toBeNull();
    expect(openerAfterClose?.getAttribute("aria-hidden")).toBeNull();
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(true);

    // 4. 窗口拉宽至 >= 1280px：进入常驻栏模式，此时才移除 body[data-has-narrow-rail]
    await act(async () => {
      setWideViewport(true);
    });
    await settleReactWork();
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(false);

    // 5. 再缩回窄窗并卸载：恢复后再卸载干净移除
    await act(async () => {
      setWideViewport(false);
    });
    await settleReactWork();
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(true);

    await act(async () => {
      view?.unmount();
    });
    await settleReactWork();
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(false);
  });

  test("任务快照与工作流库查询在 poll=false 时暂停后台轮询，默认保持原节奏", () => {
    const activeSnapshot = taskCenterSnapshotOptions();
    const pausedSnapshot = taskCenterSnapshotOptions({ poll: false });
    expect(activeSnapshot.refetchInterval).toBe(5_000);
    expect(activeSnapshot.refetchIntervalInBackground).toBe(false);
    expect(pausedSnapshot.refetchInterval).toBe(false);
    expect(pausedSnapshot.refetchIntervalInBackground).toBe(false);

    const activeWf = workflowLibraryQueryOptions();
    const pausedWf = workflowLibraryQueryOptions({ poll: false });
    expect(activeWf.refetchIntervalInBackground).toBe(false);
    expect(pausedWf.refetchIntervalInBackground).toBe(false);
    const activeFn = activeWf.refetchInterval as (q: {
      state: {
        status: string;
        data: { runs: { status: string }[] } | undefined;
        errorUpdateCount: number;
      };
    }) => number | false;
    const pausedFn = pausedWf.refetchInterval as (q: {
      state: {
        status: string;
        data: { runs: { status: string }[] } | undefined;
        errorUpdateCount: number;
      };
    }) => number | false;
    const runningState = {
      state: {
        status: "success",
        data: { runs: [{ status: "running" }] },
        errorUpdateCount: 0,
      },
    };
    const errorState = {
      state: { status: "error", data: undefined, errorUpdateCount: 1 },
    };
    expect(activeFn(runningState)).toBe(3_000);
    expect(activeFn(errorState)).toBe(5_000);
    expect(pausedFn(runningState)).toBe(false);
    expect(pausedFn(errorState)).toBe(false);
  });
});
