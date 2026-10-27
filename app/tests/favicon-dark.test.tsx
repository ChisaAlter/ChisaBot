import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { TabFavicon, TabStrip } from "@/components/computer/browser-tabs";
import { availableScreenHeight } from "@/components/computer/takeover-fit";
import { DARK_INK_LUMINANCE, hexLuminance, isDarkInkPixels } from "@/lib/favicon-tone";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await settleReactWork();
  cleanup();
  GlobalRegistrator.unregister();
});

/** DESIGN §96：暗色主题下深色墨图标要垫底板；放大页不滚动。 */
describe("深色墨图标判断", () => {
  test("GitHub 黑 / 深灰算深色，品牌彩色和中灰不算", () => {
    expect((hexLuminance("#24292f") ?? 1) < DARK_INK_LUMINANCE).toBe(true);
    expect((hexLuminance("#000") ?? 1) < DARK_INK_LUMINANCE).toBe(true);
    for (const colour of ["#0f7bd8", "#fb7299", "#6b7280", "#ffffff", "#0d9488"])
      expect((hexLuminance(colour) ?? 0) < DARK_INK_LUMINANCE).toBe(false);
    expect(hexLuminance("nope")).toBeNull();
  });

  test("像素：黑色图形是深色墨，透明部分不算，彩色图形不是", () => {
    const px = (r: number, g: number, b: number, a: number, n = 64) =>
      Array.from({ length: n }, () => [r, g, b, a]).flat();
    expect(isDarkInkPixels([...px(0, 0, 0, 255), ...px(255, 255, 255, 0)])).toBe(true);
    expect(isDarkInkPixels(px(36, 41, 47, 255))).toBe(true);
    expect(isDarkInkPixels(px(15, 123, 216, 255))).toBe(false);
    expect(isDarkInkPixels(px(255, 255, 255, 255))).toBe(false);
    expect(isDarkInkPixels(px(0, 0, 0, 0))).toBe(false);
  });

  test("字母块：GitHub 的深色字母块带 is-dark-ink，必应的不带", () => {
    const gh = render(<TabFavicon tab={{ title: "GitHub", url: "https://github.com/" }} />);
    expect(gh.container.querySelector(".btab-ic.is-mono.is-dark-ink")).toBeTruthy();
    cleanup();
    const bing = render(<TabFavicon tab={{ title: "必应", url: "https://www.bing.com/" }} />);
    expect(bing.container.querySelector(".btab-ic.is-mono")).toBeTruthy();
    expect(bing.container.querySelector(".is-dark-ink")).toBeNull();
    cleanup();
  });
});

describe("放大页", () => {
  test("屏幕可用高度 = 卡片最大高度 − 工具条和底栏", () => {
    // 1280×840：卡片最多 776，工具条 + 底栏 + 间距 = 180 → 屏幕 596。
    expect(availableScreenHeight(776, 180 + 900, 900)).toBe(596);
    expect(availableScreenHeight(200, 400, 100)).toBe(120);
  });

  test("还没有标签时标签栏仍然放得下关闭按钮", () => {
    const ui = render(<TabStrip computerId="no-tabs-yet" driving={false} end={<button type="button">{"关"}</button>} poll={false} />);
    expect(ui.getByText("关")).toBeTruthy();
    expect(ui.queryAllByRole("tab").length).toBe(0);
    cleanup();
    const none = render(<TabStrip computerId="no-tabs-yet-2" driving={false} poll={false} />);
    expect(none.container.innerHTML).toBe("");
  });
});
