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
import { nextUniqueProviderSlug } from "@/components/agent-providers/agent-providers-page";
import { LocalAgentCard } from "@/components/chat/local-agent-card";
import { resetToastsForTest } from "@/components/ui/toast";
import { ConversationScopeProvider } from "@/lib/chat/conversation-scope";
import { localAgentKeys } from "@/lib/local-agents";
import type { LocalAgentTaskView } from "../../shared/local-agents";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  resetToastsForTest();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const THREAD_ID = "thread-card-test";

function makeQueryClient(tasks: LocalAgentTaskView[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: 0 },
    },
  });
  queryClient.setQueryData(localAgentKeys.thread(THREAD_ID), tasks);
  return queryClient;
}

function makeBaseTask(
  overrides: Partial<LocalAgentTaskView> = {},
): LocalAgentTaskView {
  return {
    id: "task-1",
    deviceId: "server",
    deviceName: "服务器本机",
    environmentId: "server",
    instanceId: "inst-codex",
    instanceName: "Codex",
    agent: "codex",
    title: "修复登录鉴权问题",
    profile: "workspace",
    isolation: "worktree",
    network: true,
    cwd: "/workspace/app",
    status: "done",
    step: null,
    lines: [
      {
        at: "2026-11-25T06:00:00.000Z",
        kind: "status",
        text: "已完成代码修改与单测",
      },
    ],
    lineCount: 1,
    summary: "已修复 token 刷新竞态问题",
    diff: null,
    error: null,
    approvalId: null,
    approvalSummary: null,
    pendingInput: null,
    sessionId: "sess-abc-123",
    turnCount: 1,
    continuable: true,
    resultMessageId: null,
    createdAt: "2026-11-25T06:00:00.000Z",
    startedAt: "2026-11-25T06:00:01.000Z",
    finishedAt: "2026-11-25T06:00:15.000Z",
    ...overrides,
  };
}

