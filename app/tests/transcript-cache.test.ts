import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { QueryClient } from "@tanstack/react-query";
import { channelFromRoster, channelKeys } from "@/lib/channels/queries";
import {
  cachedTranscript,
  clearTranscriptCache,
  prefetchTranscript,
  rememberTranscript,
} from "@/lib/conversations/transcript-cache";

/**
 * 打开对话 / 切机器人「秒开」（DESIGN.md §83）：切回刚看过的机器人时，第一帧画的是这里记下的那一份，
 * 不重新等接入和整段历史；空闲 / 悬停时预取的也放这里。锁住：只记拷贝、空的不记、最多 12 段、
 * 同一段对话预取只发一次请求、预取不覆盖离开时记下的更新的那份。
 */
const msg = (id: string, role: "user" | "assistant" = "user"): Message =>
  ({ id, role, content: id }) as Message;

const realFetch = globalThis.fetch;
let calls = 0;
beforeEach(() => {
  clearTranscriptCache();
  calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(
      JSON.stringify({ messages: [msg("s1"), msg("s2", "assistant")] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("transcript cache", () => {
  test("记下的是拷贝：agent 之后原地改数组不影响缓存", () => {
    const live = [msg("a"), msg("b", "assistant")];
    rememberTranscript("t1", live);
    live.push(msg("c"));
    expect(cachedTranscript("t1")?.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("空对话不记（空白不比骨架好）", () => {
    rememberTranscript("t1", []);
    expect(cachedTranscript("t1")).toBeNull();
  });

  test("最多记 12 段，最久没用的先丢", () => {
    for (let i = 0; i < 13; i += 1) rememberTranscript(`t${i}`, [msg(`m${i}`)]);
    expect(cachedTranscript("t0")).toBeNull();
    expect(cachedTranscript("t12")).not.toBeNull();
    // 用过一次的排到最后，不会被下一次挤掉。
    cachedTranscript("t1");
    rememberTranscript("t13", [msg("m13")]);
    expect(cachedTranscript("t1")).not.toBeNull();
    expect(cachedTranscript("t2")).toBeNull();
  });

  test("同一段对话同时预取只发一次请求，30 秒内不再发", async () => {
    await Promise.all([
      prefetchTranscript("t1", "bot"),
      prefetchTranscript("t1", "bot"),
    ]);
    expect(calls).toBe(1);
    expect(cachedTranscript("t1")?.map((m) => m.id)).toEqual(["s1", "s2"]);
    await prefetchTranscript("t1", "bot");
    expect(calls).toBe(1);
  });

  test("预取读不到不报错、不记", async () => {
    globalThis.fetch = mock(
      async () => new Response("no", { status: 500 }),
    ) as unknown as typeof fetch;
    await prefetchTranscript("t9", "bot");
    expect(cachedTranscript("t9")).toBeNull();
  });

  test("预取回来时，离开对话时记下的更新的那份不被覆盖", async () => {
    const pending = prefetchTranscript("t1", "bot");
    await new Promise((resolve) => setTimeout(resolve, 1));
    rememberTranscript("t1", [msg("local-newer")]);
    await pending;
    expect(cachedTranscript("t1")?.map((m) => m.id)).toEqual(["local-newer"]);
  });
});

describe("channelFromRoster", () => {
  test("左栏列表里有这一行就先用它当对话详情", () => {
    const client = new QueryClient();
    client.setQueryData(channelKeys.list(), {
      pages: [
        {
          channels: [
            {
              id: "channel_1",
              name: "n",
              agentIds: ["bot"],
              threadId: "thread_1",
              active: true,
              lastMessageAt: "2026-10-16T00:00:00.000Z",
              summary: null,
              lastMessage: "hi",
              lastMessageAgentId: "bot",
              createdAt: "2026-10-15T00:00:00.000Z",
              pinned: false,
              lastReadAt: null,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [""],
    });
    expect(channelFromRoster(client, "channel_1")).toEqual({
      id: "channel_1",
      name: "n",
      agentIds: ["bot"],
      threadId: "thread_1",
      active: true,
      lastMessageAt: "2026-10-16T00:00:00.000Z",
    });
    expect(channelFromRoster(client, "channel_2")).toBeUndefined();
  });
});
