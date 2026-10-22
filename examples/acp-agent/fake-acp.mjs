// Local-only ACP fixture. Faults and recordings are selected through a JSON argv option,
// so parallel tests never mutate the parent environment or use a model/server.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionSeq = 0;
let promptSeq = 0;
const turns = new Map();
const permissionOutcomes = new Map();
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const record = (type, value = {}) => {
  if (config.recordFile) appendFileSync(config.recordFile, `${JSON.stringify({ type, pid: process.pid, at: Date.now(), ...value })}\n`);
};
record("spawn");

function cancelled(turn) {
  if (turn.done) return;
  turn.done = true;
  record("prompt_end", { sessionId: turn.sessionId, text: turn.text, cancelled: true });
  respond(turn.id, { stopReason: "cancelled" });
}

lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message.id === "string" && message.id.startsWith("permission-") && !message.method) {
    permissionOutcomes.set(message.id, message.result);
    record("permission", { outcome: message.result });
    return;
  }
  if (message.method === "initialize") {
    record("initialize");
    setTimeout(() => respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: {},
      ...(config.hostTools === false ? {} : { _meta: { chisabotHostTools: 1 } }),
    }), config.initializeDelayMs ?? 0);
    return;
  }
  if (message.method === "session/new") {
    const sessionId = `acp-${process.pid}-${++sessionSeq}`;
    record("session_new", { sessionId, params: message.params });
    setTimeout(() => respond(message.id, { sessionId }), config.sessionDelaysMs?.[sessionSeq - 1] ?? config.sessionDelayMs ?? 0);
    return;
  }
  if (message.method === "session/cancel") {
    record("cancel", { sessionId: message.params.sessionId });
    const turn = turns.get(message.params.sessionId);
    if (turn && !config.ignoreCancel) setTimeout(() => cancelled(turn), config.cancelDelayMs ?? 5);
    return;
  }
  if (message.method !== "session/prompt") return;
  const params = message.params;
  const text = (params.prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const behavior = config.turns?.[text] ?? {};
  const turn = { id: message.id, sessionId: params.sessionId, text, done: false };
  turns.set(turn.sessionId, turn);
  const sequence = ++promptSeq;
  record("prompt", { sessionId: turn.sessionId, text, params });
  if (behavior.exit || config.exitOnPrompt || (config.exitOnceFile && !existsSync(config.exitOnceFile))) {
    if (config.exitOnceFile) writeFileSync(config.exitOnceFile, "exited");
    setTimeout(() => process.exit(17), 5);
    return;
  }
  if (behavior.hang || config.hang) return;
  const update = (payload, force = false) => {
    if (turn.done && !force) return;
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: turn.sessionId, update: payload } });
  };
  if (config.staleAfterCancelMs) setTimeout(() => {
    record("stale_update", { sessionId: turn.sessionId });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE_OLD_UPDATE" } }, true);
  }, config.staleAfterCancelMs);
  const delay = behavior.delayMs ?? config.promptDelayMs ?? 30;
  setTimeout(() => {
    if (turn.done) return;
    if (config.reasoning) update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考中" } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: config.echoCapability ? params._meta.chisabot.toolGateway.capability : `收到：${text}` } });
    const stopReason = behavior.stopReason ?? config.stopReason;
    if (stopReason && stopReason !== "end_turn") {
      turn.done = true;
      record("prompt_end", { sessionId: turn.sessionId, text });
      respond(message.id, { stopReason });
      return;
    }
    if (config.noTools || behavior.noTools) {
      turn.done = true;
      record("prompt_end", { sessionId: turn.sessionId, text });
      respond(message.id, { stopReason: "end_turn" });
      if (config.exitAfterPromptMs) setTimeout(() => process.exit(0), config.exitAfterPromptMs);
      return;
    }
    const callId = `real-call-${process.pid}-${sequence}`;
    const permissionId = `permission-${sequence}`;
    update({
      sessionUpdate: "tool_call", ...(config.missingToolId ? {} : { toolCallId: callId }),
      title: "运行 echo hi", name: "display-name", _meta: {
        name: "canonical_echo",
        ...(config.completeHostInput || config.callback ? { chisabot: { version: 1, callId, name: "canonical_echo", inputComplete: true } } : {}),
      },
      kind: "execute", status: "in_progress", rawInput: config.completeHostInput || config.callback ? { command: "echo hi" } : { command: "echo" },
    });
    if (config.inputConflict) update({ sessionUpdate: "tool_call_update", toolCallId: callId, rawInput: { command: "changed after complete" } });
    else if (config.snapshots !== false && !config.completeHostInput && !config.callback) update({ sessionUpdate: "tool_call_update", toolCallId: callId, rawInput: { command: "echo hi", nested: { ready: true } } });
    if (config.callback) {
      void (async () => {
        const gateway = params._meta.chisabot.toolGateway;
        const response = await fetch(`${gateway.url}/tools/call`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gateway.capability}` },
          body: JSON.stringify({ callId, name: "canonical_echo", args: { command: "echo hi" } }),
        });
        const payload = await response.json();
        record("callback", { status: response.status });
        if (response.status !== 200) throw new Error("host callback rejected");
        update({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", rawOutput: payload.result });
        turn.done = true;
        record("prompt_end", { sessionId: turn.sessionId, text });
        respond(message.id, { stopReason: "end_turn" });
      })().catch(() => {
        if (turn.done) return;
        turn.done = true;
        respond(message.id, { stopReason: "cancelled" });
      });
      return;
    }
    write({
      jsonrpc: "2.0", id: permissionId, method: "session/request_permission",
      params: { sessionId: turn.sessionId, toolCall: { toolCallId: callId }, options: [
        { optionId: "allow-1", name: "Allow once", kind: "allow_once" },
        { optionId: "deny-1", name: "Deny", kind: "reject_once" },
      ] },
    });
    setTimeout(() => {
      if (turn.done) return;
      if (config.waiting) {
        const waiting = { kind: "approval", requestId: "approval-1", toolCallId: callId, reason: "human_input", ...config.waiting };
        update({
          sessionUpdate: "tool_call_update", toolCallId: callId, status: "pending", content: null, rawOutput: null,
          _meta: { name: "canonical_echo", chisabot: { version: 1, waiting, callId, name: "canonical_echo" } },
        });
        turn.done = true;
        record("prompt_end", { sessionId: turn.sessionId, text });
        respond(message.id, { stopReason: "cancelled", _meta: { chisabot: { version: 1, waiting, callId, name: "canonical_echo" } } });
        return;
      }
      if (!config.missingToolResult) update({
        sessionUpdate: "tool_call_update", toolCallId: callId, status: config.failedTool ? "failed" : "completed",
        content: config.nullToolResult ? null : [{ type: "content", content: { type: "text", text: config.failedTool ? "tool failed" : "hi" } }],
        ...(config.nullToolResult ? { rawOutput: null } : config.rawOutput !== undefined ? { rawOutput: config.rawOutput } : {}),
      });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `完成。权限回答：${JSON.stringify(permissionOutcomes.get(permissionId) ?? null)}` } });
      turn.done = true;
      record("prompt_end", { sessionId: turn.sessionId, text });
      respond(message.id, { stopReason: "end_turn" });
    }, config.toolDelayMs ?? 15);
  }, delay);
});
