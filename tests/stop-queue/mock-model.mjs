// Deterministic OpenAI-compatible model for the CB-104 stop / queue E2E.
//   last user message contains "LONG" -> streams a long article for ~40 s (one chunk every 250 ms);
//   anything else                      -> short reply "收到：<text>".
// GET /stats reports streams that are still open and when the last one was cut by the client, so the
// E2E can prove that Stop actually reaches the model call instead of only hiding the UI.
import http from "node:http";

const PORT = Number(process.env.PORT || 4314);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (m) =>
  typeof m.content === "string"
    ? m.content
    : (m.content || []).map((p) => p.text || "").join("");
const stats = { open: 0, started: 0, aborted: 0, lastAbortAt: 0, prompts: [] };

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "GET" && req.url?.startsWith("/stats")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(stats));
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ data: [{ id: "mock-stop-queue", object: "model" }] }),
      );
    }
    let json = {};
    try {
      json = JSON.parse(body || "{}");
    } catch {}
    const users = (json.messages || [])
      .filter((m) => m.role === "user")
      .map(textOf);
    const last = users.at(-1) || "";
    const id = `chatcmpl-${Date.now()}`;
    const base = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "mock-stop-queue",
    };
    if (!json.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          model: "mock-stop-queue",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "测试标题" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    }
    stats.started++;
    stats.open++;
    stats.prompts.push(users.slice(-3));
    let closed = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        closed = true;
        stats.aborted++;
        stats.lastAbortAt = Date.now();
      }
      stats.open--;
    });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    });
    // A paused supplement sent with 「发送这条 / 全部发送」 arrives wrapped; answer its original text.
    const resumed = last.split("所选补充原文：\n")[1];
    const long = !resumed && (/LONG/.test(last) || /^换个方向/.test(last));
    const pieces = long
      ? Array.from(
          { length: 160 },
          (_, i) => `第${i + 1}句：时间管理先从记录开始。`,
        )
      : [`收到：${(resumed ?? last).slice(0, 40)}`];
    for (const piece of pieces) {
      if (closed) return;
      send({
        ...base,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      });
      await sleep(long ? 250 : 40);
    }
    if (closed) return;
    send({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  })
  .listen(PORT, () => console.log(`mock-stop-queue on ${PORT}`));
