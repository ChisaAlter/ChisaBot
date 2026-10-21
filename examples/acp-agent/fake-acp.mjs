// 测试用的假 ACP agent：实现 initialize / session/new / session/prompt，发几条 session/update，
// 并在工具调用中间发一次 session/request_permission，验证桥会不会回复。不是 DSH/Hermes。
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionSeq = 0;
let newSessions = 0;
const permissionOutcomes = new Map();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof message.id === "string" && message.id.startsWith("permission-") && !message.method) {
    permissionOutcomes.set(message.id, message.result);
    return;
  }

  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: 1, agentCapabilities: {} });
    return;
  }
  if (message.method === "session/new") {
    newSessions += 1;
    sessionSeq += 1;
    if (process.env.FAKE_ACP_SESSION_COUNT_FILE) {
      writeFileSync(process.env.FAKE_ACP_SESSION_COUNT_FILE, String(newSessions));
    }
    respond(message.id, { sessionId: `acp-session-${sessionSeq}`, configOptions: [] });
    return;
  }
  if (message.method !== "session/prompt") return;

  const sessionId = message.params?.sessionId ?? "acp-session-1";
  const text = message.params?.prompt?.find((block) => block.type === "text")?.text ?? "";
  const fail = process.env.FAKE_ACP_ERROR === "1";
  const turn = sessionSeq;
  const permissionId = `permission-${turn}`;
  const update = (payload) => notify("session/update", { sessionId, update: payload });

  setTimeout(() => {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `收到：${text}` } });
    if (fail) {
      respond(message.id, { stopReason: "refusal" });
      return;
    }
    update({
      sessionUpdate: "tool_call",
      toolCallId: `call-${turn}`,
      title: "运行 echo hi",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "echo hi" },
    });
    write({
      jsonrpc: "2.0",
      id: permissionId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: `call-${turn}`, title: "运行 echo hi", kind: "execute", status: "pending" },
        options: [
          { optionId: "allow-1", name: "Allow once", kind: "allow_once" },
          { optionId: "deny-1", name: "Deny", kind: "reject_once" },
        ],
      },
    });

    setTimeout(() => {
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: `call-${turn}`,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hi" } }],
      });
      const outcome = permissionOutcomes.get(permissionId);
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `完成。权限回答：${JSON.stringify(outcome ?? null)}` },
      });
      respond(message.id, { stopReason: "end_turn" });
    }, 25);
  }, 5);
});
