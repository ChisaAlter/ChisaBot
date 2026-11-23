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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

/**
 * V2 主题 / 画布 / 材质性能与架构守卫：
 *  1. 所有 `--surface-*` 均注册为 `@property { inherits: false }`，且 0 条仅命中 `<html>`/`:root` 的规则声明它们；
 *     壁纸滑块仅写 `#sky-root` 的 `--canvas-blur` / `--canvas-scrim`，绝不污染 `<html>`，不注入 `#chisabot-glass-alpha`；
 *  2. 地址栏 `<meta name="theme-color">` 跟随 7 套主题 × 浅/深色；
 *  3. 多标签页通过 `storage` 事件同步 `chisabot-appearance`、性能模式薄代理与 `ThemeProvider`；
 *  4. 系统「减少动态效果」立刻暂停天空循环；
 *  5. 唯一启动脚本 `appearanceBootScript()` 内联进 `index.html`，首帧挂齐所有 V2 根属性并兼容旧 16 键；
 *  6. 实色 + 静止动态背景统一收编性能模式（原 `PerfModePreference` 已移除），且性能模式停止头像呼吸/眨眼动画；
 *  7. 聊天浮动卡片、PC 窗口角托 `.win-ctrls` 与全站弹层均在 `materials.css` 统一管理（0 `!important`，0 90-97% 深色硬编码覆盖）。
 */
type Appearance = typeof import("../src/lib/appearance");
type Palette = typeof import("../src/lib/palette");
type Perf = typeof import("../src/lib/perf-mode");
type Sky = typeof import("../src/components/sky-background");
type Theme = typeof import("../src/components/theme-provider");
type AppearancePrefs =
  typeof import("../src/components/settings/appearance-preferences");

const srcDir = path.join(import.meta.dir, "../src");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const tokensCss = strip(
  readFileSync(path.join(srcDir, "styles/tokens.css"), "utf8"),
);
const canvasCss = strip(
  readFileSync(path.join(srcDir, "styles/canvas.css"), "utf8"),
);
const materialsCss = strip(
  readFileSync(path.join(srcDir, "styles/materials.css"), "utf8"),
);
const stylesCss = strip(readFileSync(path.join(srcDir, "styles.css"), "utf8"));
const perfNoBlurCss = strip(
  readFileSync(path.join(srcDir, "perf-noblur.css"), "utf8"),
);
const viteConfig = readFileSync(
  path.join(import.meta.dir, "../vite.config.ts"),
  "utf8",
);

let appearance: Appearance;
let palette: Palette;
let perf: Perf;
let sky: Sky;
let theme: Theme;
let appearancePrefs: AppearancePrefs;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  appearance = await import("../src/lib/appearance");
  palette = await import("../src/lib/palette");
  perf = await import("../src/lib/perf-mode");
  sky = await import("../src/components/sky-background");
  theme = await import("../src/components/theme-provider");
  appearancePrefs = await import(
    "../src/components/settings/appearance-preferences"
  );
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  window.localStorage.clear();
  appearance.resetAppearance();
  appearance.flushAppearanceWrites();
  window.localStorage.clear();
  await appearance.reloadAppearanceFromStorage();
});

afterEach(() => {
  cleanup();
  perf.setPerfMode(false);
  appearance.resetAppearance();
  appearance.flushAppearanceWrites();
  window.localStorage.clear();
  const root = document.documentElement;
  for (const name of [
    "data-theme",
    "data-material",
    "data-canvas",
    "data-static-bg",
    "data-perf",
    "data-sky",
    "data-sky-off",
    "data-sky-painted",
    "data-sky-ease",
    "data-theme-family",
    "data-glass",
    "data-wallpaper",
  ]) {
    root.removeAttribute(name);
  }
  root.classList.remove("dark");
  root.removeAttribute("style");
  document.body.innerHTML = "";
});

function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function innermostRules(text: string): Array<[string, string]> {
  const rules: Array<[string, string]> = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push([(m[1] ?? "").trim(), m[2] ?? ""]);
  }
  return rules;
}

const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => r()));

