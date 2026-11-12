import { describe, expect, test } from "bun:test";
import { friendlyError } from "../src/lib/chat/friendly-error";
import {
  friendlyStopReason,
  stoppedReason,
} from "../src/lib/conversations/stopped-turn";

test("DSH备用模型错误优先保留真实归属与超时详情", () => {
  const raw = "备用模型「backup」请求失败：HTTP 404 model not found";
  const result = friendlyError(stoppedReason(raw));
  expect(result.title).toBe("备用模型也未能完成回答");
  expect(result.detail).toBe(raw);
  expect(
    friendlyError(
      stoppedReason("主模型「primary」请求失败：HTTP 401 invalid API key"),
    ).title,
  ).toBe("模型密钥无效或已过期");
  const timedOut = "主模型「gpt-5.4」请求失败：Request timed out.";
  const timeoutCard = friendlyError(stoppedReason(timedOut));
  expect(timeoutCard.title).toBe("模型响应超时");
  expect(timeoutCard.detail).toBe(timedOut);
});

describe("模型回答到一半断开（成熟度扫查 F7）", () => {
  test("频道聊天的出错卡片说中文", () => {
    const f = friendlyError("AI SDK stream error");
    expect(f.title).toBe("模型的连接中途断开了");
    expect(f.retryable).toBe(true);
    expect(
      friendlyError(
        'ClinePass: connection lost mid-reply (http2: server sent GOAWAY and closed the connection; debug="server_shutting_down")',
      ).title,
    ).toBe("模型的连接中途断开了");
  });
  test("机器人聊天的停止提示说中文", () => {
    expect(friendlyStopReason("AI SDK stream error")).toContain("连接中途断开");
  });
  test("原来的规则不受影响", () => {
    expect(friendlyError("Error 429: Too Many Requests").title).toContain(
      "限流",
    );
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

/*
 * Hermes 上游把登录被撤说成「<email>'s sign-in was revoked; sign in again」：
 * 不是换 key 能解决的，要让用户去重新登录，所以说得更具体而不是笼统的「密钥无效」。
 */
describe("模型登录被服务商撤销", () => {
  test("登录被撤或 Magpie OAuth refresh_token_invalidated 说清楚要重新登录", () => {
    const f = friendlyError(
      "Provider said: HTTP 401: Codex: agent@example.com's sign-in was revoked; sign in again",
    );
    expect(f.title).toBe("模型登录已失效");
    expect(f.hint).toContain("重新登录");
    expect(f.retryable).toBe(false);

    const oauthExpired = friendlyError(
      '主模型「gpt-5.4」请求失败：{ error_code: Some("refresh_token_invalidated"), error_message: Some("Your session has ended. Please log in again.") }',
    );
    expect(oauthExpired.title).toBe("模型登录已失效");
    expect(oauthExpired.retryable).toBe(false);
  });

  test("key 被拒仍是密钥提示", () => {
    expect(
      friendlyError(
        "custom rejected your API key, so the model can't be reached.",
      ).title,
    ).toBe("模型密钥无效或已过期");
  });
});

describe("网关本地隐私脱敏拦截图片（privacy-gate）与模型不支持读图", () => {
  const rawPrivacyGate =
    'privacy-gate: a content part of type "image_url" cannot be masked locally; extract it to text first (Settings -> Privacy masks text only). Nothing was sent.';

  test("原始 privacy-gate 英文报错与带前缀报错均给出中文说明并禁用重试", () => {
    const reason = friendlyStopReason(rawPrivacyGate);
    expect(reason).toContain("本地隐私脱敏");
    expect(reason).toContain("撤回");

    const fromRaw = friendlyError(`这一轮出错了：${rawPrivacyGate}`);
    expect(fromRaw.title).toBe(
      "当前模型网关开启了本地隐私脱敏，不能直接发送图片",
    );
    expect(fromRaw.hint).toContain("撤回这条消息");
    expect(fromRaw.hint).toContain("Settings → Privacy");
    expect(fromRaw.retryable).toBe(false);

    const fromRoute = friendlyError(
      `主模型「gpt-4o」请求失败：${rawPrivacyGate}`,
    );
    expect(fromRoute.title).toBe(
      "当前模型网关开启了本地隐私脱敏，不能直接发送图片",
    );
    expect(fromRoute.retryable).toBe(false);
  });

  test("主备模型都不支持读取图片时禁用无意义重试并引导切换模型或撤回", () => {
    const f = friendlyError(
      "当前主模型和备用模型都不能读取这段对话中的图片，请选择支持图片的模型。",
    );
    expect(f.title).toBe("当前所选模型不支持读取图片");
    expect(f.hint).toContain("撤回这条消息");
    expect(f.retryable).toBe(false);
  });
});
