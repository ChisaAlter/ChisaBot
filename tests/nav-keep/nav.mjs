// cb-navkeep: 从 设置 / 待处理 / 设备 切回机器人聊天，是否整页重载、闪白、骨架、滚动丢失、重新拉消息。PREVIEW ONLY（只读导航，不发消息）。
// env: BASE (preview), WIDTHS=1280,390, AGENT=general-assistant, TAG
import { chromium } from "playwright-core";
import fs from "node:fs";
const base = process.env.BASE || "http://127.0.0.1:3297";
const WIDTHS = (process.env.WIDTHS || "1280,390").split(",").map(Number);
const AGENT = process.env.AGENT || "general-assistant";
const TAG = process.env.TAG || "run";
const OUT = "/out";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const exe = (() => { const d = fs.readdirSync("/ms-playwright").find((x) => x.startsWith("chromium-") && !x.includes("headless")); return `/ms-playwright/${d}/chrome-linux64/chrome`; })();
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const results = [];
const check = (ok, what) => { console.log(ok ? "PASS" : "FAIL", what); results.push([ok, what]); };

const DBG = () => {
  window.__scrollLog = [];
  const rec = (what, el, v) => { if (window.__phase !== "away") return; if (!(el instanceof Element) || !el.matches?.('[data-slot="message-scroller-viewport"]')) return; window.__scrollLog.push([Math.round(performance.now()), what, JSON.stringify(v ?? null).slice(0, 80), (new Error().stack || "").split("\n").slice(2, 9).join(" | ").slice(0, 900)]); };
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get() { return d.get.call(this); }, set(v) { rec("scrollTop=", this, v); d.set.call(this, v); } });
  for (const m of ["scrollTo", "scrollBy", "scroll"]) { const o = Element.prototype[m]; Element.prototype[m] = function (...a) { rec(m, this, a); return o.apply(this, a); }; }
  const si = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (...a) { if (window.__phase === "away") window.__scrollLog.push([Math.round(performance.now()), "scrollIntoView", this.className?.toString().slice(0, 60), (new Error().stack || "").split("\n").slice(2, 7).join(" | ").slice(0, 600)]); return si.apply(this, a); };
  const fo = HTMLElement.prototype.focus; HTMLElement.prototype.focus = function (...a) { if (window.__phase === "away") window.__scrollLog.push([Math.round(performance.now()), "focus", (this.getAttribute("aria-label") || this.className?.toString() || this.tagName).slice(0, 60), JSON.stringify(a)]); return fo.apply(this, a); };
  setInterval(() => { if (window.__phase === "away") { const a = document.activeElement; const s = (a?.getAttribute?.("aria-label") || a?.className?.toString() || a?.tagName || "").slice(0, 40); if (window.__lastAct !== s) { window.__lastAct = s; window.__scrollLog.push([Math.round(performance.now()), "active", s, ""]); } } }, 5);
  document.addEventListener("scroll", (e) => { if (window.__phase === "away" && e.target?.matches?.('[data-slot="message-scroller-viewport"]')) window.__scrollLog.push([Math.round(performance.now()), "scroll-event", e.target.scrollTop, ""]); }, true);
};
const INIT = () => {
  window.__loadId = Math.random().toString(36).slice(2);
  window.__frames = []; window.__phase = "load";
  const T0 = performance.now();
  const sample = () => {
    const v = document.querySelector('[data-slot="message-scroller-viewport"]');
    let rows = 0, firstId = null, firstTop = null;
    if (v) {
      const vr = v.getBoundingClientRect();
      for (const r of v.querySelectorAll("[data-testid=kept-page][data-visible=true] [data-message-id]")) {
        const b = r.getBoundingClientRect();
        if (b.height === 0) continue;
        rows++;
        if (firstId === null && b.bottom > vr.top + 4) { firstId = r.getAttribute("data-message-id"); firstTop = Math.round(b.top - vr.top); }
      }
    }
    const rail = document.querySelector('[data-testid="left-rail"]');
    window.__frames.push({
      t: Math.round(performance.now() - T0), ph: window.__phase, path: location.pathname,
      v: v ? 1 : 0, rows, top: v ? Math.round(v.scrollTop) : null, gap: v ? Math.round(v.scrollHeight - v.scrollTop - v.clientHeight) : null,
      firstId, firstTop, vw: v ? v.clientWidth : null, vh: v ? v.clientHeight : null, sh: v ? v.scrollHeight : null,
      skel: [...document.querySelectorAll(".route-skel, .app-skel, .sky-skel-block, .sky-skel-bar, .sky-skel-card, [aria-busy=true]")].filter((e) => e.getClientRects().length).length,
      skelWhat: [...document.querySelectorAll(".route-skel, .app-skel, .sky-skel-block, .sky-skel-bar, .sky-skel-card, [aria-busy=true]")].filter((e) => e.getClientRects().length).slice(0, 3).map((e) => (e.className || e.tagName).toString().slice(0, 50) + "|" + (e.getAttribute("aria-label") || "")).join(","),
      railBots: document.querySelectorAll('[data-testid="left-rail"] .glass-bot-row').length,
      panelBusy: [...document.querySelectorAll(".panel-rail [class*=skel], aside [class*=skel]")].filter((e) => e.getClientRects().length).length,
      railTag: rail ? (rail.__navTag ?? "new") : null,
      ta: document.querySelector('[data-testid=kept-page][data-visible=true] textarea[data-testid="copilot-chat-textarea"]') ? 1 : 0,
    });
    requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = sample; c.port2.postMessage(0); });
  };
  requestAnimationFrame(sample);
};

