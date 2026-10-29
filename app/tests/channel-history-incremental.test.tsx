import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { applyChannelEvent } from "@/lib/channels/use-channel-events";
import { resetStoredSyncs } from "@/lib/copilot/thread-messages";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * 真实界面路径：ChannelChat 恢复 / 刷新历史都经 readThreadMessages 读对话存储（「Bot 在别处说了话」
 * 时按 0/750/1500ms 拉）。这里服务器按 since/cursor 协议回答（同 server/src/thread-messages-delta.ts），
 * 证明界面发出的请求带 since / cursor，没变时只拿到 unchanged、不 setMessages，只变尾部时只传尾部。
 */
type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "incremental-channel",
  name: "Incremental test",
  agentIds: ["incremental-bot"],
  threadId: "incremental-thread",
  active: true,
  lastMessageAt: "2026-09-09T00:00:00.000Z",
};
const initial = {
  id: "initial",
  role: "assistant",
  content: "Stored opening",
} satisfies Message;
const second = {
  id: "second",
  role: "assistant",
  content: "Second stored",
} satisfies Message;
const fresh = {
  id: "fresh",
  role: "assistant",
  content: "Fresh stored reply",
} satisfies Message;

let originalFetch: typeof fetch;
let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;
/** 服务器每个版本的整份；版本 k 的 version = v{k}、cursor = c{k}（指向倒数第二条之后）。 */
let revisions: Message[][] = [];
let reads: { since: string | null; cursor: string | null }[] = [];
let answers: Record<string, unknown>[] = [];

function CoreProbe() {
  core = useCopilotKit().copilotkit;
  return null;
}
function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function answer(url: URL): Record<string, unknown> {
  const rev = revisions.length;
  const rows = revisions[rev - 1] ?? [];
  const version = `v${rev}`;
  const cursor = `c${rev}`;
  if (url.searchParams.get("since") === version)
    return { unchanged: true, version, cursor };
  const known = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
  const base = known >= 1 && known <= rev ? revisions[known - 1] : undefined;
  const start = base ? base.length - 1 : 0;
  return { messages: rows.slice(start), version, cursor, start };
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
      if (url.pathname === "/api/plugins/for/incremental-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "incremental-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        // 顺序核对（不带 agentId）不是这里要看的路径。
        if (!url.searchParams.has("agentId"))
          return NativeResponse.json({ messages: [] });
        reads.push({
          since: url.searchParams.get("since"),
          cursor: url.searchParams.get("cursor"),
        });
        const body = answer(url);
        answers.push(body);
        return NativeResponse.json(body);
      }
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
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
  core = undefined;
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
    lastMessageAgentId: "incremental-bot",
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-09-09T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}
async function announce(second: number, text: string) {
  await act(async () => {
    queryClient.setQueryData<ChannelCache>(channelKeys.list(), (cache) => {
      if (!cache) throw new Error("No mounted channel cache");
      const patched = applyChannelEvent(cache, {
        channelId: channel.id,
        lastMessage: text,
        lastMessageAgentId: "incremental-bot",
        lastMessageAt: `2026-09-09T00:00:${String(second).padStart(2, "0")}.000Z`,
      });
      if (patched === "unknown") throw new Error("Channel missing from cache");
      return patched;
    });
  });
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("the mounted channel re-reads history with since/cursor; unchanged sets nothing, a tail only ships the tail", async () => {
  revisions = [[initial, second]];
  reads = [];
  answers = [];
  cacheChannel();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <CoreProbe />
        <ChannelChat channel={channel} runtimeAgentId="incremental-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  await view.findByText("Second stored");
  expect(reads[0]).toEqual({ since: "", cursor: null });

  const agent = core?.getAgent(`channel:${channel.id}`);
  if (!agent) throw new Error("Mounted channel agent is not registered");
  const setMessages = agent.setMessages.bind(agent);
  let sets = 0;
  agent.setMessages = ((messages: Parameters<typeof setMessages>[0]) => {
    sets += 1;
    return setMessages(messages);
  }) as typeof agent.setMessages;

  // Bot 在别处说了话，但存储没变：之后每一次读都带 since+cursor，只拿到 unchanged，不 setMessages。
  const quiet = reads.length;
  await announce(5, "Second stored");
  await waitFor(() => expect(reads.length).toBeGreaterThan(quiet));
  await act(async () => {
    await pause(2000);
  });
  for (const read of reads.slice(quiet))
    expect(read).toEqual({ since: "v1", cursor: "c1" });
  for (const body of answers.slice(quiet)) expect(body.unchanged).toBe(true);
  expect(sets).toBe(0);

  // 存储多了一条：带着同一个 since/cursor 去读，服务器只回尾部（从第 1 条起），界面补上新回复。
  revisions.push([initial, second, fresh]);
  const grown = reads.length;
  await announce(6, "Fresh stored reply");
  await view.findByText("Fresh stored reply");
  expect(reads[grown]).toEqual({ since: "v1", cursor: "c1" });
  expect(answers[grown]).toMatchObject({ start: 1, messages: [second, fresh] });
  expect(sets).toBeGreaterThan(0);
  expect(view.getAllByText("Second stored")).toHaveLength(1);
  expect(view.getAllByText("Stored opening")).toHaveLength(1);
}, 20_000);
