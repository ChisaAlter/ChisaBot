// e2e（DESIGN.md §84）：左栏「机器人 ↔ Claude Code」来回切换是原地切换，不是整屏刷新。只读：非 GET 全部拦掉。
// 每次切换逐帧（requestAnimationFrame）记录：文档导航数、外壳 / 顶栏 / 左栏容器 / 左栏两块内容是否换了元素、
// 整屏骨架帧、外壳缺席帧、主区空白帧、请求；切回来时回到原来那条对话。1280 亮 / 1280 暗 / 390 亮 / 390 暗。
// env: BASE, TOK（可选，生产只读）, TAG, OUT_DIR, CYCLES（默认 3）, VIEWS, EXPECT=0（只记录不判定，对照修复前）
import fs from "node:fs";
import { chromium } from "playwright-core";
const base = process.env.BASE || "http://127.0.0.1:3001";
const TOK = process.env.TOK;
const TAG = process.env.TAG || "x";
const OUT = `${process.env.OUT_DIR || "/tmp"}/mode-switch-${TAG}`;
const CYCLES = Number(process.env.CYCLES || 3);
const VIEWS = (process.env.VIEWS || "1280-light,1280-dark,390-light,390-dark").split(",");
const EXPECT = process.env.EXPECT !== "0";
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errors = [];
const fails = [];
const check = (ok, msg) => { if (!EXPECT) return log("INFO", ok ? "ok" : "no", msg); log(ok ? "PASS" : "FAIL", msg); if (!ok) fails.push(msg); };
const exe = process.env.CHROME || (() => { const d = fs.existsSync("/ms-playwright") ? fs.readdirSync("/ms-playwright").find((x) => x.startsWith("chromium-") && !x.includes("headless")) : null; return d ? `/ms-playwright/${d}/chrome-linux64/chrome` : undefined; })();
const host = new URL(base).hostname;
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage", ...(host === "example.com" ? ["--host-resolver-rules=MAP example.com 127.0.0.1"] : [])] });

