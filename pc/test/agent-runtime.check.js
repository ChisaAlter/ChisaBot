"use strict";
/** 本地 agent 运行时（docs/local-agents.md）：工作目录 / 改动 / 应用、内置循环、档位、CLI 输出解析、整条协议。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sandbox = require("../src/agent-runtime/sandbox");
const { runBuiltin } = require("../src/agent-runtime/builtin");
const { builtinToolGate, isInside } = require("../src/agent-runtime/profile");
const { claudeParser, codexParser, buildCommand } = require("../src/agent-runtime/cli-agents");
const { createAgentRuntime } = require("../src/agent-runtime/index");
const { attachAgentRuntime } = require("../src/agent-runtime/attach");
const { EventEmitter } = require("node:events");

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-repo-"));
  fs.writeFileSync(path.join(dir, "README.md"), "hello wrold\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.js"), "module.exports = 1;\n");
  if (hasGit) {
    const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  }
  return dir;
}

test("profile gate: reads inside, writes by profile, outside asks", () => {
  const dir = repo();
  const ctx = { workdir: dir, roots: [dir] };
  assert.equal(builtinToolGate("readonly", "read_file", { path: "README.md" }, ctx), null);
  assert.match(builtinToolGate("readonly", "write_file", { path: "README.md" }, ctx), /只读/);
  assert.match(builtinToolGate("readonly", "read_file", { path: "/etc/passwd" }, ctx), /不在工作区/);
  assert.equal(builtinToolGate("workspace", "edit_file", { path: "src/a.js" }, ctx), null);
  assert.match(builtinToolGate("workspace", "write_file", { path: "../escape.txt" }, ctx), /不在工作区/);
  assert.equal(builtinToolGate("full", "write_file", { path: "/tmp/x" }, ctx), null);
  {
    const { mapIntoCopy } = require("../src/agent-runtime/builtin");
    const dctx = { disposable: true, origin: "/home/u/repo", workdir: "/tmp/copy", roots: ["/home/u/repo"] };
    assert.equal(mapIntoCopy({ path: "/home/u/repo/a.txt" }, dctx).path, path.join("/tmp/copy", "a.txt"));
    assert.equal(mapIntoCopy({ path: "/etc/x" }, dctx).path, "/etc/x");
    assert.equal(mapIntoCopy({ command: "cd /home/u/repo && ls" }, dctx).command, "cd /tmp/copy && ls");
    assert.match(builtinToolGate("workspace", "run", { command: "echo > /home/u/repo/x" }, dctx), /原文件夹/);
    assert.match(builtinToolGate("workspace", "write_file", { path: "/home/u/repo/x" }, dctx), /不在工作区/);
  }
  assert.equal(isInside(path.join(dir, "src", "new.js"), [dir]), true);
});

test("node stop and revocation stop the attached agent runtime", () => {
  const attached = attachAgentRuntime();
  let stopped = 0;
  attached.runtime.stopAll = () => { stopped++; };
  const agent = { events: new EventEmitter(), sendRaw: () => true };
  attached.bind(agent);
  agent.events.emit("state", { state: "offline" });
  assert.equal(stopped, 0, "ordinary reconnect preserves resumable agent work");
  agent.events.emit("state", { state: "stopped" });
  agent.events.emit("state", { state: "revoked" });
  assert.equal(stopped, 2);
});

test("stopping while preparing a workdir does not start the agent afterwards", async () => {
  const originalPrepare = sandbox.prepare;
  let prepared;
  let markPrepareStarted;
  const prepareStarted = new Promise((resolve) => {
    markPrepareStarted = resolve;
  });
  let cleaned = false;
  const sent = [];
  const runtime = createAgentRuntime({ send: (message) => { sent.push(message); return true; } });
  sandbox.prepare = () => new Promise((resolve) => {
    prepared = resolve;
    markPrepareStarted();
  });
  try {
    runtime.handle({ type: "agent_run", taskId: "cancel-prep", agent: "builtin", prompt: "unused", cwd: os.tmpdir(), profile: "readonly", roots: [os.tmpdir()], isolation: "none", timeoutMs: 5000 });
    await prepareStarted;
    runtime.stopAll();
    prepared({ workdir: os.tmpdir(), notes: [], mode: "direct", cleanup: async () => { cleaned = true; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleaned, true);
    assert.equal(runtime.running, 0);
    assert.equal(sent.some((message) => message.type === "agent_started" || message.type === "agent_llm"), false);
    assert.ok(sent.some((message) => message.type === "agent_done" && message.stopped === true));
  } finally {
    sandbox.prepare = originalPrepare;
    runtime.stopAll();
  }
});

test("worktree: changes stay in the copy until applied", { skip: !hasGit }, async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "src", "a.js"), "module.exports = 2;\n"); // 未提交的改动也带进去
  const prep = await sandbox.prepare({ taskId: "t-worktree-0001", cwd: dir, isolation: "worktree" });
  assert.equal(prep.mode, "worktree");
  assert.notEqual(prep.workdir, dir);
  assert.equal(fs.readFileSync(path.join(prep.workdir, "src", "a.js"), "utf8"), "module.exports = 2;\n");
  fs.writeFileSync(path.join(prep.workdir, "README.md"), "hello world\n");
  fs.writeFileSync(path.join(prep.workdir, "NEW.md"), "new\n");
  const diff = await sandbox.diff(prep);
  assert.equal(diff.pending, true);
  assert.deepEqual(diff.files.map((f) => `${f.status}:${f.path}`).sort(), ["added:NEW.md", "modified:README.md"]);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "hello wrold\n");
  const applied = await sandbox.apply(prep);
  assert.deepEqual(applied, { ok: true });
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "hello world\n");
  assert.equal(fs.readFileSync(path.join(dir, "NEW.md"), "utf8"), "new\n");
  await prep.cleanup();
  assert.equal(fs.existsSync(prep.workRoot), false);
});

test("not a git repo: worktree falls back to a copy; direct mode still counts changes", { skip: !hasGit }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-plain-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  const prep = await sandbox.prepare({ taskId: "t-copy-00000001", cwd: dir, isolation: "worktree" });
  assert.equal(prep.mode, "copy");
  assert.match(prep.notes.join(), /不是 git 仓库/);
  fs.writeFileSync(path.join(prep.workdir, "a.txt"), "2\n");
  assert.equal((await sandbox.diff(prep)).files[0].path, "a.txt");
  assert.equal((await sandbox.apply(prep)).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "2\n");
  await prep.cleanup();
  const direct = await sandbox.prepare({ taskId: "t-direct-0000001", cwd: dir, isolation: "none" });
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  const d = await sandbox.diff(direct);
  assert.equal(d.pending, false);
  assert.deepEqual(d.files.map((f) => f.path), ["b.txt"]);
  assert.equal(fs.existsSync(path.join(dir, ".git")), false); // 快照不在用户文件夹里
  await direct.cleanup();
});

test("wrap builds sandbox command lines", () => {
  const b = sandbox.wrap({ isolation: "bwrap", workdir: "/w", network: false, file: "claude", args: ["-p", "x"] });
  assert.equal(b.file, "bwrap");
  assert.ok(b.args.includes("--unshare-net"));
  assert.deepEqual(b.args.slice(-3), ["claude", "-p", "x"]);
  const d = sandbox.wrap({ isolation: "docker", workdir: "/w", network: false, file: "sh", args: ["-c", "ls"], containerImage: "alpine" });
  assert.deepEqual(d.args.slice(0, 2), ["run", "--rm"]);
  assert.ok(d.args.includes("none"));
  const m = sandbox.wrap({ isolation: "sandbox-exec", workdir: "/w", network: false, file: "codex", args: [] });
  assert.match(m.args[1], /deny network/);
});

test("builtin loop: tools run locally, out-of-profile steps ask, denied steps are reported to the model", async () => {
  const dir = repo();
  const script = [
    [{ type: "tool-call", toolCallId: "1", toolName: "read_file", input: JSON.stringify({ path: "README.md" }) }],
    [{ type: "tool-call", toolCallId: "2", toolName: "edit_file", input: JSON.stringify({ path: "README.md", old_string: "wrold", new_string: "world" }) }],
    [{ type: "tool-call", toolCallId: "3", toolName: "write_file", input: JSON.stringify({ path: "../outside.txt", content: "x" }) }],
    [{ type: "tool-call", toolCallId: "4", toolName: "run", input: JSON.stringify({ command: "echo hi-from-run" }) }],
    [{ type: "text", text: "改好了 README 的错别字。" }],
  ];
  const seen = [];
  const asked = [];
  const lines = [];
  const result = await runBuiltin({
    prompt: "修错别字",
    workdir: dir,
    profile: "workspace",
    roots: [dir],
    isolation: "none",
    network: true,
    disposable: false,
    signal: new AbortController().signal,
    model: async (messages) => {
      seen.push(messages[messages.length - 1]);
      return script.shift();
    },
    approve: async (_operation, summary) => {
      asked.push(summary);
      return false;
    },
    emit: (kind, text) => lines.push(`${kind}:${text}`),
  });
  assert.equal(result.summary, "改好了 README 的错别字。");
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "hello world\n");
  assert.equal(fs.existsSync(path.join(dir, "..", "outside.txt")), false);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /不在工作区/);
  assert.match(seen[1].output, /hello wrold/);
  assert.match(seen[3].output, /没有批准/);
  assert.match(seen[4].output, /hi-from-run/);
  assert.ok(lines.includes("tool:修改 README.md"));
});

test("claude stream-json and codex json parsing", () => {
  const out = [];
  const emit = (kind, text) => out.push(`${kind}:${text}`);
  const c = claudeParser();
  c.line(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet" }), emit);
  c.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "我来看看" }, { type: "tool_use", name: "Edit", input: { file_path: "a.js" } }] } }), emit);
  c.line(JSON.stringify({ type: "result", subtype: "success", result: "完成", num_turns: 3, total_cost_usd: 0.0123 }), emit);
  assert.deepEqual(out.slice(0, 3), ["status:Claude Code 已启动（claude-sonnet）", "text:我来看看", "tool:修改 a.js"]);
  assert.deepEqual(c.result(), { summary: "完成", isError: false, sessionId: null });
  const x = codexParser();
  out.length = 0;
  x.line(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }), emit);
  x.line(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "测试都过了" } }), emit);
  assert.deepEqual(out, ["tool:运行 npm test", "text:测试都过了"]);
  assert.equal(x.result().summary, "测试都过了");
  const claude = buildCommand("claude", { prompt: "p", profile: "workspace", skipPermissions: false, network: true, workdir: "/w", root: true });
  assert.ok(claude.args.includes("acceptEdits"));
  assert.equal(claude.env.IS_SANDBOX, undefined);
  const full = buildCommand("claude", { prompt: "p", profile: "full", skipPermissions: true, network: true, workdir: "/w", root: true });
  assert.ok(full.args.includes("--dangerously-skip-permissions"));
  assert.equal(full.env.IS_SANDBOX, "1");
  assert.ok(buildCommand("claude", { prompt: "p", profile: "readonly", skipPermissions: false, workdir: "/w" }).args.includes("plan"));
  assert.ok(buildCommand("codex", { prompt: "p", profile: "readonly", skipPermissions: false, workdir: "/w" }).args.includes("read-only"));
});

test("runtime protocol: agent_run with a fake CLI agent streams events and reports a pending diff; apply merges", { skip: !hasGit || process.platform === "win32" }, async () => {
  const dir = repo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-bin-"));
  // 假的 claude：输出 stream-json，并改一个文件。
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/bin/sh\necho '{"type":"system","subtype":"init","model":"mock"}'\necho '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"README.md"}}]}}'\nprintf 'hello world\\n' > README.md\necho '{"type":"result","subtype":"success","result":"改好了","num_turns":1}'\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const sent = [];
  const runtime = createAgentRuntime({
    send: (m) => {
      sent.push(m);
      return true;
    },
  });
  try {
    assert.equal(runtime.handle({ type: "agent_run", taskId: "task-proto-1", agent: "claude", prompt: "修错别字", cwd: dir, profile: "workspace", isolation: "worktree", network: true, roots: [dir], skipPermissions: false, builtinModel: { kind: "server" }, containerImage: "x", timeoutMs: 60_000 }), true);
    const t0 = Date.now();
    while (!sent.some((m) => m.type === "agent_done") && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
    const done = sent.find((m) => m.type === "agent_done");
    assert.ok(done, JSON.stringify(sent.slice(-3)));
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.summary, "改好了");
    assert.equal(done.diff.pending, true);
    assert.equal(done.diff.files[0].path, "README.md");
    assert.ok(sent.some((m) => m.type === "agent_event" && m.kind === "tool" && m.text === "修改 README.md"));
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "hello wrold\n");
    runtime.handle({ type: "agent_apply", taskId: "task-proto-1" });
    const t1 = Date.now();
    while (!sent.some((m) => m.type === "agent_applied") && Date.now() - t1 < 10_000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.find((m) => m.type === "agent_applied").ok, true);
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "hello world\n");
    assert.equal(runtime.handle({ type: "something_else" }), false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("shadow home: links shared dirs via junction/symlink while isolating auth.json", () => {
  const { prepareShadowHome, inspectHomeAuth } = require("../src/agent-runtime/shadow-home");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-home-"));
  const baseHome = path.join(root, "main-codex");
  const shadowHome = path.join(root, "shadow-personal");
  fs.mkdirSync(path.join(baseHome, "skills"), { recursive: true });
  fs.writeFileSync(path.join(baseHome, "skills", "demo.md"), "# skill\n");
  fs.writeFileSync(path.join(baseHome, "config.toml"), "model = 'o3'\n");
  fs.writeFileSync(path.join(baseHome, "auth.json"), JSON.stringify({ tokens: { access: "main-account" } }));

  const res = prepareShadowHome({ driver: "codex", homePath: baseHome, shadowHomePath: shadowHome });
  assert.equal(res.env.CODEX_HOME, shadowHome);
  // 共享目录可读到主目录里的 skill
  assert.equal(fs.readFileSync(path.join(shadowHome, "skills", "demo.md"), "utf8"), "# skill\n");
  // config.toml 初始拷贝，auth.json 严格隔离不拷贝
  assert.equal(fs.readFileSync(path.join(shadowHome, "config.toml"), "utf8"), "model = 'o3'\n");
  assert.equal(fs.existsSync(path.join(shadowHome, "auth.json")), false);
  assert.equal(inspectHomeAuth({ driver: "codex", homePath: baseHome, shadowHomePath: shadowHome }).authenticated, null);

  // 在影子目录独立写入自己的 auth.json，不影响主目录
  fs.writeFileSync(path.join(shadowHome, "auth.json"), JSON.stringify({ tokens: { access: "shadow-account" } }));
  assert.equal(inspectHomeAuth({ driver: "codex", homePath: baseHome, shadowHomePath: shadowHome }).authenticated, true);
  assert.match(fs.readFileSync(path.join(baseHome, "auth.json"), "utf8"), /main-account/);

  // 禁止父子嵌套
  assert.throws(() => prepareShadowHome({ driver: "codex", homePath: baseHome, shadowHomePath: path.join(baseHome, "nested") }), /父子目录/);
});

test("antigravity proxy sanitizer & custom/codex driver command builder", () => {
  const { sanitizeAntigravityEnv } = require("../src/agent-runtime/acp-client");
  const { genericJsonlParser } = require("../src/agent-runtime/cli-agents");

  const cleaned = sanitizeAntigravityEnv({
    ELECTRON_RUN_AS_NODE: "1",
    HTTP_PROXY: "127.0.0.1:7890",
    HTTPS_PROXY: "http://127.0.0.1:7890",
  });
  assert.equal(cleaned.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(cleaned.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(cleaned.HTTPS_PROXY, "http://127.0.0.1:7890");

  const codexCmd = buildCommand("codex", {
    prompt: "fix bug",
    profile: "workspace",
    skipPermissions: false,
    network: true,
    workdir: "/repo",
    model: "gpt-5-codex",
    extraArgs: ["--full-auto"],
    codexConfigArgs: ["-c", 'mcp_servers.chisabot_subagents.command="node"'],
  });
  assert.equal(codexCmd.args[codexCmd.args.length - 1], "fix bug", "prompt must stay at the end of codex exec args");
  assert.ok(codexCmd.args.includes("gpt-5-codex"));
  assert.ok(codexCmd.args.includes("--full-auto"));

  const customCmd = buildCommand("custom", {
    prompt: "hello",
    workdir: "/repo",
    model: "m1",
    extraArgs: ["--cwd", "{{workdir}}", "--ask", "{{prompt}}"],
    stdinPrompt: false,
    outputFormat: "jsonl",
  });
  assert.deepEqual(customCmd.args, ["--cwd", "/repo", "--ask", "hello"]);
  assert.equal(customCmd.stdin, null);

  const parser = genericJsonlParser();
  const emitted = [];
  parser.line(JSON.stringify({ type: "tool", title: "检索代码" }), (k, t) => emitted.push(`${k}:${t}`));
  parser.line(JSON.stringify({ summary: "自定义完成" }), (k, t) => emitted.push(`${k}:${t}`));
  assert.equal(parser.result().summary, "自定义完成");
  assert.deepEqual(emitted, ["tool:检索代码", "text:自定义完成"]);
});

test("ACP session & nested subagent MCP bridge end-to-end (cross-platform)", async () => {
  const dir = repo();
  const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-acp-"));
  const mockAcpScript = path.join(tmpBin, "mock-acp-agent.js");

  // 一个纯 Node 编写的标准 ACP 智能体：验证 initialize、接收 mcpServers 并通过 stdio MCP 调一次嵌套 subagent_list，再写文件并返回结果
  fs.writeFileSync(
    mockAcpScript,
    `"use strict";
const { spawn } = require("node:child_process");
let buf = "";
let mcpServers = [];
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
let reqSeq = 100;
const pending = new Map();

function callMcpList(serverSpec) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const item of serverSpec.env || []) env[item.name] = item.value;
    const child = spawn(serverSpec.command, serverSpec.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += String(c);
      for (const line of out.split("\\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 2) { child.kill(); resolve(m.result); }
        } catch {}
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "subagent_list", arguments: {} } }) + "\\n");
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && !msg.method) {
      const fn = pending.get(msg.id);
      if (fn) { pending.delete(msg.id); fn(msg.result); }
      continue;
    }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "mock-acp", title: "Mock ACP", version: "2.4.0" }, authMethods: [] } });
    } else if (msg.method === "session/new") {
      mcpServers = msg.params.mcpServers || [];
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_1" } });
    } else if (msg.method === "session/prompt") {
      (async () => {
        let subInfo = "none";
        if (mcpServers.length > 0) {
          const mcpRes = await callMcpList(mcpServers[0]);
          subInfo = mcpRes.content[0].text;
        }
        const writeId = ++reqSeq;
        await new Promise((r) => {
          pending.set(writeId, r);
          send({ jsonrpc: "2.0", id: writeId, method: "fs/write_text_file", params: { sessionId: "sess_1", path: "README.md", content: "hello acp\\n" } });
        });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "调用子代理目录" } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP 完成，子代理：" + subInfo } } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      })();
    }
  }
});
`,
  );

  const sent = [];
  let runtime;
  runtime = createAgentRuntime({
    send: (m) => {
      sent.push(m);
      if (m.type === "agent_subcall" && m.action === "list") {
        setImmediate(() => {
          runtime.handle({
            type: "agent_subcall_result",
            reqId: m.reqId,
            taskId: m.taskId,
            ok: true,
            data: [{ slug: "codebuddy", name: "Codebuddy" }],
          });
        });
      }
      return true;
    },
  });

  // 1. 测试单实例 ACP 探活
  runtime.handle({
    type: "agent_probe",
    reqId: "probe-1",
    instance: {
      id: "inst-acp",
      slug: "mock-acp",
      name: "Mock ACP",
      driver: "acp",
      config: { commandPath: process.execPath, extraArgs: [mockAcpScript] },
      env: {},
    },
  });
  const p0 = Date.now();
  while (!sent.some((m) => m.type === "agent_probe_result") && Date.now() - p0 < 10_000) {
    await new Promise((r) => setTimeout(r, 30));
  }
  const probeMsg = sent.find((m) => m.type === "agent_probe_result");
  assert.ok(probeMsg);
  assert.equal(probeMsg.probe.status, "available");
  assert.equal(probeMsg.probe.version, "2.4.0");

  // 2. 测试 ACP 运行 + fs/write_text_file 回调 + 嵌套 MCP 互调桥
  runtime.handle({
    type: "agent_run",
    taskId: "task-acp-1",
    agent: "acp",
    prompt: "用 ACP 修改 README 并列出可用子代理",
    cwd: dir,
    profile: "workspace",
    isolation: "none",
    network: true,
    roots: [dir],
    skipPermissions: false,
    builtinModel: { kind: "server" },
    containerImage: "x",
    timeoutMs: 30_000,
    instance: {
      id: "inst-acp",
      slug: "mock-acp",
      name: "Mock ACP",
      driver: "acp",
      config: { commandPath: process.execPath, extraArgs: [mockAcpScript] },
      env: {},
    },
    subagentBridge: { enabled: true, depth: 0, maxDepth: 3 },
  });

  const t0 = Date.now();
  while (!sent.some((m) => m.type === "agent_done" && m.taskId === "task-acp-1") && Date.now() - t0 < 15_000) {
    await new Promise((r) => setTimeout(r, 40));
  }
  const started = sent.find((m) => m.type === "agent_started" && m.taskId === "task-acp-1");
  assert.ok(started);
  assert.equal(started.sessionId, null);
  const done = sent.find((m) => m.type === "agent_done" && m.taskId === "task-acp-1");
  assert.ok(done, JSON.stringify(sent.slice(-4)));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.sessionId, "sess_1");
  assert.equal(done.continuable, true);
  assert.match(done.summary, /codebuddy/);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "hello acp\n");

  // 3. 验证递归深度上限拦截（depth >= maxDepth 时不启动互调桥）
  const { createSubagentBridge } = require("../src/agent-runtime/subagent-bridge");
  const blockedBridge = await createSubagentBridge({ taskId: "deep", depth: 3, maxDepth: 3, onSubcall: async () => ({}) });
  assert.equal(blockedBridge, null);
});

test("which(): quote stripping, case-insensitive Path/PathExt, and Windows .cmd over extensionless POSIX script", () => {
  const { which, clearWhichCache } = require("../src/agent-runtime/detect");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-which-"));
  const win = process.platform === "win32";
  try {
    const spacedDir = path.join(tmpRoot, "dir with spaces");
    fs.mkdirSync(spacedDir, { recursive: true });

    const bareScript = path.join(spacedDir, "mytool");
    fs.writeFileSync(bareScript, "#!/bin/sh\necho posix\n", { mode: 0o755 });
    const cmdFile = path.join(spacedDir, "mytool.cmd");
    if (win) {
      fs.writeFileSync(cmdFile, "@echo off\r\necho win-cmd\r\n");
    }

    clearWhichCache();
    // 1. 显式路径带双引号剥离 + Windows 下无扩展名显式路径优先匹配 .cmd 而非同名 POSIX sh 脚本
    const explicitHit = which(`"${bareScript}"`);
    assert.equal(explicitHit, win ? cmdFile : bareScript);

    // 2. PATH 条目带双引号与 Windows 大小写 Path / PathExt
    const quotedPathEnv = win
      ? { Path: `"${spacedDir}"`, PathExt: ".CMD;.BAT" }
      : { PATH: `"${spacedDir}"` };
    assert.equal(which("mytool", quotedPathEnv), win ? cmdFile : bareScript);

    if (win) {
      // 3. 同时存在 Path 与 PATH 时，后者覆盖前者
      const dir2 = path.join(tmpRoot, "dir2");
      fs.mkdirSync(dir2, { recursive: true });
      const exe2 = path.join(dir2, "mytool.exe");
      fs.writeFileSync(exe2, "stub");
      const overrideEnv = { Path: spacedDir, PATH: dir2, PathExt: ".EXE;.CMD" };
      assert.equal(which("mytool", overrideEnv), exe2);
    }
  } finally {
    clearWhichCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("antigravity discovery: custom > managed > system, no .t3/agentapi sniffing, desktop GUI filtered, ACP isolation args", () => {
  const {
    resolveAntigravityExecutable,
    resolveAntigravityExecutableWithSource,
    resolveAcpCommand,
    isAntigravityDesktopGuiPath,
    extraSearchDirs,
    clearWhichCache,
  } = require("../src/agent-runtime/detect");
  const {
    resolveAntigravityToolsDir,
  } = require("../src/agent-runtime/antigravity-managed");
  const win = process.platform === "win32";
  const ext = win ? ".exe" : "";
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-agy-disc-"));
  try {
    const fakeHome = path.join(tmpRoot, "home");
    const dataDir = path.join(tmpRoot, "chisabot-data");
    const localAppData = path.join(fakeHome, "AppData", "Local");
    fs.mkdirSync(localAppData, { recursive: true });
    const baseEnv = win
      ? {
          PATH: "",
          USERPROFILE: fakeHome,
          LOCALAPPDATA: localAppData,
          CHISABOT_AGENT_DATA_DIR: dataDir,
        }
      : {
          PATH: "",
          HOME: fakeHome,
          CHISABOT_AGENT_DATA_DIR: dataDir,
        };

    // 0. extraSearchDirs 包含 %LOCALAPPDATA%\agy\bin，且严禁包含桌面 GUI 根目录 Programs\antigravity
    if (win) {
      const dirs = extraSearchDirs(baseEnv).map((d) => d.toLowerCase());
      assert.ok(dirs.includes(path.join(localAppData, "agy", "bin").toLowerCase()));
      assert.equal(
        dirs.includes(path.join(localAppData, "programs", "antigravity").toLowerCase()),
        false,
      );
    }

    // 1. 桌面 GUI 路径拒绝规则
    assert.equal(
      isAntigravityDesktopGuiPath("C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe"),
      true,
    );
    assert.equal(
      isAntigravityDesktopGuiPath("/Applications/Antigravity.app/Contents/MacOS/Antigravity"),
      true,
    );
    assert.equal(
      isAntigravityDesktopGuiPath("C:\\AI\\antigravity-cli\\antigravity.exe"),
      false,
    );

    // 2. 彻底不再嗅探 ~/.t3/tools 或 ~/.gemini/antigravity-cli/bin/agentapi(.bat)
    const platKey = `${process.platform}-${process.arch}`;
    const t3Root = path.join(fakeHome, ".t3", "tools", "antigravity-acp", platKey);
    const t3VerDir = path.join(t3Root, "versions", "rel-1515");
    fs.mkdirSync(t3VerDir, { recursive: true });
    fs.writeFileSync(path.join(t3VerDir, `agy${ext}`), "stub", { mode: 0o755 });
    fs.writeFileSync(path.join(t3Root, "active.json"), JSON.stringify({ releaseId: "rel-1515" }));

    const staleCliDir = path.join(tmpRoot, "stale-cli");
    fs.mkdirSync(staleCliDir, { recursive: true });
    const staleCli = path.join(staleCliDir, `antigravity${ext}`);
    fs.writeFileSync(staleCli, "stub", { mode: 0o755 });
    const geminiCliBin = path.join(fakeHome, ".gemini", "antigravity-cli", "bin");
    fs.mkdirSync(geminiCliBin, { recursive: true });
    fs.writeFileSync(
      path.join(geminiCliBin, win ? "agentapi.bat" : "agentapi"),
      win ? `@echo off\r\n"${staleCli}" agentapi %*\r\n` : `#!/bin/sh\nexec "${staleCli}" agentapi "$@"\n`,
      { mode: 0o755 },
    );

    clearWhichCache();
    assert.deepEqual(resolveAntigravityExecutableWithSource("agy", baseEnv), {
      file: null,
      source: null,
    });
    const missingDefault = resolveAcpCommand("antigravity", {}, baseEnv);
    assert.equal(missingDefault.file, null);
    assert.equal(
      missingDefault.missingReason,
      "未安装 Antigravity 运行时，可在下方一键安装或手动指定可执行路径",
    );

    // 3. 系统 PATH 中的 antigravity 返回 source: "system"，并自动跳过排在前面的桌面端 GUI
    const guiDir = path.join(tmpRoot, "Programs", "Antigravity");
    fs.mkdirSync(guiDir, { recursive: true });
    const guiExe = path.join(guiDir, win ? "Antigravity.exe" : "antigravity");
    fs.writeFileSync(guiExe, "gui-stub", { mode: 0o755 });
    const pathBinDir = path.join(tmpRoot, "path-bin");
    fs.mkdirSync(pathBinDir, { recursive: true });
    const systemBin = path.join(pathBinDir, `antigravity${ext}`);
    fs.writeFileSync(systemBin, "cli-stub", { mode: 0o755 });

    const envWithSystem = {
      ...baseEnv,
      PATH: win ? `${guiDir};${pathBinDir}` : pathBinDir,
    };
    clearWhichCache();
    if (win) {
      assert.equal(resolveAntigravityExecutable(guiExe, baseEnv), null);
      const guiRes = resolveAcpCommand(
        "antigravity",
        { commandPath: guiExe, protocolMode: "auto" },
        baseEnv,
      );
      assert.equal(guiRes.file, null);
      assert.match(guiRes.missingReason || "", /桌面端/);
    }
    assert.deepEqual(resolveAntigravityExecutableWithSource("agy", envWithSystem), {
      file: systemBin,
      source: "system",
    });

    // 4. ChisaBot 托管版优先级高于系统 PATH（managed > system）
    const toolsDir = resolveAntigravityToolsDir(envWithSystem);
    const managedVerDir = path.join(toolsDir, "versions", "1.5.16");
    fs.mkdirSync(managedVerDir, { recursive: true });
    const managedBin = path.join(managedVerDir, `agy${ext}`);
    fs.writeFileSync(managedBin, "managed-stub", { mode: 0o755 });
    fs.writeFileSync(
      path.join(toolsDir, "active.json"),
      JSON.stringify({
        version: "1.5.16",
        binaryRelPath: `versions/1.5.16/agy${ext}`,
        sha512: "a".repeat(128),
        installedAt: new Date().toISOString(),
        sourceUrl: "https://storage.googleapis.com/antigravity-public/antigravity-cli/test",
      }),
    );

    clearWhichCache();
    assert.deepEqual(resolveAntigravityExecutableWithSource("", envWithSystem), {
      file: managedBin,
      source: "managed",
    });
    assert.deepEqual(resolveAntigravityExecutableWithSource("agy", envWithSystem), {
      file: managedBin,
      source: "managed",
    });

    // 5. 显式非默认 commandPath 优先级最高（custom > managed > system），且找不到时不回退
    const customDir = path.join(tmpRoot, "custom-agy");
    fs.mkdirSync(customDir, { recursive: true });
    const customBin = path.join(customDir, `my-agy${ext}`);
    fs.writeFileSync(customBin, "custom-stub", { mode: 0o755 });
    clearWhichCache();
    assert.deepEqual(resolveAntigravityExecutableWithSource(customBin, envWithSystem), {
      file: customBin,
      source: "custom",
    });
    const missingCustom = resolveAcpCommand(
      "antigravity",
      { commandPath: path.join(tmpRoot, "not-exist-agy"), protocolMode: "auto" },
      envWithSystem,
    );
    assert.equal(missingCustom.file, null);
    assert.equal(missingCustom.runtimeSource, null);
    assert.match(missingCustom.missingReason || "", /not-exist-agy/);

    // 6. resolveAcpCommand 自动拼入严格隔离参数（--gemini-dir / 相对名 --app-data-dir antigravity-cli / --disable-telemetry）
    const autoCmd = resolveAcpCommand(
      "antigravity",
      { commandPath: "", protocolMode: "auto", extraArgs: ["--sandbox"] },
      envWithSystem,
      { id: "inst-alpha", slug: "alpha", driver: "antigravity", config: {}, env: {} },
    );
    assert.equal(autoCmd.mode, "acp");
    assert.equal(autoCmd.file, managedBin);
    assert.equal(autoCmd.runtimeSource, "managed");
    const expectedHome = path.join(dataDir, "agent-homes", "antigravity", "inst-alpha");
    assert.equal(autoCmd.homePath, expectedHome);
    assert.deepEqual(autoCmd.args, [
      "acp",
      "--gemini-dir",
      path.join(expectedHome, ".gemini"),
      "--app-data-dir",
      "antigravity-cli",
      "--disable-telemetry",
      "--sandbox",
    ]);
    const appDataIdx = autoCmd.args.indexOf("--app-data-dir");
    assert.equal(path.isAbsolute(autoCmd.args[appDataIdx + 1]), false);
  } finally {
    clearWhichCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("antigravity probeInstance protocolMode acp/auto, env sanitization, spaced .cmd, and CLI args", async () => {
  const { probeInstance, capture } = require("../src/agent-runtime/detect");
  const { probeAcpAgent, sanitizeAntigravityEnv } = require("../src/agent-runtime/acp-client");
  const win = process.platform === "win32";
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-agy-probe "));
  const prevElectronNode = process.env.ELECTRON_RUN_AS_NODE;
  const prevElectronConsole = process.env.ELECTRON_NO_ATTACH_CONSOLE;
  try {
    // 1. CLI 参数构建校验（-p / --output-format text / --model / viaStdin）
    const cliDirect = buildCommand("antigravity", {
      prompt: "hello\nworld",
      model: "gemini-2.5-pro",
      profile: "workspace",
      viaStdin: false,
      extraArgs: ["--sandbox"],
    });
    assert.deepEqual(cliDirect.args, [
      "-p",
      "hello\nworld",
      "--output-format",
      "text",
      "--model",
      "gemini-2.5-pro",
      "--sandbox",
    ]);
    assert.equal(cliDirect.stdin, null);

    const cliStdin = buildCommand("antigravity", {
      prompt: "multi\nline",
      model: "gemini-2.5-pro",
      profile: "readonly",
      viaStdin: true,
    });
    assert.deepEqual(cliStdin.args, [
      "--output-format",
      "text",
      "--model",
      "gemini-2.5-pro",
      "--mode",
      "plan",
    ]);
    assert.equal(cliStdin.stdin, "multi\nline");

    // 2. probeAcpAgent 绝不将 sanitizeAntigravityEnv 删除的 ELECTRON_RUN_AS_NODE 重新注回
    const envCheckScript = path.join(tmpRoot, "env-check-acp.js");
    fs.writeFileSync(
      envCheckScript,
      `"use strict";
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const idx = buf.indexOf("\\n");
  if (idx < 0) return;
  const msg = JSON.parse(buf.slice(0, idx).trim());
  if (msg.method === "initialize") {
    if (process.env.ELECTRON_RUN_AS_NODE !== undefined || process.env.ELECTRON_NO_ATTACH_CONSOLE !== undefined) {
      process.stderr.write("LEAKED_ELECTRON_ENV\\n");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentInfo: { name: "Clean ACP", version: "1.5.16" }, authMethods: [] },
    }) + "\\n");
  }
});
`,
    );
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
    const sanitized = sanitizeAntigravityEnv(process.env, true);
    assert.equal(sanitized.ELECTRON_RUN_AS_NODE, undefined);
    const acpRes = await probeAcpAgent({
      file: process.execPath,
      args: [envCheckScript],
      env: sanitized,
      timeoutMs: 5000,
    });
    assert.equal(acpRes.status, "available", JSON.stringify(acpRes));
    assert.equal(acpRes.version, "1.5.16");

    // 3. 含空格路径的假 CLI（支持 --version 但 acp 子命令失败）：
    //    - protocolMode: "acp" 必须返回 error，绝不误报 CLI 可用
    //    - protocolMode: "auto" 可降级返回 available / CLI 可用
    const spacedBinDir = path.join(tmpRoot, "My Tools (Test)");
    fs.mkdirSync(spacedBinDir, { recursive: true });
    const fakeCliJs = path.join(spacedBinDir, "fake-agy.js");
    fs.writeFileSync(
      fakeCliJs,
      `"use strict";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("1.5.16");
  process.exit(0);
}
if (args[0] === "acp") {
  console.error("ACP_BROKEN_HANDSHAKE");
  process.exit(2);
}
process.exit(1);
`,
    );
    const fakeWrapper = path.join(spacedBinDir, win ? "fake agy.cmd" : "fake-agy");
    if (win) {
      fs.writeFileSync(
        fakeWrapper,
        `@echo off\r\n"${process.execPath}" "${fakeCliJs}" %*\r\n`,
      );
    } else {
      fs.writeFileSync(
        fakeWrapper,
        `#!/bin/sh\nexec "${process.execPath}" "${fakeCliJs}" "$@"\n`,
        { mode: 0o755 },
      );
    }

    // 验证含空格路径 .cmd 通过 capture() 正常拿版本号
    const capRes = await capture(fakeWrapper, ["--version"], { timeoutMs: 5000 });
    assert.equal(capRes.code, 0, JSON.stringify(capRes));
    assert.match(capRes.out, /1\.5\.16/);

    // protocolMode: "acp" 失败不得降级误报 CLI 可用
    const acpStrictProbe = await probeInstance({
      driver: "antigravity",
      config: { commandPath: fakeWrapper, protocolMode: "acp" },
    });
    assert.equal(acpStrictProbe.status, "error", JSON.stringify(acpStrictProbe));
    assert.match(acpStrictProbe.message, /ACP_BROKEN_HANDSHAKE/);

    // protocolMode: "auto" 在 ACP 失败且 --version 成功时降级 CLI 可用（隔离 HOME 确保无本地凭据干扰）
    const emptyHome = path.join(tmpRoot, "empty-home");
    fs.mkdirSync(emptyHome, { recursive: true });
    const isolatedAuthEnv = {
      USERPROFILE: emptyHome,
      HOME: emptyHome,
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
    };
    const autoFallbackProbe = await probeInstance({
      driver: "antigravity",
      config: { commandPath: fakeWrapper, protocolMode: "auto" },
      env: isolatedAuthEnv,
    });
    assert.equal(autoFallbackProbe.status, "available", JSON.stringify(autoFallbackProbe));
    assert.equal(autoFallbackProbe.authenticated, null);
    assert.equal(autoFallbackProbe.authLabel, "CLI 可用");
    assert.equal(autoFallbackProbe.version, "1.5.16");

    // 4. capture() 超时能杀子进程并及时返回
    const tStart = Date.now();
    const timeoutRes = await capture(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { timeoutMs: 300 },
    );
    const elapsed = Date.now() - tStart;
    assert.equal(timeoutRes.code, -1);
    assert.equal(timeoutRes.timedOut, true);
    assert.ok(elapsed < 4000, `capture timeout took too long: ${elapsed}ms`);
  } finally {
    if (prevElectronNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prevElectronNode;
    if (prevElectronConsole === undefined) delete process.env.ELECTRON_NO_ATTACH_CONSOLE;
    else process.env.ELECTRON_NO_ATTACH_CONSOLE = prevElectronConsole;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("Windows .cmd spawnCommand prevents quote breakout injection & env expansion; authLabel compaction & isolated auth check", async () => {
  const {
    capture,
    clearWhichCache,
  } = require("../src/agent-runtime/detect");
  const {
    resolveAntigravityIsolation,
    inspectManagedAntigravityAuth,
  } = require("../src/agent-runtime/antigravity-managed");
  const {
    formatAcpAuthLabel,
    probeAcpAgent,
  } = require("../src/agent-runtime/acp-client");
  const win = process.platform === "win32";
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-sec-auth "));
  try {
    // 1. Windows .cmd 危险参数防命令注入与防 %VAR% 展开回归测试
    if (win) {
      const binDir = path.join(tmpRoot, "Tools (Safe)");
      fs.mkdirSync(binDir, { recursive: true });
      const echoJs = path.join(binDir, "echo-argv.js");
      const echoCmd = path.join(binDir, "run echo.cmd");
      fs.writeFileSync(
        echoJs,
        'console.log(JSON.stringify(process.argv.slice(2)));\n',
      );
      fs.writeFileSync(
        echoCmd,
        `@echo off\r\n"${process.execPath}" "%~dp0echo-argv.js" %*\r\n`,
      );

      const dangerousCases = [
        ["--arg", 'a"b&echo INJECTED'],
        ["--arg", "%OS%"],
        ["--arg", "%OS%%TEMP%"],
        ["--arg", "a|echo PWN", "x>pwn.txt", "c^d", "(paren)", "!OS!", "--k=v", ""],
      ];
      for (const argv of dangerousCases) {
        const res = await capture(echoCmd, argv, { cwd: tmpRoot, timeoutMs: 5000 });
        assert.equal(res.code, 0, JSON.stringify(res));
        assert.equal(
          res.out.trim(),
          JSON.stringify(argv),
          `argv fidelity mismatch for ${JSON.stringify(argv)}: got ${res.out}`,
        );
      }
      assert.equal(fs.existsSync(path.join(tmpRoot, "pwn.txt")), false);
    }

    // 2. formatAcpAuthLabel 与 probeAcpAgent 收敛超长英文 authMethods
    assert.equal(
      formatAcpAuthLabel([
        { id: "oauth-personal", name: "Log in with Google" },
        { id: "oauth-business", name: "Log in with Gemini Enterprise" },
        { id: "gemini-api-key", name: "Gemini API key" },
        { id: "agent-platform", name: "Gemini Enterprise Agent Platform" },
      ]),
      "ACP 就绪",
    );
    assert.equal(
      formatAcpAuthLabel([{ id: "oauth", name: "OAuth" }, { id: "key", name: "API Key" }]),
      "支持 OAuth / API Key",
    );

    const longAuthScript = path.join(tmpRoot, "long-auth-acp.js");
    fs.writeFileSync(
      longAuthScript,
      `"use strict";
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const idx = buf.indexOf("\\n");
  if (idx < 0) return;
  const msg = JSON.parse(buf.slice(0, idx).trim());
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.16" },
        authMethods: [
          { id: "oauth-personal", name: "Log in with Google" },
          { id: "oauth-business", name: "Log in with Gemini Enterprise" },
          { id: "gemini-api-key", name: "Gemini API key" },
          { id: "agent-platform", name: "Gemini Enterprise Agent Platform" },
        ],
      },
    }) + "\\n");
  }
});
`,
    );
    const acpLongRes = await probeAcpAgent({
      file: process.execPath,
      args: [longAuthScript],
      timeoutMs: 5000,
    });
    assert.equal(acpLongRes.status, "available");
    assert.equal(acpLongRes.authLabel, "ACP 就绪");

    // 3. 严格隔离环境与隔离凭据无副作用探测（绝不读取宿主全局 ~/.gemini）
    const hostHome = path.join(tmpRoot, "host-home");
    const dataDir = path.join(tmpRoot, "chisabot-data");
    // 在宿主全局 ~/.gemini 放置一个有效 token，验证隔离实例绝不会误读它
    const hostAcpDir = path.join(hostHome, ".gemini", "antigravity-acp");
    fs.mkdirSync(hostAcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(hostAcpDir, "acp_token.json"),
      JSON.stringify({ token: "host-secret-token" }),
    );

    const baseHostEnv = {
      USERPROFILE: hostHome,
      HOME: hostHome,
      CHISABOT_AGENT_DATA_DIR: dataDir,
      ANTIGRAVITY_LEAK: "from-host",
      agy_host_var: "from-host-lower",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
    };
    const instanceSpec = {
      id: "inst_01/bad:chars",
      slug: "work-agy",
      driver: "antigravity",
      config: { fixProxy: true },
      env: { HTTP_PROXY: "127.0.0.1:7890", CUSTOM_FLAG: "yes" },
    };

    const iso = resolveAntigravityIsolation(instanceSpec, baseHostEnv);
    assert.equal(
      iso.homeDir,
      path.join(dataDir, "agent-homes", "antigravity", "inst_01-bad-chars"),
    );
    assert.equal(iso.geminiDir, path.join(iso.homeDir, ".gemini"));
    assert.equal(iso.env.HOME, iso.homeDir);
    assert.equal(iso.env.USERPROFILE, iso.homeDir);
    assert.equal(iso.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE, "1");
    assert.equal(iso.env.AGY_CLI_DISABLE_AUTO_UPDATE, "1");
    assert.equal(iso.env.ANTIGRAVITY_LEAK, undefined);
    assert.equal(iso.env.agy_host_var, undefined);
    assert.equal(iso.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(iso.env.ELECTRON_NO_ATTACH_CONSOLE, undefined);
    assert.equal(iso.env.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(iso.env.CUSTOM_FLAG, "yes");
    if (win) {
      assert.equal(iso.env.APPDATA, path.join(iso.homeDir, "AppData", "Roaming"));
      assert.equal(iso.env.LOCALAPPDATA, path.join(iso.homeDir, "AppData", "Local"));
    } else {
      assert.equal(iso.env.XDG_CONFIG_HOME, path.join(iso.homeDir, ".config"));
      assert.equal(iso.env.XDG_DATA_HOME, path.join(iso.homeDir, ".local", "share"));
      assert.equal(iso.env.XDG_CACHE_HOME, path.join(iso.homeDir, ".cache"));
    }
    assert.deepEqual(iso.acpExtraArgs, [
      "--gemini-dir",
      iso.geminiDir,
      "--app-data-dir",
      "antigravity-cli",
      "--disable-telemetry",
    ]);

    // 宿主 ~/.gemini 有 token 但隔离目录为空 -> 必须为未登录
    assert.equal(
      inspectManagedAntigravityAuth(instanceSpec, baseHostEnv).authenticated,
      null,
    );
    // 实例显式配了 GEMINI_API_KEY -> 已配置 API Key
    assert.equal(
      inspectManagedAntigravityAuth(
        { ...instanceSpec, env: { GEMINI_API_KEY: "dummy-placeholder" } },
        baseHostEnv,
      ).authLabel,
      "已配置 API Key",
    );

    // 隔离目录中空对象 token 不视为已认证
    const isoCliDir = path.join(iso.geminiDir, "antigravity-cli");
    fs.mkdirSync(isoCliDir, { recursive: true });
    fs.writeFileSync(path.join(isoCliDir, "cli_token.json"), "{}");
    assert.equal(
      inspectManagedAntigravityAuth(instanceSpec, baseHostEnv).authenticated,
      null,
    );

    // 隔离目录写入有效 token + settings -> Google 账号
    fs.writeFileSync(
      path.join(isoCliDir, "cli_token.json"),
      JSON.stringify({ token: "iso-stub" }),
    );
    fs.writeFileSync(
      path.join(isoCliDir, "settings.json"),
      JSON.stringify({ auth: { type: "oauth-personal" } }),
    );
    const tokenAuth = inspectManagedAntigravityAuth(instanceSpec, baseHostEnv);
    assert.equal(tokenAuth.authenticated, true);
    assert.equal(tokenAuth.authLabel, "Google 账号");

    // chisabot-auth.json 优先提供邮箱标签
    fs.writeFileSync(
      path.join(isoCliDir, "chisabot-auth.json"),
      JSON.stringify({
        email: "dev@example.com",
        loggedInAt: new Date().toISOString(),
        method: "oauth-oob",
      }),
    );
    const metaAuth = inspectManagedAntigravityAuth(instanceSpec, baseHostEnv);
    assert.equal(metaAuth.authenticated, true);
    assert.equal(metaAuth.authLabel, "Google · dev@example.com");
    assert.equal(metaAuth.email, "dev@example.com");
  } finally {
    clearWhichCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("antigravity managed installer: SHA-512 verify, tamper reject, allowlist, cancel zero-residue staging, atomic active.json & version pruning", async () => {
  const crypto = require("node:crypto");
  const http = require("node:http");
  const {
    installManagedAntigravity,
    readManagedAntigravityInfo,
    getAntigravityRuntimeStatus,
    resolveAntigravityToolsDir,
    resolveManifestPlatform,
    assertAllowedUrl,
    auditTarListing,
  } = require("../src/agent-runtime/antigravity-managed");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-agy-inst-"));
  const dataDir = path.join(tmpRoot, "chisabot-data");
  const customEnv = { CHISABOT_AGENT_DATA_DIR: dataDir };
  const platSpec = resolveManifestPlatform();
  assert.equal(platSpec.supported, true);

  // 1. 验证默认生产白名单严格拦截非官方域名与非官方路径前缀
  assert.throws(
    () => assertAllowedUrl("https://evil.example.com/manifests/windows_amd64.json", "manifest"),
    /非官方 Manifest/,
  );
  assert.throws(
    () => assertAllowedUrl("https://storage.googleapis.com/other-bucket/cli.exe", "download"),
    /非官方下载源/,
  );
  assert.doesNotThrow(() =>
    assertAllowedUrl(
      "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16/windows-x64/cli_windows_x64.exe",
      "download",
    ),
  );

  // 2. 验证 tar 安全审计（拒绝绝对路径、..、symlink、hardlink，仅放行 antigravity）
  assert.equal(
    auditTarListing(
      "-rwxr-xr-x 0/0 1024 2026-11-24 12:00 ./antigravity\n",
      "./antigravity\n",
    ),
    "./antigravity",
  );
  assert.throws(
    () => auditTarListing("lrwxrwxrwx 0/0 0 2026-11-24 12:00 antigravity -> /etc/passwd\n", "antigravity\n"),
    /非普通文件|符号链接/,
  );
  assert.throws(
    () => auditTarListing("hrwxr-xr-x 0/0 0 2026-11-24 12:00 antigravity link to /bin/sh\n", "antigravity\n"),
    /非普通文件|硬链接/,
  );
  assert.throws(
    () => auditTarListing("-rwxr-xr-x 0/0 10 2026-11-24 12:00 ../antigravity\n", "../antigravity\n"),
    /路径穿越/,
  );
  assert.throws(
    () => auditTarListing("-rwxr-xr-x 0/0 10 2026-11-24 12:00 /usr/bin/antigravity\n", "/usr/bin/antigravity\n"),
    /绝对路径/,
  );

  // 准备真实测试载荷（Windows 直下 exe 字节；Unix 用 tar 打包真实 .tar.gz）
  const makePayload = (label) => {
    if (platSpec.archiveType === "exe") {
      return Buffer.from(`MOCK_AGY_BINARY_${label}_${"x".repeat(4096)}`);
    }
    const packDir = fs.mkdtempSync(path.join(tmpRoot, "pack-"));
    const binPath = path.join(packDir, "antigravity");
    fs.writeFileSync(binPath, `#!/bin/sh\necho "${label}"\n`, { mode: 0o755 });
    const tgzPath = path.join(tmpRoot, `payload-${label}.tar.gz`);
    execFileSync("tar", ["-czf", tgzPath, "-C", packDir, "antigravity"]);
    return fs.readFileSync(tgzPath);
  };

  let activeManifest = null;
  const payloads = new Map();
  let slowMode = false;
  let redirectEvil = false;

  const server = http.createServer((req, res) => {
    if (req.url === `/manifests/${platSpec.manifestPlatform}.json`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(activeManifest));
      return;
    }
    if (req.url === "/redirect-evil") {
      res.writeHead(302, { Location: "http://evil.invalid/bad.exe" });
      res.end();
      return;
    }
    const body = payloads.get(req.url);
    if (body) {
      if (redirectEvil) {
        res.writeHead(302, { Location: "http://evil.invalid/hijack.exe" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
      });
      if (slowMode) {
        res.write(body.subarray(0, 64));
        const t = setTimeout(() => {
          if (!res.destroyed) res.end(body.subarray(64));
        }, 5000);
        res.on("close", () => clearTimeout(t));
        return;
      }
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const toolsDir = resolveAntigravityToolsDir(customEnv);

  const registerRelease = (version, tamperSha = false) => {
    const buf = makePayload(version);
    const sha512 = crypto.createHash("sha512").update(buf).digest("hex");
    const route = `/downloads/${version}`;
    payloads.set(route, buf);
    activeManifest = {
      version,
      url: `${baseUrl}${route}`,
      sha512: tamperSha ? "0".repeat(128) : sha512,
    };
    return sha512;
  };

  try {
    // 3. 正常安装 v1.5.15 + 进度阶段上报 + active.json 落盘 + staging 零残留
    const sha15 = registerRelease("1.5.15");
    const stages = [];
    const res15 = await installManagedAntigravity({
      jobId: "job-15",
      customEnv,
      manifestBaseUrl: baseUrl,
      allowedHosts: ["127.0.0.1"],
      onProgress: (p) => stages.push(p.stage),
    });
    assert.equal(res15.ok, true);
    assert.equal(res15.version, "1.5.15");
    assert.equal(fs.existsSync(res15.binaryPath), true);
    for (const s of ["checking", "downloading", "verifying", "extracting", "activating"]) {
      assert.ok(stages.includes(s), `missing progress stage ${s}: ${JSON.stringify(stages)}`);
    }
    const info15 = readManagedAntigravityInfo(customEnv);
    assert.equal(info15.version, "1.5.15");
    assert.equal(info15.sha512, sha15);
    assert.deepEqual(fs.readdirSync(path.join(toolsDir, "staging")), []);

    // 4. 连续升级到 v1.5.16 与 v1.5.17，验证 active.json 原子切换且仅保留最近 2 个版本
    registerRelease("1.5.16");
    await installManagedAntigravity({
      jobId: "job-16",
      customEnv,
      manifestBaseUrl: baseUrl,
      allowedHosts: ["127.0.0.1"],
    });
    // 稍微拉大 mtime 间隔确保 1.5.16 新于 1.5.15
    const nowSec = Date.now() / 1000;
    fs.utimesSync(path.join(toolsDir, "versions", "1.5.15"), nowSec - 60, nowSec - 60);
    fs.utimesSync(path.join(toolsDir, "versions", "1.5.16"), nowSec - 10, nowSec - 10);

    registerRelease("1.5.17");
    await installManagedAntigravity({
      jobId: "job-17",
      customEnv,
      manifestBaseUrl: baseUrl,
      allowedHosts: ["127.0.0.1"],
    });
    assert.equal(readManagedAntigravityInfo(customEnv).version, "1.5.17");
    const keptVersions = fs.readdirSync(path.join(toolsDir, "versions")).sort();
    assert.deepEqual(keptVersions, ["1.5.16", "1.5.17"]);

    // 5. SHA-512 篡改失败：中止安装、不破坏旧 active.json、staging 零残留
    registerRelease("1.5.18", true);
    await assert.rejects(
      () =>
        installManagedAntigravity({
          jobId: "job-tamper",
          customEnv,
          manifestBaseUrl: baseUrl,
          allowedHosts: ["127.0.0.1"],
        }),
      /SHA-512/,
    );
    assert.equal(readManagedAntigravityInfo(customEnv).version, "1.5.17");
    assert.deepEqual(fs.readdirSync(path.join(toolsDir, "staging")), []);

    // 6. 重定向跳出白名单域名被严格拦截，且 staging 零残留
    registerRelease("1.5.19");
    redirectEvil = true;
    await assert.rejects(
      () =>
        installManagedAntigravity({
          jobId: "job-redirect",
          customEnv,
          manifestBaseUrl: baseUrl,
          allowedHosts: ["127.0.0.1"],
        }),
      /白名单/,
    );
    redirectEvil = false;
    assert.deepEqual(fs.readdirSync(path.join(toolsDir, "staging")), []);

    // 7. 下载中途取消：立即中止且 staging 零残留
    slowMode = true;
    const ac = new AbortController();
    const cancelPromise = installManagedAntigravity({
      jobId: "job-cancel",
      customEnv,
      manifestBaseUrl: baseUrl,
      allowedHosts: ["127.0.0.1"],
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 120);
    await assert.rejects(
      () => cancelPromise,
      (err) => err?.cancelled === true || err?.name === "AbortError",
    );
    slowMode = false;
    assert.deepEqual(fs.readdirSync(path.join(toolsDir, "staging")), []);

    // 8. getAntigravityRuntimeStatus 查询托管状态与最新版本检查
    const status = await getAntigravityRuntimeStatus({
      customEnv,
      checkLatest: true,
      manifestBaseUrl: baseUrl,
      allowedHosts: ["127.0.0.1"],
    });
    assert.equal(status.installed, true);
    assert.equal(status.source, "managed");
    assert.equal(status.managedInstalled, true);
    assert.equal(status.managedVersion, "1.5.17");
    assert.equal(status.latestVersion, "1.5.19");
    assert.equal(status.updateAvailable, true);
  } finally {
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("antigravity OOB login, submitCode, logout, cancel & runtime protocol end-to-end", async () => {
  const {
    resolveAntigravityIsolation,
    inspectManagedAntigravityAuth,
    logoutAntigravityInstance,
  } = require("../src/agent-runtime/antigravity-managed");
  const win = process.platform === "win32";
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-agy-login-"));
  const dataDir = path.join(tmpRoot, "chisabot-data");
  const hostHome = path.join(tmpRoot, "host-home");
  fs.mkdirSync(path.join(hostHome, ".gemini", "antigravity-cli"), { recursive: true });
  // 在宿主全局目录写一个保护文件，验证 logout 绝不会触碰它
  const hostSentinel = path.join(hostHome, ".gemini", "antigravity-cli", "cli_token.json");
  fs.writeFileSync(hostSentinel, JSON.stringify({ token: "host-untouched" }));

  const customEnv = {
    USERPROFILE: hostHome,
    HOME: hostHome,
    CHISABOT_AGENT_DATA_DIR: dataDir,
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };

  const mockScriptJs = path.join(tmpRoot, "mock-agy-login.js");
  fs.writeFileSync(
    mockScriptJs,
    `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("1.5.16");
  process.exit(0);
}
if (args[0] === "acp" && args[1] === "--login") {
  const gIdx = args.indexOf("--gemini-dir");
  const aIdx = args.indexOf("--app-data-dir");
  if (
    process.env.ANTIGRAVITY_REMOTE_OOB_AUTH !== "1" ||
    process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE !== "1" ||
    process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== "1" ||
    gIdx < 0 ||
    aIdx < 0 ||
    args[aIdx + 1] !== "antigravity-cli"
  ) {
    process.stderr.write("BAD_ISOLATION_ARGS\\n");
    process.exit(2);
  }
  const geminiDir = args[gIdx + 1];
  process.stdout.write(
    "Open this link in a browser to log in with Google:\\n\\n" +
    "  https://accounts.google.com/o/oauth2/auth?client_id=mock&state=s123&response_type=code\\n\\n" +
    "Then paste the authorization code and press Enter:\\n"
  );
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\\n");
    if (nl < 0) return;
    const code = buf.slice(0, nl).trim();
    if (code === "VALID_CODE_42") {
      const cliDir = path.join(geminiDir, "antigravity-cli");
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(path.join(cliDir, "cli_token.json"), JSON.stringify({ access_token: "mock-tok" }));
      process.stdout.write("Logged in as alice@example.com\\n");
      process.exit(0);
    }
    process.stderr.write("INVALID_CODE\\n");
    process.exit(1);
  });
}
`,
  );

  const mockWrapper = path.join(tmpRoot, win ? "mock-agy.cmd" : "mock-agy");
  if (win) {
    fs.writeFileSync(
      mockWrapper,
      `@echo off\r\n"${process.execPath}" "${mockScriptJs}" %*\r\n`,
    );
  } else {
    fs.writeFileSync(
      mockWrapper,
      `#!/bin/sh\nexec "${process.execPath}" "${mockScriptJs}" "$@"\n`,
      { mode: 0o755 },
    );
  }

  const sent = [];
  const runtime = createAgentRuntime({
    send: (m) => {
      sent.push(m);
      return true;
    },
    antigravityOptions: { customEnv },
  });

  const inst = {
    id: "agy-inst-1",
    slug: "agy-1",
    driver: "antigravity",
    config: { commandPath: mockWrapper },
    env: {},
  };

  try {
    // 1. agent_runtime_status 协议回包
    assert.equal(
      runtime.handle({
        type: "agent_runtime_status",
        reqId: "st-1",
        driver: "antigravity",
      }),
      true,
    );
    const tSt = Date.now();
    while (!sent.some((m) => m.type === "agent_runtime_status_result" && m.reqId === "st-1") && Date.now() - tSt < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const stRes = sent.find((m) => m.type === "agent_runtime_status_result" && m.reqId === "st-1");
    assert.equal(stRes?.ok, true);
    assert.equal(stRes.status.supported, true);

    // 2. agent_runtime_login_start -> awaiting_auth -> agent_runtime_login_submit -> login_result
    assert.equal(
      runtime.handle({
        type: "agent_runtime_login_start",
        sessionId: "login-1",
        driver: "antigravity",
        instance: inst,
      }),
      true,
    );
    const tAuth = Date.now();
    while (
      !sent.some(
        (m) =>
          m.type === "agent_runtime_login_event" &&
          m.sessionId === "login-1" &&
          m.stage === "awaiting_auth",
      ) &&
      Date.now() - tAuth < 8000
    ) {
      await new Promise((r) => setTimeout(r, 30));
    }
    const authEv = sent.find(
      (m) =>
        m.type === "agent_runtime_login_event" &&
        m.sessionId === "login-1" &&
        m.stage === "awaiting_auth",
    );
    assert.ok(authEv, JSON.stringify(sent));
    assert.match(authEv.authUrl || "", /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth/);

    // 提交授权码
    assert.equal(
      runtime.handle({
        type: "agent_runtime_login_submit",
        sessionId: "login-1",
        code: "VALID_CODE_42",
      }),
      true,
    );
    const tDone = Date.now();
    while (
      !sent.some(
        (m) => m.type === "agent_runtime_login_result" && m.sessionId === "login-1",
      ) &&
      Date.now() - tDone < 8000
    ) {
      await new Promise((r) => setTimeout(r, 30));
    }
    const loginRes = sent.find(
      (m) => m.type === "agent_runtime_login_result" && m.sessionId === "login-1",
    );
    assert.equal(loginRes?.ok, true, JSON.stringify(loginRes));
    assert.equal(loginRes.authenticated, true);
    assert.equal(loginRes.email, "alice@example.com");
    assert.equal(loginRes.authLabel, "Google · alice@example.com");

    // 验证 chisabot-auth.json 落盘且不含敏感 token/code/authUrl
    const iso = resolveAntigravityIsolation(inst, customEnv);
    const metaPath = path.join(iso.geminiDir, "antigravity-cli", "chisabot-auth.json");
    const metaRaw = fs.readFileSync(metaPath, "utf8");
    const meta = JSON.parse(metaRaw);
    assert.equal(meta.email, "alice@example.com");
    assert.equal(meta.method, "oauth-oob");
    assert.equal(metaRaw.includes("VALID_CODE_42"), false);
    assert.equal(metaRaw.includes("mock-tok"), false);

    // 验证隔离态探活识别到 Google · alice@example.com
    const authState = inspectManagedAntigravityAuth(inst, customEnv);
    assert.equal(authState.authenticated, true);
    assert.equal(authState.authLabel, "Google · alice@example.com");

    // 在隔离目录放一个非凭据文件 settings.json，验证 logout 保留它且清除凭据
    const keepSettings = path.join(iso.geminiDir, "antigravity-cli", "settings.json");
    fs.writeFileSync(keepSettings, JSON.stringify({ theme: "dark" }));

    // 3. agent_runtime_logout 清理隔离凭据且不动宿主 ~/.gemini 与非凭据文件
    assert.equal(
      runtime.handle({
        type: "agent_runtime_logout",
        reqId: "logout-1",
        driver: "antigravity",
        instance: inst,
      }),
      true,
    );
    const tOut = Date.now();
    while (
      !sent.some((m) => m.type === "agent_runtime_logout_result" && m.reqId === "logout-1") &&
      Date.now() - tOut < 5000
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const logoutRes = sent.find(
      (m) => m.type === "agent_runtime_logout_result" && m.reqId === "logout-1",
    );
    assert.equal(logoutRes?.ok, true);
    assert.equal(fs.existsSync(metaPath), false);
    assert.equal(
      fs.existsSync(path.join(iso.geminiDir, "antigravity-cli", "cli_token.json")),
      false,
    );
    assert.equal(fs.existsSync(keepSettings), true);
    assert.equal(fs.existsSync(hostSentinel), true);
    assert.equal(inspectManagedAntigravityAuth(inst, customEnv).authenticated, null);

    // 也直接验证 logoutAntigravityInstance 幂等性
    const idempotentLogout = await logoutAntigravityInstance({
      instance: inst,
      baseEnv: customEnv,
    });
    assert.equal(idempotentLogout.ok, true);
    assert.equal(idempotentLogout.removedCount, 0);

    // 4. agent_runtime_login_cancel 中止进行中的登录进程并回报 cancelled: true
    runtime.handle({
      type: "agent_runtime_login_start",
      sessionId: "login-cancel-1",
      driver: "antigravity",
      instance: inst,
    });
    const tWait2 = Date.now();
    while (
      !sent.some(
        (m) =>
          m.type === "agent_runtime_login_event" &&
          m.sessionId === "login-cancel-1" &&
          m.stage === "awaiting_auth",
      ) &&
      Date.now() - tWait2 < 8000
    ) {
      await new Promise((r) => setTimeout(r, 30));
    }
    runtime.handle({
      type: "agent_runtime_login_cancel",
      sessionId: "login-cancel-1",
    });
    const cancelRes = sent.find(
      (m) => m.type === "agent_runtime_login_result" && m.sessionId === "login-cancel-1",
    );
    assert.equal(cancelRes?.ok, false);
    assert.equal(cancelRes?.cancelled, true);

    // 5. 回归验证：向不存在/已失效的 sessionId 提交授权码时，立即回发 agent_runtime_login_result（避免服务端卡死在 submitting）
    assert.equal(
      runtime.handle({
        type: "agent_runtime_login_submit",
        sessionId: "login-missing-session",
        code: "ORPHAN_CODE",
      }),
      true,
    );
    const missingSubmitRes = sent.find(
      (m) =>
        m.type === "agent_runtime_login_result" &&
        m.sessionId === "login-missing-session",
    );
    assert.ok(missingSubmitRes, "missing session submit must emit agent_runtime_login_result immediately");
    assert.equal(missingSubmitRes.ok, false);
    assert.equal(missingSubmitRes.authenticated, false);
    assert.equal(missingSubmitRes.cancelled, false);
    assert.equal(missingSubmitRes.homePath, null);
    assert.match(missingSubmitRes.error || "", /不存在或已结束/);
  } finally {
    runtime.stopAll();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("sessionId & continuable contract: external drivers avoid fake sess-<taskId>, resumable drivers propagate real IDs, builtin keeps sess-<taskId>", async () => {
  const win = process.platform === "win32";
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-sess-contract-"));
  const workDir = path.join(tmpRoot, "workspace");
  const binDir = path.join(tmpRoot, "bin");
  const dataDir = path.join(tmpRoot, "data");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const makeMockCli = (name, scriptBody) => {
    const jsPath = path.join(binDir, `${name}.js`);
    fs.writeFileSync(jsPath, `"use strict";\n${scriptBody}\n`);
    const wrapperPath = path.join(binDir, win ? `${name}.cmd` : name);
    if (win) {
      fs.writeFileSync(
        wrapperPath,
        `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`,
      );
    } else {
      fs.writeFileSync(
        wrapperPath,
        `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`,
        { mode: 0o755 },
      );
    }
    return wrapperPath;
  };

  const agyArgLog = path.join(tmpRoot, "agy-args.json");
  const mockAgy = makeMockCli(
    "mock-agy-cli",
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(agyArgLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write("antigravity cli fallback ok\\n");`,
  );

  const claudeArgLog = path.join(tmpRoot, "claude-args.json");
  const mockClaude = makeMockCli(
    "mock-claude-cli",
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(claudeArgLog)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "system", subtype: "init", model: "mock-claude", session_id: "claude-real-001" }));
console.log(JSON.stringify({ type: "result", subtype: "success", result: "claude ok", num_turns: 1 }));`,
  );

  const mockCodex = makeMockCli(
    "mock-codex-cli",
    `console.log(JSON.stringify({ type: "thread.started", thread_id: "thr_real_002" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex ok" } }));`,
  );

  const mockCustom = makeMockCli(
    "mock-custom-cli",
    `process.stdout.write("custom ok\\n");`,
  );

  const sent = [];
  let runtime;
  runtime = createAgentRuntime({
    send: (m) => {
      sent.push(m);
      if (m.type === "agent_llm") {
        setImmediate(() => {
          if (m.taskId === "task-builtin-fail-1") {
            runtime.handle({
              type: "agent_llm_result",
              taskId: m.taskId,
              reqId: m.reqId,
              ok: false,
              error: "mock llm failure",
            });
            return;
          }
          runtime.handle({
            type: "agent_llm_result",
            taskId: m.taskId,
            reqId: m.reqId,
            ok: true,
            content: [{ type: "text", text: "builtin ok" }],
          });
        });
      }
      return true;
    },
    antigravityOptions: {
      customEnv: { ...process.env, CHISABOT_AGENT_DATA_DIR: dataDir },
    },
  });

  const waitDone = async (taskId, fromIdx) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      const hit = sent
        .slice(fromIdx)
        .find((m) => m.type === "agent_done" && m.taskId === taskId);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for agent_done(${taskId})`);
  };

  try {
    // 1. Antigravity CLI 回退（--output-format text 无真 sessionId）：绝不伪造 sess-<taskId>，且 continuable: false
    const idx1 = sent.length;
    runtime.handle({
      type: "agent_run",
      taskId: "task-agy-cli-1",
      agent: "antigravity",
      prompt: "hello agy cli",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      timeoutMs: 15_000,
      instance: {
        id: "inst-agy-cli",
        slug: "agy-cli",
        driver: "antigravity",
        config: { commandPath: mockAgy, protocolMode: "cli" },
        env: { CHISABOT_AGENT_DATA_DIR: dataDir },
      },
    });
    const agyDone = await waitDone("task-agy-cli-1", idx1);
    const agyStarted = sent
      .slice(idx1)
      .find((m) => m.type === "agent_started" && m.taskId === "task-agy-cli-1");
    assert.equal(agyStarted?.sessionId, null);
    assert.equal(agyDone.ok, true, JSON.stringify(agyDone));
    assert.equal(agyDone.sessionId, null);
    assert.equal(agyDone.continuable, false);

    // 即使上层误传旧的伪造 sess-<taskId>，也不得传给 agy --resume 且仍上报 sessionId: null, continuable: false
    const idx1b = sent.length;
    runtime.handle({
      type: "agent_continue",
      taskId: "task-agy-cli-1",
      sessionId: "sess-task-agy-cli-1",
      agent: "antigravity",
      prompt: "follow up without real id",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      timeoutMs: 15_000,
      instance: {
        id: "inst-agy-cli",
        slug: "agy-cli",
        driver: "antigravity",
        config: { commandPath: mockAgy, protocolMode: "cli" },
        env: { CHISABOT_AGENT_DATA_DIR: dataDir },
      },
    });
    const agyContinueDone = await waitDone("task-agy-cli-1", idx1b);
    const agyContinueStarted = sent
      .slice(idx1b)
      .find((m) => m.type === "agent_started" && m.taskId === "task-agy-cli-1");
    const agyArgv = JSON.parse(fs.readFileSync(agyArgLog, "utf8"));
    assert.equal(agyContinueStarted?.sessionId, null);
    assert.equal(agyArgv.includes("--resume"), false);
    assert.equal(agyContinueDone.ok, true, JSON.stringify(agyContinueDone));
    assert.equal(agyContinueDone.sessionId, null);
    assert.equal(agyContinueDone.continuable, false);

    // 2. Claude CLI 返回真 session_id -> 上报真 ID 且 continuable: true，续接时携带 --resume
    const idx2 = sent.length;
    runtime.handle({
      type: "agent_run",
      taskId: "task-claude-real-1",
      agent: "claude",
      prompt: "hello claude",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      timeoutMs: 15_000,
      instance: {
        id: "inst-claude",
        slug: "claude-1",
        driver: "claude",
        config: { commandPath: mockClaude },
        env: {},
      },
    });
    const claudeDone = await waitDone("task-claude-real-1", idx2);
    const claudeStarted = sent
      .slice(idx2)
      .find((m) => m.type === "agent_started" && m.taskId === "task-claude-real-1");
    assert.equal(claudeStarted?.sessionId, null);
    assert.equal(claudeDone.ok, true, JSON.stringify(claudeDone));
    assert.equal(claudeDone.sessionId, "claude-real-001");
    assert.equal(claudeDone.continuable, true);

    const idx2b = sent.length;
    runtime.handle({
      type: "agent_continue",
      taskId: "task-claude-real-1",
      sessionId: "claude-real-001",
      agent: "claude",
      prompt: "continue claude",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      timeoutMs: 15_000,
      instance: {
        id: "inst-claude",
        slug: "claude-1",
        driver: "claude",
        config: { commandPath: mockClaude },
        env: {},
      },
    });
    const claudeContDone = await waitDone("task-claude-real-1", idx2b);
    const claudeContStarted = sent
      .slice(idx2b)
      .find((m) => m.type === "agent_started" && m.taskId === "task-claude-real-1");
    const claudeArgv = JSON.parse(fs.readFileSync(claudeArgLog, "utf8"));
    assert.equal(claudeContStarted?.sessionId, "claude-real-001");
    const resumeIdx = claudeArgv.indexOf("--resume");
    assert.ok(resumeIdx >= 0 && claudeArgv[resumeIdx + 1] === "claude-real-001");
    assert.equal(claudeContDone.sessionId, "claude-real-001");
    assert.equal(claudeContDone.continuable, true);

    // 3. Codex CLI 返回真 thread_id -> 上报该真 ID 且 continuable: true
    const idx3 = sent.length;
    runtime.handle({
      type: "agent_run",
      taskId: "task-codex-real-1",
      agent: "codex",
      prompt: "hello codex",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      timeoutMs: 15_000,
      instance: {
        id: "inst-codex",
        slug: "codex-1",
        driver: "codex",
        config: { commandPath: mockCodex },
        env: {},
      },
    });
    const codexDone = await waitDone("task-codex-real-1", idx3);
    const codexStarted = sent
      .slice(idx3)
      .find((m) => m.type === "agent_started" && m.taskId === "task-codex-real-1");
    assert.equal(codexStarted?.sessionId, null);
    assert.equal(codexDone.ok, true, JSON.stringify(codexDone));
    assert.equal(codexDone.sessionId, "thr_real_002");
    assert.equal(codexDone.continuable, true);

    // 4. 不支持 --resume 的外部驱动（如 custom）-> sessionId: null, continuable: false
    const idx4 = sent.length;
    runtime.handle({
      type: "agent_run",
      taskId: "task-custom-1",
      agent: "custom",
      prompt: "hello custom",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      timeoutMs: 15_000,
      instance: {
        id: "inst-custom",
        slug: "custom-1",
        driver: "custom",
        config: { commandPath: mockCustom },
        env: {},
      },
    });
    const customDone = await waitDone("task-custom-1", idx4);
    const customStarted = sent
      .slice(idx4)
      .find((m) => m.type === "agent_started" && m.taskId === "task-custom-1");
    assert.equal(customStarted?.sessionId, null);
    assert.equal(customDone.ok, true, JSON.stringify(customDone));
    assert.equal(customDone.sessionId, null);
    assert.equal(customDone.continuable, false);

    // 5. 外部驱动失败分支（catch）也不得泄漏伪造 sess-<taskId>
    const idx5 = sent.length;
    runtime.handle({
      type: "agent_run",
      taskId: "task-claude-fail-1",
      agent: "claude",
      prompt: "fail missing bin",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      timeoutMs: 15_000,
      instance: {
        id: "inst-claude-missing",
        slug: "claude-missing",
        driver: "claude",
        config: { commandPath: path.join(tmpRoot, "does-not-exist-claude") },
        env: {
          PATH: "",
          Path: "",
          USERPROFILE: tmpRoot,
          HOME: tmpRoot,
        },
      },
    });
    const failDone = await waitDone("task-claude-fail-1", idx5);
    assert.equal(failDone.ok, false);
    assert.match(failDone.error || "", /没有找到可执行文件/);
    assert.equal(failDone.sessionId, null);
    assert.equal(failDone.continuable, false);

    // 6. builtin 驱动保持 sess-<taskId> 与 continuable: true（含成功与启动后失败）
    const idx6 = sent.length;
    runtime.handle({
      type: "agent_run",
      taskId: "task-builtin-keep-1",
      agent: "builtin",
      prompt: "hello builtin",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      builtinModel: { kind: "server" },
      timeoutMs: 15_000,
    });
    const builtinDone = await waitDone("task-builtin-keep-1", idx6);
    const builtinStarted = sent
      .slice(idx6)
      .find((m) => m.type === "agent_started" && m.taskId === "task-builtin-keep-1");
    assert.equal(builtinStarted?.sessionId, "sess-task-builtin-keep-1");
    assert.equal(builtinDone.ok, true, JSON.stringify(builtinDone));
    assert.equal(builtinDone.sessionId, "sess-task-builtin-keep-1");
    assert.equal(builtinDone.continuable, true);

    const idx6b = sent.length;
    runtime.handle({
      type: "agent_run",
      taskId: "task-builtin-fail-1",
      agent: "builtin",
      prompt: "fail builtin after start",
      cwd: workDir,
      profile: "workspace",
      isolation: "none",
      network: true,
      roots: [workDir],
      skipPermissions: false,
      builtinModel: { kind: "server" },
      timeoutMs: 15_000,
    });
    const builtinFailDone = await waitDone("task-builtin-fail-1", idx6b);
    assert.equal(builtinFailDone.ok, false);
    assert.equal(builtinFailDone.sessionId, "sess-task-builtin-fail-1");
    assert.equal(builtinFailDone.continuable, true);
  } finally {
    runtime.stopAll();
    await runtime.cleanupSessions();
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("subagent-bridge: extracted asar scriptPath is shared consistently across mcpConfig, ACP, Codex, and CHISABOT_SUBAGENT_CLI", async () => {
  const {
    createSubagentBridge,
    MCP_STDIO_SCRIPT,
  } = require("../src/agent-runtime/subagent-bridge");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-asar-bridge-"));
  const fakeAsarDir = path.join(tmpRoot, "app.asar");
  const fakeAsarScript = path.join(fakeAsarDir, "subagent-mcp-stdio.js");
  fs.mkdirSync(fakeAsarDir, { recursive: true });
  const originalContent = fs.readFileSync(MCP_STDIO_SCRIPT, "utf8");
  fs.writeFileSync(fakeAsarScript, originalContent, "utf8");

  let asarBridge = null;
  let defaultBridge = null;
  try {
    asarBridge = await createSubagentBridge({
      taskId: "t-asar-bridge",
      depth: 0,
      maxDepth: 2,
      mcpStdioScript: fakeAsarScript,
      onSubcall: async () => ({}),
    });
    assert.ok(asarBridge);
    assert.equal(asarBridge.scriptPath.includes(".asar"), false);
    assert.notEqual(asarBridge.scriptPath, fakeAsarScript);
    assert.equal(fs.readFileSync(asarBridge.scriptPath, "utf8"), originalContent);

    const claudeCfg = JSON.parse(
      fs.readFileSync(asarBridge.claudeMcpConfigPath, "utf8"),
    );
    const claudeScriptArg = claudeCfg.mcpServers.chisabot_subagents.args[0];
    assert.equal(claudeScriptArg, asarBridge.scriptPath);
    assert.equal(asarBridge.acpMcpServers[0].args[0], asarBridge.scriptPath);
    assert.ok(
      asarBridge.codexConfigArgs.some((arg) =>
        arg.includes(JSON.stringify(asarBridge.scriptPath)),
      ),
    );
    assert.equal(
      asarBridge.codexConfigArgs.some((arg) => arg.includes(".asar")),
      false,
    );
    assert.ok(
      asarBridge.env.CHISABOT_SUBAGENT_CLI.includes(`"${asarBridge.scriptPath}"`),
      `expected CHISABOT_SUBAGENT_CLI to use extracted scriptPath: ${asarBridge.env.CHISABOT_SUBAGENT_CLI}`,
    );
    assert.equal(
      asarBridge.env.CHISABOT_SUBAGENT_CLI.includes(".asar"),
      false,
    );

    defaultBridge = await createSubagentBridge({
      taskId: "t-default-bridge",
      depth: 0,
      maxDepth: 2,
      onSubcall: async () => ({}),
    });
    assert.ok(defaultBridge);
    const defaultClaudeCfg = JSON.parse(
      fs.readFileSync(defaultBridge.claudeMcpConfigPath, "utf8"),
    );
    assert.equal(
      defaultClaudeCfg.mcpServers.chisabot_subagents.args[0],
      defaultBridge.scriptPath,
    );
    assert.ok(
      defaultBridge.env.CHISABOT_SUBAGENT_CLI.includes(
        `"${defaultBridge.scriptPath}"`,
      ),
    );
  } finally {
    if (asarBridge) await asarBridge.close();
    if (defaultBridge) await defaultBridge.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("pc/src/agent-runtime is self-contained without parent-directory requires", () => {
  const runtimeDir = path.join(__dirname, "..", "src", "agent-runtime");
  const files = fs
    .readdirSync(runtimeDir)
    .filter((name) => name.endsWith(".js"));
  assert.ok(files.includes("proxy.js"));
  for (const name of files) {
    const content = fs.readFileSync(path.join(runtimeDir, name), "utf8");
    const parentRequire = content.match(
      /require\(\s*["']\.\.\/[^"']+["']\s*\)/,
    );
    assert.equal(
      parentRequire,
      null,
      `agent-runtime/${name} must not require outside pc/src/agent-runtime: ${parentRequire?.[0]}`,
    );
  }
});