describe("1) --surface-* 严格不继承，滑块仅改 #sky-root 不触碰 <html>", () => {
  const SURFACE_PROPS = [
    "--surface-bg",
    "--surface-bg-solid",
    "--surface-blur",
    "--surface-border",
    "--surface-highlight",
    "--surface-shadow",
    "--surface-ink",
    "--surface-ink-2",
  ] as const;

  test("8 个 --surface-* 属性全部注册为 @property { inherits: false }", () => {
    for (const prop of SURFACE_PROPS) {
      expect(tokensCss).toMatch(
        new RegExp(`@property ${prop} \\{[^}]*inherits: false;`),
      );
    }
  });

  test("全站没有任何仅命中 <html> 或 :root 的规则声明 --surface-* 或 --canvas-blur/--canvas-scrim", () => {
    const combined = [tokensCss, canvasCss, materialsCss, stylesCss].join("\n");
    for (const [selector, body] of innermostRules(combined)) {
      if (
        !/--surface-(?:bg|bg-solid|blur|border|highlight|shadow|ink|ink-2)\s*:/.test(
          body,
        ) &&
        !/--canvas-(?:blur|scrim)\s*:/.test(body)
      ) {
        continue;
      }
      if (selector.startsWith("@property")) continue;
      for (const sel of splitSelectors(selector)) {
        expect(/^(:root|html(\S*))$/.test(sel)).toBe(false);
      }
    }
  });

  test("换材质只改 data-material 一个根属性，不写行内样式，绝不注入 #chisabot-glass-alpha", async () => {
    appearance.applyAppearanceToDocument();
    const root = document.documentElement;
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((list) => mutations.push(...list));
    mo.observe(root, { attributes: true });
    try {
      appearance.setMaterial("clear");
      appearance.setMaterial("clear");
      await Promise.resolve();
      expect(mutations.map((m) => m.attributeName)).toEqual(["data-material"]);
      expect(root.getAttribute("data-material")).toBe("clear");
      expect(document.getElementById("chisabot-glass-alpha")).toBeNull();
    } finally {
      mo.disconnect();
    }
  });

  test("拖壁纸模糊与薄幕滑块只写 #sky-root 行内变量，绝不触发 <html> 属性变更", async () => {
    const skyRoot = document.createElement("div");
    skyRoot.id = "sky-root";
    document.body.appendChild(skyRoot);

    appearance.setWallpaperSource("waterlily-pond");
    const root = document.documentElement;
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((list) => mutations.push(...list));
    mo.observe(root, { attributes: true });
    try {
      for (let v = 4; v <= 16; v += 2) {
        appearance.setWallpaperAdjustments({ blur: v, scrim: 20 + v });
      }
      await Promise.resolve();
      expect(mutations.map((m) => m.attributeName)).toEqual([]);
      expect(root.style.getPropertyValue("--canvas-blur")).toBe("");
      expect(root.style.getPropertyValue("--canvas-scrim")).toBe("");
      expect(skyRoot.style.getPropertyValue("--canvas-blur")).toBe("16px");
      expect(skyRoot.style.getPropertyValue("--canvas-scrim")).toBe("0.36");
    } finally {
      mo.disconnect();
    }
  });
});

