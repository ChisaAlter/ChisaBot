import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 挂在大容器（html / body / :root / .glass-shell / .glass-topbar / .glass-main）上的 :has()
 * 会让容器里任何一处 DOM 变化都去重算整个容器的样式，流式输出时每个 token 都要算一遍。
 * 新代码请改用组件直接输出的 data-* 属性（例如顶栏的 data-sidebar / data-winctrls）。
 * 下面的清单是 main 上已有的旧规则，只许减少不许增加；删掉一条旧规则时把它也从清单里去掉。
 */
/** 已经删掉、不许再出现的旧规则（左栏收起改用顶栏的 data-sidebar）。 */
const FORBIDDEN = [
  '.glass-shell:has([data-slot="sidebar"][data-state="collapsed"])',
];

const LEGACY = [
  "body:has(.glass-topbar)",
  '.glass-topbar:has(.win-ctrls[data-count="3"])',
  "body:not(:has(.glass-composer))",
  "body:has(.update-banner)",
  "body:has(.computer-takeover)",
  "html:has(> body .glass-shell)",
  "body:has(.rail-tab.is-narrow)",
  'body:has([data-slot="sheet-overlay"])',
];

const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (s) =>
    s.replace(/[{}]/g, " "),
  );

/** 按括号深度切分：只在最外层遇到分隔符时切。 */
function splitTop(text: string, isSep: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (!quote && depth === 0 && isSep(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 去掉括号里的内容，只看复合选择器本身挂在谁身上。 */
function outsideParens(compound: string): string {
  let depth = 0;
  let out = "";
  for (const ch of compound) {
    if (ch === "(") depth++;
    if (depth === 0) out += ch;
    if (ch === ")") depth--;
  }
  return out;
}

const BIG =
  /^(?:html|body|:root)(?![\w-])|\.glass-(?:shell|topbar|main)(?![\w-])/;

function containerHasSelectors(): string[] {
  const found = new Set<string>();
  for (const m of css.matchAll(/([^{};]+)\{/g)) {
    const prelude = m[1].trim();
    if (!prelude || prelude.startsWith("@") || !prelude.includes(":has("))
      continue;
    for (const complex of splitTop(prelude, (ch) => ch === ",")) {
      for (const compound of splitTop(complex, (ch) => /[\s>+~]/.test(ch))) {
        if (compound.includes(":has(") && BIG.test(outsideParens(compound))) {
          found.add(compound);
        }
      }
    }
  }
  return [...found].sort();
}

test("找得到旧的大容器 :has()，说明检查本身在工作", () => {
  expect(containerHasSelectors()).toContain("body:has(.glass-topbar)");
});

test("已删掉的旧 :has() 不许再出现", () => {
  const raw = readFileSync(
    path.join(import.meta.dir, "../src/styles.css"),
    "utf8",
  );
  for (const sel of FORBIDDEN) {
    expect(raw.includes(sel)).toBe(false);
    expect(containerHasSelectors()).not.toContain(sel);
    expect(LEGACY).not.toContain(sel);
  }
  // 换一种写法也不行：.glass-shell 上按左栏收起状态的 :has()。
  expect(css).not.toMatch(/\.glass-shell:has\([^{]*collapsed/);
});

test("styles.css 不新增挂在大容器上的 :has()", () => {
  // 多出来的是新加的（改用 data 属性）；少了的是旧规则已经删掉（把它从 LEGACY 里去掉）。
  expect(containerHasSelectors()).toEqual([...LEGACY].sort());
});

test("顶栏收起左栏 / 4 个标题按钮改用顶栏自己的 data 属性", () => {
  expect(
    css.includes('.glass-topbar[data-sidebar="collapsed"] .glass-topbar-start'),
  ).toBe(true);
  expect(
    css.includes('html[data-desktop] .glass-topbar[data-winctrls="4"]'),
  ).toBe(true);
  expect(css.includes('.win-ctrls[data-count="4"]')).toBe(false);
});

test("外壳和顶栏组件里不用 Tailwind 的 has-* 变体", () => {
  for (const file of ["glass-shell.tsx", "glass-topbar.tsx"]) {
    const src = readFileSync(
      path.join(import.meta.dir, "../src/components/layout", file),
      "utf8",
    )
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/(?:^|[\s"'`])(?:group-|peer-)?has-\[|:has\(/);
  }
});
