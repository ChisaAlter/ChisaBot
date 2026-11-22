#!/usr/bin/env node
// 竖屏 / 窄窗点击右侧面板抽屉与展开左侧窄边栏的滚动零回跳真机回归（复用 perf/mock-server.mjs，无需后端）。
//
// 覆盖四类核心场景：
//   1. 420×860 贴底开关右侧面板 Sheet：paddingRight 零变动、ΔscrollHeight ≤ 2px、峰值 gap ≤ 4px、smooth 调用 = 0；
//   2. 420×860 上滑 500px 读历史时开关右侧面板 Sheet：第一条可见消息 ID 不变、偏移 ≤ 4px、不被夹回底部；
//   3. 420×860 流式 toolTurn 期间打开面板 Sheet：无全屏空白帧（firstVis !== null）、不因开面板暴涨 .chat-slack；
//   4. 780×1050 折叠 BotMiniRail 展开/收起左侧边栏：全程无 smooth / auto 平滑回追动画。
//
// 用法：
//   node tests/chat-scroll/portrait-panel-jump.mjs [--dist app/dist] [--chrome <path>]
// 需要先构建前端产物（bun run generate:app-config && bun run --cwd app build）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startMockServer } from "../../perf/mock-server.mjs";
import { resolveBrowserExecutable } from "../../scripts/verify-ui.mjs";

const { values: opts } = parseArgs({
  options: {
    dist: { type: "string", default: "app/dist" },
    chrome: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help) {
  console.log(
    "node tests/chat-scroll/portrait-panel-jump.mjs [--dist app/dist] [--chrome <path>]",
  );
  process.exit(0);
}

const DIST = path.resolve(opts.dist);
if (!fs.existsSync(path.join(DIST, "index.html"))) {
  throw new Error(`未找到构建产物 ${DIST}，请先构建 app/dist`);
}
const CHROME =
  opts.chrome || process.env.CHROME_PATH || resolveBrowserExecutable();
if (!CHROME) {
  throw new Error("未找到本机 Edge/Chrome/Chromium，请通过 --chrome 指定");
}

const INIT_SCRIPT = `(() => {
  window.__scrollLog = [];
  window.__frames = [];
  window.__recording = false;
  window.__label = "";
  const idOf = (el) => el?.dataset?.slot || el?.tagName || "?";
  for (const fn of ["scrollTo", "scroll"]) {
    const orig = Element.prototype[fn];
    if (!orig) continue;
    Element.prototype[fn] = function (...args) {
      if (window.__recording && this.dataset?.slot === "message-scroller-viewport") {
        const o = args[0];
        window.__scrollLog.push({
          label: window.__label,
          fn,
          el: idOf(this),
          top: o && typeof o === "object" ? o.top : args[0],
          behavior: o && typeof o === "object" ? o.behavior : undefined,
        });
      }
      return orig.apply(this, args);
    };
  }
  function sample() {
    if (window.__recording) {
      const vp = document.querySelector('[data-testid="kept-page"][data-visible="true"] [data-slot="message-scroller-viewport"]')
        || document.querySelector('[data-slot="message-scroller-viewport"]');
      const ct = vp?.querySelector('[data-testid="chat-transcript"]');
      if (vp && ct) {
        const vr = vp.getBoundingClientRect();
        let firstId = null;
        let firstTop = null;
        for (const row of ct.querySelectorAll('[data-message-id]')) {
          const box = row.getBoundingClientRect();
          if (box.height <= 0) continue;
          if (box.bottom > vr.top + 1 && box.top < vr.bottom) {
            firstId = row.dataset.messageId;
            firstTop = Math.round(box.top - vr.top);
            break;
          }
        }
        const cs = getComputedStyle(ct);
        const slack = ct.querySelector('[data-chat-slack]');
        window.__frames.push({
          label: window.__label,
          st: Math.round(vp.scrollTop),
          sh: vp.scrollHeight,
          ch: vp.clientHeight,
          gap: Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight),
          pr: cs.paddingRight,
          slackH: slack ? Math.round(slack.getBoundingClientRect().height) : 0,
          firstId,
          firstTop,
        });
      }
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

async function rmDir(dir) {
  for (let i = 0; i < 6; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runSession(width, height, config, fn) {
  const mock = await startMockServer({ dist: DIST, toolTurn: config.toolTurn });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cb-portrait-jump-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: true,
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    args: ["--no-first-run", "--mute-audio"],
  });
  try {
    await ctx.addInitScript(INIT_SCRIPT);
    await ctx.addInitScript(() => {
      window.chisabotWindow = {
        platform: "win32",
        minimize() {},
        toggleMaximize() {},
        close() {},
        async isMaximized() {
          return false;
        },
        onMaximizedChange() {
          return () => {};
        },
        toggleCompact() {},
        async isCompact() {
          return true;
        },
        onCompactChange() {
          return () => {};
        },
      };
    });
    if (config.sidebar) {
      await ctx.addInitScript(
        (state) => localStorage.setItem("chisabot-sidebar", state),
        config.sidebar,
      );
    }
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${mock.base}/channel/c1`, {
      waitUntil: "load",
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-message-id]").length > 40,
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(2600);
    await page.evaluate(() => {
      const vp = document.querySelector(
        '[data-slot="message-scroller-viewport"]',
      );
      if (vp) vp.scrollTo({ top: vp.scrollHeight, behavior: "instant" });
    });
    await page.waitForTimeout(250);

    const record = async (label, actionFn, waitMs = 950) => {
      await page.evaluate((name) => {
        window.__label = name;
        window.__recording = true;
      }, label);
      await page.waitForTimeout(60);
      await actionFn();
      await page.waitForTimeout(waitMs);
      await page.evaluate(() => {
        window.__recording = false;
      });
    };

    await fn(page, record);
    return await page.evaluate(() => ({
      frames: window.__frames,
      logs: window.__scrollLog,
    }));
  } finally {
    await ctx.close().catch(() => {});
    mock.close();
    await rmDir(profile);
  }
}

