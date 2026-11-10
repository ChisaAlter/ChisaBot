/**
 * PR #516 r3：任务卡片 QA r2 的 5 个 P3，加 main 上既有的两处（抽屉关后焦点、液态玻璃下实心按钮图标）。
 */
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
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { panelSheetFinalFocus } from "@/components/panels/panel-rail";
import {
  isStaleActionError,
  railQueryFailed,
  railQueryLoading,
  TasksRailCard,
  workflowRunDescription,
} from "@/components/panels/tasks-rail-card";
import { ClientError } from "@/lib/client";
import { taskCenterKeys } from "@/lib/task-center-api";
import { workflowKeys } from "@/lib/workflows";
import type {
  TaskCenterDecision,
  TaskCenterSnapshot,
} from "../../shared/task-center";
import type { WorkflowRunView } from "../../shared/workflows";
import { lastDecl, stylesCss } from "./contrast-model";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const railCss = readFileSync(
  join(import.meta.dir, "../src/components/panels/tasks-rail-card.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function emptySnapshot(over: Partial<TaskCenterSnapshot> = {}) {
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
    ...over,
  } as TaskCenterSnapshot;
}

const decision: TaskCenterDecision = {
  id: "dec-1",
  taskId: "task-1",
  ownerUserId: "u1",
  taskVersion: 1,
  summary: "准备向团队群发送研发周报草稿",
  proposedAction: {
    title: "发送周报至研发频道",
    description: "发送整理好的周报 Markdown",
    executor: "bot",
    risk: "external",
  },
  status: "pending",
  createdAt: "2026-11-06T16:04:00.000Z",
  decidedAt: null,
  notificationError: null,
} as TaskCenterDecision;

function step(id: string, status: WorkflowRunView["steps"][number]["status"]) {
  return {
    id,
    name: `步骤 ${id}`,
    roleKey: "dev",
    roleName: "开发",
    botId: "b1",
    botName: "Chisa",
    status,
    output: "",
    tokens: 0,
    skills: [],
  };
}

function run(
  over: Partial<WorkflowRunView> & Pick<WorkflowRunView, "steps">,
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "发布前验收流水线",
    icon: "",
    status: "running",
    source: "chat",
    inputs: {},
    usage: { tokens: 0, steps: 0, elapsedMs: 0 },
    limits: {
      maxTokens: 60000,
      maxSteps: 10,
      timeLimitMinutes: 20,
      stepTimeoutMinutes: 5,
    },
    outputFormat: "markdown",
    output: null,
    error: null,
    createdAt: "2026-11-06T16:02:00.000Z",
    startedAt: "2026-11-06T16:02:01.000Z",
    finishedAt: null,
    tools: {},
    ...over,
  } as WorkflowRunView;
}

function staticClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: false,
      },
    },
  });
}

async function renderRail(queryClient: QueryClient) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TasksRailCard />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/tasks",
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/workflows/runs/$runId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RouterProvider router={router} />);
  });
  await settleReactWork();
  return view;
}

