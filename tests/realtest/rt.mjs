// rt.mjs — 真实可用性验收：一次性机器人，通过网页聊天输入框像用户一样发任务，等回复、截图、记录工具调用。
// TASKS=a,b,...  PC=1 模拟 PC 客户端（Electron UA + 1280x840）。不碰任何已有机器人 / 对话。
import fs from "node:fs";
import { api, base, browser, context, errors, log, newPage, chisaBot, send, summarize, threadMessages, threadOf, transcript, waitIdle } from "./lib.mjs";
import { guardInit, guardedDeleteBot, trackBot } from "./guard.mjs";

const T = {
  a: { max: 240000, msg: "帮我搜一条今天的科技新闻，告诉我标题和一句话摘要，并给出来源链接。" },
  b: { max: 300000, msg: "用你右边的浏览器打开 https://github.com/ChisaAlter/ChisaBot ，告诉我这个仓库的简介（About）写的是什么、默认分支最新一次提交的说明是什么。" },
  c1: { max: 360000, msg: "用浏览器打开 https://httpbin.org/forms/post 帮我填表并提交：Customer name 填 张三，Telephone 填 13800000000，E-mail 填 test@example.com，Pizza Size 选 Medium，Toppings 勾 Bacon 和 Extra Cheese，Preferred delivery time 填 19:30，Delivery instructions 填 放门口。提交后告诉我返回结果里 custname、size、delivery 分别是什么。这是测试表单，可以直接提交。" },
  c2: { max: 360000, msg: "用浏览器打开 https://www.selenium.dev/selenium/web/web-form.html ，填写：Text input 填 你好ChisaBot，Textarea 填 第二行测试，Dropdown (select) 选 Two，Date picker 填 07/12/2000，勾上 Default checkbox，然后点 Submit。告诉我提交后页面显示了什么。这是测试表单，可以直接提交。" },
  c3: { max: 300000, msg: "打开 https://hark.com/login ，如果页面上有出生日期（月/日/年下拉框）就选成 2000 年 7 月 12 日，不要提交、不要登录，选完读一下页面告诉我三个框现在显示的值。" },
  d: { max: 240000, msg: "在工作区创建一个文件 notes/todo.md，写三条待办：买牛奶、交房租、给妈妈打电话。然后把第二条改成「交水电费」，最后把文件的完整内容原样发给我。" },
  e: { max: 240000, msg: "写一段 Python 代码，计算 1 到 1000000 之间所有质数的个数和它们的和，真的运行它，把代码和运行结果告诉我。" },
  e2: { max: 240000, msg: "写一段 Python 代码，计算 1 到 100000 之间所有质数的个数，保存成工作区里的文件 primes.py，真的运行它，告诉我运行结果，并在回复里给我这个文件的链接，我要下载。" },
  e3: { max: 240000, msg: "写一段 Python 代码，计算 1 到 100000 之间所有质数的个数，保存成工作区里的文件 primes.py，真的运行它，告诉我运行结果。回复的最后一行请直接写出这个文件的地址 https://workspace.local/primes.py （就贴地址本身，不要写成 Markdown 链接，也不要用下载卡片），我要点它下载。" },
  e4: { max: 240000, msg: "写一段 Python 代码，计算 1 到 100000 之间所有质数的个数，保存成工作区里的文件 primes.py，真的运行它，告诉我运行结果。回复里请用这段 HTML 给我下载链接：<a href=\"primes.py\" download>primes.py</a>（原样写出，不要用下载卡片），我要点它下载。" },
  f: { max: 480000, msg: "搜索目前世界上最高的 5 座建筑，打开一个可靠的网页核对数据，然后整理成表格（名称、城市、高度、建成年份），附上你核对用的来源链接。" },
  g1: { max: 180000, msg: "2 分钟后提醒我喝水。" },
  g2: { max: 180000, msg: "记住：我喜欢喝冰美式，不加糖。" },
  g3: { max: 180000, msg: "你有哪些技能？挑一个你觉得最有用的，现在用它帮我做一件小事。" },
  g4: { max: 240000, msg: "帮我做一个网页：标题「周末计划」，列出周六爬山、周日看电影，发布后把链接给我。" },
  h2: { max: 900000, shotEvery: 45000, msg: "逐个用你的浏览器打开这 8 个官网：python.org、nodejs.org、www.rust-lang.org、go.dev、kotlinlang.org、www.ruby-lang.org、www.php.net、dart.dev。每个页面都要真的打开，读出页面上写的最新稳定版本号（页面上没写就打开它的下载页找），全部看完后整理成一张表（语言、最新版本、你在哪个页面看到的）。" },
  h3: { max: 1500000, shotEvery: 60000, msg: "帮我做一份开源项目近况表。逐个用你的浏览器打开下面 12 个 GitHub 仓库：先打开仓库主页读 star 数，再打开它的 Releases 页面（仓库地址后面加 /releases）读最新正式版本号和发布日期。仓库：microsoft/vscode、facebook/react、vuejs/core、sveltejs/svelte、vitejs/vite、denoland/deno、oven-sh/bun、rust-lang/rust、golang/go、python/cpython、nodejs/node、tauri-apps/tauri。每个都要真的打开两页，不要凭记忆。全部看完后给我一张表（仓库、star、最新版本、发布日期），最后说一句你觉得哪个最近最活跃、为什么。" },
  L: { max: 900000, shotEvery: 30000, msg: "在工作区写一个 Python 脚本 slow.py：循环 4 次，每次先 sleep 55 秒，再打印「第 N 轮」和当前时间，最后打印 done。然后真的用命令运行它（前台运行，整个大约要 4 分钟，请耐心等它自己跑完，不要放到后台、不要中途停止、不要改短时间），跑完把完整输出原样发给我，并说一下总共用了多少秒。" },
  L2: { max: 900000, shotEvery: 30000, msg: "在你自己的电脑的工作区里写一个 Python 脚本 long_calc.py：先循环 4 次，每次 sleep 55 秒并打印「第 N 轮」和当前时间；然后计算 2 到 2000000 之间质数的个数并打印出来，最后打印 done。然后真的在你自己的电脑上用命令前台运行它（整个大约要 4 分钟，请耐心等它跑完，不要放到后台、不要中途停止、不要改短时间），跑完把完整输出原样发给我，并说一下总共用了多少秒。" },
  h: { max: 900000, shotEvery: 45000, msg: "帮我调研 3 个开源 AI agent 框架：LangGraph、CrewAI、AutoGen。逐个用浏览器打开它们的 GitHub 仓库页面，记录 star 数、最新发布版本号和日期、主要编程语言，最后给我一个对比表和你的推荐理由。" },
};
const TASKS = (process.env.TASKS || "a").split(",");
const PC = process.env.PC === "1";
const results = [];
const ctx = await context({ pc: PC });
const page = await newPage(ctx, "rt");
await page.goto(base + "/", { waitUntil: "domcontentloaded" });
const call = (p, o) => api(page, p, o);
await guardInit(call);
const r = await call("/api/agents", { method: "POST", body: JSON.stringify({ name: `临时验收${process.env.NAME || ""}`, title: "临时测试（会删除）", roleDescription: "我的私人助手：回答问题、查资料、帮我把事情办好。", visibility: "private" }) });
if (!JSON.parse(r.body).agent) { log("create bot failed", r.status, r.body.slice(0, 300)); process.exit(1); }
const bot = trackBot(JSON.parse(r.body).agent.id);
fs.appendFileSync("/out/bots.txt", bot + "\n");
if (process.env.MODEL) { const m = await call(`/api/agents/${bot}/model`, { method: "PUT", body: JSON.stringify({ model: process.env.MODEL }) }); log("bot model", process.env.MODEL, m.status, m.body.slice(0, 160)); }
log("bot", bot, "pc", PC);
try {
  await chisaBot(page, bot);
  let tid = null;
  for (const k of TASKS) {
    const t = T[k];
    const before = tid ? (await threadMessages(page, tid)).length || 0 : 0;
    const t0 = Date.now();
    await send(page, t.msg);
    if (!tid) { await page.waitForURL((u) => /\/channel\/(?!new)/.test(u.pathname), { timeout: 30000 }).catch(() => {}); tid = await threadOf(page); log("thread", tid, page.url()); }
    const w = await waitIdle(page, { max: t.max, shotEvery: t.shotEvery || 0, shotPrefix: `/out/${k}-progress` });
    if (k === "g1") { log("waiting for reminder 150s"); await page.waitForTimeout(150000); }
    const msgs = await threadMessages(page, tid);
    const tr = await transcript(page);
    const stopped = await page.locator('[data-testid="transcript-stopped"]:visible').count();
    await page.screenshot({ path: `/out/${k}.png` });
    await page.screenshot({ path: `/out/${k}-full.png`, fullPage: true }).catch(() => {});
    // 最终回答：最后一条有文字的助手消息在最后一次工具结果之后
    let finalText = ""; let lastToolIdx = -1; const arr = Array.isArray(msgs) ? msgs.slice(before) : [];
    arr.forEach((m, i) => { if (m.role === "tool") lastToolIdx = i; });
    arr.forEach((m, i) => { if (m.role === "assistant" && i > lastToolIdx) { const c = typeof m.content === "string" ? m.content : ""; if (c.trim()) finalText = c; } });
    const blocked = (tr.match(/\[blocked\]/g) || []).length;
    const links = await page.locator('[data-slot="message-scroller-viewport"] a[href*="/files/download"], [data-slot="message-scroller-viewport"] a[href*="/api/chat-files/"]').evaluateAll((as) => as.map((a) => a.href)).catch(() => []);
    const linkChecks = [];
    for (const href of links.slice(0, 3)) linkChecks.push(await page.evaluate(async (h) => { const r = await fetch(h); const t = await r.text(); return { href: h.replace(location.origin, ""), status: r.status, type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), bytes: t.length, head: t.slice(0, 80) }; }, href).catch((e) => ({ href, error: String(e) })));
    const wsLocal = await page.locator('[data-slot="message-scroller-viewport"] a[href*="workspace.local"]').count().catch(() => -1);
    const wsCards = (await page.locator('[data-slot="message-scroller-viewport"] :text("workspace.local")').count().catch(() => -1));
    const fallbackNotice = (tr.match(/已改用[^\n]*/g) || []).slice(0, 3);
    const toolText = summarize(msgs, before); const deviceShell = /device_run_shell/.test(toolText); const runCmds = (toolText.match(/computer_run_command\([^\n]*/g) || []).map((x) => x.slice(0, 200));
    const res = { task: k, deviceShell, runCmds, finalText: finalText.slice(0, 1500), finalOk: !!finalText.trim(), blocked, linkChecks, wsLocal, wsCards, fallbackNotice, webgl: /WebGL/i.test(tr), secs: Math.round((Date.now() - t0) / 1000), timedOut: w.timedOut, events: w.events, stoppedCard: stopped, tools: summarize(msgs, before) };
    results.push(res);
    fs.writeFileSync(`/out/${k}.txt`, `${t.msg}\n\n=== tools/messages ===\n${res.tools}\n\n=== transcript tail ===\n${tr.slice(-3000)}\n`);
    log("TASK", k, `deviceShell=${deviceShell} runCmds=${JSON.stringify(runCmds)} final=${res.finalOk} blocked=${blocked} links=${JSON.stringify(linkChecks)} wsLocalA=${wsLocal} wsLocalText=${wsCards} fb=${JSON.stringify(fallbackNotice)} ${res.secs}s timedOut=${w.timedOut} stopped=${stopped} events=${JSON.stringify(w.events)}`);
    console.log(res.tools.slice(-2500));
  }
} catch (error) {
  log("SCRIPT-ERROR", String(error?.stack || error).slice(0, 800));
  await page.screenshot({ path: `/out/error.png` }).catch(() => {});
} finally {
  if (process.env.KEEP !== "1") { const d = await guardedDeleteBot(call, bot); log("deleted bot", bot, JSON.stringify(d).slice(0, 120)); }
  log("ERRORS", JSON.stringify(errors.slice(0, 25)));
  fs.writeFileSync("/out/results.json", JSON.stringify(results, null, 2));
  await browser.close();
}
