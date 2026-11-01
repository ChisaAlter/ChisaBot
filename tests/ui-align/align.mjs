// UI 文本对齐审计（DESIGN.md §82）：每个页面、对话、弹窗、菜单、提示，1280 浅色 + 390 深色。
// 预览上跑（CHAT=1 需要把预览的默认模型指向 tests/chat-scroll 一类的假模型，提示 WORK / CARD 见 README）。所有非 GET 一律拦掉，只有聊天那一段放行建临时机器人 / 发消息；临时机器人用 guard 删。
// 输出 /out/align-<TAG>/results.json + 每页截图（红框 = 文字没居中 / 被裁 / 换行 / 行高不一；黄框 = 字形墨迹偏；紫框 = 干活卡贴着上下内容）。
// 退出码：FAIL_ON=1 时有标记就 exit 1（回归检查用）。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
// —— 自带的小工具（不依赖 worker harness）——
const base = process.env.BASE || "http://127.0.0.1:3001";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const exe = fs.readdirSync("/ms-playwright").find((d) => d.startsWith("chromium-") && !d.includes("headless"));
const browser = await chromium.launch({ headless: true, executablePath: `/ms-playwright/${exe}/chrome-linux64/chrome`, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
async function context(theme, viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true, ...extra });
  await ctx.addInitScript((t) => { try { localStorage.setItem("chisabot-theme", t); } catch {} }, theme);
  if (process.env.TOK) await ctx.addCookies([{ name: "__Host-openbot_session", value: process.env.TOK, url: base, secure: true, httpOnly: true, sameSite: "Lax" }]);
  return ctx;
}
async function newPage(ctx, tag) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${tag} pageerror ${String(e).slice(0, 300)}`));
  return p;
}
const api = (page, p, init) => page.evaluate(async ([u, i]) => { const r = await fetch(u, { ...i, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.text() }; }, [p, init ?? {}]);
// 只删这次自己建的临时机器人：开跑前记下已有的全部机器人，删之前再核对一次
const preexisting = new Set(); const created = new Set();
// 宁可多保护：响应里出现过的每个 id 都当成已有的
const idsOf = (body) => [...String(body).matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
async function guardInit(call) { const r = await call("/api/agents", {}); if (r.status >= 300) throw new Error("cannot snapshot bots"); for (const id of idsOf(r.body)) preexisting.add(id); }
function trackBot(id) { if (preexisting.has(id)) throw new Error("not ours"); created.add(id); return id; }
async function guardedDeleteBot(call, id) { if (!created.has(id) || preexisting.has(id)) return { refused: true }; return call(`/api/agents/${id}`, { method: "DELETE" }); }
async function mkBot(page, name, role) {
  const r = await api(page, "/api/agents", { method: "POST", body: JSON.stringify({ name, title: "临时测试（会删除）", roleDescription: role, visibility: "private" }) });
  return JSON.parse(r.body).agent.id;
}
const TAG = process.env.TAG || "a"; const OUT = process.env.OUT || `/out/align-${TAG}`; fs.mkdirSync(OUT, { recursive: true });
const MEASURE = fs.readFileSync(process.env.MEASURE || path.join(path.dirname(new URL(import.meta.url).pathname), "measure.js"), "utf8");
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const ROUTES = (process.env.ROUTES || [
  "/", "/bots", "/approvals", "/settings", "/settings/approvals", "/settings/connected-accounts",
  "/settings/devices", "/settings/im", "/settings/media", "/settings/memory", "/settings/pages", "/settings/passwords", "/settings/schedules",
  "/settings/skills", "/settings/vault", "/admin", "/admin/models", "/admin/images", "/admin/devices", "/admin/computers", "/admin/audit",
  "/admin/system-update", "/admin/skills", "/admin/credentials", "/admin/magpie", "/admin/learning", "/admin/people", "/onboarding",
    "/this-page-does-not-exist",
].join(",")).split(",").concat(process.env.EXTRA_ROUTES ? process.env.EXTRA_ROUTES.split(",") : []);
const results = { tag: TAG, font: process.env.NOTO === "1" ? "Noto Sans CJK SC" : "WenQuanYi Zen Hei", pages: [] };
let allowChat = false;
async function guardRoutes(ctx) {
  await ctx.route("**/*", (route) => {
    const r = route.request(); const m = r.method(); const u = r.url();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return route.continue();
    if (allowChat && /\/api\/(agents|copilotkit|channels|bot-threads|chat|agui|messages|threads|link-preview)/.test(u)) return route.continue();
    if (/\/api\/copilotkit\/info/.test(u)) return route.continue();
    return route.fulfill({ status: 204, body: "" });
  });
  await ctx.addInitScript(MEASURE);
}
async function measure(page, name, vtag, extra = {}) {
  await page.evaluate(MEASURE).catch(() => {});
  const r = await page.evaluate((o) => { window.__alignClear(); return window.__alignMeasure(o); }, { minGap: 6 }).catch((e) => ({ error: String(e).slice(0, 200), flags: [], counts: {} }));
  if (process.env.PIX !== "0" && r.list) await pix(page, r, vtag, name);
  await page.evaluate(() => window.__alignMark(true)).catch(() => {});
  const file = `${vtag}-${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: false }).catch(() => {});
  await page.evaluate(() => window.__alignMark(false)).catch(() => {});
  const rec = { vp: vtag, name, url: page.url().replace(base, ""), shot: file, controls: r.controls, counts: r.counts, flags: r.flags?.map(({ rect, ...f }) => f), pixed: (r.list || []).filter((x) => x.pix).map((x) => ({ d: x.d, dy: x.pix.dy, dx: x.pix.dx, cjk: x.cjk })), spacing: r.spacing, ...extra };
  results.pages.push(rec);
  log(vtag, name, "controls", r.controls, JSON.stringify(r.counts), r.error || "");
  return r;
}
const pixSeen = new Set();
// 像素级复核：每个单行控件截一张 2 倍图，看墨迹（字 + 图标真画出来的像素）是不是在控件正中
async function pix(page, r, vtag, name) {
  let n = 0;
  // 浮在内容上的「回到底部」按钮会盖住下面的控件，量墨迹时先藏起来
  await page.addStyleTag({ content: ".chat-bottom-pill{visibility:hidden!important}" }).catch(() => {});
  for (const rec of r.list) {
    if (!rec.single || rec.h > 64 || rec.w > 480 || rec.w < 12) continue;
    const key = vtag + "|" + rec.d; if (pixSeen.has(key)) continue; pixSeen.add(key);
    if (++n > 80) break;
    const box = await page.evaluate((i) => { const e = document.querySelector(`[data-align-i="${i}"]`); if (!e) return null; e.scrollIntoView({ block: "nearest", inline: "nearest" }); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }, rec.i).catch(() => null);
    if (!box || box.width < 2 || box.y < 0 || box.x < 0 || box.y + box.height > page.viewportSize().height || box.x + box.width > page.viewportSize().width) continue;
    const buf = await page.screenshot({ clip: box, scale: "device", animations: "disabled" }).catch(() => null); if (!buf) continue;
    const ink = await page.evaluate(([u, rr]) => window.__alignPix(u, window.devicePixelRatio, rr), ["data:image/png;base64," + buf.toString("base64"), rec]).catch(() => null);
    if (!ink) continue;
    const dy = Math.round(((ink.top + ink.bottom) / 2 - ink.H / 2) * 10) / 10;
    const dx = Math.round(((ink.left + ink.right) / 2 - (rec.cb.l + (ink.W - rec.cb.l - rec.cb.r) / 2)) * 10) / 10;
    rec.pix = { dy, dx, ink };
    const iconOnly = rec.iconOnly;
    const add = (kind, why) => {
      r.flags.push({ kind, d: rec.d, why, crop: `crop-${vtag}-${name}-${rec.i}.png` }); r.counts[kind] = (r.counts[kind] || 0) + 1;
      fs.writeFileSync(`${OUT}/crop-${vtag}-${name}-${rec.i}.png`, buf);
      return page.evaluate((i) => document.querySelector(`[data-align-i="${i}"]`)?.setAttribute("data-align-flag", "PIX"), rec.i).catch(() => {});
    };
    if (rec.boxed && ((rec.cjk && !rec.desc) || iconOnly) && Math.abs(dy) > 1) await add("PIX_V", `墨迹竖向偏 ${dy}px（墨迹 ${ink.top.toFixed(1)}–${ink.bottom.toFixed(1)} / 高 ${ink.H.toFixed(1)}）`);
    if (rec.centred && Math.abs(dx) > 2) await add("PIX_H", `墨迹横向偏 ${dx}px`);
  }
}
const nameOf = (p) => p.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "home";
async function chat(page, vtag, bot) {
  allowChat = true;
  await page.goto(`${base}/channel/new?agent=${encodeURIComponent(bot)}`, { waitUntil: "domcontentloaded" });
  const box = page.locator('[aria-label="消息"]').first(); await box.waitFor({ timeout: 60000 }); await page.waitForTimeout(2000);
  const live = [];
  for (const [i, prompt] of ["WORK 对齐测试", "WORK 第二轮", "CARD 对齐"].entries()) {
    await box.fill(prompt); await page.keyboard.press("Enter"); const t0 = Date.now(); let shot = false;
    while (Date.now() - t0 < 60000) {
      await page.waitForTimeout(350);
      const s = await page.evaluate(() => { window.__alignClear?.(); const x = window.__alignMeasure({ minGap: 6 }); return x.spacing.filter((r) => r.card === "chat-work-card"); }).catch(() => []);
      if (s.length) { live.push(...s.map((x) => ({ ...x, turn: i, t: Date.now() - t0 }))); if (!shot && Date.now() - t0 > 2500) { shot = true; await measure(page, `chat-live${i}`, vtag); } }
      const busy = await page.locator('[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]').first().isVisible().catch(() => false);
      if (!busy && Date.now() - t0 > 5000) { await page.waitForTimeout(2500); if (!(await page.locator('[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]').first().isVisible().catch(() => false))) break; }
    }
  }
  await page.waitForTimeout(1200);
  const worstAbove = Math.min(...live.map((x) => x.gapAbove ?? 99)); const worstBelow = Math.min(...live.map((x) => x.gapBelow ?? 99));
  const liveGap = live.filter((x) => (x.gapAbove ?? 99) < 6 || (x.gapBelow ?? 99) < 6);
  await measure(page, "chat-done", vtag, { liveSamples: live.length, liveMinAbove: worstAbove, liveMinBelow: worstBelow, liveGapFlags: liveGap.length });
  if (liveGap.length) results.pages.at(-1).flags.push({ kind: "GAP", d: "干活卡（进行中）", why: `进行中有 ${liveGap.length} 次采样间距 < 6px（最小 上 ${worstAbove} / 下 ${worstBelow}）` }), (results.pages.at(-1).counts.GAP = (results.pages.at(-1).counts.GAP || 0) + liveGap.length);
  // 展开步骤
  const done = page.locator("[data-testid=kept-page][data-visible=true] [data-testid=chat-work-done]").last();
  if (await done.count()) { await done.click().catch(() => {}); await page.waitForTimeout(500); await measure(page, "chat-done-open", vtag); await done.click().catch(() => {}); }
  // 复制 → 提示
  const copy = page.locator('button[aria-label="复制"], button[aria-label*="复制"]').last();
  if (await copy.count()) { await copy.click({ force: true }).catch(() => {}); await page.waitForTimeout(400); await measure(page, "chat-copy", vtag); }
  allowChat = false;
}
async function menus(page, vtag) {
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3500);
  const tries = [
    ["drawer", 'button[aria-label*="打开"]:visible, button[aria-label*="菜单"]:visible, button[aria-label*="侧栏"]:visible'],
    ["botmenu", 'button[aria-label$="机器人菜单"]:visible'],
    ["newbot", 'button:has-text("新建机器人"):visible, a:has-text("新建机器人"):visible, button[aria-label*="新建"]:visible'],
    ["account", '[aria-label*="账号"]:visible, [data-account-menu]:visible'],
  ];
  for (const [n, sel] of tries) {
    const el = page.locator(sel).first();
    if (!(await el.count())) { log(vtag, "no", n); continue; }
    await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1300);
    await measure(page, `menu-${n}`, vtag);
    if (n === "drawer") {
      // 抽屉里的新建 / 菜单再点一层
      const nb = page.locator('[role=dialog] button:has-text("新建"), [data-slot=sheet-content] button:has-text("新建")').first();
      if (await nb.count()) { await nb.click({ force: true }).catch(() => {}); await page.waitForTimeout(800); await measure(page, "menu-drawer-newbot", vtag); }
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(300); await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  }
  // 设置里的下拉 / 确认框
  await page.goto(`${base}/settings/schedules`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3000);
  const sel = page.locator("[data-slot=select-trigger]:visible").first();
  if (await sel.count()) { await sel.click({ force: true }).catch(() => {}); await page.waitForTimeout(600); await measure(page, "menu-select", vtag); await page.keyboard.press("Escape"); }
  await page.goto(`${base}/settings/devices`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3000);
  const add = page.locator('button:has-text("添加"):visible, button:has-text("配对"):visible, button:has-text("连接"):visible').first();
  if (await add.count()) { await add.click({ force: true }).catch(() => {}); await page.waitForTimeout(900); await measure(page, "dialog-devices", vtag); await page.keyboard.press("Escape"); }
}
async function run(theme, viewport, vtag, bot) {
  const ctx = await context(theme, viewport, { deviceScaleFactor: 2 }); await guardRoutes(ctx);
  const page = await newPage(ctx, vtag);
  if (!ONLY || ONLY.includes("routes")) for (const path of ROUTES) {
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(3200);
    await measure(page, nameOf(path), vtag);
  }
  if (!ONLY || ONLY.includes("menus")) await menus(page, vtag);
  if (bot && (!ONLY || ONLY.includes("chat"))) await chat(page, vtag, bot);
  await ctx.close();
}
// 临时机器人
const c0 = await context("light", { width: 1280, height: 800 }); const p0 = await newPage(c0, "setup");
let bot = null;
if (process.env.CHAT === "1" && (!ONLY || ONLY.includes("chat"))) {
  await c0.route("**/*", (r) => r.continue());
  await p0.goto(`${base}/settings`, { waitUntil: "domcontentloaded" });
  await guardInit((p, o) => api(p0, p, o));
  bot = trackBot(await mkBot(p0, "对齐测试", "你是测试助手。"));
}
try {
  if (!process.env.MOBILE_ONLY) await run("light", { width: 1280, height: 800 }, "w", bot);
  if (!process.env.WIDE_ONLY) await run("dark", { width: 390, height: 844 }, "m", bot);
} finally {
  if (bot) { const ok = await guardedDeleteBot((p, o) => api(p0, p, o), bot).catch((e) => String(e)); log("bot deleted", JSON.stringify(ok)); }
}
const total = {}; for (const p of results.pages) for (const [k, v] of Object.entries(p.counts || {})) total[k] = (total[k] || 0) + v;
results.total = total; results.errors = errors.slice(0, 80);
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
console.log("TOTAL", JSON.stringify(total));
await browser.close();
if (process.env.FAIL_ON === "1" && Object.values(total).reduce((a, b) => a + b, 0) > 0) process.exit(1);
