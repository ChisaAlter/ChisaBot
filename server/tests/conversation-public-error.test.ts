import { expect, test } from "bun:test";
import { publicConversationError } from "../src/conversations/routes";

test("query failures never reach the browser with their statement or bound values", () => {
  const failure = Object.assign(
    new Error(
      "Failed query: select * from secrets where id = $1\nparams: sk-live-123",
    ),
    {
      query: "select * from secrets where id = $1",
      params: ["sk-live-123"],
      cause: new Error("connection reset"),
    },
  );
  const text = publicConversationError(failure);
  expect(text).toBe("connection reset");
  expect(text).not.toContain("select");
  expect(text).not.toContain("sk-live-123");
});

test("URL credentials and secret-shaped text are masked, length is capped, non-errors are generic", () => {
  const text = publicConversationError(
    new Error(
      `upstream https://user:hunter2@api.example.com/v1?key=abc failed Authorization: Bearer abcdefghijklmnop ${"x".repeat(1000)}`,
    ),
  );
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("abcdefghijklmnop");
  expect(text.length).toBeLessThanOrEqual(301);
  expect(publicConversationError("raw string")).toBe("会话执行失败。");
  expect(publicConversationError(new Error("这段对话已被编辑。"))).toBe(
    "这段对话已被编辑。",
  );
});
