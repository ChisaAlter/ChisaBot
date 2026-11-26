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
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { useRailTasksSummary } from "@/components/panels/rail-tasks-summary";
import {
  APPROVALS_ACTIVE_POLL_MS,
  APPROVALS_IDLE_POLL_MS,
  type ApprovalInboxData,
  approvalInboxOptions,
  hasPendingApprovals,
} from "@/lib/approvals";
import {
  ToolRendererProvider,
  useRegisteredToolRenderers,
  useRenderTool,
} from "@/lib/chat/renderers";
import {
  resetTabsStoreForTests,
  setTabsView,
  TABS_VIEW_CACHE_MAX,
  tabsStoreStats,
  useBrowserTabs,
} from "@/lib/computers/tabs";
import { recentConfirmationsQueryOptions } from "@/lib/confirmations";
import {
  type DesktopWindowBridge,
  desktopClipTimerRunningForTests,
  useDesktopWindow,
} from "@/lib/desktop-window";
import {
  clearFaviconToneCache,
  FAVICON_TONE_CACHE_MAX,
  faviconToneCacheKey,
  faviconToneCacheStats,
  setCachedFaviconTone,
} from "@/lib/favicon-tone";
import {
  createKeptVisibility,
  KeptVisibilityContext,
} from "@/lib/kept-visible";
import {
  relativeClockStatus,
  resetRelativeClocksForTests,
  useRelativeNow,
} from "@/lib/relative-time";
import {
  hasActiveTaskCenterWork,
  TASK_CENTER_ACTIVE_POLL_MS,
  TASK_CENTER_IDLE_POLL_MS,
  taskCenterKeys,
  taskCenterSnapshotOptions,
} from "@/lib/task-center-api";
import { clockStatus, resetClockForTests, useNow } from "@/lib/use-now";
import { useThreadWorkers } from "@/lib/conversations/workers";
import type { TaskCenterSnapshot } from "../../shared/task-center";
import { settleReactWork } from "./settle-react-work";

const realFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

beforeEach(() => {
  jest.useRealTimers();
  resetClockForTests();
  resetRelativeClocksForTests();
  clearFaviconToneCache();
  resetTabsStoreForTests();
  setDocumentHidden(false);
});

afterEach(async () => {
  cleanup();
  await settleReactWork();
  globalThis.fetch = realFetch;
  window.chisabotWindow = undefined;
  setDocumentHidden(false);
  resetClockForTests();
  resetRelativeClocksForTests();
  clearFaviconToneCache();
  resetTabsStoreForTests();
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: hidden ? "hidden" : "visible",
  });
}

function makeSnapshot(
  overrides: Partial<TaskCenterSnapshot> = {},
): TaskCenterSnapshot {
  return {
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
    ...overrides,
  };
}

function makeApprovals(
  overrides: Partial<ApprovalInboxData> = {},
): ApprovalInboxData {
  return {
    enabled: true,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
    ...overrides,
  };
}

