#!/usr/bin/env node
/**
 * 把网页的 Skyglass 设计令牌和时间天空复制给 PC 客户端的本机窗口（设置向导、审批弹窗、本机确认、离线页），
 * 保证这几个原生窗口和网页用同一套颜色、玻璃、字体、圆角、动效和深色模式（DESIGN.md §10、§7、§16.5）。
 *
 *   node scripts/sync-skyglass.mjs      # 网页改了令牌或天空后重跑，产物提交进仓库
 *
 * 产物：src/ui/skyglass-tokens.css（:root / .dark 令牌、@property、天空背景与星星，逐字取自 app/src/styles.css）
 *       src/ui/sky.js（computeSky，逐字取自 app/src/lib/sky.ts，只去掉 TypeScript 类型）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../app/src");
const out = path.resolve(here, "../src/ui");
const css = fs.readFileSync(path.join(app, "styles.css"), "utf8");

function block(startMarker, from = 0) {
  const start = css.indexOf(startMarker, from);
  if (start < 0) throw new Error(`styles.css 里找不到 ${startMarker}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return { text: css.slice(start, i + 1), end: i + 1 };
  }
  throw new Error(`${startMarker} 没有闭合`);
}

const tokenStart = css.indexOf("Skyglass design tokens");
const root = block(":root {", tokenStart);
const dark = block(".dark {", root.end);
const palettes = css.match(/^html(?:\.dark)?\[data-palette="[^"]+"\]\s*\{[^}]+\}/gm) ?? [];
const properties = css.match(/^@property --sky-[^\n]+$/gm) ?? [];
const bodyStart = css.indexOf("\nbody {", dark.end);
const body = block("body {", bodyStart);
const darkBody = block(".dark body {", body.end);
const stars = block("body::before {", darkBody.end);
const lightRoot = block(":root {"); // 最早的 :root：shadcn 基础变量（--background 等）
const baseDark = block(".dark {");

fs.writeFileSync(
  path.join(out, "skyglass-tokens.css"),
  [
    "/* 由 pc/scripts/sync-skyglass.mjs 从 app/src/styles.css 生成，请勿手改。 */",
    lightRoot.text,
    baseDark.text,
    root.text,
    dark.text,
    ...palettes,
    ...properties,
    body.text,
    darkBody.text,
    stars.text,
    "",
  ].join("\n\n"),
);

const ts = fs.readFileSync(path.join(app, "lib/sky.ts"), "utf8");
const fnStart = ts.indexOf("export function computeSky");
const fnEnd = ts.indexOf("\n}\n", fnStart) + 2;
let fn = ts.slice(fnStart, fnEnd).replace("export function", "function");
fn = fn
  .replace(/\(minuteOfDay: number, dark: boolean\): SkyVars/, "(minuteOfDay, dark)")
  .replace(/^\s*type P = [^\n]+\n/m, "")
  .replace(/const (\w+): [^=]+ = /g, "const $1 = ")
  .replace(/\((c|i): (string|number)\): number\[\] =>/g, "($1) =>")
  .replace(/\(([a-z]): (string|number)\)/g, "($1)")
  .replace(/\(a: string, b: string, t: number, alphaScale: number\): string/, "(a, b, t, alphaScale)")
  .replace(/\(a: number, b: number, t: number\)/, "(a, b, t)")
  .replace(/let u: number;/, "let u;");
if (/:\s*(string|number|boolean|SkyVars|P\b)/.test(fn.replace(/"[^"]*"/g, ""))) throw new Error("sky.ts 里还有没去掉的类型标注");

fs.writeFileSync(
  path.join(out, "sky.js"),
  `"use strict";
/* 由 pc/scripts/sync-skyglass.mjs 从 app/src/lib/sky.ts 生成，请勿手改。 */
${fn}

if (typeof module !== "undefined") module.exports = { computeSky };
`,
);
console.log("skyglass-tokens.css + sky.js 已更新");
