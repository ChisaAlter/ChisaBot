#!/usr/bin/env node
// 外观模型重构（模式 × 皮肤 × 背景，DESIGN.md §140，CB-134）的真浏览器验收。
//
// 覆盖：
//  - 外观块：皮肤网格 + 「主题天空」卡 + 8 张天象卡（昼 / 暮 / 夜角标）；
//  - 皮肤卡 = 强调色 + 主题天空：点配色把 chisabot-sky-source 写到 "theme"，主题天空卡选中；
//  - 天象卡切回引擎：skySource 写 "hark" 并退出壁纸；
//  - 昼夜配对：浅色下点「柏林夜」，--sky-lift 落在配对场景（檀香山晨霞 darkness 0.55 → 0.07）
//    而不是夜景本体的 0.14 顶格；引擎活着时顺带记录 applyScene 的真实解析下标；
//  - 明暗绑定皮肤：深色下点「素白星尘」连模式一起切回浅色；
//  - 壁纸互斥：选壁纸后天空卡组不亮 + 「壁纸启用中 · 皮肤仅更新强调色」提示；
//  - live 天象 → <html data-sky="live">（PC 原生窗同步语义）；
//  - 桌面 + 移动视口截图、零控制台报错。
//
// 用法：node tests/appearance-model/appearance.mjs [--dist app/dist] [--out <dir>] [--chrome <path>]
// 需要 `bun run generate:app-config && bun run --cwd app build` 先产出 --dist。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startMockServer } from "../../perf/mock-server.mjs";
import { resolveBrowserExecutable } from "../../scripts/verify-ui.mjs";

