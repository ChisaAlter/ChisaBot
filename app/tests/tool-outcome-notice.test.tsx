import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { type AgentSubscriber, EventType } from "@ag-ui/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolOutcomeNotice } from "@/components/channels/tool-outcome-notice";
import { toast } from "@/components/ui/toast";
import { ConversationSession } from "@/lib/chat/session-client";
import type {
  ToolOutcomeResolution,
  UnknownToolOperation,
} from "../../shared/conversations";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
let handler: typeof fetch;
const clients: QueryClient[] = [];
let restoreToasts: (() => void) | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    (...args: Parameters<typeof fetch>) => handler(...args),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  for (const query of clients.splice(0)) query.clear();
  restoreToasts?.();
  restoreToasts = undefined;
  await settleReactWork();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const operation: UnknownToolOperation = {
  id: "operation-1",
  toolName: "email_send",
  createdAt: "2026-11-10T12:00:00.000Z",
  error: "发送已开始，但回执没有返回。",
  canContinue: true,
  details: [{ label: "主题", value: "周报" }],
};

function harness(
  initial: UnknownToolOperation[] = [operation],
  initialReadError = false,
) {
  let operations = initial;
  let readError = initialReadError;
  const requests: ToolOutcomeResolution[] = [];
  let resolveRequest:
    | ((request: ToolOutcomeResolution) => Promise<Response>)
    | undefined;
  let reads = 0;
  const messages: string[] = [];
  const success = spyOn(toast, "success").mockImplementation((text) => {
    messages.push(text);
    return 0;
  });
  const error = spyOn(toast, "error").mockImplementation((text) => {
    messages.push(text);
    return 0;
  });
  restoreToasts = () => {
    success.mockRestore();
    error.mockRestore();
  };
  handler = Object.assign(
    async (url: RequestInfo | URL, options?: RequestInit) => {
      expect(String(url)).toStartWith("/api/conversations/thread-1/operations");
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body)) as ToolOutcomeResolution;
        requests.push(body);
        if (resolveRequest) return resolveRequest(body);
        operations = [];
        return NativeResponse.json({
          resolved: true,
          continued: body.continue,
        });
      }
      reads++;
      return readError
        ? NativeResponse.json({ error: "暂时不可用" }, { status: 503 })
        : NativeResponse.json({ operations });
    },
    { preconnect: originalFetch.preconnect },
  );
  const agent = new ConversationSession("bot-1", "thread-1", "bot-1");
  let subscriber: AgentSubscriber | undefined;
  agent.subscribe = (next) => {
    subscriber = next;
    return {
      unsubscribe: () => {
        subscriber = undefined;
      },
    };
  };
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(cache);
  const continued: boolean[] = [];
  const view = render(
    <QueryClientProvider client={cache}>
      <ToolOutcomeNotice
        agent={agent}
        ready
        onResolved={(next) => continued.push(next)}
      />
    </QueryClientProvider>,
  );
  return {
    view,
    requests,
    continued,
    messages,
    setOperations: (next: UnknownToolOperation[]) => {
      operations = next;
    },
    setReadError: (next: boolean) => {
      readError = next;
    },
    setResolver: (
      next: (request: ToolOutcomeResolution) => Promise<Response>,
    ) => {
      resolveRequest = next;
    },
    readCount: () => reads,
    finish: () =>
      subscriber?.onRunFinishedEvent?.({
        event: {
          type: EventType.RUN_FINISHED,
          threadId: "thread-1",
          runId: "run-1",
          outcome: { type: "success", pendingToolCallIds: [] },
        },
        outcome: "success",
        pendingToolCallIds: [],
        agent,
        messages: [],
        state: {},
        input: {
          threadId: "thread-1",
          runId: "run-1",
          messages: [],
          tools: [],
          context: [],
          state: {},
        },
      }),
  };
}

async function fill(
  view: ReturnType<typeof render>,
  outcome: ToolOutcomeResolution["outcome"] = "completed",
) {
  await view.findByRole("region", { name: "核对操作结果" });
  const user = userEvent.setup({ document: globalThis.document });
  await user.selectOptions(view.getByLabelText("实际结果"), outcome);
  await user.type(
    view.getByLabelText("核对说明"),
    "  已在目标服务核对结果。  ",
  );
}

test("reopens persisted unknown operation and requires an outcome and note before continuing", async () => {
  const { view, requests, continued } = harness();
  const submit = await view.findByRole("button", { name: "记录并继续" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByText("email_send")).toBeTruthy();
  expect(view.getByText("周报")).toBeTruthy();
  await fill(view);
  await act(async () => {
    fireEvent.click(submit);
  });
  await waitFor(() => expect(continued).toEqual([true]));
  expect(requests).toEqual([
    { outcome: "completed", note: "已在目标服务核对结果。", continue: true },
  ]);
  await waitFor(() =>
    expect(view.queryByRole("region", { name: "核对操作结果" })).toBeNull(),
  );
});

test("stopped or changed operations only record the observation", async () => {
  const { view, requests, continued } = harness([
    { ...operation, canContinue: false },
  ]);
  await fill(view, "not_executed");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "记录结果" }));
  });
  await waitFor(() => expect(continued).toEqual([false]));
  expect(requests[0]?.continue).toBe(false);
  expect(requests[0]?.outcome).toBe("not_executed");
});

test("pending save disables inputs and suppresses repeated clicks", async () => {
  const h = harness();
  let finish!: (response: Response) => void;
  h.setResolver(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await fill(h.view, "failed");
  const button = h.view.getByRole("button", { name: "记录并继续" });
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  expect(
    (h.view.getByLabelText("实际结果") as HTMLSelectElement).disabled,
  ).toBe(true);
  expect(
    (h.view.getByLabelText("核对说明") as HTMLTextAreaElement).disabled,
  ).toBe(true);
  await act(async () => {
    fireEvent.click(button);
  });
  expect(h.requests).toHaveLength(1);
  await act(async () => {
    finish(NativeResponse.json({ continued: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(h.continued).toEqual([true]);
  expect(h.requests[0]?.outcome).toBe("failed");
});

test("failed save keeps the user's observation and does not claim continuation", async () => {
  const h = harness();
  h.setResolver(async () =>
    NativeResponse.json({ error: "原任务已停止，请刷新。" }, { status: 409 }),
  );
  await fill(h.view);
  await act(async () => {
    fireEvent.click(h.view.getByRole("button", { name: "记录并继续" }));
  });
  await waitFor(() => expect(h.messages).toContain("原任务已停止，请刷新。"));
  expect((h.view.getByLabelText("核对说明") as HTMLTextAreaElement).value).toBe(
    "  已在目标服务核对结果。  ",
  );
  expect(h.continued).toEqual([]);
  expect(h.view.getByRole("region", { name: "核对操作结果" })).toBeTruthy();
});

test("a finished event discovers a new unknown operation when the prior query was empty", async () => {
  const h = harness([]);
  await waitFor(() => expect(h.readCount()).toBe(1));
  expect(h.view.queryByRole("region", { name: "核对操作结果" })).toBeNull();
  h.setOperations([operation]);
  await act(async () => {
    h.finish();
  });
  await h.view.findByRole("region", { name: "核对操作结果" });
  expect(h.readCount()).toBe(2);
});

test("a failed reload is visible and retry restores the persisted decision", async () => {
  const failed = harness([operation], true);
  await failed.view.findByRole("alert");
  failed.setReadError(false);
  await act(async () => {
    fireEvent.click(failed.view.getByRole("button", { name: "重试" }));
  });
  await failed.view.findByRole("region", { name: "核对操作结果" });
});
