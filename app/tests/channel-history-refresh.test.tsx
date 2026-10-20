import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { z } from "zod";
import { ChannelChat, HISTORY_UNAVAILABLE_NOTICE } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { applyChannelEvent } from "@/lib/channels/use-channel-events";
import { queryClient } from "@/query-client";

type ChannelCache = InfiniteData<ChannelPage>;
const ActivityRequestSchema = z.object({
  agentId: z.string().nullable(),
  at: z.string(),
  text: z.string(),
});
type ActivityRequest = z.infer<typeof ActivityRequestSchema>;
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "refresh-channel",
  name: "Refresh test",
  agentIds: ["refresh-bot"],
  threadId: "refresh-thread",
  active: true,
  lastMessageAt: "2026-09-09T00:00:00.000Z",
};
const initial = {
  id: "initial",
  role: "assistant",
  content: "Stored opening",
} satisfies Message;
const fresh = {
  id: "fresh",
  role: "assistant",
  content: "Fresh stored reply",
} satisfies Message;
const local: Message = {
  id: "local",
  role: "user",
  content: "Local message stays",
};
const broken = { id: "broken", role: "user", content: null };
// 这两句现在是产品里的中文常量（channel-chat.tsx）：从那里取，别再抄英文原文。
const unavailable = HISTORY_UNAVAILABLE_NOTICE;
const oneHole = "有一条较早的消息无法读取，未显示。会话其余部分完整。";

/*
 * 按 2026-10 的新行为调整（app/src/components/channels/channel-chat.tsx 的 channelHistoryNotice，
 * 以及 lib/copilot/thread-messages.ts 的 HISTORY_RETRY_DELAYS_MS）：
 *
 *   1. 「较早的消息暂时无法加载。」只在**什么都没恢复出来**时出现
 *      （availability unavailable && messageCount === 0 && (读失败 || 有过最后一句)）。
 *      会话里已经有消息（网关快照、刚发出的那句、后台重试补回来的部分）时不再说：再多一句
 *      「无法加载」只会让人以为丢了东西，而后台还在重试。刷新失败（Bot 在别处说了话，这次没拉下来）
 *      同样一句都不说——屏幕上的会话是完好的。
 *   2. 首次读取失败后后台会按 [1.5s, 4s, 10s] 再读；这段期间（retryingHistory）算「恢复中」，也不提示。
 *      所以「什么都没恢复出来」的那句提示要等 15.5s 的重试全部失败才出现，已经有消息的用例则永远不等它。
 *      纯函数层面的三条（有消息→null、重试中→null、空会话失败→提示）在 channel-history-notice.test.ts。
 *
 * 因此下面这些用例保住的是别的东西：消息不丢、顺序正确、不重复、后台重试后恢复、发送闸门释放；
 * notice 只按上面的语义断言（有东西看的时候不出现，什么都不剩时才出现）。
 */
