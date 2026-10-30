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

/**
 * @param {{ dist: string, port?: number, latencyMs?: number, fixtures?: string }} opts
 * @returns {Promise<{ base: string, close: () => void, seen: Map<string, number>, setSignedOut: (v: boolean) => void }>}
 */
export async function startMockServer({
  dist,
  port = 0,
  latencyMs = 0,
  fixtures,
}) {
  const fxPath = fixtures || new URL("./fixtures/api.json", import.meta.url);
  const fx = JSON.parse(fs.readFileSync(fxPath, "utf8"));
  fx["^/api/copilotkit/threads/tc1/messages$"] = { messages: longThread() };
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
            if (p === "/api/copilotkit/info")
              return json(200, {
                version: "1.77.0",
                agents,
                audioFileTranscriptionEnabled: false,
              });
            if (
              req.method === "POST" &&
              /\/api\/copilotkit\/agent\/[^/]+\/run$/.test(p)
            )
              return streamRun(res, body);
            if (/\/api\/copilotkit\/agent\/[^/]+\/connect$/.test(p)) {
              res.writeHead(200, { "content-type": "text/event-stream" });
              return res.end();
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
