// 每个机器人记住「我的操作状态」+ 聊天不往回跳（DESIGN.md §88）。真浏览器（Playwright），对着一个预览实例跑。
//
//   BASE=http://127.0.0.1:<预览端口> [TOK=…] [WIDTHS=1280,390] [SEND=1] [READONLY=1] node tests/bot-state/bot-state.mjs
//
// 需要：左栏至少两个机器人，其中一个有一段较长的对话（≥ 20 条）。预览里用生产库的拷贝即可。
// SEND=1 时会在那段对话里发消息（WORKL：干活卡跑完收成「做了 n 步」；SCHED：日程卡），要把预览的默认模型
// 指到 tests/bot-state/mock-model.mjs（只在预览里做！）。READONLY=1：除了接入（POST …/connect）以外的非 GET
// 请求都在浏览器里拦下（生产只读检查用；草稿 / 标签 / 滚动位置只在这台浏览器的 localStorage 里，不写服务器）。
//
// 每一帧画完后取样：第一条看得见的消息和它离顶边多远、离底部多远。「往回跳」= 没有人动滚动时，同一条消息在屏幕上
// 往下挪了 > 20px（或者换了一条、scrollTop 变小 > 20px）。
//
// 断言（任何一项不过退出码 1）：
//   A. 发消息（SEND=1）：干活卡跑 → 收起、日程卡出现，全程 0 次往回跳，最后在底部；
//   B. 1280：右栏切到「计算机」、写一半草稿、往上翻 → 去设置 → 从左栏点回来：还是「计算机」、草稿在、
//      第一条看得见的消息和离顶边的距离和离开时一样（±4px）、回来的过程中 0 次往回跳；
//   C. 切到另一个机器人：它是自己的样子（默认「面板」、没有这段草稿）；再切回来：同 B；
//   D. 刷新：同 B；
//   E. 390：草稿、滚动位置同 B（右栏在抽屉里，不量）。
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.BASE || "http://127.0.0.1:3243";
const TOK = process.env.TOK;
const WIDTHS = (process.env.WIDTHS || "1280,390").split(",").map(Number);
const SEND = process.env.SEND === "1";
const READONLY = process.env.READONLY === "1";
const OUT = process.env.OUT || "/out";
const DRAFT = "草稿测试：写了一半的话（会删除）";
const failures = [];
const check = (ok, what) => { console.log(ok ? "PASS" : "FAIL", what); if (!ok) failures.push(what); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const exe = process.env.CHROME || (() => {
  try { const d = fs.readdirSync("/ms-playwright").find((x) => x.startsWith("chromium-") && !x.includes("headless")); return d ? `/ms-playwright/${d}/chrome-linux64/chrome` : undefined; } catch { return undefined; }
})();
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage", "--host-resolver-rules=MAP example.com 127.0.0.1"] });

// 在应用代码之前装上：每一帧画完后记一次（人看到的那一帧）。
const SAMPLER = () => {
  window.__frames = []; window.__phase = "load";
  const T0 = performance.now();
  const sample = () => {
    const v = document.querySelector('[data-slot="message-scroller-viewport"]');
    if (v && v.clientHeight > 0) {
      const vr = v.getBoundingClientRect();
      let top = null;
      for (const r of v.querySelectorAll("[data-testid=kept-page][data-visible=true] [data-message-id]")) { const b = r.getBoundingClientRect(); if (b.bottom > vr.top + 1) { top = [r.getAttribute("data-message-id"), Math.round(b.top - vr.top)]; break; } }
      window.__frames.push([Math.round(performance.now() - T0), window.__phase, Math.round(v.scrollTop), Math.round(v.scrollHeight - v.scrollTop - v.clientHeight), top, location.pathname]);
    }
    requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = sample; c.port2.postMessage(0); });
  };
  requestAnimationFrame(sample);
};

function backwardJumps(frames) {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (a[5] !== b[5] || !a[4] || !b[4]) continue;
    if (a[4][0] === b[4][0] ? b[4][1] - a[4][1] > 20 : b[2] < a[2] - 20) out.push({ t: b[0], from: a.slice(2, 5), to: b.slice(2, 5) });
  }
  return out;
}

