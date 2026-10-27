// Browser E2E for DESIGN.md §38 (side preview + mock-model.mjs as the default model).
// SCENARIO=steer : send WORK, type while it streams (button becomes 发送), the message shows as 已排队,
//                  then appears in the transcript where it was read (已读取) and is answered.
// SCENARIO=worker: send DELEGATE, a live task card shows status / step / plan / time, 补充说明 reaches the
//                  worker, the card collapses to one line when done, the result row + summary appear
//                  without a reload. THEME=dark, MOBILE=1 (390×844) for variants. Screenshots → /out.
import { chromium } from "playwright-core";
import fs from "node:fs";

const exe = fs.readdirSync("/ms-playwright").find((d) => d.startsWith("chromium-") && !d.includes("headless"));
const browser = await chromium.launch({ executablePath: `/ms-playwright/${exe}/chrome-linux64/chrome`, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const BASE = process.env.BASE || "http://127.0.0.1:3098";
const BOT = process.env.BOT;
const SCENARIO = process.env.SCENARIO || "steer";
const MOBILE = process.env.MOBILE === "1";
const DARK = process.env.THEME === "dark";
const TAG = process.env.TAG || SCENARIO;
const OLD = process.env.OLD === "1"; // the build before this change: only shoot what the user saw
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const vp = MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 820 };
const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, locale: "zh-CN", timezoneId: "Asia/Shanghai", ...(MOBILE ? { isMobile: true, hasTouch: true } : {}) });
await ctx.addInitScript((dark) => {
  try { localStorage.setItem("chisabot-theme", dark ? "dark" : "light"); } catch {}
}, DARK);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let failures = 0;
const check = (ok, what) => { log(ok ? "PASS" : "FAIL", what); if (!ok) failures++; };
const shot = async (name) => { await page.screenshot({ path: `/out/${TAG}-${name}.png` }); log("shot", name); };
const ta = () => page.locator('[aria-label="消息"]').first();

await page.goto(`${BASE}/bot?agent=${BOT}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[aria-label="消息"]', { timeout: 40000 });
await page.waitForTimeout(1500);
const send = async (text) => { await ta().fill(text); await page.keyboard.press("Enter"); };

try {
if (SCENARIO === "steer") {
  await send("WORK 帮我做三步");
  await page.waitForSelector('[data-testid="composer-stop"]', { timeout: 15000 });
  await page.waitForTimeout(1800);
  await ta().fill("只看 2026 年的");
  await page.waitForTimeout(250);
  if (OLD) {
    check(await page.locator('[data-testid="composer-stop"]').isVisible(), "old: while it answers the button is only 停止");
    await shot("typing");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    await shot("after-enter");
    await page.waitForTimeout(9000);
    await shot("end");
  } else {
    check(await page.locator('[data-testid="composer-queue"]').isVisible(), "typing while it answers turns 停止 into 发送");
    await shot("typing");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="queued-messages"] .queued-msg', { timeout: 5000 });
    check(true, "queued bubble shows right away");
    check((await ta().inputValue()) === "", "composer cleared");
    check(await page.locator('[data-testid="composer-stop"]').isVisible(), "empty composer: button is 停止 again");
    await shot("queued");
    await page.waitForSelector('[data-testid="queued-read"]', { timeout: 15000 });
    check((await page.locator('[data-testid="queued-messages"] .queued-msg').count()) === 0, "queued bubble gone once read");
    await shot("read");
    await page.waitForSelector('[data-testid="composer-send"]', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const transcript = await page.locator("[data-testid=chat-transcript]").innerText();
    check(transcript.includes("已按补充调整：只看 2026 年的"), "the reply answered the queued message");
    check((transcript.match(/只看 2026 年的/g) || []).length === 2, "the queued message appears once in the transcript (plus once quoted in the reply)");
    await shot("end");
    // reload: order survives
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="消息"]', { timeout: 40000 });
    await page.waitForTimeout(2500);
    const after = await page.locator("[data-testid=chat-transcript]").innerText();
    check(after.indexOf("只看 2026 年的") < after.indexOf("已按补充调整"), "after reload the queued message sits before the answer");
    await shot("reloaded");
  }
}

if (SCENARIO === "worker") {
  await send("DELEGATE 帮我在后台做个测试任务");
  const card = page.locator('[data-testid="worker-card"]').first();
  await card.waitFor({ timeout: 20000 });
  await page.waitForSelector('[data-testid="worker-card"][data-status="running"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="worker-plan"] .is-current', { timeout: 15000 });
  check(true, "running card with a plan");
  await page.waitForTimeout(400);
  await card.scrollIntoViewIfNeeded();
  await shot("running");
  // chat stays free while it runs
  check(await page.locator('[data-testid="composer-send"]').isVisible(), "main conversation is free while the worker runs");
  await page.locator('[data-testid="worker-steer"]').click();
  await page.locator(".worker-steer-input").fill("结果里写上日期");
  await shot("steer-input");
  await page.locator(".worker-steer button[type=submit]").click();
  await page.waitForTimeout(500);
  await shot("steered");
  await page.waitForSelector('[data-testid="worker-card"][data-status="done"]', { timeout: 40000 });
  await page.waitForTimeout(400);
  check((await card.innerText()).includes("后台结果"), "collapsed one-line result");
  await page.waitForSelector('[data-testid="worker-result"]', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=chat-transcript]")?.textContent?.includes("后台任务做完了"), null, { timeout: 20000 });
  const text = await page.locator("[data-testid=chat-transcript]").innerText();
  check(text.includes("后台任务做完了"), "main bot summarised the result without a reload");
  check(text.includes("日期"), "steer message reached the worker");
  await page.waitForTimeout(800);
  await shot("done");
  await page.locator('[data-testid="worker-result"] .worker-result-line').click();
  await page.waitForTimeout(400);
  await shot("result-open");
}

} catch (error) {
  log("ERROR", String(error).slice(0, 300));
  failures++;
  await shot("error").catch(() => {});
  log("cards", await page.locator('[data-testid="worker-card"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-status") + ":" + e.textContent)).catch(() => ""));
}
check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(" | ")}`);
log(failures ? `RESULT FAIL (${failures})` : "RESULT PASS");
await browser.close();
process.exit(failures ? 1 : 0);
