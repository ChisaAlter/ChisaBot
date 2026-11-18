#!/usr/bin/env node
// 「面板」把手跟随窗口移动（--edge-clip-r 轮询，DESIGN.md §82.11，CB-132）的真浏览器验证。
//
// 0.1.161 只在挂载 + window.resize 时量越屏量：恢复态窗口被拖到右缘出屏（拖窗口不产生
// 任何 DOM 事件，chisabotWindow 桥也没有 bounds 回调）时变量停在旧值，把手跟着出屏被裁半条
// （用户 2026-11-18 截图实测）。现在 250ms 轮询 screenX + outerWidth 重算，值变才写样式。
//
// 这里用 addInitScript 注入假窗口桥 + 可写的 screenX / outerWidth / screen.avail*，
// 改 __edgeX 不派发任何事件（模拟拖窗口），断言真 Chromium 里 .rail-tab 的
// computed `right` 在一个轮询周期内跟上新的越屏量；再翻 __bridgeMax 断言最大化恒 0。
//
// 用法：node tests/rail-edge-clip/edge-clip.mjs [--dist app/dist] [--out <dir>] [--chrome <path>]
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
    "node tests/rail-edge-clip/edge-clip.mjs [--dist app/dist] [--out dir] [--chrome path]",
  );
  process.exit(0);
}
const DIST = path.resolve(o.dist);
if (!fs.existsSync(path.join(DIST, "index.html")))
  throw new Error(`no build at ${DIST} (run the app build first)`);
const OUT = o.out
  ? path.resolve(o.out)
  : fs.mkdtempSync(path.join(os.tmpdir(), "rail-edge-clip-"));
fs.mkdirSync(OUT, { recursive: true });
const CHROME =
  o.chrome || process.env.CHROME_PATH || resolveBrowserExecutable();
if (!CHROME)
  throw new Error("no Edge/Chrome found (set --chrome or CHROME_PATH)");

const log = (...args) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

/* 假桌面窗口桥 + 可写窗口几何。__edgeX/__outerW/__availW/__bridgeMax 由 evaluate 改写；
   localStorage 预置面板栏收起，宽窗口的「面板」把手才会出现。 */
const INIT = `
  window.__edgeX = 200;
  window.__outerW = 1280;
  window.__availW = 1920;
  window.__bridgeMax = false;
  window.__bridgeCbs = new Set();
  window.chisabotWindow = {
    platform: "win32",
    minimize() {},
    toggleMaximize() {},
    close() {},
    isMaximized() { return Promise.resolve(window.__bridgeMax); },
    onMaximizedChange(cb) {
      window.__bridgeCbs.add(cb);
      return () => window.__bridgeCbs.delete(cb);
    },
    isCompact() { return Promise.resolve(false); },
    onCompactChange() { return () => {}; },
  };
  Object.defineProperty(window, "screenX", {
    configurable: true,
    get: () => window.__edgeX,
  });
  Object.defineProperty(window, "outerWidth", {
    configurable: true,
    get: () => window.__outerW,
  });
  Object.defineProperty(window.screen, "availLeft", {
    configurable: true,
    get: () => 0,
  });
  Object.defineProperty(window.screen, "availWidth", {
    configurable: true,
    get: () => window.__availW,
  });
  try { localStorage.setItem("chisabot-panel-rail", "collapsed"); } catch {}
`;

const probe = `(() => {
  const root = document.documentElement;
  const tab = document.querySelector(".rail-tab");
  const cs = tab ? getComputedStyle(tab) : null;
  return {
    screenX: window.screenX,
    outerWidth: window.outerWidth,
    availWidth: window.screen.availWidth,
    clip: root.style.getPropertyValue("--edge-clip-r"),
    right: cs ? cs.right : null,
    tabRect: tab ? Math.round(tab.getBoundingClientRect().right) : null,
    desktop: root.dataset.desktop || null,
    maximized: root.dataset.maximized || null,
  };
})()`;

const mock = await startMockServer({ dist: DIST });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cb-edge-clip-"));
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

