import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * CB-024（DESIGN.md §7.4）：天空只在 html[data-sky-ease] 时渐变。切暗色 / 每分钟走一格都是一帧换好——
 * 天空渐变 1.6 秒时每块毛玻璃都要逐帧重新模糊（切主题 ≈ 1.9 秒光栅化）。
 */
const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");

function rules(selector: RegExp) {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const sel = m[1].trim().split("\n").pop()!.trim();
    if (selector.test(sel)) out.push(m[2]);
  }
  return out;
}

test("body / body::before have no unconditional sky transition", () => {
  const plain = [...rules(/^body$/), ...rules(/^body::before$/), ...rules(/^\.dark body$/)];
  expect(plain.length).toBeGreaterThan(0);
  for (const body of plain) expect(body).not.toMatch(/transition/);
});

test("the sky fade lives under html[data-sky-ease] only", () => {
  const eased = rules(/^html\[data-sky-ease\] body$/);
  expect(eased.length).toBeGreaterThan(0);
  expect(eased[0]).toMatch(/--sky-1 1\.6s/);
  expect(rules(/^html\[data-sky-ease\] body::before$/)[0]).toMatch(/opacity 1\.6s/);
  // 选择器主体必须是 body（加 / 去属性只重算 body，不是整页）
  expect(css).not.toMatch(/\[data-sky-ease\]\s+\*/);
});

test("easeNextSkyChange sets the attribute and clears it after the fade", async () => {
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
  } as unknown as HTMLElement;
  const timers: Array<() => void> = [];
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = "window" in g;
  const prev = g.window;
  g.window = { setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
  try {
    const { easeNextSkyChange } = await import("../src/components/sky-background");
    easeNextSkyChange(root);
    expect(attrs.has("data-sky-ease")).toBe(true);
    timers.at(-1)!();
    expect(attrs.has("data-sky-ease")).toBe(false);
  } finally {
    if (hadWindow) g.window = prev;
    else delete g.window;
  }
});
