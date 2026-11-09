import { describe, expect, test } from "bun:test";
import { createChannelUploadMirror } from "../src/chat-files/channel-mirror";

/** CB-046（DESIGN.md §68）：频道聊天的上传也要进机器人工作区 uploads/，和旧 /bot 一样。 */
describe("channel upload mirror", () => {
  const file = {
    actorId: "u1",
    channelId: "c1",
    name: "a.png",
    mimeType: "image/png",
    bytes: Buffer.from([1, 2, 3]),
  };

  test("a channel with exactly one bot stores the upload for that bot", async () => {
    const calls: unknown[] = [];
    const mirror = createChannelUploadMirror({
      botsInChannel: async () => ["bot-1"],
      upload: async (owner, agentId, f) =>
        void calls.push([owner, agentId, f.name, [...f.bytes]]),
    });
    await mirror(file);
    expect(calls).toEqual([["u1", "bot-1", "a.png", [1, 2, 3]]]);
  });

  test("no bot or several bots: nothing is stored", async () => {
    let called = 0;
    for (const bots of [[], ["a", "b"]]) {
      const mirror = createChannelUploadMirror({
        botsInChannel: async () => bots,
        upload: async () => void called++,
      });
      await mirror(file);
    }
    expect(called).toBe(0);
  });
});
