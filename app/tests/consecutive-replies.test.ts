import { describe, expect, test } from "bun:test";
import { compactTurns } from "../src/components/channels/chat-transcript";

/**
 * 机器人连发几条消息（中间没有调工具）：每一条都是回答，不是过程话，都要露着。
 * 以前 compactTurns 把「有结果」那一轮里除开场一句和最后一句以外的文字都当过程话收起，
 * 连发三条只剩第一条和最后一条；有干活卡的一轮里开场一句也收进卡片，于是只剩最后一条。
 */
type Item = Parameters<typeof compactTurns>[0][number];
const user = (id: string, text: string): Item =>
  ({ kind: "text", id, role: "user", text }) as Item;
const bot = (id: string, text: string): Item =>
  ({ kind: "text", id, role: "assistant", text }) as Item;
const call = (id: string, name: string, result = "ok"): Item =>
  ({
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: '{"command":"node -v"}' },
    },
    result,
  }) as Item;

describe("机器人连发多条消息", () => {
  test("没有工具的一轮：三条都露着，中间那条不当过程话", () => {
    const items = [
      user("u1", "在吗"),
      bot("a1", "在的。"),
      bot("a2", "刚看了你的日程。"),
      bot("a3", "下午三点有个会。"),
    ];
    const compact = compactTurns(items, false, new Set());
    for (const id of ["a1", "a2", "a3"])
      expect(compact.hidden.has(id)).toBe(false);
    expect(compact.tone.get("a2")).toBe("final");
    expect(compact.tone.get("a3")).toBe("final");
  });

  test("干活之后连发几条：最后一个工具之后的几条都露着（开场一句照旧进卡片，§93）", () => {
    const items = [
      user("u1", "装一下"),
      bot("a1", "我先检查。"),
      call("t1", "device_run_shell"),
      bot("a2", "装好了，版本 v22。"),
      bot("a3", "另外 npm 也升到了 10。"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.hidden.has("a1")).toBe(true);
    expect(compact.hidden.has("a2")).toBe(false);
    expect(compact.tone.get("a2")).toBe("final");
    expect(compact.hidden.has("a3")).toBe(false);
    expect(compact.tone.get("a3")).toBe("final");
    expect(compact.work.get("t1")?.notes.map((n) => n.text)).toEqual([
      "我先检查。",
    ]);
  });

  test("两步之间的话仍是过程话：后面又调了工具的照旧收起", () => {
    const items = [
      user("u1", "装一下"),
      bot("a1", "在的。"),
      bot("a2", "我先检查。"),
      call("t1", "device_run_shell"),
      bot("a3", "装好了。"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.hidden.has("a2")).toBe(true);
    expect(compact.tone.get("a3")).toBe("final");
  });

  test("还在跑：后面还没调工具的几条照旧露着", () => {
    const items = [
      user("u1", "在吗"),
      bot("a1", "在的。"),
      bot("a2", "我看看。"),
    ];
    const compact = compactTurns(items, true, new Set());
    expect(compact.hidden.has("a1")).toBe(false);
    expect(compact.hidden.has("a2")).toBe(false);
  });

  test("先干活、再连发两条（没有开场一句）：两条都露着，都不进卡片", () => {
    const items = [
      user("u1", "装一下"),
      call("t1", "device_run_shell"),
      bot("a2", "装好了，版本 v22。"),
      bot("a3", "另外 npm 也升到了 10。"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.hidden.has("a2")).toBe(false);
    expect(compact.tone.get("a2")).toBe("final");
    expect(compact.hidden.has("a3")).toBe(false);
    expect(compact.tone.get("a3")).toBe("final");
    expect(compact.work.get("t1")?.notes).toEqual([]);
  });

  test("回答中间记了一笔（memory_save）：记忆不算干活，前后两段都是回答", () => {
    const items = [
      user("u1", "装一下"),
      bot("a1", "我先检查。"),
      call("t1", "device_run_shell"),
      bot("a2", "装好了，版本 v22。"),
      call("m1", "memory_save"),
      bot("a3", "我记下了你用 Node 22。"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.hidden.has("a1")).toBe(true);
    expect(compact.hidden.has("a2")).toBe(false);
    expect(compact.tone.get("a2")).toBe("final");
    expect(compact.hidden.has("a3")).toBe(false);
    expect(compact.tone.get("a3")).toBe("final");
    expect(compact.work.get("t1")?.notes.map((n) => n.text)).toEqual([
      "我先检查。",
    ]);
  });

  test("回答之后才记一笔（memory_save 在最后）：回答照旧露着，是结果", () => {
    const items = [
      user("u1", "装一下"),
      call("t1", "device_run_shell"),
      bot("a2", "装好了。"),
      bot("a3", "版本 v22。"),
      call("m1", "memory_save"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.hidden.has("a2")).toBe(false);
    expect(compact.tone.get("a2")).toBe("final");
    expect(compact.hidden.has("a3")).toBe(false);
    expect(compact.tone.get("a3")).toBe("final");
  });
});
