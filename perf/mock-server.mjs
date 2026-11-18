// Static dist + mocked /api for the jank harness. No real backend or credentials needed.
// Fixture map: perf/fixtures/api.json ({ "<path regex>": <json body> }); anything unmatched → 404.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

const PARA =
  "这是一段用于性能测试的回复内容，包含**加粗**、`行内代码`和一个[链接](https://example.com)。".repeat(
    3,
  );

/** 240-message conversation (c1 / thread tc1) with headings, lists and code blocks. */
function longThread() {
  const out = [];
  for (let i = 0; i < 240; i++) {
    if (i % 2 === 0) {
      out.push({
        id: `L${i}`,
        role: "user",
        content: `第 ${i / 2 + 1} 个问题：帮我看看这段话怎么改？`,
      });
    } else {
      const rich = `## 小结 ${i}\n\n${PARA}\n\n- 要点一\n- 要点二\n- 要点三\n\n\`\`\`ts\nconst x = ${i};\nconsole.log(x);\n\`\`\``;
      out.push({
        id: `L${i}`,
        role: "assistant",
        content: i % 10 === 1 ? rich : `${PARA}\n\n${PARA}`,
      });
    }
  }
  return out;
}

const STREAM_TEXT = (
  "好的，下面是逐步说明。\n\n## 第一步\n\n先准备**材料**，然后按顺序操作：\n\n1. 打开设置\n2. 选择 `外观`\n3. 保存\n\n" +
  "这一段是流式输出的正文，用来测每一帧的渲染成本。".repeat(4) +
  "\n\n"
).repeat(6);

