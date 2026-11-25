import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  describeInstanceStatus,
  InstanceDetailPane,
} from "@/components/agent-providers/agent-providers-page";
import { AntigravityManagedCard } from "@/components/agent-providers/antigravity-managed-card";
import { SubagentPickerChip } from "@/components/chat/subagent-picker-chip";
import { ScheduleEditDialog } from "@/components/schedules/edit-dialog";
import { formatExecutorLabel } from "@/components/task-center/labels";
import { resetToastsForTest, toast } from "@/components/ui/toast";
import {
  localAgentDrawsCard,
  taskIdOf,
} from "@/lib/conversations/local-agent-tool";
import {
  getCardCheck,
  isSubagentRunToolName,
  pickToolRenderer,
  registeredCardChecks,
  type ToolRenderer,
  unfinishedToolText,
} from "@/lib/conversations/tool-renderers";
import {
  type AntigravityInstallJobView,
  type AntigravityLoginSessionView,
  type AntigravityRuntimeState,
  localAgentKeys,
} from "@/lib/local-agents";
import { editFormOf, editPatchOf } from "@/lib/schedule-edit";
import { findEntry, SETTINGS_PAGES } from "@/lib/settings/registry";
import {
  AGENT_DRIVER_SPECS,
  AGENT_PROVIDER_PRESETS,
  type AgentInstanceView,
} from "../../shared/agent-providers";
import type { ScheduleView } from "../../shared/schedules";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const sampleInstance: AgentInstanceView = {
  id: "inst-codex-personal",
  slug: "codex-personal",
  environmentId: "server",
  environmentName: "服务器本机",
  environmentOnline: true,
  driver: "codex",
  name: "Codex 个人号",
  description: "负责后端重构与单测修复",
  enabled: true,
  exposeAsTool: true,
  toolName: "agent_codex_personal",
  isDefaultSeed: false,
  sortOrder: 0,
  config: {
    commandPath: "codex",
    homePath: "~/.codex",
    shadowHomePath: "~/.codex-t3/personal",
  },
  envVars: [
    { name: "OPENAI_API_KEY", value: "", sensitive: true, hasValue: true },
  ],
  probe: {
    status: "available",
    version: "0.118.0",
    resolvedPath: "/usr/local/bin/codex",
    authenticated: true,
    authLabel: "已认证",
    message: null,
    checkedAt: "2026-11-11T10:00:00.000Z",
  },
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
};

describe("subagent tool renderers & card checks", () => {
  test("recognizes device_agent_run, subagent_run, and dynamic agent_<slug> tools", () => {
    expect(isSubagentRunToolName("device_agent_run")).toBe(true);
    expect(isSubagentRunToolName("subagent_run")).toBe(true);
    expect(isSubagentRunToolName("agent_codex_personal")).toBe(true);
    expect(isSubagentRunToolName("agent_codex-personal")).toBe(true);
    expect(isSubagentRunToolName("agent_")).toBe(false);
    expect(isSubagentRunToolName("subagent_list")).toBe(false);
    expect(isSubagentRunToolName("computer_click")).toBe(false);
  });

  test("pickToolRenderer and getCardCheck match dynamic agent_<slug> tools", () => {
    const dummyRenderer: ToolRenderer = {
      name: "device_agent_run",
      match: isSubagentRunToolName,
      render: () => null,
    };
    expect(pickToolRenderer([dummyRenderer], "agent_codex_personal")).toBe(
      dummyRenderer,
    );
    expect(pickToolRenderer([dummyRenderer], "subagent_run")).toBe(
      dummyRenderer,
    );
    expect(pickToolRenderer([dummyRenderer], "other_tool")).toBeUndefined();

    expect(localAgentDrawsCard).toBeDefined();
    const check = getCardCheck(registeredCardChecks, "agent_codex_personal");
    expect(check).toBeDefined();
    expect(
      check?.({
        args: JSON.stringify({ task: "fix bug" }),
        result: JSON.stringify({
          ok: true,
          taskId: "12345678-1234-1234-1234-123456789abc",
        }),
      }),
    ).toBe(true);
    expect(
      check?.({
        args: JSON.stringify({ task: "fix bug" }),
        result: JSON.stringify({ ok: false, error: "denied" }),
      }),
    ).toBe(false);
    expect(
      taskIdOf(
        JSON.stringify({
          taskId: "12345678-1234-1234-1234-123456789abc",
        }),
      ),
    ).toBe("12345678-1234-1234-1234-123456789abc");
  });

  test("unfinishedToolText formats subagent_run and agent_<slug> nicely", () => {
    expect(unfinishedToolText("agent_codex_personal")).toBe(
      "交给子代理没有完成",
    );
    expect(unfinishedToolText("subagent_run")).toBe("交给子代理没有完成");
  });
});

