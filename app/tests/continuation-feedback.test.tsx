import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { z } from "zod";
import { ConfirmationPages } from "@/components/approvals/confirmation-pages";
import {
  ConfirmCardView,
  looseConfirmations,
} from "@/components/chat/confirm-card";
import { ProposedSkillCard } from "@/components/skills/proposed-skill";
import {
  type InteractionRenderProps,
  ToolRendererProvider,
  useInteractionRenderer,
  useRenderToolCall,
} from "@/lib/chat/renderers";
import {
  confirmKeys,
  recentConfirmationsQueryOptions,
  useConfirmationPage,
} from "@/lib/confirmations";
import type {
  ConfirmRequestView,
  ContinuationView,
} from "../../shared/confirmations";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  for (const cache of clients.splice(0)) cache.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function cache() {
  const result = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(result);
  return result;
}
function request(
  id: string,
  continuation?: ContinuationView,
): ConfirmRequestView {
  return {
    id,
    agentId: "bot",
    threadId: "thread",
    toolCallId: null,
    category: "message",
    tool: "send",
    title: id,
    target: null,
    details: [],
    status: continuation ? "approved" : "pending",
    decidedVia: "web",
    createdAt: "2026-11-11T00:00:00Z",
    decidedAt: null,
    expiresAt: "2026-12-11T00:00:00Z",
    continuation,
  };
}
function api(path: RequestInfo | URL) {
  return new URL(String(path), "https://example.test");
}

test("preview reads only first recent/actionable pages and deduplicates their current state", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = api(input);
    calls.push(url.search);
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("20");
    return Response.json({
      requests: url.searchParams.has("view")
        ? [
            request("old"),
            request("duplicate", { state: "failed", retryable: true }),
          ]
        : [request("new"), request("duplicate", { state: "running" })],
      nextCursor: "more-pages",
    });
  }) as typeof fetch;
  const rows = await cache().fetchQuery(recentConfirmationsQueryOptions());
  expect(rows.map((row) => row.id).sort()).toEqual(["duplicate", "new", "old"]);
  expect(rows.find((row) => row.id === "duplicate")?.continuation?.state).toBe(
    "failed",
  );
  expect(calls.length).toBe(2);
});

function PagedConfirmations() {
  const pages = useConfirmationPage("actionable");
  return (
    <>
      <div>
        {pages.query.data?.requests.map((row) => (
          <p key={row.id}>{row.title}</p>
        ))}
      </div>
      <ConfirmationPages {...pages} />
    </>
  );
}

test("explicit next page reaches older work; failed navigation retains visible page", async () => {
  let failNext = true;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = api(input);
    calls.push(url.search);
    expect(url.searchParams.get("view")).toBe("actionable");
    expect(url.searchParams.get("limit")).toBe("50");
    if (!url.searchParams.has("cursor"))
      return Response.json({
        requests: [request("first-page")],
        nextCursor: "older/page+2",
      });
    expect(url.searchParams.get("cursor")).toBe("older/page+2");
    if (failNext)
      return Response.json({ error: "下一页暂时读不到" }, { status: 503 });
    return Response.json({
      requests: [request("old-pending")],
      nextCursor: null,
    });
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={cache()}>
      <PagedConfirmations />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.getByText("first-page")).toBeTruthy());
  expect(calls.length).toBe(1);
  fireEvent.click(view.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(calls.length).toBe(2));
  expect(view.getByText("first-page")).toBeTruthy();
  expect(view.getByText("第 1 页")).toBeTruthy();
  await waitFor(() =>
    expect(view.getByRole("button", { name: "加载失败" })).toBeTruthy(),
  );
  failNext = false;
  fireEvent.click(view.getByRole("button", { name: "加载失败" }));
  await waitFor(() => expect(view.getByText("old-pending")).toBeTruthy());
  expect(view.queryByText("first-page")).toBeNull();
  expect(view.getByText("第 2 页")).toBeTruthy();
  expect(calls.length).toBe(3);
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "上一页" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(view.getByRole("button", { name: "上一页" }));
  await waitFor(() => expect(view.getByText("first-page")).toBeTruthy());
});
test("confirmation polling follows accepted continuation and stops after settled or failed", async () => {
  const client = cache();
  const options = recentConfirmationsQueryOptions();
  for (const [state, expected] of [
    ["queued", 2000],
    ["running", 2000],
    ["completed", false],
    ["failed", false],
  ] as const) {
    client.setQueryData(confirmKeys.recent, [request("decided", { state })]);
    const query = client
      .getQueryCache()
      .build<
        ConfirmRequestView[],
        Error,
        ConfirmRequestView[],
        typeof confirmKeys.recent
      >(client, options);
    expect(typeof options.refetchInterval).toBe("function");
    if (typeof options.refetchInterval === "function") {
      expect(options.refetchInterval(query)).toBe(expected);
    }
  }
});