let originalFetch: typeof fetch;
let history: (threadId: string) => Promise<Response>;
let historyReads: string[];
let gatewaySnapshot: readonly Message[] = [];
let runRequests: { path: string; input: RunAgentInput }[] = [];
let activityRequests: ActivityRequest[] = [];
let runEvents: (input: RunAgentInput) => unknown[];
let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function CoreProbe() {
  core = useCopilotKit().copilotkit;
  return null;
}
function stored(messages: unknown[]) {
  return NativeResponse.json({ messages });
}
function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
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
      if (url.pathname === "/api/plugins/for/refresh-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "refresh-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: gatewaySnapshot },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runRequests.push({ path: url.pathname, input: body });
        return sse(runEvents(body));
      }
      if (/\/api\/channels\/[^/]+\/activity$/.test(url.pathname)) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        activityRequests.push(
          ActivityRequestSchema.parse(await request.json()),
        );
        return new NativeResponse(null, { status: 204 });
      }
      if (/\/api\/channels\/[^/]+\/busy$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      const match = url.pathname.match(/\/threads\/([^/]+)\/messages$/);
      if (match) {
        const threadId = match[1];
        if (!threadId) throw new Error("Missing fixture thread id");
        /*
         * useConversationSync 在每一轮结束 800ms 后还会探一次「两边消息顺序一致吗」：同一个 URL，
         * 但不带 agentId（见 use-conversation-sync.ts 的 reconcile）。那不是恢复历史，所以既不算进
         * historyReads，也不吃掉用例按次数摆的 fixture——否则谁先落地就成了计时器彩票，条数与提示
         * 都会被它搅乱。空列表就是「没有要对的顺序」。
         */
        if (!url.searchParams.has("agentId")) return stored([]);
        historyReads.push(threadId);
        return history(threadId);
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
  core = undefined;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function tree(selected: AgentChannel) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider
        runtimeUrl="http://localhost/api/copilotkit"
      >
        <CoreProbe />
        <ChannelChat channel={selected} runtimeAgentId="refresh-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}
function cacheChannel(
  selected: AgentChannel,
  activity: ActivityFixture | null = null,
) {
  const summary: ChannelSummary = {
    ...selected,
    summary: null,
    lastMessage: activity?.text ?? null,
    lastMessageAgentId:
      activity === null
        ? "refresh-bot"
        : activity.agentId === undefined
          ? "refresh-bot"
          : activity.agentId,
    lastMessageAt: activity?.at ?? selected.lastMessageAt,
    createdAt: "2026-09-09T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}
function mounting(
  read: typeof history = async () => stored([initial]),
  snapshot: readonly Message[] = [],
  cachedActivity: ActivityFixture | null = null,
) {
  historyReads = [];
  gatewaySnapshot = snapshot;
  runRequests = [];
  activityRequests = [];
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];
  history = read;
  cacheChannel(channel, cachedActivity);
  return render(tree(channel));
}
async function mounted() {
  const view = mounting();
  await view.findByText("Stored opening");
  return view;
}

function currentAgent(selected = channel) {
  const agent = core?.getAgent(`channel:${selected.id}`);
  if (!agent) throw new Error("Mounted channel agent is not registered");
  return agent;
}
type ActivityFixture = { agentId?: string | null; text?: string; at?: string };

async function announce(
  at: number,
  selected = channel,
  activity: ActivityFixture = {},
) {
  await act(async () => {
    queryClient.setQueryData<ChannelCache>(channelKeys.list(), (cache) => {
      if (!cache) throw new Error("No mounted channel cache");
      const patched = applyChannelEvent(cache, {
        channelId: selected.id,
        lastMessage: activity.text ?? "Bot announced a turn",
        lastMessageAgentId:
          activity.agentId === undefined ? "refresh-bot" : activity.agentId,
        lastMessageAt:
          activity.at ?? `2026-09-09T00:00:${String(at).padStart(2, "0")}.000Z`,
      });
      if (patched === "unknown")
        throw new Error("Announced channel missing from cache");
      return patched;
    });
  });
}
function delayedResponse() {
  let resolve: (response: Response) => void = () => {
    throw new Error("Response not initialized");
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Real provider, ChannelChat, history reader, and query cache; only the HTTP boundary is synthetic.
/*
 * 按 2026-10 的新行为调整：notice 只在什么都没恢复出来时出现。这里两种读失败要分开看——
 * 网关快照里已经有消息时从头到尾不提示（消息还在、发送照常）；快照也是空的才轮到那句提示，
 * 而且要等后台重试 [1.5s, 4s, 10s] 全部失败之后。发出去一句之后，提示一样让位。
 */
test.each([
  { name: "partial gateway snapshot", snapshot: [initial] },
  { name: "empty gateway snapshot", snapshot: [] },
])(
  "a failed mount restore keeps $name and releases the send, warning only when nothing was recovered",
  async ({ snapshot }) => {
    const view = mounting(
      async () => new NativeResponse("failed", { status: 500 }),
      snapshot,
    );
    if (snapshot.length > 0) {
      // 有东西可看：一句都不说，快照里的消息原样在。
      await view.findByText(initial.content);
      expect(view.queryByText(unavailable)).toBeNull();
    } else {
      // 什么都没恢复出来：提示要等后台重试全部失败才出现，这期间不打扰（空会话显示骨架）。
      await view.findByText(unavailable, {}, { timeout: 20_000 });
    }
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(
      view.getByRole("textbox", { name: "消息" }),
      "Later local turn",
    );
    await user.click(view.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(runRequests).toHaveLength(1));
    expect(runRequests[0]?.path).toBe("/api/copilotkit/agent/refresh-bot/run");
    expect(runRequests[0]?.input.threadId).toBe(channel.threadId);
    expect(runRequests[0]?.input.messages.slice(0, snapshot.length)).toEqual([
      ...snapshot,
    ]);
    expect(runRequests[0]?.input.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Later local turn",
    });
    // 会话里已经有消息（快照或刚发出去的这句）：提示不再挂在那里。
    await waitFor(() => expect(view.queryByText(unavailable)).toBeNull());
    expect(view.queryByText(/different CopilotKit project/)).toBeNull();
  },
  // 空快照那一种要等真实的后台重试表（1.5s + 4s + 10s）走完，默认 5s 不够。
  30_000,
);

test("a finished run without new assistant text does not report a prior assistant as new activity", async () => {
  const priorReply = {
    id: "prior-run-reply",
    role: "assistant",
    content: "Earlier answer",
  } satisfies Message;
  const view = mounting(async () => stored([initial]), [initial]);
  await view.findByText(initial.content);
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    {
      type: "TEXT_MESSAGE_START",
      messageId: priorReply.id,
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: priorReply.id,
      delta: priorReply.content,
    },
    { type: "TEXT_MESSAGE_END", messageId: priorReply.id },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Ask for the first answer",
  );
  await user.click(view.getByRole("button", { name: "发送消息" }));
  await view.findByText(priorReply.content);
  await waitFor(() =>
    expect(
      activityRequests.filter(
        (activity) =>
          activity.agentId === "refresh-bot" &&
          activity.text === priorReply.content,
      ),
    ).toHaveLength(1),
  );

  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Ask for a no-text follow-up",
  );
  await user.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(runRequests).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 1000));

  expect(
    activityRequests.filter(
      (activity) =>
        activity.agentId === "refresh-bot" &&
        activity.text === priorReply.content,
    ),
  ).toHaveLength(1);
});

