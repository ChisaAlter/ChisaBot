// DESIGN §90 e2e（预览 :3251 + 假模型 mockfold）：过程话收进干活卡（实时 / 结束 / 出错 / 重新打开），liveTail 接入不重复。
// 临时机器人（guard），结束删；只放行这次测试自己需要的写。
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
  p.on("console", (m) => { if (m.type() === "error") errors.push(`${tag} console ${m.text().slice(0, 300)}`); });
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
const NARR = "检查结果显示两项都未安装";
const NARR2 = "第二步还没成功";
const DUP = "刚才安装调用中断了"; // 断网时只流到半句：用开头几个字数，半截 + 整段 = 出现两次
const TAG = process.env.TAG || "f"; const OUT = process.env.OUT || `/tmp/fold-${TAG}`; fs.mkdirSync(OUT, { recursive: true });
const fails = []; const check = (ok, msg) => { log(ok ? "PASS" : "FAIL", msg); if (!ok) fails.push(msg); };
const ctx = await context("light", { width: 1280, height: 860 });
// 模拟「本机的流断了、服务器还在跑」（截图那次）：把 copilotkit 的事件流包一层，window.__cutStream = true 时让它出错（只断一次）。
await ctx.addInitScript(() => {
  window.__cutStream = false;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const type = res.headers.get("content-type") || "";
    if (!/copilotkit/.test(url) || !res.body || !/event-stream/.test(type)) return res;
    const reader = res.body.getReader();
    const cut = () => new Promise((resolve) => { const t = setInterval(() => { if (window.__cutStream) { clearInterval(t); resolve({ cut: true }); } }, 50); });
    const body = new ReadableStream({
      async pull(controller) {
        const next = await Promise.race([reader.read(), cut()]);
        if (next.cut) { window.__cutStream = false; window.__cutCount = (window.__cutCount || 0) + 1; reader.cancel().catch(() => {}); controller.error(new TypeError("network error")); return; }
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
});
const page = await newPage(ctx, "f");
await page.route("**/*", (route) => {
  const r = route.request(); const m = r.method(); const u = r.url();
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
/** 看得见的过程话（淡色一行，不算 0 高收起的）、看得见的机器人文字、干活卡点开后的过程话。 */
const probe = () => page.evaluate(() => {
  const shown = (e) => { const r = e.getBoundingClientRect(); return e.offsetParent !== null && r.height > 1 && !e.closest("[data-folded]"); };
  const vis = (s) => [...document.querySelectorAll(s)].filter(shown);
  const main = document.querySelector('[data-slot="message-scroller-content"]');
  return {
    steps: vis(".chat-step-line").map((e) => e.innerText.replace(/\s+/g, " ")),
    // 收起的行（data-folded，0 高，§82.9）还在 DOM 里，不算看得见的字
    text: main ? [...main.querySelectorAll("[data-message-id]")].filter((e) => !e.closest("[data-folded]") && !e.hasAttribute("data-folded")).map((e) => e.innerText).join("\n") : "",
    live: vis("[data-testid=kept-page][data-visible=true] [data-testid=chat-work-card]").length,
    done: vis("[data-testid=kept-page][data-visible=true] [data-testid=chat-work-done]").length,
    notes: vis("[data-testid=kept-page][data-visible=true] .chat-work-note").map((e) => e.innerText),
    error: vis('[data-testid=kept-page][data-visible=true] [data-testid="transcript-stopped"]').map((e) => e.innerText).join(" "),
    composer: document.querySelector('[aria-label="消息"]')?.innerText ?? "",
  };
});
async function newChat(name) {
  const bot = trackBot(await mkBot(page, name, "你是测试助手。")); bots.push(bot);
  await page.goto(`${base}/channel/new?agent=${encodeURIComponent(bot)}`, { waitUntil: "domcontentloaded" });
  await box().waitFor({ timeout: 60000 }); await page.waitForTimeout(1500);
}
async function sendAndWatch(prompt, tag, { onTick } = {}) {
  await box().click(); await box().fill(prompt); await page.keyboard.press("Enter");
  const t0 = Date.now(); const seen = { stepWithNarrAfterTool: 0, maxDup: 0, samples: 0 };
  let idleSince = null;
  while (Date.now() - t0 < 120000) {
    const p = await probe(); seen.samples++;
    if (onTick) await onTick(Date.now() - t0, p);
    // 过程话一旦后面调了工具（mock 里 NARR 之后紧跟工具），就不该再作为淡色一行露着
    if (p.steps.some((s) => s.includes(NARR)) && (p.live || p.done) && Date.now() - t0 > 0) seen.lastStepNarr = Date.now() - t0;
    seen.maxDup = Math.max(seen.maxDup, p.text.split(DUP).length - 1);
    const b = await busy();
    if (!b && Date.now() - t0 > 4000) { idleSince ??= Date.now(); if (Date.now() - idleSince > 3000) break; } else idleSince = null;
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: `${OUT}/${tag}-done.png` });
  return seen;
}
async function openCard() {
  const done = page.locator("[data-testid=kept-page][data-visible=true] [data-testid=chat-work-done]").last();
  if (!(await done.isVisible().catch(() => false))) return [];
  await done.click(); await page.waitForTimeout(400);
  const notes = await page.locator("[data-testid=kept-page][data-visible=true] .chat-work-note").allInnerTexts();
  await page.screenshot({ path: `${OUT}/card-open-${Date.now() % 100000}.png` });
  await done.click(); await page.waitForTimeout(200);
  return notes;
}

try {
  const ONLY = process.env.ONLY || ""; let p; let notes;
  if (!ONLY || ONLY === "fold") {
  // 1) narration → tool → 结果
  await newChat("过程话测试一");
  const ok = await sendAndWatch("FOLDOK 装一下", "ok");
  p = await probe();
  check(p.steps.length === 0, `FOLDOK: no loose process line after the turn (${JSON.stringify(p.steps)})`);
  check(/装好了，两项都可以用了/.test(p.text), "FOLDOK: final answer visible");
  check(p.text.split(NARR).length - 1 === 0, "FOLDOK: narration not in the transcript");
  notes = await openCard();
  check(notes.some((n) => n.includes(NARR)), `FOLDOK: narration inside the opened card (${JSON.stringify(notes)})`);
  log("ok samples", ok.samples);

  // 2) narration → tool → narration → 连接断开（出错）
  await newChat("过程话测试二");
  await sendAndWatch("FOLDERR 装一下", "err");
  p = await probe();
  check(p.steps.length === 0, `FOLDERR: no loose process line under the card (${JSON.stringify(p.steps)})`);
  check(p.text.split(NARR).length - 1 === 0 && p.text.split(NARR2).length - 1 === 0, "FOLDERR: neither narration loose in the transcript");
  check(p.done === 1, `FOLDERR: one done work card (${p.done})`);
  log("FOLDERR error banner:", p.error);
  notes = await openCard();
  check(notes.some((n) => n.includes(NARR)), `FOLDERR: first narration inside the card (${JSON.stringify(notes)})`);
  // 重新打开（回放）
  await page.reload({ waitUntil: "domcontentloaded" }); await box().waitFor({ timeout: 60000 }); await page.waitForTimeout(4000);
  p = await probe();
  check(p.steps.length === 0, `FOLDERR reload: no loose process line (${JSON.stringify(p.steps)})`);
  check(p.text.split(NARR).length - 1 === 0, "FOLDERR reload: narration not loose");
  await page.screenshot({ path: `${OUT}/err-reload.png` });

  }
  if (!ONLY || ONLY === "dup") {
  // 3) DUP：流到一半本机的流断开（服务器接着跑） → liveTail 接入回放，同一段话只出现一次
  await newChat("过程话测试三");
  let offAt = null;
  const dup = await sendAndWatch("DUP 确认一下", "dup", {
    onTick: async (ms, pr) => {
      if (offAt === null && ms > 3500 && pr.text.includes("刚才安装")) { offAt = ms; log("before cut:", JSON.stringify(pr.text.slice(-60))); await page.evaluate(() => { window.__cutStream = true; }); log("stream cut at", ms); }
      if (offAt !== null && ms % 1000 < 160) log("tick", ms, "busy?", "err:", pr.error.slice(0, 30), "dup:", pr.text.split(DUP).length - 1);
      if (offAt !== null && offAt > 0 && ms - offAt > 1500) { log("cuts", await page.evaluate(() => window.__cutCount || 0)); offAt = -1; }
    },
  });
  // 服务器那一轮写完后再读一次（最多 20 秒）
  for (let i = 0; i < 20; i++) { p = await probe(); if (/确认过了，已经装好/.test(p.text)) break; await page.waitForTimeout(1000); }
  log("DUP final transcript:", JSON.stringify(p.text.slice(-200)));
  const n = p.text.split(DUP).length - 1;
  check(n === 1, `DUP: lead sentence appears exactly once after reconnect (now ${n}, max seen ${dup.maxDup})`);
  check(dup.maxDup <= 1, `DUP: never doubled while replaying (max ${dup.maxDup})`);
  check(/确认过了，已经装好/.test(p.text), "DUP: server's answer arrived after reconnect");
  log("DUP composer after:", JSON.stringify(p.composer), "error:", p.error);
  await page.screenshot({ path: `${OUT}/dup-end.png` });
  log("thread", page.url());
  }
} catch (e) {
  fails.push(`exception ${String(e).slice(0, 300)}`); log("EXC", e);
} finally {
  if (!process.env.KEEP) for (const b of bots) log("delete", b, (await guardedDeleteBot(call, b)).status);
  log("errors", JSON.stringify(errors.slice(0, 20)));
  log(fails.length ? `RESULT FAIL ${fails.length}: ${fails.join(" | ")}` : "RESULT ALL PASS");
  await browser.close();
  process.exitCode = fails.length ? 1 : 0;
}
