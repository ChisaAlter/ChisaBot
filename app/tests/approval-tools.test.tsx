import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { z } from "zod";
import {
  formatApprovalScopeHint,
  InlineApproval,
} from "@/components/approvals/inline-approval";
import { ToolRendererProvider, useRenderToolCall } from "@/lib/chat/renderers";
import { useComputerToolRenderer } from "@/lib/conversations/approval-tools";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const NativeResponse = globalThis.Response;
function Tool() {
  useComputerToolRenderer({
    name: "computer_click",
    parameters: z.object({ ref: z.string() }),
    render: () => <span>点击结果</span>,
  });
  return null;
}
function Call() {
  const draw = useRenderToolCall();
  return draw({
    toolCall: {
      id: "call",
      type: "function",
      function: { name: "computer_click", arguments: '{"ref":"e7"}' },
    },
  });
}
test("a replayed call only displays its approval; an explicit click sends the decision once", async () => {
  const original = globalThis.fetch;
  const posted: { url: string; body: unknown }[] = [];
  let decided = false;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === "POST") {
        posted.push({
          url: String(url),
          body: JSON.parse(String(options.body)),
        });
        decided = true;
        return NativeResponse.json({ accepted: true });
      }
      return NativeResponse.json({
        requests: decided
          ? []
          : [
              {
                id: "approval-1",
                status: "pending",
                action: {
                  toolCallId: "call",
                  toolRef: "computer_click",
                  scope: "Submit form",
                  policy: { behaviour: "ask", reason: "请确认" },
                },
              },
            ],
        questions: [],
      });
    },
    { preconnect: original.preconnect },
  );
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    const view = render(
      <QueryClientProvider client={queries}>
        <ToolRendererProvider>
          <Tool />
          <Call />
        </ToolRendererProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.getByTestId("upstream-approval-card")).toBeTruthy(),
    );
    expect(posted).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: /^确认$/ }));
    await waitFor(() =>
      expect(posted).toEqual([
        {
          url: "/api/approvals/approval-1/decision",
          body: { decision: "allow_once" },
        },
      ]),
    );
    await waitFor(() =>
      expect(view.queryByTestId("upstream-approval-card")).toBeNull(),
    );
  } finally {
    cleanup();
    queries.clear();
    globalThis.fetch = original;
  }
});

test("formatApprovalScopeHint formats domain/subdomain, host, repo, path, command and wildcard scopes", () => {
  expect(formatApprovalScopeHint("   ")).toBe("");
  expect(formatApprovalScopeHint("*")).toContain("全局范围");
  expect(formatApprovalScopeHint("https://api.github.com/repos")).toContain(
    "github.com",
  );
  expect(formatApprovalScopeHint("https://api.github.com/repos")).toContain(
    "子域",
  );
  expect(formatApprovalScopeHint("docs.weather.com.cn")).toContain(
    "weather.com.cn",
  );
  expect(formatApprovalScopeHint("http://192.168.1.5:3000/api")).toContain(
    "192.168.1.5",
  );
  expect(formatApprovalScopeHint("octocat/hello-world")).toContain("仓库范围");
  expect(formatApprovalScopeHint("/Users/demo/notes.md")).toContain("路径范围");
  expect(formatApprovalScopeHint("C:\\work\\notes.txt")).toContain("路径范围");
  expect(formatApprovalScopeHint("./src/app.ts")).toContain("路径范围");
  expect(formatApprovalScopeHint("git push origin main")).toContain("命令范围");
  expect(formatApprovalScopeHint("Submit form")).toContain("Submit form");
});

test("InlineApproval exposes allow_always with scopeHint and locks duplicate clicks while excluding payment and hand_off", async () => {
  const original = globalThis.fetch;
  const posted: { url: string; body: unknown }[] = [];
  let releasePost!: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  let decided = false;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === "POST") {
        posted.push({
          url: String(url),
          body: JSON.parse(String(options.body)),
        });
        await postGate;
        decided = true;
        return NativeResponse.json({ accepted: true });
      }
      return NativeResponse.json({
        requests: decided
          ? []
          : [
              {
                id: "approval-scope",
                status: "pending",
                action: {
                  toolCallId: "call-scope",
                  toolRef: "computer_click",
                  scope: "https://docs.github.com/en/rest",
                  policy: { behaviour: "ask", reason: "你的规则要求先问你" },
                },
              },
              {
                id: "approval-pay",
                status: "pending",
                action: {
                  toolCallId: "call-pay",
                  toolRef: "computer_click",
                  scope: "https://pay.example.com/checkout",
                  policy: { behaviour: "ask", reason: "付款确认" },
                },
              },
              {
                id: "approval-handoff",
                status: "pending",
                action: {
                  toolCallId: "call-handoff",
                  toolRef: "computer_click",
                  scope: "https://account.example.com/password",
                  policy: {
                    behaviour: "hand_off",
                    reason: "改密码要你亲自完成",
                  },
                },
              },
            ],
        questions: [],
      });
    },
    { preconnect: original.preconnect },
  );
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    const view = render(
      <QueryClientProvider client={queries}>
        <InlineApproval fallback={<span>ok</span>} toolCallId="call-scope" />
        <InlineApproval fallback={<span>pay</span>} toolCallId="call-pay" />
        <InlineApproval
          fallback={<span>handoff</span>}
          toolCallId="call-handoff"
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.getAllByTestId("upstream-approval-card")).toHaveLength(3),
    );
    const cards = view.getAllByTestId("upstream-approval-card");
    expect(cards[0]?.textContent).toContain("始终允许此范围");
    expect(cards[0]?.textContent).toContain("github.com");
    expect(cards[1]?.textContent).not.toContain("始终允许此范围");
    expect(cards[1]?.textContent).toContain("付款购买一律先问你");
    expect(cards[2]?.textContent).not.toContain("始终允许此范围");

    const allowAlwaysBtn = view.getByRole("button", {
      name: "始终允许此范围",
    }) as HTMLButtonElement;
    fireEvent.click(allowAlwaysBtn);
    fireEvent.click(allowAlwaysBtn);
    await waitFor(() =>
      expect(posted).toEqual([
        {
          url: "/api/approvals/approval-scope/decision",
          body: { decision: "allow_always" },
        },
      ]),
    );
    releasePost();
    await waitFor(() => expect(decided).toBe(true));
  } finally {
    releasePost();
    cleanup();
    queries.clear();
    globalThis.fetch = original;
  }
});
