import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import { ThemeProvider } from "@/components/theme-provider";
import {
  APPEARANCE_STORAGE_KEY,
  appearanceBootScript,
  DEFAULT_APPEARANCE_CONFIG,
  flushAppearanceWrites,
  getAppearanceConfig,
  isDefaultAppearance,
  reloadAppearanceFromStorage,
  resetAppearance,
  setMaterial,
} from "@/lib/appearance";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  window.localStorage.clear();
  resetAppearance();
  flushAppearanceWrites();
  window.localStorage.clear();
  await reloadAppearanceFromStorage();
});

function bootMaterial(): string | null {
  document.documentElement.removeAttribute("data-material");
  Function(appearanceBootScript())();
  return document.documentElement.getAttribute("data-material");
}

describe("V2 默认材质为磨砂（glass）", () => {
  test("空存储默认读取 glass 材质、sky 主题、auto 动态天空（关闭天气）", () => {
    const cfg = getAppearanceConfig();
    expect(cfg).toEqual(DEFAULT_APPEARANCE_CONFIG);
    expect(cfg.material).toBe("glass");
    expect(cfg.theme).toBe("sky");
    expect(cfg.staticBackground).toBe(false);
  });

  test("resetAppearance 回到默认磨砂材质 glass", () => {
    setMaterial("clear");
    flushAppearanceWrites();
    expect(getAppearanceConfig().material).toBe("clear");

    resetAppearance();
    flushAppearanceWrites();
    expect(getAppearanceConfig().material).toBe("glass");
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(true);
    const stored = JSON.parse(
      window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}",
    );
    expect(stored.material).toBe("glass");
  });

  test("启动脚本在空存储或非法材质值时写 data-material=\"glass\"，合法 V2 材质原样保持", () => {
    expect(bootMaterial()).toBe("glass");

    for (const mat of ["glass", "clear", "solid"] as const) {
      window.localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify({ ...DEFAULT_APPEARANCE_CONFIG, material: mat }),
      );
      expect(bootMaterial()).toBe(mat);
    }

    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE_CONFIG, material: "liquid" }),
    );
    expect(bootMaterial()).toBe("glass");
  });

  test("旧版外观键无损迁移：mist/frosted → glass，crystal/liquid → clear，perf-mode → solid + 静止背景", async () => {
    const cases: Array<[Record<string, string>, "glass" | "clear" | "solid", boolean]> = [
      [{ "chisabot-glass-style": "mist" }, "glass", false],
      [{ "chisabot-glass-style": "frosted" }, "glass", false],
      [{ "chisabot-glass-style": "crystal" }, "clear", false],
      [{ "chisabot-glass-style": "liquid" }, "clear", false],
      [{ "chisabot.perf-mode": "on", "chisabot-glass-style": "crystal" }, "solid", true],
      [{ [THEME_STORAGE_KEY]: "dark" }, "glass", false],
    ];

    for (const [legacy, expectedMaterial, expectedStatic] of cases) {
      window.localStorage.clear();
      for (const [k, v] of Object.entries(legacy)) {
        window.localStorage.setItem(k, v);
      }
      expect(bootMaterial()).toBe(expectedMaterial);
      await reloadAppearanceFromStorage();
      expect(getAppearanceConfig().material).toBe(expectedMaterial);
      expect(getAppearanceConfig().staticBackground).toBe(expectedStatic);
    }
  });

  test("设置页判脏使用 isDefaultAppearance：默认状态隐藏「恢复默认」，改材质立即显示", () => {
    resetAppearance();
    flushAppearanceWrites();
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    expect(view.queryByRole("button", { name: "恢复默认" })).toBeNull();
    act(() => {
      setMaterial("clear");
      flushAppearanceWrites();
    });
    view.rerender(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    expect(view.getByRole("button", { name: "恢复默认" })).toBeTruthy();
  });
});

describe("CHANGELOG", () => {
  test("历史玻璃材质变更条目在对应发布节中保持连续相邻", () => {
    const log = readFileSync(
      path.join(import.meta.dir, "../../CHANGELOG.md"),
      "utf8",
    );
    const sections = log
      .split(/^## /m)
      .slice(1)
      .map((section) => section.slice(section.indexOf("\n") + 1).trim());
    const glassSections = sections.filter((section) =>
      section.includes("新用户与「恢复默认」的玻璃材质改为「薄雾玻璃」"),
    );
    expect(glassSections).toHaveLength(1);
    const section = glassSections[0] ?? "";
    const lines = section.split("\n");
    const firstEntry = lines.findIndex((line) => line.startsWith("- "));
    const mist = lines.findIndex((l) => l.includes("薄雾玻璃"));
    const liquid = lines.findIndex((l) => l.startsWith("- 液态玻璃"));
    expect(mist).toBeGreaterThanOrEqual(0);
    expect(liquid).toBe(mist + 1);
    expect(
      lines
        .slice(firstEntry, liquid + 1)
        .every((line) => line.startsWith("- ")),
    ).toBe(true);
  });
});
