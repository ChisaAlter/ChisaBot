// AG-UI HTTP/SSE -> ACP stdio. The Hermes adapter owns the model loop and executes host tools.
// Host identity and gateway capabilities travel only in params._meta.chisabot, never in prompts.
// ACP_REQUIRE_HOST_CONTEXT=1 requires trusted host metadata and a durable ACP_STATE_PATH ledger.
// Run locally with a configured ACP_AGENT_CMD; the tests use only fake-acp.mjs.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const DEFAULTS = {
  host: process.env.ACP_BRIDGE_HOST || "127.0.0.1",
  port: Number(process.env.ACP_BRIDGE_PORT || 4100),
  command: process.env.ACP_AGENT_CMD || "dsh acp",
  cwd: process.env.ACP_CWD || process.cwd(),
  approval: (process.env.ACP_APPROVAL || "allow").toLowerCase(),
  turnTimeoutMs: Number(process.env.ACP_TURN_TIMEOUT_MS || 15 * 60 * 1000),
  initTimeoutMs: Number(process.env.ACP_INIT_TIMEOUT_MS || 30_000),
  cancelGraceMs: Number(process.env.ACP_CANCEL_GRACE_MS || 2_000),
  requireHostContext: process.env.ACP_REQUIRE_HOST_CONTEXT === "1",
  statePath: process.env.ACP_STATE_PATH || "",
  token: process.env.ACP_BRIDGE_TOKEN || "",
};

function splitCommand(text) {
  const parts = [];
  let current = "";
  let quote = null;
  for (const character of String(text)) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (current) parts.push(current);
      current = "";
    } else current += character;
  }
  if (quote) throw new Error("ACP_AGENT_CMD has an unmatched quote");
  if (current) parts.push(current);
  if (!parts.length) throw new Error("ACP_AGENT_CMD is empty");
  return parts;
}

function rpcError(message, code = "ACP_ERROR") {
  return Object.assign(new Error(message), { code });
}

/** One child generation. A retired child can never become healthy or deliver events again. */
class AcpClient {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.requestHandlers = new Set();
    this.failed = false;
    this.healthy = false;
    this.initialized = false;
    this.failure = null;
  }

  start() {
    if (this.child || this.failed) return;
    try {
      const [bin, ...args] = Array.isArray(this.options.command)
        ? this.options.command
        : splitCommand(this.options.command);
      if (typeof bin !== "string" || !bin) throw new Error("empty executable");
      const child = spawn(bin, args, {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          HERMES_DISABLE_LAZY_INSTALLS: process.env.HERMES_DISABLE_LAZY_INSTALLS ?? "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.stdout.setEncoding("utf8");
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
      // Agent stderr may contain request payloads. Drain it without forwarding credentials to logs.
      child.stderr.resume();
      child.stdin.on("error", () => this.fail(rpcError("ACP agent stdin closed", "ACP_PROCESS_EXIT")));
      child.on("error", (error) => this.fail(rpcError(`ACP agent spawn failed (${error.code || "error"})`, "ACP_SPAWN_ERROR")));
      child.on("exit", (code, signal) => {
        this.fail(rpcError(`ACP agent exited (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`, "ACP_PROCESS_EXIT"));
      });
    } catch {
      this.fail(rpcError("ACP agent could not be spawned", "ACP_SPAWN_ERROR"));
    }
  }

  onLine(line) {
    if (this.failed) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && typeof message.method === "string") {
      void this.answerRequest(message);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(rpcError(message.error.message || "ACP JSON-RPC error", "ACP_RPC_ERROR"));
      else pending.resolve(message.result);
    } else if (typeof message.method === "string") {
      for (const listener of this.notificationListeners) listener(message);
    }
  }

  async answerRequest(message) {
    for (const handler of this.requestHandlers) {
      try {
        if (await handler(message)) return;
      } catch {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "ACP client request failed" } });
        return;
      }
    }
    this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported ACP client method" } });
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.healthy = false;
    this.initialized = false;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  write(message) {
    if (this.failed || !this.child) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      this.fail(rpcError("ACP agent stdin closed", "ACP_PROCESS_EXIT"));
      return false;
    }
  }

  // A turn timeout starts cancellation but leaves the RPC pending until its response or retirement.
  // Releasing it at the deadline would let the next turn observe updates from the previous one.
  request(method, params, timeoutMs, onTimeout) {
    this.start();
    if (this.failed) return Promise.reject(this.failure);
    const id = ++this.seq;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (onTimeout) {
          onTimeout();
          return;
        }
        this.pending.delete(id);
        reject(rpcError(`ACP ${method} timed out`, "ACP_RPC_TIMEOUT"));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) { this.write({ jsonrpc: "2.0", method, params }); }
  respond(id, result) { this.write({ jsonrpc: "2.0", id, result }); }
  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }
  onRequest(handler) {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  retire(reason = "ACP process generation retired") {
    this.fail(rpcError(reason, "ACP_GENERATION_RETIRED"));
    try { this.child?.kill("SIGKILL"); } catch {}
  }

  async close() {
    const child = this.child;
    this.retire("ACP bridge closed");
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 500);
      child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
    });
  }
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item) ?? "null").join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
const digest = (value) => createHash("sha256").update(stableJson(value)).digest("hex");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