test("failed continuation remains visible after reload and the old resume marker", () => {
  const rows = [
    request("failed", {
      state: "failed",
      error: "暂时无法继续",
      retryable: true,
    }),
    request("queued", { state: "queued" }),
    request("done", { state: "completed" }),
  ];
  expect(
    looseConfirmations(
      rows,
      new Set(),
      new Set(["failed", "queued", "done"]),
    ).map((row) => row.id),
  ).toEqual(["failed", "queued"]);
});

test("confirmation retry is explicit and pending clicks cannot submit twice", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const view = render(
    <ConfirmCardView
      model={{
        category: "message",
        title: "发送报告",
        status: "approved",
        continuation: {
          state: "failed",
          retryable: true,
          error: "连接暂时不可用",
        },
      }}
      onRetry={async () => {
        calls++;
        await pending;
      }}
    />,
  );
  const button = view.getByRole("button", { name: "继续处理" });
  expect(view.getByText(/连接暂时不可用/)).toBeTruthy();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(calls).toBe(1);
  expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => {
    release();
    await pending;
  });
});

test("an already-started failed continuation cannot replay its effect", () => {
  const view = render(
    <ConfirmCardView
      model={{
        category: "delete",
        title: "清理文件",
        status: "approved",
        continuation: {
          state: "failed",
          retryable: false,
          error: "执行中断，请核对结果。",
        },
      }}
      onRetry={async () => {
        throw new Error("must never be offered");
      }}
    />,
  );
  expect(view.queryByRole("button", { name: "继续处理" })).toBeNull();
  expect(view.getByText("继续处理失败")).toBeTruthy();
  expect(view.getByText(/执行中断，请核对结果/)).toBeTruthy();
});

function SkillResult(props: InteractionRenderProps) {
  return (
    <ProposedSkillCard
      args={{ slug: "daily" }}
      result={props.result}
      continuation={props.continuation}
      retryContinuation={props.retryContinuation}
    />
  );
}
function RegisteredInteraction() {
  useInteractionRenderer({
    name: "save_skill",
    parameters: z.record(z.string(), z.unknown()),
    render: SkillResult,
  });
  return <DrawInteraction />;
}
function DrawInteraction() {
  const draw = useRenderToolCall();
  return draw({
    toolCall: {
      id: "call",
      type: "function",
      function: { name: "save_skill", arguments: "{}" },
    },
    toolMessage: {
      id: "result",
      role: "tool",
      toolCallId: "call",
      content: "已记录这次决定。",
    },
  });
}
function interactionView(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <ToolRendererProvider>
        <RegisteredInteraction />
      </ToolRendererProvider>
    </QueryClientProvider>,
  );
}

test("stored tool result still reads continuation and retry only requeues the existing answer", async () => {
  let continuation: ContinuationView = {
    state: "failed",
    retryable: true,
    error: "续执行未能开始",
  };
  let retries = 0;
  let answers = 0;
  globalThis.fetch = (async (input, init) => {
    const url = api(input);
    if (init?.method === "POST") {
      if (url.pathname.endsWith("/retry")) {
        retries++;
        continuation = { state: "queued" };
        return Response.json({ accepted: true });
      }
      answers++;
    }
    return Response.json({
      status: "answered",
      answer: "原答案",
      continuation,
    });
  }) as typeof fetch;
  const client = cache();
  const view = interactionView(client);
  await waitFor(() =>
    expect(view.getByRole("button", { name: "继续处理" })).toBeTruthy(),
  );
  expect(view.getByText("已记录这次决定。")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "继续处理" }));
  await waitFor(() => expect(view.getByText("等待继续")).toBeTruthy());
  expect(retries).toBe(1);
  expect(answers).toBe(0);
  continuation = { state: "running" };
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["conversation-interaction", "call"],
    });
  });
  await waitFor(() => expect(view.getByText("继续处理中")).toBeTruthy());
  continuation = { state: "completed" };
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["conversation-interaction", "call"],
    });
  });
  await waitFor(() => expect(view.getByText("后续已完成")).toBeTruthy());
  expect(view.queryByRole("button", { name: "继续处理" })).toBeNull();
});

test("retry rejected after another device handled it refreshes the current continuation", async () => {
  let posted = false;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      posted = true;
      return Response.json({ error: "已经开始，请查看结果" }, { status: 409 });
    }
    return Response.json({
      status: "answered",
      answer: "原答案",
      continuation: posted
        ? { state: "running" }
        : { state: "failed", retryable: true },
    });
  }) as typeof fetch;
  const view = interactionView(cache());
  await waitFor(() =>
    expect(view.getByRole("button", { name: "继续处理" })).toBeTruthy(),
  );
  fireEvent.click(view.getByRole("button", { name: "继续处理" }));
  await waitFor(() => expect(view.getByText("继续处理中")).toBeTruthy());
  expect(view.queryByRole("button", { name: "继续处理" })).toBeNull();
});
