// cb-sendscroll: §94 / §94.7 —— 30 分钟内连续发消息不翻页上跳（回答中补话也算连续）；空闲超过 30 分钟照旧翻页，但落在视口上 1/3；打字不挪动对话。PREVIEW ONLY（向假模型发消息）。
// env: BASE (preview), WIDTHS=1280,390, OUT=/out
// 时钟：页面里的 Date 被换成可加偏移的版本（localStorage cbsend-off，ms），用来模拟「过了 35 分钟」。
import { chromium } from "playwright-core";
import fs from "node:fs";
const base = process.env.BASE || "http://127.0.0.1:3291";
const WIDTHS = (process.env.WIDTHS || "1280,390").split(",").map(Number);
const OUT = process.env.OUT || "/out";
const TAG = process.env.TAG || "run";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const exe = (() => { const d = fs.readdirSync("/ms-playwright").find((x) => x.startsWith("chromium-") && !x.includes("headless")); return `/ms-playwright/${d}/chrome-linux64/chrome`; })();
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const failures = [];
const results = [];
const check = (ok, what) => { console.log(ok ? "PASS" : "FAIL", what); results.push([ok, what]); if (!ok) failures.push(what); };

const INIT = () => {
  // 可偏移的时钟
  const RealDate = Date;
  const off = () => Number(localStorage.getItem("cbsend-off") || 0);
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + off()); else super(...a); }
    static now() { return RealDate.now() + off(); }
  }
  window.Date = FakeDate;
  // 每帧采样：每一行离视口顶边多远、底部距离、两块留白、输入框高度
  window.__frames = []; window.__phase = "load"; window.__user = 0;
  const T0 = performance.now();
  const sample = () => {
    const v = document.querySelector('[data-slot="message-scroller-viewport"]');
    if (v) {
      const vr = v.getBoundingClientRect();
      const rows = {};
      let lastBottom = -1e9;
      for (const r of v.querySelectorAll("[data-testid=kept-page][data-visible=true] [data-message-id]")) {
        const b = r.getBoundingClientRect();
        if (b.height === 0) continue;
        rows[r.getAttribute("data-message-id")] = [Math.round((b.top - vr.top) * 10) / 10, Math.round(b.height), r.querySelector('[data-slot="message"][data-align="end"]') ? 1 : 0];
        lastBottom = Math.max(lastBottom, b.bottom - vr.top);
      }
      // 「思考中」、排队的消息这类不带 id 的行也算内容（不算两块留白）
      for (const c of v.querySelectorAll('[data-slot="message-scroller-content"] > .contents > *')) {
        if (c.hasAttribute("data-chat-slack")) continue;
        const b = c.getBoundingClientRect(); if (b.height > 0) lastBottom = Math.max(lastBottom, b.bottom - vr.top);
      }
      const sp = v.querySelector("[data-testid=kept-page][data-visible=true] [data-message-scroller-spacer]");
      const sl = v.querySelector("[data-chat-slack]");
      const comp = document.querySelector('[aria-label="消息"]')?.closest("form, .glass-composer, [data-slot=composer]") || document.querySelector('[aria-label="消息"]');
      window.__frames.push({
        t: Math.round(performance.now() - T0), ph: window.__phase, top: Math.round(v.scrollTop), gap: Math.round(v.scrollHeight - v.scrollTop - v.clientHeight),
        ch: v.clientHeight, sp: sp && !sp.hidden ? Math.round(sp.getBoundingClientRect().height) : 0, sl: sl && sl.style.display !== "none" ? Math.round(sl.getBoundingClientRect().height) : 0,
        comp: comp ? Math.round(comp.getBoundingClientRect().height) : 0, last: Math.round(lastBottom), rows, u: window.__user,
      });
    }
    requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = sample; c.port2.postMessage(0); });
  };
  requestAnimationFrame(sample);
  for (const ev of ["wheel", "touchmove"]) window.addEventListener(ev, () => { window.__user++; }, { capture: true, passive: true });
};

/*
 * 一段时间里的移动：对相邻两帧都在的行，算它们一起挪了多少（取中位数）。
 * back = 往回（内容往下挪，> 2px）的次数；up = 每帧往上挪的量；allowed = 同一帧里「这一行下面长出来的」高度。
 */