function redact(value, secrets = []) {
  if (typeof value === "string") {
    for (const secret of secrets) if (secret) value = value.split(secret).join("[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /^(capability|authorization|token|access_?token|api_?key|password)$/i.test(key) ? "[REDACTED]" : redact(item, secrets),
  ]));
  return value;
}

function blockText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join("\n");
  if (typeof content !== "object") return String(content);
  if (content.type === "text") return typeof content.text === "string" ? content.text : "";
  if (content.type === "content") return blockText(content.content);
  if (content.type === "diff") return `[diff${content.path ? ` ${content.path}` : ""}]${content.newText ? `\n${content.newText}` : ""}`;
  return "";
}

/** Keep OpenAI multimodal parts, and translate AG-UI binary image parts without discarding them. */
function openAIContent(content) {
  if (!Array.isArray(content)) return content === undefined ? "" : content;
  return content.map((part) => {
    if (part?.type === "binary" && String(part.mimeType || "").startsWith("image/")) {
      const url = part.url || (part.data ? `data:${part.mimeType};base64,${part.data}` : null);
      if (url) return { type: "image_url", image_url: { url } };
    }
    return part;
  });
}

function openAIMessage(message) {
  const result = { role: message.role, content: openAIContent(message.content) };
  if (nonempty(message.name)) result.name = message.name;
  if (message.role === "assistant") {
    const calls = message.tool_calls ?? message.toolCalls;
    if (Array.isArray(calls) && calls.length) {
      result.tool_calls = calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function?.name ?? call.name,
          arguments: typeof (call.function?.arguments ?? call.args) === "string"
            ? (call.function?.arguments ?? call.args)
            : JSON.stringify(call.function?.arguments ?? call.args ?? {}),
        },
      }));
    }
    for (const key of ["reasoning_content", "reasoning", "refusal"]) {
      if (own(message, key)) result[key] = message[key];
    }
  }
  if (message.role === "tool") {
    const callId = message.tool_call_id ?? message.toolCallId;
    if (!nonempty(callId)) throw rpcError("Tool history is missing tool_call_id", "ACP_INVALID_HISTORY");
    result.tool_call_id = callId;
  }
  return result;
}

function promptBlocks(message) {
  if (typeof message.content === "string") return message.content.trim() ? [{ type: "text", text: message.content }] : [];
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (part?.type === "text" && nonempty(part.text)) return [{ type: "text", text: part.text }];
    const url = part?.type === "image_url" ? part.image_url?.url : null;
    if (typeof url === "string") {
      const inline = /^data:(image\/[^;,]+);base64,([\s\S]+)$/.exec(url);
      // The adapter receives the original current message too; ACP image data is for compatible peers.
      if (inline) return [{ type: "image", mimeType: inline[1], data: inline[2] }];
      return [{ type: "resource_link", uri: url, name: "user image", mimeType: "image/*" }];
    }
    return [];
  });
}

