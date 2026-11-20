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
  /*
   * 共享进程里后面的文件（wallpaper-loading 等）接着用这个 documentElement、这份 localStorage 和
   * perf / appearance 的模块状态：用例里写过的 data-perf、data-theme-family、data-glass、dark、
   * body 的天空色都要收干净，不然「退回天空」之类的断言拿到的还是这摊剩局。
   */
  perf.setPerfMode(false);
  appearance.resetAppearanceDefaults();
  appearance.flushAppearanceWrites();
  appearance.flushGlassAlpha();
  // 天空的模块级 mode 也收回去：留着 "off" 的话，后面文件里第一次 setSkyMode("off") 会被当成
  // 没变而跳过，data-sky-off 就不会再写（wallpaper-loading 的「退回天空」断言就栽在这）。
  sky.__skyLoopForTestOnly.setMode("snapshot");
  window.localStorage.clear();
  const root = document.documentElement;
  for (const name of [
    "data-theme-family",
    "data-glass",
    "data-perf",
    "data-theme",
    "data-wallpaper",
    "data-sky-painted",
    "data-sky-ease",
  ]) {
    root.removeAttribute(name);
  }
  root.classList.remove("dark");
  document.body.removeAttribute("style");
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

  test("四档材质的 :where 名单和 appearance.ts 的 GLASS_SURFACE_SELECTOR 一致", () => {
    const tokens = surfaceTokens();
    expect(tokens.length).toBeGreaterThan(10);
    const declaring = innermostRules(css).filter(
      ([sel, body]) =>
        /^:where\(html/.test(sel) && /--lg-surface\s*:/.test(body),
    );
    expect(declaring.length).toBe(8);
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

  test("渲染预算只关闭裸代码块气泡的模糊，普通 AI 气泡与侧栏共用磨砂模糊", () => {
    expect(css).toContain(
      '.glass-main .chat-bubbles [data-slot="bubble"].chat-bubble-bare > [data-slot="bubble-content"],',
    );
    expect(css).not.toContain(
      '.glass-main :where([data-slot="bubble"] > [data-slot="bubble-content"])',
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

  test("薄幕值变化仍立即生效，同值重新应用不触发根样式变更", async () => {
    appearance.applyAppearanceToDocument();
    const root = document.documentElement;
    appearance.setWallpaperScrim(42);
    expect(root.style.getPropertyValue("--wallpaper-scrim-alpha")).toBe("0.42");
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((list) => mutations.push(...list));
    mo.observe(root, { attributes: true });
    try {
      appearance.setWallpaperScrim(42);
      appearance.applyAppearanceToDocument();
      await Promise.resolve();
      expect(mutations).toEqual([]);
    } finally {
      mo.disconnect();
    }
  });
});

describe("2) 地址栏颜色跟随应用主题", () => {
  test("每个主题族的地址栏颜色都取 seed 天空顶部段，族间不同", () => {
    for (const f of palette.THEME_FAMILIES) {
      for (const dark of [false, true]) {
        expect(palette.familyThemeColor(dark ? f.dark : f.light, dark)).toMatch(
          /^#[0-9a-f]{6}$/,
        );
      }
    }
    const sakura = palette.THEME_FAMILIES.find((f) => f.id === "sakura");
    const azure = palette.THEME_FAMILIES.find((f) => f.id === "azure");
    expect(sakura).toBeTruthy();
    expect(azure).toBeTruthy();
    expect(palette.familyThemeColor(sakura!.light, false)).not.toBe(
      palette.familyThemeColor(azure!.light, false),
    );
  });

  test("两条按系统配色分的 meta 都改成应用的颜色", () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#9dbddc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0c1626" media="(prefers-color-scheme: dark)">';
    const sakura = palette.THEME_FAMILIES.find((f) => f.id === "sakura");
    const color = palette.familyThemeColor(sakura!.dark, true);
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

  test("别的标签页换主题族 / 材质 / 雾度：这边状态和页面跟着变，不写回存储", async () => {
    appearance.installAppearanceStorageSync();
    const writes: string[] = [];
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (k: string, v: string) => {
      writes.push(k);
      original(k, v);
    };
    try {
      original(appearance.FAMILY_LIGHT_STORAGE_KEY, "sakura");
      fireStorage(appearance.FAMILY_LIGHT_STORAGE_KEY, "sakura");
      original(appearance.GLASS_STYLE_STORAGE_KEY, "frosted");
      fireStorage(appearance.GLASS_STYLE_STORAGE_KEY, "frosted");
      original(appearance.GLASS_OPACITY_STORAGE_KEY, "30");
      fireStorage(appearance.GLASS_OPACITY_STORAGE_KEY, "30");
      const state = appearance.getAppearanceState();
      expect(state.familyLight).toBe("sakura");
      expect(state.familyDark).toBe("azure");
      expect(state.glassStyle).toBe("frosted");
      expect(state.glassOpacity).toBe(30);
      expect(document.documentElement.getAttribute("data-theme-family")).toBe(
        "sakura",
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
        appearance.setThemeHalf("light", "sakura");
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

describe("5) 启动骨架用用户选的主题族", () => {
  function runBoot(stored: Record<string, string>, dark: boolean) {
    window.localStorage.clear();
    for (const [k, v] of Object.entries(stored))
      window.localStorage.setItem(k, v);
    const root = document.documentElement;
    root.removeAttribute("data-theme-family");
    root.removeAttribute("data-glass");
    root.classList.toggle("dark", dark);
    document.body.removeAttribute("style");
    document.head.innerHTML =
      '<meta name="theme-color" content="#9dbddc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0c1626" media="(prefers-color-scheme: dark)">';
    new Function(palette.familyBootScript())();
  }

  test("vite 插件把主题族启动脚本内联进 index.html", () => {
    expect(viteConfig).toContain("familyBootScript()");
  });

  test("非默认族：根上写 data-theme-family，body 写和应用同样的派生变量，地址栏同色", () => {
    runBoot(
      {
        [palette.FAMILY_DARK_STORAGE_KEY]: "sakura",
        [palette.GLASS_STYLE_STORAGE_KEY]: "crystal",
      },
      true,
    );
    const sakura = palette.THEME_FAMILIES.find((f) => f.id === "sakura");
    const expected = palette.deriveSeed(sakura!.dark, true);
    expect(document.documentElement.getAttribute("data-theme-family")).toBe(
      "sakura",
    );
    expect(document.documentElement.getAttribute("data-glass")).toBe("crystal");
    for (const [k, v] of Object.entries(expected.body)) {
      expect(document.body.style.getPropertyValue(k)).toBe(v);
    }
    for (const m of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      expect(m.getAttribute("content")).toBe(
        palette.familyThemeColor(sakura!.dark, true),
      );
    }
  });

  test("存的值不认识或什么都没存：族回落 azure 照常派生，玻璃按「存过外观就是老用户」回落", () => {
    // 只存了个不认识的材质、别的外观都没存过：新用户 → mist。
    runBoot({ [palette.GLASS_STYLE_STORAGE_KEY]: "bogus" }, false);
    expect(document.documentElement.getAttribute("data-glass")).toBe("mist");
    expect(document.documentElement.getAttribute("data-theme-family")).toBe(
      "azure",
    );
    // 存过族键（哪怕值不认识）：算存过外观的老用户 → 0.1.155 起统一回落 mist；
    // 族解析不到仍落 azure，派生变量与地址栏颜色照常写。
    runBoot(
      {
        [palette.FAMILY_LIGHT_STORAGE_KEY]: "nope",
        [palette.GLASS_STYLE_STORAGE_KEY]: "bogus",
      },
      false,
    );
    expect(document.documentElement.getAttribute("data-theme-family")).toBe(
      "azure",
    );
    expect(document.documentElement.getAttribute("data-glass")).toBe("mist");
    const azure = palette.THEME_FAMILIES.find((f) => f.id === "azure");
    const expected = palette.deriveSeed(azure!.light, false);
    expect(document.body.style.getPropertyValue("--sky-1")).toBe(
      expected.body["--sky-1"],
    );
    for (const m of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      expect(m.getAttribute("content")).toBe(
        palette.familyThemeColor(azure!.light, false),
      );
    }
    document.documentElement.classList.remove("dark");
  });

  test("旧 palette 键一次性迁移：老存档 sakura → 落樱族", () => {
    runBoot({ [palette.PALETTE_STORAGE_KEY]: "sakura" }, false);
    expect(document.documentElement.getAttribute("data-theme-family")).toBe(
      "sakura",
    );
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
      /html\[data-perf="on"\] svg\.sa :is\(\.sa-body, \.sa-eyes, \.sa-open, \.sa-happy\) \{ animation: none; transition: none; \}/,
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

describe("9) 聊天浮动面与窗口按钮进玻璃面名单（不再吃 .glass-shell 薄纱）", () => {
  /** 直接浮在壁纸上的卡与胶囊：确认卡、页面/定时/网关/提问卡、干活步骤、草稿/历史提示、
   * 工具结果核对、交接恢复、状态/干活胶囊、「显示更早」、PC 窗口按钮。 */
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
    ".rs-capsule",
    ".chat-thinking",
  ];
  test("全部在 GLASS_SURFACE_SELECTOR 里（拿得到 --lg-* 变量与深釉翻墨）", () => {
    for (const cls of FLOATING) {
      expect(appearance.GLASS_SURFACE_SELECTOR).toContain(cls);
    }
  });
  test("各自有规则把底画成 --lg-surface-strong（含不带模糊的胶囊组）", () => {
    const rules = [
      ...css.matchAll(
        /:is\(([^)]*)\)\s*\{\s*background: var\(--pal-tint-layer,\) var\(--lg-surface-strong\)/g,
      ),
    ];
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const cls of FLOATING) {
      expect(rules.some(([, list]) => list.includes(cls))).toBe(true);
    }
  });
});

describe("10) 窗口按钮条不进材质画底名单（回归门）", () => {
  test(".win-ctrls 不出现在任何 --lg-* 画底规则的选择器里", () => {
    const rules = [
      ...css.matchAll(
        /([^{}]+)\{\s*background: var\(--pal-tint-layer,\) var\(--lg-surface/g,
      ),
    ];
    expect(rules.length).toBeGreaterThan(0);
    for (const [sel] of rules) {
      expect(sel).not.toContain(".win-ctrls");
    }
  });
});

describe("11) 全站弹窗、菜单、抽屉与浮层统一跟随玻璃效果与深浅色设置（§147）", () => {
  const OVERLAYS = [
    ".hk-drawer",
    '[data-slot="dropdown-menu-content"]',
    '[data-slot="dropdown-menu-sub-content"]',
    '[data-slot="context-menu-content"]',
    '[data-slot="context-menu-sub-content"]',
    '[data-slot="select-content"]',
    '[data-slot="popover-content"]',
    '[data-slot="combobox-content"]',
    '[data-slot="dialog-content"]',
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

  test("全部弹层与弹窗纳入 GLASS_SURFACE_SELECTOR 与主玻璃面画底规则（透明灯箱 dialog 除外）", () => {
    const surfaceRules = [
      ...css.matchAll(
        /([^{}]+)\{\s*background: var\(--pal-tint-layer,\) var\(--lg-surface\) !important;/g,
      ),
    ];
    const combined = surfaceRules.map((m) => m[1]).join(" ");
    expect(surfaceRules.length).toBeGreaterThanOrEqual(2);
    for (const sel of OVERLAYS) {
      expect(appearance.GLASS_SURFACE_SELECTOR).toContain(sel);
      expect(combined).toContain(sel);
    }
    expect(combined).toContain(
      '[data-slot="dialog-content"]:not(.bg-transparent)',
    );
  });

  test("不再残留硬编码深色 90%–97% 实底覆盖（菜单 / 弹窗 / 抽屉 / 模型与权限弹层 / 面板库 / 书签）", () => {
    for (const pat of [
      /\.dark\s+\.glass-pop\[data-slot="dropdown-menu-content"\]\s*\{[^}]*background:/,
      /\.dark\s+\.glass-drawer\[data-slot="sheet-content"\]\s*\{[^}]*background:/,
      /\.dark\s+\[data-slot="dialog-content"\]\s*\{[^}]*background:/,
      /\.dark\s+\.model-popover\s*\{[^}]*background:/,
      /\.dark\s+\.perm-popover\s*\{[^}]*background:/,
      /\.dark\s+\.rail-lib\s*\{[^}]*background:/,
      /\.dark\s+\.bm-menu/,
    ]) {
      expect(css).not.toMatch(pat);
    }
  });

  test("暗色弹窗遮罩维持轻薄压暗（alpha <= 0.28），避免把半透明磨砂弹窗压成深蓝实底", () => {
    const match = css.match(
      /\.dark\s+\[data-slot="dialog-overlay"\]\s*\{\s*background:\s*rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(0.28);
  });
});
