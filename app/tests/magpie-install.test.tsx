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
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  installStepIndex,
  MagpieInstallCard,
  type MagpieInstallView,
  magpieInstallView,
} from "@/components/magpie/magpie-install";
import type {
  SystemUpdateJob,
  SystemUpdateOverview,
} from "../../shared/system-update";
import { settleReactWork } from "./settle-react-work";

/**
 * 一键安装 Magpie（DESIGN.md §15「一键安装」）。页面状态由两份数据决定：`/api/admin/magpie` 说
 * Magpie 有没有接上，`/api/admin/system-update` 说宿主机更新程序在不在、会不会装、装到哪一步。
 * 这里把每一种组合钉住，再渲染几个关键状态看文案、按钮和进度。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const NOW = "2026-11-10T02:00:00Z";

function overview(
  patch: Partial<SystemUpdateOverview> = {},
): SystemUpdateOverview {
  return {
    updaterOnline: true,
    configured: true,
    updaterVersion: 4,
    updaterOutdated: false,
    warnings: [],
    running: { version: "0.1.138", buildId: "dev" },
    behind: 0,
    commits: [],
    depsChanged: false,
    estimates: {},
    externalBusy: false,
    job: null,
    pending: [],
    history: [],
    magpie: { installed: false, updateAvailable: false, installable: true },
    ...patch,
  };
}

function job(patch: Partial<SystemUpdateJob> = {}): SystemUpdateJob {
  return {
    id: "magpie-abc123",
    action: "magpie",
    status: "running",
    step: "pull",
    startedAt: NOW,
    log: [],
    ...patch,
  };
}

const notConfigured = { configured: false };

describe("magpieInstallView", () => {
  test("已经接上 Magpie 的部署（含手动配置的）：不显示安装", () => {
    expect(magpieInstallView({ configured: true }, overview())).toBeNull();
    expect(
      magpieInstallView({ configured: true }, overview({ configured: false })),
    ).toBeNull();
  });

  test("没装宿主机更新程序：给出要在服务器上运行的命令", () => {
    const view = magpieInstallView(
      notConfigured,
      overview({ configured: false, sourceDir: "/srv/chisabot" }),
    );
    expect(view).toEqual({
      kind: "no-updater",
      command:
        "cd /srv/chisabot && git pull && sudo sh deploy/install-updater.sh",
    });
  });

  test("更新程序太旧、或它的 magpie.sh 还不会装：先系统更新，不给按钮", () => {
    expect(
      magpieInstallView(notConfigured, overview({ updaterOutdated: true }))
        ?.kind,
    ).toBe("outdated");
    expect(
      magpieInstallView(
        notConfigured,
        overview({ magpie: { installed: false, updateAvailable: false } }),
      )?.kind,
    ).toBe("outdated");
    expect(
      magpieInstallView(notConfigured, overview({ magpie: undefined }))?.kind,
    ).toBe("outdated");
  });

  test("更新程序没在运行 / 正在做别的更新：不能装", () => {
    expect(
      magpieInstallView(notConfigured, overview({ updaterOnline: false }))
        ?.kind,
    ).toBe("offline");
    expect(
      magpieInstallView(notConfigured, overview({ pending: ["update"] }))?.kind,
    ).toBe("busy");
    expect(
      magpieInstallView(notConfigured, overview({ externalBusy: true }))?.kind,
    ).toBe("busy");
    expect(
      magpieInstallView(
        notConfigured,
        overview({ job: job({ action: "update", status: "running" }) }),
      )?.kind,
    ).toBe("busy");
    // 一次「检查更新」不算忙。
    expect(
      magpieInstallView(notConfigured, overview({ pending: ["check"] }))?.kind,
    ).toBe("ready");
  });

  test("一切就绪：可以一键安装", () => {
    expect(magpieInstallView(notConfigured, overview())).toEqual({
      kind: "ready",
    });
  });

  test("排队 → 进行中 → 装好等接入", () => {
    expect(
      magpieInstallView(notConfigured, overview({ pending: ["magpie"] }))?.kind,
    ).toBe("queued");
    const running = magpieInstallView(notConfigured, overview({ job: job() }));
    expect(running?.kind).toBe("running");
    expect(
      magpieInstallView(
        notConfigured,
        overview({
          job: job({ status: "succeeded", step: "done" }),
          magpie: {
            installed: true,
            managed: true,
            updateAvailable: false,
            installable: true,
          },
        }),
      )?.kind,
    ).toBe("connecting");
  });

  test("失败给原因、可以重试；被宿主机拒掉的请求也要显示", () => {
    const failed = magpieInstallView(
      notConfigured,
      overview({
        job: job({
          status: "failed",
          step: "verify",
          error: "镜像签名校验没有通过",
          finishedAt: NOW,
        }),
      }),
    );
    expect(failed).toMatchObject({
      kind: "failed",
      error: "镜像签名校验没有通过",
    });
    const rejected = magpieInstallView(
      notConfigured,
      overview({
        history: [
          {
            id: "magpie-r1",
            action: "magpie",
            status: "rejected",
            at: NOW,
            error: "已经有一个更新或回滚在进行",
          },
        ],
      }),
    );
    expect(rejected).toEqual({
      kind: "failed",
      error: "已经有一个更新或回滚在进行",
    });
  });

  test("服务器上已有别人装的 Magpie：不提供安装，不去覆盖", () => {
    expect(
      magpieInstallView(
        notConfigured,
        overview({
          magpie: {
            installed: true,
            updateAvailable: false,
            installable: true,
          },
        }),
      )?.kind,
    ).toBe("external");
  });

  test("进度条步骤：done 停在最后、未知 key 不倒退", () => {
    expect(installStepIndex("pull")).toBe(1);
    expect(installStepIndex("connect")).toBe(5);
    expect(installStepIndex("done")).toBe(5);
    expect(installStepIndex("something-new")).toBe(0);
    expect(installStepIndex()).toBe(0);
  });
});

async function renderCard(
  view: MagpieInstallView,
  extra: { requestError?: string; onInstall?: () => void } = {},
) {
  const rootRoute = createRootRoute({
    component: () => (
      <MagpieInstallCard
        onInstall={extra.onInstall}
        requestError={extra.requestError}
        view={view}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
  const result = render(wrap(<RouterProvider router={router} />));
  await waitFor(() =>
    expect(result.container.querySelector(".magpie-install")).not.toBeNull(),
  );
  return result;
}

describe("MagpieInstallCard", () => {
  test("就绪：标题、来源说明和「一键安装」", async () => {
    let clicked = 0;
    const view = await renderCard(
      { kind: "ready" },
      { onInstall: () => (clicked += 1) },
    );
    expect(view.getByText("这台服务器还没有 Magpie")).toBeTruthy();
    expect(view.getByText(/官方镜像 ghcr\.io\/yetone\/magpie/u)).toBeTruthy();
    expect(view.getByText(/校验官方签名，不通过就不启动/u)).toBeTruthy();
    const button = view.getByRole("button", { name: /一键安装/u });
    button.click();
    expect(clicked).toBe(1);
  });

  test("进行中：六步进度、当前步骤、最后一行日志，没有安装按钮", async () => {
    const view = await renderCard({
      kind: "running",
      job: job({
        step: "verify",
        log: [
          "签名校验通过：这份镜像由 github.com/yetone/magpie 的官方 CI 构建",
        ],
      }),
    });
    expect(view.getByText("正在安装 Magpie")).toBeTruthy();
    const steps = [
      ...view.container.querySelectorAll(".magpie-install-steps li"),
    ];
    expect(steps.map((li) => li.textContent)).toEqual([
      "准备",
      "拉取官方镜像",
      "校验来源",
      "启动",
      "健康检查",
      "接入 ChisaBot",
    ]);
    expect(steps.map((li) => li.getAttribute("data-step"))).toEqual([
      "done",
      "done",
      "active",
      "todo",
      "todo",
      "todo",
    ]);
    expect(view.getByText(/签名校验通过/u)).toBeTruthy();
    expect(view.queryByRole("button", { name: /安装/u })).toBeNull();
    expect(
      view.container
        .querySelector(".magpie-install")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  test("失败：在哪一步断的、原因、重试和日志入口", async () => {
    const view = await renderCard({
      kind: "failed",
      error:
        "Magpie 启动后 60 秒内没有响应，已停掉这个容器；安装目录保留，可以直接重试",
      job: job({ status: "failed", step: "health" }),
    });
    expect(view.getByText("Magpie 没有装好")).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain("没有响应");
    const states = [
      ...view.container.querySelectorAll(".magpie-install-steps li"),
    ].map((li) => li.getAttribute("data-step"));
    expect(states).toEqual(["done", "done", "done", "done", "failed", "todo"]);
    expect(view.getByRole("button", { name: /重试安装/u })).toBeTruthy();
    expect(
      view.getByText("查看完整日志").closest("a")?.getAttribute("href"),
    ).toBe("/admin/system-update");
  });

  test("请求被服务器拒绝时把原因显示出来", async () => {
    const view = await renderCard(
      { kind: "ready" },
      { requestError: "宿主机更新程序没有在运行，暂时不能更新或回滚。" },
    );
    expect(view.getByRole("alert").textContent).toContain("没有在运行");
  });

  test("没有更新程序：命令可复制；太旧：去系统更新", async () => {
    const command =
      "cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh";
    const first = await renderCard({ kind: "no-updater", command });
    expect(first.getByText(command)).toBeTruthy();
    expect(first.queryByRole("button", { name: /一键安装/u })).toBeNull();
    cleanup();
    const second = await renderCard({ kind: "outdated" });
    expect(
      second.getByText("前往系统更新").closest("a")?.getAttribute("href"),
    ).toBe("/admin/system-update");
  });

  test("装好等接入：最后一步在转", async () => {
    const view = await renderCard({ kind: "connecting" });
    expect(view.getByText("Magpie 已安装，正在接入")).toBeTruthy();
    const states = [
      ...view.container.querySelectorAll(".magpie-install-steps li"),
    ].map((li) => li.getAttribute("data-step"));
    expect(states.at(-1)).toBe("active");
    expect(states.slice(0, -1).every((state) => state === "done")).toBe(true);
  });
});