describe("settings registry & task-center executor labels", () => {
  test("agent-providers page is registered under devices group with searchable items", () => {
    const page = SETTINGS_PAGES.find((p) => p.id === "agent-providers");
    expect(page).toBeDefined();
    expect(page?.title).toBe("智能体提供方");
    expect(page?.to).toBe("/settings/agent-providers");
    expect(findEntry("agent-providers.agent-provider-env")?.item?.title).toBe(
      "提供方环境变量与工作区边界",
    );
  });

  test("formatExecutorLabel maps bot, local-agent, and agent:<id> capabilities", () => {
    expect(formatExecutorLabel("bot")).toBe("ChisaBot 机器人");
    expect(formatExecutorLabel("local-agent")).toBe("本地 Agent");
    expect(formatExecutorLabel("agent:codex-1")).toBe("子代理 · codex-1");
    expect(
      formatExecutorLabel("agent:inst-codex-personal", [
        {
          id: "agent:inst-codex-personal",
          kind: "executor",
          name: "Codex 个人号（服务器本机）",
          available: true,
          detail: "codex",
        },
      ]),
    ).toBe("Codex 个人号（服务器本机）");
  });
});

describe("schedule agentInstanceId binding & SubagentPickerChip", () => {
  const baseSchedule = {
    id: "sch_subagent",
    title: "每日代码巡检",
    instruction: "扫描安全漏洞并输出摘要",
    kind: "cron",
    cron: "0 9 * * *",
    runAt: null,
    timezone: "Asia/Shanghai",
    status: "active",
    agentInstanceId: null,
  } as unknown as ScheduleView;

  test("editFormOf and editPatchOf track agentInstanceId bind and unbind", () => {
    const initial = editFormOf(baseSchedule);
    expect(initial.agentInstanceId).toBe("");
    expect(
      editPatchOf(initial, {
        ...initial,
        agentInstanceId: "inst-codex-personal",
      }),
    ).toEqual({
      patch: { agentInstanceId: "inst-codex-personal" },
    });

    const boundInitial = editFormOf({
      ...baseSchedule,
      agentInstanceId: "inst-codex-personal",
    });
    expect(boundInitial.agentInstanceId).toBe("inst-codex-personal");
    expect(
      editPatchOf(boundInitial, { ...boundInitial, agentInstanceId: "" }),
    ).toEqual({
      patch: { agentInstanceId: null },
    });
  });

  test("ScheduleEditDialog renders executor selector when instances are provided", async () => {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <ScheduleEditDialog
          instances={[sampleInstance]}
          onOpenChange={() => {}}
          schedule={baseSchedule}
        />
      </QueryClientProvider>,
    );
    const trigger = await view.findByTestId("sch-edit-agent-instance");
    expect(trigger.textContent).toContain("由对话机器人处理（默认）");
  });

  test("SubagentPickerChip displays selected instance and clears on x click", async () => {
    const changes: (string | null)[] = [];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(localAgentKeys.instances(), [sampleInstance]);
    const user = userEvent.setup({ document: globalThis.document });
    const view = render(
      <QueryClientProvider client={client}>
        <SubagentPickerChip
          onSelect={(id) => changes.push(id)}
          selectedId="inst-codex-personal"
        />
      </QueryClientProvider>,
    );
    expect(view.getByTestId("subagent-picker-chip").textContent).toContain(
      "@Codex 个人号",
    );
    await user.click(view.getByLabelText("取消子代理直连"));
    await waitFor(() => expect(changes).toEqual([null]));
    client.clear();
  });
});

