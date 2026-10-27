// 发送时聊天跳动的回归测试（DESIGN.md §35.4）。逐帧记录：滚动区在屏幕上的位置（sTop）、scrollTop、发送那一刻视口里
// 一条消息（anchor）的屏幕位置。发送之后任何相邻两帧：滚动区移动、scrollTop 回退 > 24px、anchor 往下跳 > 24px
// 或往上跳 > 120px/帧（比贴底弹簧快；采样隔了几帧按帧数放宽；发送后频道聊天自己开平滑滚动、把新消息滚到顶的那几帧不算）都算跳。ASSERT=1 时不过退出码 1。
// 对象是频道聊天（/channel/*；2026-10-15 CB-046 起机器人聊天只剩这一套）。
// 用法（ChisaBot 镜像里跑 playwright-core，--network host）：
//   BASE=http://127.0.0.1:3092 BOT=<机器人 id> THREAD=<要打开的会话 id，建议用真实长会话的副本> ASSERT=1 node send-jump.mjs
//   场景：W/H（默认 1280×800；窄窗 W=420 H=860）、SCROLLUP=700（发送前上滑）、PROMPT=…（长回复 / 多行）、CPU=4、
//         FAIL=1 TWICE=1（第一轮模拟失败让提示出现，第二轮正常发送让提示消失）、VIDEO=1。输出在 /out。
//         POLLTICK=1（全端同步 §42.7：从第一次发送起到最后一轮结束后 POLLMS 毫秒（默认 6000），把每次 /sync 的回复改成
//         「事件序号变了 + 服务器在回答」，逼同步在本机发送中 / 刚结束时反复尝试接入；必须 0 跳）。
import { chromium } from "playwright-core";
import fs from "node:fs";
const exe = fs.readdirSync("/ms-playwright").find((d) => d.startsWith("chromium-") && !d.includes("headless"));
const browser = await chromium.launch({ executablePath: `/ms-playwright/${exe}/chrome-linux64/chrome`, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const BASE = process.env.BASE || "http://127.0.0.1:3092";
const BOT = process.env.BOT || "knowledge";
const THREAD = process.env.THREAD || "";
const W = Number(process.env.W || 1280), H = Number(process.env.H || 800);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const vp = { width: W, height: H };
const ctx = await browser.newContext({
  viewport: vp, deviceScaleFactor: 1, locale: "zh-CN", timezoneId: "Asia/Shanghai",
  ...(process.env.VIDEO ? { recordVideo: { dir: "/out/video", size: vp } } : {}),
});
await ctx.addInitScript(({ bot, thread }) => {
  try {
    localStorage.setItem("chisabot-theme", "light");
  } catch {}
  const w = window;
  w.__samples = [];
  w.__events = [];
  w.__findScroller = () => {
    const list = document.querySelector("[data-testid=chat-transcript]");
    let el = list?.parentElement;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 2) return el;
      el = el.parentElement;
    }
    return null;
  };
  const topLevel = (s) => [...s.querySelectorAll("[data-message-id]")].filter((e) => !e.parentElement.closest("[data-message-id]"));
  let anchorId = null; // message id pinned at send time (the one at the viewport middle)
  let anchorRef = null;
  let lastList = null, lastScroller = null;
  w.__arm = () => {
    const s = w.__findScroller();
    const sr = s.getBoundingClientRect();
    const mid = sr.top + sr.height * 0.35;
    let best = Infinity;
    for (const e of topLevel(s)) { const r = e.getBoundingClientRect(); if (r.height <= 0) continue; const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid)); if (d < best) { best = d; anchorId = e.dataset.messageId; anchorRef = e; } }
    w.__anchorId = anchorId;
    lastList = document.querySelector("[data-testid=chat-transcript]"); lastScroller = s;
    const mo = new MutationObserver((recs) => {
      if (!w.__sampling) return;
      let removedMsgs = 0, addedMsgs = 0;
      for (const r of recs) {
        for (const n of r.removedNodes) if (n.nodeType === 1 && (n.matches?.("[data-message-id]") || n.querySelector?.("[data-message-id]"))) removedMsgs += n.matches?.("[data-message-id]") ? 1 : n.querySelectorAll("[data-message-id]").length;
        for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches?.("[data-message-id]") || n.querySelector?.("[data-message-id]"))) addedMsgs += n.matches?.("[data-message-id]") ? 1 : n.querySelectorAll("[data-message-id]").length;
      }
      if (removedMsgs || addedMsgs) w.__events.push({ t: Math.round(performance.now()), kind: "dom", removedMsgs, addedMsgs });
    });
    mo.observe(document.querySelector("main") ?? document.body, { childList: true, subtree: true });
  };
  const tick = () => {
    if (w.__sampling) {
      const s = w.__findScroller();
      const list = document.querySelector("[data-testid=chat-transcript]");
      if (s && lastScroller && s !== lastScroller) w.__events.push({ t: Math.round(performance.now()), kind: "scroller-replaced" });
      if (list && lastList && list !== lastList) w.__events.push({ t: Math.round(performance.now()), kind: "list-replaced" });
      lastScroller = s || lastScroller; lastList = list || lastList;
      if (s) {
        const sr = s.getBoundingClientRect();
        const a = anchorId ? s.querySelector(`[data-message-id="${CSS.escape(anchorId)}"]`) : null;
        if (a && a !== anchorRef) { w.__events.push({ t: Math.round(performance.now()), kind: "anchor-remounted" }); anchorRef = a; }
        const ar = a?.getBoundingClientRect();
        // first message whose bottom is inside the viewport
        const all = topLevel(s);
        let firstVis = null, firstVisTop = null;
        for (let i = 0; i < all.length; i++) { const r = all[i].getBoundingClientRect(); if (r.height > 0 && r.bottom > sr.top + 1 && r.top < sr.bottom) { firstVis = i; firstVisTop = Math.round(r.top - sr.top); break; } }
        w.__samples.push({
          t: Math.round(performance.now()), top: Math.round(s.scrollTop), h: s.scrollHeight, ch: s.clientHeight,
          gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
          aTop: ar ? Math.round(ar.top - sr.top) : null, aScr: ar ? Math.round(ar.top) : null, sTop: Math.round(sr.top), aH: ar ? Math.round(ar.height) : null,
          n: all.length, firstVis, firstVisTop,
          running: Boolean(document.querySelector('[data-testid="composer-stop"]')),
          // 发送后那 700ms 频道聊天自己开着平滑滚动（chat-transcript.tsx useSmoothSendScroll），把刚发的消息滚到顶。
          smooth: s.style.scrollBehavior === "smooth",
        });
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, { bot: BOT, thread: THREAD });
// 频道聊天（CB-046，DESIGN.md §68）：`/bot?agent=&thread=` 跳到这条对话的频道（没有频道的旧对话由服务器补一个）。
const page = await ctx.newPage();
let failLeft = process.env.FAIL === "1" ? 1 : 0;
if (failLeft) {
  await page.route(/\/api\/copilotkit/, async (route) => {
    const req = route.request();
    if (failLeft > 0 && req.method() === "POST" && /\/run\b|"runId"/.test(req.url() + (req.postData() || "").slice(0, 400)) && !/connect/.test(req.url())) {
      failLeft--;
      log("FAILING", req.url());
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟上游出错：这一轮没有回答。" }) });
    }
    return route.continue();
  });
}
// POLLTICK=1：发送期间及之后几秒伪造「别处有动静」的同步回复（只改这台看到的 /sync，不碰服务器）。
let pollUntil = 0, pollForced = 0, pollBump = 0;
if (process.env.POLLTICK === "1") {
  await page.route(/\/api\/bot-threads\/[^/]+\/sync/, async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    if (Date.now() < pollUntil) {
      try {
        const j = JSON.parse(body);
        if (j.thread) { j.thread.seq = `${j.thread.seq}-poll${++pollBump}`; j.thread.running = true; pollForced++; body = JSON.stringify(j); }
      } catch {}
    }
    return route.fulfill({ response: res, body });
  });
}
page.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") log("console", m.text().slice(0, 200)); });
if (Number(process.env.CPU || 1) > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU) }); }

