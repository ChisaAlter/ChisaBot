import { describe, expect, test } from "bun:test";
import { searchChannelMessages } from "../src/channels/search";

// CB-106：命中带上机器人 id 和会话更新时间（给侧栏结果显示「机器人 · 时间」）。
function fakeDatabase(rows: unknown[]) {
  const calls: string[] = [];
  const database = {
    $client: {
      unsafe: async (sql: string) => {
        calls.push(sql);
        return rows;
      },
    },
  } as unknown as Parameters<typeof searchChannelMessages>[0];
  return { database, calls };
}

const actor = { id: "user-1" } as Parameters<typeof searchChannelMessages>[1];

describe("searchChannelMessages hit meta (CB-106)", () => {
  test("returns agentId and ISO updatedAt from the thread row", async () => {
    const { database, calls } = fakeDatabase([
      {
        channel_id: "c1",
        name: "番茄",
        summary: null,
        thread_id: "t1",
        agent_id: "agent_a",
        updated_at: new Date("2026-10-27T02:00:00Z"),
        messages: [{ id: "m1", role: "user", content: "番茄工作法" }],
      },
      {
        channel_id: "c2",
        name: "x",
        summary: null,
        thread_id: "t2",
        agent_id: null,
        updated_at: null,
        messages: JSON.stringify([
          { id: "m2", role: "assistant", content: "番茄" },
        ]),
      },
    ]);
    const hits = await searchChannelMessages(database, actor, "番茄");
    expect(calls[0]).toContain("t.agent_id");
    expect(calls[0]).toContain("t.updated_at");
    expect(
      hits.map((h) => [h.channelId, h.messageId, h.agentId, h.updatedAt]),
    ).toEqual([
      ["c1", "m1", "agent_a", "2026-10-27T02:00:00.000Z"],
      ["c2", "m2", null, null],
    ]);
  });
});
