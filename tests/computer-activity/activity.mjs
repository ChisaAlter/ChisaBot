// CB-101 验收：计算机活动面板。真浏览器 × 4 个尺寸 × web / pc 两种外壳。
// BASE=http://127.0.0.1:3210 BOT=<id> DATABASE_URL=… OUT=… node tests/computer-activity/activity.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const base = process.env.BASE || "http://127.0.0.1:3210";
const bot = process.env.BOT;
const out = process.env.OUT || "/workspace/cb-reqs/CB-101/after";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
fs.mkdirSync(out, { recursive: true });
const SIZES = [[360, 800], [390, 844], [768, 1024], [1280, 800]];
const MODES = ["web", "pc"];
// 一张 1280×800 的灰色 PNG 太大，用 16×10 的放大显示就够了：预览只要「有画面」。
const PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAA7N+mxAAAAFklEQVR4nGP8//8/AymAiST1oxpGNQAAkfMDEaoCq5oAAAAASUVORK5CYII=";

const seed = (phase) =>
  execFileSync("bun", ["tests/computer-activity/seed.ts", phase], {
    cwd: repo,
    env: { ...process.env, BOT: bot },
    stdio: "inherit",
  });

const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const results = [];

async function open(mode, [width, height], { live = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", timezoneId: "Asia/Shanghai", deviceScaleFactor: 1, isMobile: false });
  if (mode === "pc") {
    await context.addInitScript(() => {
      const noop = () => () => undefined;
      window.chisabotWindow = { platform: "win32", minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onMaximizedChange: noop, toggleCompact() {}, isCompact: async () => false, onCompactChange: noop };
      window.chisabotPC = { state: async () => ({}), setLocal: async () => ({}), checkUpdate: async () => ({}), installUpdate: async () => ({}), pickFolders: async () => [], enroll: async () => ({}), reconnect: async () => ({}), logout: async () => ({}), onChange: noop };
    });
  }
  await context.route("**/api/computers/*/status", (route) => route.fulfill({ json: { botId: bot, state: "ready" } }));
  await context.route("**/api/computers/*/screenshot*", (route) =>
    live
      ? route.fulfill({ status: 503, json: { error: "capture busy", captureBusy: true, liveCast: true } })
      : route.fulfill({ json: { base64: PNG, url: "https://example.com/", title: "Example Domain", width: 1280, height: 800 } }),
  );
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`${base}/channel/new?agent=${bot}&watch=true`, { waitUntil: "domcontentloaded" });
  await page.locator(".activity-log").first().waitFor({ timeout: 45_000 });
  await page.waitForTimeout(800);
  return { context, page, pageErrors };
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [];
    if (doc.scrollWidth > doc.clientWidth + 1) offenders.push(`document ${doc.scrollWidth}>${doc.clientWidth}`);
    for (const element of document.querySelectorAll(".activity-log, .activity-scroll, .activity-step, .computer-status")) {
      const rect = element.getBoundingClientRect();
      if (rect.width && element.scrollWidth > element.clientWidth + 1) offenders.push(`${element.className} ${element.scrollWidth}>${element.clientWidth}`);
      if (rect.right > window.innerWidth + 1) offenders.push(`${element.className} right ${Math.round(rect.right)}>${window.innerWidth}`);
    }
    return offenders;
  });
}