describe("2) 地址栏颜色跟随 7 套主题 × 浅/深色", () => {
  test("7 套主题浅/深均有独立 hex themeColor，且主题间可区分", () => {
    expect(palette.THEMES).toHaveLength(7);
    for (const t of palette.THEMES) {
      expect(palette.themeMetaColor(t.id, false)).toMatch(/^#[0-9a-f]{6}$/);
      expect(palette.themeMetaColor(t.id, true)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(palette.themeMetaColor("sakura", false)).not.toBe(
      palette.themeMetaColor("sky", false),
    );
  });

  test("applyThemeColor 同步更新所有 meta[name=theme-color]", () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#9dbddc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0c1626" media="(prefers-color-scheme: dark)">';
    const color = palette.themeMetaColor("sakura", true);
    palette.applyThemeColor(color);
    const metas = [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ];
    expect(metas.map((m) => m.content)).toEqual([color, color]);
  });
});

describe("3) 多标签页同步", () => {
  function fireStorage(key: string | null, newValue: string | null) {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue,
        storageArea: window.localStorage,
      }),
    );
  }

  test("别的标签页修改 chisabot-appearance：本页状态与 DOM 跟着更新且不回写存储", async () => {
    appearance.installAppearanceStorageSync();
    const writes: string[] = [];
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (k: string, v: string) => {
      writes.push(k);
      original(k, v);
    };
    try {
      const remote = JSON.stringify({
        ...appearance.DEFAULT_APPEARANCE_CONFIG,
        theme: "sakura",
        material: "clear",
        canvas: { kind: "pure" },
      });
      original(appearance.APPEARANCE_STORAGE_KEY, remote);
      fireStorage(appearance.APPEARANCE_STORAGE_KEY, remote);

      const cfg = appearance.getAppearanceConfig();
      expect(cfg.theme).toBe("sakura");
      expect(cfg.material).toBe("clear");
      expect(cfg.canvas).toEqual({ kind: "pure" });
      expect(document.documentElement.getAttribute("data-theme")).toBe("sakura");
      expect(document.documentElement.getAttribute("data-material")).toBe(
        "clear",
      );
      expect(document.documentElement.getAttribute("data-canvas")).toBe("pure");

      await new Promise((r) =>
        setTimeout(r, appearance.SLIDER_WRITE_DELAY_MS + 40),
      );
      expect(writes).toEqual([]);
    } finally {
      window.localStorage.setItem = original;
    }
  });

  test("本页未落盘的滑块防抖写入会被远端 storage 同步作废，不会覆盖远端值", async () => {
    appearance.setWallpaperSource("waterlily-pond");
    appearance.setWallpaperAdjustments({ blur: 6, scrim: 25 });

    const remote = JSON.stringify({
      ...appearance.DEFAULT_APPEARANCE_CONFIG,
      canvas: {
        kind: "wallpaper",
        source: "waterlily-pond",
        blur: 18,
        scrim: 60,
      },
    });
    window.localStorage.setItem(appearance.APPEARANCE_STORAGE_KEY, remote);
    await appearance.syncAppearanceFromStorage(
      appearance.APPEARANCE_STORAGE_KEY,
    );
    await new Promise((r) =>
      setTimeout(r, appearance.SLIDER_WRITE_DELAY_MS + 50),
    );
    const cfg = appearance.getAppearanceConfig();
    expect(cfg.canvas).toEqual({
      kind: "wallpaper",
      source: "waterlily-pond",
      blur: 18,
      scrim: 60,
    });
  });

  test("无关存储键不触发外观订阅", async () => {
    let emitted = 0;
    const off = appearance.subscribeAppearance(() => {
      emitted += 1;
    });
    await appearance.syncAppearanceFromStorage("unrelated-key");
    off();
    expect(emitted).toBe(0);
  });

  test("性能模式薄代理与 ThemeProvider 均响应跨标签页 chisabot-appearance 同步", async () => {
    appearance.setAppearanceMode("light");
    function Probe() {
      const { dark, mode } = theme.useTheme();
      return (
        <span data-testid="probe">{`${mode}:${dark ? "dark" : "light"}`}</span>
      );
    }
    const view = render(
      <theme.ThemeProvider>
        <Probe />
      </theme.ThemeProvider>,
    );
    expect(view.getByTestId("probe").textContent).toBe("light:light");

    const remote = JSON.stringify({
      ...appearance.DEFAULT_APPEARANCE_CONFIG,
      mode: "dark",
      material: "solid",
      staticBackground: true,
    });
    await act(async () => {
      window.localStorage.setItem(appearance.APPEARANCE_STORAGE_KEY, remote);
      fireStorage(appearance.APPEARANCE_STORAGE_KEY, remote);
    });
    expect(view.getByTestId("probe").textContent).toBe("dark:dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(perf.getPerfMode()).toBe(true);
    expect(document.documentElement.getAttribute("data-perf")).toBe("on");
  });
});