describe("Antigravity preset, status label & detail pane", () => {
  const antigravityInstance: AgentInstanceView = {
    ...sampleInstance,
    id: "inst-antigravity",
    slug: "antigravity",
    driver: "antigravity",
    name: "Antigravity",
    toolName: "agent_antigravity",
    config: {
      commandPath: null,
      fixProxy: true,
      protocolMode: "auto",
    },
    probe: {
      status: "missing",
      version: null,
      resolvedPath: null,
      authenticated: null,
      authLabel: null,
      message: "未找到 Antigravity 可执行文件（agy / antigravity）",
      checkedAt: "2026-11-24T10:00:00.000Z",
    },
  };

  test("Antigravity preset leaves commandPath null and documents agy / antigravity auto-discovery", () => {
    const preset = AGENT_PROVIDER_PRESETS.find((p) => p.key === "antigravity");
    expect(preset?.config.commandPath).toBeNull();
    expect(preset?.config.protocolMode).toBe("auto");
    expect(AGENT_DRIVER_SPECS.antigravity.description).toContain("antigravity");
    expect(AGENT_DRIVER_SPECS.antigravity.description).toContain("agy acp");
    expect(AGENT_DRIVER_SPECS.antigravity.fields.commandPlaceholder).toContain(
      "antigravity",
    );
    expect(AGENT_DRIVER_SPECS.antigravity.fields.commandHint).toContain(
      "agy / antigravity",
    );
  });

  test("describeInstanceStatus only prefixes 已认证 when authenticated === true", () => {
    expect(
      describeInstanceStatus({
        ...antigravityInstance,
        probe: {
          status: "available",
          version: "1.5.16",
          resolvedPath: "C:\\AI\\antigravity-cli\\antigravity.exe",
          authenticated: null,
          authLabel: "CLI 可用",
          message: "可用",
          checkedAt: "2026-11-24T10:00:00.000Z",
        },
      }),
    ).toEqual({ text: "CLI 可用", tone: "ok" });

    expect(
      describeInstanceStatus({
        ...antigravityInstance,
        probe: {
          status: "available",
          version: "1.5.16",
          resolvedPath: "C:\\AI\\antigravity-cli\\antigravity.exe",
          authenticated: null,
          authLabel: "已检测",
          message: "可用",
          checkedAt: "2026-11-24T10:00:00.000Z",
        },
      }),
    ).toEqual({ text: "已检测", tone: "ok" });

    expect(
      describeInstanceStatus({
        ...antigravityInstance,
        probe: {
          status: "available",
          version: "1.5.16",
          resolvedPath: "C:\\AI\\antigravity-cli\\antigravity.exe",
          authenticated: true,
          authLabel: "ACP 就绪",
          message: null,
          checkedAt: "2026-11-24T10:00:00.000Z",
        },
      }),
    ).toEqual({ text: "已认证 · ACP 就绪", tone: "ok" });

    expect(
      describeInstanceStatus({
        ...antigravityInstance,
        probe: {
          status: "available",
          version: "1.5.16",
          resolvedPath: "C:\\AI\\antigravity-cli\\antigravity.exe",
          authenticated: true,
          authLabel: "已认证",
          message: null,
          checkedAt: "2026-11-24T10:00:00.000Z",
        },
      }),
    ).toEqual({ text: "已认证", tone: "ok" });

    expect(
      describeInstanceStatus({
        ...antigravityInstance,
        probe: {
          status: "available",
          version: "1.5.16",
          resolvedPath: "/home/u/.chisabot/tools/antigravity/agy",
          authenticated: true,
          authLabel: "ACP 就绪",
          runtimeSource: "managed",
          message: null,
          checkedAt: "2026-11-24T10:00:00.000Z",
        },
      }),
    ).toEqual({ text: "已认证 · ACP 就绪 · 托管版", tone: "ok" });

    expect(
      describeInstanceStatus({
        ...antigravityInstance,
        probe: {
          status: "unauthenticated",
          version: "1.5.16",
          resolvedPath: "/home/u/.chisabot/tools/antigravity/agy",
          authenticated: false,
          authLabel: null,
          runtimeSource: "managed",
          message: null,
          checkedAt: "2026-11-24T10:00:00.000Z",
        },
      }),
    ).toEqual({ text: "未认证 · 托管版", tone: "warn" });
  });

  test("InstanceDetailPane shows Antigravity protocolMode selector, hint, and auto-probes after saving", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const probedInstance: AgentInstanceView = {
      ...antigravityInstance,
      config: {
        commandPath: "C:\\AI\\antigravity-cli\\antigravity.exe",
        fixProxy: true,
        protocolMode: "auto",
      },
      probe: {
        status: "available",
        version: "1.5.16",
        resolvedPath: "C:\\AI\\antigravity-cli\\antigravity.exe",
        authenticated: true,
        authLabel: "ACP 就绪",
        message: null,
        checkedAt: "2026-11-24T10:01:00.000Z",
      },
    };
    const mockFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ url, method, body });
        return new Response(JSON.stringify({ instance: probedInstance }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ) as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData<AntigravityRuntimeState>(
      localAgentKeys.antigravityRuntime("server"),
      {
        online: true,
        runtime: {
          installed: false,
          source: "missing",
          managedInstalled: false,
          managedVersion: null,
          managedBinaryPath: null,
          systemBinaryPath: null,
          activeBinaryPath: null,
          activeVersion: null,
          platformKey: "win32-x64",
          toolsDir: "C:\\Users\\demo\\.chisabot\\tools\\antigravity\\win32-x64",
          supported: true,
        },
        installJob: null,
      },
    );
    queryClient.setQueryData<AntigravityLoginSessionView | null>(
      localAgentKeys.antigravityLogin("inst-antigravity"),
      null,
    );

    let updatedCalls = 0;
    try {
      const user = userEvent.setup({ document: globalThis.document });
      const view = render(
        <QueryClientProvider client={queryClient}>
          <InstanceDetailPane
            instance={antigravityInstance}
            onClone={() => {}}
            onDeleted={() => {}}
            onUpdated={() => {
              updatedCalls += 1;
            }}
            readOnly={false}
          />
        </QueryClientProvider>,
      );

      expect(view.getByText("连接协议模式")).toBeDefined();
      expect(
        view.getByLabelText("Antigravity 连接协议模式").textContent,
      ).toContain("自动（优先 ACP）");
      expect(
        view.getByPlaceholderText(/留空由 ChisaBot 自动分配独立隔离目录/),
      ).toBeDefined();
      const commandInput = view.getByPlaceholderText(
        /留空自动检测 agy \/ antigravity/,
      );
      expect(commandInput).toBeDefined();

      await user.type(commandInput, "C:\\AI\\antigravity-cli\\antigravity.exe");
      await user.click(view.getByRole("button", { name: "保存配置" }));

      await waitFor(() => expect(updatedCalls).toBe(1));
      expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "PUT /api/local-agents/instances/inst-antigravity",
        "POST /api/local-agents/instances/inst-antigravity/probe",
      ]);
      const savedPayload = JSON.parse(requests[0]?.body ?? "{}") as {
        config?: { commandPath?: string | null; protocolMode?: string };
      };
      expect(savedPayload.config?.commandPath).toBe(
        "C:\\AI\\antigravity-cli\\antigravity.exe",
      );
      expect(savedPayload.config?.protocolMode).toBe("auto");
    } finally {
      queryClient.clear();
      fetchSpy.mockRestore();
      resetToastsForTest();
    }
  });

  test("InstanceDetailPane disables save/reset while probing and uses alert toast when probe warns", async () => {
    resetToastsForTest();
    const errorSpy = spyOn(toast, "error");
    const successSpy = spyOn(toast, "success");

    let resolveProbe: ((res: Response) => void) | null = null;
    const requests: string[] = [];
    const missingAfterProbe: AgentInstanceView = {
      ...antigravityInstance,
      probe: {
        status: "missing",
        version: null,
        resolvedPath: null,
        authenticated: null,
        authLabel: null,
        message: "未找到指定路径",
        checkedAt: "2026-11-24T10:02:00.000Z",
      },
    };
    const mockFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);
        if (method === "POST" && url.endsWith("/probe") && !resolveProbe) {
          return await new Promise<Response>((resolve) => {
            resolveProbe = resolve;
          });
        }
        return new Response(JSON.stringify({ instance: missingAfterProbe }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ) as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData<AntigravityRuntimeState>(
      localAgentKeys.antigravityRuntime("server"),
      {
        online: true,
        runtime: {
          installed: false,
          source: "missing",
          managedInstalled: false,
          managedVersion: null,
          managedBinaryPath: null,
          systemBinaryPath: null,
          activeBinaryPath: null,
          activeVersion: null,
          platformKey: "win32-x64",
          toolsDir: "C:\\Users\\demo\\.chisabot\\tools\\antigravity\\win32-x64",
          supported: true,
        },
        installJob: null,
      },
    );
    queryClient.setQueryData<AntigravityLoginSessionView | null>(
      localAgentKeys.antigravityLogin("inst-antigravity"),
      null,
    );

    try {
      const user = userEvent.setup({ document: globalThis.document });
      const view = render(
        <QueryClientProvider client={queryClient}>
          <InstanceDetailPane
            instance={antigravityInstance}
            onClone={() => {}}
            onDeleted={() => {}}
            onUpdated={() => {}}
            readOnly={false}
          />
        </QueryClientProvider>,
      );

      await user.click(view.getByRole("button", { name: "重新检测" }));

      await waitFor(() => {
        expect(
          view
            .getByRole("button", { name: "保存配置" })
            .hasAttribute("disabled"),
        ).toBe(true);
        expect(
          view.getByRole("button", { name: "还原" }).hasAttribute("disabled"),
        ).toBe(true);
      });

      const finishProbe = resolveProbe as ((res: Response) => void) | null;
      finishProbe?.(
        new Response(JSON.stringify({ instance: missingAfterProbe }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await waitFor(() => {
        expect(
          view
            .getByRole("button", { name: "保存配置" })
            .hasAttribute("disabled"),
        ).toBe(false);
      });
      expect(requests).toEqual([
        "POST /api/local-agents/instances/inst-antigravity/probe",
      ]);
      expect(errorSpy).toHaveBeenCalledWith(
        "Antigravity：未找到 · 未找到指定路径",
      );
      expect(successSpy).not.toHaveBeenCalled();

      // 保存错误配置后自动探活返回 warn，同样应走告警提示而非绿色 success
      errorSpy.mockClear();
      successSpy.mockClear();
      await user.click(view.getByRole("button", { name: "保存配置" }));

      await waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          "提供方配置已保存 · 未找到 · 未找到指定路径",
        );
      });
      expect(successSpy).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
      successSpy.mockRestore();
      resetToastsForTest();
    }
  });
});

