import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  MOUNT_ALL_HISTORY_EVENT,
  TAIL_FIRST_CAP,
  TAIL_FIRST_INITIAL,
  TAIL_FIRST_THRESHOLD,
} from "@/lib/chat/tail-first-paint";
import { setThreadUi } from "@/lib/chat/ui-memory";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-025：长对话首屏先挂尾巴。这里只断言「挂载条数有界 → 很快补全」，
 * 不进浏览器量 4× CPU（那是生产狗粮 / FRA）；chat-scroll 回归仍是 §35 闸门。
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => cleanup());

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function wrap(node: ReactNode) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      {node}
    </QueryClientProvider>
  );
}

function manyMessages(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    out.push({
      id: `m-${i}`,
      role,
      content: `line-${i} ${"字".repeat(8)}`,
    });
  }
  return out;
}

test("short transcript mounts every row on first paint", () => {
  const n = TAIL_FIRST_THRESHOLD;
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(n)} scrollKey="short" />),
  );
  const root = container.querySelector('[data-testid="chat-transcript"]');
  expect(root).not.toBeNull();
  expect(root?.hasAttribute("data-tail-first-pending")).toBe(false);
  expect(
    container.querySelectorAll("[data-slot='message-scroller-item']").length,
  ).toBeGreaterThanOrEqual(n);
});

const rowCount = (container: HTMLElement) =>
  container.querySelectorAll("[data-slot='message-scroller-item']").length;
const transcript = (container: HTMLElement) =>
  container.querySelector('[data-testid="chat-transcript"]');
const waitCaughtUp = (container: HTMLElement) =>
  waitFor(
    () => {
      expect(
        transcript(container)?.hasAttribute("data-tail-first-pending"),
      ).toBe(false);
    },
    { timeout: 3000 },
  );

test("long transcript first paint is bounded, then catches up to the cap and stops", async () => {
  const n = 120;
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(n)} scrollKey="long-a" />),
  );
  expect(transcript(container)).not.toBeNull();
  expect(transcript(container)?.hasAttribute("data-tail-first-pending")).toBe(
    true,
  );
  const first = rowCount(container);
  expect(first).toBeLessThanOrEqual(TAIL_FIRST_INITIAL + 4);
  expect(first).toBeGreaterThan(0);

  await waitCaughtUp(container);
  await act(async () => {
    await settleReactWork();
  });

  // The automatic catch-up stops at the cap: older history is not mounted until it is asked for.
  const rows = rowCount(container);
  expect(rows).toBeGreaterThanOrEqual(TAIL_FIRST_CAP);
  expect(rows).toBeLessThanOrEqual(TAIL_FIRST_CAP + 4);
  expect(rows).toBeLessThan(n);
  expect(transcript(container)?.hasAttribute("data-tail-first-truncated")).toBe(
    true,
  );
});

test("a transcript under the cap still mounts every row", async () => {
  const n = TAIL_FIRST_CAP - 10;
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(n)} scrollKey="mid" />),
  );
  await waitCaughtUp(container);
  await act(async () => {
    await settleReactWork();
  });
  expect(rowCount(container)).toBeGreaterThanOrEqual(n);
  expect(transcript(container)?.hasAttribute("data-tail-first-truncated")).toBe(
    false,
  );
});

test("the mount-all event on the scroll container mounts the older history", async () => {
  const n = 120;
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(n)} scrollKey="long-b" />),
  );
  await waitCaughtUp(container);
  await act(async () => {
    await settleReactWork();
  });
  expect(rowCount(container)).toBeLessThan(n);

  const viewport = container.querySelector(
    '[data-slot="message-scroller-viewport"]',
  );
  expect(viewport).not.toBeNull();
  await act(async () => {
    viewport?.dispatchEvent(new Event(MOUNT_ALL_HISTORY_EVENT));
    await settleReactWork();
  });
  await waitFor(() => expect(rowCount(container)).toBeGreaterThanOrEqual(n), {
    timeout: 3000,
  });
  expect(transcript(container)?.hasAttribute("data-tail-first-truncated")).toBe(
    false,
  );
});

test("a saved scroll anchor (left mid-conversation) opens with the whole history mounted", async () => {
  const n = 120;
  setThreadUi("long-c", {
    scroll: {
      atBottom: false,
      spacer: 0,
      anchor: "m-3",
      offset: 0,
      at: Date.now(),
    },
  });
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(n)} scrollKey="long-c" />),
  );
  await waitFor(() => expect(rowCount(container)).toBeGreaterThanOrEqual(n), {
    timeout: 3000,
  });
  expect(transcript(container)?.hasAttribute("data-tail-first-truncated")).toBe(
    false,
  );
});