test("a finished run with new assistant text still reports that assistant text as activity", async () => {
  const reply = {
    id: "current-run-reply",
    role: "assistant",
    content: "Current run answer",
  } satisfies Message;
  const view = mounting(async () => stored([initial]), [initial]);
  await view.findByText(initial.content);
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "TEXT_MESSAGE_START", messageId: reply.id, role: "assistant" },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: reply.id,
      delta: reply.content,
    },
    { type: "TEXT_MESSAGE_END", messageId: reply.id },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Ask for current answer",
  );
  await user.click(view.getByRole("button", { name: "发送消息" }));
  await view.findByText(reply.content);
  await waitFor(() =>
    expect(
      activityRequests.some(
        (activity) =>
          activity.agentId === "refresh-bot" && activity.text === reply.content,
      ),
    ).toBe(true),
  );
});

test("a same-tab activity echo does not append a lagging durable partial beside the completed local reply", async () => {
  const fullReply = {
    id: "streamed-full-reply",
    role: "assistant",
    content: "I can answer this fully from the live run.",
  } satisfies Message;
  const partialEcho = {
    id: "durable-lagging-partial",
    role: "assistant",
    content: "I can answer this fully",
  } satisfies Message;
  const view = mounting(async () => stored([initial]), [initial]);
  await view.findByText(initial.content);
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    {
      type: "TEXT_MESSAGE_START",
      messageId: fullReply.id,
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: fullReply.id,
      delta: fullReply.content,
    },
    { type: "TEXT_MESSAGE_END", messageId: fullReply.id },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Ask for live answer",
  );
  await user.click(view.getByRole("button", { name: "发送消息" }));
  await view.findByText(fullReply.content);
  await waitFor(() =>
    expect(
      activityRequests.some(
        (activity) =>
          activity.agentId === "refresh-bot" &&
          activity.text === fullReply.content,
      ),
    ).toBe(true),
  );
  const selfActivity = activityRequests.find(
    (activity) =>
      activity.agentId === "refresh-bot" && activity.text === fullReply.content,
  );
  if (!selfActivity) throw new Error("Missing self-reported Bot activity");
  history = async () => stored([initial, partialEcho]);
  await announce(1, channel, selfActivity);
  expect(historyReads).toHaveLength(1);

  expect(view.getByText(fullReply.content)).toBeTruthy();
  expect(view.queryByText(partialEcho.content)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).toContain(
    fullReply.id,
  );
  expect(currentAgent().messages.map((message) => message.id)).not.toContain(
    partialEcho.id,
  );
});