const failures = [];
function check(ok, message) {
  if (ok) {
    console.log(`PASS: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failures.push(message);
  }
}

// 场景 1 & 2：420×860 贴底与上滑 500px 开关面板 Sheet
{
  const { frames, logs } = await runSession(
    420,
    860,
    {},
    async (page, record) => {
      await record("open-bottom", () =>
        page.locator(".rail-tab.is-narrow").click(),
      );
      await record("close-bottom", () =>
        page.locator('[data-testid="panel-sheet-close"]').click(),
      );
      await page.evaluate(() => {
        const vp = document.querySelector(
          '[data-slot="message-scroller-viewport"]',
        );
        if (vp)
          vp.scrollTo({
            top: Math.max(0, vp.scrollHeight - vp.clientHeight - 500),
            behavior: "instant",
          });
      });
      await page.waitForTimeout(250);
      await record("open-mid", () =>
        page.locator(".rail-tab.is-narrow").click(),
      );
      await record("close-mid", () =>
        page.locator('[data-testid="panel-sheet-close"]').click(),
      );
    },
  );

  for (const label of ["open-bottom", "close-bottom"]) {
    const f = frames.filter((x) => x.label === label);
    const l = logs.filter((x) => x.label === label);
    const base = f[0];
    const maxGap = Math.max(...f.map((x) => x.gap));
    const maxShDelta = Math.max(...f.map((x) => Math.abs(x.sh - base.sh)));
    const prChanged = f.some((x) => x.pr !== base.pr);
    const smoothCalls = l.filter(
      (c) => c.behavior === "smooth" || c.behavior === "auto",
    ).length;
    check(
      !prChanged && maxShDelta <= 2 && maxGap <= 4 && smoothCalls === 0,
      `420×860 [${label}] prChanged=${prChanged} dSh=${maxShDelta} maxGap=${maxGap} smoothCalls=${smoothCalls}`,
    );
  }

  const openMid = frames.filter((x) => x.label === "open-mid");
  const closeMid = frames.filter((x) => x.label === "close-mid");
  const midStart = openMid[0];
  const midEnd = closeMid[closeMid.length - 1];
  const midDelta = Math.abs((midEnd.firstTop ?? 0) - (midStart.firstTop ?? 0));
  check(
    midEnd.firstId === midStart.firstId && midDelta <= 4 && midEnd.gap > 400,
    `420×860 [midscroll open/close] ${midStart.firstId}@${midStart.firstTop} -> ${midEnd.firstId}@${midEnd.firstTop} (gap=${midEnd.gap})`,
  );
}

// 场景 3：420×860 流式 toolTurn 期间开关面板 Sheet 无整屏空白
{
  const { frames } = await runSession(
    420,
    860,
    { toolTurn: { holdMs: 4000 } },
    async (page, record) => {
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await page.keyboard.type("测试流式开关面板");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(900);
      await record("busy-open", () =>
        page.locator(".rail-tab.is-narrow").click(),
      );
      await record("busy-close", () =>
        page.locator('[data-testid="panel-sheet-close"]').click(),
      );
    },
  );
  const busyFrames = frames.filter(
    (x) => x.label === "busy-open" || x.label === "busy-close",
  );
  const blankFrames = busyFrames.filter((x) => x.firstId === null).length;
  const maxSlack = Math.max(...busyFrames.map((x) => x.slackH));
  check(
    blankFrames === 0 && maxSlack < 300,
    `420×860 [busy-panel] blankFrames=${blankFrames} maxSlack=${maxSlack}px`,
  );
}

// 场景 4：780×1050 折叠 BotMiniRail 展开/收起左侧边栏无平滑回追
{
  const { frames, logs } = await runSession(
    780,
    1050,
    { sidebar: "collapsed" },
    async (page, record) => {
      await record("expand-sidebar", () =>
        page.locator(".glass-mini-toggle").click(),
      );
      await record("collapse-sidebar", () =>
        page.locator(".side-search-row .glass-roster-toggle").click(),
      );
    },
  );
  for (const label of ["expand-sidebar", "collapse-sidebar"]) {
    const f = frames.filter((x) => x.label === label);
    const l = logs.filter((x) => x.label === label);
    const smoothOrAuto = l.filter(
      (c) => c.behavior === "smooth" || c.behavior === "auto",
    ).length;
    const end = f[f.length - 1];
    check(
      smoothOrAuto === 0 && end.gap <= 4,
      `780×1050 [${label}] smoothOrAuto=${smoothOrAuto} endGap=${end.gap}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n共 ${failures.length} 项回归检查失败`);
  process.exit(1);
}
console.log("\n全部竖屏面板/侧栏滚动回归检查通过");
