import { expect, test } from "bun:test";
import { classifyChallenge } from "../src/challenge";

test("Cloudflare's explicit response signal requests help, generic 403 does not", () => {
  expect(
    classifyChallenge({
      cfMitigated: "challenge",
      text: "",
      visibleChallengeControl: false,
    })?.kind,
  ).toBe("cloudflare");
  expect(
    classifyChallenge({
      text: "403 Forbidden",
      visibleChallengeControl: false,
    }),
  ).toBeUndefined();
});
test("visible challenges require specific language and visible interactive evidence", () => {
  expect(
    classifyChallenge({
      text: "Verify you are human",
      visibleChallengeControl: true,
    })?.kind,
  ).toBe("visible-challenge");
  for (const text of [
    "An article about CAPTCHA",
    "Sign in to your account",
    "Access denied",
    "Unusual traffic detected",
  ]) {
    expect(
      classifyChallenge({ text, visibleChallengeControl: false }),
    ).toBeUndefined();
  }
  expect(
    classifyChallenge({
      text: "Verify you are human",
      visibleChallengeControl: false,
    }),
  ).toBeUndefined();
  expect(
    classifyChallenge({
      text: "An article about CAPTCHA",
      visibleChallengeControl: true,
    }),
  ).toBeUndefined();
});

test("detects domestic captcha widgets, slider prompts, and blocked QR login walls as cn-captcha", () => {
  const expectedReason =
    "检测到国内安全验证或滑块/扫码风控，请在浏览器窗口亲自完成验证后点击「我已完成，继续执行」。";

  expect(
    classifyChallenge({
      text: "正常页面标题",
      visibleChallengeControl: false,
      hasCnCaptchaWidget: true,
    }),
  ).toEqual({
    kind: "cn-captcha",
    reason: expectedReason,
  });

  for (const prompt of [
    "安全验证\n拖动滑块完成拼图",
    "请按住滑块，拖动到最右边",
    "向右滑动完成拼图验证",
    "请完成安全验证以继续访问",
    "请完成人机验证",
    "账号存在风险，请使用手机扫码登录",
    "扫码登录即可继续访问",
  ]) {
    expect(
      classifyChallenge({
        text: prompt,
        visibleChallengeControl: false,
      }),
    ).toEqual({
      kind: "cn-captcha",
      reason: expectedReason,
    });
  }

  expect(
    classifyChallenge({
      text: "扫码登录 首页\n".concat("普通正文内容与文章列表。".repeat(80)),
      visibleChallengeControl: false,
      hasQrLogin: true,
      hasBlockingOverlay: true,
    }),
  ).toEqual({
    kind: "cn-captcha",
    reason: expectedReason,
  });
});

test("ignores non-blocking mentions of QR login or slider documentation on regular pages", () => {
  const longBody = "这是一篇介绍前端交互设计与登录流程的文章。".repeat(80);
  expect(
    classifyChallenge({
      text: `扫码登录 首页 推荐\n${longBody}`,
      visibleChallengeControl: false,
    }),
  ).toBeUndefined();

  expect(
    classifyChallenge({
      text: `如何实现拖动滑块和向右滑动完成拼图组件教程\n${longBody}`,
      visibleChallengeControl: false,
    }),
  ).toBeUndefined();
});

test("detectChallenge delegates DOM signals to requestHelp with cn-captcha source without interacting", async () => {
  const { detectChallenge } = await import("../src/challenge");
  const { createControl } = await import("../src/control");
  const control = createControl();
  const fakePage = {
    evaluate: async () => ({
      text: "安全验证：请按住滑块",
      visibleChallengeControl: false,
      hasCnCaptchaWidget: true,
      hasQrLogin: false,
      hasBlockingOverlay: true,
    }),
  } as unknown as Parameters<typeof detectChallenge>[0];

  const challenge = await detectChallenge(fakePage, control, {
    toolCallId: "nav-cn-1",
  });
  expect(challenge).toMatchObject({
    kind: "cn-captcha",
    reason:
      "检测到国内安全验证或滑块/扫码风控，请在浏览器窗口亲自完成验证后点击「我已完成，继续执行」。",
  });
  expect(control.get().request).toMatchObject({
    id: challenge?.requestId,
    source: "cn-captcha",
    status: "waiting",
    toolCallId: "nav-cn-1",
  });
});
