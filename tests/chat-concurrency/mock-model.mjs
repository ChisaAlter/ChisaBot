// OpenAI-compatible fake model for the concurrency / background-worker E2E (DESIGN.md §38).
// The conversation decides the reply:
//   "WORK"      -> 3 slow tool steps (worker_status), ~2.5 s of streamed text each; after every step it
//                  checks whether the person's mid-turn messages were injected and, at the end, answers
//                  each one by quoting it ("已按补充调整：…").
//   "DELEGATE"  -> calls delegate_task, then says it handed the job off.
//   worker turn (prompt has the 后台任务 frame) -> worker_plan ×3 with slow text between, folds in any
//                  补充说明, ends with "后台结果：…".
//   worker result (last user message starts with ⟦chisabot:worker-result:) -> one-line summary.
//   anything else -> short echo, so a queued plain message gets its own reply.
import http from "node:http";

const PORT = Number(process.env.PORT || 4011);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) =>
  typeof m.content === "string"
    ? m.content
    : (m.content || []).map((p) => p.text || "").join("");
const chunks = (text, size) => {
  const arr = Array.from(text);
  const out = [];
  for (let i = 0; i < arr.length; i += size)
    out.push(arr.slice(i, i + size).join(""));
  return out;
};
const filler = (n) =>
  `第 ${n} 步：正在处理，这一段文字故意写得长一点，让流式输出持续几秒钟，方便在中途再发消息。`;

function plan(messages) {
  const users = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === "user");
  const last = users[users.length - 1];
  const lastText = last ? textOf(last.m) : "";
  const tools = last
    ? messages.slice(last.i + 1).filter((m) => m.role === "tool").length
    : 0;
  const all = messages.map(textOf).join("\n");

  const frame = messages.findIndex(
    (m) => m.role === "user" && textOf(m).startsWith("你现在是后台任务「"),
  );
  if (frame >= 0) {
    const after = frame;
    const steps = messages
      .slice(after + 1)
      .filter((m) => m.role === "tool").length;
    const extra = messages
      .slice(after + 1)
      .filter((m) => m.role === "user")
      .map(textOf)
      .join(" / ");
    const st = (i) =>
      i < steps ? "done" : i === steps ? "current" : "pending";
    if (steps < 3)
      return {
        text: filler(steps + 1),
        tool: {
          name: "worker_plan",
          args: {
            steps: ["打开资料", "整理要点", "写出结果"].map((text, i) => ({
              text,
              status: st(i),
            })),
          },
        },
        gap: 260,
      };
    return {
      text: `后台结果：三步都完成了。${extra ? `另外按补充说明处理了：${extra.replace(/^[^：]*：/, "")}` : ""}`,
    };
  }
  if (lastText.startsWith("⟦chisabot:worker-result:"))
    return {
      text: `后台任务做完了，要点：${lastText.split("\n").slice(3).join(" ").slice(0, 60)}`,
    };
  const workIndex = messages.findLastIndex(
    (m) =>
      m.role === "user" &&
      /WORK\b/.test(textOf(m)) &&
      !/后台任务/.test(textOf(m)),
  );
  if (workIndex >= 0 && /WORK\b/.test(all)) {
    const tail = messages.slice(workIndex + 1);
    const steps = tail.filter((m) => m.role === "tool").length;
    const injected = tail
      .filter((m) => m.role === "user")
      .map((m) => textOf(m).split("\n").pop());
    const answered = tail.some(
      (m) => m.role === "assistant" && /已按补充调整/.test(textOf(m)),
    );
    if (!answered && steps < 3)
      return {
        text: filler(steps + 1),
        tool: { name: "worker_status", args: {} },
        gap: 180,
      };
    if (!answered)
      return {
        text: injected.length
          ? `已按补充调整：${injected.join("；")}。三步都做完了。`
          : "三步都做完了。",
      };
  }
  if (/DELEGATE/.test(lastText) && tools === 0)
    return {
      text: "我交给后台去做。",
      tool: {
        name: "delegate_task",
        args: {
          title: "测试后台任务",
          task: "WORKER 请分三步完成测试任务",
          plan: ["打开资料", "整理要点", "写出结果"],
        },
      },
    };
  if (/DELEGATE/.test(lastText))
    return { text: "已经交给后台了，做完会把结果发到这里。你可以继续跟我聊。" };
  return { text: `收到：${lastText.slice(0, 40)}`, gap: 60 };
}

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ data: [{ id: "mock-concurrency", object: "model" }] }),
      );
    }
    let j = {};
    try {
      j = JSON.parse(body || "{}");
    } catch {}
    const messages = j.messages || [];
    const reply = plan(messages);
    const id = `chatcmpl-${Date.now()}`;
    const base = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "mock-concurrency",
    };
    if (!j.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          model: "mock-concurrency",
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
    for (const c of chunks(reply.text, 6)) {
      send({
        ...base,
        choices: [{ index: 0, delta: { content: c }, finish_reason: null }],
      });
      await sleep(reply.gap ?? 120);
    }
    const offered = (j.tools || [])
      .map((t) => t.function?.name)
      .filter(Boolean);
    if (reply.tool && offered.includes(reply.tool.name)) {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                  type: "function",
                  function: {
                    name: reply.tool.name,
                    arguments: JSON.stringify(reply.tool.args),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    } else {
      if (reply.tool)
        console.log("tool not offered:", reply.tool.name, offered.join(","));
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  })
  .listen(PORT, () => console.log(`mock on ${PORT}`));