try {
  await ctx.addInitScript(INIT);
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on("pageerror", (e) => log(`  pageerror: ${String(e).slice(0, 160)}`));
  await page.goto(`${mock.base}/channel/c1`, {
    waitUntil: "load",
    timeout: 120000,
  });
  await page.waitForSelector(".rail-tab", { state: "visible", timeout: 60000 });
  await page.waitForFunction(
    "document.querySelectorAll('[data-message-id]').length > 10",
    undefined,
    { timeout: 60000 },
  );

  const p0 = await page.evaluate(probe);
  check(
    "注入生效：假桥 + 可控几何",
    p0.desktop === "win32" &&
      p0.screenX === 200 &&
      p0.outerWidth === 1280 &&
      p0.availWidth === 1920,
    JSON.stringify(p0),
  );
  check(
    "初值 0px（窗口在工作区内）",
    p0.clip === "0px" && p0.right === "0px",
    `clip=${p0.clip} right=${p0.right}`,
  );

  // 拖窗口右缘出屏：screenX 1500 + outerWidth 1280 = 2780，越出 1920 工作区 860px。不发任何事件。
  await page.evaluate("window.__edgeX = 1500");
  const moved = await page
    .waitForFunction(
      "getComputedStyle(document.querySelector('.rail-tab')).right === '860px'",
      undefined,
      { timeout: 3000, polling: 60 },
    )
    .then(() => true)
    .catch(() => false);
  const p1 = await page.evaluate(probe);
  check(
    "拖出屏 ~250ms 内 right 跟上 860px",
    moved,
    `clip=${p1.clip} right=${p1.right}`,
  );

  // 拖回工作区内 → 回 0px。
  await page.evaluate("window.__edgeX = 200");
  const back = await page
    .waitForFunction(
      "getComputedStyle(document.querySelector('.rail-tab')).right === '0px'",
      undefined,
      { timeout: 3000, polling: 60 },
    )
    .then(() => true)
    .catch(() => false);
  check("拖回屏内回 0px", back, `right=${(await page.evaluate(probe)).right}`);

  // 窗口在屏外时最大化 → 恒 0（客户区就是工作区）。
  await page.evaluate("window.__edgeX = 1500");
  await page.waitForFunction(
    "document.documentElement.style.getPropertyValue('--edge-clip-r') === '860px'",
    undefined,
    { timeout: 3000, polling: 60 },
  );
  await page.evaluate(
    "window.__bridgeMax = true; for (const cb of window.__bridgeCbs) cb(true)",
  );
  const maxed = await page
    .waitForFunction(
      "getComputedStyle(document.querySelector('.rail-tab')).right === '0px'",
      undefined,
      { timeout: 3000, polling: 60 },
    )
    .then(() => true)
    .catch(() => false);
  check(
    "最大化时恒 0px（忽略越屏量）",
    maxed,
    `right=${(await page.evaluate(probe)).right}`,
  );

  // 还原恢复态 → 把手重新回到让位后的位置。
  await page.evaluate(
    "window.__bridgeMax = false; for (const cb of window.__bridgeCbs) cb(false)",
  );
  const restored = await page
    .waitForFunction(
      "getComputedStyle(document.querySelector('.rail-tab')).right === '860px'",
      undefined,
      { timeout: 3000, polling: 60 },
    )
    .then(() => true)
    .catch(() => false);
  check(
    "还原回恢复态 again 860px",
    restored,
    `right=${(await page.evaluate(probe)).right}`,
  );

  await page.screenshot({
    path: path.join(OUT, "rail-tab-moved-860.png"),
    fullPage: false,
  });
  const tabShot = await page
    .locator(".rail-tab")
    .screenshot()
    .catch(() => null);
  if (tabShot) fs.writeFileSync(path.join(OUT, "rail-tab.png"), tabShot);
  log(`screenshots → ${OUT}`);
} finally {
  await ctx.close().catch(() => {});
  mock.close();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}

if (failures) {
  console.error(`edge-clip: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("edge-clip: all checks passed");
