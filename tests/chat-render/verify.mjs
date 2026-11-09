// Exercise the shipped web build with deterministic AG-UI events. No production data or model calls.
// node tests/chat-render/verify.mjs [app/dist] [output directory]
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { startMockServer } from "../../perf/mock-server.mjs";

const dist = path.resolve(process.argv[2] || "app/dist");
const out = path.resolve(process.argv[3] || "perf/out/chat-render");
fs.mkdirSync(out, { recursive: true });
const seed = [
  { id: "seed-user", role: "user", content: "请整理项目的处理结果。" },
  { id: "seed-answer", role: "assistant", content: Array.from({ length: process.argv.includes("--serve") ? 24 : 8 }, (_, i) => `第 ${i + 1} 项处理结果：正文保留在对话中，可以向上翻阅。这里包含**加粗内容**和\`行内代码\`。`).join("\n\n") },
];
const fixture = JSON.parse(fs.readFileSync(new URL("../../perf/fixtures/api.json", import.meta.url), "utf8"));
fixture["^/api/conversations/threads/tc2/messages$"] = { messages: seed };
const fixturePath = path.join(out, "fixture.json");
fs.writeFileSync(fixturePath, JSON.stringify(fixture));
const mock = await startMockServer({ dist, fixtures: fixturePath });
let history = structuredClone(seed);
let runCount = 0;
let running = false;
let lastError = null;
const commands = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sse = (res, event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
const proxy = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/api/bot-threads/a2/sync")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ thread: { threadId: "tc2", seq: String(runCount), revision: "0", running, workers: null, inbox: null } }));
  }
  if (req.url?.split("?")[0] === "/api/conversations/threads/tc2/messages") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ messages: history }));
  }
  if (req.method === "POST" && req.url === "/api/conversations/agent/a2/connect") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { type: "RUN_STARTED", runId: `replay-${runCount}`, threadId: "tc2" });
    sse(res, { type: "MESSAGES_SNAPSHOT", messages: history });
    sse(res, lastError ?? { type: "RUN_FINISHED", runId: `replay-${runCount}`, threadId: "tc2" });
    return res.end();
  }
  if (req.method === "POST" && req.url === "/api/conversations/tc2/commands") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { input } = JSON.parse(raw);
    const commandId = input.messages.findLast(message => message.role === "user").id;
    commands.set(commandId, input);
    res.writeHead(202, { "content-type": "application/json" });
    return res.end(JSON.stringify({ accepted: true, commandId, runId: input.runId }));
  }
  if (req.method === "POST" && (/\/agent\/[^/]+\/run$/.test(req.url) || req.url === "/api/conversations/tc2/events")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input = body.commandId ? commands.get(body.commandId) : body;
    const n = ++runCount;
    running = true;
    const { runId, threadId } = input;
    history = input.messages;
    lastError = null;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, { type: "RUN_STARTED", runId, threadId });
    if (history.at(-1)?.content === "验证失败恢复") {
      lastError = { type: "RUN_ERROR", code: "DSH_RUNTIME_ERROR", message: "隔离验证：模型停止。" };
      sse(res, lastError);
      running = false;
      return res.end();
    }
    for (const [i, text] of [
      "已整理好项目处理结果。下面是具体说明。",
      "第二段结果始终在气泡里。\n\n## 已完成\n\n- 修复正文显示\n- 保留代码示例\n\n## 后续处理\n\n- 检查模型连接\n- 核对最终结果\n\n普通正文保持原来的格式。",
      "### 命令示例\n\n```sh\necho ok\n```",
    ].entries()) {
      const messageId = `answer-${n}-${i}`;
      sse(res, { type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      for (let at = 0; at < text.length; at += 8) {
        sse(res, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text.slice(at, at + 8) });
        await delay(25);
      }
      sse(res, { type: "TEXT_MESSAGE_END", messageId });
      history.push({ id: messageId, role: "assistant", content: text });
    }
    // Keep the second message visible while the run is still live.
    await delay(1500);
    sse(res, { type: "RUN_FINISHED", runId, threadId });
    running = false;
    return res.end();
  }
  const target = new URL(req.url, mock.base);
  const upstream = http.request(target, { method: req.method, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${proxy.address().port}`;
if (process.argv.includes("--serve")) {
  console.log(base);
  await new Promise(() => {});
}
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === "win32" ? { channel: "msedge" } : {}), args: ["--no-sandbox"] });
const results = [];
try {
  for (const [name, width, height, theme] of [["desktop", 1280, 900, "light"], ["mobile", 420, 860, "light"], ["desktop-dark", 1280, 900, "dark"]]) {
    history = structuredClone(seed);
    lastError = null;
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
    await context.addInitScript((theme) => localStorage.setItem("chisabot-theme", theme), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/channel/c2`);
    const editor = page.locator(".prompt-area-editor, [contenteditable=true], textarea").filter({ visible: true }).first();
    await editor.waitFor({ timeout: 45000 });
    await page.waitForTimeout(2200);
    await editor.fill("请继续说明显示修复结果");
    await editor.press("Enter");
    await page.getByText("第二段结果始终在气泡里。", { exact: true }).waitFor();
    const live = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="chat-transcript"]');
      const bare = [...root.querySelectorAll(".chat-step-line")].filter((e) => e.getBoundingClientRect().height > 0).length;
      return { bare, automaticDocs: root.querySelectorAll(".chat-doc-card").length, busy: root.getAttribute("aria-busy") };
    });
    await page.screenshot({ path: path.join(out, `${name}-stream.png`) });
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-transcript"]')?.getAttribute("aria-busy") === "false");
    await page.waitForTimeout(2200);
    // Width reflow and a completed turn must both leave a compact tail.
    await page.setViewportSize({ width: width - 70, height });
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(1000);
    const settled = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="chat-transcript"]');
      const viewport = root.closest('[data-slot="message-scroller-viewport"]');
      const slack = root.querySelector("[data-chat-slack]");
      const spacer = root.querySelector("[data-message-scroller-spacer]");
      const heading = [...root.querySelectorAll("h3")].find((el) => el.textContent === "命令示例");
      const bubble = heading?.closest('[data-slot="bubble"]');
      return { slack: slack?.getBoundingClientRect().height ?? 0, spacer: spacer?.getBoundingClientRect().height ?? 0, floor: root.style.minHeight, bottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight, headingSurfaced: Boolean(bubble && !bubble.classList.contains("chat-bubble-bare")) };
    });
    await page.screenshot({ path: path.join(out, `${name}-settled.png`) });
    await editor.fill("验证失败恢复");
    await editor.press("Enter");
    await page.getByText("隔离验证：模型停止。", { exact: true }).waitFor();
    assert.equal(await editor.innerText(), "", `${name}: admitted failure restored a duplicate draft`);
    assert.equal(await page.getByText("没发出去", { exact: true }).count(), 0, `${name}: admitted command labelled unsent`);
    await page.reload();
    await page.getByText("隔离验证：模型停止。", { exact: true }).waitFor();
    assert.equal(await page.getByText("验证失败恢复", { exact: true }).count(), 1, `${name}: accepted user message duplicated`);
    await page.screenshot({ path: path.join(out, `${name}-failure-reloaded.png`) });
    results.push({ name, live, settled, failureRestored: true, errors });
    await context.close();
  }
} finally {
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  proxy.closeAllConnections();
  proxy.close();
  mock.close();
}
console.log(JSON.stringify(results, null, 2));
for (const row of results) {
  assert.equal(row.live.bare, 0, `${row.name}: assistant text outside a bubble`);
  assert.equal(row.live.automaticDocs, 0, `${row.name}: ordinary answer changed into a document`);
  assert.ok(row.settled.slack + row.settled.spacer <= 2, `${row.name}: trailing blank remains`);
  assert.equal(row.settled.floor, "", `${row.name}: idle content retains a height floor`);
  assert.equal(row.settled.headingSurfaced, true, `${row.name}: code heading has no surface`);
  assert.equal(row.errors.length, 0, `${row.name}: browser errors`);
}