function renderCard(task: LocalAgentTaskView) {
  const queryClient = makeQueryClient([task]);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConversationScopeProvider agentId="bot-1" threadId={THREAD_ID}>
        <LocalAgentCard taskId={task.id} />
      </ConversationScopeProvider>
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

describe("LocalAgentCard 增强功能", () => {
  test("diff.patch 折叠预览可展开与收起，并正确对 unified diff 行做语义着色", async () => {
    const samplePatch = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "index 1111111..2222222 100644",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -10,4 +10,5 @@ export function verify() {",
      " const ok = check();",
      "-return false;",
      "+return ok;",
      "+// added guard",
    ].join("\n");

    const task = makeBaseTask({
      diff: {
        files: [
          { path: "src/auth.ts", added: 2, removed: 1, status: "modified" },
        ],
        added: 2,
        removed: 1,
        pending: true,
        applied: false,
        patch: samplePatch,
      },
    });

    const user = userEvent.setup({ document: globalThis.document });
    const { view, queryClient } = renderCard(task);
    try {
      const toggle = view.getByTestId("local-agent-patch-toggle");
      expect(toggle.textContent).toContain("查看代码改动");
      expect(view.queryByTestId("local-agent-patch")).toBeNull();

      await user.click(toggle);
      expect(toggle.textContent).toContain("收起代码改动");

      const patchBox = view.getByTestId("local-agent-patch");
      const lines = Array.from(patchBox.querySelectorAll(".la-patch-line"));
      expect(lines.length).toBe(9);
      expect(lines[0]?.classList.contains("is-meta")).toBe(true);
      expect(lines[2]?.classList.contains("is-meta")).toBe(true);
      expect(lines[3]?.classList.contains("is-meta")).toBe(true);
      expect(lines[4]?.classList.contains("is-hunk")).toBe(true);
      expect(lines[5]?.classList.contains("is-ctx")).toBe(true);
      expect(lines[6]?.classList.contains("is-del")).toBe(true);
      expect(lines[7]?.classList.contains("is-add")).toBe(true);
      expect(lines[8]?.classList.contains("is-add")).toBe(true);

      await user.click(toggle);
      expect(view.queryByTestId("local-agent-patch")).toBeNull();
    } finally {
      queryClient.clear();
    }
  });

  test("needs_input 追问表单保持展开、支持单选/多选/文本输入并提交至 /answer", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const task = makeBaseTask({
      id: "task-needs-input",
      status: "needs_input",
      finishedAt: null,
      step: "等待用户确认迁移策略",
      pendingInput: {
        reqId: "req-1",
        askedAt: "2026-11-25T06:01:00.000Z",
        questions: [
          {
            id: "strategy",
            header: "迁移策略",
            question: "希望采用哪种方式处理旧表数据？",
            options: [
              { label: "在线双写", description: "零停机切换" },
              { label: "离线迁移", description: "维护窗口一次性导入" },
            ],
            allowMultiple: false,
            required: true,
          },
          {
            id: "checks",
            header: "额外检查",
            question: "需要附带执行哪些校验？",
            options: [{ label: "单测" }, { label: "类型检查" }],
            allowMultiple: true,
            required: true,
          },
          {
            id: "note",
            header: "补充备注",
            question: "请填写发布负责人或备注",
            required: true,
          },
        ],
      },
    });

    const resumedTask = makeBaseTask({
      ...task,
      status: "running",
      pendingInput: null,
      step: "已收到答复，继续执行",
    });

    const mockFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ url, method, body });
        if (url.endsWith("/api/local-agents/tasks/task-needs-input/answer")) {
          return new Response(JSON.stringify({ task: resumedTask }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ tasks: [resumedTask] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      mockFetch as typeof globalThis.fetch,
    );

    const user = userEvent.setup({ document: globalThis.document });
    const { view, queryClient } = renderCard(task);
    try {
      expect(view.getByTestId("local-agent-input-form")).toBeDefined();
      const submitBtn = view.getByTestId("local-agent-input-submit");
      expect(submitBtn.hasAttribute("disabled")).toBe(true);

      await user.click(view.getByRole("button", { name: /在线双写/ }));
      await user.click(view.getByRole("button", { name: "单测" }));
      await user.click(view.getByRole("button", { name: "类型检查" }));
      await user.type(
        view.getByTestId("local-agent-input-field-note"),
        "发版前先通知值班人",
      );

      expect(submitBtn.hasAttribute("disabled")).toBe(false);
      await user.click(submitBtn);

      await waitFor(() => {
        const answerCall = requests.find(
          (item) =>
            item.method === "POST" &&
            item.url.endsWith(
              "/api/local-agents/tasks/task-needs-input/answer",
            ),
        );
        expect(answerCall).toBeDefined();
        expect(JSON.parse(answerCall?.body ?? "{}")).toEqual({
          answers: {
            strategy: ["在线双写"],
            checks: ["单测", "类型检查"],
            note: ["发版前先通知值班人"],
          },
        });
      });
    } finally {
      queryClient.clear();
      fetchSpy.mockRestore();
    }
  });

  test("任务已完成且 continuable 且有 sessionId 时展开卡片可续聊，提交至 /continue 并清空输入", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const task = makeBaseTask({
      id: "task-cont",
      status: "done",
      continuable: true,
      sessionId: "sess-keep-alive",
      diff: null,
    });
    const continuedTask = makeBaseTask({
      ...task,
      status: "running",
      finishedAt: null,
      turnCount: 2,
    });

    const mockFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ url, method, body });
        if (url.endsWith("/api/local-agents/tasks/task-cont/continue")) {
          return new Response(
            JSON.stringify({ task: continuedTask, timedOut: false }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ tasks: [continuedTask] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      mockFetch as typeof globalThis.fetch,
    );

    const user = userEvent.setup({ document: globalThis.document });
    const { view, queryClient } = renderCard(task);
    try {
      // 默认折叠成单行，不展示续聊输入框
      expect(view.queryByTestId("local-agent-continue-form")).toBeNull();

      // 点击「展开详情」展开卡片
      await user.click(view.getByRole("button", { name: "展开详情" }));
      const input = view.getByTestId(
        "local-agent-continue-input",
      ) as HTMLTextAreaElement;
      const submitBtn = view.getByTestId("local-agent-continue-submit");
      expect(submitBtn.hasAttribute("disabled")).toBe(true);

      // Shift+Enter 换行不触发提交
      await user.type(input, "补充回归测试{Shift>}{Enter}{/Shift}并更新注释");
      expect(requests.length).toBe(0);
      expect(submitBtn.hasAttribute("disabled")).toBe(false);

      // Enter 提交调用 /continue
      await user.keyboard("{Enter}");

      await waitFor(() => {
        const continueCall = requests.find(
          (item) =>
            item.method === "POST" &&
            item.url.endsWith("/api/local-agents/tasks/task-cont/continue"),
        );
        expect(continueCall).toBeDefined();
        expect(JSON.parse(continueCall?.body ?? "{}")).toEqual({
          prompt: "补充回归测试\n并更新注释",
          mode: "async",
        });
      });

      await waitFor(() => {
        expect(input.value).toBe("");
      });
    } finally {
      queryClient.clear();
      fetchSpy.mockRestore();
    }
  });

  test("continuable 为 false 或无 sessionId 时不显示续聊输入框", async () => {
    const user = userEvent.setup({ document: globalThis.document });

    const nonContinuable = makeBaseTask({
      id: "task-no-cont",
      continuable: false,
      sessionId: "sess-1",
    });
    const first = renderCard(nonContinuable);
    try {
      await user.click(first.view.getByRole("button", { name: "展开详情" }));
      expect(first.view.queryByTestId("local-agent-continue-form")).toBeNull();
    } finally {
      first.queryClient.clear();
      cleanup();
    }

    const noSession = makeBaseTask({
      id: "task-no-sess",
      continuable: true,
      sessionId: null,
    });
    const second = renderCard(noSession);
    try {
      await user.click(second.view.getByRole("button", { name: "展开详情" }));
      expect(second.view.queryByTestId("local-agent-continue-form")).toBeNull();
    } finally {
      second.queryClient.clear();
    }
  });
});

describe("nextUniqueProviderSlug", () => {
  test("只在同环境已有相同 slug 冲突时追加递增后缀", () => {
    expect(nextUniqueProviderSlug("claude", ["codex"])).toBe("claude");
    expect(nextUniqueProviderSlug("codex", ["codex"])).toBe("codex-2");
    expect(nextUniqueProviderSlug("codex", ["codex", "codex-2"])).toBe(
      "codex-3",
    );
    expect(nextUniqueProviderSlug("codex", ["codex", "codex-3"])).toBe(
      "codex-2",
    );
    expect(nextUniqueProviderSlug("claude", ["Codex", "CLAUDE"])).toBe(
      "claude-2",
    );
  });
});
