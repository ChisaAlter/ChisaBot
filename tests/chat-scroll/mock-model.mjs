// OpenAI-compatible mock model for the scroll-jump repro: streams deterministic markdown in
// ~upstream-like bursts. Last user message decides the reply:
//   "SEED <n>"  -> short/medium varied reply (history seeding, fast)
//   "LONG"      -> long markdown (headings, list, code, table, links, images), ~15 s stream
//   "TOOLS"     -> narration + a harmless tool call first, then the long answer (turn compaction)
import http from "node:http";

const para = (n) =>
  `这是第 ${n} 段说明文字，用来把回复撑长一些，看看流式输出的时候聊天窗口会不会乱跳。法兰克福是德国的金融中心，美因河穿城而过，老城区的罗马广场周围有很多木桁架房子。`;
const code = Array.from({ length: 28 }, (_, i) => `  const value${i} = compute(${i}) * factor + offset; // 第 ${i} 行`).join("\n");
const LONG = [
  "## 总览",
  "",
  para(1),
  "",
  "下面是几个要点：",
  "",
  "- **第一点**：滚动应该一直贴在底部。",
  "- **第二点**：用户往上翻的时候不能被拽回去。",
  "- **第三点**：加载旧消息时不能跳。",
  "",
  para(2),
  "",
  "参考链接：https://github.com/ChisaAlter/ChisaBot 和 https://www.wikipedia.org/",
  "",
  "```ts",
  "function compute(input: number) {",
  code,
  "  return input;",
  "}",
  "```",
  "",
  para(3),
  "",
  "| 城市 | 人口 | 河流 |",
  "| --- | --- | --- |",
  "| 法兰克福 | 77 万 | 美因河 |",
  "| 柏林 | 375 万 | 施普雷河 |",
  "| 汉堡 | 185 万 | 易北河 |",
  "",
  "![美因河](https://picsum.photos/seed/main1/800/520)",
  "![老城区](https://picsum.photos/seed/main2/640/640)",
  "![天际线](https://picsum.photos/seed/main3/900/500)",
  "",
  para(4),
  "",
  "### 结尾",
  "",
  para(5),
  para(6),
].join("\n");

function seedReply(n) {
  const k = n % 5;
  if (k === 0) return `第 ${n} 条回复。\n\n${para(n)}\n\n\`\`\`bash\necho seed-${n}\nls -la /tmp\n\`\`\``;
  if (k === 1) return `好的，第 ${n} 条。`;
  if (k === 2) return `${para(n)}\n\n- 甲\n- 乙\n- 丙`;
  if (k === 3) return `第 ${n} 条：${para(n)} ${para(n + 100)}`;
  return `看这张图（第 ${n} 条）：\n\n![图${n}](https://picsum.photos/seed/s${n}/600/400)`;
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("");
  }
  return "";
}

function chunks(text, size) {
  const out = [];
  const arr = Array.from(text);
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size).join(""));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "mock-scroll", object: "model" }] }));
    }
    let j = {};
    try { j = JSON.parse(body || "{}"); } catch {}
    const messages = j.messages || [];
    const user = lastUser(messages);
    const afterTool = messages.length && messages[messages.length - 1].role === "tool";
    let text;
    let tool = null;
    let size = 20;
    let gap = 150;
    const m = /SEED\s+(\d+)/.exec(user);
    if (m) { text = seedReply(Number(m[1])); size = 400; gap = 20; }
    else if (/TOOLS/.test(user) && !afterTool) { text = "我先看一下当前的时间，再给你详细说明。"; tool = { name: "get_time" }; }
    else if (/LONG|TOOLS/.test(user)) text = LONG;
    else text = "你好，我是测试模型。";
    const id = `chatcmpl-${Date.now()}`;
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-scroll" };
    if (!j.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id, object: "chat.completion", model: "mock-scroll", choices: [{ index: 0, message: { role: "assistant", content: `${user.slice(0, 0)}测试标题` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    for (const c of chunks(text, size)) {
      send({ ...base, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] });
      await sleep(gap);
    }
    // Tools the agent knows are the client-provided ones; pick one that exists when asked.
    if (tool) {
      const tools = (j.tools || []).map((t) => t.function?.name).filter(Boolean);
      const name = tools.find((n) => /panel_list|computer_read|web_search/.test(n)) || tools[0];
      if (name) {
        const args = name === "web_search" ? JSON.stringify({ query: "Frankfurt" }) : "{}";
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } });
    res.write("data: [DONE]\n\n");
    res.end();
  })
  .listen(4010, () => console.log("mock on 4010"));