// ---------- WCAG 对比度（不跑浏览器，按 styles.css 的真实令牌算） ----------
type RGB = [number, number, number];
function hex(v: string): RGB {
  const m = v.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`not a hex color: ${v}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a: RGB, b: RGB, p: number): RGB =>
  [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as RGB;
function luminance([r, g, b]: RGB) {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrast(a: RGB, b: RGB) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
/** `color-mix(in srgb, var(--x) N%, var(--ink-1))` 里的百分比。 */
function mixPercent(body: string, prop: string, source: string) {
  const m = body.match(
    new RegExp(
      `${prop}:\\s*color-mix\\(in srgb, var\\(${source}\\) (\\d+)%, var\\(--ink-1\\)\\)`,
    ),
  );
  if (!m) throw new Error(`${prop} is not a color-mix of ${source}`);
  return Number(m[1]) / 100;
}
function ruleBody(selector: string) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = railCss.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`missing rule ${selector}`);
  return m[1];
}

describe("P3-1 状态胶囊文字对比度 ≥ 4.5", () => {
  test("状态字和出错说明都用 --task-tone-text，而不是原色调", () => {
    expect(ruleBody(".task-rail-status")).toContain(
      "color: var(--task-tone-text);",
    );
    expect(ruleBody(".task-rail-description[data-error]")).toContain(
      "color: var(--task-tone-text);",
    );
  });

  test("浅色 / 深色 × 默认与 7 种配色 × 5 种色调，在最差的卡片底色上都 ≥ 4.5:1", () => {
    const textMix = mixPercent(
      ruleBody(".task-rail-item"),
      "--task-tone-text",
      "--task-tone",
    );
    const toneMix = (tone: string, token: string) =>
      mixPercent(
        ruleBody(`.task-rail-item[data-tone="${tone}"]`),
        "--task-tone",
        token,
      );
    const palettes = [
      ...stylesCss.matchAll(/html\[data-palette="([a-z]+)"\]\s*\{/g),
    ].map((m) => m[1]);
    expect(palettes.length).toBeGreaterThanOrEqual(7);

    const modes = [
      {
        name: "light",
        root: ":root",
        sel: (p: string) => `html[data-palette="${p}"]`,
        // QA r2 在 4 种玻璃预设下量到的最暗胶囊底是 (217,229,246)；再往暗处留出余量。
        backgrounds: [
          [255, 255, 255],
          [217, 229, 246],
          [200, 212, 230],
        ] as RGB[],
        inks: ["#0f172a", "#111a2b"],
      },
      {
        name: "dark",
        root: ".dark",
        sel: (p: string) => `html.dark[data-palette="${p}"]`,
        // 深色下量到的胶囊底在 (29–36, 35–40, 48–53) 之间；再往亮处留出余量。
        backgrounds: [
          [0, 0, 0],
          [36, 40, 53],
          [56, 62, 78],
        ] as RGB[],
        inks: ["#e9eef8", "#f8fafc"],
      },
    ];
    const failures: string[] = [];
    let worst = Number.POSITIVE_INFINITY;
    for (const mode of modes) {
      const token = (name: string) => {
        const v = lastDecl(stylesCss, mode.root, name);
        if (!v) throw new Error(`${mode.root} ${name} missing`);
        return hex(v);
      };
      for (const inkHex of mode.inks) {
        const ink = hex(inkHex);
        const muted = mix(
          ink,
          mode.name === "light" ? [255, 255, 255] : [16, 25, 44],
          0.76,
        );
        const accents: [string, RGB][] = [
          ["default", token("--accent-blue-ink")],
          ...palettes.map(
            (p) =>
              [
                p,
                hex(lastDecl(stylesCss, mode.sel(p), "--accent-blue-ink")!),
              ] as [string, RGB],
          ),
        ];
        const tones: [string, RGB][] = [
          ...accents.map(([p, c]) => [`info/${p}`, c] as [string, RGB]),
          ["warning", mix(token("--warn"), ink, toneMix("warning", "--warn"))],
          [
            "success",
            mix(token("--success"), ink, toneMix("success", "--success")),
          ],
          [
            "danger",
            mix(token("--danger"), ink, toneMix("danger", "--danger")),
          ],
          ["neutral", muted],
        ];
        for (const [toneName, tone] of tones) {
          const text = mix(tone, ink, textMix);
          for (const bg of mode.backgrounds) {
            const chip = mix(tone, bg, 0.09);
            const ratio = contrast(text, chip);
            worst = Math.min(worst, ratio);
            if (ratio < 4.5)
              failures.push(
                `${mode.name} ink=${inkHex} ${toneName} bg=${bg.join(",")} ${ratio.toFixed(2)}`,
              );
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});

describe("P3-2 出错后的后台轮询不再闪骨架屏", () => {
  test("railQueryFailed / railQueryLoading 的判定", () => {
    // 首次加载
    expect(
      railQueryLoading({
        isPending: true,
        isError: false,
        data: undefined,
        errorUpdateCount: 0,
      }),
    ).toBe(true);
    // 报错后轮询重拉：TanStack 把 status 改回 pending，但仍算失败、不出骨架
    const refetchingAfterError = {
      isPending: true,
      isError: false,
      data: undefined,
      errorUpdateCount: 1,
    };
    expect(railQueryFailed(refetchingAfterError)).toBe(true);
    expect(railQueryLoading(refetchingAfterError)).toBe(false);
    // 有数据后再报错：失败，但不出骨架
    expect(
      railQueryFailed({ isError: true, data: { x: 1 }, errorUpdateCount: 2 }),
    ).toBe(true);
    // 恢复后：不算失败
    expect(
      railQueryFailed({ isError: false, data: { x: 1 }, errorUpdateCount: 2 }),
    ).toBe(false);
  });

  test("任务接口 500 后，后台重拉期间提示一直在、骨架屏不出现", async () => {
    let snapshotCalls = 0;
    let releaseSecond: (() => void) | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workflows"))
        return Response.json({ presets: [], mine: [], runs: [] });
      if (url.endsWith("/api/task-center")) {
        snapshotCalls += 1;
        if (snapshotCalls >= 2)
          await new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
        return Response.json({ error: "x" }, { status: 500 });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
        },
      },
    });
    const view = await renderRail(queryClient);
    const rail = view.getByTestId("tasks-rail-card");
    await waitFor(() =>
      expect(rail.querySelector(".task-rail-notice")).not.toBeNull(),
    );
    expect(rail.querySelector(".task-rail-notice")?.textContent).toContain(
      "任务暂时无法刷新",
    );
    expect(rail.querySelector(".task-rail-loading")).toBeNull();

    // 模拟 5 秒轮询那一次重拉，并让它挂着
    await act(async () => {
      void queryClient.refetchQueries({ queryKey: taskCenterKeys.snapshot });
    });
    await settleReactWork();
    expect(
      queryClient.getQueryState(taskCenterKeys.snapshot)?.fetchStatus,
    ).toBe("fetching");
    expect(queryClient.getQueryState(taskCenterKeys.snapshot)?.status).toBe(
      "pending",
    );
    expect(rail.querySelector(".task-rail-notice")).not.toBeNull();
    expect(rail.querySelector(".task-rail-loading")).toBeNull();
    // 重试按钮也不跟着后台轮询转圈
    expect(
      rail
        .querySelector(".task-rail-notice [data-slot='button']")
        ?.getAttribute("data-btn-state"),
    ).not.toBe("pending");
    // 也不会掉回完整空态
    expect(rail.querySelector(".task-rail-empty")).toBeNull();

    await act(async () => {
      releaseSecond?.();
    });
    await settleReactWork();
    expect(rail.querySelector(".task-rail-notice")).not.toBeNull();
    expect(rail.querySelector(".task-rail-loading")).toBeNull();
  });
});

describe("P3-3 工作流卡片的可读名称是一句完整的话", () => {
  test("读「已完成 2/5 步」，可见标签行和进度条对读屏隐藏", async () => {
    const queryClient = staticClient();
    queryClient.setQueryData(taskCenterKeys.snapshot, emptySnapshot());
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [
        run({
          steps: [
            step("a", "succeeded"),
            step("b", "skipped"),
            step("c", "running"),
            step("d", "pending"),
            step("e", "pending"),
          ],
        }),
      ],
    });
    const view = await renderRail(queryClient);
    const link = view.container.querySelector<HTMLAnchorElement>(
      'article[data-kind="workflow"] a',
    )!;
    expect(link.querySelector(".sr-only")?.textContent).toBe("已完成 2/5 步");
    const label = link.querySelector(".task-rail-progress-label")!;
    expect(label.getAttribute("aria-hidden")).toBe("true");
    const progress = link.querySelector("progress")!;
    expect(progress.getAttribute("aria-hidden")).toBe("true");
    expect(progress.hasAttribute("aria-label")).toBe(false);
    expect(progress.getAttribute("value")).toBe("40");

    // 模拟读屏取可读名称：去掉 aria-hidden 子树后的文字
    const clone = link.cloneNode(true) as HTMLElement;
    for (const hidden of clone.querySelectorAll('[aria-hidden="true"]'))
      hidden.remove();
    const name = clone.textContent ?? "";
    expect(name).toContain("已完成 2/5 步");
    expect(name).not.toContain("步骤进度");
    expect(name).not.toMatch(/\b40\b/);
    expect(name.match(/2\/5/g)).toHaveLength(1);
  });
});

describe("P3-4 步骤都结束但运行还没收尾", () => {
  test("文案按状态区分", () => {
    const done = run({
      steps: [
        step("a", "succeeded"),
        step("b", "skipped"),
        step("c", "succeeded"),
      ],
    });
    expect(workflowRunDescription(done, 3)).toBe("步骤已全部完成，正在收尾…");
    const endedWithFailure = run({
      steps: [step("a", "succeeded"), step("b", "failed")],
    });
    expect(workflowRunDescription(endedWithFailure, 1)).toBe(
      "步骤已结束，正在收尾…",
    );
    expect(
      workflowRunDescription(
        run({ steps: [step("a", "succeeded"), step("b", "running")] }),
        1,
        { name: "步骤 b" },
      ),
    ).toBe("当前：步骤 b");
    expect(
      workflowRunDescription(
        run({ status: "queued", steps: [step("a", "pending")] }),
        0,
      ),
    ).toBe("等待工作流开始");
    expect(workflowRunDescription(run({ steps: [] }), 0)).toBe("准备执行步骤…");
    expect(
      workflowRunDescription(
        run({ steps: [step("a", "succeeded"), step("b", "pending")] }),
        1,
      ),
    ).toBe("准备执行步骤…");
  });

  test("卡片上显示「正在收尾」，不再是「准备执行步骤…」", async () => {
    const queryClient = staticClient();
    queryClient.setQueryData(taskCenterKeys.snapshot, emptySnapshot());
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [
        run({
          steps: [
            step("a", "succeeded"),
            step("b", "succeeded"),
            step("c", "succeeded"),
          ],
        }),
      ],
    });
    const view = await renderRail(queryClient);
    const card = view.container.querySelector('article[data-kind="workflow"]')!;
    expect(card.textContent).toContain("步骤已全部完成，正在收尾…");
    expect(card.textContent).not.toContain("准备执行步骤");
  });
});

describe("P3-5 审批返回 409 后卡片立刻消失", () => {
  test("isStaleActionError 只认 409 / 404", () => {
    expect(isStaleActionError(new ClientError("已处理", 409))).toBe(true);
    expect(isStaleActionError(new ClientError("不存在", 404))).toBe(true);
    expect(isStaleActionError(new ClientError("坏了", 500))).toBe(false);
    expect(isStaleActionError(new Error("网络"))).toBe(false);
  });

  test("点批准拿到 409：不等轮询，卡片马上拿掉并重新拉取", async () => {
    const posts: string[] = [];
    let snapshotGets = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(url);
        return Response.json(
          { error: "这条确认请求已经处理。" },
          { status: 409 },
        );
      }
      if (url.endsWith("/api/task-center")) {
        snapshotGets += 1;
        // 刷新请求故意一直挂着：卡片消失不能依赖它返回
        return new Promise<Response>(() => {});
      }
      return Response.json({ presets: [], mine: [], runs: [] });
    }) as typeof fetch;
    const queryClient = staticClient();
    queryClient.setQueryData(
      taskCenterKeys.snapshot,
      emptySnapshot({ outbox: [decision] }),
    );
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [],
    });
    const view = await renderRail(queryClient);
    expect(view.container.textContent).toContain("发送周报至研发频道");
    const approve = [
      ...view.container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.includes("批准"))!;
    await act(async () => {
      fireEvent.click(approve);
    });
    // 只等 POST 的 409 落地（刷新请求一直挂着，所以卡片消失只能来自 409 的处理）
    await waitFor(() =>
      expect(view.container.textContent).not.toContain("发送周报至研发频道"),
    );
    await settleReactWork();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("/api/task-center/outbox/dec-1/decide");
    expect(
      queryClient.getQueryData<TaskCenterSnapshot>(taskCenterKeys.snapshot)
        ?.outbox,
    ).toEqual([]);
    expect(snapshotGets).toBeGreaterThanOrEqual(1);
  });
});

describe("既有：面板抽屉关闭后焦点回到触发按钮", () => {
  test("panelSheetFinalFocus：打开者还在 → 它；否则 → 重新挂上的把手；都没有 → 交回默认", () => {
    document.body.innerHTML = "";
    expect(panelSheetFinalFocus(null)).toBe(true);

    const handle = document.createElement("button");
    handle.setAttribute("aria-controls", "chisabot-panel-sheet");
    document.body.append(handle);
    expect(panelSheetFinalFocus(null)).toBe(handle);

    const opener = document.createElement("button");
    document.body.append(opener);
    expect(panelSheetFinalFocus(opener)).toBe(opener);

    const sheet = document.createElement("div");
    sheet.id = "chisabot-panel-sheet";
    const inside = document.createElement("button");
    sheet.append(inside);
    document.body.append(sheet);
    expect(panelSheetFinalFocus(inside)).toBe(handle);

    opener.remove();
    expect(panelSheetFinalFocus(opener)).toBe(handle);
    document.body.innerHTML = "";
  });

  test("抽屉接上了 finalFocus，且在打开时记下打开者", () => {
    const rail = readFileSync(
      join(import.meta.dir, "../src/components/panels/panel-rail.tsx"),
      "utf8",
    );
    expect(rail).toContain("finalFocus={sheetFinalFocus}");
    expect(rail).toContain("panelSheetFinalFocus(sheetOpener.current)");
  });
});

describe("既有：液态玻璃下实心按钮的图标不被 blend 冲淡", () => {
  test("实心按钮里的 svg 固定 mix-blend-mode: normal，且优先级高于液态玻璃那条", () => {
    const rule = stylesCss.match(
      /\[data-slot="button"\]\[data-variant="default"\] svg,[^{]*\{([^}]*)\}/,
    );
    expect(rule?.[1]).toContain("mix-blend-mode: normal");
    // 液态玻璃那条：:where(html…) :is(.rail-card, …) :where(svg) → 优先级 (0,1,0)
    expect(stylesCss).toMatch(
      /:is\([^)]*\.rail-card[^)]*\)\s*:where\(svg\)\s*\{\s*mix-blend-mode: var\(--lg-blend, multiply\);/,
    );
    // 本规则 [data-slot][data-variant] svg → (0,2,1)，紧跟在按钮状态规则后面、同为非分层样式，按优先级胜出。
    // 真浏览器里的 getComputedStyle 结果见 /workspace/cb-dev/516-shots/r3/measure.json。
    const idx = stylesCss.indexOf(
      '[data-slot="button"][data-variant="default"] svg',
    );
    expect(stylesCss.slice(idx - 400, idx)).toContain(
      '[data-slot="button"][data-variant="link"][data-btn-state="error"]',
    );
  });
});
