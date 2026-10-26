// 弹窗关闭性能探针（DESIGN.md §37）：新建机器人向导的四条关闭路径（取消 / × / Esc / 点遮罩），4× CPU 降速。
// 用法（在 chisabot 镜像里，host 网络）：node close-perf.mjs  env: BASE, CPU(4), N(5), PATHS, TRACE=1, DARK=1, READONLY=1（拦截所有非 GET，对生产只读）, CSS（注入试验样式）
// 输出 /out/summary.json、/out/open-*.png、/out/closed-*.png、/out/trace/*.json
import { chromium } from "playwright-core";
import fs from "node:fs";
const exe = fs.readdirSync("/ms-playwright").find((d) => d.startsWith("chromium-") && !d.includes("headless"));
const browser = await chromium.launch({ executablePath: `/ms-playwright/${exe}/chrome-linux64/chrome`, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const BASE = process.env.BASE || "http://127.0.0.1:3096";
const CPU = Number(process.env.CPU || 4);
const N = Number(process.env.N || 5);
const PATHS = (process.env.PATHS || "cancel,x,esc,backdrop").split(",");
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
await ctx.addInitScript((dark) => {
  try { localStorage.setItem("chisabot-theme", dark ? "dark" : "light"); } catch {}
  const w = window;
  w.__rec = null;
  w.__frames = [];
  const tick = (t) => { if (w.__rec) w.__frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (w.__rec) w.__rec.lt.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: "longtask" }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (w.__rec) w.__rec.ev.push({ n: e.name, s: Math.round(e.startTime), d: Math.round(e.duration), proc: Math.round(e.processingEnd - e.processingStart), wait: Math.round(e.processingStart - e.startTime) }); }).observe({ type: "event", durationThreshold: 16, buffered: false }); } catch {}
  for (const type of ["pointerdown", "keydown"]) addEventListener(type, (e) => { if (w.__rec && w.__rec.input == null) w.__rec.input = e.timeStamp; }, true);
  w.__arm = () => {
    w.__frames = [];
    w.__rec = { input: null, gone: null, lt: [], ev: [], outsideMut: 0, armedAt: performance.now() };
    const pop = document.querySelector('[data-slot="dialog-content"]');
    const portal = pop?.closest("[data-base-ui-portal]") || pop?.parentElement;
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (portal && portal.contains(m.target)) continue;
        if (m.target.closest && m.target.closest('[data-slot="dialog-overlay"],[data-slot="dialog-content"]')) continue;
        w.__rec.outsideMut++;
      }
      if (!w.__rec.gone && !document.querySelector('[data-slot="dialog-content"]')) w.__rec.gone = performance.now();
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    w.__mo = mo;
  };
  w.__collect = () => {
    w.__mo?.disconnect();
    const r = w.__rec; w.__rec = null;
    const from = r.input ?? r.armedAt;
    const end = (r.gone ?? performance.now()) + 200;
    const fr = w.__frames.filter((t) => t >= from - 20 && t <= end);
    const gaps = []; for (let i = 1; i < fr.length; i++) gaps.push(Math.round(fr[i] - fr[i - 1]));
    const firstFrame = fr.find((t) => t > from);
    return {
      clickToGone: r.gone && r.input ? Math.round(r.gone - r.input) : null,
      inputToFirstFrame: firstFrame && r.input ? Math.round(firstFrame - r.input) : null,
      frames: fr.length, maxGap: gaps.length ? Math.max(...gaps) : null, janky: gaps.filter((g) => g > 34).length,
      fps: fr.length > 1 ? Math.round((fr.length - 1) / ((fr[fr.length - 1] - fr[0]) / 1000)) : null,
      longTasks: r.lt.filter((x) => x.s >= from - 5), ltSum: r.lt.filter((x) => x.s >= from - 5).reduce((a, b) => a + b.d, 0),
      events: r.ev, outsideMut: r.outsideMut,
    };
  };
}, process.env.DARK === "1");
if (process.env.READONLY === "1") await ctx.route("**/*", (r) => { const m = r.request().method(); if (m === "GET" || m === "HEAD" || m === "OPTIONS") return r.continue(); return r.fulfill({ status: 204, body: "" }); });
const page = await ctx.newPage();
const reqs = [];
let capReq = false;
page.on("request", (r) => { if (capReq) reqs.push(`${r.method()} ${r.url().replace(BASE, "")}`); });
page.on("pageerror", (e) => log("pageerror", e.message));
await page.goto(BASE + "/", { waitUntil: "networkidle" }).catch(() => {});
await page.waitForTimeout(3000);
log("url", page.url()); await page.screenshot({ path: "/out/bg.png" }); log("dom nodes", await page.evaluate(() => document.querySelectorAll("*").length));
if (process.env.CSS) await page.addStyleTag({ content: process.env.CSS });
const cdp = await ctx.newCDPSession(page);
if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });

