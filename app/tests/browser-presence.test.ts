import { describe, expect, test } from "bun:test";
import {
  browserPresenceCardLabel,
  browserPresenceFootLabel,
  browserPresenceKind,
} from "@/lib/computers/browser-presence";
import {
  applyScreenshotPollResult,
  nextScreenshotPollDelay,
} from "@/lib/computers/screenshot-poll";
import {
  SCREEN_BUSY_ZH,
  SCREEN_UNAVAILABLE_ZH,
  screenshotErrorMessage,
} from "@/lib/computers/screen";

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
  test("backs off on consecutive failures, caps at 8s", () => {
    expect(nextScreenshotPollDelay(0, 1000)).toBe(1000);
    expect(nextScreenshotPollDelay(1, 1000)).toBe(1000);
    expect(nextScreenshotPollDelay(2, 1000)).toBe(2000);
    expect(nextScreenshotPollDelay(3, 1000)).toBe(4000);
    expect(nextScreenshotPollDelay(4, 1000)).toBe(8000);
    expect(nextScreenshotPollDelay(9, 1000)).toBe(8000);
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
});
