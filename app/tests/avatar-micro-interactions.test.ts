import { afterEach, describe, expect, test } from "bun:test";
import {
  forgetRememberedPreviews,
  isAntiBotChallengeTitle,
  type LinkPreviewData,
  peekCachedLinkPreview,
  previewClient,
  rememberPreview,
  sanitizeLinkPreview,
} from "@/components/rich-previews/link-preview-query";
import {
  assignDistinctBusyExpressions,
  BUSY_EXPRESSIONS,
  computeGazeVector,
  createStaggeredGazeScheduler,
  deriveSignAvatarMood,
} from "@/lib/agents/avatar-expressions";
import { mergeLinkFields } from "@/lib/rich-previews/link-fields";

afterEach(() => {
  previewClient.clear();
  forgetRememberedPreviews();
});

describe("虚拟形象情感微交互：去重忙碌神态、指针凝视与登录表情机", () => {
  test("assignDistinctBusyExpressions 为 ≤6 个忙碌 Bot 分配全部互异神态且确定性稳定", () => {
    const sixBots = [
      "bot-alpha",
      "bot-beta",
      "bot-gamma",
      "bot-delta",
      "bot-epsilon",
      "bot-zeta",
    ];
    const first = assignDistinctBusyExpressions(sixBots);
    const second = assignDistinctBusyExpressions(sixBots);

    expect(first.size).toBe(6);
    expect(new Set(first.values()).size).toBe(BUSY_EXPRESSIONS.length);
    for (const id of sixBots) {
      expect(first.get(id)).toBe(second.get(id));
    }

    // 超过 6 个忙碌 Bot 时平滑循环复用且去重重复 ID
    const eightBots = [...sixBots, "bot-eta", "bot-theta", "bot-alpha"];
    const eightMap = assignDistinctBusyExpressions(eightBots);
    expect(eightMap.size).toBe(8);
    for (const expr of eightMap.values()) {
      expect(BUSY_EXPRESSIONS).toContain(expr);
    }
  });

  test("computeGazeVector 正确限幅并严格遵守 prefers-reduced-motion", () => {
    // 开启减少动态效果时严格归零
    expect(
      computeGazeVector({ x: 100, y: 100 }, { x: 500, y: 100 }, 80, {
        reach: 0.08,
        reducedMotion: true,
      }),
    ).toEqual({ x: 0, y: 0 });

    // 远距离严格限幅在 size * reach = 80 * 0.1 = 8px
    const far = computeGazeVector({ x: 100, y: 100 }, { x: 1000, y: 100 }, 80, {
      reach: 0.1,
      reducedMotion: false,
    });
    expect(far.x).toBeCloseTo(8, 2);
    expect(far.y).toBeCloseTo(0, 2);

    // 对角线向量模长不超过 maxOffset
    const diag = computeGazeVector({ x: 0, y: 0 }, { x: 500, y: 500 }, 100, {
      reach: 0.075,
    });
    expect(Math.hypot(diag.x, diag.y)).toBeLessThanOrEqual(7.51);
  });

  test("createStaggeredGazeScheduler 单 rAF 错峰冷却、失焦暂停与减少动态效果静默", () => {
    let now = 1000;
    const queued: Array<(ts: number) => void> = [];
    let reduced = false;
    const scheduler = createStaggeredGazeScheduler({
      minCooldownMs: 200,
      maxCooldownMs: 200,
      idleStopMs: 800,
      adapter: {
        now: () => now,
        random: () => 0.5,
        isReducedMotion: () => reduced,
        requestFrame: (cb) => {
          queued.push(cb);
          return queued.length;
        },
        cancelFrame: () => {},
      },
    });

    const fakeEl = {
      getBoundingClientRect: () => ({
        left: 100,
        top: 100,
        width: 80,
        height: 80,
      }),
    } as unknown as Element;

    const applied: Array<{ x: number; y: number }> = [];
    const unregister = scheduler.register({
      element: fakeEl,
      apply: (offset) => applied.push(offset),
    });

    // 移动指针触发单帧
    scheduler.updatePointer({ x: 300, y: 140 });
    expect(queued.length).toBe(1);
    const frame1 = queued.shift();
    frame1?.(now);
    expect(applied.length).toBe(1);
    expect(applied[0]?.x).toBeGreaterThan(0);

    // 冷却期内（+50ms < 200ms）不重复重绘同一头像
    now += 50;
    const frame2 = queued.shift();
    frame2?.(now);
    expect(applied.length).toBe(1);

    // 超过冷却期（+200ms）再次应用
    now += 200;
    const frame3 = queued.shift();
    frame3?.(now);
    expect(applied.length).toBe(2);

    // 窗口失焦暂停：立刻归零并停止循环
    scheduler.setPaused(true);
    expect(applied[applied.length - 1]).toEqual({ x: 0, y: 0 });
    expect(scheduler.isRunning()).toBe(false);

    // 减少动态效果开启时忽略指针移动
    reduced = true;
    scheduler.setPaused(false);
    scheduler.updatePointer({ x: 500, y: 500 });
    expect(scheduler.isRunning()).toBe(false);

    unregister();
    scheduler.dispose();
  });

  test("登录页表单状态联动表情机覆盖密码闭眼回避、报错摇头与成功眯眼笑", () => {
    expect(deriveSignAvatarMood({})).toBe("idle");
    expect(deriveSignAvatarMood({ hasPointer: true })).toBe("gaze");
    expect(
      deriveSignAvatarMood({ passwordFocused: true, hasPointer: true }),
    ).toBe("cover-eyes");
    expect(deriveSignAvatarMood({ passwordFilled: true })).toBe("cover-eyes");
    expect(
      deriveSignAvatarMood({ submitting: true, passwordFilled: true }),
    ).toBe("submitting");
    expect(deriveSignAvatarMood({ hasError: true, submitting: true })).toBe(
      "shake-error",
    );
    expect(deriveSignAvatarMood({ succeeded: true, hasError: true })).toBe(
      "happy-squint",
    );
  });
});

