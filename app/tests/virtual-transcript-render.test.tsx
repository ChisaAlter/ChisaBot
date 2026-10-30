import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
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
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { transcriptSizeCache } from "@/components/channels/virtual-transcript";
import { MESSAGE_FLASH_CLASS } from "@/lib/channels/focus-message";
import { VIRTUAL_TAIL_ROWS } from "@/lib/chat/virtual-transcript";
import { resetVirtualTranscriptForTest } from "@/lib/chat/virtual-transcript-flag";
import { settleReactWork } from "./settle-react-work";

/**
 * jank P3-3：flag 打开时走 virtua，关着时走原来的 tail-first。happy-dom 没有布局，
 * 这里断言结构（哪些行在虚拟列表里、末尾常驻、shift、缓存、Ctrl+F），像素级「不跳 ≤1px」留给 Playwright / harness。
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
  resetVirtualTranscriptForTest(null);
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function wrap(node: ReactNode) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>
  );
}

function manyMessages(n: number, from = 0): Message[] {
  const out: Message[] = [];
  for (let i = from; i < from + n; i++) {
    out.push({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `line-${i} ${"字".repeat(8)}`,
    });
  }
  return out;
}

const content = (c: HTMLElement) =>
  c.querySelector('[data-testid="chat-transcript"]') as HTMLElement;

test("flag 关：走旧的 tail-first 路径，没有虚拟列表", () => {
  resetVirtualTranscriptForTest(false);
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(120)} scrollKey="off" />),
  );
  expect(
    container.querySelector('[data-testid="virtual-transcript"]'),
  ).toBeNull();
  expect(content(container).hasAttribute("data-tail-first-pending")).toBe(true);
});

test("flag 开：tail-first 不补行，除末尾几行外都交给虚拟列表", () => {
  resetVirtualTranscriptForTest(true);
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(120)} scrollKey="on" />),
  );
  const box = container.querySelector('[data-testid="virtual-transcript"]');
  expect(box).not.toBeNull();
  expect(box?.getAttribute("data-virtual-rows")).toBe(
    String(120 - VIRTUAL_TAIL_ROWS),
  );
  expect(content(container).hasAttribute("data-tail-first-pending")).toBe(
    false,
  );
  // 末尾常驻：最后几行是滚动内容的直接子元素，不在虚拟列表里
  for (let i = 120 - VIRTUAL_TAIL_ROWS; i < 120; i++) {
    const row = container.querySelector(`[data-message-id="m-${i}"]`);
    expect(row).not.toBeNull();
    expect(row?.closest('[data-testid="virtual-transcript"]')).toBeNull();
    expect(row?.parentElement).toBe(content(container));
  }
  // 远处的老消息没挂
  expect(container.querySelector('[data-message-id="m-60"]')).toBeNull();
});

test("流式中：末尾那一行原地更新，不重挂、不进虚拟列表", () => {
  resetVirtualTranscriptForTest(true);
  const base = manyMessages(60);
  const stream = (text: string): Message[] => [
    ...base,
    { id: "live", role: "assistant", content: text },
  ];
  const { container, rerender } = render(
    wrap(<ChatTranscript busy messages={stream("一")} scrollKey="stream" />),
  );
  const before = container.querySelector('[data-message-id="live"]');
  expect(before).not.toBeNull();
  rerender(
    wrap(
      <ChatTranscript
        busy
        messages={stream("一二三四五")}
        scrollKey="stream"
      />,
    ),
  );
  const after = container.querySelector('[data-message-id="live"]');
  expect(after).toBe(before);
  expect(after?.closest('[data-testid="virtual-transcript"]')).toBeNull();
});

test("前插历史：虚拟列表行数增加，末尾常驻的行不重挂（shift 保位）", () => {
  resetVirtualTranscriptForTest(true);
  const { container, rerender } = render(
    wrap(
      <ChatTranscript messages={manyMessages(40, 40)} scrollKey="prepend" />,
    ),
  );
  const tail = container.querySelector('[data-message-id="m-79"]');
  const viewport = content(container).parentElement as HTMLElement;
  const top = viewport.scrollTop;
  rerender(
    wrap(<ChatTranscript messages={manyMessages(80, 0)} scrollKey="prepend" />),
  );
  expect(
    container
      .querySelector('[data-testid="virtual-transcript"]')
      ?.getAttribute("data-virtual-rows"),
  ).toBe(String(80 - VIRTUAL_TAIL_ROWS));
  expect(container.querySelector('[data-message-id="m-79"]')).toBe(tail);
  expect(viewport.scrollTop).toBe(top);
});

test("行高缓存：卸载时按会话 key 存下，切回同一段复用", () => {
  resetVirtualTranscriptForTest(true);
  transcriptSizeCache.release("cache-key");
  const messages = manyMessages(30);
  const first = render(
    wrap(<ChatTranscript messages={messages} scrollKey="cache-key" />),
  );
  first.unmount();
  const ids = messages.slice(0, 30 - VIRTUAL_TAIL_ROWS).map((m) => m.id);
  expect(transcriptSizeCache.restore("cache-key", ids)).toBeDefined();
  // 别的会话拿不到
  expect(transcriptSizeCache.restore("other-key", ids)).toBeUndefined();
});

test("Ctrl+F（flag 开）：应用内搜索，命中行滚到并高亮，Enter 换下一个，Esc 关", async () => {
  resetVirtualTranscriptForTest(true);
  const messages = manyMessages(40);
  messages[39] = {
    id: "m-39",
    role: "assistant",
    content: "needle at the end",
  };
  messages[38] = { id: "m-38", role: "user", content: "another needle" };
  const { container } = render(
    wrap(<ChatTranscript messages={messages} scrollKey="find" />),
  );
  const event = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  const bar = container.querySelector('[data-testid="transcript-find"]');
  expect(bar).not.toBeNull();
  const input = bar?.querySelector("input") as HTMLInputElement;
  // React 19 在 happy-dom 下会丢掉直接派发的 input 事件，用 user-event 打字。
  const user = userEvent.setup({ document: globalThis.document });
  await user.type(input, "needle");
  await waitFor(() =>
    expect(
      container.querySelector('[data-testid="transcript-find-count"]')
        ?.textContent,
    ).toBe("2/2"),
  );
  await waitFor(() => {
    const row = container.querySelector('[data-message-id="m-39"]');
    expect(row?.hasAttribute("data-find-current")).toBe(true);
    expect(row?.classList.contains(MESSAGE_FLASH_CLASS)).toBe(true);
  });
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      container
        .querySelector('[data-message-id="m-38"]')
        ?.hasAttribute("data-find-current"),
    ).toBe(true),
  );
  expect(
    container
      .querySelector('[data-message-id="m-39"]')
      ?.hasAttribute("data-find-current"),
  ).toBe(false);
  await user.keyboard("{Escape}");
  expect(container.querySelector('[data-testid="transcript-find"]')).toBeNull();
});

test("Ctrl+F（flag 关）：不拦截，交给浏览器", () => {
  resetVirtualTranscriptForTest(false);
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(10)} scrollKey="nofind" />),
  );
  const event = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(false);
  expect(container.querySelector('[data-testid="transcript-find"]')).toBeNull();
});
