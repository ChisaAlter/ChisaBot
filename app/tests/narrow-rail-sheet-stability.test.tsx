import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { setPanelRailOpen, setPanelSheetOpen } from "@/lib/panels/rail-open";
import { beginResizing, initResizeState } from "@/lib/resize-state";
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
  setPanelRailOpen(true);
  wideMatches = false;
  mqlListeners.clear();
  initResizeState()();
  cleanup();
  await settleReactWork();
  document.body.removeAttribute("data-has-narrow-rail");
  window.localStorage.removeItem("chisabot-panel-rail-width");
  window.localStorage.removeItem("chisabot-panel-rail");
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

    // 2. 点击把手打开抽屉：展开态卸载「面板」把手，body[data-has-narrow-rail] 必须保持 true，且顶栏关闭键存在
    await act(async () => {
      if (opener) fireEvent.click(opener);
    });
    await settleReactWork();
    expect(view?.container.querySelector(".rail-tab.is-narrow")).toBeNull();
    expect(
      document.querySelector('[data-testid="panel-sheet-close"]'),
    ).not.toBeNull();
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(true);

    // 3. 关闭抽屉：把手重新挂载可见，body[data-has-narrow-rail] 依然保持 true
    await act(async () => {
      setPanelSheetOpen(false);
    });
    await settleReactWork();
    const openerAfterClose = view?.container.querySelector(
      ".rail-tab.is-narrow",
    );
    expect(openerAfterClose).not.toBeNull();
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

  test("任务快照与工作流库查询在 poll=false 时暂停后台轮询，默认按活跃/空闲自适应节奏", () => {
    const activeSnapshot = taskCenterSnapshotOptions();
    const pausedSnapshot = taskCenterSnapshotOptions({ poll: false });
    expect(typeof activeSnapshot.refetchInterval).toBe("function");
    const snapInterval = activeSnapshot.refetchInterval as (q: {
      state: {
        data?: {
          counts?: Record<string, number>;
          decisionCounts?: { pending: number };
        };
      };
    }) => number | false;
    expect(snapInterval({ state: { data: { counts: { running: 1 } } } })).toBe(
      5_000,
    );
    expect(snapInterval({ state: { data: { counts: { running: 0 } } } })).toBe(
      60_000,
    );
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

  test("宽窗展开态仅显示顶栏收起键而不显示右缘「面板」把手，收起后显示把手且切换过程走纯 GPU 动效标记", async () => {
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

    // 模拟历史版本保存的过窄 300px 宽度，验证会被平滑提升到 >= 320px，防止三标签挤掉收起键
    window.localStorage.setItem("chisabot-panel-rail-width", "300");
    wideMatches = true;
    setPanelRailOpen(true);

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

    // 展开态：不渲染 .rail-tab 把手，顶栏操作区包含收起键，宽度已抬升到 320px
    expect(view?.container.querySelector(".rail-tab")).toBeNull();
    const rail = view?.container.querySelector<HTMLElement>(
      "#chisabot-panel-rail",
    );
    expect(rail?.getAttribute("data-state")).toBe("expanded");
    expect(rail?.style.width).toBe("320px");
    const closeBtn = view?.container.querySelector<HTMLButtonElement>(
      '.rail-head .rail-head-actions [data-testid="panel-rail-close"]',
    );
    expect(closeBtn).not.toBeNull();

    // 点击收起键：切入 closing 动效、卸载展开态后立即出现右缘「面板」把手
    await act(async () => {
      if (closeBtn) fireEvent.click(closeBtn);
    });
    expect(rail?.getAttribute("data-state")).toBe("collapsed");
    expect(rail?.getAttribute("data-rail-motion")).toBe("closing");
    const tab =
      view?.container.querySelector<HTMLButtonElement>("button.rail-tab");
    expect(tab).not.toBeNull();

    // 点击右缘「面板」把手展开：立即卸载把手并进入 opening 动效
    await act(async () => {
      if (tab) fireEvent.click(tab);
    });
    expect(view?.container.querySelector(".rail-tab")).toBeNull();
    expect(rail?.getAttribute("data-state")).toBe("expanded");
    expect(rail?.getAttribute("data-rail-motion")).toBe("opening");
  });

  test("CSS 守卫：.rail-tab 禁止 both 锁态，.rail-tabs 弹性等分防裁切，.glass-rail 零 width/padding 逐帧重排且接入 glass-hold", () => {
    const stylesCss = readFileSync(
      join(import.meta.dir, "../src/styles.css"),
      "utf8",
    );
    const materialsCss = readFileSync(
      join(import.meta.dir, "../src/styles/materials.css"),
      "utf8",
    );

    // 1. .rail-tab 仅用 backwards（禁止 both/forwards 级联锁死 opacity）
    expect(stylesCss).toContain(
      "animation: rail-tab-in var(--dur-2) var(--ease-out) 120ms backwards;",
    );
    expect(stylesCss).not.toContain(
      "animation: rail-tab-in var(--dur-2) var(--ease-out) 120ms both;",
    );

    // 2. 顶栏操作区 flex: none 贴右，三标签网格可弹性收缩且滑块等分
    expect(stylesCss).toMatch(
      /\.rail-head-actions\s*\{[^}]*margin-left:\s*auto;\s*flex:\s*none;/,
    );
    expect(stylesCss).toContain("width: calc((100% - 6px) / 3);");

    // 3. .glass-rail 不再对 width / padding 做逐帧布局过渡
    const glassRailRule = stylesCss.match(/\.glass-rail\s*\{([^}]*)\}/);
    expect(glassRailRule?.[1]).not.toMatch(
      /transition\s*:[^;]*(?:width|padding)/,
    );

    // 4. 宽窗展开期接入 glass-hold，收起态与关闭期剥离模糊
    expect(materialsCss).toContain(
      '.glass-rail[data-rail-motion="opening"] > .rail-card',
    );
    expect(materialsCss).toContain(
      '.glass-rail:is(.is-collapsed, [data-rail-motion="closing"]) > .rail-card',
    );

    // 5. materials.css 消费预合成色标（零逐气泡实时 color-mix 求值），且 html[data-resizing] 抑制跨断点并发入场动画
    expect(materialsCss).not.toContain("color-mix(");
    expect(stylesCss).toMatch(
      /html\[data-resizing\]\s*:is\([\s\S]*?\.rail-tab[\s\S]*?\.ch-content-enter[\s\S]*?\)\s*\{\s*animation:\s*none;/,
    );

    // 6. 宽窗右栏收起（closing）必须锚定 --glass-top 且 height: auto（禁止 top: 0 撞入顶栏并拉高），安装提示展开态同步偏移
    const closingRailRule = stylesCss.match(
      /\.glass-rail\[data-rail-motion="closing"\]\s*\{([^}]*)\}/,
    );
    expect(closingRailRule?.[1]).toContain("top: var(--glass-top);");
    expect(closingRailRule?.[1]).toContain("height: auto;");
    expect(closingRailRule?.[1]).not.toMatch(/\btop:\s*0\s*;/);
    expect(stylesCss).toMatch(
      /body\[data-install-hint="open"\]\s+\.glass-rail\[data-rail-motion="closing"\]\s*\{\s*top:\s*calc\(var\(--glass-top\)\s*\+\s*var\(--install-hint-gap,\s*0px\)\);/,
    );

    // 7. html[data-resizing] 抑制侧栏、壁纸与面板过渡/动画（防小窗↔大窗跨断点并发重排）
    expect(stylesCss).toMatch(
      /html\[data-resizing\]\s*:is\([\s\S]*?\[data-slot="sidebar-gap"\][\s\S]*?\[data-slot="sidebar-container"\][\s\S]*?\.chisabot-wallpaper-img[\s\S]*?\.live-panel[\s\S]*?\)\s*\{\s*transition:\s*none;/,
    );
  });

  test("小窗切回大窗（缩放期）跨断点首帧先画右栏玻璃壳，下一帧 rAF 渐进挂载重内容；非缩放期首帧同步挂载", async () => {
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

    const realRaf = window.requestAnimationFrame;
    const realCancelRaf = window.cancelAnimationFrame;
    let rafQueue: FrameRequestCallback[] = [];
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      if (id > 0 && id <= rafQueue.length) {
        rafQueue[id - 1] = () => {};
      }
    }) as typeof window.cancelAnimationFrame;

    try {
      wideMatches = false;
      setPanelRailOpen(true);

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

      // 1. 缩放期窄→宽：首帧右栏壳体立现，重型 PanelRailBody 暂缓 1 帧
      await act(async () => {
        beginResizing(220);
        setWideViewport(true);
      });
      expect(
        view?.container.querySelector("#chisabot-panel-rail"),
      ).not.toBeNull();
      expect(
        view?.container.querySelector('[data-testid="panel-rail-close"]'),
      ).toBeNull();

      // 下一帧 rAF 后立即挂载完整内容
      await act(async () => {
        const pending = rafQueue;
        rafQueue = [];
        for (const cb of pending) cb(performance.now());
      });
      await settleReactWork();
      expect(
        view?.container.querySelector('[data-testid="panel-rail-close"]'),
      ).not.toBeNull();

      // 2. 复位到窄窗并结束缩放期，非缩放期窄→宽首帧同步挂载完整内容
      initResizeState()();
      await act(async () => {
        setWideViewport(false);
      });
      await settleReactWork();
      await act(async () => {
        setWideViewport(true);
      });
      expect(
        view?.container.querySelector('[data-testid="panel-rail-close"]'),
      ).not.toBeNull();
    } finally {
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancelRaf;
    }
  });
});
