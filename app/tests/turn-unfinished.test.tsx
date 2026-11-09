import { describe, expect, test } from "bun:test";
import { neverThrow } from "@/lib/conversations/approval-tools";
import {
  isAbortFailure,
  unfinishedTurnReason,
} from "@/lib/conversations/stopped-turn";

// Execution errors are covered at the server gateway; these assertions retain the visible failure contract.
describe("neverThrow", () => {
  test("turns any exception into { ok:false }", async () => {
    expect(
      await neverThrow(undefined, async () => {
        throw new Error("x");
      }),
    ).toEqual({ ok: false, reason: "这一步没有成功：x" });
    expect(await neverThrow(undefined, async () => 3)).toBe(3);
  });
  test("a stop still stops", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      neverThrow(controller.signal, async () => {
        throw new Error("aborted");
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("a turn that ended without finishing", () => {
  const before = new Set(["u0", "a0"]);
  const call = (id: string, name: string) => ({
    id,
    type: "function",
    function: { name, arguments: "{}" },
  });

  test("the production case: the last thing is a tool error, nothing after it", () => {
    const reason = unfinishedTurnReason(
      [
        { id: "u1", role: "user", content: "选啊" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [call("k2", "computer_key")],
        },
        {
          id: "t1",
          role: "tool",
          toolCallId: "k2",
          content:
            "Error: Element f4e36 is not on the page any more. Take a fresh snapshot and use the refs from it.",
        },
      ],
      before,
    );
    expect(reason).toBe(
      "机器人在「按键」这一步出错，这一轮没有做完：页面已经变了，它要找的元素不在了。点「重试」再来一次。",
    );
  });

  test("a tool result with no follow-up (e.g. the follow-up limit) is still reported", () => {
    const reason = unfinishedTurnReason(
      [
        { id: "u1", role: "user", content: "hi" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [call("c1", "computer_click")],
        },
        { id: "t1", role: "tool", toolCallId: "c1", content: '{"ok":true}' },
      ],
      before,
    );
    expect(reason).toBe(
      "机器人做完「点击」之后没有接着做，这一轮没有做完。点「重试」再来一次。",
    );
  });

  test("an empty reply is reported", () => {
    expect(
      unfinishedTurnReason(
        [
          { id: "u1", role: "user", content: "hi" },
          { id: "a1", role: "assistant", content: "" },
        ],
        before,
      ),
    ).toContain("没有给出任何回复");
  });

  test("a normal answer, an approval wait and old messages are not", () => {
    expect(
      unfinishedTurnReason(
        [
          { id: "u1", role: "user", content: "hi" },
          { id: "a1", role: "assistant", content: "好了" },
        ],
        before,
      ),
    ).toBeNull();
    // 等审批卡：工具调用没有结果，或结果是 { waiting: true }。
    expect(
      unfinishedTurnReason(
        [
          { id: "u1", role: "user", content: "hi" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [call("c1", "computer_click")],
          },
        ],
        before,
      ),
    ).toBeNull();
    expect(
      unfinishedTurnReason(
        [
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [call("c1", "computer_click")],
          },
          {
            id: "t1",
            role: "tool",
            toolCallId: "c1",
            content: '{"waiting":true}',
          },
        ],
        before,
      ),
    ).toBeNull();
    // 这一轮什么都没加（最后一条是发送前就有的）。
    expect(
      unfinishedTurnReason(
        [{ id: "a0", role: "assistant", content: "" }],
        before,
      ),
    ).toBeNull();
  });

  test("aborts are told apart from failures", () => {
    expect(isAbortFailure(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortFailure(new Error("The operation was aborted"))).toBe(true);
    expect(isAbortFailure(new Error("500 Internal"))).toBe(false);
  });
});

describe("how the unfinished-turn notice reads", () => {
  test("the reason is shown as the hint under a plain headline, not mistaken for a model timeout", async () => {
    const { friendlyError } = await import("@/lib/chat/friendly-error");
    const reason =
      "机器人在「按键」这一步出错，这一轮没有做完：Timeout 10000ms exceeded. 点「重试」再来一次。";
    expect(friendlyError(reason)).toEqual({
      title: "这一轮没有做完",
      hint: reason,
      detail: "",
      retryable: true,
    });
  });
});