test("a same-timestamp different activity after a self echo still refreshes durable history", async () => {
  const fullReply = {
    id: "local-live-reply",
    role: "assistant",
    content: "Local reply already rendered",
  } satisfies Message;
  const relayed = {
    id: "same-time-relayed-reply",
    role: "assistant",
    content: "Same timestamp relayed reply",
  } satisfies Message;
  const view = mounting(async () => stored([initial]), [initial]);
  await view.findByText(initial.content);
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    {
      type: "TEXT_MESSAGE_START",
      messageId: fullReply.id,
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: fullReply.id,
      delta: fullReply.content,
    },
    { type: "TEXT_MESSAGE_END", messageId: fullReply.id },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Ask before same-time relay",
  );
  await user.click(view.getByRole("button", { name: "发送消息" }));
  await view.findByText(fullReply.content);
  await waitFor(() =>
    expect(
      activityRequests.some(
        (activity) =>
          activity.agentId === "refresh-bot" &&
          activity.text === fullReply.content,
      ),
    ).toBe(true),
  );
  const selfActivity = activityRequests.find(
    (activity) =>
      activity.agentId === "refresh-bot" && activity.text === fullReply.content,
  );
  if (!selfActivity) throw new Error("Missing self-reported Bot activity");

  await announce(1, channel, selfActivity);
  expect(historyReads).toHaveLength(1);
  history = async () => stored([initial, relayed]);
  await announce(1, channel, {
    ...selfActivity,
    agentId: "relay-bot",
    text: "Different same-time relay",
  });

  await view.findByText(relayed.content);
  expect(historyReads).toHaveLength(2);
  expect(currentAgent().messages.map((message) => message.id)).toContain(
    relayed.id,
  );
});

test.each([
  { name: "different timestamp", override: { at: "2026-09-09T00:00:10.000Z" } },
  {
    name: "different text",
    override: { text: "A different Bot-authored update" },
  },
  { name: "different agent", override: { agentId: "relay-bot" } },
])(
  "a $name activity after a self report still refreshes durable history",
  async ({ override }) => {
    const fullReply = {
      id: "local-live-reply",
      role: "assistant",
      content: "Local reply already rendered",
    } satisfies Message;
    const relayed = {
      id: "relayed-durable-reply",
      role: "assistant",
      content: "Relayed durable reply",
    } satisfies Message;
    const view = mounting(async () => stored([initial]), [initial]);
    await view.findByText(initial.content);
    runEvents = (input) => [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      {
        type: "TEXT_MESSAGE_START",
        messageId: fullReply.id,
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: fullReply.id,
        delta: fullReply.content,
      },
      { type: "TEXT_MESSAGE_END", messageId: fullReply.id },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ];

    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(
      view.getByRole("textbox", { name: "消息" }),
      "Ask before relay",
    );
    await user.click(view.getByRole("button", { name: "发送消息" }));
    await view.findByText(fullReply.content);
    await waitFor(() =>
      expect(
        activityRequests.some(
          (activity) =>
            activity.agentId === "refresh-bot" &&
            activity.text === fullReply.content,
        ),
      ).toBe(true),
    );
    const selfActivity = activityRequests.find(
      (activity) =>
        activity.agentId === "refresh-bot" &&
        activity.text === fullReply.content,
    );
    if (!selfActivity) throw new Error("Missing self-reported Bot activity");

    history = async () => stored([initial, relayed]);
    await announce(1, channel, { ...selfActivity, ...override });
    await view.findByText(relayed.content);
    expect(historyReads).toHaveLength(2);
    expect(currentAgent().messages.map((message) => message.id)).toContain(
      relayed.id,
    );
  },
);

test("a ready durable mount adds the newer turn beyond the gateway snapshot", async () => {
  const view = mounting(async () => stored([initial, fresh]), [initial]);
  await view.findByText(fresh.content);
  expect(view.getByText(initial.content)).toBeTruthy();
  expect(view.queryByText(unavailable)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    "fresh",
  ]);
});

