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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubagentPickerChip } from "@/components/chat/subagent-picker-chip";
import { ScheduleEditDialog } from "@/components/schedules/edit-dialog";
import { formatExecutorLabel } from "@/components/task-center/labels";
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
import { localAgentKeys } from "@/lib/local-agents";
import { editFormOf, editPatchOf } from "@/lib/schedule-edit";
import { findEntry, SETTINGS_PAGES } from "@/lib/settings/registry";
import type { AgentInstanceView } from "../../shared/agent-providers";
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
