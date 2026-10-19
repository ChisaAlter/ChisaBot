import { describe, expect, test } from "bun:test";
import { addressToUrl, isBlankPageUrl, isPlainWhitePixels, screenProblem } from "@/components/computer/live-screen";

describe("takeover blank page", () => {
  test("about:blank and empty urls are blank; missing url is a real page", () => {
    expect(isBlankPageUrl("about:blank")).toBe(true);
    expect(isBlankPageUrl(" ")).toBe(true);
    expect(isBlankPageUrl(undefined)).toBe(false);
    expect(isBlankPageUrl("https://example.com/")).toBe(false);
  });
  test("only a (nearly) white frame counts as blank", () => {
    expect(isPlainWhitePixels([255, 255, 255, 255, 250, 252, 249, 255])).toBe(true);
    expect(isPlainWhitePixels([255, 255, 255, 255, 30, 40, 50, 255])).toBe(false);
    expect(isPlainWhitePixels([])).toBe(false);
  });
});

describe("takeover address bar", () => {
  test("file:// addresses go to the computer as typed, not to a search", () => {
    expect(addressToUrl("file:///workspace/date.html")).toBe("file:///workspace/date.html");
    expect(addressToUrl("workspace.local/date.html")).toBe("https://workspace.local/date.html");
    expect(addressToUrl("天气")).toContain("bing.com/search");
  });
});

describe("takeover refusals", () => {
  /*
   * The computer's answer to input it will not take, said in the language of the rest of this view.
   *
   * These sentences were unreachable here until input stopped being blocked by the app's own copy of
   * the control state: the computer agrees with that state, so it had nothing to refuse. Now it is
   * the one that answers, and it answers in English, which would land on an otherwise Chinese screen
   * the first time the fix did its job.
   */
  test("a refusal the person can act on says what to do", () => {
    expect(screenProblem("Take control before driving the computer yourself.")).toContain("接管控制");
    expect(screenProblem("This screen is still starting. Try that again in a moment.")).toContain("正在打开");
    expect(
      screenProblem("This computer stopped, so the screen ended. Start it again to carry on watching."),
    ).toContain("已经停了");
  });

  test("a message nobody wrote a sentence for is passed through, not swallowed", () => {
    expect(screenProblem("CDP connection closed unexpectedly")).toBe("CDP connection closed unexpectedly");
  });
});
