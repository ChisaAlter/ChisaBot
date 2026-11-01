import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Composer } from "@/components/channels/composer/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "https://chisabot.test/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/*
 * ConversationView 里的会话流会读这一串对话的确认卡（react-query，2026-10-20 起）。直接 render 会
 * 「No QueryClient set」，所以这里给两层包装；rerender 也用同一份 client，免得每次换一棵新树。
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
});
const wrap = (node: ReactNode) => <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;

test("saving a model blocks click and Enter sends while retaining the draft", async () => {
  let sent = 0;
  const props = { initialValue: "keep these words", onSubmit: () => { sent += 1; } };
  const view = render(<Composer compact {...props} sendBlocked modelControl={<span>model picker</span>} />);
  const editor = view.container.querySelector("[contenteditable]") as HTMLElement;
  expect(view.getByText("model picker")).toBeTruthy();
  expect((view.getByLabelText("发送消息") as HTMLButtonElement).disabled).toBe(true);
  expect(editor.getAttribute("contenteditable")).toBe("true");
  await act(async () => {
    fireEvent.click(view.getByLabelText("发送消息"));
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    // Covers the form path too: keyboard submission must never bypass the button gate.
    fireEvent.submit(view.container.querySelector("form")!);
  });
  expect(sent).toBe(0);
  expect(editor.textContent).toContain("keep these words");
  view.rerender(<Composer compact {...props} sendBlocked={false} />);
  await act(async () => fireEvent.click(view.getByLabelText("发送消息")));
  expect(sent).toBe(1);
});

test("saving a model blocks message parking instead of treating it as a busy turn", async () => {
  let queued = 0;
  const view = render(<Composer compact pending sendBlocked initialValue="not queued yet" onQueue={() => { queued += 1; }} />);
  expect((view.getByLabelText("排队发送") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => fireEvent.submit(view.container.querySelector("form")!));
  expect(queued).toBe(0);
  expect(view.container.querySelector("[contenteditable]")?.textContent).toContain("not queued yet");
});

test("a parked message waits for the model save and drains when it finishes", async () => {
  let sent = 0;
  const props = { messages: [], onSubmit: () => { sent += 1; }, queueWhileBusy: true };
  const view = render(wrap(<ConversationView {...props} pending />));
  const editor = view.container.querySelector("[contenteditable]") as HTMLElement;
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  await act(async () => {
    fireEvent.paste(editor, { clipboardData: { files: [], items: [], types: ["text/plain"], getData: (type: string) => type === "text/plain" ? "parked correction" : "" } });
  });
  await act(async () => fireEvent.click(view.getByLabelText("排队发送")));
  expect(sent).toBe(0);
  view.rerender(wrap(<ConversationView {...props} pending={false} sendBlocked />));
  await act(async () => {});
  expect(sent).toBe(0);
  expect(view.container.textContent).toContain("parked correction");
  view.rerender(wrap(<ConversationView {...props} pending={false} sendBlocked={false} />));
  await act(async () => {});
  expect(sent).toBe(1);
});
