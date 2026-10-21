import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useTailFirstMount } from "@/lib/chat/use-tail-first-mount";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function History({
  ids,
  thread = "identity-thread",
}: {
  ids: string[];
  thread?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const mount = useTailFirstMount(ids.length, thread, viewport, ids[0]);
  return (
    <div ref={viewport} data-pending={mount.pending}>
      {ids.slice(mount.startIndex).map((id) => (
        <div key={id} data-message-id={id}>
          {id}
        </div>
      ))}
    </div>
  );
}

// Watch actual removals across commits, not only the final DOM. A layout-effect correction can
// remount a row before rerender() returns and still erase its selection, local state and scroll anchor.
test("appending user and streamed assistant messages preserves every mounted history node", async () => {
  const ids = Array.from({ length: 90 }, (_, n) => `history-${n}`);
  const view = render(<History ids={ids} />);
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-message-id]").length).toBe(
      90,
    ),
  );
  const original = [...view.container.querySelectorAll("[data-message-id]")];
  const removed: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.removedNodes) {
        if (node instanceof HTMLElement && node.dataset.messageId)
          removed.push(node.dataset.messageId);
      }
  });
  observer.observe(view.container, { childList: true, subtree: true });
  try {
    await act(async () => {
      view.rerender(<History ids={[...ids, "new-user"]} />);
      await Promise.resolve();
    });
    await act(async () => {
      view.rerender(<History ids={[...ids, "new-user", "streaming-answer"]} />);
      await Promise.resolve();
    });
    await act(async () => {
      // A new snapshot array with identical IDs must also keep the original elements.
      view.rerender(<History ids={[...ids, "new-user", "streaming-answer"]} />);
      await Promise.resolve();
    });
    expect(removed).toEqual([]);
    for (const node of original) {
      expect(node.isConnected).toBe(true);
      expect(
        view.container.querySelector(
          `[data-message-id="${node.getAttribute("data-message-id")}"]`,
        ),
      ).toBe(node);
    }
    expect(view.container.querySelectorAll("[data-message-id]")).toHaveLength(
      92,
    );
  } finally {
    observer.disconnect();
  }
});

test("the real transcript preserves history and the pending user through stream, failure and replay snapshots", async () => {
  const messages: Message[] = Array.from({ length: 90 }, (_, n) => ({
    id: `transcript-${n}`,
    role: n % 2 === 0 ? "user" : "assistant",
    content: `Historical line ${n}`,
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (next: Message[], busy: boolean, stopped?: string) => (
    <QueryClientProvider client={client}>
      <ChatTranscript
        messages={next}
        busy={busy}
        {...(stopped ? { stopped } : {})}
        scrollKey="identity-full"
      />
    </QueryClientProvider>
  );
  const view = render(tree(messages, false));
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-message-id]").length).toBe(
      90,
    ),
  );
  const original = [...view.container.querySelectorAll("[data-message-id]")];
  const removed: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.dataset.messageId) removed.push(node.dataset.messageId);
        for (const row of node.querySelectorAll<HTMLElement>(
          "[data-message-id]",
        ))
          removed.push(row.dataset.messageId!);
      }
  });
  observer.observe(view.container, { childList: true, subtree: true });
  try {
    const user: Message = {
      id: "pending-user",
      role: "user",
      content: "Keep this message even if sending fails",
    };
    await act(async () => view.rerender(tree([...messages, user], true)));
    const pending = view.container.querySelector(
      '[data-message-id="pending-user"]',
    );
    await act(async () =>
      view.rerender(tree([...messages, user], false, "Endpoint is offline")),
    );
    expect(
      view.container.querySelector('[data-message-id="pending-user"]'),
    ).toBe(pending);
    const reply: Message = {
      id: "streamed-reply",
      role: "assistant",
      content: "The first chunk",
    };
    await act(async () =>
      view.rerender(tree([...messages, user, reply], true)),
    );
    reply.content += " and the final chunk";
    await act(async () =>
      view.rerender(tree([...messages, user, reply], true)),
    );
    await act(async () =>
      view.rerender(tree([...messages, user, { ...reply }], false)),
    );
    await act(async () =>
      view.rerender(tree([...messages, user, { ...reply }], false)),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(removed).toEqual([]);
    for (const node of original) {
      expect(node.isConnected).toBe(true);
      expect(
        view.container.querySelector(
          `[data-message-id="${node.getAttribute("data-message-id")}"]`,
        ),
      ).toBe(node);
    }
    expect(
      view.container.querySelector('[data-message-id="pending-user"]'),
    ).toBe(pending);
    await waitFor(() =>
      expect(view.container.textContent).toContain("and the final chunk"),
    );
  } finally {
    observer.disconnect();
    client.clear();
  }
});