async function settle(page, ms = 1500) { await page.waitForTimeout(ms); }
async function waitChat(page) {
  await page.waitForURL(/\/channel\//, { timeout: 60000 });
  await page.locator('[data-slot="message-scroller-viewport"] [data-message-id]').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(6000);
}
async function openMenu(page, width) {
  let trig = page.locator('[aria-label="账号与设置"]:visible').first();
  if (!(await trig.count())) {
    const drawer = page.locator('button[aria-label^="打开"]:visible').first();
    if (await drawer.count()) { await drawer.click(); await page.waitForTimeout(500); }
    trig = page.locator('[aria-label="账号与设置"]:visible').first();
  }
  await trig.click();
  await page.waitForTimeout(400);
}
async function menuGo(page, width, label) {
  await openMenu(page, width);
  await page.getByRole("menuitem", { name: label, exact: true }).first().click().catch(async () => {
    await page.locator('[role="menu"]').getByText(label, { exact: true }).first().click();
  });
}
async function clickBotInRail(page, width, name) {
  let rail = page.locator('[data-testid="left-rail"]:visible');
  if (!(await rail.count())) {
    const drawer = page.locator('button[aria-label^="打开"]:visible').first();
    if (await drawer.count()) { await drawer.click(); await page.waitForTimeout(500); }
  }
  // The bot row: a link to /channel or a button with the bot name.
  const row = page.locator('[data-testid="left-rail"] .glass-bot-row').filter({ hasText: name }).first();
  await row.click();
}

async function backToChat(page) {
  let l = page.locator(':is([aria-label="返回聊天"], a:has-text("返回聊天")):visible').first();
  if (!(await l.count())) { const d = page.locator('button[aria-label^="打开"]:visible').first(); if (await d.count()) { await d.click(); await page.waitForTimeout(500); } l = page.locator(':is([aria-label="返回聊天"], a:has-text("返回聊天")):visible').first(); }
  await l.click();
}
async function prepare(page) {
  // Scroll up a bit (user wheel) so the restore of a non-bottom position is tested.
  const v = page.locator('[data-slot="message-scroller-viewport"]');
  const box = await v.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80); }
  await page.waitForTimeout(800);
  await page.evaluate(() => { const r = document.querySelector('[data-testid="left-rail"]'); if (r) r.__navTag = "kept"; });
  const f = await page.evaluate(() => window.__frames.at(-1));
  return f;
}

