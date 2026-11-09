import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { z } from "zod";
import { ToolRendererProvider, useRenderToolCall } from "@/lib/chat/renderers";
import { useComputerToolRenderer } from "@/lib/conversations/approval-tools";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const NativeResponse = globalThis.Response;
function Tool() {
  useComputerToolRenderer({
    name: "computer_click",
    parameters: z.object({ ref: z.string() }),
    render: () => <span>点击结果</span>,
  });
  return null;
}
function Call() {
  const draw = useRenderToolCall();
  return draw({
    toolCall: {
      id: "call",
      type: "function",
      function: { name: "computer_click", arguments: '{"ref":"e7"}' },
    },
  });
}
test("a replayed call only displays its approval; an explicit click sends the decision once", async () => {
  const original = globalThis.fetch;
  const posted: { url: string; body: unknown }[] = [];
  let decided = false;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === "POST") {
        posted.push({
          url: String(url),
          body: JSON.parse(String(options.body)),
        });
        decided = true;
        return NativeResponse.json({ accepted: true });
      }
      return NativeResponse.json({
        requests: decided
          ? []
          : [
              {
                id: "approval-1",
                status: "pending",
                action: {
                  toolCallId: "call",
                  toolRef: "computer_click",
                  scope: "Submit form",
                  policy: { behaviour: "ask", reason: "请确认" },
                },
              },
            ],
        questions: [],
      });
    },
    { preconnect: original.preconnect },
  );
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    const view = render(
      <QueryClientProvider client={queries}>
        <ToolRendererProvider>
          <Tool />
          <Call />
        </ToolRendererProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.getByTestId("upstream-approval-card")).toBeTruthy(),
    );
    expect(posted).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: /^确认$/ }));
    await waitFor(() =>
      expect(posted).toEqual([
        {
          url: "/api/approvals/approval-1/decision",
          body: { decision: "allow_once" },
        },
      ]),
    );
    await waitFor(() =>
      expect(view.queryByTestId("upstream-approval-card")).toBeNull(),
    );
  } finally {
    cleanup();
    queries.clear();
    globalThis.fetch = original;
  }
});