test("stop and fallback markers are siblings and never replace their anchor message", () => {
  const messages: Message[] = [
    { id: "marker-user", role: "user", content: "Please begin" },
    { id: "marker-answer", role: "assistant", content: "Partial answer" },
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (
    stops: ReadonlySet<string>,
    fallbacks?: ReadonlyMap<string, string>,
  ) => (
    <QueryClientProvider client={client}>
      <ChatTranscript
        messages={messages}
        stoppedTurns={stops}
        {...(fallbacks ? { fallbacks } : {})}
        scrollKey="marker-identity"
      />
    </QueryClientProvider>
  );
  const view = render(tree(new Set()));
  const answer = view.container.querySelector(
    '[data-message-id="marker-answer"]',
  );
  expect(answer).not.toBeNull();
  view.rerender(tree(new Set(["marker-user"])));
  expect(
    view.container.querySelector('[data-testid="turn-stopped"]'),
  ).not.toBeNull();
  expect(
    view.container.querySelector('[data-message-id="marker-answer"]'),
  ).toBe(answer);
  view.rerender(
    tree(new Set(), new Map([["marker-user", "Switched provider"]])),
  );
  expect(
    view.container.querySelector('[data-testid="turn-fallback"]'),
  ).not.toBeNull();
  expect(
    view.container.querySelector('[data-message-id="marker-answer"]'),
  ).toBe(answer);
  view.rerender(tree(new Set()));
  expect(
    view.container.querySelector('[data-message-id="marker-answer"]'),
  ).toBe(answer);
  client.clear();
});

test("crossing the tail-first threshold does not unmount any of the already visible short history", () => {
  const ids = Array.from({ length: 48 }, (_, n) => `boundary-${n}`);
  const view = render(<History ids={ids} />);
  const original = [...view.container.querySelectorAll("[data-message-id]")];
  view.rerender(<History ids={[...ids, "new-user"]} />);
  expect(view.container.querySelectorAll("[data-message-id]")).toHaveLength(49);
  for (const node of original) expect(node.isConnected).toBe(true);
});

test("an append during initial catch-up preserves its entire already-mounted tail", () => {
  const ids = Array.from({ length: 120 }, (_, n) => `catchup-${n}`);
  const view = render(<History ids={ids} />);
  const original = [...view.container.querySelectorAll("[data-message-id]")];
  expect(original.length).toBeLessThan(120);
  view.rerender(<History ids={[...ids, "new-user"]} />);
  for (const node of original) expect(node.isConnected).toBe(true);
  expect(
    view.container.querySelector('[data-message-id="new-user"]'),
  ).not.toBeNull();
});

test("a new channel still starts with its own bounded tail window", async () => {
  const ids = Array.from({ length: 90 }, (_, n) => `old-${n}`);
  const view = render(<History ids={ids} />);
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-message-id]").length).toBe(
      90,
    ),
  );
  const next = Array.from({ length: 120 }, (_, n) => `new-${n}`);
  view.rerender(<History ids={next} thread="new-thread" />);
  expect(
    view.container.querySelectorAll("[data-message-id]").length,
  ).toBeLessThan(120);
  expect(view.container.textContent).not.toContain("old-");
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-message-id]").length).toBe(
      120,
    ),
  );
});