test.each([false, true])(
  "mount keeps a readable gateway tool result while restoring newer durable replies (longer store: %s)",
  async (longerStore) => {
    const toolCall = {
      id: "tool-call",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        },
      ],
    } satisfies Message;
    const toolResult = {
      id: "tool-result",
      role: "tool",
      toolCallId: "call",
      content: "Readable gateway tool output",
    } satisfies Message;
    const latest = {
      id: "latest",
      role: "assistant",
      content: "Latest durable reply",
    } satisfies Message;
    const later = longerStore ? [fresh, latest] : [fresh];
    const snapshot = [initial, toolCall, toolResult];
    const view = mounting(
      async () =>
        stored([
          initial,
          toolCall,
          { ...toolResult, content: { unsupported: "stored result shape" } },
          ...later,
        ]),
      snapshot,
    );
    await view.findByText(fresh.content);
    if (longerStore) expect(view.getByText(latest.content)).toBeTruthy();
    expect(view.getByText(oneHole)).toBeTruthy();
    expect(currentAgent().messages).toEqual([...snapshot, ...later]);
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(
      view.getByRole("textbox", { name: "消息" }),
      "Continue restored conversation",
    );
    await user.click(view.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(runRequests).toHaveLength(1));
    expect(runRequests[0]?.input.threadId).toBe(channel.threadId);
    expect(runRequests[0]?.input.messages.slice(0, -1)).toEqual([
      ...snapshot,
      ...later,
    ]);
  },
);

/*
 * 按 2026-10 的新行为调整：notice 只在什么都没恢复出来时出现。这里的网关快照里有一条 initial，
 * 后台重试又在跑，所以从头到尾不提示。这条保住的是两件别的事：卡住的读取 4 秒截止后照样放行
 * 第一条消息（闸门松开，不是把消息扣下），以及被放弃的那次读取迟到的答案不再追加。
 */
test("a stalled mount history read releases the send gate without appending its late answer", async () => {
  const pending = delayedResponse();
  const view = mounting((_threadId) => pending.promise, [initial]);
  await waitFor(() => expect(historyReads).toHaveLength(1));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Send while history stalls",
  );
  await user.click(view.getByRole("button", { name: "发送消息" }));

  // 读存储 4 秒截止（THREAD_MESSAGES_DEADLINE_MS）后放行：消息带着网关快照发出去。
  await waitFor(() => expect(runRequests).toHaveLength(1), { timeout: 4000 });
  expect(runRequests[0]?.path).toBe("/api/copilotkit/agent/refresh-bot/run");
  expect(runRequests[0]?.input.threadId).toBe(channel.threadId);
  expect(runRequests[0]?.input.messages.slice(0, -1)).toEqual([initial]);
  expect(runRequests[0]?.input.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Send while history stalls",
  });
  // 手里有网关快照：不挂「较早的消息暂时无法加载」。
  expect(view.queryByText(unavailable)).toBeNull();

  // 之后的后台重试也读不到（500）。这条只问一件事：被放弃的那次读取迟到的答案不能追加进来。
  history = async () => new NativeResponse("failed", { status: 500 });
  await act(async () => pending.resolve(stored([initial, fresh])));
  await waitFor(() => expect(historyReads.length).toBeGreaterThan(1), {
    timeout: 4000,
  });
  expect(view.queryByText(fresh.content)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).not.toContain(
    fresh.id,
  );
  // 4s 截止 + 1.5s 后的第一次后台重试，默认 5s 不够。
}, 12_000);

test("a UI send waits for mount history before adding its message", async () => {
  const pending = delayedResponse();
  const view = mounting(() => pending.promise, [initial]);
  await waitFor(() => expect(historyReads).toHaveLength(1));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Send after restore",
  );
  await user.click(view.getByRole("button", { name: "发送消息" }));
  expect(runRequests).toHaveLength(0);
  expect(currentAgent().messages).toEqual([initial]);
  await act(async () => pending.resolve(stored([initial, fresh])));
  await waitFor(() => expect(runRequests).toHaveLength(1));
  expect(runRequests[0]?.input.messages.slice(0, -1)).toEqual([initial, fresh]);
  expect(runRequests[0]?.input.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Send after restore",
  });
});

test("an unmounted history read cannot append messages to its former agent", async () => {
  const pending = delayedResponse();
  const view = mounting(() => pending.promise, [initial]);
  await waitFor(() => expect(historyReads).toHaveLength(1));
  const formerAgent = currentAgent();
  view.unmount();
  await act(async () => pending.resolve(stored([initial, fresh])));
  expect(formerAgent.messages).toEqual([initial]);
});

