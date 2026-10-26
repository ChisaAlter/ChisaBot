import { chromium } from "playwright-core";
import fs from "node:fs";
export const base = process.env.BASE || "http://127.0.0.1:3001";
export const TOK = process.env.TOK;
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const exe = fs.readdirSync("/ms-playwright").find((d) => d.startsWith("chromium-") && !d.includes("headless"));
export const browser = await chromium.launch({ headless: true, executablePath: `/ms-playwright/${exe}/chrome-linux64/chrome`, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
export const errors = [];
export async function context(theme, viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true, ...extra });
  await ctx.addInitScript((t) => { try { localStorage.setItem("chisabot-theme", t); } catch {} }, theme);
  if (TOK) await ctx.addCookies([{ name: "__Host-openbot_session", value: TOK, domain: new URL(process.env.BASE || "http://127.0.0.1:3001").hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
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
export async function mkBot(page, name, role = "你是测试助手，回答简短，用中文。") {
  const r = await api(page, "/api/agents", { method: "POST", body: JSON.stringify({ name, title: "临时测试（会删除）", roleDescription: role, visibility: "private" }) });
  const id = JSON.parse(r.body).agent.id; fs.appendFileSync("/out/bots.txt", id + "\n"); return id;
}
export const ta = (page) => page.locator('[aria-label="消息"]:visible').first();
export const busy = (page) => page.locator('[data-testid="composer-stop"], [data-testid="composer-queue"]').first().isVisible().catch(() => false);
export async function chisaBot(page, bot) {
  await page.goto(`${base}/bot?agent=${encodeURIComponent(bot)}`, { waitUntil: "domcontentloaded" }); await page.waitForURL(/\/channel\//, { timeout: 60000 });
  await ta(page).waitFor({ timeout: 60000 }); await page.waitForTimeout(1500);
}
export async function send(page, text) { await ta(page).click(); await ta(page).fill(text); await page.keyboard.press("Enter"); log("sent", text.slice(0, 80)); }
export async function waitIdle(page, { max = 240000, onTick } = {}) {
  const t0 = Date.now(); let idle = null; let first = null;
  await page.waitForTimeout(2500);
  while (Date.now() - t0 < max) {
    await page.waitForTimeout(1200);
    if (onTick) await onTick(Date.now() - t0);
    if (!(await busy(page))) { idle ??= Date.now(); if (Date.now() - idle > 5000) break; } else idle = null;
  }
  return Date.now() - t0;
}
export const transcript = (page) => page.locator('[data-slot="message-scroller-viewport"]').first().innerText().catch(() => "");
export async function lastReply(page, text) { return (await transcript(page)).split(text).pop().trim(); }
