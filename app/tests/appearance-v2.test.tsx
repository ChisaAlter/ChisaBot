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
import {
  createHarkFetch,
  resolveSkyTarget,
  SkyBackground,
} from "@/components/sky-background";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import {
  APPEARANCE_STORAGE_KEY,
  type AppearanceConfigV2,
  appearanceBootScript,
  CUSTOM_ACCENT_CSS_PROPS,
  DEFAULT_APPEARANCE_CONFIG,
  deriveCustomAccentVars,
  flushAppearanceWrites,
  getAppearanceConfig,
  HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
  isDefaultAppearance,
  LEGACY_APPEARANCE_STORAGE_KEYS,
  migrateLegacyAppearance,
  reloadAppearanceFromStorage,
  resetAppearance,
  resolveAutoSkyHour,
  setAppearanceConfig,
  setAppearanceMode,
  setCanvas,
  setCustomAccent,
  setMaterial,
  setSkyScene,
  setSkyWeather,
  setStaticBackground,
  setTheme,
  setWallpaperAdjustments,
  setWallpaperSource,
  shouldFetchLiveWeather,
  syncAppearanceFromStorage,
} from "@/lib/appearance";
import { getPerfMode, setPerfMode } from "@/lib/perf-mode";
import { settleReactWork } from "./settle-react-work";

function hexLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const rgb = [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(a: string, b: string): number {
  const l1 = hexLuminance(a);
  const l2 = hexLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  for (const attr of [
    "data-theme",
    "data-material",
    "data-canvas",
    "data-static-bg",
    "data-perf",
    "data-sky",
    "data-sky-off",
    "data-sky-painted",
    "data-theme-family",
    "data-glass",
    "data-wallpaper",
    "data-palette",
  ]) {
    document.documentElement.removeAttribute(attr);
  }
  await reloadAppearanceFromStorage();
});

afterEach(async () => {
  cleanup();
  flushAppearanceWrites();
  await settleReactWork();
});

