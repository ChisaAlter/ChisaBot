// e2e（DESIGN.md §23 / §79）：右栏「面板 | 计算机」两个入口都在（空聊天 / 新话题 + 已有对话；1280 亮 + 390 暗）。只读：非 GET 全部拦掉。
import fs from "node:fs";
import { chromium } from "playwright-core";
const base = process.env.BASE || "http://127.0.0.1:3001";
const TOK = process.env.TOK; // 可选：登录 cookie（生产只读检查用）
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errors = [];
const exe = process.env.CHROME || (() => { const d = fs.existsSync("/ms-playwright") ? fs.readdirSync("/ms-playwright").find((x) => x.startsWith("chromium-") && !x.includes("headless")) : null; return d ? `/ms-playwright/${d}/chrome-linux64/chrome` : undefined; })();
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
async function context(theme, viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true, ...extra });
  await ctx.addInitScript((t) => { try { localStorage.setItem("chisabot-theme", t); } catch {} }, theme);
  if (TOK) await ctx.addCookies([{ name: "__Host-openbot_session", value: TOK, url: base, secure: true, httpOnly: true, sameSite: "Lax" }]);
  return ctx;
}
async function newPage(ctx, tag) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${tag} pageerror ${String(e).slice(0, 300)}`));
  return p;
}
const api = (page, path) => page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, body: await r.text() }; }, path);
const TAG = process.env.TAG || "x"; const OUT = `${process.env.OUT_DIR || "/tmp"}/rail-computer-${TAG}`; fs.mkdirSync(OUT, { recursive: true });
const EXPECT_NEW = process.env.EXPECT_NEW !== "0"; // 0 = 只记录空聊天（对照修复前的版本）
const fails = []; const check = (ok, msg) => { log(ok ? "PASS" : "FAIL", msg); if (!ok) fails.push(msg); };
const block = (p) => p.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) ? r.continue() : r.fulfill({ status: 204, body: "" })));
const state = (p) => p.evaluate(() => ({
  url: location.pathname + location.search,
  radios: [...document.querySelectorAll('[role="radiogroup"][aria-label="右栏内容"] [role="radio"]')].map((r) => ({ t: r.textContent.trim(), on: r.getAttribute("aria-checked") })),
  head: document.querySelector(".rail-head-t")?.textContent ?? null,
  computerPane: [...document.querySelectorAll(".rail-pane[data-active='true']")].some((el) => el.querySelector("[aria-label='计算机']") || el.textContent.includes("浏览器")),
}));
async function scenario(p, tag, url, narrow, must) {
  await p.goto(url, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(5000);
  if (narrow) { const h = p.locator(".rail-tab.is-narrow").first(); check((await h.count()) > 0, `${tag}: 窄屏有「面板」把手`); if (await h.count()) { await h.click(); await p.waitForTimeout(1200); } }
  const s = await state(p); log(tag, JSON.stringify(s));
  await p.screenshot({ path: `${OUT}/${tag}-panels.png` });
  const names = s.radios.map((r) => r.t);
  const both = names.includes("面板") && names.includes("计算机");
  if (must) check(both, `${tag}: 右栏有「面板」和「计算机」两个入口 (${JSON.stringify(names)} head=${s.head})`);
  else log("INFO", `${tag}: both=${both}`);
  if (!both) return;
  await p.locator('[role="radiogroup"][aria-label="右栏内容"] [role="radio"]', { hasText: "计算机" }).click();
  await p.waitForTimeout(2500);
  const s2 = await state(p); log(tag, "after click", JSON.stringify(s2));
  check(s2.url.includes("watch=true"), `${tag}: 点「计算机」后地址带 watch=true`);
  check(s2.radios.find((r) => r.t === "计算机")?.on === "true", `${tag}: 「计算机」标签选中`);
  await p.screenshot({ path: `${OUT}/${tag}-computer.png` });
  await p.locator('[role="radiogroup"][aria-label="右栏内容"] [role="radio"]', { hasText: "面板" }).click();
  await p.waitForTimeout(1200);
  const s3 = await state(p);
  check(!s3.url.includes("watch=true") && s3.radios.find((r) => r.t === "面板")?.on === "true", `${tag}: 切回「面板」`);
}
const d = await context("light", { width: 1280, height: 860 });
const page = await newPage(d, "d"); await block(page);
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(5000);
log("version", JSON.parse((await api(page, "/api/version")).body).commit);
const agents = JSON.parse((await api(page, "/api/agents")).body); const list = agents.agents ?? agents.items ?? agents;
const bot = list[0].id; log("bot", bot, list[0].name);
const chs = JSON.parse((await api(page, "/api/channels?limit=20")).body).channels ?? [];
const ch = chs.find((c) => c.agentIds?.length === 1);
const fresh = `${base}/channel/new?agent=${encodeURIComponent(bot)}&topic=new`;
const urls = [["new", fresh, EXPECT_NEW], ...(ch ? [["chan", `${base}/channel/${ch.id}`, true]] : [])];
if (!ch) log("INFO no existing channel");
for (const [k, u, must] of urls) await scenario(page, `1280-light-${k}`, u, false, must);
const m = await context("dark", { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
const mp = await newPage(m, "m"); await block(mp);
for (const [k, u, must] of urls) await scenario(mp, `390-dark-${k}`, u, true, must);
// 1280 dark + 390 light, 空聊天
const d2 = await context("dark", { width: 1280, height: 860 }); const p2 = await newPage(d2, "d2"); await block(p2);
await scenario(p2, "1280-dark-new", fresh, false, EXPECT_NEW);
const m2 = await context("light", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }); const p3 = await newPage(m2, "m2"); await block(p3);
await scenario(p3, "390-light-new", fresh, true, EXPECT_NEW);
log("ERRORS", errors.length, JSON.stringify(errors.slice(0, 10)));
log(fails.length ? `RESULT FAIL ${fails.length}` : "RESULT PASS");
await browser.close();
process.exit(fails.length ? 1 : 0);
