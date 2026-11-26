import { afterEach, describe, expect, test } from "bun:test";
import {
  collectVisibleNoticeSnapshot,
  diffNewLimitNotice,
  isShortNotice,
  LIMIT_NOTICE_MAX_LENGTH,
  LIMIT_NOTICE_SELECTOR,
  matchesLimitNotice,
  normalizeNoticeText,
} from "../src/limit-notice";

describe("limit-notice pure matching", () => {
  test("matches Chinese and English rate/daily limit toast phrases", () => {
    const hits = [
      "今日免费次数已用完，请明天再来",
      "已达上限，请升级套餐",
      "操作过于频繁，请稍后再试",
      "请求过于频繁，触发限流",
      "Daily limit reached for today",
      "Rate limit exceeded. Try again later.",
      "429 Too Many Requests",
      "Quota exceeded",
    ];
    for (const text of hits) {
      expect(matchesLimitNotice(text)).toBe(true);
    }
  });

  test("ignores normal toasts and long body paragraphs (>120 non-whitespace chars)", () => {
    expect(matchesLimitNotice("保存成功")).toBe(false);
    expect(matchesLimitNotice("已复制到剪贴板")).toBe(false);
    expect(matchesLimitNotice("   ")).toBe(false);

    const longArticle =
      "这是一段介绍 API rate limit 与每日限流设计规范的详细说明文字，".repeat(
        6,
      );
    expect(longArticle.replace(/\s+/g, "").length).toBeGreaterThan(
      LIMIT_NOTICE_MAX_LENGTH,
    );
    expect(isShortNotice(longArticle)).toBe(false);
    expect(matchesLimitNotice(longArticle)).toBe(false);
  });

  test("normalizes whitespace and counts only non-whitespace characters toward 120-char limit", () => {
    const padded = `  操作过于频繁，  请稍后再试  ${" ".repeat(140)}`;
    expect(normalizeNoticeText(padded)).toBe("操作过于频繁， 请稍后再试");
    expect(isShortNotice(padded)).toBe(true);
    expect(matchesLimitNotice(padded)).toBe(true);
  });

  test("diffNewLimitNotice only reports newly appeared limit notices and prefers inner concise node", () => {
    const before = ["系统维护通知", "今日次数已用完"];
    expect(
      diffNewLimitNotice(before, ["系统维护通知", "今日次数已用完"]),
    ).toBeUndefined();

    expect(
      diffNewLimitNotice(before, [
        "系统维护通知",
        "提示：操作过于频繁，请稍后再试 ×",
        "操作过于频繁，请稍后再试",
      ]),
    ).toBe("操作过于频繁，请稍后再试");
  });
});

type FakeNode = {
  textContent: string | null;
  style: { display?: string; visibility?: string; opacity?: string };
  rect: { width: number; height: number };
  selfExcluded?: boolean;
  containsExcluded?: boolean;
  matches: (selector: string) => boolean;
  querySelector: (selector: string) => object | null;
  getBoundingClientRect: () => DOMRect;
};

describe("collectVisibleNoticeSnapshot DOM boundary", () => {
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
  });

  test("captures visible toast text while skipping hidden nodes and sensitive inputs", () => {
    const makeNode = (
      text: string,
      opts: Partial<{
        display: string;
        visibility: string;
        opacity: string;
        width: number;
        height: number;
        selfExcluded: boolean;
        containsExcluded: boolean;
      }> = {},
    ): FakeNode => ({
      textContent: text,
      style: {
        display: opts.display ?? "block",
        visibility: opts.visibility ?? "visible",
        opacity: opts.opacity ?? "1",
      },
      rect: { width: opts.width ?? 200, height: opts.height ?? 32 },
      matches: () => Boolean(opts.selfExcluded),
      querySelector: () => (opts.containsExcluded ? {} : null),
      getBoundingClientRect: () =>
        ({
          width: opts.width ?? 200,
          height: opts.height ?? 32,
          top: 10,
          left: 10,
          right: 210,
          bottom: 42,
        }) as DOMRect,
    });

    const nodes = [
      makeNode("操作过于频繁，请稍后再试"),
      makeNode("次数已用完", { display: "none" }),
      makeNode("hunter2 Rate limit exceeded", { containsExcluded: true }),
      makeNode("Rate limit exceeded"),
      makeNode("rate limit secret input", { selfExcluded: true }),
    ];

    globalThis.document = {
      title: "测试页面",
      querySelectorAll: () => nodes,
    } as unknown as Document;

    globalThis.getComputedStyle = ((node: FakeNode) =>
      node.style) as unknown as typeof getComputedStyle;

    const snapshot = collectVisibleNoticeSnapshot({
      selector: LIMIT_NOTICE_SELECTOR,
      maxLength: LIMIT_NOTICE_MAX_LENGTH,
    });

    expect(snapshot.title).toBe("测试页面");
    expect(snapshot.notices).toEqual([
      "操作过于频繁，请稍后再试",
      "Rate limit exceeded",
    ]);
  });
});
