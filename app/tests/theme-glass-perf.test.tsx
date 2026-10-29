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
 * 模块 11 审计（主题 / 壁纸 / 玻璃，2026-10-29）：
 * 1. 改外观只让读玻璃变量的元素重算：--lg-* 不再挂在 <html> 上往下继承，滑块合并到每帧一次；
 * 2. 地址栏颜色（meta theme-color）跟随应用的深浅色和配色；
 * 3. 多标签页通过 storage 事件同步外观、深浅色、性能模式；
 * 4. 系统开了「减少动态效果」天空当帧停；
 * 5. 启动骨架用用户选的配色；
 * 8. 设置里有性能模式开关，性能模式也停掉头像表情动画。
 */
type Appearance = typeof import("../src/lib/appearance");
type Palette = typeof import("../src/lib/palette");
type Perf = typeof import("../src/lib/perf-mode");
type Sky = typeof import("../src/components/sky-background");
type Theme = typeof import("../src/components/theme-provider");
type PerfPref =
  typeof import("../src/components/settings/perf-mode-preference");

const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
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
let perfPref: PerfPref;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  appearance = await import("../src/lib/appearance");
  palette = await import("../src/lib/palette");
  perf = await import("../src/lib/perf-mode");
  sky = await import("../src/components/sky-background");
  theme = await import("../src/components/theme-provider");
  perfPref = await import("../src/components/settings/perf-mode-preference");
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  window.localStorage.clear();
  appearance.resetAppearanceDefaults();
  appearance.flushAppearanceWrites();
  appearance.flushGlassAlpha();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
});

const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => r()));

/** 按顶层逗号切选择器列表（括号里的逗号不切）。 */
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

/** 最里层的规则块（@media 里的也算）：[选择器, 声明]。 */
function innermostRules(text: string): Array<[string, string]> {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Array<[string, string]> = [];
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push([m[1].trim(), m[2]]);
  }
  return rules;
}

/** 选择器最后一个复合选择器（最后一个顶层空格 / > 之后），:is(...) 展开成列表。 */
function lastCompounds(selector: string): string[] {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && (ch === " " || ch === ">")) cut = i + 1;
  }
  const last = selector.slice(cut).trim();
  if (!last.startsWith(":is(")) return [last];
  // 只有整个复合选择器就是一个 :is(...) 时才展开（:is(...).border 这种不展开）。
  let d = 0;
  for (let i = 3; i < last.length; i++) {
    if (last[i] === "(") d++;
    if (last[i] === ")" && --d === 0) {
      return i === last.length - 1 ? splitSelectors(last.slice(4, i)) : [last];
    }
  }
  return [last];
}

function surfaceTokens(): string[] {
  const inner =
    /^:where\(([\s\S]*)\)$/.exec(appearance.GLASS_SURFACE_SELECTOR)?.[1] ?? "";
  return splitSelectors(inner);
}

