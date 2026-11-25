import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  AppPackagesPanel,
  McpEnhancementsCard,
} from "@/components/settings/app-packages-panel";
import {
  type AppPackageDetail,
  type AppPackageSummary,
  appPackagesKeys,
  formatMcpTransportLabel,
  isMcpTransportMode,
  MCP_TRANSPORT_LABELS,
  MCP_TRANSPORT_MODES,
  type McpServerEnhancementView,
  mcpEnhancementQueryOptions,
  normalizeMcpTransportMode,
  updateMcpEnhancement,
} from "@/lib/app-packages";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function selectOption(option: HTMLElement) {
  fireEvent.pointerDown(option, { button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
  fireEvent.click(option);
}

function makeEnhancement(
  overrides: Partial<McpServerEnhancementView> = {},
): McpServerEnhancementView {
  return {
    serverId: "acme-mcp",
    transport: "streamable-http",
    customInstructions: "初始指令",
    disabledTools: [],
    customHeaderKeys: [],
    oauth: null,
    lastGood: null,
    updatedAt: "2026-11-25T00:00:00.000Z",
    updatedBy: "admin@example.com",
    ...overrides,
  };
}

describe("MCP 远端传输模式（auto / streamable-http / sse）解析与 UI", () => {
  beforeEach(() => {
    global.fetch = Object.assign(
      async () => new Response(JSON.stringify({}), { status: 200 }),
      { preconnect: originalFetch.preconnect },
    );
  });

  test("前端辅助函数完整识别、归一化与格式化 auto / streamable-http / sse", () => {
    expect(MCP_TRANSPORT_MODES).toEqual(["auto", "streamable-http", "sse"]);
    expect(isMcpTransportMode("auto")).toBe(true);
    expect(isMcpTransportMode("streamable-http")).toBe(true);
    expect(isMcpTransportMode("sse")).toBe(true);
    expect(isMcpTransportMode("websocket")).toBe(false);

    expect(normalizeMcpTransportMode("auto")).toBe("auto");
    expect(normalizeMcpTransportMode("sse")).toBe("sse");
    expect(normalizeMcpTransportMode("streamable-http")).toBe(
      "streamable-http",
    );
    expect(normalizeMcpTransportMode("unknown-mode")).toBe("streamable-http");

    expect(formatMcpTransportLabel("auto")).toBe(MCP_TRANSPORT_LABELS.auto);
    expect(formatMcpTransportLabel("auto")).toContain("自动");
  });

  test("mcpEnhancementQueryOptions 与 updateMcpEnhancement 原样保留 auto 模式", async () => {
    const serverState = makeEnhancement({ transport: "auto" });
    global.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (
          url === "/api/mcp-enhancements/acme-mcp" &&
          (!init?.method || init.method === "GET")
        ) {
          return Response.json({ enhancement: serverState });
        }
        if (
          url === "/api/mcp-enhancements/acme-mcp" &&
          init?.method === "PUT"
        ) {
          const patch = JSON.parse(String(init.body ?? "{}")) as {
            transport?: McpServerEnhancementView["transport"];
          };
          return Response.json({
            enhancement: {
              ...serverState,
              transport: patch.transport ?? serverState.transport,
            },
          });
        }
        return new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );

    const queryClient = makeQueryClient();
    const fetched = await queryClient.fetchQuery(
      mcpEnhancementQueryOptions("acme-mcp"),
    );
    expect(fetched?.transport).toBe("auto");

    const updated = await updateMcpEnhancement("acme-mcp", {
      transport: "auto",
    });
    expect(updated.transport).toBe("auto");
  });

  test("McpEnhancementsCard 正确回显服务端保存的 auto 模式，并支持下拉切换与保存 auto", async () => {
    let current = makeEnhancement({
      serverId: "srv-echo",
      transport: "auto",
      customInstructions: "保持 auto",
    });
    const sentPayloads: Array<Record<string, unknown>> = [];

    global.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (
          url === "/api/mcp-enhancements/srv-echo" &&
          (!init?.method || init.method === "GET")
        ) {
          return Response.json({ enhancement: current });
        }
        if (
          url === "/api/mcp-enhancements/srv-echo" &&
          init?.method === "PUT"
        ) {
          const body = JSON.parse(String(init.body ?? "{}")) as Record<
            string,
            unknown
          >;
          sentPayloads.push(body);
          current = makeEnhancement({
            serverId: "srv-echo",
            transport: normalizeMcpTransportMode(body.transport),
            customInstructions:
              typeof body.customInstructions === "string"
                ? body.customInstructions
                : current.customInstructions,
          });
          return Response.json({ enhancement: current });
        }
        return new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );

    const queryClient = makeQueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <McpEnhancementsCard serverId="srv-echo" toolNames={["ping"]} />
      </QueryClientProvider>,
    );

    const trigger = await view.findByTestId("mcp-transport-select");
    expect(trigger.textContent).toContain(MCP_TRANSPORT_LABELS.auto);

    // 切换到 sse 再保存
    fireEvent.click(trigger);
    const sseOption = await view.findByTestId("mcp-transport-option-sse");
    expect(view.getByTestId("mcp-transport-option-auto")).toBeTruthy();
    expect(
      view.getByTestId("mcp-transport-option-streamable-http"),
    ).toBeTruthy();
    selectOption(sseOption);
    await waitFor(() => {
      expect(trigger.textContent).toContain(MCP_TRANSPORT_LABELS.sse);
    });

    fireEvent.click(view.getByRole("button", { name: "保存传输与使用指引" }));
    await waitFor(() => {
      expect(sentPayloads.length).toBe(1);
    });
    expect(sentPayloads[0]?.transport).toBe("sse");

    // 切回 auto 并保存，确认发包与保存后回显都是 auto
    fireEvent.click(trigger);
    const autoOption = await view.findByTestId("mcp-transport-option-auto");
    selectOption(autoOption);
    await waitFor(() => {
      expect(trigger.textContent).toContain(MCP_TRANSPORT_LABELS.auto);
    });

    fireEvent.click(view.getByRole("button", { name: "保存传输与使用指引" }));
    await waitFor(() => {
      expect(sentPayloads.length).toBe(2);
    });
    expect(sentPayloads[1]?.transport).toBe("auto");
    expect(trigger.textContent).toContain(MCP_TRANSPORT_LABELS.auto);
  });

  test("切换 serverId 时重置未保存的传输协议草稿并回显新服务器的配置", async () => {
    const byServer: Record<string, McpServerEnhancementView> = {
      "srv-a": makeEnhancement({
        serverId: "srv-a",
        transport: "streamable-http",
      }),
      "srv-b": makeEnhancement({
        serverId: "srv-b",
        transport: "auto",
      }),
    };

    global.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const match = String(input).match(
          /^\/api\/mcp-enhancements\/([^/?]+)$/,
        );
        const id = match?.[1];
        if (id && byServer[id]) {
          return Response.json({ enhancement: byServer[id] });
        }
        return new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );

    const queryClient = makeQueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <McpEnhancementsCard serverId="srv-a" toolNames={[]} />
      </QueryClientProvider>,
    );

    const trigger = await view.findByTestId("mcp-transport-select");
    expect(trigger.textContent).toContain(
      MCP_TRANSPORT_LABELS["streamable-http"],
    );

    // 未保存的 sse 草稿
    fireEvent.click(trigger);
    selectOption(await view.findByTestId("mcp-transport-option-sse"));
    await waitFor(() => {
      expect(trigger.textContent).toContain(MCP_TRANSPORT_LABELS.sse);
    });

    // 切换到 srv-b，草稿必须清零并回显 srv-b 的 auto
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <McpEnhancementsCard serverId="srv-b" toolNames={[]} />
      </QueryClientProvider>,
    );

    const triggerB = await view.findByTestId("mcp-transport-select");
    await waitFor(() => {
      expect(triggerB.textContent).toContain(MCP_TRANSPORT_LABELS.auto);
    });
  });

  test("AppPackagesPanel 源码审阅弹窗正确格式化 remote-mcp 的 auto 传输标签", async () => {
    const pkgSummary: AppPackageSummary = {
      id: "remote-auto-app",
      status: "draft",
      installed: false,
      enabled: false,
      currentDigest: "a".repeat(64),
      approvedDigest: null,
      needsReview: true,
      version: "1.0.0",
      name: { en: "Remote Auto", "zh-CN": "远端自动协商 MCP" },
      description: { en: "desc", "zh-CN": "描述" },
      publisher: "tester",
      license: "MIT",
      runtime: {
        kind: "remote-mcp",
        url: "https://mcp.example.com/mcp",
        transport: "auto",
      },
      permissions: {
        network: ["https://mcp.example.com"],
        workspace: "none",
      },
      configSchema: [],
      configuredKeys: [],
      nonSecretValues: {},
      oauthConnected: false,
      oauthScopes: [],
      skills: [],
      iconDataUrl: null,
      revisions: [],
      createdAt: "2026-11-25T00:00:00.000Z",
      updatedAt: "2026-11-25T00:00:00.000Z",
      createdBy: "admin",
    };

    const pkgDetail: AppPackageDetail = {
      ...pkgSummary,
      files: [],
      package: {
        format: "chisabot-app/v1",
        id: pkgSummary.id,
        version: pkgSummary.version,
        name: pkgSummary.name,
        description: pkgSummary.description,
        publisher: pkgSummary.publisher,
        license: pkgSummary.license,
        runtime: pkgSummary.runtime,
        files: [],
        configSchema: [],
        skills: [],
        permissions: pkgSummary.permissions,
        packageDigest: pkgSummary.currentDigest,
      },
    };

    global.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === "/api/apps") {
          return Response.json({ apps: [pkgSummary], oauthCallbackUrl: null });
        }
        if (url === `/api/apps/${pkgSummary.id}`) {
          return Response.json({ app: pkgDetail });
        }
        return new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );

    const queryClient = makeQueryClient();
    queryClient.setQueryData(appPackagesKeys.all, {
      apps: [pkgSummary],
      oauthCallbackUrl: null,
    });
    queryClient.setQueryData(appPackagesKeys.detail(pkgSummary.id), pkgDetail);

    const view = render(
      <QueryClientProvider client={queryClient}>
        <AppPackagesPanel />
      </QueryClientProvider>,
    );

    const reviewBtn = await view.findByTestId("review-app-remote-auto-app");
    fireEvent.click(reviewBtn);

    await waitFor(() => {
      expect(
        document.body.textContent?.includes(MCP_TRANSPORT_LABELS.auto),
      ).toBe(true);
    });
  });
});
