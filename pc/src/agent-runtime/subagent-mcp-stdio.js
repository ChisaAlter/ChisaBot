#!/usr/bin/env node
"use strict";
/**
 * ChisaBot 本地子代理互调桥（stdio MCP Server 兼 CLI 工具）。
 *
 * 1. MCP 模式（默认）：通过标准换行分隔 JSON-RPC 2.0 暴露工具：
 *    - subagent_list：查看当前可调用的子代理实例列表与擅长领域
 *    - subagent_run：调用指定子代理执行子任务（默认 mode="wait" 同步等待结果，或 mode="async" 后台派发）
 *    - subagent_status：查询子代理任务状态与输出摘要
 *    - subagent_stop：停止正在运行的子代理任务
 * 2. CLI 回退模式（传入 `--cli <list|run|status|stop> [json]`）：直接输出 JSON 到 stdout 并退出。
 */
const fs = require("node:fs");

function parseArgs(argv) {
  let bridgeFile = null;
  let cliAction = null;
  let cliPayload = "{}";
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bridge-file" && argv[i + 1]) {
      bridgeFile = argv[++i];
    } else if (arg === "--cli" && argv[i + 1]) {
      cliAction = argv[++i];
      if (argv[i + 1]) cliPayload = argv[++i];
    }
  }
  return { bridgeFile, cliAction, cliPayload };
}

function loadBridgeConfig(bridgeFile) {
  if (bridgeFile) {
    const raw = fs.readFileSync(bridgeFile, "utf8");
    const parsed = JSON.parse(raw);
    return { url: parsed.url, token: parsed.token };
  }
  return {
    url: process.env.CHISABOT_BRIDGE_URL || "",
    token: process.env.CHISABOT_BRIDGE_TOKEN || "",
  };
}

async function callBridge(config, action, params = {}) {
  if (!config.url || !config.token) {
    throw new Error("子代理桥接未配置（缺少 url 或 token）");
  }
  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ action, params }),
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `子代理调用失败（HTTP ${res.status}）`);
  }
  return body.data;
}

const MCP_TOOLS = [
  {
    name: "subagent_list",
    description: "列出当前可调用的其他智能体实例（含 slug、名称、宿主环境与擅长领域说明）。在拆分子任务前可先调用查看。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "subagent_run",
    description: "委派一个子任务给指定的智能体实例执行。mode='wait'（默认）会等待子代理完成并返回摘要与改动统计；mode='async' 立即返回 taskId 后台运行。",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "目标智能体实例的 slug 或 id（从 subagent_list 获取，例如 codex、claude、antigravity、codebuddy）。",
        },
        task: {
          type: "string",
          description: "要交给该子代理完成的完整任务说明（包含背景、目标文件与验收标准）。",
        },
        title: {
          type: "string",
          description: "简短中文任务标题（不超过 40 字）。",
        },
        mode: {
          type: "string",
          enum: ["wait", "async"],
          description: "wait（默认同步等待结果返回）或 async（异步后台运行）。",
        },
        cwd: {
          type: "string",
          description: "可选工作目录路径（留空默认沿用当前工作区）。",
        },
        profile: {
          type: "string",
          enum: ["readonly", "workspace", "full"],
          description: "可选权限档位（例如只做代码审查传 readonly）。",
        },
      },
      required: ["instance", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "subagent_status",
    description: "查询已启动的子代理任务状态、最近输出与结果摘要。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "子代理任务 ID。" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "subagent_stop",
    description: "停止一个正在运行的子代理任务。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "要停止的子代理任务 ID。" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

async function runCliMode(config, action, rawPayload) {
  let params = {};
  try {
    params = rawPayload ? JSON.parse(rawPayload) : {};
  } catch (err) {
    process.stderr.write(`JSON 参数解析失败: ${err.message}\n`);
    process.exit(1);
  }
  try {
    const data = await callBridge(config, action, params);
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

function startMcpServer(config) {
  function writeMsg(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    const { id, method, params } = msg;
    if (id === undefined) return; // notification (e.g. notifications/initialized)

    try {
      if (method === "initialize") {
        const clientProto = (params && params.protocolVersion) || "2024-11-05";
        writeMsg({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: clientProto,
            capabilities: { tools: {} },
            serverInfo: { name: "chisabot-subagents", version: "1.0.0" },
          },
        });
        return;
      }

      if (method === "ping") {
        writeMsg({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      if (method === "tools/list") {
        writeMsg({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
        return;
      }

      if (method === "tools/call") {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const actionMap = {
          subagent_list: "list",
          subagent_run: "run",
          subagent_status: "status",
          subagent_stop: "stop",
        };
        const action = actionMap[name];
        if (!action) {
          writeMsg({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `未知工具：${name}` }],
            },
          });
          return;
        }
        try {
          const data = await callBridge(config, action, args);
          writeMsg({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
            },
          });
        } catch (err) {
          writeMsg({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `子代理调用错误：${err.message}` }],
            },
          });
        }
        return;
      }

      writeMsg({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (err) {
      writeMsg({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err && err.message ? err.message : String(err) },
      });
    }
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
      buffer = buffer.slice(idx + 1);
      if (!line || line.startsWith("Content-Length:")) continue;
      try {
        const parsed = JSON.parse(line);
        void handleMessage(parsed);
      } catch {}
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

const parsedArgs = parseArgs(process.argv);
const bridgeConfig = loadBridgeConfig(parsedArgs.bridgeFile);
if (parsedArgs.cliAction) {
  void runCliMode(bridgeConfig, parsedArgs.cliAction, parsedArgs.cliPayload);
} else {
  startMcpServer(bridgeConfig);
}
