import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import * as DictationModule from "@/components/channels/composer/use-dictation";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import {
  type AgentChannel,
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import * as TailFirstModule from "@/lib/chat/use-tail-first-mount";
import { useMainBot, useUserPreferences } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 从设置回到聊天约 100ms 后，preferences / channels / agents 会在后台重读（staleTime 过了、观察者重新挂上）。
 * 数据没变时，聊天列表（ChatTranscript）和输入框（Composer）一次都不该重渲染（审查 #415）。
 *
 * 真实渲染：真的 ChannelChat（里面是真的 ChatTranscript / Composer），外面套一个和 ChatStage 一样用到
 * 偏好（useMainBot → useUserPreferences）、机器人列表、会话列表的外壳。服务器每次回同样的数据。
 * 渲染次数用模块命名空间上的 spyOn 数（调用原实现，不改行为）：ChatTranscript 每画一次调一次
 * useTailFirstMount，Composer 每画一次调一次 useDictation。
 */

const NativeResponse = globalThis.Response;
const AGENT = "refetch-bot";
const channel: AgentChannel = {
  id: "refetch-channel",
  name: "Refetch test",
  agentIds: [AGENT],
  threadId: "refetch-thread",
  active: true,
  lastMessageAt: "2026-10-29T00:00:00.000Z",
};
const summary: ChannelSummary = {
  ...channel,
  summary: null,
  lastMessage: "hi",
  lastMessageAgentId: AGENT,
  createdAt: "2026-10-29T00:00:00.000Z",
  pinned: false,
  lastReadAt: null,
};
const user = { id: "user-1", email: "u@example.com", name: "U" };
const agents = [{ id: AGENT, name: "千纱", hidden: false }];
const preferences = { messageListEmphasis: "thread", mainBotId: AGENT, selfHostBannerDismissed: true };
const requests: string[] = [];
let originalFetch: typeof fetch;

function sse(events: unknown[]) {
  return new NativeResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://localhost",
      );
      const path = url.pathname;
      requests.push(path);
      // 每次都是新的 JSON 对象、内容一样：和真服务器一样，靠 structuralSharing 认出「没变」。
      if (path === "/api/agents") return NativeResponse.json({ agents });
      if (path === "/api/settings/preferences") return NativeResponse.json({ preferences });
      if (path === "/api/channels") return NativeResponse.json({ channels: [summary], nextCursor: null });
      if (path.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [AGENT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (path.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (/\/threads\/[^/]+\/messages$/.test(path))
        return NativeResponse.json({
          messages: [{ id: "m1", role: "assistant", content: "已有的一条回复" }],
          version: "v1",
          cursor: "c1",
          start: 0,
        });
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(path)) return new NativeResponse(null, { status: 204 });
      // 其余接口（权限、模型、插件……）和这里无关，一律 404，前后两次回答一样。
      return NativeResponse.json({}, { status: 404 });
    },
    { preconnect() {} },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const stageSeen: unknown[] = [];
/** 和 ChatStage 一样：读偏好（主机器人）、机器人列表、会话列表，下面是聊天。 */
function Stage() {
  // 和真实组件一样只读 data（什么都不读的 useQuery 会在每次状态变化时都通知，见 TanStack Query 的 trackedProps）。
  const mainBot = useMainBot();
  const { data: prefs } = useUserPreferences();
  const { data: bots } = useQuery(agentListQueryOptions());
  const { data: list } = useInfiniteQuery(channelListQueryOptions());
  stageSeen.push([mainBot, prefs, bots, list]);
  return <ChannelChat channel={channel} runtimeAgentId={AGENT} />;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a background refetch of preferences / agents / channels with unchanged data re-renders neither the chat list nor the composer", async () => {
  queryClient.setQueryData(authKeys.currentUser(), user);
  const counts = { transcript: 0, composer: 0 };
  const realTail = TailFirstModule.useTailFirstMount;
  const tailSpy = spyOn(TailFirstModule, "useTailFirstMount").mockImplementation(((...args: Parameters<typeof realTail>) => {
    counts.transcript++;
    return realTail(...args);
  }) as typeof realTail);
  const realDictation = DictationModule.useDictation;
  const dictationSpy = spyOn(DictationModule, "useDictation").mockImplementation(((...args: Parameters<typeof realDictation>) => {
    counts.composer++;
    return realDictation(...args);
  }) as typeof realDictation);
  try {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
          <Stage />
        </CopilotKitProvider>
      </QueryClientProvider>,
    );
    await view.findByPlaceholderText?.("输入消息…").catch(() => null);
    // 等首屏的请求都落地、渲染停下来。
    await act(async () => {
      await pause(300);
    });
    expect(counts.transcript).toBeGreaterThan(0);
    expect(counts.composer).toBeGreaterThan(0);
    const before = { ...counts };
    const fetchedBefore = requests.length;

    // 一个一个重读，再一起重读：每一步聊天列表、输入框、外壳都不重渲染。
    const keys = [["settings"], agentListQueryOptions().queryKey, channelListQueryOptions().queryKey] as const;
    for (const key of keys) {
      const stageBefore = stageSeen.length;
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: key as readonly unknown[] });
        await pause(100);
      });
      expect({ key, ...counts, stage: stageSeen.length }).toEqual({ key, ...before, stage: stageBefore });
    }
    await act(async () => {
      await Promise.all(keys.map((key) => queryClient.refetchQueries({ queryKey: key as readonly unknown[] })));
      await pause(100);
    });

    const refetched = requests.slice(fetchedBefore);
    expect(refetched).toContain("/api/settings/preferences");
    expect(refetched).toContain("/api/agents");
    expect(refetched).toContain("/api/channels");
    expect(counts).toEqual(before);
  } finally {
    tailSpy.mockRestore();
    dictationSpy.mockRestore();
  }
});