async function context(width) {
  const mobile = width < 1000;
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 800 }, isMobile: mobile, hasTouch: mobile, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true });
  if (TOK) await ctx.addCookies([{ name: "__Host-openbot_session", value: TOK, url: base }]);
  if (READONLY) {
    await ctx.route("**/*", (route) => {
      const req = route.request();
      if (["GET", "HEAD", "OPTIONS"].includes(req.method()) || /\/agent\/[^/]+\/connect$/.test(new URL(req.url()).pathname)) return route.continue();
      return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"read-only test"}' });
    });
  }
  await ctx.addInitScript(SAMPLER);
  return ctx;
}

// 找机器人和它们最近的对话
const setup = await context(1280);
const p0 = await setup.newPage();
await p0.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await p0.waitForTimeout(2500);
const get = (path) => p0.evaluate(async (p) => (await fetch(p)).json(), path);
const channels = ((await get("/api/channels")).channels ?? []).filter((c) => c.agentIds?.length === 1);
for (const c of channels) { const r = await get(`/api/copilotkit/threads/${encodeURIComponent(c.threadId)}/messages?agentId=${encodeURIComponent(c.agentIds[0])}`); c.count = r.messages?.length ?? 0; }
const agentsRaw = await get("/api/agents");
const agents = Array.isArray(agentsRaw) ? agentsRaw : agentsRaw.agents ?? [];
await setup.close();
const long = channels.sort((a, b) => b.count - a.count)[0];
const longBot = agents.find((a) => a.id === long?.agentIds[0]);
const otherBot = agents.find((a) => a.id !== longBot?.id);
if (!long || long.count < 20 || !otherBot) { console.log("SKIP need a conversation with ≥20 messages and a second bot"); process.exit(2); }
log("long", long.id, longBot?.name, long.count, "other", otherBot.name);