describe("4) 减少动态效果与场景切换 INP 保护", () => {
  test("resolveSkyMode 在减少动效/静止背景下退回 snapshot，在壁纸/净色/perf 下为 off", () => {
    expect(
      sky.resolveSkyMode({
        perf: false,
        wallpaper: false,
        live: true,
        reducedMotion: true,
      }),
    ).toBe("snapshot");
    expect(
      sky.resolveSkyMode({
        perf: false,
        wallpaper: false,
        live: true,
        staticBackground: true,
      }),
    ).toBe("snapshot");
    expect(
      sky.resolveSkyMode({
        perf: false,
        wallpaper: false,
        live: true,
        reducedMotion: false,
      }),
    ).toBe("live");
    expect(
      sky.resolveSkyMode({
        perf: true,
        wallpaper: false,
        live: true,
        reducedMotion: false,
      }),
    ).toBe("off");
  });

  test("系统减少动态效果变化时 useReducedMotion 立即同步", async () => {
    const original = window.matchMedia;
    let matches = false;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes("reduce") ? matches : false;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    })) as unknown as typeof window.matchMedia;
    try {
      function Probe() {
        return (
          <span data-testid="rm">
            {sky.useReducedMotion() ? "reduce" : "full"}
          </span>
        );
      }
      const view = render(<Probe />);
      expect(view.getByTestId("rm").textContent).toBe("full");
      await act(async () => {
        matches = true;
        for (const l of listeners) l();
      });
      expect(view.getByTestId("rm").textContent).toBe("reduce");
    } finally {
      window.matchMedia = original;
    }
  });

  test("stopSkyMotionNow 清零唤醒窗口，切换天空时刻在下一帧同步给引擎（不阻塞点击）", async () => {
    sky.stopSkyMotionNow();
    expect(sky.readSkyThrottle().wakeUntil).toBe(0);

    const calls: number[] = [];
    const w = window as unknown as {
      hark?: { applyFixedScene?: (i: number) => void; setWeatherEnabled?: (b: boolean) => void };
      fetch: typeof window.fetch;
    };
    const originalFetch = w.fetch;
    w.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof window.fetch;
    w.hark = {
      applyFixedScene: (i) => calls.push(i),
      setWeatherEnabled: () => {},
    };
    try {
      render(
        <theme.ThemeProvider>
          <sky.SkyBackground />
        </theme.ThemeProvider>,
      );
      await act(async () => {
        await nextFrame();
        await new Promise((r) => setTimeout(r, 10));
      });
      const before = calls.length;
      act(() => {
        appearance.setSkyScene("dusk");
      });
      // 同步提交阶段不调用 WebGL applyFixedScene
      expect(calls.length).toBe(before);
      await act(async () => {
        await nextFrame();
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(calls.at(-1)).toBe(6);
      expect(calls.length).toBe(before + 1);
    } finally {
      delete w.hark;
      w.fetch = originalFetch;
    }
  });
});