const sse = (res, ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

/** AG-UI run: ~6 chars every 25 ms. */
async function streamRun(res, body) {
  let input = {};
  try {
    input = JSON.parse(body);
  } catch {}
  const threadId = input.threadId || "t";
  const runId = input.runId || `r${Date.now()}`;
  const mid = `s${Date.now()}`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sse(res, { type: "RUN_STARTED", threadId, runId });
  sse(res, { type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" });
  const chars = [...STREAM_TEXT];
  for (let i = 0; i < chars.length; i += 6) {
    sse(res, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: mid,
      delta: chars.slice(i, i + 6).join(""),
    });
    await new Promise((r) => setTimeout(r, 25));
  }
  sse(res, { type: "TEXT_MESSAGE_END", messageId: mid });
  sse(res, { type: "RUN_FINISHED", threadId, runId });
  res.end();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) =>
  `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const TOOL_TURN_OPEN = "我先查一下天气和开放时间，再帮你排周末的行程。";
const TOOL_TURN_NOTE = "查到了，再核对一个来源。";
const TOOL_TURN_CALLS = [
  {
    name: "web_search",
    args: { query: "本周末 郊区 天气" },
    result: "周六晴，18–24°C，微风；周日多云转阴，17–23°C，夜间有短时小雨。",
  },
  {
    name: "web_search",
    args: { query: "植物园 周末 开放时间" },
    result: "植物园周六日 8:30–17:30 开放，门票 ¥10，温室 16:30 停止入场。",
  },
  {
    name: "web_fetch",
    args: { url: "https://example.com/park-weekend-notice" },
    result:
      "网址：https://example.com/park-weekend-notice\n状态：200\n园区公告：本周末正常开放，东门停车场 9:00 前到基本有位，湖边餐厅 11:00–14:00 营业。",
  },
];
const TOOL_TURN_ANSWER = (
  "## 周末半日行程\n\n" +
  "查完了：周六晴、18–24°C，适合出门；周日多云转阴，夜里可能下小雨，建议把行程排在周六。\n\n" +
  "### 建议路线\n\n" +
  "1. **9:00** 出发去植物园（8:30 开门，早去人少，东门停车场 9 点前基本有位）\n" +
  "2. **11:30** 园内湖边餐厅午饭（11:00–14:00 营业，饭点要排队，建议 11:30 前入座）\n" +
  "3. **13:30** 温室和花径慢慢逛，16:30 温室停止入场\n" +
  "4. **16:00** 出来去老街喝杯咖啡，傍晚回家\n\n" +
  "### 要带的东西\n\n" +
  "- 薄外套（早晚 18°C 左右，湖边风大）\n" +
  "- 防晒和水，周六晴天紫外线不低\n" +
  "- 门票 ¥10，门口扫码就能买\n\n" +
  "```\n植物园：8:30–17:30｜温室到 16:30｜东门停车 9:00 前有位\n```\n\n" +
  "如果改到周日去也可以，就是下午天色会差一点，记得带伞。\n\n"
).repeat(4).slice(0, 2100);

/*
 * toolTurn.answer：同一回合、同一节奏（~6 字符 / 25ms）、总长 ~2100 的不同正文配方，
 * 给 work-card-jump 的 --answer 矩阵定位哪类 markdown 块会让流式高度猛跳。
 */
const TOOL_TURN_PARA =
  "周六晴，18–24°C，微风；周日多云转阴，17–23°C，夜里可能下短时小雨，行程建议排在周六，早晚湖边风大，记得带件薄外套。";
const TOOL_TURN_ANSWERS = {
  rich: TOOL_TURN_ANSWER,
  plain: `${TOOL_TURN_PARA}\n\n`.repeat(24).slice(0, 2100),
  list: (
    `${TOOL_TURN_PARA}\n\n` +
    "- 9:00 出发，东门停车场 9 点前基本有位\n- 11:30 湖边餐厅午饭，饭点要排队\n- 13:30 温室和花径，16:30 停止入场\n- 16:00 老街喝杯咖啡再回家\n\n" +
    `${TOOL_TURN_PARA}\n\n` +
    "1. 先在东门扫码买票（¥10）\n2. 沿主路走到湖区\n3. 湖边餐厅取号\n4. 温室最后去，别错过 16:30\n\n"
  ).repeat(3).slice(0, 2100),
  code: (
    `${TOOL_TURN_PARA}\n\n` +
    "```ts\nconst plan = {\n  day: 'saturday',\n  leaves: '09:00',\n  spots: ['植物园', '湖边餐厅', '老街'],\n  rain: 'sunday-night',\n};\n```\n\n" +
    `${TOOL_TURN_PARA}\n\n` +
    "```\n植物园 8:30–17:30\n温室 到 16:30\n东门停车 9:00 前有位\n湖边餐厅 11:00–14:00\n```\n\n"
  ).repeat(3).slice(0, 2100),
  table: (
    `${TOOL_TURN_PARA}\n\n` +
    "| 时间 | 安排 | 备注 |\n| --- | --- | --- |\n| 9:00 | 出发去植物园 | 东门停车 9 点前有位 |\n| 11:30 | 湖边餐厅午饭 | 饭点要排队 |\n| 13:30 | 温室和花径 | 16:30 停止入场 |\n| 16:00 | 老街咖啡 | 傍晚回家 |\n\n" +
    `${TOOL_TURN_PARA}\n\n` +
    "| 项目 | 周六 | 周日 |\n| --- | --- | --- |\n| 天气 | 晴 18–24°C | 多云转阴 |\n| 风 | 微风 | 傍晚起风 |\n| 雨 | 无 | 夜间短时小雨 |\n\n"
  ).repeat(3).slice(0, 2100),
  link: (
    `${TOOL_TURN_PARA}\n\n` +
    `开放时间看[植物园官网公告](https://example.com/park/hours)，地图和停车信息在[园区导览页](https://example.com/park/map)，湖边餐厅菜单可以参考[餐厅页面](https://example.com/lake-cafe)。\n\n` +
    `${TOOL_TURN_PARA}\n\n` +
    `如果周六人太多，备选是[郊野步道](https://example.com/trail)和[河畔绿道](https://example.com/greenway)，都不需要门票。\n\n`
  ).repeat(3).slice(0, 2100),
  image: (
    `${TOOL_TURN_PARA}\n\n` +
    "![园区导览图](/_mock/img.svg)\n\n" +
    `${TOOL_TURN_PARA}\n\n` +
    `${TOOL_TURN_PARA}\n\n`
  ).repeat(4).slice(0, 2100),
  heading: (
    "## 周六行程\n\n" +
    `${TOOL_TURN_PARA}\n\n` +
    "### 上午\n\n" +
    `${TOOL_TURN_PARA}\n\n` +
    "### 下午\n\n" +
    `${TOOL_TURN_PARA}\n\n` +
    "## 周日备选\n\n" +
    `${TOOL_TURN_PARA}\n\n`
  ).repeat(3).slice(0, 2100),
};

/** 一段话按 ~6 字符 / 25ms 的节奏推给一条 TEXT_MESSAGE。 */
async function streamText(res, messageId, text) {
  sse(res, { type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 6) {
    sse(res, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: chars.slice(i, i + 6).join(""),
    });
    await sleep(25);
  }
  sse(res, { type: "TEXT_MESSAGE_END", messageId });
}

/**
 * toolTurn 模式的一次 run（AG-UI，POST /api/conversations/:thread/events 回这条流）：
 * 一句开场白 → 停 ~1.5s → 三个干活工具（web_search ×2、web_fetch，约 1.2s 一个，
 * 中间夹一句过程话）→ 长回答 ~8s 流完 → RUN_FINISHED。
 * `holdMs` > 0 时第一个工具调用的结果晚到这么久（Scenario B：回合还在跑时展开/收起干活卡）。
 */
async function streamToolTurn(res, { threadId, runId }, holdMs, answer) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sse(res, { type: "RUN_STARTED", threadId, runId });
  await streamText(res, uid("a"), TOOL_TURN_OPEN);
  await sleep(1500);
  for (let i = 0; i < TOOL_TURN_CALLS.length; i++) {
    const call = TOOL_TURN_CALLS[i];
    const toolCallId = uid("call");
    sse(res, {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: call.name,
      parentMessageId: uid("m"),
    });
    const args = JSON.stringify(call.args);
    const cut = Math.ceil(args.length / 2);
    sse(res, { type: "TOOL_CALL_ARGS", toolCallId, delta: args.slice(0, cut) });
    await sleep(30);
    sse(res, { type: "TOOL_CALL_ARGS", toolCallId, delta: args.slice(cut) });
    sse(res, { type: "TOOL_CALL_END", toolCallId });
    await sleep(i === 0 && holdMs > 0 ? holdMs : 650);
    sse(res, {
      type: "TOOL_CALL_RESULT",
      toolCallId,
      messageId: uid("t"),
      role: "tool",
      content: call.result,
    });
    if (i === 0) await streamText(res, uid("n"), TOOL_TURN_NOTE);
    if (i < TOOL_TURN_CALLS.length - 1) await sleep(520);
  }
  await streamText(res, uid("ans"), answer ?? TOOL_TURN_ANSWER);
  sse(res, { type: "RUN_FINISHED", threadId, runId });
  res.end();
}