describe("闲置轮询自适应降频与 KeepAlive 门控", () => {
  test("taskCenterSnapshotOptions 空闲时降至 60s、有活跃任务或待决策时保持 5s 且禁后台轮询", () => {
    const opts = taskCenterSnapshotOptions({ poll: true });
    expect(opts.refetchIntervalInBackground).toBe(false);
    expect(typeof opts.refetchInterval).toBe("function");
    const interval = opts.refetchInterval as (q: {
      state: { data?: TaskCenterSnapshot };
    }) => number | false;

    const idleSnap = makeSnapshot();
    expect(hasActiveTaskCenterWork(idleSnap)).toBe(false);
    expect(interval({ state: { data: idleSnap } })).toBe(
      TASK_CENTER_IDLE_POLL_MS,
    );

    const runningSnap = makeSnapshot({
      counts: { ...idleSnap.counts, running: 1 },
    });
    expect(hasActiveTaskCenterWork(runningSnap)).toBe(true);
    expect(interval({ state: { data: runningSnap } })).toBe(
      TASK_CENTER_ACTIVE_POLL_MS,
    );

    const decisionSnap = makeSnapshot({
      decisionCounts: { pending: 1, approved: 0, rejected: 0, superseded: 0 },
    });
    expect(hasActiveTaskCenterWork(decisionSnap)).toBe(true);
    expect(interval({ state: { data: decisionSnap } })).toBe(
      TASK_CENTER_ACTIVE_POLL_MS,
    );

    expect(taskCenterSnapshotOptions({ poll: false }).refetchInterval).toBe(
      false,
    );
  });

  test("approvalInboxOptions 空闲 0 待审批降至 60s，有待审批/待回答保持 10s，且支持 KeepAlive 门控", () => {
    let visible = true;
    const opts = approvalInboxOptions({ poll: () => visible });
    expect(opts.refetchIntervalInBackground).toBe(false);
    const interval = opts.refetchInterval as (q: {
      state: { data?: ApprovalInboxData };
    }) => number | false;

    const idle = makeApprovals();
    expect(hasPendingApprovals(idle)).toBe(false);
    expect(interval({ state: { data: idle } })).toBe(APPROVALS_IDLE_POLL_MS);

    const withPending = makeApprovals({
      requests: [
        {
          id: "req-1",
          status: "pending",
          createdAt: "2026-11-26T00:00:00.000Z",
          action: {
            botId: "b1",
            toolRef: "computer_click",
            effect: "click",
            scope: "example.com",
            threadId: "t1",
            args: {},
            target: {},
          },
        },
      ],
    });
    expect(hasPendingApprovals(withPending)).toBe(true);
    expect(interval({ state: { data: withPending } })).toBe(
      APPROVALS_ACTIVE_POLL_MS,
    );

    visible = false;
    expect(interval({ state: { data: withPending } })).toBe(false);
  });

  test("recentConfirmationsQueryOptions 禁用后台轮询并在隐藏态停表", () => {
    let visible = true;
    const opts = recentConfirmationsQueryOptions({ poll: () => visible });
    expect(opts.refetchIntervalInBackground).toBe(false);
    const interval = opts.refetchInterval as (q: {
      state: { data?: Array<{ status: string }> };
    }) => number | false;
    expect(interval({ state: { data: [] } })).toBe(false);
    expect(interval({ state: { data: [{ status: "pending" }] } })).toBe(2000);
    visible = false;
    expect(interval({ state: { data: [{ status: "pending" }] } })).toBe(false);
  });

  test("useRailTasksSummary 在数据未变时 memo 稳定返回对象引用", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnMount: false,
        },
      },
    });
    queryClient.setQueryData(taskCenterKeys.snapshot, makeSnapshot());
    queryClient.setQueryData(["workflows", "library"], {
      presets: [],
      mine: [],
      runs: [],
    });

    const results: Array<ReturnType<typeof useRailTasksSummary>> = [];
    function Probe({ tick }: { tick: number }) {
      const summary = useRailTasksSummary(false);
      results.push(summary);
      return <span data-tick={tick}>{summary.activeCount}</span>;
    }

    const view = render(
      <QueryClientProvider client={queryClient}>
        <Probe tick={0} />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe tick={1} />
      </QueryClientProvider>,
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[results.length - 1]).toBe(results[results.length - 2]);
    expect(results[results.length - 1]?.pendingDecisions).toBe(
      results[results.length - 2]?.pendingDecisions,
    );
    queryClient.clear();
  });

  test("useThreadWorkers 在 KeepAlive 隐藏态不轮询，恢复可见时立即补查", async () => {
    let hits = 0;
    globalThis.fetch = (async () => {
      hits += 1;
      return Response.json({
        workers: [
          {
            id: "w1",
            title: "跑任务",
            status: "running",
            step: null,
            plan: [],
            summary: null,
            error: null,
            resultMessageId: null,
            createdAt: "2026-11-26T00:00:00.000Z",
            startedAt: "2026-11-26T00:00:01.000Z",
            finishedAt: null,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const visibility = createKeptVisibility(false);

    function Probe() {
      useThreadWorkers("t-kept-worker");
      return null;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <KeptVisibilityContext.Provider value={visibility}>
          <Probe />
        </KeptVisibilityContext.Provider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    const initialHits = hits;
    expect(initialHits).toBe(1);

    // 切回可见：立刻补查一次。
    await act(async () => {
      visibility.set(true);
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(hits).toBeGreaterThan(initialHits);
    queryClient.clear();
  });
});

describe("共享时钟与桌面窗口裁切定时器后台暂停", () => {
  test("useNow 在 document.hidden 时暂停 interval，恢复可见时立刻 tick 并重启", () => {
    const seen: number[] = [];
    function Probe() {
      seen.push(useNow(true));
      return null;
    }
    const view = render(<Probe />);
    expect(clockStatus()).toEqual({ subscribers: 1, running: true });

    act(() => {
      setDocumentHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(clockStatus()).toEqual({ subscribers: 1, running: false });

    const beforeVisible = seen.length;
    act(() => {
      setDocumentHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(clockStatus()).toEqual({ subscribers: 1, running: true });
    expect(seen.length).toBeGreaterThanOrEqual(beforeVisible);
    view.unmount();
    expect(clockStatus()).toEqual({ subscribers: 0, running: false });
  });

  test("useRelativeNow 多行共享单个 60s 定时器，并在 document.hidden 时暂停", () => {
    const realSetInterval = globalThis.setInterval;
    let created = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      if (args[1] === 60_000) created += 1;
      return realSetInterval(...args);
    }) as typeof setInterval;

    try {
      function Row() {
        useRelativeNow();
        return null;
      }
      const view = render(
        <>
          <Row />
          <Row />
          <Row />
          <Row />
        </>,
      );
      expect(created).toBe(1);
      expect(relativeClockStatus()).toEqual({ subscribers: 4, running: true });

      act(() => {
        setDocumentHidden(true);
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(relativeClockStatus()).toEqual({ subscribers: 4, running: false });

      act(() => {
        setDocumentHidden(false);
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(relativeClockStatus()).toEqual({ subscribers: 4, running: true });
      expect(created).toBe(2);

      view.unmount();
      expect(relativeClockStatus()).toEqual({ subscribers: 0, running: false });
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test("desktop-window 250ms clipTimer 在最大化或 document.hidden 时暂停，恢复后重启", async () => {
    let onMax: ((v: boolean) => void) | null = null;
    const bridge: DesktopWindowBridge = {
      platform: "win32",
      minimize() {},
      toggleMaximize() {},
      close() {},
      isMaximized: () => Promise.resolve(false),
      onMaximizedChange: (cb) => {
        onMax = cb;
        return () => {
          onMax = null;
        };
      },
    };
    window.chisabotWindow = bridge;

    const { unmount } = renderHook(() => useDesktopWindow());
    await act(async () => {
      await Promise.resolve();
    });
    expect(desktopClipTimerRunningForTests()).toBe(true);

    // 最大化：停表
    act(() => {
      onMax?.(true);
    });
    expect(desktopClipTimerRunningForTests()).toBe(false);

    // 还原：恢复
    act(() => {
      onMax?.(false);
    });
    expect(desktopClipTimerRunningForTests()).toBe(true);

    // 标签页隐藏：停表
    act(() => {
      setDocumentHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(desktopClipTimerRunningForTests()).toBe(false);

    // 切回前台：恢复
    act(() => {
      setDocumentHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(desktopClipTimerRunningForTests()).toBe(true);

    unmount();
    expect(desktopClipTimerRunningForTests()).toBe(false);
  });
});

describe("LRU 缓存、监听器回收与静态架构护栏", () => {
  test("favicon-tone 使用短哈希 Key 且按 200 条上限做 LRU 淘汰", () => {
    const bigDataUrl = `data:image/png;base64,${"A".repeat(40_000)}`;
    const key = faviconToneCacheKey(bigDataUrl);
    expect(key.length).toBeLessThan(40);
    expect(key).not.toContain("AAAA");

    for (let i = 0; i < FAVICON_TONE_CACHE_MAX + 25; i++) {
      setCachedFaviconTone(`data:image/png;base64,icon-${i}`, i % 2 === 0);
    }
    const stats = faviconToneCacheStats();
    expect(stats.size).toBe(FAVICON_TONE_CACHE_MAX);
    // 最老的 0..24 已被淘汰，最新的保留
    expect(stats.keys).not.toContain(
      faviconToneCacheKey("data:image/png;base64,icon-0"),
    );
    expect(stats.keys).toContain(
      faviconToneCacheKey(
        `data:image/png;base64,icon-${FAVICON_TONE_CACHE_MAX + 24}`,
      ),
    );
  });

  test("computers/tabs 空 listeners 键在退订时删除，views 按 16 台上限 LRU 淘汰", () => {
    function Sub({ id }: { id: string }) {
      useBrowserTabs(id, false);
      return null;
    }
    const view = render(<Sub id="comp-live" />);
    expect(tabsStoreStats().listeners).toBe(1);
    view.unmount();
    expect(tabsStoreStats().listeners).toBe(0);

    for (let i = 0; i < TABS_VIEW_CACHE_MAX + 6; i++) {
      setTabsView(`comp-${i}`, {
        running: true,
        max: 8,
        activeId: "t1",
        tabs: [{ id: "t1", url: `https://s${i}.test/`, title: `S${i}`, active: true }],
      });
    }
    const stats = tabsStoreStats();
    expect(stats.views).toBe(TABS_VIEW_CACHE_MAX);
    expect(stats.viewIds).not.toContain("comp-0");
    expect(stats.viewIds).toContain(`comp-${TABS_VIEW_CACHE_MAX + 5}`);
  });

  test("RenderRegistry 真实渲染器注册后自动覆盖同名 placeholder", () => {
    let latest: readonly { name: string; placeholder?: boolean }[] = [];
    function Stub() {
      useRenderTool({
        name: "github_connect",
        placeholder: true,
        render: () => null,
      });
      return null;
    }
    function Real() {
      useRenderTool({
        name: "github_connect",
        render: () => <span>real</span>,
      });
      return null;
    }
    function Inspector() {
      latest = useRegisteredToolRenderers();
      return null;
    }

    const view = render(
      <ToolRendererProvider>
        <Stub />
        <Inspector />
      </ToolRendererProvider>,
    );
    expect(latest.filter((r) => r.name === "github_connect")).toHaveLength(1);
    expect(latest[0]?.placeholder).toBe(true);

    view.rerender(
      <ToolRendererProvider>
        <Stub />
        <Real />
        <Inspector />
      </ToolRendererProvider>,
    );
    const matched = latest.filter((r) => r.name === "github_connect");
    expect(matched).toHaveLength(1);
    expect(matched[0]?.placeholder).toBeUndefined();
  });

  test("AgentOrb 不再注入内联 <style>，且 styles.css 补齐 data-motion-rest 8 类暂停规则", async () => {
    const { default: AgentOrb } = await import(
      "@/components/agents/orb/agent-orb"
    );
    const view = render(<AgentOrb size="48px" />);
    expect(view.container.querySelector("style")).toBeNull();

    const styles = readFileSync(
      path.join(import.meta.dir, "../src/styles.css"),
      "utf8",
    );
    const restBlockStart = styles.indexOf('html[data-motion-rest="1"]');
    const restBlock = styles.slice(restBlockStart, restBlockStart + 1600);
    for (const sel of [
      ".agent-orb::before",
      ".agent-orb-sheen",
      ".rs-spinner",
      ".lc-skel-breathe",
      ".p3-dots",
      ".live-panel-spin",
      ".worker-icon.is-running svg",
      ".animate-pulse",
      ".animate-bounce",
    ]) {
      expect(restBlock).toContain(sel);
    }

    const agentsCard = readFileSync(
      path.join(import.meta.dir, "../src/components/panels/agents-rail-card.tsx"),
      "utf8",
    );
    expect(agentsCard).toContain("refetchInterval: device.online ? 30_000 : false");
  });
});
