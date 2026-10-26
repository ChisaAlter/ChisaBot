// Scroll-jump repro for the bot chat against the side preview + mock model.
// PHASE=seed (N turns "SEED i") | stream (reload, send LONG/TOOLS, sample scroll per frame)
// env: N, PROMPT (LONG|TOOLS), MOBILE=1, SCROLLUP=1 (user wheels up mid-stream), VIDEO=1, CPU
import { chromium } from "playwright-core";
import fs from "node:fs";
const exe = fs.readdirSync("/ms-playwright").find((d) => d.startsWith("chromium-") && !d.includes("headless"));
const browser = await chromium.launch({ executablePath: `/ms-playwright/${exe}/chrome-linux64/chrome`, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const BASE = process.env.BASE || "http://127.0.0.1:3097";
const BOT = process.env.BOT;
const PHASE = process.env.PHASE || "stream";
const MOBILE = process.env.MOBILE === "1";
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const vp = MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 };
const ctx = await browser.newContext({
  ...(process.env.STATE && fs.existsSync(process.env.STATE) ? { storageState: process.env.STATE } : {}),
  viewport: vp, deviceScaleFactor: 1, locale: "zh-CN", timezoneId: "Asia/Shanghai",
  ...(MOBILE ? { isMobile: true, hasTouch: true } : {}),
  ...(process.env.VIDEO ? { recordVideo: { dir: "/out/video", size: vp } } : {}),
});
await ctx.addInitScript((lite) => {
  window.__lite = lite;
  try { localStorage.setItem("chisabot-theme", "light"); } catch {}
  const w = window;
  w.__samples = [];
  w.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (w.__sampling) w.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch {}
  w.__findScroller = () => {
    const list = document.querySelector("[data-testid=chat-transcript]");
    let el = list?.parentElement;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return null;
  };
  const tick = () => {
    if (w.__sampling) {
      const found = w.__lite && w.__fixed ? w.__fixed : w.__findScroller();
      w.__fixed ??= found;
      if (found && w.__fixed && !w.__fixed.isConnected) { w.__swaps = (w.__swaps || 0) + 1; w.__fixed = found; }
      const s = w.__fixed;
      if (s) {
        const msgs = document.querySelectorAll("[data-testid=chat-transcript] [data-cb-turn]");
        const last = msgs[msgs.length - 1];
        const r = last?.getBoundingClientRect();
        const sr = s.getBoundingClientRect();
        const lastText = (last?.textContent || "").length;
        w.__samples.push({
          t: Math.round(performance.now()), top: Math.round(s.scrollTop), h: s.scrollHeight, ch: s.clientHeight,
          gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
          lastBottom: r ? Math.round(r.bottom - sr.top) : null, lastTop: r ? Math.round(r.top - sr.top) : null, lastText,
          running: Boolean(document.querySelector('[data-testid="composer-stop"]')), same: found === s, minIdx: w.__lite ? null : (() => { let m = 1e9; const sr2 = s.getBoundingClientRect(); for (const el of s.querySelectorAll('[data-index]')) { const rr = el.getBoundingClientRect(); if (rr.bottom > sr2.top && rr.top < sr2.bottom && rr.height > 0) m = Math.min(m, Number(el.dataset.index)); } return m === 1e9 ? null : m; })(), firstVis: w.__lite ? null : (() => { const sr3 = s.getBoundingClientRect(); const all = [...s.querySelectorAll('[data-message-id]')].filter((e) => !e.parentElement.closest('[data-message-id]')); for (let i = 0; i < all.length; i++) { const e = all[i]; const rr = e.getBoundingClientRect(); if (rr.height > 0 && rr.bottom > sr3.top + 1 && rr.top < sr3.bottom) { const row = e.closest('[data-index]'); return row ? Number(row.dataset.index) : i; } } return null; })(), maxIdx: w.__lite ? null : (() => { let m = -1; for (const el of s.querySelectorAll('[data-index]')) m = Math.max(m, Number(el.dataset.index)); return m; })(), fch: found ? found.clientHeight : null, fcls: found && found !== s ? (found.className || found.tagName).toString().slice(0, 80) : undefined, conn: s.isConnected,
        });
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, process.env.LITE === "1");
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));
if (Number(process.env.CPU || 1) > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU) }); }

