import { chromium } from "playwright-core";
import fs from "node:fs";
export const base = process.env.BASE || "http://127.0.0.1:3001";
export const TOK = process.env.TOK;
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const exe = fs.readdirSync("/ms-playwright").find((d) => d.startsWith("chromium-") && !d.includes("headless"));
// 有界面（Xvfb 上的真 Chrome 窗口），像人一样用页面。
export const browser = await chromium.launch({ headless: false, executablePath: `/ms-playwright/${exe}/chrome-linux64/chrome`, args: ["--no-sandbox", "--disable-dev-shm-usage", ...(process.env.HOST_MAP ? [`--host-resolver-rules=${process.env.HOST_MAP}`] : [])] });
export const errors = [];
const PC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ChisaBot/0.1.15 Chrome/146.0.7680.80 Electron/44.7.0 Safari/537.36";
export async function context({ pc = false, viewport } = {}) {
  const vp = viewport || (pc ? { width: 1280, height: 840 } : { width: 1440, height: 900 });
  const ctx = await browser.newContext({ viewport: vp, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true, ...(pc ? { userAgent: PC_UA } : {}) });
  if (pc) await ctx.addInitScript(() => {
    const noop = () => {}; const off = () => noop;
    window.chisabotWindow = { platform: "win32", minimize: noop, toggleMaximize: noop, close: noop, isMaximized: async () => false, onMaximizedChange: off, toggleCompact: noop, isCompact: async () => false, onCompactChange: off };
  });
  if (TOK) await ctx.addCookies([{ name: "__Host-openbot_session", value: TOK, domain: new URL(base).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  return ctx;
}
export async function newPage(ctx, tag) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${tag} pageerror ${String(e).slice(0, 300)}`));
  p.on("console", (m) => { if (m.type() === "error" && !/status of 404/.test(m.text())) errors.push(`${tag} console ${m.text().slice(0, 300)}`); });
  p.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) errors.push(`${tag} http ${r.status()} ${r.request().method()} ${r.url().replace(base, "").slice(0, 160)}`); });
  return p;
}
export const api = (page, path, init) => page.evaluate(async ([p, i]) => { const r = await fetch(p, { ...i, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.text() }; }, [path, init ?? {}]);
export const ta = (page) => page.locator('[aria-label="消息"]:visible').first();
export const busy = (page) => page.locator('[data-testid="composer-stop"]:visible, [data-testid="composer-queue"]:visible').first().isVisible().catch(() => false);
export async function chisaBot(page, bot) {
  await page.goto(`${base}/bot?agent=${encodeURIComponent(bot)}`, { waitUntil: "domcontentloaded" }); await page.waitForURL(/\/channel\//, { timeout: 60000 });
  await ta(page).waitFor({ timeout: 60000 }); await page.waitForTimeout(2000);
}
// 像人一样：点输入框、逐字输入、回车
export async function send(page, text) { await ta(page).click(); await ta(page).pressSequentially(text, { delay: 8 }); await page.waitForTimeout(300); await page.keyboard.press("Enter"); log("sent", text.slice(0, 100)); }
/** 等这一轮结束；途中出现确认卡片就像用户一样点「确认」。 */
export async function waitIdle(page, { max = 300000, approve = true, shotEvery = 0, shotPrefix = "/out/progress" } = {}) {
  const t0 = Date.now(); let idle = null; const events = []; let lastShot = 0; let n = 0;
  await page.waitForTimeout(3000);
  while (Date.now() - t0 < max) {
    await page.waitForTimeout(1500);
    if (approve) {
      for (const sel of ['[data-testid="confirm-approve"]:visible:text-is("确认")', 'button:visible:text-is("批准")', 'button:visible:text-is("允许")']) {
        const b = page.locator(sel).first();
        if (await b.isVisible().catch(() => false)) { const t = await b.innerText().catch(() => ""); await b.click().catch(() => {}); events.push(`${Math.round((Date.now() - t0) / 1000)}s clicked ${sel} "${t}"`); log("clicked", sel, t); await page.waitForTimeout(1500); }
      }
    }
    if (shotEvery && Date.now() - lastShot > shotEvery) { lastShot = Date.now(); await page.screenshot({ path: `${shotPrefix}-${String(n++).padStart(2, "0")}.png` }).catch(() => {}); }
    if (!(await busy(page))) { idle ??= Date.now(); if (Date.now() - idle > 8000) break; } else idle = null;
  }
  return { ms: Date.now() - t0, events, timedOut: Date.now() - t0 >= max };
}
export const transcript = (page) => page.locator('[data-slot="message-scroller-viewport"]:visible').first().innerText().catch(() => "");
export async function threadOf(page) {
  const id = new URL(page.url()).pathname.split("/channel/")[1]?.split("/")[0];
  const r = await api(page, `/api/channels/${id}`); try { return JSON.parse(r.body).channel?.threadId || JSON.parse(r.body).threadId; } catch { return null; }
}
export async function threadMessages(page, tid) {
  const r = await api(page, `/api/copilotkit/threads/${tid}/messages`); try { const j = JSON.parse(r.body); return j.messages || j; } catch { return []; }
}
export function summarize(msgs, fromIndex = 0) {
  const out = [];
  for (const m of (Array.isArray(msgs) ? msgs : []).slice(fromIndex)) {
    if (m.role === "assistant") {
      for (const tc of m.toolCalls || []) out.push(`  → ${tc.function?.name}(${String(tc.function?.arguments || "").slice(0, 160)})`);
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      if (c.trim()) out.push(`  BOT: ${c.replace(/\s+/g, " ").slice(0, 600)}`);
    } else if (m.role === "tool") out.push(`  ← ${String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).replace(/\s+/g, " ").slice(0, 220)}`);
    else if (m.role === "user") out.push(`USER: ${String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return out.join("\n");
}
