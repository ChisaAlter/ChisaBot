import { describe, expect, test } from "bun:test";
import { friendlyError } from "../src/lib/chat/friendly-error";
import { friendlyStopReason } from "../src/lib/copilot/stopped-turn";

describe("模型回答到一半断开（成熟度扫查 F7）", () => {
  test("频道聊天的出错卡片说中文", () => {
    const f = friendlyError("AI SDK stream error");
    expect(f.title).toBe("模型的连接中途断开了");
    expect(f.retryable).toBe(true);
    expect(friendlyError('ClinePass: connection lost mid-reply (http2: server sent GOAWAY and closed the connection; debug="server_shutting_down")').title).toBe("模型的连接中途断开了");
  });
  test("机器人聊天的停止提示说中文", () => {
    expect(friendlyStopReason("AI SDK stream error")).toContain("连接中途断开");
  });
  test("原来的规则不受影响", () => {
    expect(friendlyError("Error 429: Too Many Requests").title).toContain("限流");
    expect(friendlyError("fetch failed").title).toBe("网络连接中断");
  });
});

/*
 * 2026-10-20 线上：选中的 space-bunny-free 被 OpenCode Zen 下线（HTTP 410
 * 「Model space-bunny-free has been deprecated. Use minimax-m3.1-flash-free instead.」）。
 * 以前这条落到兜底「机器人在回答前停止了」，用户以为应用坏了；真实原因是模型没了。
 */
describe("模型被服务商下线", () => {
  const raw =
    "OpenCode Zen: Model space-bunny-free has been deprecated. Use minimax-m3.1-flash-free instead.";

  test("出错卡片说清楚是模型没了，并指到模型选择器", () => {
    const f = friendlyError(raw);
    expect(f.title).toBe("这个模型已经下线了");
    expect(f.hint).toContain("模型名");
    expect(f.retryable).toBe(false);
    expect(f.detail).toBe(raw);
  });

  test("机器人聊天的提示也用中文说清楚", () => {
    expect(friendlyStopReason(raw)).toContain("已经下线");
    expect(friendlyStopReason(raw)).toContain("模型名");
  });

  test("一句话都没收到时，给一条能走的下一步", () => {
    const f = friendlyError("");
    expect(f.title).toBe("这一轮没有收到回答");
    expect(f.hint).toContain("换一个模型");
    expect(f.retryable).toBe(true);
  });
});