// CHANNEL=<频道 id> 直接打开那个频道（不走 /bot 跳转，用来和没有跳转的旧版本对比）。
await page.goto(process.env.CHANNEL ? `${BASE}/channel/${process.env.CHANNEL}` : `${BASE}/bot?agent=${BOT}${THREAD ? `&thread=${encodeURIComponent(THREAD)}` : ""}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[aria-label="消息"]', { timeout: 40000 });
await page.waitForFunction(() => document.querySelectorAll("[data-testid=chat-transcript] [data-message-id]").length > 0, null, { timeout: 40000 }).catch(() => log("no messages rendered"));
await page.waitForTimeout(Number(process.env.WAIT || 6000));
const box = await page.evaluate(() => { const r = window.__findScroller().getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
if (process.env.SCROLLUP) {
  await page.mouse.move(box.x, box.y);
  const px = Number(process.env.SCROLLUP);
  for (let i = 0; i < Math.ceil(px / 100); i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(40); }
  await page.waitForTimeout(1500);
}
const s0 = await page.evaluate(() => { const s = window.__findScroller(); return { top: s.scrollTop, h: s.scrollHeight, ch: s.clientHeight, n: document.querySelectorAll("[data-testid=chat-transcript] [data-message-id]").length }; });
log("BEFORE", JSON.stringify(s0));
await page.screenshot({ path: "/out/0-before.png" });
await page.evaluate(() => { window.__arm(); window.__sampling = true; });
await page.waitForTimeout(300);
const RUNMS = Number(process.env.RUNMS || 60000);
async function sendOnce(prompt, tag) {
  const ta = page.locator('[aria-label="消息"]').first();
  await ta.click();
  await ta.fill(prompt);
  const at = await page.evaluate(() => performance.now());
  if (process.env.POLLTICK === "1") pollUntil = Number.POSITIVE_INFINITY;
  await page.keyboard.press("Enter");
  for (const ms of [40, 120, 250, 500, 900, 1500, 2500]) {
    const now = await page.evaluate(() => performance.now());
    const d = at + ms - now; if (d > 0) await page.waitForTimeout(d);
    await page.screenshot({ path: `/out/${tag}s-${String(ms).padStart(4, "0")}.png` });
  }
  const t0 = Date.now(); let idle = 0;
  while (Date.now() - t0 < RUNMS && idle < 4) { idle = (await page.locator('[data-testid="composer-stop"]').count()) ? 0 : idle + 1; await page.waitForTimeout(500); }
  if (process.env.POLLTICK === "1") { pollUntil = Date.now() + Number(process.env.POLLMS || 6000); await page.waitForTimeout(Number(process.env.POLLMS || 6000) + 500); }
  return at;
}
const PROMPT = process.env.PROMPT_B64 ? Buffer.from(process.env.PROMPT_B64, "base64").toString("utf8") : process.env.PROMPT;
const tSend = await sendOnce(PROMPT || "用一句话回答：1+1 等于几？", "");
if (process.env.TWICE === "1") {
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/out/5-between.png" });
  log("BETWEEN", JSON.stringify(await page.evaluate(() => ({ notice: Boolean(document.querySelector('[data-testid="transcript-stopped"]')) }))));
  await sendOnce(process.env.PROMPT2 || "再用一句话回答：2+2 等于几？", "b-");
}
await page.waitForTimeout(1500);
await page.screenshot({ path: "/out/9-end.png" });
const { samples, events, anchorId } = await page.evaluate(() => ({ samples: window.__samples, events: window.__events, anchorId: window.__anchorId }));
const pre = samples.filter((x) => x.t < tSend);
const post = [...(pre.length ? [pre[pre.length - 1]] : []), ...samples.filter((x) => x.t >= tSend)];
fs.writeFileSync("/out/samples.json", JSON.stringify({ tSend, anchorId, samples, events }));
// Analysis (no user input after send): fail if, between two consecutive frames, scrollTop drops > 24px, the anchor message
// moves DOWN on screen > 24px (older history slides into view) or UP > 120px (faster than the stick-to-bottom spring ever
// moves), or the scroller itself moves on screen (sTop changes: something above it appeared / vanished).
const ups = [], anchorDowns = [];
for (let i = 1; i < post.length; i++) {
  const a = post[i - 1], b = post[i];
  if (a.top - b.top > 24) ups.push({ dt: b.t - tSend, from: a.top, to: b.top, h0: a.h, h1: b.h });
  if (a.aTop != null && b.aTop != null && b.aTop - a.aTop > 40) anchorDowns.push({ dt: b.t - tSend, from: a.aTop, to: b.aTop, top0: a.top, top1: b.top, h0: a.h, h1: b.h });
}
const scr = [];
for (let i = 1; i < post.length; i++) {
  const a = post[i - 1], b = post[i];
  // 往上 120px 是「每帧（60fps）」的上限：机器慢、两次采样隔了几帧时按隔了几帧放宽（速度不变）。往下、scrollTop 回退照旧按帧严格算。
  const frames = Math.max(1, (b.t - a.t) / 16.7);
  // 发送时把新消息平滑滚到顶（scroll-behavior: smooth 开着的那几帧）是设计好的动画，不算往上跳；往下跳、回退照旧算。
  const upLimit = a.smooth || b.smooth ? Infinity : 120 * frames;
  if (a.aScr != null && b.aScr != null && (b.aScr - a.aScr > 24 || a.aScr - b.aScr > upLimit || a.sTop !== b.sTop)) scr.push({ dt: b.t - tSend, from: a.aScr, to: b.aScr, sTop0: a.sTop, sTop1: b.sTop, ch0: a.ch, ch1: b.ch, top0: a.top, top1: b.top });
}
log("SCREENJUMPS", JSON.stringify(scr.slice(0, 15)));
const minTop = Math.min(...post.map((x) => x.top));
const minFirstVis = Math.min(...post.filter((x) => x.firstVis != null).map((x) => x.firstVis));
log("RESULT", JSON.stringify({ frames: post.length, anchorId, before: pre[pre.length - 1] ?? s0, upJumps: ups.length, screenJumps: scr.length, screenDownJumps: scr.filter((x) => x.to > x.from).length, anchorDownJumps: anchorDowns.length, minTopAfterSend: minTop, firstVisAtSend: post[0]?.firstVis, minFirstVis, endGap: post[post.length - 1]?.gap }));
log("UPS", JSON.stringify(ups.slice(0, 15)));
log("ANCHORDOWN", JSON.stringify(anchorDowns.slice(0, 15)));
log("EVENTS", JSON.stringify(events.slice(0, 30).map((e) => ({ ...e, dt: e.t - tSend }))));
if (process.env.POLLTICK === "1") log("POLLTICK", JSON.stringify({ forcedSyncReplies: pollForced }));
// 发出去的消息不许消失（失败的那条也留在本机，§42.7）：发送后任何一次 DOM 变化删掉了消息就算失败。
const removed = events.filter((e) => e.kind === "dom" && e.removedMsgs > 0 && e.t >= tSend);
if (removed.length) log("REMOVED", JSON.stringify(removed.map((e) => ({ dt: e.t - tSend, n: e.removedMsgs }))));
const bad = scr.length + ups.length + (process.env.ALLOW_REMOVE === "1" ? 0 : removed.length);
log(bad ? "FAIL send-jump" : "PASS send-jump", JSON.stringify({ screenJumps: scr.length, upJumps: ups.length, removed: removed.length }));
await ctx.close();
await browser.close();
process.exit(bad && process.env.ASSERT === "1" ? 1 : 0);
