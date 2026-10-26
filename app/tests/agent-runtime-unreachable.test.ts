import { describe, expect, test } from "bun:test";
import { friendlyError } from "../src/lib/chat/friendly-error";
import { friendlyStopReason } from "../src/lib/copilot/stopped-turn";

// CB-100：服务器在流开始前连不上智能体运行时，发来的 RUN_ERROR 要显示成「智能体运行时无法连接」并能重试，
// 而不是被 ConnectionRefused 里的字样认成浏览器这边的「网络连接中断」。
describe("agent runtime unreachable", () => {
  test("server pre-stream failure maps to a localized, retryable card", () => {
    const f = friendlyError(
      "智能体运行时无法连接（ConnectionRefused: Unable to connect. Is the computer able to access the url?）",
    );
    expect(f.title).toBe("智能体运行时无法连接");
    expect(f.retryable).toBe(true);
    expect(f.detail).toContain("ConnectionRefused");
  });
  test("plain browser network errors keep their own wording", () => {
    expect(friendlyError("Failed to fetch").title).toBe("网络连接中断");
  });
  test("bot chat stop reason says the runtime is unreachable, not the model", () => {
    expect(friendlyStopReason("智能体运行时无法连接（ConnectionRefused: Unable to connect）")).toContain("智能体运行时无法连接");
  });
});