describe("V2 16 键一次性无损迁移", () => {
  const makeGetter = (map: Record<string, string>) => (key: string) =>
    Object.hasOwn(map, key) ? map[key] : null;

  test("全新用户（空存储）保持 V2 默认配置且不触发迁移写盘", () => {
    const result = migrateLegacyAppearance(makeGetter({}), false);
    expect(result.migrated).toBe(false);
    expect(result.config).toEqual(DEFAULT_APPEARANCE_CONFIG);
    expect(isDefaultAppearance(result.config)).toBe(true);
  });

  test("模式、主题族、旧 palette 与自定义强调色全组合无损映射", () => {
    const cases: Array<[string, AppearanceConfigV2["theme"]]> = [
      ["azure", "sky"],
      ["default", "sky"],
      ["ocean", "sky"],
      ["mist", "mist"],
      ["stardust", "mist"],
      ["london", "mist"],
      ["celadon", "celadon"],
      ["emerald", "celadon"],
      ["sakura", "sakura"],
      ["ruby", "sakura"],
      ["amber", "amber"],
      ["sunset", "amber"],
      ["gold", "amber"],
      ["violet", "violet"],
      ["aurora", "violet"],
      ["nocturne", "violet"],
      ["mono", "mono"],
    ];
    for (const [legacy, expected] of cases) {
      const res = migrateLegacyAppearance(
        makeGetter({
          "chisabot-theme": "light",
          "chisabot-theme-family-light": legacy,
        }),
        false,
      );
      expect(res.config.theme).toBe(expected);
      expect(res.config.mode).toBe("light");
    }

    // 深色模式下优先读 dark 槽；自定义族提取强调色到 customAccent
    const customRes = migrateLegacyAppearance(
      makeGetter({
        "chisabot-theme": "dark",
        "chisabot-theme-family-dark": "custom-ocean",
        "chisabot-theme-families": JSON.stringify([
          {
            id: "custom-ocean",
            name: "我的深海",
            light: { ac: "#112233", bg: "#f0f4f8", fg: "#101820", c: 46 },
            dark: { ac: "#38BDF8", bg: "#0d1117", fg: "#e6edf3", c: 50 },
          },
        ]),
      }),
      false,
    );
    expect(customRes.config.mode).toBe("dark");
    expect(customRes.config.theme).toBe("sky");
    expect(customRes.config.customAccent).toBe("#38bdf8");
  });

  test("性能模式与玻璃材质迁移：perf-mode 优先落到 solid + staticBackground", () => {
    const perfRes = migrateLegacyAppearance(
      makeGetter({
        "chisabot.perf-mode": "on",
        "chisabot-glass-style": "crystal",
      }),
      false,
    );
    expect(perfRes.config.material).toBe("solid");
    expect(perfRes.config.staticBackground).toBe(true);

    const crystalRes = migrateLegacyAppearance(
      makeGetter({ "chisabot-glass-style": "crystal" }),
      false,
    );
    expect(crystalRes.config.material).toBe("clear");
    expect(crystalRes.config.staticBackground).toBe(false);

    const liquidRes = migrateLegacyAppearance(
      makeGetter({ "chisabot-glass-style": "liquid" }),
      false,
    );
    expect(liquidRes.config.material).toBe("clear");

    const mistRes = migrateLegacyAppearance(
      makeGetter({ "chisabot-glass-style": "mist" }),
      false,
    );
    expect(mistRes.config.material).toBe("glass");
  });

  test("壁纸（含旧 SVG 预设、模糊裁剪 0-24 与压暗/薄幕合并）优先于天空", () => {
    const res = migrateLegacyAppearance(
      makeGetter({
        "chisabot-wallpaper-id": "aurora-mesh",
        "chisabot-wallpaper-blur": "36",
        "chisabot-wallpaper-dim": "20",
        "chisabot-wallpaper-scrim": "60",
        "chisabot-sky-source": "theme",
      }),
      false,
    );
    expect(res.config.canvas).toEqual({
      kind: "wallpaper",
      source: "nordic-fjord",
      blur: 24,
      scrim: 49,
    });
  });

  test("天空来源与 Hark 12 场景无损收敛到 pure / sky 4 时刻 / live 天气", () => {
    const pureRes = migrateLegacyAppearance(
      makeGetter({ "chisabot-sky-source": "theme" }),
      false,
    );
    expect(pureRes.config.canvas).toEqual({ kind: "pure" });

    const liveRes = migrateLegacyAppearance(
      makeGetter({
        "chisabot-sky-source": "hark",
        "chisabot-hark-scene": "live",
      }),
      false,
    );
    expect(liveRes.config.canvas).toEqual({
      kind: "sky",
      scene: "auto",
      weather: { enabled: true, city: null },
    });

    const sceneCases: Array<[string, "dawn" | "day" | "dusk" | "night"]> = [
      ["11", "dawn"],
      ["0", "day"],
      ["3", "day"],
      ["5", "day"],
      ["6", "dusk"],
      ["1", "dusk"],
      ["4", "night"],
      ["10", "night"],
    ];
    for (const [oldScene, expectedScene] of sceneCases) {
      const res = migrateLegacyAppearance(
        makeGetter({
          "chisabot-sky-source": "hark",
          "chisabot-hark-scene": oldScene,
        }),
        false,
      );
      expect(res.config.canvas).toEqual({
        kind: "sky",
        scene: expectedScene,
        weather: { enabled: false, city: null },
      });
    }
  });

  test("首次读取落盘 chisabot-appearance v:2 并清退全部 16 旧键与幽灵键", async () => {
    window.localStorage.setItem("chisabot-theme", "dark");
    window.localStorage.setItem("chisabot-theme-family-dark", "sakura");
    window.localStorage.setItem("chisabot-glass-style", "crystal");
    window.localStorage.setItem("chisabot-glass-opacity", "28");
    window.localStorage.setItem("chisabot-glass-opacity-dark", "22");
    window.localStorage.setItem("chisabot-sky-source", "hark");
    window.localStorage.setItem("chisabot-hark-scene", "6");
    window.localStorage.setItem("chisabot-sky", "off");
    window.localStorage.setItem(
      HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
      '{"place":"X"}',
    );

    await reloadAppearanceFromStorage();
    const cfg = getAppearanceConfig();
    expect(cfg).toEqual({
      v: 2,
      mode: "dark",
      theme: "sakura",
      customAccent: null,
      material: "clear",
      canvas: {
        kind: "sky",
        scene: "dusk",
        weather: { enabled: false, city: null },
      },
      staticBackground: false,
    });

    const saved = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved ?? "{}").v).toBe(2);
    for (const oldKey of LEGACY_APPEARANCE_STORAGE_KEYS) {
      expect(window.localStorage.getItem(oldKey)).toBeNull();
    }
  });
});

