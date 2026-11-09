import assert from "node:assert/strict";
import { test } from "node:test";
import { actionPromise } from "../src/action-promise.mjs";

test("future-tense promises to act count", () => {
  for (const text of [
    "我先查一下最新的价格。",
    "好的，我这就去搜索。",
    "让我确认一下。",
    "I'll check the latest docs now.",
    "Let me look into that.",
  ])
    assert.equal(actionPromise(text), true, text);
});

test("reports, questions, refusals and plain answers do not", () => {
  for (const text of [
    "我已经查好了，价格是 42 元。",
    "我找到了答案。",
    "要我先查一下最新的价格吗？",
    "我不会去查这个。",
    "我没法打开这个链接。",
    "Should I look into it?",
    "I can't search that.",
    "I've checked it already.",
    "好的。",
    "",
    undefined,
  ])
    assert.equal(actionPromise(text), false, String(text));
});
