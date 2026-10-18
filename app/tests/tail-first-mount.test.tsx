import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  TAIL_FIRST_INITIAL,
  TAIL_FIRST_THRESHOLD,
} from "@/lib/chat/tail-first-paint";
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

test("long transcript first paint is bounded, then catches up", async () => {
  const n = 120;
  const { container } = render(
    wrap(<ChatTranscript messages={manyMessages(n)} scrollKey="long-a" />),
  );
  const root = container.querySelector('[data-testid="chat-transcript"]');
  expect(root).not.toBeNull();
  expect(root?.hasAttribute("data-tail-first-pending")).toBe(true);
  const first = container.querySelectorAll(
    "[data-slot='message-scroller-item']",
  ).length;
  expect(first).toBeLessThanOrEqual(TAIL_FIRST_INITIAL + 4);
  expect(first).toBeGreaterThan(0);

  await waitFor(
    () => {
      expect(
        container
          .querySelector('[data-testid="chat-transcript"]')
          ?.hasAttribute("data-tail-first-pending"),
      ).toBe(false);
    },
    { timeout: 3000 },
  );

  await act(async () => {
    await settleReactWork();
  });

  expect(
    container.querySelectorAll("[data-slot='message-scroller-item']").length,
  ).toBeGreaterThanOrEqual(n);
});