describe("AntigravityManagedCard", () => {
  const baseAntigravityInstance: AgentInstanceView = {
    ...sampleInstance,
    id: "inst-ag-1",
    slug: "antigravity",
    environmentId: "env-pc-1",
    environmentName: "办公电脑",
    environmentOnline: true,
    driver: "antigravity",
    name: "Antigravity",
    toolName: "agent_antigravity",
    config: {
      commandPath: null,
      fixProxy: true,
      protocolMode: "auto",
    },
    probe: {
      status: "missing",
      version: null,
      resolvedPath: null,
      authenticated: null,
      authLabel: null,
      message: "未安装",
      runtimeSource: null,
      homePath: null,
      checkedAt: "2026-11-24T10:00:00.000Z",
    },
  };

  function makeQueryClient() {
    return new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: 0 },
      },
    });
  }

  test("未安装时渲染「一键安装 Antigravity」并点击触发 POST /environments/:id/antigravity/install", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const startedJob: AntigravityInstallJobView = {
      jobId: "job-1",
      environmentId: "env-pc-1",
      status: "running",
      stage: "checking",
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      message: "正在查询官方最新版本",
      version: null,
      binaryPath: null,
      error: null,
      startedAt: "2026-11-24T10:00:00.000Z",
      updatedAt: "2026-11-24T10:00:00.000Z",
      finishedAt: null,
    };
    const mockFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ url, method, body });
        if (url.endsWith("/antigravity/runtime")) {
          return new Response(
            JSON.stringify({
              online: true,
              runtime: {
                installed: false,
                source: "missing",
                managedInstalled: false,
                managedVersion: null,
                managedBinaryPath: null,
                systemBinaryPath: null,
                activeBinaryPath: null,
                activeVersion: null,
                platformKey: "win32-x64",
                toolsDir:
                  "C:\\Users\\u\\.chisabot\\tools\\antigravity\\win32-x64",
                supported: true,
              },
              installJob: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/antigravity/login")) {
          return new Response(JSON.stringify({ session: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (method === "POST" && url.endsWith("/antigravity/install")) {
          return new Response(JSON.stringify({ installJob: startedJob }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ) as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    const client = makeQueryClient();

    try {
      const user = userEvent.setup({ document: globalThis.document });
      const view = render(
        <QueryClientProvider client={client}>
          <AntigravityManagedCard
            instance={baseAntigravityInstance}
            onUpdated={() => {}}
            readOnly={false}
          />
        </QueryClientProvider>,
      );

      const installBtn = await view.findByRole("button", {
        name: "一键安装 Antigravity",
      });
      expect(view.getByText("未安装")).toBeDefined();
      await user.click(installBtn);

      await waitFor(() => {
        expect(
          requests.some(
            (r) =>
              r.method === "POST" &&
              r.url ===
                "/api/local-agents/environments/env-pc-1/antigravity/install",
          ),
        ).toBe(true);
      });
      expect(
        await view.findByTestId("antigravity-install-progress"),
      ).toBeDefined();
    } finally {
      client.clear();
      fetchSpy.mockRestore();
      resetToastsForTest();
    }
  });

  test("安装进行中渲染进度条与阶段文案，点击「取消安装」触发 POST /environments/:id/antigravity/install/cancel", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const runningJob: AntigravityInstallJobView = {
      jobId: "job-running",
      environmentId: "env-pc-1",
      status: "running",
      stage: "downloading",
      percent: 52,
      downloadedBytes: 120 * 1024 * 1024,
      totalBytes: 230 * 1024 * 1024,
      message: "正在下载 cli_windows_x64.exe",
      version: "1.5.16",
      binaryPath: null,
      error: null,
      startedAt: "2026-11-24T10:00:00.000Z",
      updatedAt: "2026-11-24T10:00:10.000Z",
      finishedAt: null,
    };
    const cancelledJob: AntigravityInstallJobView = {
      ...runningJob,
      status: "cancelled",
      finishedAt: "2026-11-24T10:00:12.000Z",
    };

    const mockFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        if (method === "POST" && url.endsWith("/antigravity/install/cancel")) {
          return new Response(JSON.stringify({ installJob: cancelledJob }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/antigravity/runtime")) {
          return new Response(
            JSON.stringify({
              online: true,
              runtime: null,
              installJob: cancelledJob,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ session: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ) as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    const client = makeQueryClient();
    client.setQueryData<AntigravityRuntimeState>(
      localAgentKeys.antigravityRuntime("env-pc-1"),
      {
        online: true,
        runtime: {
          installed: false,
          source: "missing",
          managedInstalled: false,
          managedVersion: null,
          managedBinaryPath: null,
          systemBinaryPath: null,
          activeBinaryPath: null,
          activeVersion: null,
          platformKey: "win32-x64",
          toolsDir: "C:\\Users\\u\\.chisabot\\tools\\antigravity\\win32-x64",
          supported: true,
        },
        installJob: runningJob,
      },
    );
    client.setQueryData<AntigravityLoginSessionView | null>(
      localAgentKeys.antigravityLogin("inst-ag-1"),
      null,
    );

    try {
      const user = userEvent.setup({ document: globalThis.document });
      const view = render(
        <QueryClientProvider client={client}>
          <AntigravityManagedCard
            instance={baseAntigravityInstance}
            onUpdated={() => {}}
            readOnly={false}
          />
        </QueryClientProvider>,
      );

      expect(view.getByText("下载中")).toBeDefined();
      expect(view.getByText(/52%/)).toBeDefined();
      const progressBar = view.getByRole("progressbar", {
        name: "Antigravity 安装进度",
      });
      expect(progressBar.getAttribute("aria-valuenow")).toBe("52");

      await user.click(view.getByRole("button", { name: "取消安装" }));
      await waitFor(() => {
        expect(
          requests.some(
            (r) =>
              r.method === "POST" &&
              r.url ===
                "/api/local-agents/environments/env-pc-1/antigravity/install/cancel",
          ),
        ).toBe(true);
      });
    } finally {
      client.clear();
      fetchSpy.mockRestore();
      resetToastsForTest();
    }
  });

  test("登录 awaiting_auth 时渲染 Google 授权链接和输入框，提交授权码触发 POST /instances/:id/antigravity/login/submit", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const awaitingSession: AntigravityLoginSessionView = {
      sessionId: "sess-oob-1",
      instanceId: "inst-ag-1",
      environmentId: "env-pc-1",
      status: "awaiting_auth",
      stage: "awaiting_auth",
      authUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
      userCode: null,
      message: "请打开链接并粘贴授权码",
      authenticated: false,
      authLabel: null,
      email: null,
      homePath: "C:\\Users\\u\\.chisabot\\agent-homes\\antigravity\\inst-ag-1",
      error: null,
      startedAt: "2026-11-24T10:00:00.000Z",
      updatedAt: "2026-11-24T10:00:02.000Z",
      finishedAt: null,
    };
    const succeededSession: AntigravityLoginSessionView = {
      ...awaitingSession,
      status: "succeeded",
      stage: "verifying",
      authenticated: true,
      email: "dev@example.com",
      authLabel: "dev@example.com",
      finishedAt: "2026-11-24T10:00:30.000Z",
    };

    const mockFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ url, method, body });
        if (method === "POST" && url.endsWith("/antigravity/login/submit")) {
          return new Response(JSON.stringify({ session: succeededSession }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ) as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch);

    const client = makeQueryClient();
    client.setQueryData<AntigravityRuntimeState>(
      localAgentKeys.antigravityRuntime("env-pc-1"),
      {
        online: true,
        runtime: {
          installed: true,
          source: "managed",
          managedInstalled: true,
          managedVersion: "1.5.16",
          managedBinaryPath:
            "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
          systemBinaryPath: null,
          activeBinaryPath:
            "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
          activeVersion: "1.5.16",
          platformKey: "win32-x64",
          toolsDir: "C:\\Users\\u\\.chisabot\\tools\\antigravity\\win32-x64",
          supported: true,
        },
        installJob: null,
      },
    );
    client.setQueryData<AntigravityLoginSessionView | null>(
      localAgentKeys.antigravityLogin("inst-ag-1"),
      awaitingSession,
    );

    let updatedCount = 0;
    try {
      const user = userEvent.setup({ document: globalThis.document });
      const view = render(
        <QueryClientProvider client={client}>
          <AntigravityManagedCard
            instance={{
              ...baseAntigravityInstance,
              probe: {
                status: "unauthenticated",
                version: "1.5.16",
                resolvedPath:
                  "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
                authenticated: false,
                authLabel: null,
                runtimeSource: "managed",
                homePath:
                  "C:\\Users\\u\\.chisabot\\agent-homes\\antigravity\\inst-ag-1",
                message: null,
                checkedAt: "2026-11-24T10:00:00.000Z",
              },
            }}
            onUpdated={() => {
              updatedCount += 1;
            }}
            readOnly={false}
          />
        </QueryClientProvider>,
      );

      const authLink = view.getByRole("link", { name: "打开 Google 授权页" });
      expect(authLink.getAttribute("href")).toBe(awaitingSession.authUrl);
      expect(authLink.getAttribute("target")).toBe("_blank");
      expect(view.getByRole("button", { name: "复制链接" })).toBeDefined();

      const codeInput = view.getByLabelText("Google 授权码或回调链接");
      await user.type(codeInput, "4/0A-sample-auth-code");
      await user.click(view.getByRole("button", { name: "提交授权码" }));

      await waitFor(() => expect(updatedCount).toBe(1));
      const submitReq = requests.find(
        (r) =>
          r.method === "POST" &&
          r.url ===
            "/api/local-agents/instances/inst-ag-1/antigravity/login/submit",
      );
      expect(submitReq).toBeDefined();
      expect(JSON.parse(submitReq?.body ?? "{}")).toEqual({
        code: "4/0A-sample-auth-code",
        sessionId: "sess-oob-1",
      });
    } finally {
      client.clear();
      fetchSpy.mockRestore();
      resetToastsForTest();
    }
  });

  test("已认证状态点击「退出登录」触发 POST /instances/:id/antigravity/logout", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const mockFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        if (method === "POST" && url.endsWith("/antigravity/logout")) {
          return new Response(
            JSON.stringify({
              ok: true,
              homePath:
                "C:\\Users\\u\\.chisabot\\agent-homes\\antigravity\\inst-ag-1",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ session: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ) as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch);

    const client = makeQueryClient();
    client.setQueryData<AntigravityRuntimeState>(
      localAgentKeys.antigravityRuntime("env-pc-1"),
      {
        online: true,
        runtime: {
          installed: true,
          source: "managed",
          managedInstalled: true,
          managedVersion: "1.5.16",
          managedBinaryPath:
            "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
          systemBinaryPath: null,
          activeBinaryPath:
            "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
          activeVersion: "1.5.16",
          platformKey: "win32-x64",
          toolsDir: "C:\\Users\\u\\.chisabot\\tools\\antigravity\\win32-x64",
          latestVersion: "1.6.0",
          updateAvailable: true,
          supported: true,
        },
        installJob: null,
      },
    );
    client.setQueryData<AntigravityLoginSessionView | null>(
      localAgentKeys.antigravityLogin("inst-ag-1"),
      null,
    );

    let updatedCount = 0;
    try {
      const user = userEvent.setup({ document: globalThis.document });
      const view = render(
        <QueryClientProvider client={client}>
          <AntigravityManagedCard
            instance={{
              ...baseAntigravityInstance,
              probe: {
                status: "available",
                version: "1.5.16",
                resolvedPath:
                  "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
                authenticated: true,
                authLabel: "dev@example.com",
                runtimeSource: "managed",
                homePath:
                  "C:\\Users\\u\\.chisabot\\agent-homes\\antigravity\\inst-ag-1",
                message: null,
                checkedAt: "2026-11-24T10:00:00.000Z",
              },
            }}
            onUpdated={() => {
              updatedCount += 1;
            }}
            readOnly={false}
          />
        </QueryClientProvider>,
      );

      expect(view.getByText("ChisaBot 托管 v1.5.16")).toBeDefined();
      expect(view.getByText("新版本 v1.6.0")).toBeDefined();
      expect(view.getByText("已登录 · dev@example.com")).toBeDefined();
      expect(
        view.getByRole("button", { name: "切换账号 / 重新登录" }),
      ).toBeDefined();

      await user.click(view.getByRole("button", { name: "退出登录" }));
      await waitFor(() => expect(updatedCount).toBe(1));
      expect(
        requests.some(
          (r) =>
            r.method === "POST" &&
            r.url ===
              "/api/local-agents/instances/inst-ag-1/antigravity/logout",
        ),
      ).toBe(true);
    } finally {
      client.clear();
      fetchSpy.mockRestore();
      resetToastsForTest();
    }
  });

  test("readOnly 与离线状态下禁用全部写操作按钮并展示原因", () => {
    const client = makeQueryClient();
    client.setQueryData<AntigravityRuntimeState>(
      localAgentKeys.antigravityRuntime("env-pc-1"),
      {
        online: true,
        runtime: {
          installed: true,
          source: "managed",
          managedInstalled: true,
          managedVersion: "1.5.16",
          managedBinaryPath:
            "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
          systemBinaryPath: null,
          activeBinaryPath:
            "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
          activeVersion: "1.5.16",
          platformKey: "win32-x64",
          toolsDir: "C:\\Users\\u\\.chisabot\\tools\\antigravity\\win32-x64",
          supported: true,
        },
        installJob: null,
      },
    );
    client.setQueryData<AntigravityLoginSessionView | null>(
      localAgentKeys.antigravityLogin("inst-ag-1"),
      null,
    );

    try {
      const readOnlyView = render(
        <QueryClientProvider client={client}>
          <AntigravityManagedCard
            instance={{
              ...baseAntigravityInstance,
              probe: {
                status: "available",
                version: "1.5.16",
                resolvedPath:
                  "C:\\Users\\u\\.chisabot\\tools\\antigravity\\agy.exe",
                authenticated: true,
                authLabel: "admin@example.com",
                runtimeSource: "managed",
                message: null,
                checkedAt: "2026-11-24T10:00:00.000Z",
              },
            }}
            onUpdated={() => {}}
            readOnly={true}
          />
        </QueryClientProvider>,
      );

      expect(readOnlyView.getByText(/当前为只读视图/)).toBeDefined();
      expect(
        readOnlyView
          .getByRole("button", { name: "检查更新 / 重新安装" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        readOnlyView
          .getByRole("button", { name: "切换账号 / 重新登录" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        readOnlyView
          .getByRole("button", { name: "退出登录" })
          .hasAttribute("disabled"),
      ).toBe(true);
      readOnlyView.unmount();

      // 离线状态
      client.setQueryData<AntigravityRuntimeState>(
        localAgentKeys.antigravityRuntime("env-pc-1"),
        {
          online: false,
          runtime: {
            installed: false,
            source: "missing",
            managedInstalled: false,
            managedVersion: null,
            managedBinaryPath: null,
            systemBinaryPath: null,
            activeBinaryPath: null,
            activeVersion: null,
            platformKey: "win32-x64",
            toolsDir: "C:\\Users\\u\\.chisabot\\tools\\antigravity\\win32-x64",
            supported: true,
          },
          installJob: null,
        },
      );

      const offlineView = render(
        <QueryClientProvider client={client}>
          <AntigravityManagedCard
            instance={{
              ...baseAntigravityInstance,
              environmentOnline: false,
            }}
            onUpdated={() => {}}
            readOnly={false}
          />
        </QueryClientProvider>,
      );

      expect(offlineView.getByText(/所在运行环境当前离线/)).toBeDefined();
      expect(
        offlineView
          .getByRole("button", { name: "一键安装 Antigravity" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        offlineView
          .getByRole("button", { name: "登录 Google 账号" })
          .hasAttribute("disabled"),
      ).toBe(true);
    } finally {
      client.clear();
    }
  });
});
