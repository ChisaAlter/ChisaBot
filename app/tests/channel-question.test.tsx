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
import { dismissPersonQuestion } from "@/lib/approvals";

/**
 * 「1 个问题」点进对话之后必须有事可做。
 *
 * The question used to live only in Approvals, so following the rail's number into the conversation
 * that raised it found nothing to click and the number stayed (§110). The box below the transcript
 * is the same answer through the same route, and answering has to clear the rail's own count at
 * once rather than up to fifteen seconds later.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // React's scheduler still has a task queued from the last render; let it land while the DOM exists,
  // or it throws `window is not defined` between tests.
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let answered = false;
const sent: { path: string; method: string; body: unknown }[] = [];
let reads = 0;

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
            botId: "agent_mail",
            threadId: "t1",
            channelId: "channel-1",
            question: "要不要现在发这封邮件？",
            why: "发出去就收不回来了。",
            createdAt: new Date().toISOString(),
          },
        ],
  };
}

beforeEach(() => {
  answered = false;
  reads = 0;
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
        reads += 1;
        return Response.json(inbox());
      }
      if (url.startsWith("/api/agents"))
        return Response.json({
          agents: [{ id: "agent_mail", name: "邮件助手" }],
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw(channelId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // 侧栏数字读的就是这个查询：答完必须当场作废，而不是等下一次轮询。
  client.setQueryData(["bot-lifecycle", "attention"], []);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <PendingQuestion channelId={channelId} />
      </QueryClientProvider>,
    ),
  };
}

test("这个对话里的问题画在输入框上面，回答直接走同一个接口", async () => {
  const view = draw("channel-1");
  await view.findByText("邮件助手问你：要不要现在发这封邮件？");
  expect(view.getByText("发出去就收不回来了。")).toBeTruthy();

  /*
   * Typing, not `fireEvent.input`: React 19 drops a dispatched input event under happy-dom, so the
   * controlled draft never moves and the send button stays disabled. user-event needs the document
   * handed to it because this module (not the happy-dom global) is where it reads one from.
   */
  const user = userEvent.setup({ document: globalThis.document });
  await user.type(view.getByLabelText("你的回答"), "发吧，附件用最终版");
  await user.click(view.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/questions/q1/respond",
      method: "POST",
      body: { response: "发吧，附件用最终版" },
    }),
  );
  // 答完，这条问题不再是 pending，卡片自己消失；侧栏那个数同时作废。
  await waitFor(() => expect(view.queryByRole("region")).toBeNull());
  expect(
    view.client.getQueryState(["bot-lifecycle", "attention"])?.isInvalidated,
  ).toBe(true);
});

test("别的对话问的问题不会画在这个对话里", async () => {
  const view = draw("channel-2");
  await waitFor(() => expect(reads).toBeGreaterThan(0));
  expect(view.queryByRole("region")).toBeNull();
});

test("关掉一个答不了的问题走 dismiss，不写回答也不恢复那一轮", async () => {
  const seen: { url: string; method: string }[] = [];
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), method: String(init?.method) });
    return Response.json({ id: "q1", dismissed: true });
  }) as unknown as typeof fetch;

  await dismissPersonQuestion("q1");

  expect(seen).toEqual([
    { url: "/api/approvals/questions/q1/dismiss", method: "POST" },
  ]);
});