function prepareInput(input, options) {
  const host = input?.forwardedProps?.chisabotHermes;
  let context = null;
  if (host !== undefined) {
    if (!isObject(host) || host.version !== 1 || !isObject(host.scope)
      || !["actorId", "botId", "threadId", "runId"].every((key) => nonempty(host.scope[key]))
      || !isObject(host.toolGateway) || !nonempty(host.toolGateway.url) || !nonempty(host.toolGateway.capability)
      || !isObject(host.model) || !nonempty(host.model.id)) {
      throw rpcError("Invalid chisabotHermes host context", "ACP_INVALID_HOST_CONTEXT");
    }
    if (input.threadId !== host.scope.threadId || input.runId !== host.scope.runId) {
      throw rpcError("Host scope does not match AG-UI threadId/runId", "ACP_INVALID_HOST_CONTEXT");
    }
    let gateway;
    try { gateway = new URL(host.toolGateway.url); } catch {}
    if (!gateway || !["http:", "https:"].includes(gateway.protocol) || gateway.username || gateway.password
      || gateway.search || gateway.hash || /\s/.test(host.toolGateway.url)
      || !/^[\x21-\x7e]+$/.test(host.toolGateway.capability)) {
      throw rpcError("Invalid host tool gateway URL or capability", "ACP_INVALID_HOST_CONTEXT");
    }
    context = {
      version: 1,
      scope: Object.fromEntries(["actorId", "botId", "threadId", "runId"].map((key) => [key, host.scope[key]])),
      toolGateway: { url: host.toolGateway.url, capability: host.toolGateway.capability },
      model: { id: host.model.id },
    };
  }
  if (options.requireHostContext && !context) throw rpcError("Trusted chisabotHermes host context is required", "ACP_HOST_CONTEXT_REQUIRED");
  if (options.requireHostContext && !options.statePath) throw rpcError("ACP_STATE_PATH is required for safe Hermes run recovery", "ACP_STATE_REQUIRED");
  if (!context && Array.isArray(input?.tools) && input.tools.length) {
    throw rpcError("Host tools require chisabotHermes context and a host-tools ACP adapter", "ACP_HOST_CONTEXT_REQUIRED");
  }
  const threadId = context?.scope.threadId ?? (nonempty(input?.threadId) ? input.threadId : "thread");
  const runId = context?.scope.runId ?? (nonempty(input?.runId) ? input.runId : randomUUID());
  const rawMessages = Array.isArray(input?.messages) ? input.messages : [];
  const systems = rawMessages.filter((message) => message?.role === "system" || message?.role === "developer");
  const systemPrompt = [typeof input?.system === "string" ? input.system : "", ...systems.map((message) => blockText(message.content))]
    .filter((text) => text.trim()).join("\n\n");
  const messages = rawMessages.filter((message) => ["user", "assistant", "tool"].includes(message?.role));
  const normalized = messages.map(openAIMessage);
  const last = normalized.at(-1);
  const continuation = context && last?.role === "tool";
  if (!last || (!continuation && last.role !== "user")) {
    throw rpcError("This turn has no new user message or tool-result continuation", "ACP_EMPTY_PROMPT");
  }
  const prompt = continuation
    ? [{ type: "text", text: "Continue the assistant turn using the authoritative host history and the tool results provided in metadata." }]
    : promptBlocks(last);
  if (!prompt.length) throw rpcError("This turn has no supported user content", "ACP_EMPTY_PROMPT");
  const tools = (Array.isArray(input?.tools) ? input.tools : []).map((tool) => {
    if (!nonempty(tool?.name)) throw rpcError("A host tool has no name", "ACP_INVALID_TOOLS");
    const inputSchema = tool.inputSchema ?? tool.parameters ?? { type: "object", properties: {} };
    if (!isObject(inputSchema)) throw rpcError("A host tool has an invalid input schema", "ACP_INVALID_TOOLS");
    return { name: tool.name, description: typeof tool.description === "string" ? tool.description : "", inputSchema };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw rpcError("Duplicate host tool names", "ACP_INVALID_TOOLS");
  if (context && stableJson([systemPrompt, normalized, tools, context.model]).includes(context.toolGateway.capability)) {
    throw rpcError("Host capability must not occur in model-visible content", "ACP_INVALID_HOST_CONTEXT");
  }
  const namespace = digest(context ? ["host", context.scope.actorId, context.scope.botId, threadId] : ["generic", threadId]);
  // Hash non-system rows separately: regenerated system memory must not invalidate a history extension.
  const rowHashes = normalized.map((message, index) => digest({ ...message, id: messages[index].id }));
  const inputDigest = digest({ systemPrompt, messages: normalized, rowHashes, tools, model: context?.model ?? null });
  return {
    threadId, runId, namespace, key: digest([namespace, runId]), inputDigest, rowHashes,
    prompt, systemPrompt, context, tools,
    history: continuation ? normalized : normalized.slice(0, -1),
    currentMessage: continuation ? null : last,
    continuation: Boolean(continuation),
  };
}

export function createAcpBridge(overrides = {}) {
  const options = { ...DEFAULTS, ...overrides };
  for (const key of ["turnTimeoutMs", "initTimeoutMs", "cancelGraceMs"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  const runs = new Map();
  const sessionQueues = new Map();
  const generations = new Set();
  const activeTurns = new Set();
  let generationSeq = 0;
  let generation = null;
  let closing = false;
  let stateHealthy = true;
  const statePath = options.statePath ? resolve(options.statePath) : "";
  if (statePath && existsSync(statePath)) {
    let saved;
    try { saved = JSON.parse(readFileSync(statePath, "utf8")); } catch { throw new Error("ACP state ledger is unreadable; refusing unsafe recovery"); }
    if (saved?.version !== 1 || !Array.isArray(saved.runs)) throw new Error("ACP state ledger has an unsupported format");
    for (const item of saved.runs) {
      if (!nonempty(item.key) || !nonempty(item.digest) || !Array.isArray(item.rowHashes) || !Array.isArray(item.events)
        || !["started", "completed", "unknown"].includes(item.status)) throw new Error("ACP state ledger has an invalid run record");
      const entry = {
        key: item.key, digest: item.digest, rowHashes: item.rowHashes,
        status: item.status === "completed" ? "completed" : "unknown",
        events: item.events, done: true, subscribers: new Set(), secrets: [], started: true,
      };
      if (!runs.has(item.key)) runs.set(item.key, []);
      runs.get(item.key).push(entry);
    }
  }

  const persist = () => {
    if (!statePath) return;
    const records = [...runs.values()].flat().filter((entry) => entry.started).map((entry) => ({
      key: entry.key, digest: entry.digest, rowHashes: entry.rowHashes,
      status: entry.status === "completed" ? "completed" : entry.status === "unknown" ? "unknown" : "started",
      events: redact(entry.events, entry.secrets),
    }));
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, runs: records }), { mode: 0o600 });
      renameSync(temporary, statePath);
    } catch {
      stateHealthy = false;
      throw rpcError("ACP state ledger could not be persisted; execution is blocked", "ACP_STATE_ERROR");
    }
  };

  const getGeneration = () => {
    if (closing) throw rpcError("ACP bridge is closed", "ACP_CLOSED");
    if (!generation || generation.client.failed) {
      const previous = generation;
      if (previous) void previous.client.close().finally(() => generations.delete(previous));
      generation = { id: ++generationSeq, client: new AcpClient(options), init: null, hostTools: false, sessions: new Map(), seeded: new Set() };
      generations.add(generation);
    }
    return generation;
  };

  const ensureInitialized = async (current) => {
    if (!current.init) {
      current.init = (async () => {
        const result = await current.client.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "chisabot-acp-bridge", version: "0.2.0" },
        }, options.initTimeoutMs);
        if (current.client.failed) throw current.client.failure;
        current.hostTools = result?._meta?.chisabotHostTools === 1;
        current.client.initialized = true;
        current.client.healthy = true;
      })().catch((error) => {
        current.client.retire("ACP initialization failed");
        throw error;
      });
    }
    await current.init;
  };

  const serialize = (key, task) => {
    const previous = sessionQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    sessionQueues.set(key, next);
    void next.finally(() => {
      if (sessionQueues.get(key) === next) sessionQueues.delete(key);
    }).catch(() => {});
    return next;
  };

  const emit = (entry, event) => {
    const safe = redact(event, entry.secrets);
    entry.events.push(safe);
    for (const subscriber of entry.subscribers) subscriber.send(safe);
  };

  const complete = (entry, terminal) => {
    if (entry.done) return;
    const safe = redact(terminal, entry.secrets);
    entry.events.push(safe);
    entry.status = "completed";
    try { persist(); } catch {
      entry.status = "unknown";
      entry.events[entry.events.length - 1] = { type: "RUN_ERROR", code: "ACP_STATE_ERROR", message: "ACP result could not be committed to the run ledger; do not retry this run" };
    }
    entry.done = true;
    for (const subscriber of entry.subscribers) {
      subscriber.send(entry.events.at(-1));
      subscriber.finish();
    }
    entry.subscribers.clear();
  };

  const execute = async (entry, prepared) => {
    if (entry.cancelReason) {
      complete(entry, { type: "RUN_ERROR", code: "ACP_CANCELLED", message: entry.cancelReason });
      return;
    }
    const active = {
      generation: null, sessionId: null, cancelReason: null, cancelCode: null, grace: null, cancelSent: false,
      cancel(reason, code = "ACP_CANCELLED") {
        if (this.cancelReason) return;
        this.cancelReason = reason;
        this.cancelCode = code;
        this.sendCancel();
        this.grace = setTimeout(() => this.generation?.client.retire("ACP cancellation grace expired"), options.cancelGraceMs);
      },
      sendCancel() {
        if (!this.cancelReason || this.cancelSent || !this.sessionId || !this.generation) return;
        this.cancelSent = true;
        this.generation.client.notify("session/cancel", { sessionId: this.sessionId });
      },
    };
    entry.active = active;
    activeTurns.add(active);
    const deadline = Date.now() + options.turnTimeoutMs;
    const timeout = () => active.cancel(`ACP turn timed out after ${options.turnTimeoutMs}ms`, "ACP_TURN_TIMEOUT");
    const timer = setTimeout(timeout, options.turnTimeoutMs);
    const remaining = () => Math.max(1, deadline - Date.now());
    let offNotification = () => {};
    let offRequest = () => {};
    let textMessageId = null;
    let reasoningMessageId = null;
    let waiting = null;
    let waitingCallId = null;
    const toolCalls = new Map();
    const closeText = () => {
      if (textMessageId) emit(entry, { type: "TEXT_MESSAGE_END", messageId: textMessageId });
      textMessageId = null;
    };
    const closeReasoning = () => {
      if (reasoningMessageId) {
        emit(entry, { type: "REASONING_MESSAGE_END", messageId: reasoningMessageId });
        emit(entry, { type: "REASONING_END", messageId: reasoningMessageId });
      }
      reasoningMessageId = null;
    };
    const endTool = (tool) => {
      if (tool.ended) return;
      // rawInput updates are snapshots. Emit one complete JSON document immediately before END.
      emit(entry, { type: "TOOL_CALL_ARGS", toolCallId: tool.id, delta: JSON.stringify(tool.rawInput ?? {}) });
      emit(entry, { type: "TOOL_CALL_END", toolCallId: tool.id });
      tool.ended = true;
    };
    const closeMessages = () => {
      closeText();
      closeReasoning();
      for (const tool of toolCalls.values()) endTool(tool);
    };
    try {
      if (!stateHealthy) throw rpcError("ACP state ledger is unhealthy; execution is blocked", "ACP_STATE_ERROR");
      const current = getGeneration();
      active.generation = current;
      await ensureInitialized(current);
      if (active.cancelReason) throw rpcError(active.cancelReason, active.cancelCode);
      if (prepared.context && !current.hostTools) throw rpcError("ACP adapter did not advertise chisabotHostTools:1", "ACP_HOST_TOOLS_UNSUPPORTED");
      let session = current.sessions.get(prepared.namespace);
      if (!session) {
        session = current.client.request("session/new", {
          cwd: resolve(options.cwd), mcpServers: [],
          _meta: { chisabotNamespace: prepared.namespace },
        }, remaining(), timeout).then((created) => {
          if (!nonempty(created?.sessionId)) throw rpcError("ACP session/new did not return a sessionId", "ACP_INVALID_SESSION");
          return created.sessionId;
        });
        current.sessions.set(prepared.namespace, session);
      }
      active.sessionId = await session;
      active.sendCancel();
      if (active.cancelReason) throw rpcError(active.cancelReason, active.cancelCode);
      const sessionId = active.sessionId;
      offNotification = current.client.onNotification((message) => {
        if (active.cancelReason || current.client.failed || message.method !== "session/update" || message.params?.sessionId !== sessionId) return;
        const update = message.params.update ?? {};
        const metadata = update._meta?.chisabot;
        if (isObject(metadata?.waiting)) {
          waiting = metadata.waiting;
          waitingCallId = metadata.callId ?? update.toolCallId ?? waitingCallId;
        }
        if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
          const text = blockText(update.content);
          if (!text) return;
          if (update.sessionUpdate === "agent_message_chunk") {
            closeReasoning();
            if (!textMessageId) {
              textMessageId = `msg-${randomUUID()}`;
              emit(entry, { type: "TEXT_MESSAGE_START", messageId: textMessageId, role: "assistant" });
            }
            emit(entry, { type: "TEXT_MESSAGE_CONTENT", messageId: textMessageId, delta: text });
          } else {
            closeText();
            if (!reasoningMessageId) {
              reasoningMessageId = `reasoning-${randomUUID()}`;
              emit(entry, { type: "REASONING_START", messageId: reasoningMessageId });
              emit(entry, { type: "REASONING_MESSAGE_START", messageId: reasoningMessageId, role: "reasoning" });
            }
            emit(entry, { type: "REASONING_MESSAGE_CONTENT", messageId: reasoningMessageId, delta: text });
          }
          return;
        }
        if (!["tool_call", "tool_call_update"].includes(update.sessionUpdate)) return;
        closeText();
        closeReasoning();
        if (!nonempty(update.toolCallId)) {
          active.cancel("ACP tool update is missing its real toolCallId", "ACP_INVALID_TOOL_CALL");
          return;
        }
        let tool = toolCalls.get(update.toolCallId);
        if (!tool) {
          tool = {
            id: update.toolCallId, rawInput: {}, ended: false, result: false,
            name: update._meta?.name || update.name || metadata?.name || update.title || update.kind || "tool",
          };
          toolCalls.set(tool.id, tool);
          emit(entry, { type: "TOOL_CALL_START", toolCallId: tool.id, toolCallName: String(tool.name) });
        }
        const hasInput = update.rawInput !== null && update.rawInput !== undefined;
        if (hasInput) {
          if (tool.ended && stableJson(update.rawInput) !== stableJson(tool.rawInput)) {
            active.cancel("ACP tool input changed after its complete arguments were published", "ACP_TOOL_INPUT_CONFLICT");
            return;
          }
          if (!tool.ended) tool.rawInput = update.rawInput;
        }
        // Host callbacks wait for the canonical call to be captured before execution. The adapter
        // marks its provider arguments complete, so publish them before its separate HTTP request.
        if (prepared.context && update.sessionUpdate === "tool_call" && metadata?.inputComplete === true) {
          if (metadata.version !== 1 || metadata.callId !== tool.id || metadata.name !== tool.name || !hasInput) {
            active.cancel("ACP host tool start has invalid complete-input metadata", "ACP_INVALID_TOOL_CALL");
            return;
          }
          endTool(tool);
        }
        if (update.status === "completed" || update.status === "failed" || metadata?.waiting) {
          endTool(tool);
          const hasOutput = update.rawOutput !== null && update.rawOutput !== undefined;
          const hasContent = typeof update.content === "string"
            || (Array.isArray(update.content) && update.content.length > 0);
          if (!tool.result && !metadata?.waiting && (hasOutput || hasContent)) {
            tool.result = true;
            const content = hasOutput
              ? typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput)
              : blockText(update.content) || (typeof update.content === "string" ? update.content : JSON.stringify(update.content));
            emit(entry, { type: "TOOL_CALL_RESULT", messageId: `tool-result-${tool.id}`, toolCallId: tool.id, content: content ?? "", role: "tool" });
          }
        }
      });
      offRequest = current.client.onRequest((message) => {
        if (message.method !== "session/request_permission" || message.params?.sessionId !== sessionId) return false;
        const list = Array.isArray(message.params.options) ? message.params.options : [];
        const selected = options.approval === "deny" || active.cancelReason ? null
          : list.find((option) => option?.kind === "allow_once") ?? list.find((option) => String(option?.kind || "").startsWith("allow"));
        current.client.respond(message.id, selected
          ? { outcome: { outcome: "selected", optionId: selected.optionId } }
          : { outcome: { outcome: "cancelled" } });
        return true;
      });
      const prompt = [...prepared.prompt];
      const params = { sessionId, prompt };
      if (prepared.context) {
        params._meta = { chisabot: {
          ...prepared.context, systemPrompt: prepared.systemPrompt, history: prepared.history, tools: prepared.tools,
          ...(prepared.continuation ? { continuation: true } : {}),
          // ACP content cannot represent every OpenAI image URL. This is the same current user row,
          // not history; the adapter can retain the exact multimodal content when constructing input.
          ...(prepared.currentMessage ? { currentMessage: prepared.currentMessage } : {}),
        } };
      } else if (prepared.systemPrompt && !current.seeded.has(sessionId)) {
        prompt.unshift({ type: "text", text: `【宿主设定】\n${prepared.systemPrompt}` });
        current.seeded.add(sessionId);
      }
      // Commit before issuing the write-capable RPC. On restart an unfinished record is unknown.
      entry.started = true;
      entry.status = "started";
      persist();
      if (active.cancelReason) throw rpcError(active.cancelReason, active.cancelCode);
      const result = await current.client.request("session/prompt", params, remaining(), timeout);
      if (active.cancelReason) throw rpcError(active.cancelReason, active.cancelCode);
      const resultMetadata = result?._meta?.chisabot;
      if (isObject(resultMetadata?.waiting)) {
        waiting = resultMetadata.waiting;
        waitingCallId = resultMetadata.callId ?? waitingCallId;
      }
      closeMessages();
      const waitingId = waiting?.toolCallId ?? waitingCallId ?? waiting?.requestId ?? `waiting-${prepared.runId}`;
      const unresolved = [...toolCalls.values()].filter((tool) => !tool.result && (!waiting || tool.id !== waitingId));
      if (unresolved.length) throw rpcError(`ACP finished without tool results: ${unresolved.map((tool) => tool.id).join(", ")}`, "ACP_MISSING_TOOL_RESULT");
      if (waiting) {
        const safeWaiting = { ...waiting, toolCallId: waitingId };
        emit(entry, { type: "CUSTOM", name: "openbot.headless.waiting", value: safeWaiting });
        complete(entry, {
          type: "RUN_FINISHED", threadId: prepared.threadId, runId: prepared.runId,
          outcome: { type: "interrupt", interrupts: [{
            id: waitingId, toolCallId: waitingId, reason: waiting.reason ?? "waiting", payload: safeWaiting,
            metadata: { openbotWaiting: safeWaiting },
          }] },
        });
      } else if (result?.stopReason === "end_turn") {
        complete(entry, { type: "RUN_FINISHED", threadId: prepared.threadId, runId: prepared.runId });
      } else {
        const reasons = { cancelled: "ACP agent cancelled this turn", refusal: "ACP agent 拒绝了这一轮", max_tokens: "ACP agent reached its token limit", max_turn_requests: "ACP agent reached its request limit" };
        throw rpcError(reasons[result?.stopReason] ?? "ACP agent returned no successful stop reason", result?.stopReason === "cancelled" ? "ACP_CANCELLED" : "ACP_STOP_ERROR");
      }
    } catch (error) {
      closeMessages();
      // Even cooperative cancellation gets a new session: a late update can only target the old id.
      active.generation?.sessions.delete(prepared.namespace);
      if (active.sessionId) active.generation?.seeded.delete(active.sessionId);
      complete(entry, {
        type: "RUN_ERROR", code: active.cancelCode ?? error?.code ?? "ACP_ERROR",
        message: active.cancelReason ?? (error instanceof Error ? error.message : String(error)),
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(active.grace);
      offNotification();
      offRequest();
      activeTurns.delete(active);
      entry.active = null;
    }
  };

  const errorResponse = (message, code = "ACP_ERROR") => new Response(`data: ${JSON.stringify({ type: "RUN_ERROR", code, message })}\n\n`, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });

  const run = (input, requestSignal) => {
    let prepared;
    try { prepared = prepareInput(input, options); } catch (error) {
      return errorResponse(error.message, error.code);
    }
    const siblings = runs.get(prepared.key) ?? [];
    let entry = siblings.find((item) => item.digest === prepared.inputDigest);
    if (entry?.status === "unknown") return errorResponse("This run was already started before recovery; its outcome is unknown and it must not be replayed", "ACP_RUN_UNKNOWN");
    if (!entry && siblings.length) {
      const previous = siblings.at(-1);
      if (previous.status === "unknown") return errorResponse("A previous segment of this run has an unknown outcome", "ACP_RUN_UNKNOWN");
      if (prepared.rowHashes.length <= previous.rowHashes.length || !previous.rowHashes.every((row, index) => prepared.rowHashes[index] === row)) {
        return errorResponse("Conflicting input for an existing ACP run; refusing a second prompt", "ACP_RUN_CONFLICT");
      }
    }
    const fresh = !entry;
    if (!entry) {
      entry = {
        key: prepared.key, digest: prepared.inputDigest, rowHashes: prepared.rowHashes,
        status: "queued", events: [], done: false, subscribers: new Set(), started: false, active: null,
        secrets: [options.token, prepared.context?.toolGateway.capability].filter(Boolean), cancelReason: null,
      };
      siblings.push(entry);
      runs.set(prepared.key, siblings);
      emit(entry, { type: "RUN_STARTED", threadId: prepared.threadId, runId: prepared.runId });
    }
    let detach = () => {};
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        const onAbort = () => {
          subscriber.finish();
          entry.subscribers.delete(subscriber);
          if (!entry.done && entry.subscribers.size === 0) {
            if (entry.active) entry.active.cancel("The caller cancelled this turn");
            else entry.cancelReason = "The caller cancelled this queued turn";
          }
        };
        const subscriber = {
          send(event) {
            if (closed) return;
            try { controller.enqueue(`data: ${JSON.stringify(event)}\n\n`); } catch { onAbort(); }
          },
          finish() {
            if (closed) return;
            closed = true;
            requestSignal?.removeEventListener("abort", onAbort);
            try { controller.close(); } catch {}
          },
        };
        detach = onAbort;
        for (const event of entry.events) subscriber.send(event);
        if (entry.done) subscriber.finish();
        else {
          entry.subscribers.add(subscriber);
          if (requestSignal?.aborted) onAbort();
          else requestSignal?.addEventListener("abort", onAbort, { once: true });
        }
      },
      cancel() { detach(); },
    });
    if (fresh) void serialize(prepared.namespace, () => execute(entry, prepared)).catch((error) => {
      complete(entry, { type: "RUN_ERROR", code: "ACP_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return new Response(stream, { headers: {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive",
    } });
  };

  const healthSnapshot = () => ({
    ok: Boolean(generation?.client.healthy && generation.client.initialized && stateHealthy
      && (!options.requireHostContext || (generation.hostTools && statePath))),
    hostTools: Boolean(generation?.hostTools),
    healthy: Boolean(generation?.client.healthy), initialized: Boolean(generation?.client.initialized),
    generation: generation?.id ?? 0, sessions: generation?.client.failed ? 0 : generation?.sessions.size ?? 0,
    queuedScopes: sessionQueues.size, activeTurns: activeTurns.size,
    runRecords: [...runs.values()].reduce((count, entries) => count + entries.length, 0),
    persistentState: Boolean(statePath), stateHealthy,
  });

  const server = Bun.serve({
    hostname: options.host, port: options.port, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json(healthSnapshot());
      // Authenticated deployment readiness does not create a session or run a write-capable prompt.
      if (url.pathname === "/ready") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        if (!options.token || request.headers.get("authorization") !== `Bearer ${options.token}`) return new Response("unauthorized", { status: 401 });
        try { await ensureInitialized(getGeneration()); } catch {}
        const snapshot = healthSnapshot();
        return Response.json(snapshot, { status: snapshot.ok ? 200 : 503 });
      }
      if (url.pathname !== "/ag-ui") return new Response("not found", { status: 404 });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (options.token && request.headers.get("authorization") !== `Bearer ${options.token}`) return new Response("unauthorized", { status: 401 });
      let input;
      try { input = await request.json(); } catch { return new Response("invalid JSON", { status: 400 }); }
      return run(input, request.signal);
    },
  });

  return {
    server,
    // The same entry point as HTTP, useful to attach an AbortSignal without HTTP-client buffering.
    run,
    close: async () => {
      closing = true;
      for (const active of activeTurns) active.cancel("ACP bridge is closing");
      server.stop(true);
      await Promise.all([...generations].map((current) => current.client.close()));
      await Promise.allSettled([...sessionQueues.values()]);
    },
  };
}

if (import.meta.main) {
  const bridge = createAcpBridge();
  console.log(`ACP bridge listening on http://${bridge.server.hostname}:${bridge.server.port}/ag-ui`);
  const stop = async () => { await bridge.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
