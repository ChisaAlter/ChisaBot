import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  BrowserActivity,
  deriveActiveBrowserStatus,
  groupBrowserSteps,
  projectBrowserGroup,
} from "@/components/channels/browser-activity";
import type { VisibleChatItem } from "@/components/channels/chat-messages";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  BrowserLiveCard,
  type BrowserOpenTabTarget,
  BrowserStatusBar,
} from "@/components/computer/browser-live-card";
import {
  clearRememberedShots,
  keepShot,
} from "@/components/computer/screenshot-card";
import { ChromeExtensionCard } from "@/components/devices/chrome-extension-card";
import { DeviceRow } from "@/components/devices/devices";
import {
  browserExtensionDownloadQueryOptions,
  DEVICE_KIND_LABEL,
  deviceKind,
  platformLabel,
} from "@/lib/devices";
import { type DeviceView, defaultCapabilities } from "../../shared/devices";
import { settleReactWork } from "./settle-react-work";
import { renderWithRouter } from "./support/render-with-router";

beforeAll(() => {
  if (!globalThis.document) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});

beforeEach(() => {
  window.localStorage.clear();
  clearRememberedShots();
});

afterEach(async () => {
  cleanup();
  await settleReactWork();
});

afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

function withQuery(node: ReactNode, enabled = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function makeToolStep(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result?: unknown,
): Extract<VisibleChatItem, { kind: "tool" }> {
  return {
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    ...(result !== undefined
      ? { result: typeof result === "string" ? result : JSON.stringify(result) }
      : {}),
  };
}

function makeExtensionDevice(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: "dev_ext_1",
    ownerUserId: "user_1",
    name: "办公电脑 Chrome",
    platform: "browser_extension",
    osVersion: "Chrome 134",
    hostname: null,
    arch: null,
    clientVersion: "0.1.0",
    capabilities: defaultCapabilities(),
    allowedRoots: [],
    paused: false,
    revoked: false,
    online: true,
    lastSeenAt: new Date().toISOString(),
    lastIp: "127.0.0.1",
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: {
      botId: "bot_whale",
      botName: "鲸鱼娘",
      at: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe("BrowserLiveCard 渲染、角色徽章、实时缩略图与打开标签页", () => {
  test("渲染角色头像动作徽章、bubble 单通道材质、骨架与实时缩略图更新并支持 Lightbox 放大", async () => {
    const opened: BrowserOpenTabTarget[] = [];
    const view = render(
      <BrowserLiveCard
        botName="鲸鱼娘"
        enableCloudFrameFetch={false}
        onOpenTab={(target) => {
          opened.push(target);
        }}
        phaseBadge="检查服务器"
        runKey="run-1"
        running
        source="extension"
        stepLabel="继续向下查看内存、网卡与流量图表"
        tabId={42}
        tabTitle="云监控面板"
        tabUrl="https://console.example.com/metrics"
      />,
    );

    const badge = view.getByTestId("browser-live-badge");
    expect(badge.textContent).toContain("鲸鱼娘");
    expect(badge.textContent).toContain("检查服务器");
    expect(badge.getAttribute("data-surface")).toBe("control");
    expect(view.getByTestId("browser-live-running-dot")).toBeTruthy();

    const card = view.getByTestId("browser-live-card");
    expect(card.getAttribute("data-surface")).toBe("bubble");
    expect(card.getAttribute("data-source")).toBe("extension");
    expect(view.getByTestId("browser-live-step").textContent).toBe(
      "继续向下查看内存、网卡与流量图表",
    );
    expect(view.getByTestId("browser-live-skeleton")).toBeTruthy();

    // 实时帧到达后平滑切换为缩略图，点击弹出 Lightbox
    const sampleShot =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    view.rerender(
      <BrowserLiveCard
        botName="鲸鱼娘"
        enableCloudFrameFetch={false}
        onOpenTab={(target) => {
          opened.push(target);
        }}
        phaseBadge="检查服务器"
        runKey="run-1"
        running={false}
        shotUrl={sampleShot}
        source="extension"
        stepLabel="已完成监控页巡检"
        tabId={42}
        tabTitle="云监控面板"
        tabUrl="https://console.example.com/metrics"
      />,
    );

    const img = view.getByTestId("browser-live-thumb") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(sampleShot);
    expect(view.queryByTestId("browser-live-running-dot")).toBeNull();

    // 点击缩略图打开 Lightbox
    fireEvent.click(view.getByTestId("browser-live-thumb-btn"));
    expect(document.body.textContent).toContain("浏览器预览-console.example.com.jpg");
    expect(document.body.textContent).toContain("下载");

    // 点击底部全宽「打开标签页」调用外部注入回调（携带真实 tabId）
    fireEvent.click(view.getByTestId("browser-live-open-tab"));
    expect(opened).toEqual([
      {
        source: "extension",
        tabId: 42,
        url: "https://console.example.com/metrics",
        title: "云监控面板",
      },
    ]);
  });

  test("复用 chat-shots 本地缓存持久化并支持步骤列表折叠与高危审批槽", () => {
    const sampleShot =
      "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      keepShot("shot-persisted-1", sampleShot, "https://ops.example.com", "bot-1");
      const view = render(
        <BrowserLiveCard
          approvalSlot={<div data-testid="mock-approval">高危审批卡</div>}
          botName="鲸鱼娘"
          enableCloudFrameFetch={false}
          issues={1}
          runKey="run-2"
          running={false}
          shotId="shot-persisted-1"
          source="cloud"
          stepLabel="已读取监控页"
          steps={[
            {
              id: "s1",
              toolName: "computer_navigate",
              toolCallId: "s1",
              label: "打开了页面",
              href: "https://ops.example.com",
              title: "ops.example.com",
              failed: false,
              pending: false,
            },
            {
              id: "s2",
              toolName: "computer_click",
              toolCallId: "s2",
              label: "点击了页面",
              failed: true,
              reason: "操作已被安全策略拦截",
              pending: false,
            },
          ]}
          tabUrl="https://ops.example.com"
        />,
      );

      expect(view.getByTestId("browser-live-thumb").getAttribute("src")).toBe(
        sampleShot,
      );
      expect(view.getByTestId("mock-approval")).toBeTruthy();
      expect(view.queryByTestId("browser-live-steps")).toBeNull();

      // 展开步骤列表
      fireEvent.click(view.getByTestId("browser-live-steps-toggle"));
      const list = view.getByTestId("browser-live-steps");
      expect(list.textContent).toContain("打开了页面");
      expect(list.textContent).toContain("操作已被安全策略拦截");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("双源工具聚合（computer_* + browser_*）与输入框上方实时状态横条", () => {
  test("连续的 browser_* 本机扩展工具与 computer_* 云端工具聚合渲染为 BrowserLiveCard", () => {
    const steps: VisibleChatItem[] = [
      makeToolStep(
        "c1",
        "browser_navigate",
        { url: "https://dash.example.com/server" },
        {
          ok: true,
          source: "extension",
          tabId: 18,
          url: "https://dash.example.com/server",
          title: "服务器监控",
          stepLabel: "打开服务器监控面板",
        },
      ),
      makeToolStep(
        "c2",
        "browser_scroll",
        { deltaY: 600 },
        {
          ok: true,
          source: "extension",
          tabId: 18,
          url: "https://dash.example.com/server",
          title: "服务器监控",
          stepLabel: "继续向下查看内存、网卡与流量图表",
          shotUrl: "/api/chat-shots/shot-c2",
        },
      ),
      makeToolStep("cmd1", "computer_run_command", { command: "uptime" }, { ok: true }),
      makeToolStep(
        "c3",
        "computer_navigate",
        { url: "https://docs.example.com" },
        { ok: true, url: "https://docs.example.com", title: "文档中心" },
      ),
    ];

    const grouped = groupBrowserSteps(steps);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.kind).toBe("browser");
    expect(grouped[1]?.kind).toBe("tool");
    expect(grouped[2]?.kind).toBe("browser");

    const extGroup = grouped[0];
    if (extGroup?.kind !== "browser") throw new Error("expected browser group");
    expect(extGroup.steps).toHaveLength(2);

    const projected = projectBrowserGroup(extGroup, {
      active: false,
      botName: "鲸鱼娘",
    });
    expect(projected.payload.source).toBe("extension");
    expect(projected.payload.tabId).toBe(18);
    expect(projected.payload.shotUrl).toBe("/api/chat-shots/shot-c2");
    expect(projected.payload.stepLabel).toBe("继续向下查看内存、网卡与流量图表");

    const view = render(
      <BrowserActivity active={false} botName="鲸鱼娘" group={extGroup} />,
    );
    expect(view.getByTestId("browser-live-card").getAttribute("data-source")).toBe(
      "extension",
    );
    expect(view.getByTestId("browser-live-step").textContent).toBe(
      "继续向下查看内存、网卡与流量图表",
    );

    // 仅含进行中步骤时不应把 pending toolCall.id 当作已完成截图地址，应先展示骨架屏；
    // 且返回 yielded_to_human 时应展示「已礼让暂停」微标。
    const pendingGroup = groupBrowserSteps([
      makeToolStep("p1", "browser_navigate", {
        url: "https://status.example.com",
      }),
    ])[0];
    if (pendingGroup?.kind !== "browser") throw new Error("expected browser group");
    const pendingProjected = projectBrowserGroup(pendingGroup, { active: true });
    expect(pendingProjected.shotId).toBeUndefined();
    expect(pendingProjected.payload.running).toBe(true);
    view.rerender(
      <BrowserActivity active botName="鲸鱼娘" group={pendingGroup} />,
    );
    expect(view.getByTestId("browser-live-skeleton")).toBeTruthy();

    const yieldedGroup = groupBrowserSteps([
      makeToolStep(
        "y1",
        "browser_click",
        { ref: "e5" },
        {
          ok: true,
          source: "extension",
          state: "yielded_to_human",
          stepLabel: "检测到真人接手，已礼让暂停",
        },
      ),
    ])[0];
    if (yieldedGroup?.kind !== "browser") throw new Error("expected browser group");
    view.rerender(
      <BrowserActivity active={false} botName="鲸鱼娘" group={yieldedGroup} />,
    );
    expect(view.getByTestId("browser-live-card").textContent).toContain(
      "已礼让暂停",
    );
  });

  test("deriveActiveBrowserStatus 继承同轮前序标签页信息，且 ConversationView 状态横条运行中展示并结束后收起", () => {
    const runningMessages = [
      { id: "u1", role: "user", content: "看看我当前 Chrome 里的服务器监控" },
      {
        id: "a0",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "b0",
            type: "function",
            function: {
              name: "browser_navigate",
              arguments: JSON.stringify({ url: "https://console.example.com/net" }),
            },
          },
        ],
      },
      {
        id: "t0",
        role: "tool",
        toolCallId: "b0",
        content: JSON.stringify({
          ok: true,
          source: "extension",
          tabId: 9,
          url: "https://console.example.com/net",
          title: "网卡监控",
        }),
      },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "b1",
            type: "function",
            function: {
              name: "browser_hover",
              arguments: JSON.stringify({
                ref: "e12",
                snapshotId: 3,
                stepLabel: "悬停查看网卡峰值图表",
              }),
            },
          },
        ],
      },
    ] as unknown as Message[];

    const activeStatus = deriveActiveBrowserStatus(runningMessages, true);
    expect(activeStatus).toEqual({
      active: true,
      source: "extension",
      stepLabel: "悬停查看网卡峰值图表",
      tabId: 9,
      tabUrl: "https://console.example.com/net",
      tabTitle: "网卡监控",
    });
    expect(deriveActiveBrowserStatus(runningMessages, false)).toBeNull();

    const opened: BrowserOpenTabTarget[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const view = render(
        withQuery(
          <ConversationView
            busy
            messages={runningMessages}
            onOpenBrowserTab={(target) => {
              opened.push(target);
            }}
            onSubmit={() => {}}
          />,
          false,
        ),
      );

      const bar = view.getByTestId("browser-status-bar");
      expect(bar.getAttribute("data-surface")).toBe("bubble");
      expect(bar.textContent).toContain("浏览器");
      expect(bar.textContent).toContain("悬停查看网卡峰值图表");

      fireEvent.click(view.getByTestId("browser-status-open-tab"));
      expect(opened[0]).toEqual({
        source: "extension",
        tabId: 9,
        url: "https://console.example.com/net",
        title: "网卡监控",
      });

      // 回合结束后状态横条平滑收起（open=false）
      view.rerender(
        withQuery(
          <ConversationView
            busy={false}
            messages={runningMessages}
            onOpenBrowserTab={(target) => {
              opened.push(target);
            }}
            onSubmit={() => {}}
          />,
          false,
        ),
      );
      const collapseWrapper = view
        .queryByTestId("browser-status-bar")
        ?.closest("[data-open]");
      if (collapseWrapper) {
        expect(collapseWrapper.getAttribute("data-open")).toBe("false");
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("BrowserStatusBar 独立渲染遵循单行状态与回调约定", () => {
    const clicks: BrowserOpenTabTarget[] = [];
    const view = render(
      <BrowserStatusBar
        active
        onOpenTab={(t) => {
          clicks.push(t);
        }}
        source="cloud"
        stepLabel="正在打开 github.com"
        tabUrl="https://github.com"
      />,
    );
    expect(view.getByTestId("browser-status-text").textContent).toBe(
      "正在打开 github.com",
    );
    fireEvent.click(view.getByTestId("browser-status-open-tab"));
    expect(clicks).toEqual([{ source: "cloud", url: "https://github.com/" }]);
  });
});

describe("设置 → 设备页 Chrome / Edge 浏览器扩展卡片与设备行", () => {
  test("deviceKind 与 platformLabel 正确识别 browser_extension，且 browserExtensionDownloadQueryOptions 正确解析 meta", async () => {
    const ext = makeExtensionDevice();
    expect(deviceKind(ext)).toBe("extension");
    expect(DEVICE_KIND_LABEL[deviceKind(ext)]).toBe("浏览器扩展");
    expect(platformLabel(ext.platform)).toBe("Chrome / Edge 扩展");

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/devices/extension/meta")) {
        return new Response(
          JSON.stringify({
            available: true,
            version: "0.2.0",
            filename: "chisabot-chrome-extension.zip",
            bytes: 102_400,
            sha256: "deadbeef",
            downloadUrl: "/api/devices/extension/download",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const opts = browserExtensionDownloadQueryOptions();
      const queryClient = new QueryClient();
      const data = await queryClient.fetchQuery(opts);
      expect(data).toEqual({
        available: true,
        version: "0.2.0",
        filename: "chisabot-chrome-extension.zip",
        bytes: 102_400,
        sha256: "deadbeef",
        downloadUrl: "/api/devices/extension/download",
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("ChromeExtensionCard 展示下载状态、三步安装指引并支持下载与生成扩展绑定码", async () => {
    const downloads: Array<{ url: string; filename: string }> = [];
    const pairingBodies: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/devices/pairing") && init?.method === "POST") {
        pairingBodies.push(JSON.parse(String(init.body ?? "{}")));
        return new Response(
          JSON.stringify({
            id: "pair_ext_1",
            code: "cbp_ext_998877",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            ttlSeconds: 300,
            kind: "extension",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const view = render(
        withQuery(
          <ChromeExtensionCard
            meta={{
              available: true,
              version: "0.1.0",
              filename: "chisabot-chrome-extension.zip",
              bytes: 245_760,
              sha256: "abc123def456",
              downloadUrl: "/api/devices/extension/download",
            }}
            onDownload={async (url, filename) => {
              downloads.push({ url, filename });
            }}
          />,
        ),
      );

      expect(view.container.textContent).toContain("Chrome / Edge 浏览器扩展");
      expect(view.container.textContent).toContain("版本 0.1.0");
      expect(view.container.textContent).toContain("240 KB");
      expect(view.container.textContent).toContain("abc123def456");

      const steps = view.getByTestId("chrome-extension-install-steps");
      expect(steps.textContent).toContain("chrome://extensions");
      expect(steps.textContent).toContain("开发者模式");
      expect(steps.textContent).toContain("加载已解压的扩展程序");

      // 一键下载 ZIP
      const downloadBtn = view.getByTestId(
        "chrome-extension-download-btn",
      ) as HTMLButtonElement;
      expect(downloadBtn.disabled).toBe(false);
      await act(async () => {
        fireEvent.click(downloadBtn);
      });
      await waitFor(() =>
        expect(downloads).toEqual([
          {
            url: "/api/devices/extension/download",
            filename: "chisabot-chrome-extension.zip",
          },
        ]),
      );

      // 生成一次性扩展绑定码
      await act(async () => {
        fireEvent.click(view.getByTestId("chrome-extension-pair-btn"));
      });
      await waitFor(() =>
        expect(view.getByTestId("chrome-extension-pair-code").textContent).toBe(
          "cbp_ext_998877",
        ),
      );
      expect(pairingBodies).toEqual([{ kind: "extension" }]);

      // 服务端尚未发布安装包时，下载按钮应禁用并给出中文提示
      view.rerender(
        withQuery(<ChromeExtensionCard meta={{ available: false }} />),
      );
      expect(
        (
          view.getByTestId("chrome-extension-download-btn") as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(view.container.textContent).toContain("扩展安装包尚未发布到这台服务器");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("DeviceRow 正确展示 browser_extension 设备的专属标签、实时权限档位、在线/急停状态而不误报能力全部关闭", async () => {
    const view = await renderWithRouter(
      <DeviceRow
        device={makeExtensionDevice({
          online: true,
          paused: false,
          companionState: {
            state: "controlling",
            tier: "cautious",
            allowRemoteDispatch: true,
            attached: true,
            attachedTabId: 7,
            tabGroupId: 2,
            tabCount: 3,
          },
        })}
      />,
    );
    expect(view.container.textContent).toContain("办公电脑 Chrome");
    expect(view.container.textContent).toContain("浏览器扩展");
    expect(view.container.textContent).toContain("本机浏览器伴侣 · 谨慎操作");
    expect(view.container.textContent).toContain("允许跨端调度");
    expect(view.container.textContent).toContain("3 个受控标签页");
    expect(view.container.textContent).toContain("在线");
    expect(view.container.textContent).not.toContain("能力全部关闭");

    const pausedView = await renderWithRouter(
      <DeviceRow device={makeExtensionDevice({ online: true, paused: true })} />,
    );
    expect(pausedView.container.textContent).toContain("已紧急停止");
  });
});