describe("全字段判脏、自定义强调色 AA 对比度与 DOM 根契约", () => {
  test("isDefaultAppearance 对所有字段精确判脏，resetAppearance 全部归零", () => {
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(true);

    setAppearanceMode("dark");
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(true);

    setTheme("celadon");
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();

    setCustomAccent("#ff6600");
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();

    setMaterial("clear");
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();

    setStaticBackground(true);
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();

    setCanvas({ kind: "pure" });
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();

    setSkyScene("night");
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();

    setSkyWeather({ enabled: true, city: "杭州" });
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();

    setWallpaperSource("waterlily-pond");
    setWallpaperAdjustments({ blur: 8, scrim: 45 });
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    resetAppearance();
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(true);
  });

  test("deriveCustomAccentVars 在极端强调色下均保证浅/深模式 WCAG AA >= 4.5:1", () => {
    const samples = [
      "#ffffff",
      "#000000",
      "#facc15",
      "#22c55e",
      "#94a3b8",
      "#4176e6",
      "#d4527e",
      "#7c3aed",
    ];
    for (const hex of samples) {
      const lightVars = deriveCustomAccentVars(hex, false);
      expect(contrastRatio(lightVars["--accent-ink"], "#eef2f7")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(lightVars["--accent-ink"], "#ffffff")).toBeGreaterThanOrEqual(4.5);

      const darkVars = deriveCustomAccentVars(hex, true);
      expect(contrastRatio(darkVars["--accent-ink"], "#1c222e")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darkVars["--accent-ink"], "#10141c")).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("DOM 根契约严格落位，壁纸变量仅写 #sky-root 不污染 <html>，绝不注入 #chisabot-glass-alpha", () => {
    const skyRoot = document.createElement("div");
    skyRoot.id = "sky-root";
    document.body.appendChild(skyRoot);

    setAppearanceConfig({
      mode: "dark",
      theme: "violet",
      customAccent: "#facc15",
      material: "clear",
      canvas: {
        kind: "wallpaper",
        source: "starry-rhone",
        blur: 12,
        scrim: 40,
      },
      staticBackground: true,
    });

    const root = document.documentElement;
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.getAttribute("data-theme")).toBe("violet");
    expect(root.getAttribute("data-material")).toBe("clear");
    expect(root.getAttribute("data-canvas")).toBe("wallpaper");
    expect(root.getAttribute("data-static-bg")).toBe("on");
    expect(root.getAttribute("data-theme-family")).toBeNull();
    expect(root.getAttribute("data-glass")).toBeNull();
    expect(document.getElementById("chisabot-glass-alpha")).toBeNull();

    // 自定义强调色写入 <html>，清空后立即移除
    for (const prop of CUSTOM_ACCENT_CSS_PROPS) {
      expect(root.style.getPropertyValue(prop)).not.toBe("");
    }
    // 壁纸微调变量严禁挂在 <html>，仅挂在 #sky-root
    expect(root.style.getPropertyValue("--canvas-blur")).toBe("");
    expect(root.style.getPropertyValue("--canvas-scrim")).toBe("");
    expect(skyRoot.style.getPropertyValue("--canvas-blur")).toBe("12px");
    expect(skyRoot.style.getPropertyValue("--canvas-scrim")).toBe("0.40");

    setCustomAccent(null);
    for (const prop of CUSTOM_ACCENT_CSS_PROPS) {
      expect(root.style.getPropertyValue(prop)).toBe("");
    }
    skyRoot.remove();
  });

  test("perf-mode 收编为 material === solid && staticBackground 薄代理", () => {
    expect(getPerfMode()).toBe(false);
    setPerfMode(true);
    expect(getPerfMode()).toBe(true);
    expect(getAppearanceConfig().material).toBe("solid");
    expect(getAppearanceConfig().staticBackground).toBe(true);
    expect(document.documentElement.getAttribute("data-perf")).toBe("on");

    setMaterial("glass");
    expect(getPerfMode()).toBe(false);
    expect(document.documentElement.getAttribute("data-perf")).toBeNull();
  });

  test("跨标签页 storage 事件同步 chisabot-appearance", async () => {
    const otherTab: AppearanceConfigV2 = {
      v: 2,
      mode: "light",
      theme: "amber",
      customAccent: null,
      material: "solid",
      canvas: { kind: "pure" },
      staticBackground: true,
    };
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(otherTab),
    );
    await syncAppearanceFromStorage(APPEARANCE_STORAGE_KEY);
    expect(getAppearanceConfig()).toEqual(otherTab);
    expect(document.documentElement.getAttribute("data-theme")).toBe("amber");
    expect(document.documentElement.getAttribute("data-material")).toBe(
      "solid",
    );
    expect(document.documentElement.getAttribute("data-canvas")).toBe("pure");
  });
});

