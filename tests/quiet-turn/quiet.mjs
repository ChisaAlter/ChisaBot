// DESIGN §93 e2e（预览 + 假模型 mockquiet）：简单回合收起干活卡 + 开场一句收进卡片 + 无空气泡 + 底部不多留白。
// 临时机器人（guard），结束删；只放行这次测试自己需要的写。
// env: TAG, W (宽), H (高), THEME (light|dark), ONLY (quiet|loud), KEEP
import fs from "node:fs";
import { chromium } from "playwright-core";
// 自带的最小工具（不依赖 worker 机器上的 lib / guard）：只删这次自己建的机器人。
const base = process.env.BASE || "http://127.0.0.1:3001";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errors = [];
const exe = process.env.CHROME || (fs.existsSync("/ms-playwright") ? (() => { const d = fs.readdirSync("/ms-playwright").find((x) => x.startsWith("chromium-") && !x.includes("headless")); return `/ms-playwright/${d}/chrome-linux64/chrome`; })() : undefined);
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = (theme, viewport) => browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai" }).then(async (c) => { await c.addInitScript((t) => { try { localStorage.setItem("chisabot-theme", t); } catch {} }, theme); return c; });
async function newPage(c, tag) {
  const p = await c.newPage();
  p.on("pageerror", (e) => errors.push(`${tag} pageerror ${String(e).slice(0, 300)}`));
  return p;
}
const api = (page, path, init) => page.evaluate(async ([p, i]) => { const r = await fetch(p, { ...i, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.text() }; }, [path, init ?? {}]);
const created = new Set();
const guardInit = async () => {};
const trackBot = (id) => { created.add(id); return id; };
const guardedDeleteBot = async (call, id) => (created.has(id) ? call(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }) : { status: 0, refused: true });
async function mkBot(page, name, role) {
  const r = await api(page, "/api/agents", { method: "POST", body: JSON.stringify({ name, title: "临时测试（会删除）", roleDescription: role, visibility: "private" }) });
  return JSON.parse(r.body).agent.id;
}
const LEAD = "我来查看你当前在线电脑的屏幕";
const ANSWER = "这是你当前在线的";
const TAG = process.env.TAG || "q"; const OUT = process.env.OUT || `/tmp/quiet-${TAG}`; fs.mkdirSync(OUT, { recursive: true });
const W = Number(process.env.W || 1280); const H = Number(process.env.H || 860); const THEME = process.env.THEME || "light";
const fails = []; const check = (ok, msg) => { log(ok ? "PASS" : "FAIL", msg); if (!ok) fails.push(msg); };
const ctx = await context(THEME, { width: W, height: H });
// 截图地址换成一张 1600×670 的图（设备截图 30 分钟就过期；预览里也没有在线的电脑）。
const PNG = fs.readFileSync(process.env.SHOT || new URL("./shot.png", import.meta.url));
const page = await newPage(ctx, TAG);
await page.route("**/*", (route) => {
  const r = route.request(); const m = r.method(); const u = r.url();
  if (/\/api\/devices\/[^/]+\/screenshots\//.test(u)) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return route.continue();
  if (/\/api\/(agents|copilotkit|channels|bot-threads|chat|agui|messages|threads|link-preview)/.test(u)) return route.continue();
  log("BLOCKED", m, u.replace(base, "")); return route.fulfill({ status: 204, body: "" });
});
await page.goto(`${base}/settings`, { waitUntil: "domcontentloaded" });
const call = (p, o) => api(page, p, o);
await guardInit(call);
const bots = [];
const box = () => page.locator('[aria-label="消息"]').first();
const busy = () => page.locator('[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]').first().isVisible().catch(() => false);
const probe = () => page.evaluate(([LEAD]) => {
  const shown = (e) => { const r = e.getBoundingClientRect(); return e.offsetParent !== null && r.height > 1 && !e.closest("[data-folded]"); };
  const vis = (s) => [...document.querySelectorAll(s)].filter(shown);
  const main = document.querySelector('[data-slot="message-scroller-content"]');
  const vp = document.querySelector('[data-slot="message-scroller-viewport"]');
  const rows = main ? [...main.querySelectorAll("[data-message-id]")].filter((e) => !e.closest("[data-folded]") && !e.hasAttribute("data-folded") && shown(e)) : [];
  const lastRow = rows.at(-1);
  const composer = document.querySelector('[aria-label="消息"]')?.closest("form, [data-slot=composer], .chat-composer") ?? document.querySelector('[aria-label="消息"]');
  const vpBox = vp?.getBoundingClientRect();
  const spacer = main?.querySelector("[data-testid=kept-page][data-visible=true] [data-message-scroller-spacer]");
  const slack = main?.querySelector("[data-chat-slack]");
  const imgs = vis(".chat-bubbles ~ * img, [data-message-id] img").filter((i) => i.naturalWidth > 0);
  return {
    text: rows.map((e) => e.innerText).join("\n"),
    leadVisible: rows.some((e) => e.innerText.includes(LEAD)),
    live: vis("[data-testid=kept-page][data-visible=true] [data-testid=chat-work-card]").length,
    done: vis("[data-testid=kept-page][data-visible=true] [data-testid=chat-work-done]").length,
    emptyBubbles: vis("[data-cb-bubble]").filter((b) => !b.innerText.trim() && !b.querySelector("img,svg,canvas")).length,
    bubbles: vis("[data-cb-bubble]").map((b) => b.innerText.trim().slice(0, 40)),
    images: imgs.length,
    // 最后一行底边到视口底边 / 内容底边的距离
    lastBottom: lastRow ? Math.round(lastRow.getBoundingClientRect().bottom) : null,
    vpBottom: vpBox ? Math.round(vpBox.bottom) : null,
    composerTop: composer ? Math.round(composer.getBoundingClientRect().top) : null,
    scrollHeight: vp?.scrollHeight, scrollTop: Math.round(vp?.scrollTop ?? 0), clientHeight: vp?.clientHeight,
    spacerH: spacer && !spacer.hidden ? Math.round(spacer.getBoundingClientRect().height) : 0,
    slackH: slack && slack.style.display !== "none" ? Math.round(slack.getBoundingClientRect().height) : 0,
    contentBottom: main ? Math.round(main.getBoundingClientRect().bottom) : null,
    padBottom: main ? getComputedStyle(main).paddingBottom : null,
  };
}, [LEAD]);
const blank = (p) => (p.lastBottom !== null && p.vpBottom !== null ? Math.min(p.vpBottom, p.composerTop ?? p.vpBottom) - p.lastBottom : null);
async function newChat(name) {
  const bot = trackBot(await mkBot(page, name, "你是测试助手。")); bots.push(bot);
  await page.goto(`${base}/channel/new?agent=${encodeURIComponent(bot)}`, { waitUntil: "domcontentloaded" });
  await box().waitFor({ timeout: 60000 }); await page.waitForTimeout(1500);
}
/** 每一帧记最后一条用户消息离视口顶多远（看一轮结束时画面怎么动：平滑落下，不是一跳）。 */
const startTrace = (prompt) => page.evaluate((prompt) => {
  window.__trace = []; window.__tracing = true;
  const loop = () => {
    const vp = document.querySelector('[data-slot="message-scroller-viewport"]');
    const rows = [...document.querySelectorAll('[data-testid=kept-page][data-visible=true] [data-message-id]')].filter((e) => !e.closest("[data-folded]") && e.innerText.includes(prompt));
    const last = rows.at(-1);
    if (vp && last) window.__trace.push({ t: Math.round(performance.now()), y: Math.round(last.getBoundingClientRect().bottom), st: Math.round(vp.scrollTop), busy: !!document.querySelector('[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]') });
    if (window.__tracing) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}, prompt);
const stopTrace = () => page.evaluate(() => { window.__tracing = false; const tr = window.__trace || [];
  const end = tr.findIndex((f, i) => i > 0 && tr[i - 1].busy && !f.busy);
  const after = end < 0 ? [] : tr.slice(end);
  let maxDown = 0, maxUp = 0;
  for (let i = 1; i < after.length; i++) { const d = after[i].y - after[i - 1].y; if (d > maxDown) maxDown = d; if (-d > maxUp) maxUp = -d; }
  const moves = [];
  for (let i = Math.max(1, end - 40); i < tr.length; i++) { const d = tr[i].y - tr[i - 1].y; if (Math.abs(d) > 2 && moves.length < 40) moves.push(`${tr[i].t - (tr[end]?.t ?? 0)}:${d}:st${tr[i].st}${tr[i].busy ? "B" : ""}`); }
  return { frames: after.length, maxDown, maxUp, settle: after.length ? after.at(-1).y - after[0].y : 0, moves: moves.join(" ") };
});
async function sendAndWatch(prompt, tag) {
  await startTrace(prompt);
  await box().click(); await box().fill(prompt); await page.keyboard.press("Enter");
  const t0 = Date.now(); const seen = { liveCard: false, leadSeen: false, leadAfterTool: false, emptyMax: 0, samples: 0 };
  let idleSince = null;
  while (Date.now() - t0 < 90000) {
    const p = await probe(); seen.samples++;
    if (p.live) seen.liveCard = true;
    if (p.leadVisible) seen.leadSeen = true;
    if (p.leadVisible && p.live && !seen.leadAfterTool) seen.leadAfterToolAt = Date.now() - t0;
    seen.emptyMax = Math.max(seen.emptyMax, p.emptyBubbles);
    const b = await busy();
    if (!b && Date.now() - t0 > 4000) { idleSince ??= Date.now(); if (Date.now() - idleSince > 2500) break; } else idleSince = null;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  seen.motion = await stopTrace();
  seen.motion.release = await page.evaluate(() => document.querySelector('[data-slot="message-scroller-viewport"]')?.dataset.cbRelease ?? null);
  log(tag, "motion after the turn ended", JSON.stringify(seen.motion));
  await page.screenshot({ path: `${OUT}/${tag}-done.png` });
  return seen;
}
async function reopen() {
  await page.reload({ waitUntil: "domcontentloaded" }); await box().waitFor({ timeout: 60000 }); await page.waitForTimeout(4500);
}
try {
  const ONLY = process.env.ONLY || "";
  // 基线：没有工具的短回答之后的底部留白
  await newChat("简单回合测试");
  // 先撑过一屏（用户那段对话有 60 条），再看最后一轮下面留多少空：只该是正常的底边距。
  await sendAndWatch("LONG 讲长一点", "long");
  let p = await probe();
  const baseBlank = blank(p);
  log("LONG metrics", JSON.stringify({ ...p, text: undefined }), "blank", baseBlank);
  const reserve = (q) => q.spacerH + q.slackH;
  if (!ONLY || ONLY === "quiet") {
    const seen = await sendAndWatch("QUIET k看我当前的电脑", "quiet");
    p = await probe();
    log("QUIET metrics", JSON.stringify({ ...p, text: p.text.slice(-120) }), "blank", blank(p));
    check(seen.liveCard, "QUIET live: work card visible while running");
    check(seen.motion.maxUp <= 2 && seen.motion.maxDown <= 90, `QUIET: end-of-turn motion is a glide, no jump back (${JSON.stringify(seen.motion)})`);
    check(p.live === 0 && p.done === 0, `QUIET done: no work card row (live ${p.live} done ${p.done})`);
    check(!p.leadVisible, "QUIET done: lead narration folded");
    check(p.text.includes(ANSWER), "QUIET done: answer visible");
    check(p.emptyBubbles === 0 && seen.emptyMax === 0, `QUIET: never an empty bubble (now ${p.emptyBubbles}, max ${seen.emptyMax}) ${JSON.stringify(p.bubbles)}`);
    check(p.images >= 1, `QUIET: screenshot image shown (${p.images})`);
    check(reserve(p) === 0 && blank(p) !== null && blank(p) <= (baseBlank ?? 0) + 8, `QUIET: no reserved space below the finished turn (spacer ${p.spacerH} slack ${p.slackH}, blank ${blank(p)} vs long-answer baseline ${baseBlank})`);
    await reopen();
    p = await probe();
    log("QUIET reload metrics", JSON.stringify({ ...p, text: p.text.slice(-120) }), "blank", blank(p));
    check(p.live === 0 && p.done === 0, `QUIET reload: no work card row (${p.done})`);
    check(!p.leadVisible, "QUIET reload: lead narration folded");
    check(p.emptyBubbles === 0, `QUIET reload: no empty bubble (${p.emptyBubbles})`);
    check(p.images >= 1, `QUIET reload: image (${p.images})`);
    check(reserve(p) === 0 && blank(p) !== null && blank(p) <= (baseBlank ?? 0) + 8, `QUIET reload: no reserved space (spacer ${p.spacerH} slack ${p.slackH}, blank ${blank(p)} vs ${baseBlank})`);
    await page.screenshot({ path: `${OUT}/quiet-reload.png` });
  }
  if (!ONLY || ONLY === "loud") {
    await sendAndWatch("LOUD 看看电脑和页面", "loud");
    p = await probe();
    log("LOUD metrics", JSON.stringify({ ...p, text: p.text.slice(-120) }), "blank", blank(p));
    check(p.done >= 1, `LOUD (4 steps): done card stays (${p.done})`);
    check(reserve(p) === 0, `LOUD: no reserved space below (spacer ${p.spacerH} slack ${p.slackH}, blank ${blank(p)})`);
    check(!p.leadVisible, "LOUD: lead narration folded into the card");
    const card = page.locator("[data-testid=kept-page][data-visible=true] [data-testid=chat-work-done]").last();
    await card.click(); await page.waitForTimeout(400);
    const notes = await page.locator("[data-testid=kept-page][data-visible=true] .chat-work-note").allInnerTexts();
    check(notes.some((n) => n.includes(LEAD)), `LOUD: lead sentence inside the opened card (${JSON.stringify(notes)})`);
    await page.screenshot({ path: `${OUT}/loud-open.png` });
    await card.click(); await page.waitForTimeout(300);
  }
  log("thread", page.url());
} catch (e) {
  fails.push(`exception ${String(e).slice(0, 300)}`); log("EXC", e);
} finally {
  if (!process.env.KEEP) for (const b of bots) log("delete", b, (await guardedDeleteBot(call, b)).status);
  log("errors", JSON.stringify(errors.slice(0, 20)));
  log(fails.length ? `RESULT FAIL ${fails.length}: ${fails.join(" | ")}` : "RESULT ALL PASS");
  await browser.close();
  if (fails.length) process.exitCode = 1;
}