test("explicit valid-empty durable history finishes without a failure notice", async () => {
  const view = mounting(async () => stored([]));
  await waitFor(() => expect(historyReads).toHaveLength(1));
  await waitFor(() =>
    expect(
      view
        .getByRole("textbox", { name: "消息" })
        .getAttribute("contenteditable"),
    ).toBe("true"),
  );
  expect(view.queryByText(unavailable)).toBeNull();
  expect(currentAgent().messages).toEqual([]);
});

test("headless unreadable-only history updates the notice while preserving local messages", async () => {
  const view = await mounted();
  await act(async () => currentAgent().addMessage(local));
  history = async () => stored([broken]);
  await announce(1);
  await view.findByText(oneHole);
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    "local",
  ]);
});

/*
 * 按 2026-10 的新行为调整：刷新失败不再挂「较早的消息暂时无法加载」（这条刷新还成功读到过一次，
 * 而且会话里本来就有消息），所以后面两次 500 不能让屏幕上任何东西变样——上一次成功读到的
 * 「有一条较早的消息无法读取」还得挂着，消息也不能被重试洗掉。
 */
test("a successful same-message refresh is not overwritten by later unavailable retries", async () => {
  const view = await mounted();
  await act(async () => currentAgent().addMessage(local));
  const beforeRefresh = historyReads.length;
  let refreshReads = 0;
  history = async () => {
    refreshReads += 1;
    return refreshReads === 1
      ? stored([initial, broken])
      : new NativeResponse("failed", { status: 500 });
  };

  await announce(1);
  await view.findByText(oneHole);
  // 刷新那条的节奏是 0 / 750 / 1500ms：睡够三遍。
  await new Promise((resolve) => setTimeout(resolve, 2600));

  expect(historyReads.length - beforeRefresh).toBe(3);
  expect(view.getByText(oneHole)).toBeTruthy();
  expect(view.queryByText(unavailable)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    "local",
  ]);
}, 5000);

test("a cached Bot activity before mount retries stale durable history and restores the later message", async () => {
  const later = {
    id: "cached-activity-reply",
    role: "assistant",
    content: "Cached activity durable reply",
  } satisfies Message;
  let reads = 0;
  const view = mounting(
    async () => {
      reads += 1;
      return stored(reads < 3 ? [initial] : [initial, later]);
    },
    [initial],
    {
      agentId: "refresh-bot",
      at: "2026-09-10T12:00:00.000Z",
      text: "Cached Bot activity",
    },
  );

  await view.findByText(later.content, {}, { timeout: 3000 });

  expect(reads).toBe(3);
  expect(historyReads).toEqual([
    channel.threadId,
    channel.threadId,
    channel.threadId,
  ]);
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    later.id,
  ]);
  expect(view.queryByText(unavailable)).toBeNull();
});

/*
 * 按 2026-10 的新行为调整：这条刷新第一次读到的是旧的一份（和屏幕一致，不算失败），750ms 后
 * 第二次读到新的一条才并进来；两次都成功，所以那条「较早的消息暂时无法加载」从头到尾都不该出现。
 */
test("a first ready stale refresh still retries and renders a later stored message", async () => {
  const view = await mounted();
  const beforeRefresh = historyReads.length;
  let refreshReads = 0;
  history = async () => {
    refreshReads += 1;
    return stored(refreshReads === 1 ? [initial] : [initial, fresh]);
  };

  await announce(1);
  await view.findByText(fresh.content);

  expect(historyReads.length - beforeRefresh).toBe(2);
  expect(view.queryByText(unavailable)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    "fresh",
  ]);
}, 3000);

/*
 * 按 2026-10 的新行为调整：刷新失败不再挂「较早的消息暂时无法加载」——那只是「别处新到的一条
 * 回复」没拉下来，屏幕上的会话完好，下一次活动还会再拉。所以失败之后一个字都不多，上一次读到
 * 的东西（fresh 和那条「有一条较早的消息无法读取」）原样留着；重试读到了，洞自然补上。
 * 这条保住的是：三次重试都打过、没有重复消息、恢复后回到干净状态。
 */
