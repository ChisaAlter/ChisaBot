import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VALID_THEME_IDS } from "../src/lib/appearance";
import { blocks } from "./contrast-model";

/**
 * V2 单通道深浅色令牌守卫（取代旧 Hark html:root vs .dark 平行层补丁）：
 *   1. 全站深浅色基底唯一收敛在 `tokens.css` 的 `:root` 与 `html.dark`，彻底消灭 `[data-theme="dark|light"]` 与 `html:root` 平行层；
 *   2. 每一套核心色标（墨色、强调色、语义色、画布基色、实面底色、描边、玻璃别名）均在 `html.dark` 有明确深色值；
 *   3. 7 套色彩主题在 `tokens.css` 均成对声明浅/深版（`html[data-theme="<id>"]` + `html.dark[data-theme="<id>"]`）。
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const tokensCss = strip(
  readFileSync(path.join(import.meta.dir, "../src/styles/tokens.css"), "utf8"),
);
const stylesCss = strip(
  readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8"),
);

const decls = (bodies: string[]) =>
  new Map(
    bodies.flatMap((body) =>
      [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
        (m) => [m[1] ?? "", (m[2] ?? "").trim()] as const,
      ),
    ),
  );

const lightRoot = decls(blocks(tokensCss, ":root"));
const darkRoot = decls(blocks(tokensCss, "html.dark"));

test("tokens.css 拥有完整的浅色 :root 与深色 html.dark 基底块", () => {
  expect(lightRoot.size).toBeGreaterThan(80);
  expect(darkRoot.size).toBeGreaterThan(40);
});

test("不再存在历史 [data-theme=\"dark|light\"] 或 html:root 平行深浅色令牌块", () => {
  const combined = `${tokensCss}\n${stylesCss}`;
  expect(combined).not.toContain('[data-theme="dark"]');
  expect(combined).not.toContain('[data-theme="light"]');
  expect(combined).not.toMatch(/html:root\s*\{/);
  expect(stylesCss).not.toContain("data-theme-family");
});

test("所有核心颜色令牌在 html.dark 中均有深色值，7 套主题均成对提供浅/深覆盖", () => {
  const mustHaveDark = [
    "--ink-1",
    "--ink-2",
    "--ink-3",
    "--ink-4",
    "--ink-on-accent",
    "--ink-primary",
    "--on-primary",
    "--side-sec-main-ink",
    "--side-sub-ink",
    "--accent",
    "--accent-ink",
    "--accent-soft",
    "--accent-ring",
    "--task-info",
    "--sem-success",
    "--sem-warn",
    "--sem-danger",
    "--canvas-pure-bg",
    "--canvas-pure-base",
    "--canvas-scrim-rgb",
    "--sky-veil-bg",
    "--surface-tint-rgb",
    "--surface-solid-panel",
    "--surface-solid-elevated",
    "--surface-solid-bubble",
    "--surface-solid-inset",
    "--surface-solid-control",
    "--surface-edge-rgb",
    "--line",
    "--line-strong",
    "--stroke",
    "--hover-wash",
    "--glass-1",
    "--glass-2",
    "--glass-3",
    "--bubble-user-bg",
    "--bubble-agent-bg",
  ];
  const missing = mustHaveDark.filter(
    (name) => !lightRoot.has(name) || !darkRoot.has(name),
  );
  expect(missing).toEqual([]);

  for (const id of VALID_THEME_IDS) {
    expect(blocks(tokensCss, `html[data-theme="${id}"]`).length).toBeGreaterThan(
      0,
    );
    expect(
      blocks(tokensCss, `html.dark[data-theme="${id}"]`).length,
    ).toBeGreaterThan(0);
  }
});