describe("唯一首屏 appearanceBootScript()", () => {
  test("首帧同步写齐 .dark / data-theme / data-material / data-canvas / meta[theme-color] 且不写 localStorage", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#000000";
    document.head.appendChild(meta);

    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        v: 2,
        mode: "dark",
        theme: "sakura",
        customAccent: "#38bdf8",
        material: "clear",
        canvas: { kind: "pure" },
        staticBackground: true,
      } satisfies AppearanceConfigV2),
    );

    const runBoot = new Function(appearanceBootScript());
    runBoot();

    const root = document.documentElement;
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.getAttribute("data-theme")).toBe("sakura");
    expect(root.getAttribute("data-material")).toBe("clear");
    expect(root.getAttribute("data-canvas")).toBe("pure");
    expect(root.getAttribute("data-static-bg")).toBe("on");
    expect(root.getAttribute("data-sky")).toBe("off");
    expect(root.style.getPropertyValue("--accent")).toBe("#38bdf8");
    expect(meta.content).toBe("#22121b");
    // 不回写旧 chisabot-theme 键
    expect(window.localStorage.getItem("chisabot-theme")).toBeNull();
    meta.remove();
  });

  test("升级前仅存旧键时，首屏脚本即按无损规则生效零闪烁", () => {
    window.localStorage.setItem("chisabot-theme", "dark");
    window.localStorage.setItem("chisabot-theme-family-dark", "london");
    window.localStorage.setItem("chisabot.perf-mode", "on");
    window.localStorage.setItem("chisabot-sky-source", "theme");

    const runBoot = new Function(appearanceBootScript());
    runBoot();

    const root = document.documentElement;
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.getAttribute("data-theme")).toBe("mist");
    expect(root.getAttribute("data-material")).toBe("solid");
    expect(root.getAttribute("data-canvas")).toBe("pure");
    expect(root.getAttribute("data-static-bg")).toBe("on");
    expect(root.getAttribute("data-perf")).toBe("on");
  });
});

