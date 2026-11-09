import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DshHostClient } from "../src/client.mjs";

const target = process.env.CHISABOT_DSH_SSH_TARGET;
if (!target)
  throw new Error(
    "Set CHISABOT_DSH_SSH_TARGET to an existing approved SSH host.",
  );
function remote(input) {
  const child = spawn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      target,
      "docker exec -i chisabot-zh /command/s6-envdir /run/s6/container_environment bun /tmp/chisabot-dsh-model-check.ts",
    ],
    { windowsHide: true },
  );
  child.stdin.end(JSON.stringify(input));
  return child;
}
async function collect(input) {
  const child = remote(input);
  const output = [];
  let errors = "";
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(errors || "Application model bridge failed.");
  return JSON.parse(Buffer.concat(output).toString("utf8"));
}
const connection = await collect({ operation: "describe" });
const models = [];
const tools = [];
const proxy = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (request.url === "/execute") {
      if (body.name !== "get_current_date")
        throw new Error("Only the read-only current-date check is enabled.");
      tools.push({ name: body.name, runId: body.binding.runId });
      const result = await collect({ operation: "current-date" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    models.push(body.model);
    if (body.model === "forced-unavailable") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Controlled primary failure for migration verification.",
          },
        }),
      );
      return;
    }
    const child = remote({ operation: "request", body });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    child.stdout.pipe(response, { end: false });
    response.on("close", () => {
      if (child.exitCode === null) child.kill();
    });
    child.on("close", (code) => {
      if (code !== 0)
        response.destroy(new Error(errors || "Remote inference failed."));
      else response.end();
    });
  } catch (error) {
    response.writeHead(502);
    response.end(error.message);
  }
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const baseURL = `http://127.0.0.1:${proxy.address().port}`;
await mkdir(".runtime", { recursive: true });
const home = await mkdtemp(join(resolve(".runtime"), "live-"));
const selected = process.env.CHISABOT_DSH_LIVE_MODEL ?? connection.model;
await writeFile(
  join(home, "chisabot.json"),
  JSON.stringify({
    ownerUserId: "live-validation",
    port: 0,
    gatewayUrl: baseURL,
    gatewayTokenEnv: "CHISABOT_TEST_TOOL_TOKEN",
    providers: {
      configured: {
        api:
          connection.provider === "anthropic"
            ? "anthropic-messages"
            : "openai-completions",
        baseURL: `${baseURL}/v1`,
        apiKeyEnv: "CHISABOT_TEST_MODEL_KEY",
        timeoutMs: 90_000,
        models: [
          {
            id: "forced-unavailable",
            contextWindow: 32000,
            maxTokens: 1024,
            input: ["text"],
          },
          {
            id: selected,
            contextWindow: 32000,
            maxTokens: 1024,
            input: ["text"],
          },
        ],
      },
    },
  }),
);
let output = "";
const host = spawn(process.execPath, ["src/start.mjs"], {
  windowsHide: true,
  env: {
    ...process.env,
    CHISABOT_DSH_HOME: home,
    CHISABOT_TEST_MODEL_KEY: "local-bridge-only",
    CHISABOT_TEST_TOOL_TOKEN: "local-bridge-only",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
host.stdout.on("data", (chunk) => {
  output += chunk;
});
host.stderr.on("data", (chunk) => {
  output += chunk;
});
let client;
try {
  for (let i = 0; i < 200 && !output.includes("chisabot-runtime-ready"); i++) {
    if (host.exitCode !== null) throw new Error(output);
    await delay(100);
  }
  if (!output.includes("chisabot-runtime-ready"))
    throw new Error("Host startup did not complete.");
  client = await DshHostClient.connect(
    JSON.parse(await readFile(join(home, "connection.json"), "utf8")).endpoint,
  );
  await client.bind({
    sessionId: "live-check",
    runId: "live-check-run",
    threadId: "live-check-thread",
    botId: "live-check-bot",
    actorId: "live-validation",
    revision: 1,
    prompt:
      "这是隔离的只读集成验证。必须调用 get_current_date 一次，然后用一句中文报告日期。不执行其他操作。",
    model: {
      primary: {
        provider: "configured",
        model: "forced-unavailable",
        maxTokens: 1024,
      },
      fallbacks: [{ provider: "configured", model: selected, maxTokens: 1024 }],
    },
    tools: [
      {
        name: "get_current_date",
        description: "读取 ChisaBot 当前北京时间。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  });
  const frames = [];
  const abort = new AbortController();
  const observing = (async () => {
    try {
      for await (const frame of client.follow("live-check", abort.signal))
        frames.push(frame);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  await client.prompt({
    sessionId: "live-check",
    requestId: "live-check-input",
    mode: "queue",
    content: [{ type: "text", text: "请调用工具确认今天的日期。" }],
  });
  let result;
  for (let i = 0; i < 5; i++) {
    result = await client.wait("live-check", { timeoutMs: 30_000 });
    if (result.reason !== "timeout") break;
  }
  const history = await client.events("live-check");
  abort.abort();
  await observing;
  const answer = history.records
    .filter((x) => x.event.type === "assistant/message")
    .flatMap((x) => x.event.data.message.content)
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n");
  const report = {
    model: selected,
    reason: result.reason,
    toolCalls: tools.length,
    attemptedModels: models,
    liveFrames: frames.filter((x) =>
      JSON.stringify(x).includes("assistant-stream"),
    ).length,
    answer,
  };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(join(home, "result.json"), JSON.stringify(report, null, 2));
  if (
    result.reason !== "idle" ||
    tools.length !== 1 ||
    !answer ||
    !models.includes("forced-unavailable") ||
    !models.includes(selected)
  )
    process.exitCode = 1;
} finally {
  await client?.close();
  if (host.exitCode === null) {
    const ended = once(host, "exit");
    host.kill();
    await ended;
  }
  proxy.closeAllConnections();
  proxy.close();
}
