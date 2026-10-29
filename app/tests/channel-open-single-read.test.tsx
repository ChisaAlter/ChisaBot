import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { resetStoredSyncs } from "@/lib/copilot/thread-messages";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * 打开一段对话只读一次历史：打开时 ChannelChat 已经和接入同时读了一份存下的对话（earlyRead），
 * 接入（connect）结束后 useConversationSync 的 onRunFinalized 不应再当作「本机一轮结束」去核对顺序、
 * 把整份历史再拉一遍（首次打开时 since 为空，等于整份传两次）。
 */
type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "open-once-channel",
  name: "Open once",
  agentIds: ["open-once-bot"],
  threadId: "open-once-thread",
  active: true,
  lastMessageAt: "2026-10-29T00:00:00.000Z",
};
const stored: Message[] = [
  { id: "u1", role: "user", content: "Hello there" },
  { id: "a1", role: "assistant", content: "Stored reply" },
];

let originalFetch: typeof fetch;
let historyReads: string[] = [];

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/open-once-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "open-once-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: stored },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        historyReads.push(url.search);
        return NativeResponse.json({
          messages: stored,
          version: "v1",
          cursor: "c1",
          start: 0,
        });
      }
      // 收件箱 / 确认卡 / 上下文等旁路请求与这里无关。
      return NativeResponse.json({}, { status: 404 });
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  resetStoredSyncs();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function cacheChannel() {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: "open-once-bot",
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-10-29T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("opening a chat reads the stored history once", async () => {
  historyReads = [];
  cacheChannel();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChannelChat channel={channel} runtimeAgentId="open-once-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  await view.findByText("Stored reply");
  // 接入结束后的顺序核对等 800ms 才读；多等一会儿，确认它没有再读一次。
  await act(async () => {
    await pause(2000);
  });
  expect(historyReads).toHaveLength(1);
  expect(view.getAllByText("Stored reply")).toHaveLength(1);
}, 20_000);