const { values: o } = parseArgs({
  options: {
    dist: { type: "string", default: "app/dist" },
    out: { type: "string", default: "" },
    chrome: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (o.help) {
  console.log(
    "node tests/appearance-model/appearance.mjs [--dist app/dist] [--out dir] [--chrome path]",
  );
  process.exit(0);
}
const DIST = path.resolve(o.dist);
if (!fs.existsSync(path.join(DIST, "index.html")))
  throw new Error(`no build at ${DIST} (run the app build first)`);
const OUT = o.out
  ? path.resolve(o.out)
  : fs.mkdtempSync(path.join(os.tmpdir(), "appearance-model-"));
fs.mkdirSync(OUT, { recursive: true });
const CHROME =
  o.chrome || process.env.CHROME_PATH || resolveBrowserExecutable();
if (!CHROME)
  throw new Error("no Edge/Chrome found (set --chrome or CHROME_PATH)");

const log = (...args) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

/* window.hark 一出现就包 applyScene：记录宿主真正解析出的场景下标（配对证据）。 */
const INIT = `
  window.__sceneCalls = [];
  let __val;
  Object.defineProperty(window, "hark", {
    configurable: true,
    get() { return __val; },
    set(v) {
      try {
        if (v && typeof v.applyScene === "function" && !v.__wrapped) {
          const orig = v.applyScene.bind(v);
          v.applyScene = (i) => { window.__sceneCalls.push(i); return orig(i); };
          v.__wrapped = true;
        }
      } catch {}
      __val = v;
    },
  });
`;

const mock = await startMockServer({ dist: DIST });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cb-appearance-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  locale: "zh-CN",
  args: ["--no-first-run", "--mute-audio"],
});

let failures = 0;
const check = (label, cond, detail) => {
  log(`  ${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const consoleErrors = [];

const ls = (page, key) =>
  page.evaluate((k) => window.localStorage.getItem(k), key);
const skyAttr = (page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-sky"));
const lift = (page) =>
  page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--sky-lift") || null,
  );
const isDark = (page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

async function openSettings(storage = {}) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    consoleErrors.push(String(e).slice(0, 160));
    log(`  pageerror: ${String(e).slice(0, 160)}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // mock 只挡了 fixtures 里的接口：未覆盖的 /api/* 404 与 channels/events WS 握手是环境噪音，不算产品错误。
    if (/Failed to load resource|WebSocket connection/i.test(text)) return;
    consoleErrors.push(text.slice(0, 160));
  });
  await page.addInitScript((s) => {
    for (const [k, v] of Object.entries(s)) window.localStorage.setItem(k, v);
  }, storage);
  await page.goto(`${mock.base}/settings`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector('[data-testid="sky-source-theme"]', {
    timeout: 20000,
  });
  await page.waitForTimeout(1200);
  return page;
}

try {
  await ctx.addInitScript(INIT);

  /* ---------- 1. 默认（浅色 + auto + 引擎源）：新外观块结构 ---------- */
  log("1) 外观块结构：皮肤 / 主题天空 / 天象卡 + 昼夜角标");
  const p1 = await openSettings();
  check("主题天空卡在", (await p1.locator('[data-testid="sky-source-theme"]').count()) === 1);
  check(
    "8 张天象卡",
    (await p1.locator('[data-testid^="hark-scene-"]').count()) === 8,
  );
  const badges = await p1
    .locator(".appearance-scene-daylight")
    .allTextContents();
  check(
    "昼 2 / 暮 3 / 夜 2 角标",
    badges.filter((t) => t === "昼").length === 2 &&
      badges.filter((t) => t === "暮").length === 2 &&
      badges.filter((t) => t === "夜").length === 2,
    badges.join(","),
  );
  check(
    "素白 / 墨夜色板带明暗绑定角标",
    (await p1.locator('[data-testid="palette-option-stardust"] .appearance-palette-mode').count()) === 1 &&
      (await p1.locator('[data-testid="palette-option-nocturne"] .appearance-palette-mode').count()) === 1,
  );
  check(
    "默认 auto 天象卡选中、data-sky 是引擎模式",
    (await p1.locator('[data-testid="hark-scene-auto"].is-active').count()) === 1 &&
      ["live", "snapshot"].includes(await skyAttr(p1)),
    `data-sky=${await skyAttr(p1)}`,
  );
  check(
    "独立「背景随时间变化」开关已删",
    (await p1.locator('text=背景随时间变化').count()) === 0,
  );

  /* ---------- 2. 浅色 + 夜景卡：解析到配对场景（护栏证据） ---------- */
  log("2) 浅色 + 柏林夜：--sky-lift 走配对场景 0.07 而非夜景顶格 0.14");
  await p1.locator('[data-testid="hark-scene-4"]').click();
  await p1.waitForTimeout(700);
  check(
    "harkScene=4、skySource=hark 已存",
    (await ls(p1, "chisabot-hark-scene")) === "4" &&
      ["hark", null].includes(await ls(p1, "chisabot-sky-source")),
  );
  const lift2 = await lift(p1);
  check(
    "--sky-lift = 0.07（配对晨霞 0.55），不是夜景顶格 0.14",
    lift2 !== null && Math.abs(Number(lift2) - 0.07) < 0.005,
    `lift=${lift2}`,
  );
  const calls = await p1.evaluate(() => window.__sceneCalls);
  if (calls.length > 0) {
    check(
      "引擎收到的解析场景 = 11（檀香山晨霞配对）",
      calls[calls.length - 1] === 11,
      `calls=${calls.join(",")}`,
    );
  } else {
    log("  info 引擎未起（无 WebGL），applyScene 不可考 —— 配对已由 --sky-lift 佐证");
  }

  /* ---------- 3. 点皮肤卡：切主题天空（引擎退出） ---------- */
  log("3) 点「樱语粉」皮肤卡：skySource=theme、主题天空卡选中、data-sky=off");
  await p1.locator('[data-testid="palette-option-sakura"]').click();
  await p1.waitForTimeout(700);
  check(
    "skySource=theme 已存、皮肤已换",
    (await ls(p1, "chisabot-sky-source")) === "theme" &&
      (await ls(p1, "chisabot-theme-palette")) === "sakura",
  );
  check(
    "主题天空卡选中、引擎关掉",
    (await p1.locator('[data-testid="sky-source-theme"].is-active').count()) ===
      1 && (await skyAttr(p1)) === "off",
    `data-sky=${await skyAttr(p1)}`,
  );
  check("--sky-lift 移除（主题渐变不需要护栏）", (await lift(p1)) === null);
  await p1.screenshot({ path: path.join(OUT, "settings-theme-sky.png"), fullPage: true });

  /* ---------- 4. 深色 + 明暗绑定皮肤 ---------- */
  log("4) 深色外观：点「素白星尘」连模式一起切回浅色");
  const p2 = await openSettings({ "chisabot-theme": "dark" });
  check("深色生效", await isDark(p2));
  await p2.locator('[data-testid="palette-option-stardust"]').click();
  await p2.waitForTimeout(900);
  check(
    "点素白后外观翻浅、皮肤已换",
    !(await isDark(p2)) &&
      (await ls(p2, "chisabot-theme-palette")) === "stardust" &&
      (await ls(p2, "chisabot-theme")) === "light",
  );
  await p2.close();

  /* ---------- 5. 壁纸互斥 + live → data-sky ---------- */
  log("5) 壁纸盖过天空组；live 天象写 data-sky=live");
  await p1.locator('[data-testid="wallpaper-preset-waterlily-pond"]').click();
  await p1.waitForTimeout(700);
  const hint = await p1
    .locator('[data-testid="palette-sky-hint"]')
    .textContent()
    .catch(() => "");
  check(
    "壁纸启用：天空卡组不亮 + 提示行",
    (await p1.locator('[aria-label="天空背景选择"] .is-active').count()) === 0 &&
      typeof hint === "string" &&
      hint.includes("壁纸启用中"),
    hint,
  );
  await p1.locator('[data-testid="palette-option-emerald"]').click();
  await p1.waitForTimeout(500);
  check(
    "壁纸启用中点皮肤只换强调色（壁纸与来源都不动）",
    (await ls(p1, "chisabot-theme-palette")) === "emerald" &&
      (await ls(p1, "chisabot-wallpaper-id")) === "waterlily-pond" &&
      (await ls(p1, "chisabot-sky-source")) === "theme",
  );
  await p1.locator('[data-testid="hark-scene-live"]').click();
  await p1.waitForTimeout(900);
  check(
    "点 live 天象：退出壁纸、skySource=hark、data-sky=live",
    (await ls(p1, "chisabot-hark-scene")) === "live" &&
      (await ls(p1, "chisabot-wallpaper-id")) === "none" &&
      (await skyAttr(p1)) === "live",
    `data-sky=${await skyAttr(p1)}`,
  );
  await p1.screenshot({ path: path.join(OUT, "settings-desktop.png"), fullPage: true });
  await p1.close();

  /* ---------- 6. 移动视口 ---------- */
  log("6) 390 移动视口截图 + 无横向溢出");
  const p3 = await openSettings();
  await p3.setViewportSize({ width: 390, height: 844 });
  await p3.waitForTimeout(400);
  const overflow = await p3.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 2,
  );
  check("移动端无横向溢出", !overflow);
  await p3.screenshot({ path: path.join(OUT, "settings-mobile.png"), fullPage: true });
  await p3.close();

  check(
    "全程零控制台错误 / pageerror",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );
} finally {
  await ctx.close().catch(() => {});
  mock.close();
}

log(failures === 0 ? "PASS（全项）" : `FAIL ×${failures}`);
log(`artifacts: ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