function motion(frames) {
  const out = { back: [], up: [], excess: [], maxUp: 0, totalUp: 0, totalGrowBelow: 0 };
  let budget = 0, idleFrames = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (a.u !== b.u) continue; // 人动了
    const ids = Object.keys(b.rows).filter((id) => a.rows[id]);
    if (!ids.length) continue;
    const ds = ids.map((id) => b.rows[id][0] - a.rows[id][0]).sort((x, y) => x - y);
    const d = ds[Math.floor(ds.length / 2)];
    // 参照行：两帧都在的第一行（最上面那一行）。它下面长出来的 = (last - top) 的变化 - 它自己高度变化
    const ref = ids.sort((x, y) => a.rows[x][0] - a.rows[y][0])[0];
    const belowA = a.last - (a.rows[ref][0] + a.rows[ref][1]);
    const belowB = b.last - (b.rows[ref][0] + b.rows[ref][1]);
    const grow = belowB - belowA;
    const viewShrink = a.ch - b.ch; // 输入框长高 → 视口变矮，钉在底部要往上挪这么多
    if (d > 2) out.back.push({ t: b.t, d: Math.round(d), top: [a.top, b.top], gap: [a.gap, b.gap] });
    if (d < 0) { out.maxUp = Math.max(out.maxUp, -d); out.totalUp += -d; }
    out.totalGrowBelow += Math.max(0, grow) + Math.max(0, viewShrink);
    // 钉底部的那一下可能晚一两帧（视口先变矮 / 内容先长，下一帧才滚）：额度 = 累计长出来的 − 已经上移的，30 帧没新额度就清零。
    const give = Math.max(0, grow) + Math.max(0, viewShrink);
    if (give > 0) { budget += give; idleFrames = 0; } else if (++idleFrames > 30) budget = 0;
    const took = Math.max(0, -d);
    if (took > budget + 3) out.excess.push({ t: b.t, up: Math.round(took), budget: Math.round(budget), sp: b.sp, sl: b.sl });
    budget = Math.max(0, budget - took);
  }
  return out;
}