async function measureReturn(page, label, before, loadId, reqs) {
  await page.waitForURL(/\/channel\//, { timeout: 30000 });
  await page.waitForTimeout(5000);
  const after = await page.evaluate(() => ({ loadId: window.__loadId, frames: window.__frames.filter((f) => f.ph === "back") }));
  const reload = after.loadId !== loadId;
  const fr = after.frames.filter((f) => f.path.startsWith("/channel/"));
  const firstChat = fr.findIndex((f) => f.v && f.rows > 0);
  const blank = fr.slice(0, firstChat < 0 ? fr.length : firstChat).length;
  const blankMs = firstChat > 0 ? fr[firstChat].t - fr[0].t : firstChat === 0 ? 0 : 9999;
  // after first painted frame, does the transcript ever go back to empty?
  const dropped = firstChat >= 0 ? fr.slice(firstChat).filter((f) => !f.v || f.rows === 0).length : -1;
  const skel = fr.filter((f) => f.skel).length;
  const last = fr.at(-1) || {};
  const firstPaint = firstChat >= 0 ? fr[firstChat] : {};
  const scrollKept = last.firstId === before.firstId && Math.abs((last.firstTop ?? 0) - (before.firstTop ?? 0)) <= 4;
  const firstPaintKept = firstPaint.firstId === before.firstId && Math.abs((firstPaint.firstTop ?? 0) - (before.firstTop ?? 0)) <= 4;
  // movement after first paint: changes of firstId/firstTop
  let moves = 0; for (let i = (firstChat < 0 ? 0 : firstChat) + 1; i < fr.length; i++) { if (fr[i].firstId !== fr[i - 1].firstId || Math.abs((fr[i].firstTop ?? 0) - (fr[i - 1].firstTop ?? 0)) > 2) moves++; }
  const msgReads = reqs.filter((r) => /\/threads\/[^/]+\/messages/.test(r)).length;
  // 回来之后输入框点得到（手机上没有透明抽屉盖着）。
  const tappable = await page.evaluate(() => { const ed = document.querySelector('[aria-label="消息"]'); const r = ed?.getBoundingClientRect(); if (!r) return false; const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return Boolean(hit && ed.contains(hit)); });
  const docLoads = reqs.filter((r) => r.startsWith("DOC ")).length;
  const railKept = last.railTag === "kept";
  const railEmpty = fr.filter((f) => f.railBots === 0).length;
  const skelMax = Math.max(0, ...fr.map((f) => f.skel));
  const skelWhat = [...new Set(fr.map((f) => f.skelWhat).filter(Boolean))].slice(0, 6);
  log(label, JSON.stringify({ reload, docLoads, blankFrames: blank, blankMs, dropped, skel, before: [before.firstId, before.firstTop, before.top], firstPaint: [firstPaint.firstId, firstPaint.firstTop], last: [last.firstId, last.firstTop, last.top], moves, msgReads, railKept, railEmpty, skelMax, skelWhat, reqs: reqs.slice(0, 40) }));
  return { label, reload, docLoads, blank, blankMs, dropped, skel, scrollKept, firstPaintKept, moves, msgReads, railKept, tappable };
}

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", isMobile: width < 600, hasTouch: width < 600 });
  await ctx.addInitScript(INIT);
  if (process.env.NAVDBG) await ctx.addInitScript(DBG);
  if (process.env.SCROLLALL) await ctx.addInitScript(() => { window.__allScroll = []; document.addEventListener("scroll", (e) => { if (window.__phase !== "away") return; const t = e.target; window.__allScroll.push([Math.round(performance.now()), t === document ? "document" : (t.getAttribute?.("data-slot") || t.className?.toString() || t.tagName).slice(0, 70), t === document ? document.scrollingElement.scrollTop : t.scrollTop]); }, true); });
  const page = await ctx.newPage();
  if (process.env.LATENCY) { const cdp = await ctx.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: Number(process.env.LATENCY), downloadThroughput: 4e6, uploadThroughput: 2e6 }); }
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  let reqs = [];
  page.on("request", (r) => { const u = r.url().replace(base, ""); if (r.resourceType() === "document") reqs.push("DOC " + u); else if (u.startsWith("/api/")) reqs.push(r.method() + " " + u.slice(0, 120)); });
  await page.goto(`${base}/bot?agent=${AGENT}`, { waitUntil: "domcontentloaded" });
  await waitChat(page);
  const botName = await page.evaluate(() => document.querySelector('[data-testid="left-rail"] .glass-bot-row.is-on')?.textContent?.trim().slice(0, 2) || "");
  if (process.env.NOANCHOR) await page.addStyleTag({ content: '.kept-chat[data-visible="false"], .kept-chat[data-visible="false"] * { overflow-anchor: none !important; }' });
  log(width, "chat open", page.url(), "bot", botName, "dbg", await page.evaluate(() => typeof window.__scrollLog + "/" + typeof window.__frames));
  const chatUrl = page.url();
  const flows = [
    ["settings→返回聊天", async () => { await menuGo(page, width, "设置"); await page.waitForURL(/\/settings/); await settle(page, 2500); return async () => { await backToChat(page); }; }],
    ["待处理→左栏机器人", async () => { await menuGo(page, width, "待处理"); await page.waitForURL(/\/approvals/); await settle(page, 2500); return async () => { await clickBotInRail(page, width, botName || "助手"); }; }],
    ["设备→浏览器后退", async () => { await menuGo(page, width, "设置"); await page.waitForURL(/\/settings/); await settle(page, 1200); await page.locator(':is(a,button)').filter({ hasText: "电脑与设备" }).first().click().catch(() => {}); await page.waitForTimeout(500); if (!(await page.locator('a[href^="/settings/devices"]:visible').count())) { const d = page.locator('button[aria-label^="打开"]:visible').first(); if (await d.count()) { await d.click(); await page.waitForTimeout(500); } await page.locator(':is(a,button):visible').filter({ hasText: "电脑与设备" }).first().click().catch(() => {}); await page.waitForTimeout(500); } await page.locator('a[href^="/settings/devices"]:visible').first().click(); await page.waitForURL(/\/settings\/devices/); await settle(page, 2500); return async () => { await page.goBack(); await page.waitForTimeout(400); if (!/\/channel\//.test(page.url())) await page.goBack(); }; }],
    ["设置→浏览器后退（单聊）", async () => { await menuGo(page, width, "设置"); await page.waitForURL(/\/settings/); await settle(page, 2500); return async () => { await page.goBack(); }; }],
  ];
  for (const [label, go] of flows.slice(0, Number(process.env.FLOWS || flows.length))) {
    try {
      if (!/\/channel\//.test(page.url())) { await page.goto(chatUrl, { waitUntil: "domcontentloaded" }); await waitChat(page); }
      const before = await prepare(page);
      const loadId = await page.evaluate(() => window.__loadId);
      await page.evaluate(() => { window.__phase = "away"; window.__frames = []; });
      const back = await go();
      const away = await page.evaluate(() => { const out = []; let last = null; for (const f of window.__frames) { const k = `${f.top}|${f.firstId}|${f.firstTop}|${f.vw}|${f.vh}|${f.sh}`; if (k !== last) { out.push([f.t, f.path.slice(0, 12), f.top, f.firstTop, f.gap, f.vw, f.vh, f.sh]); last = k; } } return out.slice(0, 20); });
      log("away-scroll", JSON.stringify(away));
      // §98.5：藏着的聊天在离开期间一像素都不动（设置左栏的 scrollIntoView 曾把它挪 46–182px）。
      const awayTops = [...new Set(away.filter((f) => !String(f[1]).startsWith("/channel/")).map((f) => f[2]))];
      check(awayTops.length === 0 || (awayTops.length === 1 && Math.abs(awayTops[0] - before.top) <= 1), `${width} ${label}: 离开期间藏着的聊天不被挪（${before.top} → ${awayTops.join("/") || "不变"}）`);
      if (process.env.SCROLLALL) log("all-scroll", JSON.stringify(await page.evaluate(() => window.__allScroll.splice(0))));
      if (process.env.NAVDBG) log("scroll-log", JSON.stringify(await page.evaluate(() => window.__scrollLog.slice(0, 30).map((x) => x.slice(0, 3)))));
      reqs = [];
      await page.evaluate(() => { window.__phase = "back"; window.__frames = []; });
      await back();
      if (process.env.SHOTS) for (let i = 0; i < 8; i++) { await page.screenshot({ path: `${OUT}/burst-${TAG}-${width}-${label.replace(/[^a-z0-9]/gi, "_")}-${i}.png` }); }
      const r = await measureReturn(page, `${width} ${label}`, before, loadId, reqs);
      await page.screenshot({ path: `${OUT}/nav-${TAG}-${width}-${label.replace(/[^a-z0-9]/gi, "_")}.png` });
      check(!r.reload && r.docLoads === 0, `${width} ${label}: 不整页重载`);
      check(r.blankMs <= 50 && r.dropped === 0, `${width} ${label}: 不闪白（空白 ${r.blankMs}ms，中途变空 ${r.dropped} 帧）`);
      check(r.skel === 0, `${width} ${label}: 无骨架（${r.skel} 帧）`);
      check(r.firstPaintKept && r.scrollKept, `${width} ${label}: 滚动位置保持（首帧 ${r.firstPaintKept} 最后 ${r.scrollKept}）`);
      check(r.moves === 0, `${width} ${label}: 回来后不跳动（${r.moves} 次）`);
      check(r.msgReads === 0, `${width} ${label}: 不重新拉整段消息（${r.msgReads} 次）`);
      check(r.tappable, `${width} ${label}: 回来后输入框点得到（没有东西盖着）`);
    } catch (e) {
      log("ERR", width, label, String(e).slice(0, 300));
      await page.screenshot({ path: `${OUT}/nav-${TAG}-${width}-err.png` }).catch(() => {});
      check(false, `${width} ${label}: 流程出错`);
    }
  }
  if (errs.length) log("pageerrors", errs.slice(0, 5));
  await ctx.close();
}

// 正在写的回答：离开到设置再回来，不中断、不重新接入（假模型 SLOW = 40 句 × 260ms）。只在预览跑。
if (process.env.STREAM) for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", isMobile: width < 600, hasTouch: width < 600 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  let reqs = [];
  page.on("request", (r) => { const u = r.url().replace(base, ""); if (r.resourceType() === "document") reqs.push("DOC " + u); else if (u.startsWith("/api/")) reqs.push(r.method() + " " + u.slice(0, 120)); });
  try {
    await page.goto(`${base}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const made = await page.evaluate(async () => { const r = await fetch("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "导航测试" + Date.now().toString(36).slice(-4), title: "临时测试（会删除）", roleDescription: "测试", visibility: "private" }) }); return r.json(); });
    const bot = made.agent.id;
    log(width, "bot", bot);
    await page.goto(`${base}/bot?agent=${bot}`, { waitUntil: "domcontentloaded" });
    const ta = page.locator('[aria-label="消息"]').first();
    await ta.waitFor({ timeout: 60000 }); await page.waitForTimeout(2000);
    await ta.click(); await ta.fill("SLOW 导航"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => /第5句/.test(document.querySelector('[data-slot="message-scroller-viewport"]')?.innerText || ""), null, { timeout: 60000 });
    await page.waitForURL(/\/channel\//, { timeout: 30000 });
    const count = () => page.evaluate(() => (document.querySelector('[data-slot="message-scroller-viewport"]')?.innerText.match(/第\d+句/g) || []).length);
    const loadId = await page.evaluate(() => window.__loadId);
    const atLeave = await count();
    await menuGo(page, width, "设置"); await page.waitForURL(/\/settings/); await page.waitForTimeout(3000);
    reqs = [];
    await page.evaluate(() => { window.__phase = "back"; window.__frames = []; });
    await backToChat(page);
    await page.waitForURL(/\/channel\//, { timeout: 30000 });
    await page.waitForTimeout(150);
    const atReturn = await count();
    await page.waitForTimeout(1850);
    const earlyReqs = reqs.slice();
    await page.waitForFunction(() => /第40句/.test(document.querySelector('[data-slot="message-scroller-viewport"]')?.innerText || ""), null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    const final = await count();
    const after = await page.evaluate(() => ({ loadId: window.__loadId, frames: window.__frames.filter((f) => f.path.startsWith("/channel/")) }));
    const firstChat = after.frames.findIndex((f) => f.v && f.rows > 0);
    // 回来后 2 秒内（回答还在写）：不重新接入、不读历史。写完之后的那次同步是正常的收尾，不算。
    const connects = earlyReqs.filter((r) => /\/connect(\?|$)/.test(r) || /\/threads\/[^/]+\/messages/.test(r)).length;
    log(width, "stream", JSON.stringify({ atLeave, atReturn, final, firstChat, connects, reqs: reqs.slice(0, 30) }));
    check(after.loadId === loadId, `${width} 流式: 不整页重载`);
    check(atReturn > atLeave + 5, `${width} 流式: 离开期间回答一直在写（离开 ${atLeave} 句 → 回来 ${atReturn} 句）`);
    check(firstChat === 0, `${width} 流式: 回来第一帧就有对话（${firstChat}）`);
    check(connects === 0, `${width} 流式: 回来不重新接入 / 读历史（${connects} 次）`);
    check(final === 40, `${width} 流式: 写完 40 句、没有重复（${final}）`);
    // 回来之后再发一条：新消息照常出现、回答照常写完。
    const ta2 = page.locator('[aria-label="消息"]:visible').last();
    await ta2.click({ timeout: 10000 });
    await ta2.fill("SLOW 第二条"); await page.keyboard.press("Enter");
    const newOk = await page.waitForFunction(() => { const t = document.querySelector('[data-slot="message-scroller-viewport"]')?.innerText || ""; return /SLOW 第二条/.test(t) && (t.match(/第40句/g) || []).length >= 2; }, null, { timeout: 60000 }).then(() => true).catch(() => false);
    check(newOk, `${width} 流式: 回来后新发的消息和回答照常更新`);
    await page.screenshot({ path: `${OUT}/nav-${TAG}-${width}-stream.png` });
    await page.evaluate(async (id) => fetch(`/api/agents/${id}`, { method: "DELETE" }), bot).catch(() => {});
  } catch (e) {
    log("ERR stream", width, String(e).slice(0, 300));
    await page.screenshot({ path: `${OUT}/nav-${TAG}-${width}-stream-err.png` }).catch(() => {});
    check(false, `${width} 流式: 流程出错`);
  }
  await ctx.close();
}

// 换机器人 / 换对话照旧刷新成对的那段，留着的换成最近看的那段；藏着时不轮询（只读导航）。
if (process.env.SWITCH) for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", isMobile: width < 600, hasTouch: width < 600 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  let reqs = [];
  page.on("request", (r) => { const u = r.url().replace(base, ""); if (r.resourceType() === "document") reqs.push("DOC " + u); else if (u.startsWith("/api/")) reqs.push(r.method() + " " + u.slice(0, 160)); });
  const ids = () => page.evaluate(() => [...document.querySelectorAll('[data-slot="message-scroller-viewport"] [data-message-id]')].filter((e) => e.getClientRects().length && e.closest('[data-visible="false"]') === null).map((e) => e.getAttribute("data-message-id")));
  const visibleViewports = () => page.evaluate(() => [...document.querySelectorAll('[data-slot="message-scroller-viewport"]')].filter((v) => v.closest('[data-visible="false"]') === null && v.getClientRects().length).length);
  try {
    await page.goto(`${base}/bot?agent=${AGENT}`, { waitUntil: "domcontentloaded" });
    await waitChat(page);
    const urlA = page.url(); const idsA = await ids();
    // 左栏换到另一个机器人
    let rail = page.locator('[data-testid="left-rail"]:visible');
    if (!(await rail.count())) { const d = page.locator('button[aria-label^="打开"]:visible').first(); if (await d.count()) { await d.click(); await page.waitForTimeout(500); } }
    const name2 = await page.evaluate(async (id) => (await (await fetch("/api/agents")).json()).agents.find((a) => a.id === id)?.name, process.env.AGENT2 || "general-assistant");
    const other = page.locator('[data-testid="left-rail"] .glass-bot-row:not(.is-on)').filter({ hasText: name2 }).first();
    const otherName = (await other.textContent())?.trim().slice(0, 6);
    await other.click();
    await page.waitForFunction((u) => location.href !== u && /\/channel\//.test(location.pathname), urlA, { timeout: 30000 });
    await page.waitForTimeout(5000);
    let urlB = page.url(); let idsB = await ids();
    const overlap = idsB.filter((x) => idsA.includes(x)).length;
    log(width, "switch", JSON.stringify({ urlA, urlB, otherName, a: idsA.length, b: idsB.length, overlap, viewports: await visibleViewports() }));
    check(urlB !== urlA && overlap === 0 && (await visibleViewports()) === 1, `${width} 换机器人: 换成那个机器人的对话（${idsB.length} 条，和上一个重叠 ${overlap}）`);
    // 换对话：直接打开 AGENT2 已有的一段（地址变化走路由），它的消息出现、不混进上一段
    if (!/\/channel\/channel_/.test(urlB) || idsB.length === 0) {
      const fromEnv = (process.env.CH2 || "").split(",").filter(Boolean);
      const candidates = fromEnv.length ? fromEnv : [await page.evaluate(async (id) => { const j = await (await fetch("/api/channels")).json(); const rows = j.items ?? j.channels ?? j; return (Array.isArray(rows) ? rows : []).find((c) => (c.agentIds ?? []).length === 1 && c.agentIds[0] === id)?.id; }, process.env.AGENT2 || "general-assistant")].filter(Boolean);
      let opened = false;
      for (const chId of candidates) {
        await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, `/channel/${chId}`);
        await page.locator('[data-slot="message-scroller-viewport"] [data-message-id]').first().waitFor({ timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        urlB = page.url(); idsB = await ids();
        if (idsB.length === 0) continue;
        opened = true;
        const ov = idsB.filter((x) => idsA.includes(x)).length;
        check(ov === 0 && (await visibleViewports()) === 1, `${width} 换对话: 打开另一段，内容是那一段（${idsB.length} 条，和上一段重叠 ${ov}）`);
        break;
      }
      if (!opened) log(width, "no non-empty channel for AGENT2");
    }
    // 去设置再回来：留着的是 B
    await menuGo(page, width, "设置"); await page.waitForURL(/\/settings/); await page.waitForTimeout(2500);
    // 藏着的成本：15 秒里的请求和脚本时间
    reqs = [];
    const m0 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    await page.waitForTimeout(15000);
    const m1 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const awayReqs = reqs.slice();
    const pollers = awayReqs.filter((r) => /\/computers\/[^/]+\/(control|tabs|screen|frame)|\/components\/for-agent\/|\/live-panels/.test(r));
    log(width, "away-cost", JSON.stringify({ reqs: awayReqs.length, script: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), layouts: m1.LayoutCount - m0.LayoutCount, pollers: pollers.slice(0, 8), all: awayReqs.slice(0, 30) }));
    const syncs = awayReqs.filter((r) => /\/bot-threads\/[^/]+\/sync/.test(r)).length;
    check(pollers.length === 0, `${width} 藏着的聊天 / 右栏不轮询（15 秒 ${pollers.length} 次计算机 / 组件 / 面板请求）`);
    check(syncs <= 2, `${width} 藏着的聊天同步放慢到 10 秒一次（15 秒 ${syncs} 次，原来 7–8 次）`);
    // 浏览器后退回到刚才那段（「返回聊天」走 `/`，落在最近用过的机器人的最新对话，不一定是这段）
    await page.goBack();
    await page.waitForURL(/\/channel\//, { timeout: 30000 }); await page.waitForTimeout(3000);
    const idsB2 = await ids();
    check(page.url() === urlB && idsB2.join() === idsB.join(), `${width} 换机器人后去设置再回来: 回到刚才那段（${idsB2.length} 条）`);
    // 换回 A（直接改地址，走路由）：A 的对话正确出现，不是 B 的残留
    await page.evaluate((u) => { history.pushState({}, "", new URL(u).pathname); dispatchEvent(new PopStateEvent("popstate")); }, urlA);
    await page.waitForTimeout(5000);
    const idsA2 = await ids();
    const leak = idsA2.filter((x) => idsB.includes(x)).length;
    check(idsA2.length > 0 && leak === 0 && (await visibleViewports()) === 1, `${width} 换对话: 换回上一段，内容正确（${idsA2.length} 条，残留 ${leak}）`);
    await page.screenshot({ path: `${OUT}/nav-${TAG}-${width}-switch.png` });
  } catch (e) {
    log("ERR switch", width, String(e).slice(0, 300));
    await page.screenshot({ path: `${OUT}/nav-${TAG}-${width}-switch-err.png` }).catch(() => {});
    check(false, `${width} 换机器人 / 对话: 流程出错`);
  }
  await ctx.close();
}
const fails = results.filter((r) => !r[0]);
log(`SUMMARY ${results.length - fails.length}/${results.length} pass`);
for (const f of fails) log("FAILED", f[1]);
await browser.close();
