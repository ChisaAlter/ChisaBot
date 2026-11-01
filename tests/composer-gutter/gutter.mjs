// 输入框两边 / 底边留白（DESIGN.md §24、§91）：窄窗口里聊天输入框不能贴左栏、窗口右边、右栏，也不能压到「面板」把手。
// 只读：所有非 GET 请求一律在本地 fulfill，不写任何东西。
//
//   BASE=http://127.0.0.1:<预览端口> CH=/channel/<对话 id> AGENT=<机器人 id> node tests/composer-gutter/gutter.mjs
//   可选：TOK（生产只读检查的登录 cookie）、WIDTHS=390,700,…、OUT_DIR、TAG
//   MIN=16（左右 / 底边最小留白，DESIGN §24 的 16px）、HANDLE_MIN=4（输入框右沿到把手左沿至少 4px）
//   ASSERT=0 只记录不判失败（量修复前的版本）。退出码 1 = 有失败。
import fs from "node:fs";
import { chromium } from "playwright-core";
const base = process.env.BASE || "http://127.0.0.1:3001";
const TOK = process.env.TOK;
const CH = process.env.CH; const AGENT = process.env.AGENT;
const MIN = Number(process.env.MIN || 16); const HANDLE_MIN = Number(process.env.HANDLE_MIN || 4);
const ASSERT = process.env.ASSERT !== "0";
const WIDTHS = String(process.env.WIDTHS || "390,700,800,884,1000,1100,1280,1440").split(",").map(Number);
const TAG = process.env.TAG || "x"; const OUT = `${process.env.OUT_DIR || "/tmp"}/composer-gutter-${TAG}`; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errors = [];
const exe = process.env.CHROME || (() => { const d = fs.existsSync("/ms-playwright") ? fs.readdirSync("/ms-playwright").find((x) => x.startsWith("chromium-") && !x.includes("headless")) : null; return d ? `/ms-playwright/${d}/chrome-linux64/chrome` : undefined; })();
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage", ...(process.env.HOST_RULES ? [`--host-resolver-rules=${process.env.HOST_RULES}`] : [])] });
const fails = []; const rows = [];
const check = (ok, msg) => { if (!ok) { log(ASSERT ? "FAIL" : "INFO", msg); if (ASSERT) fails.push(msg); } };

async function context(theme, viewport) {
  const phone = viewport.width < 500;
  const ctx = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript((t) => { try { localStorage.setItem("chisabot-theme", t); } catch {} }, theme);
  if (TOK) await ctx.addCookies([{ name: "__Host-openbot_session", value: TOK, url: base, secure: true, httpOnly: true, sameSite: "Lax" }]);
  await ctx.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) ? r.continue() : r.fulfill({ status: 204, body: "" })));
  return ctx;
}

/** 在页面里量：输入框卡片 vs 左右邻居（左栏卡 / 主区边 / 右栏卡 / 窗口边）和「面板」把手，以及消息列的内容边。 */
const measure = () => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  const comps = [...document.querySelectorAll("[data-testid=kept-page][data-visible=true] .glass-composer")].filter(vis);
  if (!comps.length) return { none: true };
  const c = comps.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0].getBoundingClientRect();
  const main = document.querySelector(".glass-main")?.getBoundingClientRect();
  const W = innerWidth; const H = innerHeight;
  let left = main ? Math.max(0, main.left) : 0; let right = main ? Math.min(W, main.right) : W;
  // 左边看得见的左栏卡（展开的 276px 卡或收起的 80px 头像栏），只算在输入框左边的
  for (const e of document.querySelectorAll('[data-slot="sidebar-inner"]')) { if (!vis(e)) continue; const r = e.getBoundingClientRect(); if (r.right <= c.left + 1 && r.bottom > c.top && r.top < c.bottom) left = Math.max(left, r.right); }
  // 右边：glass-body 里主区之外的栏（右栏卡）、cc 右栏
  for (const e of document.querySelectorAll(".glass-body > :not(main), .cc-right")) { if (!vis(e)) continue; const r = e.getBoundingClientRect(); if (r.left >= c.right - 1 && r.bottom > c.top && r.top < c.bottom && r.width > 20) right = Math.min(right, r.left); }
  const hEl = [...document.querySelectorAll(".rail-tab")].find(vis);
  const h = hEl?.getBoundingClientRect();
  const tr = document.querySelector('[data-testid=kept-page][data-visible=true] [data-testid="chat-transcript"]');
  let col = null;
  if (tr && vis(tr)) { const r = tr.getBoundingClientRect(); const s = getComputedStyle(tr); col = { l: Math.round(r.left + parseFloat(s.paddingLeft)), r: Math.round(r.right - parseFloat(s.paddingRight)) }; }
  const bottomEdge = Math.min(H, main ? main.bottom : H);
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    phone: document.documentElement.hasAttribute("data-phone"),
    comp: { l: r1(c.left), r: r1(c.right), w: r1(c.width), b: r1(c.bottom) },
    leftBound: r1(left), rightBound: r1(right),
    gl: r1(c.left - left), gr: r1(right - c.right), gb: r1(bottomEdge - c.bottom),
    handle: h ? { l: r1(h.left), clear: r1(h.left - c.right), vOverlap: h.bottom > c.top && h.top < c.bottom } : null,
    col, dl: col ? r1(c.left - col.l) : null, dr: col ? r1(col.r - c.right) : null,
  };
};