describe("链接预览 Hover 纯缓存探测与微信/知乎/小红书反爬标题过滤", () => {
  test("peekCachedLinkPreview 严格零网络命中内存缓存，未命中返回 null", () => {
    const url = "https://docs.example.test/guide";
    expect(peekCachedLinkPreview(url)).toBeNull();

    const sample: LinkPreviewData = {
      url,
      finalUrl: url,
      title: "ChisaBot 多模态指南",
      siteName: "ChisaDocs",
      domain: "docs.example.test",
      description: "支持图片、音频与视频多模态理解",
      image: null,
      imageKind: "none",
      imagePending: false,
      favicon: null,
    };
    previewClient.setQueryData(["link-preview", url], sample);

    const hit = peekCachedLinkPreview(url);
    expect(hit).not.toBeNull();
    expect(hit?.title).toBe("ChisaBot 多模态指南");
    expect(hit?.degraded).toBeUndefined();
  });

  test("反爬验证页特征识别过滤微信/知乎/小红书验证页标题，放行正常中文标题", () => {
    const blockedTitles = [
      "环境异常",
      "当前环境异常，完成验证后即可继续访问",
      "请完成验证 - 小红书",
      "安全验证 - 知乎",
      "安全限制 - 小红书",
      "微信公众平台安全验证",
      "Just a moment...",
    ];
    for (const title of blockedTitles) {
      expect(isAntiBotChallengeTitle(title)).toBe(true);
    }

    const normalTitles = [
      "如何打造安全可靠的 AI 智能体架构",
      "知乎高赞：为什么 Bun 的启动这么快",
      "小红书摄影技巧分享：城市夜景构图指南",
      "微信公众号排版设计规范",
    ];
    for (const title of normalTitles) {
      expect(isAntiBotChallengeTitle(title)).toBe(false);
    }

    // sanitizeLinkPreview & peekCachedLinkPreview 自动降级已缓存的反爬验证标题
    const wxUrl = "https://mp.weixin.qq.com/s/demo-article";
    const poisoned: LinkPreviewData = {
      url: wxUrl,
      finalUrl: wxUrl,
      title: "环境异常",
      siteName: "微信公众平台",
      domain: "mp.weixin.qq.com",
      description: "当前环境异常，完成验证后即可继续访问",
      image: "/api/link-preview/asset/abc",
      imageKind: "og",
      imagePending: false,
      favicon: null,
    };
    rememberPreview(wxUrl, poisoned);
    const sanitized = sanitizeLinkPreview(poisoned);
    expect(sanitized.degraded).toBe(true);
    expect(sanitized.title).toBe("mp.weixin.qq.com");
    expect(sanitized.image).toBeNull();

    // mergeLinkFields 同样拒绝将反爬验证标题显示为主标题
    const merged = mergeLinkFields(wxUrl, {}, poisoned);
    expect(merged.degraded).toBe(true);
    expect(merged.title).toBe("mp.weixin.qq.com");
  });
});