try {
  const me = await (await fetch(`${base}/api/me`)).json();
  await fetch(`${base}/api/me/onboarding`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ completed: true }) });
  await fetch(`${base}/api/me/profile`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "活动验收" }) });
  process.env.USER_ID = me.user.id;

  for (const mode of MODES) {
    for (const size of SIZES) {
      const label = `${mode}-${size[0]}x${size[1]}`;
      seed("history");
      const { context, page, pageErrors } = await open(mode, size);
      const log = page.locator(".activity-log").first();
      const text = await log.innerText();
      // 合并命令
      assert.match(text, /运行了 4 条命令/, `${label}: merged commands`);
      // 失败的命令不并进去，单独显示「失败 · 退出码 1」
      assert.match(text, /失败 · 退出码 1/, `${label}: failed command on its own`);
      // 拒绝：给人看的状态，不显示给模型的原文
      assert.match(text, /已拒绝：电脑当前由你控制/, `${label}: refused state`);
      assert.doesNotMatch(text, /接管|没有执行/, `${label}: no model-facing text`);
      // 打码：URL 里的 token、密码框里的字、人自己输入的内容
      assert.doesNotMatch(text, /SECRET123|hunter2|私人内容/, `${label}: masking`);
      assert.match(text, /token=••••/, `${label}: masked token visible as ••••`);
      assert.match(text, /你\s*输入了文字/, `${label}: human step labelled 你`);
      // 组头是你那句话
      assert.match(text, /帮我看看 example\.com/, `${label}: turn prompt`);
      await page.screenshot({ path: path.join(out, `${label}.png`) });

      // 展开合并的那行：4 条命令逐条可见
      await log.locator("[data-activity-batch] > button").first().click();
      assert.equal(await log.locator("[data-activity-batch] .activity-batch-list > li").count(), 4, `${label}: batch expands`);

      // 淡入且不跳：先往下滚，记住眼前那一行的位置，再来一条新记录
      const scroller = log.locator(".activity-scroll");
      const scrollable = await scroller.evaluate((element) => element.scrollHeight > element.clientHeight + 40);
      assert(scrollable, `${label}: activity list scrolls`);
      await scroller.evaluate((element) => { element.scrollTop = 160; element.dispatchEvent(new Event("scroll")); });
      await page.waitForTimeout(300);
      const anchor = await scroller.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll("[data-activity-step]")].find((r) => r.getBoundingClientRect().top >= top);
        return { id: row?.getAttribute("data-activity-step"), y: row?.getBoundingClientRect().top };
      });
      seed("live");
      await log.locator(".activity-unseen").waitFor({ timeout: 10_000 });
      const after = await page.evaluate((id) => document.querySelector(`[data-activity-step="${id}"]`)?.getBoundingClientRect().top, anchor.id);
      const jump = Math.abs((after ?? 0) - (anchor.y ?? 0));
      assert(jump <= 2, `${label}: scroll stayed put (moved ${jump}px)`);
      const unseen = await log.locator(".activity-unseen").innerText();
      assert.match(unseen, /条新记录/);
      await log.locator(".activity-unseen").click();
      await page.waitForTimeout(500);
      const freshCount = await log.locator(".activity-step.is-fresh").count();
      assert(freshCount >= 1, `${label}: new entry highlighted`);
      const liveText = await log.innerText();
      assert.match(liveText, /example\.org\/login\?code=••••/, `${label}: live URL masked`);
      assert.doesNotMatch(liveText, /OTP999/);
      await page.screenshot({ path: path.join(out, `${label}-fresh.png`) });
      const offenders = await overflow(page);
      await context.close();

      // 大屏直播：预览让路，状态行说清楚
      const liveRun = await open(mode, size, { live: true });
      await liveRun.page.locator(".computer-status[data-casting]").waitFor({ timeout: 15_000 });
      const status = await liveRun.page.locator(".computer-status").first().innerText();
      assert.match(status, /画面正在大屏直播/, `${label}: live-cast status`);
      if (size[0] === 1280 || size[0] === 390) await liveRun.page.screenshot({ path: path.join(out, `${label}-live.png`) });
      const liveOffenders = await overflow(liveRun.page);
      await liveRun.context.close();

      const errors = [...pageErrors, ...liveRun.pageErrors];
      results.push({ label, overflow: offenders.length + liveOffenders.length, offenders: [...offenders, ...liveOffenders], pageErrors: errors.length, errors, scrollJumpPx: jump, pass: true });
      assert.equal(offenders.length + liveOffenders.length, 0, `${label}: overflow ${JSON.stringify([...offenders, ...liveOffenders])}`);
      assert.equal(errors.length, 0, `${label}: page errors ${errors.join(" | ")}`);
      console.log(`ok ${label} jump=${jump}px`);
    }
  }
} finally {
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
