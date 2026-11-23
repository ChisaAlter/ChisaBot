import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * CB-024（DESIGN.md §7.4）：画布过渡只在 html[data-sky-ease] 短时态下触发。
 * 切暗色 / 每分钟走一格都是一帧换好——禁止给 body / body::before 写无条件 transition，
 * 避免每块毛玻璃逐帧重新光栅化模糊。
 */
const canvasCss = readFileSync(
  path.join(import.meta.dir, "../src/styles/canvas.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const stylesCss = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function rules(css: string, selector: RegExp) {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const sel = (m[1] ?? "").trim().replace(/\s+/g, " ");
    if (selector.test(sel)) out.push(m[2] ?? "");
  }
  return out;
}

test("body / body::before 在 canvas.css 与 styles.css 中均无无条件 transition", () => {
  const plain = [
    ...rules(canvasCss, /^body$/),
    ...rules(canvasCss, /^body::before$/),
    ...rules(canvasCss, /^(?:html)?\.dark body$/),
    ...rules(stylesCss, /^body$/),
    ...rules(stylesCss, /^body::before$/),
    ...rules(stylesCss, /^(?:html)?\.dark body$/),
  ];
  expect(plain.length).toBeGreaterThan(0);
  for (const body of plain) expect(body).not.toMatch(/transition/);
});

test("data-sky-ease 仅作用于 canvas.css 中的 #sky-root #skyph，严禁波及整页通配符", () => {
  const eased = rules(canvasCss, /^html\[data-sky-ease\] #sky-root #skyph$/);
  expect(eased.length).toBeGreaterThan(0);
  expect(eased[0]).toMatch(/transition:\s*opacity/);
  expect(canvasCss).not.toMatch(/\[data-sky-ease\]\s+\*/);
  expect(stylesCss).not.toMatch(/\[data-sky-ease\]\s+\*/);
});

test("easeNextSkyChange 写入 data-sky-ease 并在过渡结束后自动移除", async () => {
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
  } as unknown as HTMLElement;
  const timers: Array<() => void> = [];
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = "window" in g;
  const prev = g.window;
  g.window = {
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  try {
    const { easeNextSkyChange } = await import(
      "../src/components/sky-background"
    );
    easeNextSkyChange(root);
    expect(attrs.has("data-sky-ease")).toBe(true);
    const lastTimer = timers.at(-1);
    expect(lastTimer).toBeDefined();
    lastTimer?.();
    expect(attrs.has("data-sky-ease")).toBe(false);
  } finally {
    if (hadWindow) g.window = prev;
    else delete g.window;
  }
});
