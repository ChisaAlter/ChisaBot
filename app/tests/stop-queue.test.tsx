import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueuedMessages } from "../src/components/chat/queued-messages";
import {
  hideHeldSupplements,
  shouldStopOnEscape,
} from "../src/lib/copilot/held-supplements";
import {
  applyInboxState,
  markRead,
  queuedFor,
  queueMessage,
  takeQueued,
  useReadMark,
} from "../src/lib/copilot/thread-inbox";

// CB-104: Stop and queued follow-ups.
const originalFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
let impl: typeof fetch;
beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.fetch = Object.assign(
    (...args: Parameters<typeof fetch>) => impl(...args),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const user = (id: string) => ({ id, role: "user" });
const bot = (id: string) => ({ id, role: "assistant" });

test("held follow-ups are hidden from the transcript, so they are shown once (problems 2 and 4)", () => {
  const messages = [
    user("long"),
    bot("partial"),
    user("read-then-held"),
    user("fresh"),
    bot("answer"),
  ];
  const view = hideHeldSupplements(
    messages,
    new Set(["read-then-held"]),
    new Set(["read-then-held"]),
  );
  expect(view.messages.map((message) => message.id)).toEqual([
    "long",
    "partial",
    "fresh",
    "answer",
  ]);
  // 「已停止」 moves to the message that opened the stopped turn; no unanswered card on the hidden one.
  expect([...view.stops]).toEqual(["long"]);
});

test("nothing held leaves messages and stops untouched (same references)", () => {
  const messages = [user("a"), bot("b")];
  const stops = new Set(["a"]);
  const view = hideHeldSupplements(messages, new Set(["other"]), stops);
  expect(view.messages).toBe(messages);
  expect(view.stops).toBe(stops);
});

test("Esc stops only a running turn, not during IME composition, a handled Esc, or while already stopping (problem 5)", () => {
  expect(shouldStopOnEscape({ key: "Escape", running: true })).toBe(true);
  expect(shouldStopOnEscape({ key: "Escape", running: false })).toBe(false);
  expect(
    shouldStopOnEscape({ key: "Escape", running: true, isComposing: true }),
  ).toBe(false);
  expect(
    shouldStopOnEscape({
      key: "Escape",
      running: true,
      defaultPrevented: true,
    }),
  ).toBe(false);
  expect(
    shouldStopOnEscape({ key: "Escape", running: true, stopping: true }),
  ).toBe(false);
  expect(shouldStopOnEscape({ key: "Enter", running: true })).toBe(false);
});

test("a message typed while Stop winds down waits, then is sent — never parked (problem 3)", async () => {
  const threadId = crypto.randomUUID();
  let posts = 0;
  impl = (async () => {
    posts++;
    return NativeResponse.json(
      posts < 3 ? { queued: false, stopping: true } : { queued: false },
    );
  }) as unknown as typeof fetch;
  expect(await queueMessage(threadId, "new after stop")).toBe("send");
  expect(posts).toBe(3);
  expect(queuedFor(threadId)).toEqual([]);
});

test("a follow-up the stopped turn read loses 「已读取」 once it is held, and held items keep send order (problem 2)", async () => {
  const threadId = crypto.randomUUID();
  impl = (async () =>
    NativeResponse.json({
      queued: true,
      status: "queued",
    })) as unknown as typeof fetch;
  await queueMessage(threadId, "first, read into the turn", "first");
  await queueMessage(threadId, "second, still queued", "second");
  markRead(threadId, "first");
  let mark = false;
  function Probe() {
    mark = useReadMark("first");
    return null;
  }
  render(<Probe />);
  expect(mark).toBe(true);
  act(() =>
    applyInboxState(threadId, {
      running: false,
      paused: true,
      items: [
        {
          id: "first",
          status: "paused",
          kind: "message",
          message: { content: "first, read into the turn" },
        },
        {
          id: "second",
          status: "paused",
          kind: "message",
          message: { content: "second, still queued" },
        },
      ],
    }),
  );
  expect(mark).toBe(false);
  expect(queuedFor(threadId).map((item) => [item.id, item.status])).toEqual([
    ["first", "paused"],
    ["second", "paused"],
  ]);
  expect(takeQueued(threadId)).toEqual([]);
});

test("「全部发送」 sends every held item in order", async () => {
  const threadId = crypto.randomUUID();
  act(() =>
    applyInboxState(threadId, {
      running: false,
      paused: true,
      items: [
        {
          id: "h1",
          status: "paused",
          kind: "message",
          message: { content: "one" },
        },
        {
          id: "h2",
          status: "paused",
          kind: "message",
          message: { content: "two" },
        },
      ],
    }),
  );
  const sent: string[] = [];
  const onSend = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        id: string;
        accept: (run: () => Promise<unknown>) => void;
      }>
    ).detail;
    detail.accept(async () => {
      sent.push(detail.id);
    });
  };
  window.addEventListener("chisabot-send-paused", onSend);
  try {
    const view = render(
      <CopilotChatConfigurationProvider threadId={threadId}>
        <QueuedMessages />
      </CopilotChatConfigurationProvider>,
    );
    const button = view.getByTestId("queued-send-all");
    expect(button.textContent).toBe("全部发送");
    fireEvent.click(button);
    await waitFor(() => expect(sent).toEqual(["h1", "h2"]));
  } finally {
    window.removeEventListener("chisabot-send-paused", onSend);
  }
});

test("a single held item has no 「全部发送」", () => {
  const threadId = crypto.randomUUID();
  act(() =>
    applyInboxState(threadId, {
      running: false,
      paused: true,
      items: [
        {
          id: "only",
          status: "paused",
          kind: "message",
          message: { content: "only" },
        },
      ],
    }),
  );
  const view = render(
    <CopilotChatConfigurationProvider threadId={threadId}>
      <QueuedMessages />
    </CopilotChatConfigurationProvider>,
  );
  expect(view.queryByTestId("queued-send-all")).toBeNull();
  expect(view.getByText("发送这条")).toBeTruthy();
});
