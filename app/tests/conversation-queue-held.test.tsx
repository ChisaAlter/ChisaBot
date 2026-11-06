import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  type RenderResult,
  render as rtlRender,
  waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import { ConversationView } from "@/components/channels/conversation-view";
import { settleReactWork } from "./settle-react-work";

/**
 * A PARKED MESSAGE WHOSE DRAIN FAILED HAD NO WAY OUT AT ALL.
 *
 * `heldBack` keeps a restored queue from re-sending itself against a dead server — the retry is
 * supposed to be something a person asks for. Nothing asked: the row went back to reading 排队,
 * with only 移除 beside it, so the sentence sat on screen promising a send that had already been
 * tried and lost, and the only thing to press was the one that threw it away.
 *
 * The fix is two pieces wired together: a failed drain marks the parked rows 没发出去 rather than
 * leaving 排队 on them, and a 重试 underneath runs the same drain the turn ending would have.
 */

function render(ui: ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  const result = rtlRender(wrap(ui));
  return {
    ...result,
    rerender: (next: ReactNode) => result.rerender(wrap(next as ReactElement)),
  };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

/** The editor's own way of taking words: a paste, caret collapsed to the end. */
function typeInto(container: HTMLElement, words: string) {
  const editor = editorOf(container);
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
      getData: (type: string) => (type === "text/plain" ? words : ""),
    },
  });
}

function parkedRow(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[aria-label^='移除队列消息']");
}

async function park(container: HTMLElement, words: string) {
  await act(async () => {
    typeInto(container, words);
  });
  await act(async () => {
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
  });
  await waitFor(() => expect(parkedRow(container)).not.toBeNull());
}

test("a drain that fails marks the parked rows and offers a way to send them again", async () => {
  const calls: ComposerDraft[] = [];
  let fail = true;
  const onSubmit = (draft: ComposerDraft) => {
    calls.push(draft);
    return fail
      ? Promise.reject(new Error("connection dropped"))
      : Promise.resolve();
  };
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending
      queueWhileBusy
    />,
  );
  const { container } = view;

  await park(container, "你在干什么");

  // The turn ends: the drain sends the parked message — and the send fails.
  view.rerender(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending={false}
      queueWhileBusy
    />,
  );
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.text).toContain("你在干什么");

  // THE FINDING this file exists for: the row is back, and it says what happened.
  await waitFor(() => {
    expect(parkedRow(container)).not.toBeNull();
    expect(container.textContent).toContain("没发出去");
    expect(
      container.querySelector("[aria-label='重试发送排队的消息']"),
    ).not.toBeNull();
  });
  // And it is not still claiming to be queued for a send that already lost.
  expect(container.textContent).not.toContain("排队");

  // Asking again runs the same drain the turn ending ran.
  fail = false;
  fireEvent.click(
    container.querySelector(
      "[aria-label='重试发送排队的消息']",
    ) as HTMLButtonElement,
  );
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]?.text).toContain("你在干什么");

  await waitFor(() => expect(parkedRow(container)).toBeNull());
});

test("a drain that keeps failing stays parked and keeps the retry", async () => {
  const calls: ComposerDraft[] = [];
  const onSubmit = (draft: ComposerDraft) => {
    calls.push(draft);
    return Promise.reject(new Error("still down"));
  };
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending
      queueWhileBusy
    />,
  );
  const { container } = view;

  await park(container, "correction one");
  view.rerender(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending={false}
      queueWhileBusy
    />,
  );
  await waitFor(() =>
    expect(
      container.querySelector("[aria-label='重试发送排队的消息']"),
    ).not.toBeNull(),
  );

  fireEvent.click(
    container.querySelector(
      "[aria-label='重试发送排队的消息']",
    ) as HTMLButtonElement,
  );
  await waitFor(() => expect(calls).toHaveLength(2));
  // The second failure puts everything back where a person can try it a third time.
  await waitFor(() => {
    expect(parkedRow(container)).not.toBeNull();
    expect(
      container.querySelector("[aria-label='重试发送排队的消息']"),
    ).not.toBeNull();
  });
});

test("a delayed inbox reply sends the follow-up after the original turn has already ended", async () => {
  const calls: ComposerDraft[] = [];
  let finishQueue!: (outcome: "send") => void;
  let queueCalls = 0;
  const queueToServer = () => {
    queueCalls++;
    return new Promise<"send">((resolve) => {
      finishQueue = resolve;
    });
  };
  const onSubmit = async (draft: ComposerDraft) => {
    calls.push(draft);
  };
  const screen = (pending: boolean) => (
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending={pending}
      queueWhileBusy
      queueToServer={queueToServer}
    />
  );
  const view = render(screen(true));
  await act(async () => {
    typeInto(view.container, "再核对一下结果");
  });
  await act(async () => {
    fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  });
  expect(queueCalls).toBe(1);
  expect(calls).toHaveLength(0);

  // The original answer finishes before the inbox POST says it did not queue the follow-up.
  view.rerender(screen(false));
  await act(async () => {
    finishQueue("send");
  });
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.text).toBe("再核对一下结果");
  await waitFor(() => expect(parkedRow(view.container)).toBeNull());
});

test("a delayed inbox reply stays queued until the original turn finishes", async () => {
  const calls: ComposerDraft[] = [];
  let finishQueue!: (outcome: "send") => void;
  const queueToServer = () =>
    new Promise<"send">((resolve) => {
      finishQueue = resolve;
    });
  const onSubmit = async (draft: ComposerDraft) => {
    calls.push(draft);
  };
  const screen = (pending: boolean) => (
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending={pending}
      queueWhileBusy
      queueToServer={queueToServer}
    />
  );
  const view = render(screen(true));
  await act(async () => {
    typeInto(view.container, "等当前工具完成再继续");
  });
  await act(async () => {
    fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  });
  await act(async () => {
    finishQueue("send");
  });
  await waitFor(() => expect(parkedRow(view.container)).not.toBeNull());
  expect(calls).toHaveLength(0);

  view.rerender(screen(false));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.text).toBe("等当前工具完成再继续");
});
