// 把 Hermes 或 DeepSeek Harness（DSH）的 agent 内核接到 ChisaBot 的 AG-UI 远程 agent 接口上。
//
//   ChisaBot ── AG-UI (HTTP POST + SSE) ──> 本文件 ── ACP (stdio JSON-RPC) ──> `dsh acp` / `hermes acp`
//
// 为什么用 ACP（Agent Client Protocol）而不是某一个 SDK：
//   - DSH：`dsh --profile acp`（或 `dsh acp`）
//   - Hermes：`hermes acp` / `hermes-acp`
//   两个内核说的是同一套协议，ChisaBot 的 UI、渠道、历史都不用改；换内核只换一个环境变量。
//
// 它不等于「把 DSH 当工具调用」：每个 ChisaBot 会话对应一个 ACP session，DSH/Hermes 自己的循环、
// 工具（shell / 文件 / 搜索 / MCP / 子 agent）就是机器人的手。ChisaBot 的插件工具不会自动出现
// 在这条链路里——那需要把 ChisaBot 工具暴露成 MCP，再用 `mcpServers` 传进 `session/new`。
//
// 安全边界（必读）：
//   - ACP 的 `session/request_permission` 默认由桥自动同意（allow_once），因为 ChisaBot 的
//     审批卡只覆盖它自己的工具，覆盖不到 ACP 内核的 shell / 文件操作。设 `ACP_APPROVAL=deny`
//     可以一律拒绝；真正要给人看的审批卡，需要把 ACP permission 请求映射成 AG-UI 事件（下一步）。
//   - 默认只监听 127.0.0.1。要放到网络上，前面必须有一层鉴权。
//
// 运行（在 ChisaBot 仓库根目录）：
//   ACP_AGENT_CMD="dsh acp"     ACP_CWD=/workspace bun examples/acp-agent/bridge.mjs
//   ACP_AGENT_CMD="hermes acp"  ACP_CWD=/workspace bun examples/acp-agent/bridge.mjs
//
// 依赖：Bun（HTTP/SSE）+ 一个装好的 `dsh` 或 `hermes`。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const DEFAULTS = {
  host: process.env.ACP_BRIDGE_HOST || "127.0.0.1",
  port: Number(process.env.ACP_BRIDGE_PORT || 4100),
  /** 字符串（支持引号）或数组：`dsh acp` / `["C:\\path with space\\node.exe", "bin.js", "acp"]`。 */
  command: process.env.ACP_AGENT_CMD || "dsh acp",
  cwd: process.env.ACP_CWD || process.cwd(),
  /** allow（默认，自动 allow_once）| deny（一律拒绝）。 */
  approval: (process.env.ACP_APPROVAL || "allow").toLowerCase(),
  /** ACP 的 prompt 轮次超时；到点发 session/cancel 并报 RUN_ERROR。 */
  turnTimeoutMs: Number(process.env.ACP_TURN_TIMEOUT_MS || 15 * 60 * 1000),
  initTimeoutMs: Number(process.env.ACP_INIT_TIMEOUT_MS || 30_000),
  /** 可选：设置后 /ag-ui 要求 `Authorization: Bearer <token>`。 */
  token: process.env.ACP_BRIDGE_TOKEN || "",
};