const SAMPLER = () => {
  window.__frames = [];
  window.__sampling = false;
  const id = (el) => {
    if (!el) return null;
    if (!el.__cbid) el.__cbid = Math.random().toString(36).slice(2, 8);
    return el.__cbid;
  };
  const tick = () => {
    if (window.__sampling) {
      const main = document.querySelector(".glass-main");
      window.__frames.push({
        url: location.pathname,
        shell: id(document.querySelector(".glass-shell")),
        top: id(document.querySelector(".glass-topbar")),
        side: id(document.querySelector('[data-slot="sidebar-container"]')),
        main: id(main),
        botsPane: id(document.querySelector('[data-pane="bots"]')),
        appSkel: !!document.querySelector(".sky-skel"),
        routeSkel: !!document.querySelector(".glass-main .route-skel, .glass-main .page-skeleton"),
        mainText: main ? main.innerText.trim().length : -1,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
const CHAT_READY = '.glass-main [contenteditable="true"], .glass-main textarea, [data-testid="composer-send"]';
const CC_READY = '[data-testid="cc-home"], [data-testid="cc-phone-home"], [data-testid="cc-goto-login"], .cc-center, [data-testid="cc-session"]';

async function clickMode(page, phone, to) {
  const sel = to === "cc" ? '[data-testid="left-mode-cc"]' : '[data-testid="left-mode-switch"] button[role="radio"]:first-child';
  let btn = page.locator(`${sel}:visible`).first();
  if (phone && !(await btn.isVisible().catch(() => false))) {
    await page.locator('button[aria-label^="打开"]').first().click();
    await page.waitForTimeout(450);
    btn = page.locator(`${sel}:visible`).first();
  }
  await btn.click();
}

const results = {};
for (const view of VIEWS) {
  const [w, theme] = view.split("-");
  const phone = w === "390";
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 860 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript((t) => { try { localStorage.setItem("openbot-theme", t); localStorage.setItem("chisabot-left-mode", "bots"); } catch {} }, theme);
  await ctx.addInitScript(SAMPLER);
  if (TOK) await ctx.addCookies([{ name: "__Host-openbot_session", value: TOK, url: base, secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${view} pageerror ${String(e).slice(0, 300)}`));
  await page.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) ? r.continue() : r.fulfill({ status: 204, body: "" })));
  let docNavs = 0;
  const reqs = [];
  page.on("request", (r) => {
    if (r.resourceType() === "document" && r.frame() === page.mainFrame()) docNavs++;
    reqs.push(`${r.resourceType()}:${r.url().replace(base, "").slice(0, 100)}`);
  });
  try {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/channel\//, { timeout: 60000 });
    await page.locator(CHAT_READY).first().waitFor({ timeout: 60000 });
    if (!(await page.locator('[data-testid="left-mode-switch"]').count()) && !phone) throw new Error("没有左栏切换（不是管理员？）");
    await page.waitForTimeout(3500);
    const home = new URL(page.url()).pathname;
    const sw = [];
    for (let i = 0; i < CYCLES * 2; i++) {
      const to = i % 2 === 0 ? "cc" : "bots";
      const before = await page.evaluate(() => {
        const id = (el) => {
    if (!el) return null;
    if (!el.__cbid) el.__cbid = Math.random().toString(36).slice(2, 8);
    return el.__cbid;
  };
        window.__frames = [];
        window.__sampling = true;
        return { shell: id(document.querySelector(".glass-shell")), top: id(document.querySelector(".glass-topbar")), side: id(document.querySelector('[data-slot="sidebar-container"]')) };
      });
      const nav0 = docNavs;
      const r0 = reqs.length;
      const t0 = Date.now();
      await clickMode(page, phone, to);
      if (to === "cc") {
        await page.waitForURL(/\/cc/, { timeout: 30000 });
        await page.locator(CC_READY).first().waitFor({ timeout: 30000 });
      } else {
        await page.waitForURL((u) => /\/channel\//.test(u.pathname), { timeout: 30000 });
        await page.locator(CHAT_READY).first().waitFor({ timeout: 30000 });
      }
      const settle = Date.now() - t0;
      await page.waitForTimeout(900);
      const frames = await page.evaluate(() => { window.__sampling = false; return window.__frames; });
      const uniq = (k) => [...new Set([before[k], ...frames.map((f) => f[k])].filter(Boolean))];
      const s = {
        to, settle, docNavs: docNavs - nav0, frames: frames.length,
        shell: uniq("shell").length, top: uniq("top").length, side: uniq("side").length,
        botsPanes: [...new Set(frames.map((f) => f.botsPane).filter(Boolean))].length,
        noShell: frames.filter((f) => !f.shell).length, appSkel: frames.filter((f) => f.appSkel).length,
        routeSkel: frames.filter((f) => f.routeSkel).length,
        blankMain: frames.filter((f) => f.shell && f.mainText === 0 && !f.routeSkel).length,
        api: reqs.slice(r0).filter((r) => r.includes("/api/")).length,
        js: reqs.slice(r0).filter((r) => r.startsWith("script:")).length,
        url: new URL(page.url()).pathname,
      };
      sw.push(s);
      log(view, i, JSON.stringify(s));
      await page.screenshot({ path: `${OUT}/${view}-${i}-${to}.png` });
      check(s.docNavs === 0, `${view} #${i} →${to}: 没有整页导航 (${s.docNavs})`);
      check(s.shell === 1 && s.top === 1, `${view} #${i} →${to}: 外壳和顶栏还是原来那个元素 (shell ${s.shell}, top ${s.top})`);
      if (!phone) check(s.side === 1, `${view} #${i} →${to}: 左栏容器还是原来那个元素 (${s.side})`);
      if (!phone) check(s.botsPanes <= 1, `${view} #${i} →${to}: 机器人左栏没有重挂 (${s.botsPanes})`);
      check(s.noShell === 0 && s.appSkel === 0, `${view} #${i} →${to}: 没有整屏骨架 / 整屏空白帧 (noShell ${s.noShell}, appSkel ${s.appSkel})`);
      check(s.blankMain === 0, `${view} #${i} →${to}: 主区没有空白帧 (${s.blankMain})`);
      if (to === "bots") check(s.url === home, `${view} #${i}: 切回机器人回到原来那条对话 (${s.url} vs ${home})`);
      await page.waitForTimeout(500);
    }
    results[view] = sw;
  } catch (e) {
    check(false, `${view}: ${String(e).slice(0, 300)}`);
  }
  await ctx.close();
}
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(results, null, 1));
check(errors.length === 0, `没有页面错误 ${errors.join(" | ")}`);
await browser.close();
log(fails.length ? `FAIL ${fails.length}` : "ALL PASS");
process.exit(fails.length && EXPECT ? 1 : 0);