for (const width of WIDTHS) {
  const wide = width >= 1280;
  const ctx = await context(width);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));
  const phase = (p) => page.evaluate((x) => { window.__phase = x; }, p).catch(() => {});
  const frames = (p) => page.evaluate((x) => window.__frames.filter((f) => f[1] === x), p);
  const viewportBox = () => page.evaluate(() => { const r = document.querySelector('[data-slot="message-scroller-viewport"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const position = () => page.evaluate(() => {
    const v = document.querySelector('[data-slot="message-scroller-viewport"]');
    const vr = v.getBoundingClientRect();
    for (const r of v.querySelectorAll("[data-testid=kept-page][data-visible=true] [data-message-id]")) { const b = r.getBoundingClientRect(); if (b.bottom > vr.top + 1) return { id: r.getAttribute("data-message-id"), offset: Math.round(b.top - vr.top), gap: Math.round(v.scrollHeight - v.scrollTop - v.clientHeight) }; }
    return null;
  });
  const railTab = () => page.locator(".rail-tabs").first().getAttribute("data-tab").catch(() => null);
  const editor = () => page.locator('[aria-label="消息"]').first();
  const draftText = async () => ((await editor().textContent().catch(() => "")) ?? "").trim();
  const botLink = (bot) => page.locator(`a.glass-bot-link:has-text("${bot.name}")`).first();
  const openSidebar = async () => { if (!wide && !(await botLink(longBot).isVisible().catch(() => false))) { const t = page.locator('[data-sidebar="trigger"], button[aria-label*="左栏"], button[aria-label*="机器人列表"]').first(); if (await t.isVisible().catch(() => false)) { await t.click(); await page.waitForTimeout(400); } } };
  const idle = async (max = 90000) => { const t0 = Date.now(); let n = 0; await page.waitForTimeout(1500); while (Date.now() - t0 < max && n < 4) { n = (await page.locator('[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]').count()) ? 0 : n + 1; await page.waitForTimeout(500); } };

  await page.goto(`${base}/channel/${long.id}`, { waitUntil: "domcontentloaded" });
  await editor().waitFor({ timeout: 60000 });
  await page.waitForTimeout(6000);

  // A. 发消息：干活卡收起、日程卡，不往回跳
  if (SEND && !READONLY) {
    for (const prompt of ["WORKL 测试干活卡收起（会删除）", "SCHED 测试提醒卡（会删除）"]) {
      const tag = `send-${prompt.split(" ")[0]}`;
      await phase(tag);
      await editor().click(); await editor().fill(prompt); await page.keyboard.press("Enter");
      await idle(); await page.waitForTimeout(5000);
      const f = await frames(tag);
      const jumps = backwardJumps(f);
      check(jumps.length === 0, `${width} ${tag}: 0 次往回跳 ${jumps.length ? JSON.stringify(jumps.slice(0, 3)) : ""}`);
      check((f.at(-1)?.[3] ?? 99) <= 4, `${width} ${tag}: 最后在底部（离底部 ${f.at(-1)?.[3]}px）`);
    }
  }

  // 记下要保持的状态：右栏「计算机」（宽窗口）、草稿、往上翻 700px
  if (wide) {
    const computer = page.locator('.rail-tabs [role="radio"]:has-text("计算机")').first();
    if (await computer.isVisible().catch(() => false)) { await computer.click(); await page.waitForTimeout(800); }
    check((await railTab()) === "computer", `${width} 右栏切到「计算机」`);
  }
  await editor().click(); await editor().fill(DRAFT); await page.waitForTimeout(400);
  const box = await viewportBox();
  await page.mouse.move(box.x, box.y);
  if (wide) { for (let i = 0; i < 7; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(40); } }
  else await page.evaluate(() => { const v = document.querySelector('[data-slot="message-scroller-viewport"]'); v.dispatchEvent(new WheelEvent("wheel", { deltaY: -700, bubbles: true })); v.scrollTop -= 700; });
  await page.waitForTimeout(1200);
  const before = await position();
  log(width, "before leave", JSON.stringify(before), "memo", await page.evaluate((c) => JSON.stringify(JSON.parse(localStorage.getItem("chisabot-ui-memory:v1") || "{}").threads?.[c]?.scroll), long.id));
  check(before && before.gap > 100, `${width} 往上翻了（离底部 ${before?.gap}px）`);

  const expectRestored = async (label) => {
    await editor().waitFor({ timeout: 30000 });
    await page.waitForTimeout(4500);
    const after = await position();
    log(width, label, JSON.stringify(after));
    if (wide) check((await railTab()) === "computer", `${width} ${label}：右栏还是「计算机」`);
    check((await draftText()).includes(DRAFT), `${width} ${label}：草稿还在`);
    check(after && after.id === before.id && Math.abs(after.offset - before.offset) <= 4, `${width} ${label}：回到离开时那一条（${before.id.slice(0, 10)} ${before.offset}px → ${after?.id?.slice(0, 10)} ${after?.offset}px）`);
    const f = await frames(label);
    const settledAt = f.findIndex((x) => x[4] && x[4][0] === before.id && Math.abs(x[4][1] - before.offset) <= 4);
    const jumps = settledAt < 0 ? [] : backwardJumps(f.slice(settledAt));
    check(jumps.length === 0, `${width} ${label}：回到那一条以后 0 次往回跳 ${jumps.length ? JSON.stringify(jumps.slice(0, 3)) : ""}`);
  };

  // B. 去设置再从左栏点回来（地址里没有 watch）
  await phase("settings");
  await page.evaluate(() => { const a = document.querySelector('a[href^="/settings"]'); if (a) a.click(); else history.pushState({}, "", "/settings"); });
  await page.waitForTimeout(2500);
  await openSidebar();
  if (await botLink(longBot).isVisible().catch(() => false)) await botLink(longBot).click(); else await page.goBack();
  await expectRestored("settings");

  // C. 切到另一个机器人再切回来
  await openSidebar();
  if (await botLink(otherBot).isVisible().catch(() => false)) {
    await phase("other");
    await botLink(otherBot).click();
    await page.waitForTimeout(3000);
    // 这个浏览器里从没给它选过「计算机」：应该是「面板」。
    if (wide) check((await railTab()) === "panels", `${width} 另一个机器人：没记过就是「面板」（实际 ${await railTab()}）`);
    check(!(await draftText()).includes(DRAFT), `${width} 另一个机器人：没有这段草稿`);
    await phase("back");
    await openSidebar();
    await botLink(longBot).click();
    await expectRestored("back");
  }

  // D. 刷新
  await page.reload({ waitUntil: "domcontentloaded" });
  await phase("reload");
  await expectRestored("reload");

  // 收尾：清掉草稿、右栏切回「面板」（只在这台浏览器里，不写服务器）
  await editor().click(); await editor().fill(""); await page.waitForTimeout(300);
  if (wide) { const panels = page.locator('.rail-tabs [role="radio"]:has-text("面板")').first(); if (await panels.isVisible().catch(() => false)) await panels.click(); }
  await page.screenshot({ path: `${OUT}/bot-state-${width}.png` }).catch(() => {});
  await ctx.close();
}

await browser.close();
console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");
process.exit(failures.length ? 1 : 0);
