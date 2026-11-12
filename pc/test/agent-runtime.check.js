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
  let cleaned = false;
  const sent = [];
  const runtime = createAgentRuntime({ send: (message) => { sent.push(message); return true; } });
  sandbox.prepare = () => new Promise((resolve) => { prepared = resolve; });
  try {
    runtime.handle({ type: "agent_run", taskId: "cancel-prep", agent: "builtin", prompt: "unused", cwd: os.tmpdir(), profile: "readonly", roots: [os.tmpdir()], isolation: "none", timeoutMs: 5000 });
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
    approve: async (operation, summary) => {
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
  assert.deepEqual(c.result(), { summary: "完成", isError: false });
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
  const runtime = createAgentRuntime({ send: (m) => (sent.push(m), true) });
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
  const done = sent.find((m) => m.type === "agent_done" && m.taskId === "task-acp-1");
  assert.ok(done, JSON.stringify(sent.slice(-4)));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.summary, /codebuddy/);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "hello acp\n");

  // 3. 验证递归深度上限拦截（depth >= maxDepth 时不启动互调桥）
  const { createSubagentBridge } = require("../src/agent-runtime/subagent-bridge");
  const blockedBridge = await createSubagentBridge({ taskId: "deep", depth: 3, maxDepth: 3, onSubcall: async () => ({}) });
  assert.equal(blockedBridge, null);
});