test("mixed history, exhausted failure, and recovery update the notice without duplicating messages", async () => {
  const view = await mounted();
  await act(async () => currentAgent().addMessage(local));
  history = async () => stored([initial, fresh, broken]);
  await announce(1);
  await view.findByText("Fresh stored reply");
  await view.findByText(oneHole);
  const beforeFailure = historyReads.length;
  history = async () => new NativeResponse("failed", { status: 500 });
  await announce(2);
  // 刷新那条拉三遍（0 / 750 / 1500ms）都失败，然后什么都不改。
  await waitFor(() => expect(historyReads.length - beforeFailure).toBe(3), {
    timeout: 4000,
  });
  expect(view.queryByText(unavailable)).toBeNull();
  // 上一次成功读到的那句「有一条…无法读取」还挂着：只有读到的人才配改它。
  expect(view.getByText(oneHole)).toBeTruthy();
  history = async () => stored([initial, fresh]);
  await announce(3);
  // 读到完整的一份：洞的数字回到 0，提示消失。
  await waitFor(() => expect(view.queryByText(oneHole)).toBeNull());
  expect(view.queryByText(unavailable)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    "local",
    "fresh",
  ]);
}, 10000);

test("a slower refresh cannot replace a newer notice or append obsolete history", async () => {
  const view = await mounted();
  const old = delayedResponse();
  history = () => old.promise;
  await announce(1);
  await waitFor(() => expect(historyReads).toHaveLength(2));
  history = async () => stored([initial, fresh, broken]);
  await announce(2);
  await view.findByText("Fresh stored reply");
  await act(async () =>
    old.resolve(
      stored([
        { id: "obsolete", role: "assistant", content: "Obsolete history" },
      ]),
    ),
  );
  expect(view.getByText(oneHole)).toBeTruthy();
  expect(view.queryByText("Obsolete history")).toBeNull();
});

test("a cancelled channel refresh cannot replace the next channel's notice or messages", async () => {
  const view = await mounted();
  const old = delayedResponse();
  history = () => old.promise;
  await announce(1);
  await waitFor(() => expect(historyReads).toHaveLength(2));
  const next = { ...channel, id: "next-channel", threadId: "next-thread" };
  history = async () => stored([initial, broken]);
  cacheChannel(next);
  view.rerender(tree(next));
  await view.findByText(oneHole);
  await act(async () =>
    old.resolve(
      stored([
        { id: "obsolete", role: "assistant", content: "Wrong channel history" },
      ]),
    ),
  );
  expect(view.getByText(oneHole)).toBeTruthy();
  expect(currentAgent(next).messages.map((message) => message.id)).toEqual([
    "initial",
  ]);
  expect(view.queryByText("Wrong channel history")).toBeNull();
});

test.each(["unavailable", "unreadable", "readable"])(
  "a delayed %s mount read cannot overwrite the notice from a newer Bot refresh",
  async (outcome) => {
    const old = delayedResponse();
    const view = mounting(() => old.promise);
    await waitFor(() => expect(historyReads).toHaveLength(1));
    history = async () => stored([fresh, broken]);
    await announce(1);
    await waitFor(() =>
      expect(currentAgent().messages.map((message) => message.id)).toEqual([
        "fresh",
      ]),
    );
    await act(async () =>
      old.resolve(
        outcome === "unavailable"
          ? new NativeResponse("failed", { status: 500 })
          : outcome === "unreadable"
            ? stored([broken, { ...broken, id: "old-hole" }])
            : stored([
                fresh,
                { id: "obsolete", role: "assistant", content: "Old reply" },
              ]),
      ),
    );
    await view.findByText(oneHole);
    expect(currentAgent().messages.map((message) => message.id)).toEqual([
      "fresh",
    ]);
  },
);

/*
 * 按 2026-10 的新行为调整：读取失败时那句「较早的消息暂时无法加载」要等后台重试全部失败
 * （1.5s + 4s + 10s）才出现，所以读失败的这一支不再等它——这条要保的是失败之后顺序能不能恢复。
 * 读成功就有已知前缀；读失败就直接发，闸门照常放行，随后的一次刷新把 durable 的历史补回原位。
 */
