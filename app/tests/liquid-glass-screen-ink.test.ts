/**
 * 液态玻璃下线与纯 CSS 材质门禁（路径由 AGENTS.md §7 与 docs-truth-guards.test.ts 锁定）：
 *  1. 重型液态玻璃 SVG 位移透镜与 JS 光栅采样已彻底下线（无 `liquid-glass.ts` / `sky-snapshot.ts` /
 *     `data-lg-lens` / `data-lg-ink` / `chisabot-lg-lens` / `chisabot-glass-alpha` 残留）；
 *  2. 全材质（glass / clear / solid）纯 CSS 驱动，DOM 变更与滚动期间零 `getBoundingClientRect` 扫描、零 JS 空转；
 *  3. 光学字缘保护与对比度防线：仅单层轻影 `0 1px 1px` 护读裸露文字，气泡/卡片/代码块/控件严格 `text-shadow: none`。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

const srcDir = path.join(import.meta.dir, "../src");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(?:tsx?|css|html)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("1) 重型液态玻璃 SVG 透镜与 JS 光栅采样已彻底下线", () => {
  test("已删除 app/src/lib/liquid-glass.ts 与 app/src/lib/sky-snapshot.ts", () => {
    expect(existsSync(path.join(srcDir, "lib/liquid-glass.ts"))).toBe(false);
    expect(existsSync(path.join(srcDir, "lib/sky-snapshot.ts"))).toBe(false);
  });

  test("app/src 全目录无 liquid-glass / sky-snapshot / data-lg-lens / data-lg-ink 等历史残留", () => {
    const files = listSourceFiles(srcDir);
    const forbidden: Array<{ name: string; pattern: RegExp }> = [
      { name: "liquid-glass import", pattern: /lib\/liquid-glass/ },
      { name: "sky-snapshot import", pattern: /lib\/sky-snapshot/ },
      { name: "installLiquidGlass", pattern: /\binstallLiquidGlass\b/ },
      { name: "captureSkySnapshot", pattern: /\bcaptureSkySnapshot\b/ },
      { name: "data-lg-lens", pattern: /data-lg-lens/ },
      { name: "data-lg-ink", pattern: /data-lg-ink/ },
      { name: "chisabot-lg-lens", pattern: /chisabot-lg-lens/ },
      { name: "chisabot-lg-ink", pattern: /chisabot-lg-ink/ },
      { name: "--lg-lens-url", pattern: /--lg-lens-url/ },
      { name: "--lg-aa-boost", pattern: /--lg-aa-boost/ },
      { name: "--lg-density-k", pattern: /--lg-density-k/ },
      { name: "feDisplacementMap", pattern: /feDisplacementMap/ },
    ];

    const hits: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcDir, file).replace(/\\/g, "/");
      const content = stripComments(readFileSync(file, "utf8"));
      for (const { name, pattern } of forbidden) {
        if (pattern.test(content)) {
          hits.push(`${rel}: ${name}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("materials.css 仅声明 3 档纯 CSS 材质（glass / clear / solid），无 SVG 滤镜或 liquid 材质分支", () => {
    const materialsCss = stripComments(
      readFileSync(path.join(srcDir, "styles/materials.css"), "utf8"),
    );
    expect(materialsCss).toContain('html[data-material="glass"]');
    expect(materialsCss).toContain('html[data-material="clear"]');
    expect(materialsCss).toContain('html[data-material="solid"]');
    expect(materialsCss).not.toContain('data-glass="liquid"');
    expect(materialsCss).not.toContain('data-material="liquid"');
    expect(materialsCss).not.toMatch(/backdrop-filter\s*:[^;]*url\(/);
  });
});

describe("2) 全材质零 JS 光栅采样与零空转", () => {
  type Appearance = typeof import("../src/lib/appearance");
  let appearance: Appearance;

  beforeAll(async () => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    appearance = await import("../src/lib/appearance");
  });

  afterAll(async () => {
    await settleReactWork();
    await GlobalRegistrator.unregister();
  });

  beforeEach(() => {
    window.localStorage.clear();
    appearance.resetAppearance();
    appearance.flushAppearanceWrites();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    appearance.resetAppearance();
    appearance.flushAppearanceWrites();
    document.body.innerHTML = "";
  });

  test("glass / clear / solid 三档材质在切换、插入消息与滚动时零 getBoundingClientRect 扫描且零透镜/动态样式注入", async () => {
    let rectReads = 0;
    const origRect = Element.prototype.getBoundingClientRect;
    const origDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "getBoundingClientRect",
    );
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value(this: Element) {
        rectReads += 1;
        return origRect.call(this);
      },
    });

    try {
      document.body.innerHTML = `
        <aside class="glass-side-card" data-surface="panel"></aside>
        <main class="glass-main"></main>
      `;

      for (const material of ["glass", "clear", "solid"] as const) {
        appearance.setMaterial(material);
        expect(document.documentElement.getAttribute("data-material")).toBe(
          material,
        );

        for (let i = 0; i < 5; i++) {
          const bubble = document.createElement("div");
          bubble.setAttribute("data-surface", "bubble");
          document.querySelector(".glass-main")?.appendChild(bubble);
        }
        window.dispatchEvent(new Event("scroll"));
        await new Promise((r) => setTimeout(r, 30));
      }

      expect(rectReads).toBe(0);
      expect(document.getElementById("chisabot-lg-lens")).toBeNull();
      expect(document.getElementById("chisabot-glass-alpha")).toBeNull();
      expect(document.querySelector("[data-lg-lens]")).toBeNull();
      expect(document.querySelector("[data-lg-ink]")).toBeNull();
    } finally {
      if (origDescriptor) {
        Object.defineProperty(
          Element.prototype,
          "getBoundingClientRect",
          origDescriptor,
        );
      } else {
        Reflect.deleteProperty(Element.prototype, "getBoundingClientRect");
      }
    }
  });
});

describe("3) 光学字缘保护与对比度防线", () => {
  const materialsCss = stripComments(
    readFileSync(path.join(srcDir, "styles/materials.css"), "utf8"),
  );
  const stylesCss = stripComments(
    readFileSync(path.join(srcDir, "styles.css"), "utf8"),
  );

  test("光学字缘保护仅单层轻影 0 1px 1px 作用于非实色裸露容器，气泡/卡片/代码块/表单控件严格 text-shadow: none", () => {
    expect(materialsCss).toMatch(
      /html\.dark:not\(\[data-material="solid"\]\)\s*:is\(\.glass-shell,\s*\.rail-sheet,\s*\[data-surface="elevated"\],\s*\.hk-drawer\)\s*\{\s*text-shadow:\s*0 1px 1px rgba\(0,\s*0,\s*0,\s*0\.\d+\);/,
    );
    expect(materialsCss).toMatch(
      /html:not\(\.dark\)\[data-canvas="wallpaper"\]:not\(\[data-material="solid"\]\)\s*:is\(\.glass-shell,\s*\.rail-sheet,\s*\[data-surface="elevated"\],\s*\.hk-drawer\)\s*\{\s*text-shadow:\s*0 1px 1px rgba\(255,\s*255,\s*255,\s*0\.\d+\);/,
    );

    const exemptMatch = materialsCss.match(
      /:is\(([\s\S]*?)\)\s*\{\s*text-shadow:\s*none;\s*\}/,
    );
    expect(exemptMatch).toBeTruthy();
    const exemptList = exemptMatch?.[1] ?? "";
    for (const sel of [
      '[data-surface="bubble"]',
      '[data-surface="control"]',
      '[data-surface="inset"]',
      '[data-slot="bubble-content"]',
      ".jr-card",
      "pre",
      "code",
      "input",
      "textarea",
    ]) {
      expect(exemptList).toContain(sel);
    }
  });

  test("data-resizing 严禁剥离模糊或切换不透明黑底", () => {
    const combined = `${materialsCss}\n${stylesCss}`;
    for (const m of combined.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1] ?? "";
      const body = m[2] ?? "";
      if (!sel.includes("data-resizing")) continue;
      expect(body).not.toMatch(/backdrop-filter\s*:/);
      expect(body).not.toMatch(/--surface-blur\s*:/);
      expect(body).not.toMatch(/background\s*:[^;]*(?:#000|opaque)/);
    }
  });
});
