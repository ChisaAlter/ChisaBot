import { describe, expect, test } from "bun:test";
import {
  browserPresenceCardLabel,
  browserPresenceFootLabel,
  browserPresenceKind,
} from "@/lib/computers/browser-presence";
import {
  applyScreenshotPollResult,
  LIVE_CAST_PROBE_MS,
  nextScreenshotPollDelay,
  SCREENSHOT_POLL_MAX_DELAY_MS,
} from "@/lib/computers/screenshot-poll";
import {
  SCREEN_BUSY_ZH,
  SCREEN_LIVE_CAST_ZH,
  SCREEN_PAGE_TIMEOUT_ZH,
  SCREEN_UNAVAILABLE_ZH,
  screenshotErrorMessage,
  SCREEN_USER_CONTROL_ZH,
} from "@/lib/computers/screen";
import { screenshotPollBlocked } from "@/lib/computers/screenshot-poll";

describe("browserPresenceKind (DOG-05)", () => {
  test("idle bot hold is idle, not bot-busy", () => {
    expect(
      browserPresenceKind({
        control: { holder: "bot" },
        botActive: false,
      }),
    ).toBe("idle");
    expect(browserPresenceCardLabel("idle")).toContain("空闲");
    expect(browserPresenceFootLabel("idle")).toContain("空闲");
  });

  test("recent computer status → bot-busy copy", () => {
    expect(
      browserPresenceKind({
        control: { holder: "bot" },
        botActive: true,
      }),
    ).toBe("bot-busy");
    expect(browserPresenceCardLabel("bot-busy")).toContain("在用浏览器");
  });

  test("failed screenshot clears live claim", () => {
    expect(
      browserPresenceKind({
        control: { holder: "bot" },
        botActive: true,
        screenUnavailable: true,
      }),
    ).toBe("unavailable");
    expect(browserPresenceCardLabel("unavailable")).toContain("暂时看不到");
  });

  test("human / transitioning / checking", () => {
    expect(
      browserPresenceKind({ control: { holder: "human" }, botActive: false }),
    ).toBe("driving");
    expect(
      browserPresenceKind({
        control: { holder: "bot", transitioning: true },
        botActive: true,
      }),
    ).toBe("transitioning");
    expect(browserPresenceKind({ control: null, botActive: false })).toBe(
      "checking",
    );
  });
});

describe("applyScreenshotPollResult (DOG-05)", () => {
  test("error clears any prior frame", () => {
    expect(applyScreenshotPollResult({ error: "电脑正忙" })).toEqual({
      shot: null,
      problem: "电脑正忙",
    });
  });

  test("success returns the frame and clears problem", () => {
    const frame = {
      base64: "abc",
      width: 10,
      height: 10,
      capturedAt: "2026-10-18T00:00:00Z",
    };
    expect(applyScreenshotPollResult({ frame })).toEqual({
      shot: frame,
      problem: null,
    });
  });
});

describe("nextScreenshotPollDelay", () => {
  test("backs off on consecutive failures, caps at 30s", () => {
    expect(nextScreenshotPollDelay(0, 1000)).toBe(1000);
    expect(nextScreenshotPollDelay(1, 1000)).toBe(1000);
    expect(nextScreenshotPollDelay(2, 1000)).toBe(2000);
    expect(nextScreenshotPollDelay(3, 1000)).toBe(4000);
    expect(nextScreenshotPollDelay(4, 1000)).toBe(8000);
    expect(nextScreenshotPollDelay(5, 1000)).toBe(16000);
    expect(nextScreenshotPollDelay(6, 1000)).toBe(30000);
    expect(nextScreenshotPollDelay(9, 1000)).toBe(30000);
  });
});

describe("a poll that stops can never come back", () => {
  // 线上 bug：遇到一次 liveCast 就 return，定时器不再排，大屏关掉卡片也不会自己回来，
  // 而底栏文案还写着「稍后会自动重试」。所以这里断言的是「放慢」而不是「停」。
  test("liveCast slows to a probe instead of stopping", () => {
    expect(nextScreenshotPollDelay(0, 1000, { liveCast: true })).toBe(LIVE_CAST_PROBE_MS);
    expect(nextScreenshotPollDelay(99, 1000, { liveCast: true })).toBe(LIVE_CAST_PROBE_MS);
    expect(LIVE_CAST_PROBE_MS).toBeGreaterThan(0);
    expect(LIVE_CAST_PROBE_MS).toBeLessThanOrEqual(SCREENSHOT_POLL_MAX_DELAY_MS);
  });

  test("the worst backoff is still a delay, never a dead one", () => {
    expect(nextScreenshotPollDelay(1000, 1000)).toBe(SCREENSHOT_POLL_MAX_DELAY_MS);
    expect(Number.isFinite(nextScreenshotPollDelay(1000, 1000))).toBe(true);
    expect(nextScreenshotPollDelay(1000, 1000)).toBeGreaterThan(0);
  });

  test("a broken interval argument falls back to one second", () => {
    for (const bad of [Number.NaN, 0, -1]) {
      expect(nextScreenshotPollDelay(0, bad)).toBe(1000);
    }
  });
});

describe("screenshotErrorMessage", () => {
  test("503 → busy Chinese; Chinese server text kept", () => {
    expect(screenshotErrorMessage(503, "Something went wrong.")).toBe(
      SCREEN_BUSY_ZH,
    );
    expect(screenshotErrorMessage(502, undefined)).toBe(SCREEN_BUSY_ZH);
    expect(screenshotErrorMessage(500, "工作区未就绪")).toBe("工作区未就绪");
    expect(screenshotErrorMessage(undefined, undefined)).toBe(
      SCREEN_UNAVAILABLE_ZH,
    );
  });

  test("captureBusy / liveCast / pageTimeout flags", () => {
    expect(
      screenshotErrorMessage(503, "Live screen is streaming…", {
        captureBusy: true,
        liveCast: true,
      }),
    ).toBe(SCREEN_LIVE_CAST_ZH);
    expect(
      screenshotErrorMessage(503, "Another screenshot…", { captureBusy: true }),
    ).toBe(SCREEN_BUSY_ZH);
    expect(
      screenshotErrorMessage(422, "The page did not respond…", {
        pageTimeout: true,
      }),
    ).toBe(SCREEN_PAGE_TIMEOUT_ZH);
    expect(screenshotErrorMessage(422, undefined)).toBe(SCREEN_PAGE_TIMEOUT_ZH);
  });
});

describe("CB-103 user control", () => {
  test("409 + userControl → 接管中的说明，不是「忙」", () => {
    expect(
      screenshotErrorMessage(409, "Live screen is streaming.", {
        captureBusy: true,
        liveCast: true,
        userControl: true,
      }),
    ).toBe(SCREEN_USER_CONTROL_ZH);
  });

  test("接管中 / 大屏展开时卡片不发截图请求", () => {
    expect(screenshotPollBlocked({ expanded: false, driving: true })).toBe(
      "user_control",
    );
    expect(screenshotPollBlocked({ expanded: true, driving: true })).toBe(
      "expanded",
    );
    expect(screenshotPollBlocked({ expanded: false, driving: false })).toBeNull();
  });
});