test.each([false, true])(
  "recovery restores durable order after a UI send (known prefix: %s)",
  async (prefixPresent) => {
    const view = mounting(async () =>
      prefixPresent
        ? stored([initial])
        : new NativeResponse("failed", { status: 500 }),
    );
    if (prefixPresent) await view.findByText(initial.content);
    else await waitFor(() => expect(historyReads).toHaveLength(1));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const editor = view.getByRole("textbox", { name: "消息" });
    await user.type(editor, "Local turn after mount completed");
    await user.click(view.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(runRequests).toHaveLength(1), { timeout: 4000 });
    const sent = runRequests[0]?.input.messages.at(-1);
    if (sent?.role !== "user") throw new Error("Missing UI user message");
    history = async () => stored([initial, sent, fresh]);
    await announce(1);
    await view.findByText(fresh.content);
    // 读到东西了（哪怕前缀是这次补回来的）：不提示无法加载。
    expect(view.queryByText(unavailable)).toBeNull();
    const transcript = view.container.textContent ?? "";
    expect(transcript.indexOf(initial.content)).toBeLessThan(
      transcript.indexOf("Local turn after mount completed"),
    );
    expect(transcript.indexOf("Local turn after mount completed")).toBeLessThan(
      transcript.indexOf(fresh.content),
    );
    await user.type(editor, "Capture restored ordering");
    await user.click(view.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(runRequests).toHaveLength(2));
    expect(runRequests[1]?.input.threadId).toBe(channel.threadId);
    expect(runRequests[1]?.input.messages.slice(0, 3)).toEqual([
      initial,
      sent,
      fresh,
    ]);
    expect(currentAgent().messages.map((message) => message.id)).toEqual(
      runRequests[1]?.input.messages.map((message) => message.id),
    );
  },
);

test.each(["mount", "refresh"])(
  "%s restores a shorter durable snapshot around local messages without replacing their content",
  async (phase) => {
    const toolCall = {
      id: "tool-call",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        },
      ],
    } satisfies Message;
    const toolResult = {
      id: "tool-result",
      role: "tool",
      toolCallId: "call",
      content: "Local tool output",
    } satisfies Message;
    const streaming = {
      id: "streaming",
      role: "assistant",
      content: "Current streamed text",
    } satisfies Message;
    const secondAnchor = {
      id: "second-anchor",
      role: "user",
      content: "Current anchor content",
    } satisfies Message;
    const prefix = {
      id: "prefix",
      role: "assistant",
      content: "Missing durable prefix",
    } satisfies Message;
    const interior = {
      id: "interior",
      role: "assistant",
      content: "Missing durable interior",
    } satisfies Message;
    const snapshot = [
      local,
      initial,
      toolCall,
      toolResult,
      secondAnchor,
      streaming,
    ];
    const durable = [
      prefix,
      { ...initial, content: "Stale opening content" },
      interior,
      { ...secondAnchor, content: "Stale anchor content" },
      fresh,
    ];
    const view = mounting(
      async () => stored(phase === "mount" ? durable : []),
      snapshot,
    );
    if (phase === "refresh") {
      await view.findByText(streaming.content);
      history = async () => stored(durable);
      await announce(1);
    }
    await view.findByText(interior.content);
    expect(currentAgent().messages).toEqual([
      local,
      prefix,
      initial,
      toolCall,
      toolResult,
      interior,
      secondAnchor,
      streaming,
      fresh,
    ]);
    history = async () =>
      stored([prefix, initial, interior, secondAnchor, interior]);
    await announce(2);
    await waitFor(() => expect(historyReads.length).toBeGreaterThanOrEqual(3));
    expect(currentAgent().messages).toEqual([
      local,
      prefix,
      initial,
      toolCall,
      toolResult,
      interior,
      secondAnchor,
      streaming,
      fresh,
    ]);
  },
);

test.each(["mount", "refresh"])(
  "%s without shared IDs keeps local order and appends unique durable messages",
  async (phase) => {
    const view = mounting(
      async () => stored(phase === "mount" ? [fresh, fresh] : []),
      [initial, local],
    );
    if (phase === "refresh") {
      await view.findByText(initial.content);
      history = async () => stored([fresh, fresh]);
      await announce(1);
    }
    await view.findByText(fresh.content);
    expect(currentAgent().messages).toEqual([initial, local, fresh]);
  },
);