describe("动态天空 4 时刻映射、关闭天气严格 0 请求与三选一互斥画布", () => {
  test("4 个固定时刻精确映射到 SCENES[11/0/6/4]，浅/深模式下零静默错配", () => {
    const fixedCases: Array<["dawn" | "day" | "dusk" | "night", number]> = [
      ["dawn", 11],
      ["day", 0],
      ["dusk", 6],
      ["night", 4],
    ];
    for (const [scene, expectedIndex] of fixedCases) {
      const cfg: AppearanceConfigV2 = {
        ...DEFAULT_APPEARANCE_CONFIG,
        canvas: {
          kind: "sky",
          scene,
          weather: { enabled: false, city: null },
        },
      };
      // 浅色模式点静夜 -> 真实渲染静夜(4)，绝不偷换晨霞(11)
      expect(resolveSkyTarget(cfg, false)).toEqual({
        kind: "fixed",
        scene,
        harkIndex: expectedIndex,
      });
      // 深色模式点晴空 -> 真实渲染晴空(0)，绝不偷换夜空(4)
      expect(resolveSkyTarget(cfg, true)).toEqual({
        kind: "fixed",
        scene,
        harkIndex: expectedIndex,
      });
      expect(shouldFetchLiveWeather(cfg)).toBe(false);
    }
  });

  test("auto 随时间流动按浅色昼/晨昏与深色暮/星夜平滑演化", () => {
    expect(resolveAutoSkyHour(13, false)).toBe(13);
    expect(resolveAutoSkyHour(2, false)).toBeGreaterThanOrEqual(6);
    expect(resolveAutoSkyHour(2, false)).toBeLessThan(7);

    expect(resolveAutoSkyHour(23, true)).toBe(23);
    const darkNoon = resolveAutoSkyHour(12, true);
    expect(darkNoon >= 19 || darkNoon <= 5).toBe(true);
  });

  test("关闭实时天气、固定时刻或非天空画布时严格 0 Open-Meteo 网络请求", async () => {
    const fetchedUrls: string[] = [];
    const origFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      fetchedUrls.push(url);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof window.fetch;

    try {
      const harkFetch = createHarkFetch(() =>
        shouldFetchLiveWeather(getAppearanceConfig()),
      );

      // 1. 默认动态天空（auto + weather.enabled=false）-> 0 请求
      expect(shouldFetchLiveWeather(getAppearanceConfig())).toBe(false);
      await harkFetch(
        "https://api.open-meteo.com/v1/forecast?latitude=30&longitude=120",
      );
      await harkFetch(
        "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=30&longitude=120",
      );
      await harkFetch(
        "https://geocoding-api.open-meteo.com/v1/search?name=Beijing",
      );
      expect(fetchedUrls).toEqual([]);

      // 2. 固定时刻（如 night）-> 0 请求
      setSkyScene("night");
      expect(shouldFetchLiveWeather(getAppearanceConfig())).toBe(false);
      await harkFetch(
        "https://api.open-meteo.com/v1/forecast?latitude=52&longitude=13",
      );
      expect(fetchedUrls).toEqual([]);

      // 3. 净色画布 / 壁纸画布 -> 0 请求
      setCanvas({ kind: "pure" });
      await harkFetch("https://api.open-meteo.com/v1/forecast?latitude=1&longitude=1");
      setWallpaperSource("waterlily-pond");
      await harkFetch("https://api.open-meteo.com/v1/forecast?latitude=1&longitude=1");
      expect(fetchedUrls).toEqual([]);

      // 4. 开启实时天气（auto + weather.enabled=true）-> 正常请求 Open-Meteo
      setSkyWeather({ enabled: true, city: "上海" });
      expect(shouldFetchLiveWeather(getAppearanceConfig())).toBe(true);
      await harkFetch(
        "https://geocoding-api.open-meteo.com/v1/search?name=%E4%B8%8A%E6%B5%B7",
      );
      await harkFetch(
        "https://api.open-meteo.com/v1/forecast?latitude=31.23&longitude=121.47",
      );
      expect(fetchedUrls.length).toBe(2);
    } finally {
      window.fetch = origFetch;
    }
  });

  test("wallpaper_core.html 默认不自动请求天气且关闭天气不写 hark-wallpaper-v1", () => {
    const core = readFileSync(
      path.join(import.meta.dir, "../public/wallpaper_core.html"),
      "utf8",
    );
    expect(core).toContain("weatherEnabled: false");
    expect(core).toMatch(/function saveSnapshot\(\)\{\s*if \(!state\.weatherEnabled\) return;/);
    expect(core).toMatch(/async function fetchWeather\(reset\)\{\s*if \(!state\.weatherEnabled\) return;/);
    expect(core).toContain("setWeatherEnabled(enabled, city)");
    expect(core).toContain("applyFixedScene(i)");
    expect(core).toContain("setAutoTime(h, fade)");
  });

  test("SkyBackground 严格三选一互斥渲染：pure / wallpaper 不挂 WebGL，sky 不挂壁纸", () => {
    const origFetch = window.fetch;
    window.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof window.fetch;
    try {
      setCanvas({ kind: "pure" });
      const view = render(
        <ThemeProvider>
          <SkyBackground />
        </ThemeProvider>,
      );
      expect(view.container.querySelector("#sky-root")).not.toBeNull();
      expect(view.container.querySelector("canvas#gl")).toBeNull();
      expect(view.container.querySelector(".chisabot-wallpaper")).toBeNull();

      act(() => {
        setCanvas({
          kind: "wallpaper",
          source: "waterlily-pond",
          blur: 10,
          scrim: 45,
        });
      });
      expect(view.container.querySelector("canvas#gl")).toBeNull();
      expect(view.container.querySelector(".chisabot-wallpaper")).not.toBeNull();
      expect(view.container.querySelector(".chisabot-wallpaper-dim")).toBeNull();
      const skyRoot = view.container.querySelector("#sky-root") as HTMLElement;
      expect(skyRoot.style.getPropertyValue("--canvas-blur")).toBe("10px");
      expect(skyRoot.style.getPropertyValue("--canvas-scrim")).toBe("0.45");

      act(() => {
        setCanvas({
          kind: "sky",
          scene: "day",
          weather: { enabled: false, city: null },
        });
      });
      expect(view.container.querySelector("canvas#gl")).not.toBeNull();
      expect(view.container.querySelector(".chisabot-wallpaper")).toBeNull();
    } finally {
      window.fetch = origFetch;
    }
  });

  test("ThemeProvider 支持 mode / setMode / dark / setDark 并桥接 ChisaAndroid", () => {
    const calls: Array<string> = [];
    (
      window as Window & {
        ChisaAndroid?: {
          setTheme?: (m: string) => void;
          setThemeMode?: (m: string) => void;
        };
      }
    ).ChisaAndroid = {
      setTheme: (m) => calls.push(`setTheme:${m}`),
      setThemeMode: (m) => calls.push(`setThemeMode:${m}`),
    };

    let ctx: ReturnType<typeof useTheme> | null = null;
    function Probe() {
      ctx = useTheme();
      return (
        <span data-testid="probe">
          {ctx.mode}:{ctx.dark ? "dark" : "light"}
        </span>
      );
    }

    const view = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(view.getByTestId("probe").textContent).toBe("system:light");
    expect(calls).toContain("setThemeMode:system");

    act(() => {
      ctx?.setMode("dark");
    });
    expect(view.getByTestId("probe").textContent).toBe("dark:dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(calls).toContain("setTheme:dark");

    act(() => {
      ctx?.setDark(false);
    });
    expect(view.getByTestId("probe").textContent).toBe("light:light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    delete (window as Window & { ChisaAndroid?: unknown }).ChisaAndroid;
  });
});
