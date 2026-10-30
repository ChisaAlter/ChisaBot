import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { reusableEmptyChannelFor } from "../src/lib/channels/latest";
import { botChatChannelId } from "../src/lib/channels/open-bot-chat";
import { type ChannelSummary, channelKeys } from "../src/lib/channels/queries";

/**
 * /channel/new 总是开新话题：只在这个机器人最近的对话还没有消息时复用它；「和它聊天」类入口自己先找最近的对话。
 */

function channel(
  id: string,
  over: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: ["bot-a"],
    summary: null,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...over,
  } as ChannelSummary;
}

const talked = (id: string, at: string) =>
  channel(id, {
    lastMessage: "hi",
    lastMessageAt: at,
    createdAt: "2026-09-01T00:00:00.000Z",
  });

describe("/channel/new 复用哪个会话", () => {
  test("最近的对话有消息：不复用（开新话题）", () => {
    expect(
      reusableEmptyChannelFor("bot-a", [
        talked("old", "2026-10-20T00:00:00.000Z"),
      ]),
    ).toBeUndefined();
  });

  test("最近的对话还没说过话：复用它，不在旁边再开一个空的", () => {
    const empty = channel("empty", { createdAt: "2026-10-25T00:00:00.000Z" });
    expect(
      reusableEmptyChannelFor("bot-a", [
        talked("old", "2026-10-20T00:00:00.000Z"),
        empty,
      ])?.id,
    ).toBe("empty");
  });

  test("空会话比有消息的旧：最近的是有消息的那个，不复用", () => {
    const empty = channel("empty", { createdAt: "2026-10-01T00:00:00.000Z" });
    expect(
      reusableEmptyChannelFor("bot-a", [
        empty,
        talked("new", "2026-10-20T00:00:00.000Z"),
      ]),
    ).toBeUndefined();
  });

  test("群聊和别的机器人的会话不算", () => {
    expect(
      reusableEmptyChannelFor("bot-a", [
        channel("group", {
          agentIds: ["bot-a", "bot-b"],
          createdAt: "2026-10-28T00:00:00.000Z",
        }),
        channel("other", {
          agentIds: ["bot-b"],
          createdAt: "2026-10-28T00:00:00.000Z",
        }),
      ]),
    ).toBeUndefined();
  });

  test("new.tsx 用的是「只复用空会话」，不再跳到最近的对话", () => {
    const src = readFileSync(
      join(import.meta.dir, "../src/routes/_authed/_app/channel/new.tsx"),
      "utf8",
    );
    expect(src).toContain("reusableEmptyChannelFor(agent, channels.data)");
    expect(src).not.toContain("latestChannelFor");
  });
});

describe("「和它聊天」入口先找最近的对话", () => {
  test("有对话：给出最近那个频道", async () => {
    const client = new QueryClient();
    client.setQueryData(channelKeys.list(), {
      pages: [
        {
          channels: [
            talked("old", "2026-10-01T00:00:00.000Z"),
            talked("new", "2026-10-20T00:00:00.000Z"),
          ],
        },
      ],
      pageParams: [""],
    });
    expect(await botChatChannelId(client, "bot-a")).toBe("new");
    client.clear();
  });

  test("会话列表拉不到：退回 /channel/new（不抛错）", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("down", { status: 500 })) as unknown as typeof fetch;
    try {
      expect(await botChatChannelId(client, "bot-a")).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      client.clear();
    }
  });

  test("接线：资料页 / 去聊天 / 和它聊天 / 旧 /bot 地址 / 删除后回主机器人 都走 useOpenBotChat", () => {
    const src = (p: string) =>
      readFileSync(join(import.meta.dir, "../src", p), "utf8");
    for (const file of [
      "components/bot-profile/profile.tsx",
      "components/agents/agent-profile.tsx",
      "components/agents/agent-dialog.tsx",
      "routes/_authed/_app/bot.tsx",
      "components/agents/delete-bot-dialog.tsx",
    ]) {
      expect(src(file)).toContain("useOpenBotChat()");
      expect(src(file)).not.toMatch(/to: "\/channel\/new"/);
    }
    expect(src("lib/channels/open-thread.ts")).toContain(
      "botChatChannelId(queryClient, agentId)",
    );
    expect(src("lib/copilot/handoff-tool.tsx")).toContain(
      "latestChannelFor(matchedBot.id",
    );
  });
});