describe("1) 玻璃变量只算在读它的元素上（不再整页重算）", () => {
  test("--lg-alpha / --lg-surface / --lg-surface-strong / --lg-blur / --lg-shadow 注册成不继承", () => {
    for (const name of [
      "--lg-alpha",
      "--lg-surface",
      "--lg-surface-strong",
      "--lg-blur",
      "--lg-shadow",
    ]) {
      expect(css).toMatch(
        new RegExp(`@property ${name} \\{[^}]*inherits: false;`),
      );
    }
  });

  test("没有任何一条只命中 <html> 的规则声明这些变量", () => {
    for (const [selector, body] of innermostRules(css)) {
      if (!/--lg-(alpha|surface|surface-strong|blur|shadow)\s*:/.test(body))
        continue;
      for (const sel of splitSelectors(selector)) {
        // 只命中根的选择器：:root、html…（后面没有后代组合符）
        expect(/^(:root|html(\S*))$/.test(sel)).toBe(false);
      }
    }
  });

  test("三档材质的 :where 名单和 appearance.ts 的 GLASS_SURFACE_SELECTOR 一致", () => {
    const tokens = surfaceTokens();
    expect(tokens.length).toBeGreaterThan(10);
    const declaring = innermostRules(css).filter(
      ([sel, body]) =>
        /^:where\(html/.test(sel) && /--lg-surface\s*:/.test(body),
    );
    expect(declaring.length).toBe(6);
    for (const [sel] of declaring) {
      const list = /\)\s*:where\(([\s\S]*)\)\s*$/.exec(sel)?.[1] ?? "";
      expect(splitSelectors(list).map((s) => s.replace(/\s+/g, " "))).toEqual(
        tokens,
      );
    }
  });

  test("每条读玻璃变量的规则，它命中的元素都在名单里（不继承之后，读的元素自己必须有声明）", () => {
    const tokenTails = surfaceTokens().map((t) => lastCompounds(t)[0]);
    for (const [selector, body] of innermostRules(css)) {
      if (!/var\(--lg-(surface|surface-strong|blur|shadow)\b/.test(body))
        continue;
      for (const sel of splitSelectors(selector)) {
        for (const compound of lastCompounds(sel)) {
          const covered = tokenTails.some((tail) => compound.includes(tail));
          if (!covered) throw new Error(`读玻璃变量但不在名单里：${sel}`);
        }
      }
    }
  });

  test("渲染预算里给气泡关模糊的规则直接写在气泡内容上（不继承之后写在外层不再生效）", () => {
    expect(css).toContain(
      '.glass-main :where([data-slot="bubble"] > [data-slot="bubble-content"]),\n.jr-card,',
    );
  });

  test("拖滑块不改 <html>：只改 #chisabot-glass-alpha 那条规则，一帧最多写一次", async () => {
    appearance.applyAppearanceToDocument();
    const root = document.documentElement;
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((list) => mutations.push(...list));
    mo.observe(root, { attributes: true });
    const before = appearance.readGlassAlpha();
    expect(before).toBe("0.16");

    for (let v = 17; v <= 36; v++) appearance.setGlassOpacity(v);
    // 状态每一步都立即更新（滑块数字跟手），样式合并到下一帧
    expect(appearance.getAppearanceState().glassOpacity).toBe(36);
    expect(appearance.readGlassAlpha()).toBe("0.16");
    await nextFrame();
    expect(appearance.readGlassAlpha()).toBe("0.36");

    await Promise.resolve();
    mo.disconnect();
    expect(mutations.filter((m) => m.target === root)).toEqual([]);
    expect(root.style.getPropertyValue("--lg-alpha")).toBe("");
    expect(
      document.querySelectorAll(`#${appearance.GLASS_ALPHA_STYLE_ID}`).length,
    ).toBe(1);
  });

  test("换材质只改 data-glass 一个属性，不写行内样式", async () => {
    appearance.applyAppearanceToDocument();
    const root = document.documentElement;
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((list) => mutations.push(...list));
    mo.observe(root, { attributes: true });
    appearance.setGlassStyle("crystal");
    appearance.setGlassStyle("crystal");
    await Promise.resolve();
    mo.disconnect();
    expect(mutations.map((m) => m.attributeName)).toEqual(["data-glass"]);
    expect(root.getAttribute("data-glass")).toBe("crystal");
  });
});

describe("2) 地址栏颜色跟随应用主题", () => {
  test("默认配色用固定的两色，别的配色取天空顶部颜色", () => {
    expect(palette.paletteThemeColor("default", false)).toBe("#9dbddc");
    expect(palette.paletteThemeColor("default", true)).toBe("#0c1626");
    for (const p of palette.THEME_PALETTES) {
      for (const dark of [false, true]) {
        expect(palette.paletteThemeColor(p.id, dark)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    expect(palette.paletteThemeColor("sakura", false)).not.toBe(
      palette.paletteThemeColor("aurora", false),
    );
  });

  test("两条按系统配色分的 meta 都改成应用的颜色", () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#9dbddc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0c1626" media="(prefers-color-scheme: dark)">';
    palette.applyThemeColor(palette.paletteThemeColor("sakura", true));
    const metas = [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ];
    expect(metas.map((m) => m.content)).toEqual([
      palette.paletteThemeColor("sakura", true),
      palette.paletteThemeColor("sakura", true),
    ]);
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

  test("别的标签页换配色 / 材质 / 雾度：这边状态和页面跟着变，不写回存储", async () => {
    appearance.installAppearanceStorageSync();
    const writes: string[] = [];
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (k: string, v: string) => {
      writes.push(k);
      original(k, v);
    };
    try {
      original(appearance.PALETTE_STORAGE_KEY, "aurora");
      fireStorage(appearance.PALETTE_STORAGE_KEY, "aurora");
      original(appearance.GLASS_STYLE_STORAGE_KEY, "frosted");
      fireStorage(appearance.GLASS_STYLE_STORAGE_KEY, "frosted");
      original(appearance.GLASS_OPACITY_STORAGE_KEY, "30");
      fireStorage(appearance.GLASS_OPACITY_STORAGE_KEY, "30");
      const state = appearance.getAppearanceState();
      expect(state.palette).toBe("aurora");
      expect(state.glassStyle).toBe("frosted");
      expect(state.glassOpacity).toBe(30);
      expect(document.documentElement.getAttribute("data-palette")).toBe(
        "aurora",
      );
      expect(document.documentElement.getAttribute("data-glass")).toBe(
        "frosted",
      );
      expect(appearance.readGlassAlpha()).toBe("0.30");
      await new Promise((r) =>
        setTimeout(r, appearance.SLIDER_WRITE_DELAY_MS + 50),
      );
      expect(writes).toEqual([]);
    } finally {
      window.localStorage.setItem = original;
    }
  });

  test("这边还没写出的同一个滑块值作废，不会在 200ms 后把对方的值盖回去", async () => {
    appearance.setGlassOpacity(12);
    window.localStorage.setItem(appearance.GLASS_OPACITY_STORAGE_KEY, "40");
    await appearance.syncAppearanceFromStorage(
      appearance.GLASS_OPACITY_STORAGE_KEY,
    );
    await new Promise((r) =>
      setTimeout(r, appearance.SLIDER_WRITE_DELAY_MS + 50),
    );
    expect(
      window.localStorage.getItem(appearance.GLASS_OPACITY_STORAGE_KEY),
    ).toBe("40");
    expect(appearance.getAppearanceState().glassOpacity).toBe(40);
  });

  test("无关的键不处理", async () => {
    let emitted = 0;
    const off = appearance.subscribeAppearance(() => emitted++);
    await appearance.syncAppearanceFromStorage("something-else");
    off();
    expect(emitted).toBe(0);
  });

  test("性能模式跟着别的标签页开关", () => {
    perf.setPerfMode(false);
    window.localStorage.setItem(perf.PERF_MODE_STORAGE_KEY, "on");
    perf.syncPerfModeFromStorage(perf.PERF_MODE_STORAGE_KEY);
    expect(perf.getPerfMode()).toBe(true);
    expect(document.documentElement.getAttribute("data-perf")).toBe("on");
    window.localStorage.setItem(perf.PERF_MODE_STORAGE_KEY, "off");
    perf.syncPerfModeFromStorage(perf.PERF_MODE_STORAGE_KEY);
    expect(perf.getPerfMode()).toBe(false);
    expect(document.documentElement.hasAttribute("data-perf")).toBe(false);
  });

  test("深浅色跟着别的标签页切", async () => {
    window.localStorage.setItem("chisabot-theme", "light");
    function Probe() {
      const { dark } = theme.useTheme();
      return <span data-testid="dark">{dark ? "dark" : "light"}</span>;
    }
    const view = render(
      <theme.ThemeProvider>
        <Probe />
      </theme.ThemeProvider>,
    );
    expect(view.getByTestId("dark").textContent).toBe("light");
    await act(async () => {
      window.localStorage.setItem("chisabot-theme", "dark");
      fireStorage("chisabot-theme", "dark");
    });
    expect(view.getByTestId("dark").textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("4) 减少动态效果：天空当帧停", () => {
  test("动态天空在减少动态效果下退回快照，性能模式 / 壁纸下关闭", () => {
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

  test("系统设置一变，useReducedMotion 立刻跟着变（不用等重新渲染）", async () => {
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

  test("stopSkyMotionNow 把天空的唤醒窗口清零（不再画完剩下的 2.6s）", () => {
    sky.stopSkyMotionNow();
    expect(sky.readSkyThrottle().wakeUntil).toBe(0);
  });
});

describe("1b) 换配色：天空换场景等点击先上屏", () => {
  test("切配色时不在点击的任务里同步 applyScene（引擎会当场画一帧），下一帧之后才换", async () => {
    const calls: number[] = [];
    const w = window as unknown as {
      hark?: { applyScene?: (i: number) => void };
      fetch: typeof window.fetch;
    };
    const originalFetch = w.fetch;
    w.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof window.fetch;
    w.hark = { applyScene: (i) => calls.push(i) };
    try {
      render(
        <theme.ThemeProvider>
          <sky.SkyBackground />
        </theme.ThemeProvider>,
      );
      await act(async () => {
        await nextFrame();
        await new Promise((r) => setTimeout(r, 5));
      });
      const scene = () =>
        appearance.resolveEffectiveHarkScene(
          appearance.getAppearanceState(),
          document.documentElement.classList.contains("dark"),
        );
      const before = calls.length;
      act(() => {
        appearance.setThemePalette("sakura");
      });
      // 同步提交（含 effect）结束时还没换场景。
      expect(calls.length).toBe(before);
      await act(async () => {
        await nextFrame();
        await new Promise((r) => setTimeout(r, 5));
      });
      expect(calls.at(-1)).toBe(scene() as number);
      expect(calls.length).toBe(before + 1);
    } finally {
      delete w.hark;
      w.fetch = originalFetch;
    }
  });
});

describe("5) 启动骨架用用户选的配色", () => {
  function runBoot(stored: Record<string, string>, dark: boolean) {
    window.localStorage.clear();
    for (const [k, v] of Object.entries(stored))
      window.localStorage.setItem(k, v);
    const root = document.documentElement;
    root.removeAttribute("data-palette");
    root.removeAttribute("data-glass");
    root.classList.toggle("dark", dark);
    document.body.removeAttribute("style");
    document.head.innerHTML =
      '<meta name="theme-color" content="#9dbddc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0c1626" media="(prefers-color-scheme: dark)">';
    new Function(palette.paletteBootScript())();
  }

  test("vite 插件把配色启动脚本内联进 index.html", () => {
    expect(viteConfig).toContain("paletteBootScript()");
  });

  test("非默认配色：根上写 data-palette，body 写和应用同样的天空颜色，地址栏同色", () => {
    runBoot(
      {
        [palette.PALETTE_STORAGE_KEY]: "sakura",
        [palette.GLASS_STYLE_STORAGE_KEY]: "crystal",
      },
      true,
    );
    const expected = palette.computePaletteSky("sakura", true)?.body ?? {};
    expect(document.documentElement.getAttribute("data-palette")).toBe(
      "sakura",
    );
    expect(document.documentElement.getAttribute("data-glass")).toBe("crystal");
    for (const [k, v] of Object.entries(expected)) {
      expect(document.body.style.getPropertyValue(k)).toBe(v);
    }
    for (const m of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      expect(m.getAttribute("content")).toBe(
        palette.paletteThemeColor("sakura", true),
      );
    }
  });

  test("默认配色或存的值不认识：不改天空，只按应用深浅色写地址栏颜色", () => {
    runBoot(
      {
        [palette.PALETTE_STORAGE_KEY]: "nope",
        [palette.GLASS_STYLE_STORAGE_KEY]: "bogus",
      },
      false,
    );
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
    expect(document.documentElement.hasAttribute("data-glass")).toBe(false);
    expect(document.body.style.getPropertyValue("--sky-1")).toBe("");
    for (const m of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      expect(m.getAttribute("content")).toBe("#9dbddc");
    }
    document.documentElement.classList.remove("dark");
  });
});

describe("8) 性能模式入口", () => {
  test("设置里的开关打开 / 关闭性能模式并保存", async () => {
    perf.setPerfMode(false);
    const view = render(<perfPref.PerfModePreference />);
    const sw = view.getByRole("switch", { name: "性能模式" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(perf.getPerfMode()).toBe(true);
    expect(document.documentElement.getAttribute("data-perf")).toBe("on");
    expect(window.localStorage.getItem(perf.PERF_MODE_STORAGE_KEY)).toBe("on");
    expect(
      view
        .getByRole("switch", { name: "性能模式" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await act(async () => {
      fireEvent.click(view.getByRole("switch", { name: "性能模式" }));
    });
    expect(perf.getPerfMode()).toBe(false);
  });

  test("性能模式下头像表情动画（呼吸、眨眼……）停下", () => {
    expect(css).toMatch(
      /html\[data-perf="on"\] \.sa\[data-mood\] :is\(\.sa-body, \.sa-eyes, \.sa-open\) \{ animation: none; \}/,
    );
  });

  test("设置页通用 › 外观里挂着这个开关", () => {
    const page = readFileSync(
      path.join(import.meta.dir, "../src/routes/_authed/settings/index.tsx"),
      "utf8",
    );
    expect(page).toContain("<PerfModePreference />");
  });
});
