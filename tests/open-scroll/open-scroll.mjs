// 打开对话落在最新一条 / 切机器人秒开 的回归（DESIGN.md §83）。真浏览器（Playwright），对着一个预览实例跑。
//
//   BASE=http://127.0.0.1:3201 [TOK=…] [THROTTLE=150:4000:4] node tests/open-scroll/open-scroll.mjs
//
// 需要：左栏至少两个机器人，其中一个最近的对话很长（几十轮，带工具 / 图片更好）。预览里用生产库的拷贝即可。
// 只读：除了接入（POST …/connect，它不写任何东西）以外的非 GET 请求都在浏览器里拦下，不会到服务器。
// THROTTLE = 延迟ms:带宽kbps:CPU 倍数（模拟手机 / 远距离网络；历史一段段到时最容易停在半截）。
//
// 断言（任何一项不过退出码 1）：
//   1. 冷打开最长的对话：第一帧就在底部（离底部 ≤ 4px），之后 6 秒内没有 > 150px 的跳动，最后仍在底部；
//   2. 切到别的机器人再切回来：第一帧在底部、不跳；切回刚看过的对话时第一条消息出现 ≤ SWITCH_BUDGET_MS（默认 400，节流时 ×3）；
//   3. 接入回放（connect）的大小 ≤ CONNECT_BUDGET_KB（默认 1024）——每轮重复的 context / tools / 消息不再重传；
//   4. 切回刚看过的对话不重新整段读取存储以外的东西：/messages 读取 ≤ 2 次。
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.BASE || "http://127.0.0.1:3201";
const TOK = process.env.TOK;
const THROTTLE = process.env.THROTTLE;
const slow = Boolean(THROTTLE);
const SWITCH_BUDGET_MS = Number(process.env.SWITCH_BUDGET_MS || (slow ? 1200 : 400));
const CONNECT_BUDGET_KB = Number(process.env.CONNECT_BUDGET_KB || 1024);
const WIDTHS = (process.env.WIDTHS || "1280,390").split(",").map(Number);
const failures = [];
const check = (ok, what) => { console.log(ok ? "PASS" : "FAIL", what); if (!ok) failures.push(what); };

const exe = process.env.CHROME || (() => {
  try { const d = fs.readdirSync("/ms-playwright").find((x) => x.startsWith("chromium-") && !x.includes("headless")); return d ? `/ms-playwright/${d}/chrome-linux64/chrome` : undefined; } catch { return undefined; }
})();
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

async function context(width) {
  const mobile = width < 1000;
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 800 }, isMobile: mobile, hasTouch: mobile, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true });
  if (TOK) await ctx.addCookies([{ name: "__Host-openbot_session", value: TOK, url: base }]);
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (["GET", "HEAD", "OPTIONS"].includes(req.method()) || /\/agent\/[^/]+\/connect$/.test(new URL(req.url()).pathname)) return route.continue();
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"read-only test"}' });
  });
  return ctx;
}

async function throttle(ctx, page) {
  if (!THROTTLE) return;
  const [latency, kbps, cpu] = THROTTLE.split(":").map(Number);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: (kbps * 1024) / 8, uploadThroughput: (kbps * 1024) / 8 });
  if (cpu) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
}

// 每一帧画完之后记一次聊天区的 scrollTop / 离底部多远（人看到的那一帧），直到 ms 结束。
// 在帧与帧之间随手读（setTimeout）会读到「图片刚撑高、还没轮到这一帧的 ResizeObserver 回到底部」的中间状态——
// 那个状态从来没画到屏幕上，不算跳。所以：requestAnimationFrame 之后再排一个任务，读的是刚画出去的那一帧。
function watch(page, t0, ms) {
  return page.evaluate(async ([t0, ms]) => {
    const viewport = () => document.querySelector('[data-slot="message-scroller-viewport"]');
    const rows = () => document.querySelectorAll('[data-testid=kept-page][data-visible=true] [data-testid="chat-transcript"] [data-message-id]').length;
    const afterPaint = () => new Promise((r) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); }));
    const samples = [];
    const start = performance.now();
    while (performance.now() - start < ms) {
      await afterPaint();
      const v = viewport();
      const n = rows();
      if (v && n > 0) samples.push([Date.now() - t0, Math.round(v.scrollTop), Math.round(v.scrollHeight - v.scrollTop - v.clientHeight)]);
    }
    return samples;
  }, [t0, ms]);
}

