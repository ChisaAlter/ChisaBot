import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";

/** 对话里在想那一行（DESIGN.md §81）：形象头像的机器人画它自己，其他照旧三个点。 */
let mod: typeof import("@/components/agents/bot-work-mark");
let rq: typeof import("@tanstack/react-query");
let avatars: typeof import("@/lib/agents/avatars");

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  mod = await import("@/components/agents/bot-work-mark");
  rq = await import("@tanstack/react-query");
  avatars = await import("@/lib/agents/avatars");
});
afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

function withClient(node: React.ReactNode) {
  const client = new rq.QueryClient({
    defaultOptions: {
      queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  client.setQueryData(avatars.botAvatarsQueryOptions().queryKey, {
    s: { kind: "shape", shape: "round", color: "blue" },
    e: { kind: "emoji", emoji: "🐱", color: "sky" },
  } as never);
  return (
    <rq.QueryClientProvider client={client}>{node}</rq.QueryClientProvider>
  );
}

describe("BotWorkMark", () => {
  test("no agent: three dots, no query client needed", () => {
    const view = render(<mod.BotWorkMark />);
    expect(view.container.querySelector(".chat-thinking-dots")).not.toBeNull();
    view.unmount();
  });
  test("a shape-avatar bot: its own 18px avatar, hidden from screen readers", () => {
    const view = render(withClient(<mod.BotWorkMark agentId="s" />));
    const mark = view.getByTestId("chat-thinking-avatar");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelector("svg")?.getAttribute("width")).toBe("18");
    expect(view.container.querySelector(".chat-thinking-dots")).toBeNull();
    view.unmount();
  });
  test("other avatar kinds keep the dots", () => {
    for (const id of ["e", "unknown"]) {
      const view = render(withClient(<mod.BotWorkMark agentId={id} />));
      expect(
        view.container.querySelector(".chat-thinking-dots"),
      ).not.toBeNull();
      expect(view.queryByTestId("chat-thinking-avatar")).toBeNull();
      view.unmount();
    }
  });
});
