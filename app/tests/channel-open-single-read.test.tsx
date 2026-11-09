import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import {
  ConversationSessionProvider,
  conversationClient,
} from "@/lib/chat/session-client";
import { resetStoredSyncs } from "@/lib/conversations/thread-messages";
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
/** 接入时服务器回放的事件；null = 回放存下的对话、没有在跑的一轮。 */
let joinEvents: unknown[] | null = null;
let joinDelay: Promise<void> | undefined;
let submitted: RunAgentInput[] = [];
const modelFailure = "隔离验证：模型输出失败。";

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
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
      if (url.pathname.endsWith("/commands")) {
        const body = JSON.parse(String(init?.body)) as { input: RunAgentInput };
        submitted.push(body.input);
        return NativeResponse.json(
          {
            accepted: true,
            commandId: body.input.messages.at(-1)?.id,
            runId: body.input.runId,
          },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/events")) {
        const input = submitted.at(-1)!;
        return sse([
          {
            type: "RUN_STARTED",
            threadId: channel.threadId,
            runId: input.runId,
          },
          {
            type: "RUN_ERROR",
            code: "DSH_RUNTIME_ERROR",
            message: modelFailure,
          },
        ]);
      }
      if (url.pathname.endsWith("/connect")) {
        await joinDelay;
        return sse(
          joinEvents ?? [
            { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
            { type: "MESSAGES_SNAPSHOT", messages: stored },
            { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
          ],
        );
      }
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
  joinEvents = null;
  joinDelay = undefined;
  submitted = [];
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function cacheChannel(lastMessage: string | null = null) {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage,
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
      <ConversationSessionProvider>
        <ChannelChat channel={channel} runtimeAgentId="open-once-bot" />
      </ConversationSessionProvider>
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

test("a run that finishes exactly while the chat is opening still shows its answer", async () => {
  historyReads = [];
  // 打开时读到的存储还没有这一轮（读在前）；接入回放的是还在跑的那一轮，回放途中它正好跑完。
  joinEvents = [
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "live" },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        ...stored,
        { id: "u2", role: "user", content: "Second question" },
      ],
    },
    { type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "a2",
      delta: "Answer finished ",
    },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "while opening" },
    { type: "TEXT_MESSAGE_END", messageId: "a2" },
    { type: "RUN_FINISHED", threadId: channel.threadId, runId: "live" },
  ];
  cacheChannel();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConversationSessionProvider>
        <ChannelChat channel={channel} runtimeAgentId="open-once-bot" />
      </ConversationSessionProvider>
    </QueryClientProvider>,
  );
  await view.findByText("Answer finished while opening");
  await act(async () => {
    await pause(2000);
  });
  // 跑完的那一轮在接入时已经整段回放到了：不靠接入后的再读一遍，也不丢、不重复。
  expect(view.getAllByText("Answer finished while opening")).toHaveLength(1);
  expect(view.getAllByText("Second question")).toHaveLength(1);
  expect(view.getAllByText("Stored reply")).toHaveLength(1);
  expect(historyReads).toHaveLength(1);
}, 20_000);

/*
 * 0.1.110 线上冷打开仍是两次整份读（since 都为空 = 两次同时发出）：左栏列表（channelKeys.list）在聊天挂上
 * 之后才到，订阅里把「列表第一次出现」当成别处新说了一句，马上 pull()，和打开时那次 earlyRead 并发。
 * 下面两种都只许读一次：列表已在缓存（带真实的 lastMessage），和列表在挂上之后才到。
 */
function renderChat() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ConversationSessionProvider>
        <ChannelChat channel={channel} runtimeAgentId="open-once-bot" />
      </ConversationSessionProvider>
    </QueryClientProvider>,
  );
}