async function open() {
  await page.goto(`${BASE}/bot?agent=${BOT}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[aria-label="消息"]', { timeout: 30000 });
  const tl = Date.now();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=chat-transcript] [data-message-id]").length > 0, null, { timeout: 30000 }).catch(() => {});
  log("LOAD", JSON.stringify({ msToFirstMessages: Date.now() - tl, nodes: await page.evaluate(() => document.querySelectorAll("*").length) }));
  await page.waitForTimeout(5000);
}
async function send(text) {
  const ta = page.locator('[aria-label="消息"]').first();
  await ta.click();
  await ta.fill(text);
  await page.keyboard.press("Enter");
}
async function waitIdle(maxMs = 120000) {
  const t0 = Date.now();
  await page.waitForSelector('[data-testid="composer-stop"]', { timeout: 15000 }).catch(() => {});
  let idle = 0;
  while (Date.now() - t0 < maxMs && idle < 3) {
    idle = (await page.locator('[data-testid="composer-stop"]').count()) ? 0 : idle + 1;
    await page.waitForTimeout(700);
  }
}

if (PHASE === "seed") {
  await open();
  const n = Number(process.env.N || 30);
  const from = Number(process.env.FROM || 1);
  for (let i = from; i < from + n; i++) {
    await send(`SEED ${i}`);
    await waitIdle(30000);
    if (i % 5 === 0) log("seeded", i);
  }
  const count = await page.locator("[data-testid=chat-transcript] [data-message-id]").count();
  log("rendered message nodes", count);
  await ctx.storageState({ path: "/out/state.json" });
}

if (PHASE === "stream") {
  await open();
  const s0 = await page.evaluate(() => { const s = window.__findScroller(); return s && { top: s.scrollTop, h: s.scrollHeight, ch: s.clientHeight }; });
  log("after load", JSON.stringify(s0));
  await page.screenshot({ path: "/out/0-loaded.png" });
  await page.evaluate(() => { window.__sampling = true; });
  let prof = null;
  if (process.env.PROFILE) {
    prof = await ctx.newCDPSession(page);
    await prof.send("Profiler.enable");
    await prof.send("Profiler.setSamplingInterval", { interval: 500 });
    await prof.send("Profiler.start");
    setTimeout(async () => {
      const { profile } = await prof.send("Profiler.stop");
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const self = new Map();
      const dt = profile.timeDeltas; const smp = profile.samples;
      for (let i = 0; i < smp.length; i++) { const n = byId.get(smp[i]); const cf = n.callFrame; const k = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); }
      const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${Math.round(v / 1000)}ms ${k}`);
      log("PROFILE", `\n${top.join("\n")}`);
    }, 12000);
  }
  if (process.env.TRACE) {
    const tr = await ctx.newCDPSession(page);
    const events = [];
    tr.on("Tracing.dataCollected", (e) => events.push(...e.value));
    const done = new Promise((r) => tr.once("Tracing.tracingComplete", r));
    await tr.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
    setTimeout(async () => {
      await tr.send("Tracing.end");
      await done;
      const agg = new Map(); const cnt = new Map();
      for (const e of events) if (e.ph === "X" && e.dur) { agg.set(e.name, (agg.get(e.name) || 0) + e.dur); cnt.set(e.name, (cnt.get(e.name) || 0) + 1); }
      log("TRACE", `\n${[...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${Math.round(v / 1000)}ms x${cnt.get(k)} ${k}`).join("\n")}`);
      const ult = events.filter((e) => e.name === "UpdateLayoutTree" && e.args?.elementCount).map((e) => e.args.elementCount);
      const lay = events.filter((e) => e.name === "Layout" && e.args?.beginData).map((e) => e.args.beginData.dirtyObjects);
      log("TRACE-COUNTS", JSON.stringify({ styleElems_p50: ult.sort((a, b) => a - b)[ult.length >> 1], styleElems_max: ult[ult.length - 1], layoutDirty_p50: lay.sort((a, b) => a - b)[lay.length >> 1], layoutDirty_max: lay[lay.length - 1] }));
    }, 12000);
  }
  await send(process.env.PROMPT || "LONG");
  const t0 = Date.now();
  const shots = [];
  let scrolledUp = false;
  await page.waitForSelector('[data-testid="composer-stop"]', { timeout: 15000 }).catch(() => {});
  let idle = 0;
  let k = 0;
  while (Date.now() - t0 < 90000 && idle < 4) {
    idle = (await page.locator('[data-testid="composer-stop"]').count()) ? 0 : idle + 1;
    if (process.env.SCROLLUP === "1" && !scrolledUp && Date.now() - t0 > 5000) {
      scrolledUp = true;
      const box = await page.evaluate(() => { const r = window.__findScroller().getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(box.x, box.y);
      if (MOBILE) {
        await page.evaluate(() => { const s = window.__findScroller(); s.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true })); s.scrollTop -= 600; });
      } else {
        for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(30); }
      }
      await page.evaluate(() => { window.__userScrolledAt = performance.now(); });
      log("user scrolled up");
    }
    await page.waitForTimeout(500);
    if (k++ % 4 === 0) { const p = `/out/f-${String(k).padStart(3, "0")}.png`; await page.screenshot({ path: p }); shots.push(p); }
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/out/9-end.png" });
  const { samples, userAt } = await page.evaluate(() => ({ samples: window.__samples, userAt: window.__userScrolledAt ?? null }));
  fs.writeFileSync("/out/samples.json", JSON.stringify({ samples, userAt }));
  // Analysis
  let maxGap = 0, maxGapAt = null, bigUpJumps = [], offscreen = 0, firstJump = null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (userAt && b.t >= userAt - 50) break;
    if (b.gap > maxGap) { maxGap = b.gap; maxGapAt = b; }
    if (a.top - b.top > 60) { bigUpJumps.push({ t: b.t, from: a.top, to: b.top, h: b.h }); firstJump ??= b; }
    if (b.lastBottom != null && b.lastBottom < 0) offscreen++;
  }
  const f0 = samples[0]?.firstVis;
  const flashes = samples.filter((x) => (!userAt || x.t < userAt - 50) && x.firstVis != null && f0 != null && x.firstVis < f0);
  log("HISTORY", JSON.stringify({ firstVisAtSend: f0, framesShowingOlderHistory: flashes.length, minFirstVis: flashes.length ? Math.min(...flashes.map((x) => x.firstVis)) : null, firstFlash: flashes[0] ?? null }));
  const after = userAt ? samples.filter((s) => s.t > userAt + 300) : [];
  const userTop = after[0]?.top;
  const yankedDown = after.some((s) => userTop != null && s.top - userTop > 120 && s.gap < 80);
  const userUpJumps = [];
  for (let i = 1; i < after.length; i++) if (after[i - 1].top - after[i].top > 60) userUpJumps.push({ from: after[i - 1].top, to: after[i].top });
  log("RESULT", JSON.stringify({ frames: samples.length, maxGapWhilePinned: maxGap, maxGapAt, upJumpsWhilePinned: bigUpJumps.length, firstJump, lastMsgOffscreenFrames: offscreen, scrolledUp: Boolean(userAt), yankedDown, userUpJumps: userUpJumps.length, endGap: samples[samples.length - 1]?.gap }));
  const lt = await page.evaluate(() => window.__lt);
  const dur = samples.length ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 1;
  log("PERF", JSON.stringify({ fps: Math.round(samples.length / dur), longTasks: lt.length, longTaskMs: lt.reduce((a, b) => a + b, 0), maxLongTask: Math.max(0, ...lt) }));
  log("JUMPS", JSON.stringify(bigUpJumps.slice(0, 12)));
}
await ctx.close();
await browser.close();
