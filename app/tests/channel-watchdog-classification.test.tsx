import "./channel-new-error-state.fixture";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import * as View from "@/components/channels/conversation-view";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import {
  clearComposerInputs,
  dispatchComposerQuote,
} from "@/lib/chat/quote-event";
import { ConversationSessionProvider } from "@/lib/chat/session-client";
import {
  listenSendLanded,
  resetUiMemory,
  threadUi,
} from "@/lib/chat/ui-memory";
import {
  SEND_UNREACHABLE_REASON,
  SendDeliveryUnknownError,
} from "@/lib/conversations/connection-drop";
import { resetStoredSyncs } from "@/lib/conversations/thread-messages";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

// Observe the exact rejection at the existing view boundary while rendering the real
// ConversationView and Composer, preserving their actual recovery/late-acceptance effects.
type ViewProps = ComponentProps<typeof View.ConversationView>;
let currentView: ViewProps | undefined;
const ActualView = View.ConversationView;
let failures: unknown[] = [];
const NativeResponse = globalThis.Response;
const nativeNow = Date.now;
const nativeFetch = globalThis.fetch;
let offset = 0;
let mode: "unknown" | "absent" = "unknown";
let requests: { path: string; method: string }[] = [];
let submissions: RunAgentInput[] = [];
let acceptPost: () => void;
let accepted = false;
let stored: Message[] = [];
let restoreView: () => void;
let restoreClock: () => void;
const channel: AgentChannel = {
  id: "watchdog-channel",
  name: "Watchdog",
  agentIds: ["watchdog-bot"],
  threadId: "watchdog-thread",
  active: true,
  lastMessageAt: null,
};

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://localhost/channel/watchdog-channel",
  }),
);
beforeEach(() => {
  offset = 0;
  requests = [];
  submissions = [];
  failures = [];
  accepted = false;
  stored = [];
  currentView = undefined;
  resetUiMemory();
  clearComposerInputs();
  window.localStorage.clear();
  const view = spyOn(View, "ConversationView").mockImplementation((props) => {
    currentView = props;
    return (
      <ActualView
        {...props}
        onSubmit={async (draft) => {
          try {
            await props.onSubmit(draft);
          } catch (error) {
            failures.push(error);
            throw error;
          }
        }}
      />
    );
  });
  restoreView = () => view.mockRestore();
  const clock = spyOn(Date, "now").mockImplementation(
    () => nativeNow() + offset,
  );
  restoreClock = () => clock.mockRestore();
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    const path = url.pathname;
    requests.push({ path, method: init?.method ?? "GET" });
    if (path === "/api/agents") return NativeResponse.json({ agents: [] });
    if (path === "/api/plugins/for/watchdog-bot")
      return NativeResponse.json({ skills: [], tools: [] });
    if (path.endsWith("/connect"))
      return sse([
        { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
        { type: "MESSAGES_SNAPSHOT", messages: stored },
        { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
      ]);
    if (path.endsWith("/commands")) {
      submissions.push(JSON.parse(String(init?.body)).input);
      // The POST is still outstanding when watchdog evidence is read. Unmount aborts the
      // owned observation afterward, without manufacturing an acceptance or model response.
      return new Promise<Response>((resolve, reject) => {
        acceptPost = () => {
          accepted = true;
          const submission = submissions[0]!;
          stored = [
            ...submission.messages,
            {
              id: "late-answer",
              role: "assistant",
              content: "Late accepted answer",
            },
          ];
          resolve(
            NativeResponse.json(
              {
                accepted: true,
                commandId: submission.messages.at(-1)?.id,
                runId: submission.runId,
              },
              { status: 202 },
            ),
          );
        };
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    if (path.endsWith("/events")) {
      const submission = submissions[0]!;
      return sse([
        {
          type: "RUN_STARTED",
          threadId: channel.threadId,
          runId: submission.runId,
        },
        { type: "MESSAGES_SNAPSHOT", messages: stored },
        {
          type: "RUN_FINISHED",
          threadId: channel.threadId,
          runId: submission.runId,
        },
      ]);
    }
    if (path.endsWith("/messages")) {
      if (!accepted && submissions.length > 0 && mode === "unknown")
        return NativeResponse.json({}, { status: 503 });
      return NativeResponse.json({
        messages: stored,
        version: accepted ? "v2" : "v1",
        cursor: accepted ? "c2" : "c1",
        start: 0,
      });
    }
    if (path.endsWith("/inbox"))
      return !accepted && submissions.length > 0 && mode === "unknown"
        ? NativeResponse.json({}, { status: 503 })
        : NativeResponse.json({ running: false, items: [] });
    if (path.includes("/stop/")) return NativeResponse.json({ stopped: true });
    if (path.endsWith("/unlock"))
      return NativeResponse.json({ unlocked: true });
    if (
      path === "/api/ops/budget" ||
      path.endsWith("/busy") ||
      path.endsWith("/activity")
    )
      return NativeResponse.json({});
    return NativeResponse.json({}, { status: 404 });
  }) as typeof fetch;
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: "2026-11-11T00:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
});

afterEach(async () => {
  cleanup();
  // End the existing bounded reconciliation before restoring shared globals. This advances
  // only wall-clock observation; the production watchdog and reconciliation timers still run.
  offset += 100_000;
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  restoreClock();
  restoreView();
  globalThis.fetch = nativeFetch;
  queryClient.clear();
  resetStoredSyncs();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

for (const scenario of ["unknown", "absent"] as const) {
  test(`pending command with ${scenario === "unknown" ? "unreadable" : "empty"} witnesses retains its sent guard, then retracts only the late accepted copy`, async () => {
    mode = scenario;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConversationSessionProvider>
          <ChannelChat channel={channel} runtimeAgentId="watchdog-bot" />
        </ConversationSessionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(currentView?.restoring).toBe(false));
    const editor = view.getByRole("textbox", { name: "消息" });
    await act(async () => {
      fireEvent.input(editor, { target: { textContent: "Send exactly once" } });
      dispatchComposerQuote({ text: "original quote" });
    });
    await act(async () => {
      fireEvent.submit(editor.closest("form")!);
    });
    await waitFor(() => expect(submissions).toHaveLength(1));
    offset += 13_000;
    await waitFor(() => expect(failures).toHaveLength(1), { timeout: 2_500 });
    expect(failures[0]).toBeInstanceOf(SendDeliveryUnknownError);
    expect((failures[0] as Error).message).toBe(SEND_UNREACHABLE_REASON);
    expect(requests.some((request) => request.path.includes("/stop/"))).toBe(
      false,
    );
    expect(requests.some((request) => request.path.endsWith("/unlock"))).toBe(
      false,
    );
    await waitFor(() => expect(editor.textContent).toBe("Send exactly once"));
    expect(threadUi(channel.id)?.sent).toBe(
      "> original quote\n\nSend exactly once",
    );
    expect(view.getByTestId("composer-reply-quote").textContent).toContain(
      "original quote",
    );
    expect(submissions).toHaveLength(1);

    await act(async () => {
      appendText(editor, " newer draft");
    });
    expect(editor.textContent).toContain("newer draft");
    const landed: string[] = [];
    const off = listenSendLanded(channel.id, (text) => landed.push(text));
    try {
      await act(async () => acceptPost());
      await waitFor(
        () => expect(landed).toEqual(["> original quote\n\nSend exactly once"]),
        { timeout: 3_000 },
      );
      await waitFor(() =>
        expect(editor.textContent?.trim()).toBe("newer draft"),
      );
      expect(view.queryByTestId("composer-reply-quote")).toBeNull();
      expect(view.queryByText(SEND_UNREACHABLE_REASON)).toBeNull();
    } finally {
      off();
    }
    expect(submissions).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" && request.path.endsWith("/inbox"),
      ),
    ).toEqual([]);
  }, 10_000);
}

function appendText(editor: HTMLElement, text: string) {
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}
