import { describe, expect, test } from "bun:test";
import { knownForMerge } from "../src/lib/copilot/use-conversation-sync";
import { withStoredTail } from "../src/lib/copilot/thread-activity";

describe("频道聊天接着看正在写的回答（§63）", () => {
  const msgs = [
    { id: "u1", role: "user", content: "你好" },
    { id: "a1", role: "assistant", content: "你好！", toolCalls: [{ id: "t1" }] },
    { id: "u2", role: "user", content: "写故事" },
    { id: "r2", role: "reasoning", content: "想一想" },
    { id: "a2", role: "assistant", content: "从前", toolCalls: [{ id: "t2" }] },
  ];
  test("平时：全部算已有", () => {
    const known = knownForMerge(msgs);
    expect([...known.messages]).toEqual(["u1", "a1", "u2", "r2", "a2"]);
    expect([...known.toolCalls]).toEqual(["t1", "t2"]);
  });
  test("服务器正在回答：最后一条用户消息之后的半截不算已有（回放重建再接着写）", () => {
    const known = knownForMerge(msgs, true);
    expect([...known.messages]).toEqual(["u1", "a1", "u2"]);
    expect([...known.toolCalls]).toEqual(["t1"]);
  });
  test("回答写完后重读：截断的半截换成完整正文，别的不动", () => {
    const stored = [
      { id: "u1", role: "user", content: "你好" },
      { id: "a1", role: "assistant", content: "你好！（服务器版本）" },
      { id: "u2", role: "user", content: "写故事" },
      { id: "a2", role: "assistant", content: "从前有座山，山里有座庙。" },
    ];
    const out = withStoredTail(msgs, stored);
    expect(out[1]).toBe(msgs[1]);
    expect(out[4]!.content).toBe("从前有座山，山里有座庙。");
    expect((out[4] as { toolCalls?: unknown }).toolCalls).toEqual([{ id: "t2" }]);
  });
  test("没有变化返回原数组（不触发重渲染）", () => {
    expect(withStoredTail(msgs, msgs)).toBe(msgs);
  });
});

describe("回答写完后重读：补上断线时没收到的工具调用", () => {
  const local = [
    { id: "u1", role: "user", content: "总结这个网页" },
    { id: "a1", role: "assistant", content: "我去读一下这个页面。" },
  ];
  const stored = [
    { id: "u1", role: "user", content: "总结这个网页" },
    { id: "a1", role: "assistant", content: "我去读一下这个页面。", toolCalls: [{ id: "t1" }] },
  ];
  test("这台的那条没有工具调用、服务器的有：换成服务器的", () => {
    const out = withStoredTail(local, stored);
    expect(out).not.toBe(local);
    expect((out[1] as { toolCalls?: unknown }).toolCalls).toEqual([{ id: "t1" }]);
    expect(out[1]!.content).toBe("我去读一下这个页面。");
  });
  test("这台已有、服务器没有的调用不丢（不是子集就不换）", () => {
    const mine = [local[0]!, { ...local[1]!, toolCalls: [{ id: "t9" }] }];
    expect(withStoredTail(mine, stored)).toBe(mine);
  });
  test("最后一条用户消息之前的不动", () => {
    const before = [local[1]!, { id: "u2", role: "user", content: "下一句" }];
    expect(withStoredTail(before, [stored[1]!, before[1]!])).toBe(before);
  });
});
