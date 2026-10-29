import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * 干活之后连发的几条回答（不只最后一条）要像结果一样画：带链接卡、带复制按钮。
 * 以前补出来的回答段是开场一句的样子（lead），链接卡和复制按钮都不画。
 */
const realFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // 链接预览一律 422：照样出兜底卡，不连真服务器。
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "x" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

test("[工具][带链接的 a2][a3]：a2 的链接卡和复制按钮都在", async () => {
  const messages = [
    { id: "u1", role: "user", content: "发一下下载地址" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "t1",
          type: "function",
          function: { name: "device_run_shell", arguments: "{}" },
        },
      ],
    },
    { id: "r1", role: "tool", toolCallId: "t1", content: "ok" },
    {
      id: "a2",
      role: "assistant",
      content: "下载地址：\nhttps://example.com/download/v1",
    },
    { id: "a3", role: "assistant", content: "装好后重启一下。" },
  ] as Message[];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ChatTranscript
        messages={messages}
        busy={false}
        scrollKey="replies-render"
      />
    </QueryClientProvider>,
  );
  const row = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  await waitFor(() => expect(row("a2")).not.toBeNull());
  await waitFor(() =>
    expect(
      row("a2")?.querySelector('[data-testid="link-card"]'),
    ).not.toBeNull(),
  );
  expect(row("a2")?.querySelector('[aria-label="复制回答"]')).not.toBeNull();
  expect(row("a3")?.querySelector('[aria-label="复制回答"]')).not.toBeNull();
});