/**
 * @param {{ dist: string, port?: number, latencyMs?: number, fixtures?: string,
 *   toolTurn?: boolean | { holdMs?: number, answer?: keyof typeof TOOL_TURN_ANSWERS } }} opts
 * toolTurn 打开后发送走真实的 commands 传输（POST …/commands 准入 + POST …/events 回 SSE），
 * 回的是一个带干活卡的工具回合（见 streamToolTurn）；不开时行为和原来完全一样（发送无人接）。
 * @returns {Promise<{ base: string, close: () => void, seen: Map<string, number>, setSignedOut: (v: boolean) => void }>}
 */
export async function startMockServer({
  dist,
  port = 0,
  latencyMs = 0,
  fixtures,
  toolTurn,
}) {
  const fxPath = fixtures || new URL("./fixtures/api.json", import.meta.url);
  const fx = JSON.parse(fs.readFileSync(fxPath, "utf8"));
  fx["^/api/conversations/threads/tc1/messages$"] = { messages: longThread() };
  const agents = Object.fromEntries(
    ["a1", "a2", "a3"].map((id) => [
      id,
      { name: id, description: "", className: "HttpAgent" },
    ]),
  );
  const user = {
    id: "u1",
    email: "perf@example.com",
    name: "Perf",
    image: null,
    role: "admin",
    profileNeedsSetup: false,
    onboarding: null,
  };
  const root = path.resolve(dist);
  const seen = new Map();
  const pendingRuns = new Map();
  const toolHoldMs =
    toolTurn && typeof toolTurn === "object" ? toolTurn.holdMs || 0 : 0;
  const toolAnswer =
    toolTurn && typeof toolTurn === "object"
      ? TOOL_TURN_ANSWERS[toolTurn.answer] || TOOL_TURN_ANSWER
      : TOOL_TURN_ANSWER;
  let signedOut = false;
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.startsWith("/api") || p.startsWith("/auth")) {
      const key = `${req.method} ${p}`;
      seen.set(key, (seen.get(key) || 0) + 1);
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () =>
        setTimeout(
          () => {
            const json = (code, v) => {
              res.writeHead(code, { "content-type": "application/json" });
              res.end(JSON.stringify(v));
            };
            if (p.startsWith("/auth")) return json(200, {});
            if (p === "/api/me")
              return signedOut
                ? json(401, { error: "unauthorized" })
                : json(200, { user });
            if (p === "/api/conversations/info")
              return json(200, {
                version: "1.77.0",
                agents,
                audioFileTranscriptionEnabled: false,
              });
            if (
              req.method === "POST" &&
              /\/api\/conversations\/agent\/[^/]+\/run$/.test(p)
            )
              return streamRun(res, body);
            if (/\/api\/conversations\/agent\/[^/]+\/connect$/.test(p)) {
              res.writeHead(200, { "content-type": "text/event-stream" });
              return res.end();
            }
            if (toolTurn) {
              const commandsPost =
                req.method === "POST" &&
                /^\/api\/conversations\/([^/]+)\/commands$/.exec(p);
              if (commandsPost) {
                let parsed = {};
                try {
                  parsed = JSON.parse(body);
                } catch {}
                const input = parsed.input ?? {};
                const lastUser = [...(input.messages ?? [])]
                  .reverse()
                  .find((msg) => msg.role === "user");
                if (!lastUser?.id)
                  return json(400, { error: "no user command" });
                const runId = input.runId || uid("r");
                pendingRuns.set(lastUser.id, {
                  threadId: commandsPost[1],
                  runId,
                });
                return json(200, { commandId: lastUser.id, runId });
              }
              if (
                req.method === "POST" &&
                /^\/api\/conversations\/[^/]+\/events$/.test(p)
              ) {
                let parsed = {};
                try {
                  parsed = JSON.parse(body);
                } catch {}
                const run = pendingRuns.get(parsed.commandId);
                pendingRuns.delete(parsed.commandId);
                if (!run) {
                  res.writeHead(200, { "content-type": "text/event-stream" });
                  return res.end();
                }
                return streamToolTurn(res, run, toolHoldMs, toolAnswer);
              }
              const commandsGet =
                req.method === "GET" &&
                /^\/api\/conversations\/[^/]+\/commands\/([^/]+)$/.exec(p);
              if (commandsGet) {
                const run = pendingRuns.get(commandsGet[1]);
                return run
                  ? json(200, { commandId: commandsGet[1], runId: run.runId })
                  : json(404, { error: "mock" });
              }
            }
            if (req.method !== "GET") return json(200, {});
            for (const [re, v] of Object.entries(fx))
              if (new RegExp(re).test(p)) return json(200, v);
            return json(404, { error: "mock" });
          },
          p.startsWith("/auth") ? 0 : latencyMs,
        ),
      );
      return;
    }
    if (toolTurn && p === "/_mock/img.svg") {
      res.writeHead(200, {
        "content-type": "image/svg+xml",
        "cache-control": "no-cache",
      });
      return res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="#dfe8f5"/><rect x="24" y="24" width="200" height="120" rx="10" fill="#9db8dd"/><circle cx="360" cy="120" r="60" fill="#8fce9d"/><text x="240" y="240" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#445566">mock park map 480×270</text></svg>',
      );
    }
    let f = path.join(root, p);
    if (
      !f.startsWith(root) ||
      !fs.existsSync(f) ||
      fs.statSync(f).isDirectory()
    )
      f = path.join(root, "index.html");
    res.writeHead(200, {
      "content-type": MIME[path.extname(f)] || "application/octet-stream",
    });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
    seen,
    setSignedOut: (v) => {
      signedOut = v;
    },
  };
}
