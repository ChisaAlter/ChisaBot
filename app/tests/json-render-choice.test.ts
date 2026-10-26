import { describe, expect, test } from "bun:test";
import { inspectRenderUiSpec } from "../../shared/json-render/catalog";
import { replyAfterToolCall } from "@/lib/copilot/conversation";
import { choiceOptionsOf, choiceState } from "@/lib/copilot/json-render/rich-context";

/**
 * 对话里的选项卡片：选完就定、不能重复点（CB-090，DESIGN.md §112）——纯函数部分。
 * 画出来点一点的用例在 json-render-rich.test.tsx（和其它富组件共用一次 happy-dom 注册：registry 模块
 * 第一次导入时绑定当时的窗口，分两个文件各自注册 / 注销会让后跑的那个拿到已经失效的窗口）。
 */

describe("replyAfterToolCall", () => {
  const messages = [
    { role: "user", content: "帮我写备忘录" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1" }] },
    { role: "tool", toolCallId: "call-1", content: "ok" },
    { role: "assistant", content: "选一个格式" },
    { role: "user", content: [{ type: "text", text: "  用 Word  " }] },
    { role: "assistant", content: "", toolCalls: [{ id: "call-2" }] },
  ];

  test("returns the first user message after the call, trimmed", () => {
    expect(replyAfterToolCall(messages, "call-1")).toBe("用 Word");
  });

  test("no answer yet, or an unknown call, is null", () => {
    expect(replyAfterToolCall(messages, "call-2")).toBeNull();
    expect(replyAfterToolCall(messages, "nope")).toBeNull();
    expect(replyAfterToolCall([], "call-1")).toBeNull();
  });
});

describe("choice helpers", () => {
  test("collects only Button elements with choice: true and an ask", () => {
    const options = choiceOptionsOf({
      a: { type: "Button", props: { label: "Word", ask: " 用 Word ", choice: true } },
      b: { type: "Button", props: { label: "页面", ask: "做成页面", choice: true } },
      c: { type: "Button", props: { label: "展开", ask: "展开讲讲" } },
      d: { type: "List", props: { choice: true, ask: "不算" } },
      e: { type: "Button", props: { label: "空", ask: "  ", choice: true } },
    });
    expect(options).toEqual(["用 Word", "做成页面"]);
  });

  test("state: nothing picked is open; once picked every option locks and only one is marked", () => {
    expect(choiceState(null, "用 Word")).toEqual({ picked: false, locked: false });
    expect(choiceState("用 Word", " 用 Word ")).toEqual({ picked: true, locked: true });
    expect(choiceState("用 Word", "做成页面")).toEqual({ picked: false, locked: true });
  });

  test("the catalog accepts choice on Button", () => {
    const verdict = inspectRenderUiSpec(
      JSON.stringify({
        root: "b",
        elements: { b: { type: "Button", props: { label: "Word", ask: "用 Word", choice: true }, children: [] } },
      }),
    );
    expect(verdict.ok).toBe(true);
  });
});
