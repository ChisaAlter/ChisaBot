import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingQuestion } from "@/components/approvals/pending-question";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-147：结构化表单问题的会话内渲染与提交。
 * fields 存在时渲染五控件表单而非自由文本；提交走 respond 端点带 answers 键值对；
 * 过期问题禁用输入并呈「已过期」终态。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const sent: { path: string; method: string; body: unknown }[] = [];
let answered = false;
let expired = false;

const FIELDS = [
  { type: "text", id: "name", label: "发布标题", required: true },
  {
    type: "select",
    id: "env",
    label: "目标环境",
    options: ["staging", "prod"],
    required: true,
  },
  {
    type: "multiselect",
    id: "channels",
    label: "通知渠道",
    options: ["邮件", "短信"],
    required: false,
  },
  { type: "confirm", id: "sure", label: "确认无误", required: false },
];

function inbox() {
  return {
    enabled: false,
    requests: [],
    rules: [],
    teamRules: [],
    questions: answered
      ? []
      : [
          {
            id: "q1",
            botId: "agent_ops",
            threadId: "t1",
            channelId: "channel-1",
            question: "请填写发布信息",
            createdAt: new Date().toISOString(),
            fields: FIELDS,
            expiresAt: expired
              ? new Date(Date.now() - 60_000).toISOString()
              : null,
          },
        ],
  };
}

beforeEach(() => {
  answered = false;
  expired = false;
  sent.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method && init.method !== "GET") {
        if (url.endsWith("/respond")) answered = true;
        sent.push({
          path: url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      }
      if (url === "/api/approvals") {
        return Response.json(inbox());
      }
      if (url.startsWith("/api/agents")) {
        return Response.json({ agents: [] });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function renderQuestion() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["bot-lifecycle", "attention"], []);
  return render(
    <QueryClientProvider client={client}>
      <PendingQuestion channelId="channel-1" />
    </QueryClientProvider>,
  );
}

test("表单问题渲染五控件而非自由文本输入", async () => {
  const view = renderQuestion();
  await waitFor(() => view.getByTestId("user-form-fields"));
  // 五控件在：text input、select trigger、multiselect 胶囊、confirm switch
  expect(view.getByLabelText("发布标题")).toBeTruthy();
  expect(view.getByText("邮件")).toBeTruthy();
  expect(view.getByText("短信")).toBeTruthy();
  // 自由文本回答框不出现
  expect(view.queryByPlaceholderText(/输入回答/)).toBeNull();
  view.unmount();
});

test("必填缺失禁提交；填齐后 POST answers 键值对", async () => {
  const user = userEvent.setup({ document: globalThis.document });
  const view = renderQuestion();
  await waitFor(() => view.getByTestId("user-form-fields"));
  // 未填必填直接提交——无 respond 请求发出
  await user.click(view.getByText("提交"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(sent.length).toBe(0);
  // 填 text + 选 select + 胶囊多选 + confirm
  await user.type(view.getByLabelText("发布标题"), "v1 上线");
  await user.click(view.getByText("邮件"));
  await user.click(view.getByRole("switch"));
  // select：点 trigger 选 prod
  const trigger = view.getByLabelText("目标环境");
  await user.click(trigger);
  await waitFor(() => view.getByText("prod"));
  await user.click(view.getByText("prod"));
  await user.click(view.getByText("提交"));
  await waitFor(() => expect(sent.length).toBe(1));
  const body = sent[0]?.body as {
    response: string;
    answers: Record<string, unknown>;
  };
  expect(body.answers.name).toBe("v1 上线");
  expect(body.answers.env).toBe("prod");
  expect(body.answers.channels).toEqual(["邮件"]);
  view.unmount();
});

test("过期问题：表单不出现，呈「已过期」终态", async () => {
  expired = true;
  const view = renderQuestion();
  await waitFor(() => view.getByTestId("question-expired"));
  expect(view.queryByTestId("user-form-fields")).toBeNull();
  expect(view.queryByPlaceholderText(/输入回答/)).toBeNull();
  view.unmount();
});