/** 按空白拆命令，但保留引号里的空格（Windows 路径常见）。不是完整 shell。 */
function splitCommand(text) {
  const parts = [];
  let current = "";
  let quote = null;
  for (const character of String(text)) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** 新行分隔的 JSON-RPC 2.0，跑在子进程 stdio 上；ACP 的传输格式。 */
class AcpClient {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.requestHandlers = new Set();
    this.exited = false;
    this.exitReason = null;
  }

  start() {
    if (this.child) return;
    const [bin, ...args] = Array.isArray(this.options.command)
      ? this.options.command
      : splitCommand(this.options.command);
    this.child = spawn(bin, args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    createInterface({ input: this.child.stdout }).on("line", (line) => this.#onLine(line));
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[acp] ${chunk}`));
    this.child.on("error", (error) => this.#failAll(error));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitReason = `agent exited (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`;
      this.#failAll(new Error(this.exitReason));
    });
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      // Agent → client request（例如 session/request_permission）。
      void this.#answerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || "JSON-RPC error");
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.notificationListeners) listener(message);
    }
  }

  async #answerRequest(message) {
    for (const handler of this.requestHandlers) {
      try {
        const handled = await handler(message);
        if (handled === true) return;
      } catch (error) {
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
        return;
      }
    }
    this.#write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `unsupported client method ${message.method}` },
    });
  }

  #failAll(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #write(message) {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {}
  }

  request(method, params, timeoutMs = 60_000) {
    this.start();
    if (this.exited) return Promise.reject(new Error(this.exitReason || "agent is not running"));
    const id = ++this.seq;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** 回复一个 agent → client 的请求（ACP 的 session/request_permission 等）。 */
  respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(handler) {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  async close() {
    if (!this.child || this.exited) return;
    const child = this.child;
    try {
      child.stdin.end();
    } catch {}
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        resolvePromise();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** ACP 的 ContentBlock / ToolCallContent → 一段文字。 */
function blockText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).join("\n");
  if (typeof content !== "object") return String(content);
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "content") return blockText(content.content);
  if (content.type === "diff") {
    const path = content.path ? ` ${content.path}` : "";
    return `[diff${path}]${content.newText ? `\n${content.newText}` : ""}`;
  }
  return "";
}

/** 从 RunAgentInput 里取这一轮最后一条用户文字；ACP session 自己保存历史。 */
function lastUserText(input) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
    }
    return "";
  }
  return "";
}

export function createAcpBridge(overrides = {}) {
  const options = { ...DEFAULTS, ...overrides };
  const client = new AcpClient(options);
  let initialized = null;
  /** threadId → ACP sessionId */
  const sessions = new Map();
  const sessionQueues = new Map();

  const ensureInitialized = async () => {
    if (initialized) return initialized;
    initialized = (async () => {
      client.start();
      await client.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "chisabot-acp-bridge", version: "0.1.0" },
        },
        options.initTimeoutMs,
      );
    })().catch((error) => {
      initialized = null;
      throw error;
    });
    return initialized;
  };

  const ensureSession = async (threadId) => {
    const existing = sessions.get(threadId);
    if (existing) return existing;
    const created = await client.request(
      "session/new",
      { cwd: resolve(options.cwd), mcpServers: [] },
      options.initTimeoutMs,
    );
    const sessionId = created?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("ACP session/new did not return a sessionId");
    }
    sessions.set(threadId, sessionId);
    return sessionId;
  };

  const serialize = (key, task) => {
    const previous = sessionQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    sessionQueues.set(
      key,
      next.finally(() => {
        if (sessionQueues.get(key) === next) sessionQueues.delete(key);
      }),
    );
    return next;
  };

  const run = (input, requestSignal) => {
    const threadId = typeof input?.threadId === "string" ? input.threadId : "thread";
    const runId = typeof input?.runId === "string" ? input.runId : randomUUID();
    const text = lastUserText(input);

    let closed = false;
    let controllerRef = null;
    let currentSessionId = null;
    const send = (event) => {
      if (closed || !controllerRef) return;
      try {
        controllerRef.enqueue(sse(event));
      } catch {
        closed = true;
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        controllerRef = controller;
        const finish = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {}
        };
        if (!text.trim()) {
          send({ type: "RUN_ERROR", message: "这一轮没有可发给 ACP agent 的文字。" });
          finish();
          return;
        }
        send({ type: "RUN_STARTED", threadId, runId });

        void (async () => {
          await ensureInitialized();
          const sessionId = await ensureSession(threadId);
          currentSessionId = sessionId;
          await serialize(sessionId, async () => {
            await new Promise((resolveTurn) => {
              let textMessageId = null;
              let reasoningMessageId = null;
              let settled = false;
              let timer = null;
              const completedTools = new Set();
              const toolResult = (toolCallId, update) => {
                if (completedTools.has(toolCallId)) return;
                completedTools.add(toolCallId);
                send({
                  type: "TOOL_CALL_RESULT",
                  messageId: `tool-result-${toolCallId}`,
                  toolCallId,
                  content: blockText(update.content) || JSON.stringify(update.rawOutput ?? ""),
                  role: "tool",
                });
              };

              const closeText = () => {
                if (!textMessageId) return;
                send({ type: "TEXT_MESSAGE_END", messageId: textMessageId });
                textMessageId = null;
              };
              const closeReasoning = () => {
                if (!reasoningMessageId) return;
                send({ type: "REASONING_MESSAGE_END", messageId: reasoningMessageId });
                send({ type: "REASONING_END", messageId: reasoningMessageId });
                reasoningMessageId = null;
              };
              const settle = (error, finished = true) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (requestSignal) requestSignal.removeEventListener("abort", cancelOnAbort);
                offNotification();
                offRequest();
                closeText();
                closeReasoning();
                if (error) {
                  send({ type: "RUN_ERROR", message: error });
                } else if (finished) {
                  send({ type: "RUN_FINISHED", threadId, runId });
                }
                finish();
                resolveTurn();
              };

              const offNotification = client.onNotification((message) => {
                if (message.method !== "session/update") return;
                const params = message.params || {};
                if (params.sessionId !== sessionId) return;
                const update = params.update || {};
                switch (update.sessionUpdate) {
                  case "agent_message_chunk": {
                    const textChunk = blockText(update.content);
                    if (!textChunk) break;
                    closeReasoning();
                    if (!textMessageId) {
                      textMessageId = `msg-${randomUUID()}`;
                      send({ type: "TEXT_MESSAGE_START", messageId: textMessageId, role: "assistant" });
                    }
                    send({ type: "TEXT_MESSAGE_CONTENT", messageId: textMessageId, delta: textChunk });
                    break;
                  }
                  case "agent_thought_chunk": {
                    const thought = blockText(update.content);
                    if (!thought) break;
                    closeText();
                    if (!reasoningMessageId) {
                      reasoningMessageId = `reasoning-${randomUUID()}`;
                      send({ type: "REASONING_START", messageId: reasoningMessageId });
                      send({ type: "REASONING_MESSAGE_START", messageId: reasoningMessageId, role: "reasoning" });
                    }
                    send({ type: "REASONING_MESSAGE_CONTENT", messageId: reasoningMessageId, delta: thought });
                    break;
                  }
                  case "tool_call": {
                    closeText();
                    closeReasoning();
                    const toolCallId = String(update.toolCallId || `call-${randomUUID()}`);
                    send({
                      type: "TOOL_CALL_START",
                      toolCallId,
                      toolCallName: String(update.name || update.kind || "tool"),
                    });
                    send({
                      type: "TOOL_CALL_ARGS",
                      toolCallId,
                      delta: JSON.stringify(update.rawInput ?? {}),
                    });
                    send({ type: "TOOL_CALL_END", toolCallId });
                    // A tool call may already be finished in the same update (fast tools).
                    if (update.status === "completed" || update.status === "failed") {
                      toolResult(toolCallId, update);
                    }
                    break;
                  }
                  case "tool_call_update": {
                    const toolCallId = String(update.toolCallId || "tool");
                    if (update.status === "completed" || update.status === "failed") {
                      toolResult(toolCallId, update);
                    } else if (update.rawInput) {
                      send({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(update.rawInput) });
                    }
                    break;
                  }
                  default:
                    break;
                }
              });

              const offRequest = client.onRequest(async (message) => {
                if (message.method !== "session/request_permission") return false;
                const params = message.params || {};
                if (params.sessionId && params.sessionId !== sessionId) return false;
                const optionsList = Array.isArray(params.options) ? params.options : [];
                const allowOnce = optionsList.find((option) => option?.kind === "allow_once");
                const allow = optionsList.find((option) => String(option?.kind || "").startsWith("allow"));
                const selected = options.approval === "deny" ? null : allowOnce || allow || optionsList[0];
                client.respond(
                  message.id,
                  selected
                    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
                    : { outcome: { outcome: "cancelled" } },
                );
                return true;
              });

              const cancelOnAbort = () => {
                client.notify("session/cancel", { sessionId });
                settle("用户停止了这一轮");
              };
              if (requestSignal) {
                if (requestSignal.aborted) cancelOnAbort();
                else requestSignal.addEventListener("abort", cancelOnAbort, { once: true });
              }

              timer = setTimeout(() => {
                client.notify("session/cancel", { sessionId });
                settle(`ACP 这一轮超过 ${Math.round(options.turnTimeoutMs / 1000)} 秒没有结束`);
              }, options.turnTimeoutMs);

              client
                .request("session/prompt", {
                  sessionId,
                  prompt: [{ type: "text", text }],
                })
                .then((result) => {
                  const stopReason = result?.stopReason;
                  if (stopReason === "refusal") {
                    settle("agent 拒绝了这一轮");
                  } else if (stopReason === "max_tokens") {
                    settle("agent 达到了这一轮的最大 token 数", true);
                  } else if (stopReason === "max_turn_requests") {
                    settle("agent 达到了这一轮的最大请求数", true);
                  } else {
                    settle(undefined, true);
                  }
                })
                .catch((error) => settle(error instanceof Error ? error.message : String(error)));
            });
          });
        })().catch((error) => {
          send({ type: "RUN_ERROR", message: error instanceof Error ? error.message : String(error) });
          finish();
        });
      },
      cancel() {
        closed = true;
        if (currentSessionId) client.notify("session/cancel", { sessionId: currentSessionId });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  };

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({
          ok: !client.exited,
          initialized: Boolean(initialized),
          sessions: sessions.size,
          command: Array.isArray(options.command) ? options.command.join(" ") : options.command,
        });
      }
      if (url.pathname !== "/ag-ui") return new Response("not found", { status: 404 });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (options.token && request.headers.get("authorization") !== `Bearer ${options.token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      let input;
      try {
        input = await request.json();
      } catch {
        return new Response("invalid JSON", { status: 400 });
      }
      return run(input, request.signal);
    },
  });

  return {
    server,
    close: async () => {
      server.stop(true);
      await client.close();
    },
  };
}

if (import.meta.main) {
  const bridge = createAcpBridge();
  console.log(
    `ACP bridge listening on http://${bridge.server.hostname}:${bridge.server.port}/ag-ui (agent: ${DEFAULTS.command})`,
  );
  if (DEFAULTS.approval !== "deny") {
    console.warn("ACP approval is ALLOW: the agent may run shell / file tools without asking ChisaBot. Set ACP_APPROVAL=deny to refuse.");
  }
  const stop = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