async function shot(p, tag, label, opts = {}) {
  const m = await p.evaluate(measure);
  rows.push({ tag, label, ...m });
  if (m.none) { log(tag, label, "NO COMPOSER"); check(false, `${tag} ${label}: 没找到输入框`); return m; }
  log(tag, label, `gutter L ${m.gl} R ${m.gr} B ${m.gb}`, m.handle ? `handle clear ${m.handle.clear}${m.handle.vOverlap ? " (same rows)" : ""}` : "no handle", m.col ? `col Δ L ${m.dl} R ${m.dr}` : "");
  check(m.gl >= MIN - 0.5, `${tag} ${label}: 输入框左边留白 ${m.gl}px < ${MIN}`);
  check(m.gr >= MIN - 0.5, `${tag} ${label}: 输入框右边留白 ${m.gr}px < ${MIN}`);
  if (!opts.keyboard) check(m.gb >= Math.min(MIN, 8) - 0.5, `${tag} ${label}: 输入框底边留白 ${m.gb}px`);
  if (m.handle) check(m.handle.clear >= HANDLE_MIN - 0.5, `${tag} ${label}: 输入框右沿离「面板」把手只有 ${m.handle.clear}px`);
  await p.screenshot({ path: `${OUT}/${tag}-${label}.png` });
  return m;
}

const cases = [];
for (const w of WIDTHS) cases.push({ w, theme: [390, 884, 1280].includes(w) ? "dark" : "light" });
for (const w of [390, 884, 1280]) cases.push({ w, theme: "light" });
for (const { w, theme } of cases) {
  const tag = `${w}-${theme}`;
  const ctx = await context(theme, { width: w, height: w < 500 ? 844 : 840 });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${tag} pageerror ${String(e).slice(0, 300)}`));
  if (CH) {
    await p.goto(`${base}${CH}`, { waitUntil: "domcontentloaded" });
    await p.locator("[data-testid=kept-page][data-visible=true] .glass-composer").first().waitFor({ timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(4000);
    await shot(p, tag, "thread");
    // 右栏：宽屏默认是一张右栏卡（量的就是它开着的样子），再收起量一次；窄屏是把手，点开是盖在聊天上的抽屉
    const collapse = p.locator('[aria-label="收起右栏"]').filter({ visible: true }).first();
    const handle = p.locator(".rail-tab").filter({ visible: true }).first();
    if (await collapse.count()) {
      await collapse.click().catch(() => {}); await p.waitForTimeout(900);
      await shot(p, tag, "thread-rail-closed");
      const open = p.locator('[aria-label="展开面板"]').filter({ visible: true }).first();
      if (await open.count()) { await open.click().catch(() => {}); await p.waitForTimeout(900); }
    } else if (await handle.count()) {
      await handle.click().catch(() => {}); await p.waitForTimeout(900);
      const m = await p.evaluate(measure);
      if (!m.none && m.rightBound < w - 1) await shot(p, tag, "thread-rail-open");
      else log(tag, "rail opens as an overlay over the chat — nothing to measure");
      await p.keyboard.press("Escape").catch(() => {}); await p.waitForTimeout(300);
    }
    // 左栏收起成 80px 头像栏（只桌面；Ctrl B）
    if (w >= 768) {
      await p.goto(`${base}${CH}`, { waitUntil: "domcontentloaded" }); await p.locator("[data-testid=kept-page][data-visible=true] .glass-composer").first().waitFor({ timeout: 30000 }).catch(() => {}); await p.waitForTimeout(2500);
      await p.keyboard.press("Control+b"); await p.waitForTimeout(800);
      await shot(p, tag, "thread-sidebar-collapsed");
      await p.keyboard.press("Control+b"); await p.waitForTimeout(500);
    }
  }
  if (AGENT) {
    await p.goto(`${base}/channel/new?agent=${encodeURIComponent(AGENT)}&topic=new`, { waitUntil: "domcontentloaded" });
    await p.locator("[data-testid=kept-page][data-visible=true] .glass-composer").first().waitFor({ timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(2500);
    await shot(p, tag, "new-chat");
  }
  await ctx.close();
}
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ rows, errors }, null, 1));
const pe = errors.filter((e) => /pageerror/.test(e));
check(pe.length === 0, `no page errors (${pe.length}) ${pe.slice(0, 3).join(" | ")}`);
const worst = rows.filter((r) => !r.none).reduce((a, r) => Math.min(a, r.gl, r.gr), 1e9);
log("MIN-GUTTER", worst, "rows", rows.length, "fails", fails.length);
console.log(fails.length ? `FAIL ${fails.length}` : "ALL PASS");
await browser.close();
process.exit(fails.length ? 1 : 0);
