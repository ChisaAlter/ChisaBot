import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * DESIGN.md §41：Tailwind 的 group-has-* / peer-has-* 会生成「:has(…) *」，Chromium 会因此在任何 data-* 变化时
 * 重算整个应用的样式（每次点击 130–230ms，4× CPU）。改写成 [[祖先]:has(…)_&]:工具类。
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

test("no group-has-* / peer-has-* utilities (whole-app style invalidation)", () => {
  const root = path.join(import.meta.dir, "../src");
  const offenders = files(root).filter((file) => /(^|[\s"'`])(group|peer)-has-/m.test(readFileSync(file, "utf8")));
  expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
});

/*
 * peer-hover / peer-focus / peer-active 生成 `:hover ~ *`：主体是「任意后面的兄弟」。指针每动一下，悬停目标一换，
 * 浏览器就把后面所有兄弟连同整棵子树标成可能失效。聊天里每条消息互为兄弟，滚动时鼠标不动、内容在鼠标下移，
 * 悬停目标每帧都在换，于是整段对话每帧重算样式（4× 降速滚动 30fps 的主因之一）。要按兄弟的悬停改样式，
 * 写成 [[data-xxx]:hover~&]:工具类——主体是元素自己的类，只失效它自己。
 */
test("no peer-hover / peer-focus / peer-active utilities (every pointer move restyles all later siblings)", () => {
  const root = path.join(import.meta.dir, "../src");
  const offenders = files(root).filter((file) =>
    /(^|[\s"'`])(?:[a-z0-9-]+:)*peer-(?:hover|focus|focus-visible|focus-within|active)(?:\/[\w-]+)?:/m.test(
      readFileSync(file, "utf8"),
    ),
  );
  expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
});

test("styles.css has no leftover merge-conflict markers (a stray line silently drops the next rule)", () => {
  const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");
  expect(css.split("\n").filter((line) => /^(<{7}|={7}|>{7})( |$)/.test(line))).toEqual([]);
});
