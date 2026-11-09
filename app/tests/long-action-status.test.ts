import { describe, expect, test } from "bun:test";
import { effectiveStatus } from "../src/lib/conversations/approval-tools";

// §102：长动作的结果流式写出时，原来的状态码在正文的 `status` 里。
describe("effectiveStatus", () => {
  test("ordinary responses keep their HTTP status", () => {
    expect(effectiveStatus(200, { result: { ok: true } })).toBe(200);
    expect(effectiveStatus(202, { waiting: true })).toBe(202);
    expect(effectiveStatus(400, { error: "no" })).toBe(400);
  });
  test("a streamed long action reports the status written in its body", () => {
    expect(effectiveStatus(200, { waiting: true, kind: "approval", status: 202 })).toBe(202);
    expect(effectiveStatus(200, { error: "bug", status: 500 })).toBe(500);
    expect(effectiveStatus(200, { result: { ok: true, status: 7 } })).toBe(200);
    expect(effectiveStatus(200, null)).toBe(200);
  });
});
