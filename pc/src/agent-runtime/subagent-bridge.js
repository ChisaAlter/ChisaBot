"use strict";
/**
 * 外部 Agent 嵌套互调本地桥。
 *
 * 为每一次允许嵌套互调的智能体运行启动一个绑定 127.0.0.1 随机端口、受一次性 Bearer 令牌保护的本地桥接服务，
 * 并生成：
 * - ACP 标准 mcpServers 描述
 * - Claude Code `--mcp-config` 临时文件
 * - Codex `-c mcp_servers.chisabot_subagents...` 配置项
 * - 通用 CLI / 自定义脚本环境变量（CHISABOT_SUBAGENT_CLI / CHISABOT_BRIDGE_URL）
 *
 * 递归深度由服务端与本桥双重校验（depth >= maxDepth 时不启动桥接，杜绝死循环）。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { which } = require("./detect");

const MCP_STDIO_SCRIPT = path.join(__dirname, "subagent-mcp-stdio.js");

function resolveJsRunner() {
  if (!process.versions || !process.versions.electron) {
    return { command: process.execPath, env: {} };
  }
  const nodeBin = which("node");
  if (nodeBin) {
    return { command: nodeBin, env: {} };
  }
  return {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * 创建一次任务级子代理互调桥。
 * @param {{
 *   taskId: string,
 *   depth?: number,
 *   maxDepth?: number,
 *   enabled?: boolean,
 *   onSubcall: (action: string, params: object) => Promise<unknown>
 * }} options
 */
async function createSubagentBridge(options) {
  const depth = Number(options.depth) || 0;
  const maxDepth = Number(options.maxDepth) || 3;
  if (options.enabled === false || depth >= maxDepth) {
    return null;
  }

  const token = crypto.randomBytes(24).toString("hex");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-subbridge-"));
  const runner = resolveJsRunner();

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || "";
    if (req.method !== "POST" || auth !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized subagent bridge request" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (body.length < 512_000) body += chunk;
    });
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
        return;
      }
      const action = String(parsed.action || "");
      const params = parsed.params && typeof parsed.params === "object" ? parsed.params : {};
      if (!["list", "run", "status", "stop"].includes(action)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `Unsupported action: ${action}` }));
        return;
      }
      try {
        const data = await options.onSubcall(action, params);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/subcall`;

  const bridgeFile = path.join(tempDir, "bridge.json");
  fs.writeFileSync(bridgeFile, JSON.stringify({ url, token, taskId: options.taskId, depth, maxDepth }), {
    encoding: "utf8",
    mode: 0o600,
  });

  // 若运行在 Electron app.asar 内，将 stdio 桥脚本提取到外部临时目录供外部 CLI 的 node 进程读取。
  let scriptPath = MCP_STDIO_SCRIPT;
  if (scriptPath.includes(".asar") && fs.existsSync(scriptPath)) {
    const extracted = path.join(tempDir, "subagent-mcp-stdio.js");
    fs.writeFileSync(extracted, fs.readFileSync(scriptPath, "utf8"), { encoding: "utf8", mode: 0o600 });
    scriptPath = extracted;
  }

  const scriptArgs = [scriptPath, "--bridge-file", bridgeFile];

  const claudeMcpConfigPath = path.join(tempDir, "claude-mcp.json");
  fs.writeFileSync(
    claudeMcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          chisabot_subagents: {
            command: runner.command,
            args: scriptArgs,
            env: {
              ...runner.env,
              CHISABOT_BRIDGE_URL: url,
              CHISABOT_BRIDGE_TOKEN: token,
            },
          },
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );

  const acpEnvList = [
    { name: "CHISABOT_BRIDGE_URL", value: url },
    { name: "CHISABOT_BRIDGE_TOKEN", value: token },
    ...Object.entries(runner.env).map(([name, value]) => ({ name, value: String(value) })),
  ];

  const acpMcpServers = [
    {
      name: "chisabot_subagents",
      command: runner.command,
      args: scriptArgs,
      env: acpEnvList,
    },
  ];

  // Codex 支持 `-c key=toml_value` 注入临时 MCP Server（如果 runner 需要 ELECTRON_RUN_AS_NODE 也一并写入 env 表）
  const codexConfigArgs = [
    "-c",
    `mcp_servers.chisabot_subagents.command=${tomlString(runner.command)}`,
    "-c",
    `mcp_servers.chisabot_subagents.args=[${scriptArgs.map(tomlString).join(", ")}]`,
  ];
  for (const [k, v] of Object.entries(runner.env)) {
    codexConfigArgs.push("-c", `mcp_servers.chisabot_subagents.env.${k}=${tomlString(v)}`);
  }

  const cliHint = `"${runner.command}" "${MCP_STDIO_SCRIPT}" --bridge-file "${bridgeFile}" --cli`;

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  return {
    url,
    token,
    depth,
    maxDepth,
    bridgeFile,
    claudeMcpConfigPath,
    acpMcpServers,
    codexConfigArgs,
    env: {
      CHISABOT_BRIDGE_URL: url,
      CHISABOT_BRIDGE_TOKEN: token,
      CHISABOT_SUBAGENT_CLI: cliHint,
      CHISABOT_SUBAGENT_DEPTH: String(depth),
    },
    close,
  };
}

module.exports = { createSubagentBridge, MCP_STDIO_SCRIPT };