// 「跳」= 底部那条消息在屏幕上移动了：离底部的距离从 ≤4 变成 >150（人在底部时被拽走），或者人不在底部时 scrollTop 动了 >150
function summarize(samples) {
  const first = samples[0];
  const last = samples.at(-1);
  const jumps = [];
  for (let i = 1; i < samples.length; i++) {
    const [t, , gap] = samples[i];
    const prevGap = samples[i - 1][2];
    if (prevGap <= 4 && gap > 150) jumps.push([t, gap]);
    else if (prevGap > 4 && Math.abs(samples[i][1] - samples[i - 1][1]) > 150) jumps.push([t, samples[i][1] - samples[i - 1][1]]);
  }
  return { firstAt: first?.[0] ?? null, firstGap: first?.[2] ?? null, finalGap: last?.[2] ?? null, jumps };
}

const setup = await context(1280);
const p0 = await setup.newPage();
await p0.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await p0.waitForTimeout(2500);
const get = (path) => p0.evaluate(async (p) => (await fetch(p)).json(), path);
const channels = ((await get("/api/channels")).channels ?? []).filter((c) => c.agentIds?.length === 1);
for (const c of channels) {
  const r = await get(`/api/copilotkit/threads/${encodeURIComponent(c.threadId)}/messages?agentId=${encodeURIComponent(c.agentIds[0])}`);
  c.count = r.messages?.length ?? 0;
}
await setup.close();
const latest = new Map();
for (const c of channels) { const a = c.agentIds[0]; if (!latest.has(a) || (c.lastMessageAt ?? "") > (latest.get(a).lastMessageAt ?? "")) latest.set(a, c); }
const bots = [...latest.values()].sort((a, b) => b.count - a.count);
if (bots.length < 2 || bots[0].count < 20) { console.log("SKIP need ≥2 bots and one conversation with ≥20 messages", bots.map((b) => b.count)); process.exit(2); }
const [long, other] = bots;
console.log("long", long.id, long.count, "other", other.id, other.count);

for (const width of WIDTHS) {
  const ctx = await context(width);
  const page = await ctx.newPage();
  await throttle(ctx, page);
  const connects = [];
  const reads = [];
  page.on("requestfinished", async (req) => {
    const path = new URL(req.url()).pathname;
    if (/\/connect$/.test(path)) { try { const s = await req.sizes(); connects.push(s.responseBodySize); } catch {} }
    if (/\/threads\/[^/]+\/messages$/.test(path)) reads.push(path);
  });

  // 1. 冷打开
  let t0 = Date.now();
  await page.goto(`${base}/channel/${long.id}`, { waitUntil: "commit" });
  const cold = summarize(await watch(page, t0, slow ? 16000 : 8000));
  console.log(width, "cold", JSON.stringify(cold));
  check(cold.firstGap !== null && cold.firstGap <= 4, `${width} 冷打开第一帧在底部（离底部 ${cold.firstGap}px）`);
  check(cold.jumps.length === 0, `${width} 冷打开不跳（${JSON.stringify(cold.jumps)}）`);
  check(cold.finalGap !== null && cold.finalGap <= 4, `${width} 冷打开最后在底部（离底部 ${cold.finalGap}px）`);
  const biggest = Math.max(0, ...connects);
  check(biggest / 1024 <= CONNECT_BUDGET_KB, `${width} 接入回放 ${Math.round(biggest / 1024)}KB ≤ ${CONNECT_BUDGET_KB}KB`);

  if (width >= 1000) {
    // 2. 切走再切回来（左栏）
    const link = (c) => page.locator(`a.glass-bot-link[href="/channel/${c.id}"], a.glass-mini-bot[href="/channel/${c.id}"]`).first();
    await page.waitForTimeout(3000); // 空闲预取
    for (const [target, label] of [[other, "切到另一个机器人"], [long, "切回长对话"]]) {
      reads.length = 0;
      t0 = Date.now();
      await link(target).click();
      const sw = summarize(await watch(page, t0, slow ? 8000 : 4000));
      console.log(width, label, JSON.stringify(sw), "reads", reads.length);
      check(sw.firstGap !== null && sw.firstGap <= 4, `${width} ${label}：第一帧在底部（离底部 ${sw.firstGap}px）`);
      check(sw.jumps.length === 0, `${width} ${label}：不跳（${JSON.stringify(sw.jumps)}）`);
      check(sw.finalGap !== null && sw.finalGap <= 4, `${width} ${label}：最后在底部`);
      check(sw.firstAt !== null && sw.firstAt <= SWITCH_BUDGET_MS, `${width} ${label}：${sw.firstAt}ms 出现 ≤ ${SWITCH_BUDGET_MS}ms`);
      check(reads.length <= 2, `${width} ${label}：读存储 ${reads.length} 次 ≤ 2`);
    }
  }
  await ctx.close();
}

await browser.close();
console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");
process.exit(failures.length ? 1 : 0);
