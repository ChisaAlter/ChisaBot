// xbot.mjs — §101.1：A 的一轮还在跑时切到 B 的对话并让 B 也开浏览器干活，两边的计算机操作必须各自打到自己的浏览器。
// 判定：A 对话里的工具结果只出现 A 的网站，B 对话里只出现 B 的网站；各自都有最终回答。
import fs from "node:fs";
import { api, base, browser, context, errors, log, newPage, chisaBot, send, threadMessages, threadOf, waitIdle } from "./lib.mjs";
import { guardInit, guardedDeleteBot, trackBot } from "./guard.mjs";
const ctx = await context({});
const page = await newPage(ctx, "x");
await page.goto(base + "/", { waitUntil: "domcontentloaded" });
const call = (p, o) => api(page, p, o);
await guardInit(call);
const mk = async (name) => { const r = await call("/api/agents", { method: "POST", body: JSON.stringify({ name, title: "临时测试（会删除）", roleDescription: "我的私人助手：回答问题、查资料、帮我把事情办好。", visibility: "private" }) }); return trackBot(JSON.parse(r.body).agent.id); };
const A = await mk("临时甲"), B = await mk("临时乙");
fs.writeFileSync("/out/bots.txt", `${A}\n${B}\n`);
log("A", A, "B", B);
const SITES_A = ["example.com", "wikipedia.org", "github.com/explore", "developer.mozilla.org", "www.w3.org"];
const SITES_B = ["python.org", "nodejs.org"];
// 侧栏的机器人链接（窄 / 宽都有 title=名字）——SPA 内切换，不刷新页面，A 的一轮继续在后台跑
const sideLink = (name) => page.locator(`a[title="${name}"], a[title="${name}（主机器人）"]`).first();
const result = { A: {}, B: {} };
try {
  await chisaBot(page, B);
  await chisaBot(page, A);
  const t0 = new Date().toISOString();
  await send(page, "用你的浏览器依次打开 https://example.com 、https://www.wikipedia.org 、https://github.com/explore 、https://developer.mozilla.org 、https://www.w3.org ，每个都真的打开，读一下标题和页面上第一段正文，最后把五个标题列给我。");
  await page.waitForURL((u) => /\/channel\/(?!new)/.test(u.pathname), { timeout: 30000 }).catch(() => {});
  const tidA = await threadOf(page);
  await page.waitForTimeout(4000);
  log("switching to B mid-turn", t0, "A thread", tidA);
  await sideLink("临时乙").click({ timeout: 30000 });
  await page.waitForTimeout(3000);
  await send(page, "用你的浏览器依次打开 https://www.python.org 和 https://nodejs.org ，每个都真的打开并读一下标题，最后把两个标题列给我。");
  await page.waitForURL((u) => /\/channel\/(?!new)/.test(u.pathname), { timeout: 30000 }).catch(() => {});
  const tidB = await threadOf(page);
  log("B thread", tidB);
  await waitIdle(page, { max: 300000 });
  await page.screenshot({ path: "/out/x-B.png" });
  await sideLink("临时甲").click({ timeout: 30000 });
  await page.waitForTimeout(4000);
  await waitIdle(page, { max: 300000 });
  await page.screenshot({ path: "/out/x-A.png" });
  for (const [k, tid, mine, other] of [["A", tidA, SITES_A, SITES_B], ["B", tidB, SITES_B, SITES_A]]) {
    const msgs = await threadMessages(page, tid);
    const navs = []; const toolText = []; let final = "";
    for (const m of Array.isArray(msgs) ? msgs : []) {
      if (m.role === "assistant") { for (const tc of m.toolCalls || []) if (/computer_/.test(tc.function?.name || "")) navs.push(`${tc.function.name} ${String(tc.function.arguments).slice(0, 100)}`); if (typeof m.content === "string" && m.content.trim()) final = m.content; }
      if (m.role === "tool") toolText.push(String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 600));
    }
    const blob = toolText.join("\n");
    // 工具结果里出现别的机器人的网站 = 打串了（结果里写的是浏览器当前页的网址 / 标题）
    const crossed = other.filter((s) => blob.includes(s));
    result[k] = { tid, navs, crossed, final: final.slice(0, 600), finalOk: !!final.trim() };
    log("RESULT", k, JSON.stringify(result[k]).slice(0, 1500));
  }
  log("WINDOW", t0, new Date().toISOString());
} catch (e) { log("SCRIPT-ERROR", String(e?.stack || e).slice(0, 600)); await page.screenshot({ path: "/out/error.png" }).catch(() => {}); }
finally {
  fs.writeFileSync("/out/results.json", JSON.stringify(result, null, 2));
  for (const id of [A, B]) log("deleted", id, JSON.stringify(await guardedDeleteBot(call, id)).slice(0, 80));
  log("ERRORS", JSON.stringify(errors.slice(0, 15)));
  await browser.close();
}
