import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * DESIGN.md §10.5：Hark 令牌写在 `html:root`（0,1,1），会压过旧层 `.dark`（0,1,0）里的同名令牌。
 * 所以一个 Hark 令牌只要和旧的深色层同名，就必须在 `html.dark` 里给深色值；
 * 由别的令牌算出来的（值里有 var(--…)）跟着基色走，不用重复写。
 */
const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const block = (selector: string) => {
  const m = css.match(
    new RegExp(
      `(?:^|\\})\\s*${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^{}]*)\\}`,
    ),
  );
  return m ? m[1] : "";
};
const decls = (body: string) =>
  new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
  );

const hark = decls(block("html:root"));
const harkDark = decls(block("html.dark"));

/** 旧层里所有深色规则（`.dark`、`[data-theme="dark"]` 开头的选择器，不含 `html.dark`）声明过的令牌。 */
const oldDark = new Set<string>();
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selectors = m[1].split(",").map((s) => s.trim());
  if (!selectors.some((s) => /^(\.dark|\[data-theme="dark"\])$/.test(s)))
    continue;
  for (const name of decls(m[2]).keys()) oldDark.add(name);
}

test("the Hark token blocks are found", () => {
  expect(hark.size).toBeGreaterThan(40);
  expect(harkDark.size).toBeGreaterThan(10);
});

test("every Hark token that shares a name with an old dark token has a dark value", () => {
  const missing = [...hark.entries()]
    .filter(
      ([name, value]) =>
        oldDark.has(name) && !harkDark.has(name) && !value.includes("var(--"),
    )
    .map(([name]) => name);
  expect(missing).toEqual([]);
});