async function openDialog() {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
  await page.keyboard.press("Shift+N");
  try { await page.waitForSelector('[data-slot="dialog-content"]', { timeout: 4000 }); }
  catch {
    const plus = page.locator('[aria-label*="新建机器人"], [title*="新建机器人"]').first();
    await plus.click();
    await page.waitForSelector('[data-slot="dialog-content"]', { timeout: 8000 });
  }
  await page.waitForTimeout(900);
  await page.fill("#create-agent-name", "测试机器人");
  await page.fill("#create-agent-role", "这是一个用来测量关闭速度的草稿。");
  await page.waitForTimeout(400);
  if (!globalThis.__styled) { globalThis.__styled = 1; log("computed", JSON.stringify(await page.evaluate(() => { const c = getComputedStyle(document.querySelector('[data-slot="dialog-content"]')); const o = document.querySelector('[data-slot="dialog-overlay"]'); const oc = o && getComputedStyle(o); return { popBf: c.backdropFilter, popBg: c.backgroundColor, popTr: c.transition, ovBf: oc?.backdropFilter, ovBg: oc?.backgroundColor, ovTr: oc?.transition, dpr: devicePixelRatio, bodyBf: [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).backdropFilter !== "none").length }; }))); }
}
async function doClose(p) {
  if (p === "cancel") await page.getByRole("button", { name: "取消", exact: true }).click();
  else if (p === "x") await page.locator('[data-slot="dialog-content"] [data-slot="dialog-close"]').last().click();
  else if (p === "esc") { await page.focus("#create-agent-name"); await page.keyboard.press("Escape"); }
  else if (p === "backdrop") await page.mouse.click(60, 400);
}

const out = {};

const idle = await page.evaluate(async () => { const fr = []; await new Promise((r) => { const t0 = performance.now(); const f = (t) => { fr.push(t); if (t - t0 < 1000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); }); const g = []; for (let i = 1; i < fr.length; i++) g.push(fr[i] - fr[i - 1]); return { fps: fr.length - 1, maxGap: Math.round(Math.max(...g)) }; });
log("idle", JSON.stringify(idle));
const traceDir = "/out/trace"; fs.mkdirSync(traceDir, { recursive: true });
for (const p of PATHS) {
  out[p] = [];
  for (let i = 0; i < N; i++) {
    await openDialog();
    if (i === 0) await page.screenshot({ path: `/out/open-${p}.png` });
    const tracing = process.env.TRACE === "1" && i === 1;
    let chunks = [];
    if (tracing) {
      cdp.removeAllListeners("Tracing.dataCollected");
      cdp.on("Tracing.dataCollected", (e) => chunks.push(...e.value));
      await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8.execute,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
    }
    if (p === "esc") await page.focus("#create-agent-name");
    await page.evaluate(() => window.__arm());
    reqs.length = 0; capReq = true;
    await doClose(p);
    await page.waitForFunction(() => !document.querySelector('[data-slot="dialog-content"]'), null, { timeout: 15000 }).catch(() => log("NOT GONE", p));
    await page.waitForTimeout(500);
    capReq = false;
    const m = await page.evaluate(() => window.__collect());
    m.requests = [...reqs];
    if (i === 0) await page.screenshot({ path: `/out/closed-${p}.png` });
    if (tracing) {
      const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
      await cdp.send("Tracing.end"); await done;
      fs.writeFileSync(`${traceDir}/${p}.json`, JSON.stringify({ traceEvents: chunks }));
      // summarize main-thread event self-ish totals by name after the input
      const main = chunks.filter((e) => e.ph === "X" && e.dur);
      const tot = {};
      for (const e of main) if (["Layout", "UpdateLayoutTree", "Paint", "PrePaint", "Layerize", "FunctionCall", "EvaluateScript", "MajorGC", "MinorGC", "V8.GC_SCAVENGER", "RunTask", "ParseHTML", "HitTest", "Commit", "RasterTask", "IntersectionObserverController::computeIntersections", "UpdateLayer", "CompositeLayers", "ScrollAnimation", "EventDispatch", "TimerFire", "FireAnimationFrame"].includes(e.name)) { tot[e.name] ??= { n: 0, ms: 0, max: 0 }; tot[e.name].n++; tot[e.name].ms += e.dur / 1000; tot[e.name].max = Math.max(tot[e.name].max, e.dur / 1000); }
      for (const k of Object.keys(tot)) { tot[k].ms = Math.round(tot[k].ms); tot[k].max = Math.round(tot[k].max); }
      m.trace = tot;
    }
    log(p, i, JSON.stringify(m));
    out[p].push(m);
    await page.waitForTimeout(600);
  }
}
const sum = {};
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
for (const [p, runs] of Object.entries(out)) sum[p] = {
  clickToGone_med: med(runs.map((r) => r.clickToGone)), inputToFirstFrame_med: med(runs.map((r) => r.inputToFirstFrame)),
  maxGap_med: med(runs.map((r) => r.maxGap)), maxGap_worst: Math.max(...runs.map((r) => r.maxGap || 0)), fps_med: med(runs.map((r) => r.fps)),
  ltSum_med: med(runs.map((r) => r.ltSum)), ltMax_worst: Math.max(0, ...runs.flatMap((r) => r.longTasks.map((x) => x.d))),
  eventDur_med: med(runs.map((r) => Math.max(0, ...r.events.map((e) => e.d)))), outsideMut_med: med(runs.map((r) => r.outsideMut)),
  requests: [...new Set(runs.flatMap((r) => r.requests))],
};
fs.writeFileSync("/out/summary.json", JSON.stringify({ cpu: CPU, n: N, sum, out }, null, 1));
log("SUMMARY", JSON.stringify(sum, null, 1));
await browser.close();
