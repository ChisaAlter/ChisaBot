import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 性能模式 / 减少透明度下，普通 filter: blur 也要关（#375 跟进，src/perf-noblur.css）。
 * 不跑浏览器，守住前提：
 *   1. 样式表里每条带 filter: blur 的规则，perf-noblur.css 的两种情况（data-perf="on" 和
 *      prefers-reduced-transparency）都有覆盖它、且 filter 不含 blur 的规则；
 *   2. 组件里不许用内联 style 写 filter: blur（id 优先级压不过内联样式），壁纸模糊是用户自己调的，豁免。
 */
const src = path.join(import.meta.dir, "../src");
const read = (f: string) => readFileSync(path.join(src, f), "utf8");
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");

function rules(text: string) {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
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
  return m ? m[1].replace(/\$\{[^}]*\}/g, "0") : "";
}

const sheets: Record<string, string> = {
  "styles.css": strip(read("styles.css")),
  "components/rich-previews/link-card.css": strip(
    read("components/rich-previews/link-card.css"),
  ),
  "agent-orb.tsx <style>": strip(orbStyle()),
};

const noblur = strip(read("perf-noblur.css"));
const media = noblur.match(
  /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*)\n\}\n/,
);
const reduceRules = rules(media ? media[1] : "");
const perfRules = rules(noblur).filter((r) =>
  r.selector.startsWith('html[data-perf="on"]'),
);

/** 被模糊的元素选择器（去掉 :hover 之类不影响）里抽出类名 + [data-dimmed] 这样的关键 token。 */
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
    if (!/(^|[^-])filter\s*:/.test(r.body) || hasBlurFilter(r.body))
      return false;
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

test("找得到要关的 filter: blur 规则（防止解析失效变成空跑）", () => {
  const names = blurRules.map((r) => r.selector).join(" ");
  for (const k of [
    ".rp-link",
    ".rp-pile-card",
    ".lc-card",
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

test("组件不许用内联 style 写 filter: blur（壁纸豁免）", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) {
        const text = readFileSync(p, "utf8");
        if (
          /\bfilter\s*:\s*[`"'][^`"']*blur\(/.test(text) &&
          !p.endsWith("sky-background.tsx")
        ) {
          offenders.push(path.relative(src, p));
        }
      }
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
});
