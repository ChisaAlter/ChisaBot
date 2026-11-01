// sched.mjs — §101.3 定时任务完整流程：建一个几分钟后执行的任务 → 用户离开聊天 → 到点后台执行，遇到「发送」先放确认卡片
// → 用户回来在聊天里点「确认」→ 机器人自动接着做完（页面显示「已发送：定时测试」）并给出最终回答。
import fs from "node:fs";
import { api, base, browser, context, errors, log, newPage, chisaBot, send, summarize, threadMessages, threadOf, waitIdle } from "./lib.mjs";
import { guardInit, guardedDeleteBot, trackBot } from "./guard.mjs";
const SEND_URL = process.env.SEND_URL || "https://echo.websocket.org/.ws"; // 公开的 WebSocket 回声页：输入框 + 「Send Message」按钮（点它会出确认卡片，§101.3/§101.9）
const MARK = process.env.MARK || `定时测试${Date.now() % 10000}`;
const ctx = await context({});
const page = await newPage(ctx, "s");
await page.goto(base + "/", { waitUntil: "domcontentloaded" });
const call = (p, o) => api(page, p, o);
await guardInit(call);
const r = await call("/api/agents", { method: "POST", body: JSON.stringify({ name: `临时定时${process.env.NAME || ""}`, title: "临时测试（会删除）", roleDescription: "我的私人助手：回答问题、查资料、帮我把事情办好。", visibility: "private" }) });
const bot = trackBot(JSON.parse(r.body).agent.id);
fs.appendFileSync("/out/bots.txt", bot + "\n");
if (process.env.MODEL) { const m = await call(`/api/agents/${bot}/model`, { method: "PUT", body: JSON.stringify({ model: process.env.MODEL }) }); log("bot model", process.env.MODEL, m.status); }
log("bot", bot);
const res = { steps: [] };
const step = (s) => { res.steps.push(`${new Date().toISOString().slice(11, 19)} ${s}`); log("STEP", s); };
try {
  await chisaBot(page, bot);
  await send(page, `3 分钟后执行一次（用定时任务，现在先不要做）：用你的浏览器打开 ${SEND_URL} ，在消息输入框里填「${MARK}」，然后点「Send Message」按钮，把页面上显示的收发记录告诉我。这是公开的测试回声页，可以直接发。${process.env.DIRECT === "1" ? "到时候直接点按钮，不要先调用 confirm_action（要不要问我，系统点按钮时会自己判断）。" : ""}`);
  await page.waitForURL((u) => /\/channel\/(?!new)/.test(u.pathname), { timeout: 30000 }).catch(() => {});
  const tid = await threadOf(page);
  const chatUrl = page.url();
  await waitIdle(page, { max: 180000, approve: false });
  await page.screenshot({ path: "/out/s-created.png" });
  const sch = await call("/api/schedules");
  res.schedules = sch.body.slice(0, 800);
  step(`created; thread ${tid}; schedules ${sch.status}`);
  // 用户离开聊天（去设置页），任务到点在后台跑
  await page.goto(base + "/settings", { waitUntil: "domcontentloaded" });
  step("left chat → /settings");
  let card = false;
  const deadline = Date.now() + 9 * 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(20000);
    const pend = await call("/api/confirmations/requests");
    if (pend.body.includes(bot) && /pending/.test(pend.body)) { card = true; res.pending = pend.body.slice(0, 800); break; }
  }
  step(`background turn ${card ? "left a card" : "no card seen in 9 min"}`);
  // 用户回来
  await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const approve = page.locator('[data-testid=kept-page][data-visible=true] [data-testid="confirm-approve"]:visible').first();
  await approve.waitFor({ timeout: 60000 }).catch(() => {});
  await page.screenshot({ path: "/out/s-card.png" });
  const cardVisible = await approve.isVisible().catch(() => false);
  step(`card visible in chat: ${cardVisible}`);
  res.cardVisible = cardVisible;
  res.looseStack = await page.locator('[data-testid=kept-page][data-visible=true] [data-testid="loose-confirm-cards"]:visible').count();
  if (cardVisible) {
    await approve.click();
    step("clicked 确认");
    const t1 = Date.now();
    let done = false;
    while (Date.now() - t1 < 6 * 60000) {
      await page.waitForTimeout(10000);
      const msgs = await threadMessages(page, tid);
      const txt = JSON.stringify(msgs);
      const after = txt.slice(Math.max(0, txt.indexOf("⟦chisabot:confirm:")));
      if (txt.includes("⟦chisabot:confirm:") && /computer_click/.test(after) && after.includes(MARK)) { done = true; }
      if (done && !(await page.locator('[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]:visible').first().isVisible().catch(() => false))) break;
    }
    await waitIdle(page, { max: 180000, approve: false });
    step(`continued after confirm: page result seen=${done}`);
    res.done = done;
  }
  const msgs = await threadMessages(page, tid);
  res.tools = summarize(msgs);
  const last = [...(Array.isArray(msgs) ? msgs : [])].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim());
  res.final = last?.content?.slice(0, 800) ?? "";
  await page.screenshot({ path: "/out/s-final.png" });
  fs.writeFileSync("/out/s.txt", res.tools);
} catch (e) { log("SCRIPT-ERROR", String(e?.stack || e).slice(0, 600)); await page.screenshot({ path: "/out/error.png" }).catch(() => {}); }
finally {
  fs.writeFileSync("/out/results.json", JSON.stringify(res, null, 2));
  log("RESULT", JSON.stringify({ ...res, tools: undefined }).slice(0, 2500));
  log("deleted", bot, JSON.stringify(await guardedDeleteBot(call, bot)).slice(0, 80));
  log("ERRORS", JSON.stringify(errors.slice(0, 15)));
  await browser.close();
}