async function run(width) {
  const mobile = width < 1000;
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 800 }, isMobile: mobile, hasTouch: mobile, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));
  const api = (p, init) => page.evaluate(async ([p, i]) => { const r = await fetch(p, { ...i, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.text() }; }, [p, init ?? {}]);
  const phase = (p) => page.evaluate((x) => { window.__phase = x; }, p);
  const frames = (p) => page.evaluate((x) => window.__frames.filter((f) => f.ph === x), p);
  const editor = () => page.locator('[aria-label="消息"]').first();
  const busy = () => page.locator('[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]').count();
  const idle = async (max = 90000) => { const t0 = Date.now(); let n = 0; await page.waitForTimeout(1500); while (Date.now() - t0 < max && n < 4) { n = (await busy()) ? 0 : n + 1; await page.waitForTimeout(500); } };
  const setOff = (ms) => page.evaluate((m) => localStorage.setItem("cbsend-off", String(m)), ms);
  const send = async (text) => { await editor().click(); await editor().fill(text); await page.keyboard.press("Enter"); };
  /** 新出现的那条用户消息离视口顶边多远（出现后 1.2 秒内最小的）。 */
  const newUserTop = (f, beforeIds) => {
    let id = null, min = 1e9;
    for (const x of f) {
      for (const [rid, [top, , user]] of Object.entries(x.rows)) {
        if (beforeIds.has(rid) || !user) continue;
        if (id === null) id = rid;
        if (rid === id && x.t - f[0].t < 4000) min = Math.min(min, top);
      }
    }
    return { id, min: Math.round(min) };
  };
  const ids = async () => new Set(await page.evaluate(() => [...document.querySelectorAll('[data-slot="message-scroller-viewport"] [data-message-id]')].map((r) => r.getAttribute("data-message-id"))));

  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await setOff(0);
  const r = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: `滚动测试${width}`, title: "临时测试（会删除）", roleDescription: "测试", visibility: "private" }) });
  const bot = JSON.parse(r.body).agent.id; fs.appendFileSync(`${OUT}/bots.txt`, bot + "\n");
  log(width, "bot", bot);
  await page.goto(`${base}/channel/new?agent=${encodeURIComponent(bot)}`, { waitUntil: "domcontentloaded" });
  await editor().waitFor({ timeout: 60000 }); await page.waitForTimeout(2000);

  // 1) 第一句（这段对话第一句 → 照旧对齐，不检查）+ 填满一屏
  await phase("s1"); await send("SLOW 第一句（填满）"); await page.waitForURL(/\/channel\/(?!new)/, { timeout: 60000 }); await idle(); await page.waitForTimeout(1500);
  const channelUrl = page.url();

  const continuous = async (tag, text) => {
    const before = await ids();
    await phase(tag); await send(text); await idle(); await page.waitForTimeout(2500);
    const f = await frames(tag);
    const m = motion(f);
    const nu = newUserTop(f, before);
    const maxSp = Math.max(...f.map((x) => x.sp)) - (f[0]?.sp ?? 0);
    const end = f.at(-1);
    check(m.back.length === 0, `${width} ${tag}: 0 次往回挪 ${m.back.length ? JSON.stringify(m.back.slice(0, 3)) : ""}`);
    check(m.excess.length === 0, `${width} ${tag}: 没有超出「下面长出来的高度」的上跳（最大单帧上移 ${Math.round(m.maxUp)}px） ${m.excess.length ? JSON.stringify(m.excess.slice(0, 3)) : ""}`);
    check(maxSp <= 0, `${width} ${tag}: 不新留一屏空白（滚动容器 spacer 最多长了 ${maxSp}px）`);
    check(nu.min > 200, `${width} ${tag}: 新消息没被翻到顶上（最靠上时离顶 ${nu.min}px）`);
    check(end.gap <= 4, `${width} ${tag}: 最后在底部（离底 ${end.gap}px）`);
    if (end.gap > 4 || m.excess.length || m.back.length) fs.writeFileSync(`${OUT}/frames-${TAG}-${width}-${tag}.json`, JSON.stringify(f.map(({ rows, ...x }) => ({ ...x, n: Object.keys(rows).length })), null, 0));
    return { tag, maxUp: Math.round(m.maxUp), totalUp: Math.round(m.totalUp), grow: Math.round(m.totalGrowBelow), back: m.back.length, excess: m.excess.length, maxSp, newTop: nu.min, endGap: end.gap, frames: f.length };
  };
  const anchored = async (tag, text) => {
    const before = await ids();
    await phase(tag); await send(text); await page.waitForTimeout(2500);
    const f = await frames(tag);
    const nu = newUserTop(f, before);
    const maxSp = Math.max(...f.map((x) => x.sp));
    const m = motion(f);
    if (nu.min < 80 || nu.min > 320) fs.writeFileSync(`${OUT}/frames-${TAG}-${width}-${tag}.json`, JSON.stringify(f.map(({ rows, ...x }) => ({ ...x, n: Object.keys(rows).length, users: Object.entries(rows).filter(([, r]) => r[2]).map(([id, r]) => id.slice(0, 8) + "@" + r[0]) })), null, 0));
    check(nu.min >= 80 && nu.min <= 320, `${width} ${tag}: 隔了 >30 分钟 → 翻页，但落在视口上 1/3（新消息离顶 ${nu.min}px）`);
    check(maxSp > 100, `${width} ${tag}: 照旧留出空白（spacer 最大 ${maxSp}px）`);
    check(m.back.length === 0, `${width} ${tag}: 0 次往回挪 ${m.back.length ? JSON.stringify(m.back.slice(0, 3)) : ""}`);
    await idle(); await page.waitForTimeout(1500);
    return { tag, newTop: nu.min, maxSp, maxUp: Math.round(m.maxUp), back: m.back.length };
  };

  const rows = [];
  // 2) 马上接着发（<5 分钟）：不翻页
  rows.push(await continuous("c2", "SLOW 接着问（连续）"));
  // 3) 短的一句
  rows.push(await continuous("c3", "你好"));
  // 4) 过了 35 分钟（超过 30 分钟的界限）：照旧翻页
  await setOff(35 * 60 * 1000);
  rows.push(await anchored("a4", "SLOW 隔了三十五分钟"));
  // 5) 又接着发（以 a4 的发送时刻算 <30 分钟）
  rows.push(await continuous("c5", "WORK 接着（连续，带干活卡）"));

  // 6) 打字：多行、长高，对话不跳
  for (const [tag, mode] of [["type", "multi"]]) {
    await phase(tag);
    await editor().click();
    for (let i = 0; i < 7; i++) { await page.keyboard.type(`第${i + 1}行打字测试，看看对话会不会跟着跳`, { delay: 8 }); await page.keyboard.press("Shift+Enter"); }
    await page.waitForTimeout(800);
    const f = await frames(tag);
    const m = motion(f);
    const compGrow = (f.at(-1)?.comp ?? 0) - (f[0]?.comp ?? 0);
    check(m.back.length === 0, `${width} type: 打字时 0 次往回挪 ${m.back.length ? JSON.stringify(m.back.slice(0, 3)) : ""}`);
    check(m.excess.length === 0, `${width} type: 打字时对话只为钉住底部挪动（输入框长高 ${compGrow}px，对话上移共 ${Math.round(m.totalUp)}px，最大单帧 ${Math.round(m.maxUp)}px） ${m.excess.length ? JSON.stringify(m.excess.slice(0, 3)) : ""}`);
    check((f.at(-1)?.gap ?? 99) <= 4, `${width} type: 打字后仍在底部（离底 ${f.at(-1)?.gap}px）`);
    rows.push({ tag, compGrow, totalUp: Math.round(m.totalUp), maxUp: Math.round(m.maxUp), back: m.back.length, excess: m.excess.length });
    // 清空（不发）
    await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace"); await page.waitForTimeout(600);
  }

  // 7) 刷新后：服务器时刻 <30 分钟 → 不翻页（走服务器读数，本机记的没了）
  await page.goto(channelUrl, { waitUntil: "domcontentloaded" }); await editor().waitFor({ timeout: 60000 }); await page.waitForTimeout(6000);
  const thread = await page.evaluate(async (u) => { const id = u.split("/channel/")[1]; const c = (await (await fetch("/api/channels")).json()).channels.find((x) => x.id === id); return c?.threadId; }, channelUrl);
  const sa = await api(`/api/copilotkit/threads/${encodeURIComponent(thread)}/sent-at`);
  log(width, "sent-at", sa.status, sa.body.slice(0, 200));
  check(sa.status === 200 && JSON.parse(sa.body).at, `${width} GET sent-at 有服务器时刻`);
  rows.push(await continuous("r7", "刷新后接着问（连续）"));
  // 8) 刷新 + 服务器说上一条是 35 分钟前发的 → 照旧翻页。服务器时刻是真的，换算用的是它自己的「现在」，本机拨表骗不了它；
  //    所以这里把 sent-at 的回复改成「35 分钟前」（只改这一个 GET 的回复）。
  await page.route("**/sent-at", async (route) => {
    const resp = await route.fetch(); const j = await resp.json();
    if (j.at && j.now) j.at = new Date(Date.parse(j.now) - 35 * 60 * 1000).toISOString();
    await route.fulfill({ response: resp, json: j });
  });
  await page.goto(channelUrl, { waitUntil: "domcontentloaded" }); await editor().waitFor({ timeout: 60000 }); await page.waitForTimeout(6000);
  rows.push(await anchored("r8", "SLOW 刷新后隔了三十五分钟"));

  await page.screenshot({ path: `${OUT}/send-${TAG}-${width}.png` }).catch(() => {});
  fs.writeFileSync(`${OUT}/send-${TAG}-${width}.json`, JSON.stringify(rows, null, 1));
  console.log("TABLE", width, JSON.stringify(rows));
  await ctx.close();
}

for (const w of WIDTHS) { try { await run(w); } catch (e) { check(false, `${w} crashed ${String(e).slice(0, 300)}`); } }
await browser.close();
console.log(failures.length ? `FAILURES ${failures.length}` : "ALL PASS", `${results.filter((r) => r[0]).length}/${results.length}`);
process.exit(failures.length ? 1 : 0);
