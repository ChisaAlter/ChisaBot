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
import { useState } from "react";
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
import { settleReactWork } from "./settle-react-work";

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
afterAll(async () => {
  await settleReactWork();
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

test("Esc does not stop while the IME is processing the key (keyCode 229)", () => {
  expect(
    shouldStopOnEscape({ key: "Escape", running: true, keyCode: 229 }),
  ).toBe(false);
  expect(
    shouldStopOnEscape({ key: "Escape", running: true, keyCode: 27 }),
  ).toBe(true);
});

test("a failed stop request says 「停止失败，重试」 at once; retry sends it again", async () => {
  const { useStopRequest } = await import("../src/lib/copilot/held-supplements");
  const { StopFailedButton } = await import(
    "../src/components/channels/composer/composer"
  );
  const calls: string[] = [];
  const replies: Array<() => Promise<Response>> = [
    () => Promise.reject(new TypeError("Failed to fetch")),
    async () => new NativeResponse("{}", { status: 503 }),
    async () => new NativeResponse("{}", { status: 200 }),
  ];
  const fake = ((url: string) => {
    calls.push(String(url));
    const next = replies.shift();
    return next ? next() : Promise.resolve(new NativeResponse("{}"));
  }) as unknown as typeof fetch;
  function Harness() {
    const stop = useStopRequest("thread-x", fake);
    return (
      <div>
        <button data-testid="stop" onClick={() => void stop.send()} type="button">
          {"停止"}
        </button>
        {stop.failed ? (
          <StopFailedButton onRetry={() => void stop.send()} />
        ) : null}
      </div>
    );
  }
  const view = render(<Harness />);
  fireEvent.click(view.getByTestId("stop"));
  const failed = await view.findByTestId("composer-stop-failed");
  expect(failed.textContent).toBe("停止失败，重试");
  expect(calls).toEqual(["/api/copilotkit/threads/thread-x/unlock"]);
  // 5xx on retry: still failing, still offered.
  fireEvent.click(failed);
  await waitFor(() => expect(calls.length).toBe(2));
  expect(view.getByTestId("composer-stop-failed")).toBeTruthy();
  // Success on the next retry: prompt goes away.
  fireEvent.click(view.getByTestId("composer-stop-failed"));
  await waitFor(() => expect(calls.length).toBe(3));
  await waitFor(() =>
    expect(view.queryByTestId("composer-stop-failed")).toBeNull(),
  );
});

// CB-104: once the turn is over, 「停止失败，重试」 goes away and the normal Send button is back.
const turnEnds: Array<{ name: string; turn: { running?: boolean; status?: string } }> = [
  { name: "the stream ends (running → false)", turn: { running: false } },
  { name: "status → done", turn: { running: true, status: "done" } },
  { name: "status → stopped", turn: { running: true, status: "stopped" } },
  { name: "status → error", turn: { running: true, status: "error" } },
];
for (const { name, turn: endedTurn } of turnEnds) {
  test(`「停止失败，重试」 clears when the turn ends: ${name}`, async () => {
    const { useStopRequest } = await import("../src/lib/copilot/held-supplements");
    const { Composer } = await import("../src/components/channels/composer/composer");
    const fake = (async () => new NativeResponse("{}", { status: 503 })) as unknown as typeof fetch;
    let setTurn: (t: { running?: boolean; status?: string }) => void = () => {};
    function Harness() {
      const [turn, set] = useState<{ running?: boolean; status?: string }>({ running: true });
      setTurn = set;
      const stop = useStopRequest("thread-end", fake, turn);
      const busy = turn.running === true && !turn.status;
      return (
        <Composer
          compact
          initialValue="next"
          onRetryStop={() => void stop.send()}
          onStop={() => void stop.send()}
          onSubmit={async () => {}}
          pending={busy}
          stopFailed={stop.failed}
        />
      );
    }
    const view = render(<Harness />);
    fireEvent.click(view.getByTestId("composer-stop"));
    await view.findByTestId("composer-stop-failed");
    await act(async () => setTurn(endedTurn));
    await waitFor(() => expect(view.queryByTestId("composer-stop-failed")).toBeNull());
    expect(view.getByTestId("composer-send")).toBeTruthy();
    expect(view.queryByTestId("composer-stop")).toBeNull();
  });
}

test("a new turn does not inherit the previous turn's 「停止失败，重试」", async () => {
  const { useStopRequest } = await import("../src/lib/copilot/held-supplements");
  const fake = (async () => new NativeResponse("{}", { status: 503 })) as unknown as typeof fetch;
  let api: { send: () => Promise<boolean> } | null = null;
  let setRunning: (r: boolean | undefined) => void = () => {};
  function Harness() {
    const [running, set] = useState<boolean | undefined>(undefined);
    setRunning = set;
    const stop = useStopRequest("thread-new", fake, { running });
    api = stop;
    return <div data-testid="state">{stop.failed ? "failed" : "ok"}</div>;
  }
  const view = render(<Harness />);
  await act(async () => {
    await api?.send();
  });
  expect(view.getByTestId("state").textContent).toBe("failed");
  // Unknown → false ends it; then the next turn starts clean.
  await act(async () => setRunning(false));
  expect(view.getByTestId("state").textContent).toBe("ok");
  await act(async () => setRunning(true));
  expect(view.getByTestId("state").textContent).toBe("ok");
  // Fails during the new turn, the turn ends, the following turn starts clean too.
  await act(async () => {
    await api?.send();
  });
  expect(view.getByTestId("state").textContent).toBe("failed");
  await act(async () => setRunning(false));
  await act(async () => setRunning(true));
  expect(view.getByTestId("state").textContent).toBe("ok");
});