test("reopening a failed turn retains the server's actual terminal reason", async () => {
  joinEvents = [
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "failed" },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        ...stored,
        { id: "failed-user", role: "user", content: "Please answer" },
      ],
    },
    { type: "RUN_ERROR", code: "DSH_RUNTIME_ERROR", message: modelFailure },
  ];
  cacheChannel();
  const view = renderChat();
  await view.findByText(modelFailure);
  expect(view.queryByText("这一轮没有收到回答")).toBeNull();
  expect(
    conversationClient
      .getAgent("channel:open-once-channel")
      ?.isCommandAccepted("failed-user"),
  ).toBe(true);
});

test("reopening an uncertain operation shows the interruption without a retry action", async () => {
  joinEvents = [
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "unknown" },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        ...stored,
        { id: "unknown-user", role: "user", content: "Send once" },
      ],
    },
    {
      type: "RUN_FINISHED",
      threadId: channel.threadId,
      runId: "unknown",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "operation-1",
            reason: "human_input",
            message: "这一步可能已经执行，但结果尚待核对。",
            metadata: { chisabotWaiting: { kind: "operation_unknown" } },
          },
        ],
      },
    },
  ];
  cacheChannel();
  const view = renderChat();
  await view.findByText("这一步操作未能确认结果");
  expect(view.queryByRole("button", { name: "重试" })).toBeNull();
  expect(view.queryByText("这一轮没有收到回答")).toBeNull();
});

test("a message typed during the opening join waits, then an admitted failure does not restore its draft", async () => {
  let releaseJoin!: () => void;
  joinDelay = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  cacheChannel();
  const view = renderChat();
  const editor = view.getByRole("textbox", { name: "消息" });
  fireEvent.input(editor, { target: { textContent: "Send while joining" } });
  fireEvent.submit(editor.closest("form")!);
  expect(submitted).toHaveLength(0);
  await act(async () => {
    releaseJoin();
  });
  await view.findByText(modelFailure);
  await waitFor(() => expect(editor.textContent).toBe(""));
  expect(submitted).toHaveLength(1);
  expect(view.getAllByText("Send while joining")).toHaveLength(1);
  expect(view.queryByText("没发出去")).toBeNull();
  expect(view.getByRole("button", { name: "重试" })).toBeDefined();
});

test("cold open with the roster already cached (real last line) reads history once", async () => {
  historyReads = [];
  cacheChannel("Stored reply");
  const view = renderChat();
  await view.findByText("Stored reply");
  await act(async () => {
    await pause(2500);
  });
  expect(historyReads).toHaveLength(1);
  expect(view.getAllByText("Stored reply")).toHaveLength(1);
}, 20_000);

test("cold open where the roster arrives after the chat mounted reads history once", async () => {
  historyReads = [];
  const view = renderChat();
  // 列表比对话详情晚到：聊天已经挂上、打开时那次读还没回来。
  cacheChannel("Stored reply");
  await view.findByText("Stored reply");
  await act(async () => {
    await pause(2500);
  });
  expect(historyReads).toHaveLength(1);
  expect(view.getAllByText("Stored reply")).toHaveLength(1);
}, 20_000);

test("cold open where the roster arrives after the join settled reads history once", async () => {
  historyReads = [];
  const view = renderChat();
  await view.findByText("Stored reply");
  await act(async () => {
    await pause(300);
  });
  cacheChannel("Stored reply");
  await act(async () => {
    await pause(2500);
  });
  expect(historyReads).toHaveLength(1);
}, 20_000);

test("a new bot line in the roster after open still pulls history", async () => {
  historyReads = [];
  cacheChannel("Stored reply");
  const view = renderChat();
  await view.findByText("Stored reply");
  await act(async () => {
    await pause(300);
  });
  const reads = historyReads.length;
  const cache = queryClient.getQueryData<ChannelCache>(channelKeys.list());
  const row = cache!.pages[0]!.channels[0]!;
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    ...cache!,
    pages: [
      {
        ...cache!.pages[0]!,
        channels: [
          {
            ...row,
            lastMessage: "Relayed answer",
            lastMessageAt: "2026-10-29T00:05:00.000Z",
          },
        ],
      },
    ],
  });
  await act(async () => {
    await pause(500);
  });
  expect(historyReads.length).toBeGreaterThan(reads);
}, 20_000);