describe("5) 唯一启动脚本 appearanceBootScript()", () => {
  function runBoot(stored: Record<string, string>) {
    window.localStorage.clear();
    for (const [k, v] of Object.entries(stored)) {
      window.localStorage.setItem(k, v);
    }
    const root = document.documentElement;
    root.className = "";
    root.removeAttribute("style");
    for (const attr of [
      "data-theme",
      "data-material",
      "data-canvas",
      "data-static-bg",
      "data-perf",
      "data-sky",
    ]) {
      root.removeAttribute(attr);
    }
    document.head.innerHTML =
      '<meta name="theme-color" content="#9dbddc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0c1626" media="(prefers-color-scheme: dark)">';
    new Function(palette.appearanceBootScript())();
  }

  test("vite.config.ts 仅内联唯一的 appearanceBootScript()", () => {
    expect(viteConfig).toContain("appearanceBootScript()");
    expect(viteConfig).not.toContain("familyBootScript()");
    expect(viteConfig).not.toContain("skyBootScript()");
  });

  test("V2 存储与未迁移旧 16 键均在首帧挂齐所有根属性与地址栏颜色", () => {
    runBoot({
      [palette.APPEARANCE_STORAGE_KEY]: JSON.stringify({
        v: 2,
        mode: "dark",
        theme: "sakura",
        customAccent: null,
        material: "clear",
        canvas: { kind: "pure" },
        staticBackground: false,
      }),
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("sakura");
    expect(document.documentElement.getAttribute("data-material")).toBe(
      "clear",
    );
    expect(document.documentElement.getAttribute("data-canvas")).toBe("pure");
    expect(document.documentElement.getAttribute("data-sky")).toBe("off");
    for (const m of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      expect(m.getAttribute("content")).toBe(
        palette.themeMetaColor("sakura", true),
      );
    }

    // 未迁移旧键直读兼容
    runBoot({
      "chisabot-theme": "light",
      "chisabot-theme-palette": "sakura",
      "chisabot-glass-style": "crystal",
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("sakura");
    expect(document.documentElement.getAttribute("data-material")).toBe(
      "clear",
    );
    expect(document.documentElement.getAttribute("data-canvas")).toBe("pure");
  });
});

describe("6) 实色 + 静止动态背景收编性能模式", () => {
  test("设置页外观内切实色材质 + 开启静止动态背景即激活 data-perf=on 并停动画", async () => {
    const view = render(
      <theme.ThemeProvider>
        <appearancePrefs.AppearancePreferences />
      </theme.ThemeProvider>,
    );
    expect(perf.getPerfMode()).toBe(false);
    await act(async () => {
      fireEvent.click(view.getByTestId("material-card-solid"));
      fireEvent.click(view.getByTestId("static-background-switch"));
    });
    expect(perf.getPerfMode()).toBe(true);
    expect(document.documentElement.getAttribute("data-material")).toBe(
      "solid",
    );
    expect(document.documentElement.getAttribute("data-static-bg")).toBe("on");
    expect(document.documentElement.getAttribute("data-perf")).toBe("on");

    // 头像动画在性能模式下停下
    expect(stylesCss).toMatch(
      /html\[data-perf="on"\] svg\.sa :is\(\.sa-body, \.sa-eyes, \.sa-open, \.sa-happy\) \{ animation: none; transition: none; \}/,
    );

    // 设置页已移除独立的 PerfModePreference，忙碌发送与隐私遮罩已迁出外观区块
    const page = readFileSync(
      path.join(srcDir, "routes/_authed/settings/index.tsx"),
      "utf8",
    );
    expect(page).not.toContain("PerfModePreference");
    expect(page).toContain('title={"对话与隐私"}');
    expect(page).toContain("<BusySendModePreference />");
    expect(page).toContain("<PrivacyMaskPreference />");
  });
});

describe("7) 聊天浮动面、PC 窗口角托与全站弹层统一走 materials.css 单通道（0 !important）", () => {
  const FLOATING = [
    ".cf-card",
    ".gh-card",
    ".page-card",
    ".schedule-card",
    ".bot-exchange-card",
    ".chat-question",
    ".chat-work-steps",
    ".chat-draft-card",
    ".chat-history-notice",
    ".chat-history-more",
    ".to-card",
    ".hr-card",
    ".win-ctrls",
    ".rs-capsule",
    ".chat-thinking",
  ];

  const OVERLAYS = [
    ".hk-drawer",
    '[data-slot="dropdown-menu-content"]',
    '[data-slot="dropdown-menu-sub-content"]',
    '[data-slot="context-menu-content"]',
    '[data-slot="context-menu-sub-content"]',
    '[data-slot="select-content"]',
    '[data-slot="popover-content"]',
    '[data-slot="combobox-content"]',
    '[data-slot="dialog-content"]:not(.bg-transparent)',
    '[data-slot="sheet-content"]',
    ".model-popover",
    ".perm-popover",
    ".context-popover",
    ".chat-spotlight-panel",
    ".live-panel-src-pop",
    ".rail-lib",
    ".bm-menu",
    ".bm-manager",
    ".glass-toast",
    ".page-loader-card",
    ".sg-savebar",
    ".auth-card",
    ".update-banner",
    ".install-hint",
  ];

  test("全部聊天浮动卡与 .win-ctrls 纳入 bubble 表面并覆盖 perf-noblur 降级", () => {
    for (const cls of FLOATING) {
      expect(materialsCss).toContain(cls);
      expect(perfNoBlurCss).toContain(cls);
    }
    expect(materialsCss).toMatch(
      /html \.win-ctrls\s*\{\s*border-width:\s*1\.25px;/,
    );
    expect(stylesCss).toMatch(
      /\.dark\s+\.win-ctrl\s*\{[^}]*--win-ctrl-shadow:\s*drop-shadow\(/,
    );
    expect(stylesCss).toMatch(
      /html:not\(\.dark\)\[data-canvas="wallpaper"\]\s+\.win-ctrl\s*\{[^}]*--win-ctrl-shadow:\s*drop-shadow\(/,
    );
    expect(stylesCss).toMatch(
      /\.win-ctrls\s+\.win-ctrl\.is-close:hover[\s\S]*--win-ctrl-shadow:\s*none;/,
    );
  });

  test("全部弹层与弹窗纳入 elevated 表面，且不再残留硬编码深色 90%-97% 实底覆盖", () => {
    for (const sel of OVERLAYS) {
      expect(materialsCss).toContain(sel);
      expect(perfNoBlurCss).toContain(sel);
    }
    for (const pat of [
      /\.dark\s+\.glass-pop\[data-slot="dropdown-menu-content"\]\s*\{[^}]*background:/,
      /\.dark\s+\.glass-drawer\[data-slot="sheet-content"\]\s*\{[^}]*background:/,
      /\.dark\s+\[data-slot="dialog-content"\]\s*\{[^}]*background:/,
      /\.dark\s+\.model-popover\s*\{[^}]*background:/,
      /\.dark\s+\.perm-popover\s*\{[^}]*background:/,
      /\.dark\s+\.rail-lib\s*\{[^}]*background:/,
      /\.dark\s+\.bm-menu/,
    ]) {
      expect(stylesCss).not.toMatch(pat);
    }
  });
});
