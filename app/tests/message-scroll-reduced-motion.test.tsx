import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

// Run independently: Motion caches its browser media preference at the first import.
let ChatTranscript: typeof import("@/components/channels/chat-transcript").ChatTranscript;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  ({ ChatTranscript } = await import("@/components/channels/chat-transcript"));
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("reduced motion sends at the real bottom without a new-turn anchor or smooth scroll", () => {
  const messages: Message[] = [
    { id: "reduced-user", role: "user", content: "Earlier question" },
    { id: "reduced-answer", role: "assistant", content: "Earlier answer" },
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (next: Message[], busy: boolean) => (
    <QueryClientProvider client={client}>
      <ChatTranscript
        messages={next}
        busy={busy}
        scrollKey="reduced-motion-thread"
      />
    </QueryClientProvider>
  );
  const view = render(tree(messages, false));
  const original = view.container.querySelector(
    '[data-message-id="reduced-user"]',
  );
  view.rerender(
    tree(
      [
        ...messages,
        {
          id: "reduced-new-user",
          role: "user",
          content: "A new turn after a long gap",
        },
      ],
      true,
    ),
  );
  expect(
    view.container
      .querySelector('[data-message-id="reduced-new-user"]')
      ?.getAttribute("data-scroll-anchor"),
  ).toBe("false");
  expect(
    view.container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    )?.style.scrollBehavior,
  ).not.toBe("smooth");
  expect(view.container.querySelector('[data-message-id="reduced-user"]')).toBe(
    original,
  );
  client.clear();
});
