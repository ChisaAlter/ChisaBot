import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 性能模式 / 减少透明度下，普通 filter: blur 也要关（#375 跟进，src/perf-noblur.css）。
 * 覆盖全站全部样式表（styles/tokens.css、canvas.css、materials.css、styles.css、link-card.css、agent-orb.tsx <style>）：
 *   1. 每条带 filter: blur 的规则，在 perf-noblur.css 的 data-perf="on" 和 prefers-reduced-transparency 两种情况下都有无 blur 的覆盖规则；
 *   2. 组件内联 style 禁止写 filter: blur（壁纸模糊只传 --canvas-blur CSS 变量，挂载于 #sky-root）。
 */
const src = path.join(import.meta.dir, "../src");
const read = (f: string) => readFileSync(path.join(src, f), "utf8");
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");

function rules(text: string) {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({
      selector: (m[1] ?? "").trim().replace(/\s+/g, " "),
      body: m[2] ?? "",
    });
  }
  return out;
}

const hasBlurFilter = (body: string) =>
  /(^|[^-])filter\s*:[^;]*blur\(/.test(
    body.replace(/backdrop-filter\s*:[^;]*;?/g, ""),
  );

function orbStyle() {
  const tsx = read("components/agents/orb/agent-orb.tsx");
  const m = tsx.match(/<style>\{`([\s\S]*?)`\}<\/style>/);
  return m?.[1] ? m[1].replace(/\$\{[^}]*\}/g, "0") : "";
}

const sheets: Record<string, string> = {
  "styles/tokens.css": strip(read("styles/tokens.css")),
  "styles/canvas.css": strip(read("styles/canvas.css")),
  "styles/materials.css": strip(read("styles/materials.css")),
  "styles.css": strip(read("styles.css")),
  "components/rich-previews/link-card.css": strip(
    read("components/rich-previews/link-card.css"),
  ),
  "agent-orb.tsx <style>": strip(orbStyle()),
};

const noblur = strip(read("perf-noblur.css"));

function mediaBodies(css: string, query: string): string {
  const bodies: string[] = [];
  const re = /@media\s+([^{}]+)\{/g;
  for (const m of css.matchAll(re)) {
    const conditions = (m[1] ?? "").split(",").map((c) => c.trim());
    if (!conditions.includes(query)) continue;
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    bodies.push(css.slice(start, i - 1));
  }
  return bodies.join("\n");
}

const reduceRules = rules(
  mediaBodies(noblur, "(prefers-reduced-transparency: reduce)"),
);
const perfRules = rules(noblur).filter((r) =>
  r.selector.startsWith('html[data-perf="on"]'),
);

function key(selector: string) {
  const cls = selector.match(/\.[\w-]+/g) ?? [];
  const last = cls[cls.length - 1] ?? selector;
  return {
    cls: last,
    dimmed: selector.includes("[data-dimmed]"),
    before: selector.includes("::before"),
  };
}

function covered(list: typeof perfRules, selector: string) {
  const k = key(selector);
  return list.some((r) => {
    if (!/(^|[^-])filter\s*:/.test(r.body) || hasBlurFilter(r.body)) {
      return false;
    }
    if (!r.selector.includes(k.cls)) return false;
    if (k.dimmed && !r.selector.includes("[data-dimmed]")) return false;
    if (k.before !== r.selector.includes("::before")) return false;
    return true;
  });
}

const blurRules = Object.entries(sheets).flatMap(([file, text]) =>
  rules(text)
    .filter((r) => hasBlurFilter(r.body) && !r.selector.startsWith("@"))
    .flatMap((r) =>
      r.selector.split(",").map((s) => ({ file, selector: s.trim() })),
    ),
);

test("找得到全部要关的 filter: blur 规则（含 canvas.css 中的壁纸模糊）", () => {
  const names = blurRules.map((r) => r.selector).join(" ");
  for (const k of [
    ".chisabot-wallpaper-img",
    ".rp-link",
    ".agent-orb-glow",
    ".agent-orb::before",
  ]) {
    expect(names).toContain(k);
  }
});

for (const r of blurRules) {
  test(`性能模式关掉 ${r.file}: ${r.selector}`, () => {
    expect(covered(perfRules, r.selector)).toBe(true);
  });
  test(`减少透明度关掉 ${r.file}: ${r.selector}`, () => {
    expect(covered(reduceRules, r.selector)).toBe(true);
  });
}

test("变暗的卡片改用透明度，不是变成没区分的实卡", () => {
  for (const list of [perfRules, reduceRules]) {
    const r = list.find((x) => x.selector.includes("[data-dimmed]"));
    expect(r?.body).toMatch(/opacity\s*:\s*0\.\d+/);
  }
});

test("组件不许用内联 style 写 filter: blur", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) {
        const text = readFileSync(p, "utf8").replace(
          /<style>\{`[\s\S]*?`\}<\/style>/g,
          "",
        );
        if (/\bfilter\s*:[^,;}]*?blur\(/.test(text)) {
          offenders.push(path.relative(src, p));
        }
      }
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
});

test("壁纸模糊走 --canvas-blur / --canvas-scrim 单通道变量，无内联 filter: blur 与双层叠幕", () => {
  const sky = read("components/sky-background.tsx");
  expect(sky).toContain('"--canvas-blur"');
  expect(sky).toContain('"--canvas-scrim"');
  expect(sky).not.toMatch(/filter\s*:[^,\n]*blur/);
  expect(sky).not.toContain("chisabot-wallpaper-dim");
  // canvas.css 只在 .chisabot-wallpaper-img 读 --canvas-blur，在 #sky-root::after 读 --canvas-scrim
  const canvasCss = sheets["styles/canvas.css"] ?? "";
  expect(canvasCss).toContain("filter: blur(var(--canvas-blur, 0px));");
  expect(canvasCss).toContain(
    "background: rgb(var(--canvas-scrim-rgb) / var(--canvas-scrim, 0.35));",
  );
});
