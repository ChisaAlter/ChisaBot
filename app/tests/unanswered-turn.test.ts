import { describe, expect, test } from "bun:test";
import { unansweredTurn } from "../src/components/channels/chat-transcript";
import { UNANSWERED_TURN_REASON, friendlyError } from "../src/lib/chat/friendly-error";

/**
 * P1（2026-10-20）：刷新以后，失败那一轮的错误卡和「重试」不该消失。
 * 从历史里认：最后一轮是人发的消息，后面什么都没有。
 */
type Item = Parameters<typeof unansweredTurn>[0][number];
const user = (id: string, text = "你好"): Item => ({ kind: "text", id, role: "user", text }) as Item;
const bot = (id: string, text = "在的"): Item => ({ kind: "text", id, role: "assistant", text }) as Item;

describe("刷新后认得出「发出去但没人回答」", () => {
  test("最后一条是人发的消息 → 就是它", () => {
    const tail = unansweredTurn([user("u1"), bot("a1"), user("u2")], false, undefined, 0);
    expect(tail?.id).toBe("u2");
  });

  test("最后一条有回答 → 不算", () => {
    expect(unansweredTurn([user("u1"), bot("a1")], false, undefined, 0)).toBeNull();
  });

  test("还在跑 / 有排队消息 → 不算", () => {
    expect(unansweredTurn([user("u1")], true, undefined, 0)).toBeNull();
    expect(unansweredTurn([user("u1")], false, undefined, 1)).toBeNull();
  });

  test("用户自己按了停止 → 不算（那一轮是「已停止」，不是失败）", () => {
    expect(unansweredTurn([user("u1")], false, new Set(["u1"]), 0)).toBeNull();
  });

  test("服务器放的那种 user 行（定时任务 / 任务结果）→ 不算", () => {
    const marker = {
      kind: "text",
      id: "s1",
      role: "user",
      text: "⟦chisabot:schedule:abc⟧ 定时任务「早报」到点了",
    } as Item;
    expect(unansweredTurn([marker], false, undefined, 0)).toBeNull();
  });

  test("空列表 → 不算", () => {
    expect(unansweredTurn([], false, undefined, 0)).toBeNull();
  });
});

describe("这张卡说什么", () => {
  test("标记翻成中文：说明 + 下一步 + 可重试，且不把标记当详情漏出去", () => {
    const f = friendlyError(UNANSWERED_TURN_REASON);
    expect(f.title).toBe("这一轮没有收到回答");
    expect(f.hint).toContain("重试");
    expect(f.hint).toContain("换一个模型");
    expect(f.detail).toBe("");
    expect(f.retryable).toBe(true);
  });
});
