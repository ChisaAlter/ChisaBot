"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createOps } = require("../src/agent/ops");
const { gitIsRead, globToRegExp } = require("../src/agent/code-ops");
const { unifiedDiff, parsePatch, applyHunks } = require("../src/agent/textdiff");
const { createNodeAgent, capabilityFor } = require("../src/agent/core");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbcode-"));
const root = path.join(tmp, "proj");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
fs.writeFileSync(path.join(root, "src/a.js"), "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n");
fs.writeFileSync(path.join(root, "src/b.ts"), "export const twice = (x: number) => x * 2;\n// TODO fix\n// TODO again\n");
fs.writeFileSync(path.join(root, "node_modules/x/index.js"), "TODO hidden\n");
fs.writeFileSync(path.join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
fs.writeFileSync(path.join(tmp, "outside.txt"), "secret\n");
const big = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
fs.writeFileSync(path.join(root, "big.txt"), big);
const ops = createOps({ clientVersion: "test" });
const ctx = { allowedRoots: [root] };
const full = { allowedRoots: [root], fullAccess: true };

test("features list includes coding ops", () => {
  for (const op of ["search", "edit_file", "apply_patch", "git", "exec_start", "exec_poll", "exec_kill", "process_list", "file_upload", "file_download", "activity"])
    assert.ok(ops.features.includes(op), op);
});

test("search content with line numbers, skips node_modules, glob filter", async () => {
  const r = await ops.run("search", { pattern: "TODO" }, ctx);
  assert.equal(r.count, 2);
  assert.deepEqual(r.matches.map((m) => `${m.file}:${m.line}`), ["src/b.ts:2", "src/b.ts:3"]);
  const withIgnored = await ops.run("search", { pattern: "TODO", includeIgnored: true }, ctx);
  assert.equal(withIgnored.count, 3);
  const files = await ops.run("search", { glob: "*.js" }, ctx);
  assert.deepEqual(files.files, ["src/a.js"]);
  const scoped = await ops.run("search", { pattern: "a - b", literal: true, glob: "src/**/*.js" }, ctx);
  assert.equal(scoped.matches[0].line, 2);
  await assert.rejects(ops.run("search", { pattern: "x", path: tmp }, ctx), /允许的文件夹/);
});

test("glob regexp", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/c.ts"));
  assert.ok(globToRegExp("*.{js,ts}").test("x.ts"));
  assert.ok(!globToRegExp("*.js").test("a/x.js"));
});

test("read_file with line range returns numbered lines and totals", async () => {
  const r = await ops.run("read_file", { path: "big.txt", startLine: 100, endLine: 102 }, ctx);
  assert.equal(r.totalLines, 5000);
  assert.equal(r.startLine, 100);
  assert.equal(r.endLine, 102);
  assert.equal(r.more, true);
  assert.equal(r.content, "100│line 100\n101│line 101\n102│line 102");
  const capped = await ops.run("read_file", { path: "big.txt", startLine: 1, endLine: 9999 }, ctx);
  assert.equal(capped.endLine, 2000);
});

test("edit_file: unique replace returns diff + backup", async () => {
  const r = await ops.run("edit_file", { path: "src/a.js", edits: [{ oldText: "return a - b;", newText: "return a + b;" }] }, ctx);
  assert.equal(r.changed, true);
  assert.match(r.diff, /-  return a - b;\n\+  return a \+ b;/);
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.ok(fs.existsSync(r.backup));
  assert.match(fs.readFileSync(path.join(root, "src/a.js"), "utf8"), /a \+ b/);
});

test("edit_file refuses ambiguous and missing, writes nothing", async () => {
  const before = fs.readFileSync(path.join(root, "src/b.ts"), "utf8");
  await assert.rejects(ops.run("edit_file", { path: "src/b.ts", edits: [{ oldText: "// TODO", newText: "// DONE" }] }, ctx), /出现了 2 次/);
  await assert.rejects(
    ops.run("edit_file", { path: "src/b.ts", edits: [{ oldText: "twice", newText: "double" }, { oldText: "nope-not-here", newText: "" }] }, ctx),
    /第 2 处编辑.*找不到/,
  );
  assert.equal(fs.readFileSync(path.join(root, "src/b.ts"), "utf8"), before);
  const all = await ops.run("edit_file", { path: "src/b.ts", edits: [{ oldText: "// TODO", newText: "// DONE", replaceAll: true }] }, ctx);
  assert.equal(all.edits[0].replaced, 2);
});

test("edit_file keeps CRLF line endings", async () => {
  await ops.run("edit_file", { path: "crlf.txt", edits: [{ oldText: "one\ntwo", newText: "uno\ndos" }] }, ctx);
  assert.equal(fs.readFileSync(path.join(root, "crlf.txt"), "utf8"), "uno\r\ndos\r\nthree\r\n");
});

test("apply_patch multi-file incl. new file, atomic on failure", async () => {
  const patch = [
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,3 +1,3 @@",
    "-function add(a, b) {",
    "+function add(a, b = 0) {",
    "   return a + b;",
    " }",
    "--- /dev/null",
    "+++ b/src/new.js",
    "@@ -0,0 +1,2 @@",
    "+// new",
    "+module.exports = 1;",
    "",
  ].join("\n");
  const r = await ops.run("apply_patch", { patch, cwd: root }, ctx);
  assert.equal(r.files.length, 2);
  assert.equal(fs.readFileSync(path.join(root, "src/new.js"), "utf8"), "// new\nmodule.exports = 1;\n");
  assert.match(fs.readFileSync(path.join(root, "src/a.js"), "utf8"), /b = 0/);
  const bad = patch.replace("+function add(a, b = 0) {", "+X").replace("-function add(a, b) {", "-nope");
  const snapshot = fs.readFileSync(path.join(root, "src/a.js"), "utf8");
  await assert.rejects(ops.run("apply_patch", { patch: bad.replace("/dev/null\n+++ b/src/new.js", "/dev/null\n+++ b/src/new2.js"), cwd: root }, ctx), /对不上/);
  assert.equal(fs.readFileSync(path.join(root, "src/a.js"), "utf8"), snapshot);
  assert.ok(!fs.existsSync(path.join(root, "src/new2.js")));
});

test("diff + patch roundtrip", () => {
  const a = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
  const b = "a\nB\nc\nd\ne\nf\ng\nh\nI\nj\nk";
  const d = unifiedDiff(a, b, { path: "x" });
  assert.equal(applyHunks(a, parsePatch(d)[0].hunks), b);
});

test("shell sessions keep cwd and env between calls", async () => {
  const win = process.platform === "win32";
  const r1 = await ops.run("shell", { command: win ? "Set-Location src; $env:CB_TEST_VAR='hello'" : "cd src && export CB_TEST_VAR=hello", session: "s1" }, ctx);
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.cwd, path.join(root, "src"));
  const r2 = await ops.run("shell", { command: win ? 'Write-Output "$env:CB_TEST_VAR $((Get-Location).Path)"' : 'echo "$CB_TEST_VAR $(pwd)"', session: "s1" }, ctx);
  assert.equal(r2.stdout.trim(), `hello ${path.join(root, "src")}`);
  const list = await ops.run("shell_session", { action: "list" }, ctx);
  assert.equal(list.sessions[0].name, "s1");
});

test("background exec: start, poll with offset, kill", async () => {
  const r = await ops.run("exec_start", { command: "echo start; sleep 0.3; echo middle; sleep 30", cwd: root, waitMs: 100 }, ctx);
  assert.match(r.jobId, /^job_/);
  assert.equal(r.status, "running");
  const p = await ops.run("exec_poll", { jobId: r.jobId, since: 0, waitMs: 2000 }, ctx);
  assert.match(p.output, /start/);
  const p2 = await ops.run("exec_poll", { jobId: r.jobId, since: p.nextOffset, waitMs: 2000 }, ctx);
  assert.ok(p.output.includes("middle") || p2.output.includes("middle"));
  const k = await ops.run("exec_kill", { jobId: r.jobId }, ctx);
  assert.equal(k.status, "killed");
  const done = await ops.run("exec_start", { command: "echo quick; exit 3", waitMs: 3000 }, ctx);
  assert.equal(done.status, "exited");
  assert.equal(done.exitCode, 3);
  assert.match(done.output, /quick/);
  const act = await ops.run("activity", {}, ctx);
  assert.ok(act.jobs.length >= 2);
});

test("elevated requires full access", async () => {
  await assert.rejects(ops.run("shell", { command: "id", elevated: true }, ctx), /完全访问/);
});

test("full access: any path; normal mode: roots only", async () => {
  await assert.rejects(ops.run("read_file", { path: path.join(tmp, "outside.txt") }, ctx), /允许的文件夹/);
  const r = await ops.run("read_file", { path: path.join(tmp, "outside.txt") }, full);
  assert.equal(r.content, "secret\n");
  const listing = await ops.run("list_files", { path: tmp }, full);
  assert.ok(listing.entries.some((e) => e.name === "outside.txt"));
  const s = await ops.run("search", { pattern: "secret", path: tmp }, full);
  assert.equal(s.count, 1);
});

test("upload + download in chunks", async () => {
  const data = Buffer.from("hello world, chunked");
  await ops.run("file_upload", { path: "up/f.bin", offset: 0, base64: data.subarray(0, 5).toString("base64") }, ctx);
  const done = await ops.run("file_upload", { path: "up/f.bin", offset: 5, base64: data.subarray(5).toString("base64"), final: true }, ctx);
  assert.equal(done.bytes, data.length);
  const d = await ops.run("file_download", { path: "up/f.bin", offset: 0 }, ctx);
  assert.equal(Buffer.from(d.base64, "base64").toString(), data.toString());
  assert.equal(d.done, true);
});

test("process list and kill", async () => {
  const list = await ops.run("process_list", { filter: "node", limit: 5 }, ctx);
  assert.ok(list.processes.length >= 1);
  await assert.rejects(ops.run("process_kill", { pid: process.pid }, ctx), /节点自己/);
});

test("git read vs write classification + run", async () => {
  assert.equal(gitIsRead("status"), true);
  assert.equal(gitIsRead("branch", ["-a"]), true);
  assert.equal(gitIsRead("branch", ["newbranch"]), false);
  assert.equal(gitIsRead("commit"), false);
  assert.equal(capabilityFor("git", { subcommand: "diff" }), "files_read");
  assert.equal(capabilityFor("git", { subcommand: "push" }), "shell");
  if (spawnSync("git", ["--version"]).status !== 0) return;
  await ops.run("git", { cwd: root, subcommand: "init" }, ctx);
  spawnSync("git", ["-C", root, "config", "user.email", "t@t"]);
  spawnSync("git", ["-C", root, "config", "user.name", "t"]);
  await ops.run("git", { cwd: root, subcommand: "add", args: ["src"] }, ctx);
  const c = await ops.run("git", { cwd: root, subcommand: "commit", args: ["-m", "init"] }, ctx);
  assert.equal(c.exitCode, 0, c.stderr);
  const st = await ops.run("git", { cwd: root, subcommand: "status", args: ["--short"] }, ctx);
  assert.equal(st.exitCode, 0);
  await assert.rejects(ops.run("git", { cwd: root, subcommand: "diff", args: ["--output=/tmp/x"] }, ctx), /不允许/);
});

test("core: full access needs local acceptance and skips local confirm", async () => {
  const sent = [];
  class FakeWS {
    constructor() {
      this.readyState = 1;
      FakeWS.last = this;
      this.handlers = {};
      setTimeout(() => this.handlers.open && this.handlers.open(), 0);
    }
    on(e, f) {
      this.handlers[e] = f;
    }
    send(m) {
      sent.push(JSON.parse(m));
    }
    close() {}
    terminate() {}
  }
  let asked = 0;
  let localPrompts = 0;
  const agent = createNodeAgent({
    serverUrl: "http://localhost:1",
    getToken: () => "cbd_x",
    WebSocket: FakeWS,
    ops: { run: async (op, args, c) => ({ op, fullAccess: c.fullAccess }), features: ["shell"], stopAll() {} },
    local: () => ({ paused: false, forceLocalApproval: true }),
    approve: async () => {
      localPrompts++;
      return "approve";
    },
    acceptFullAccess: async () => {
      asked++;
      return true;
    },
    silenceMs: 0,
  });
  agent.start();
  await new Promise((r) => setTimeout(r, 10));
  const hello = sent.find((m) => m.type === "hello");
  assert.deepEqual(hello.features, ["shell"]);
  const device = { name: "x", capabilities: { shell: "allow" }, allowedRoots: [], paused: false, fullAccess: true, fullAccessUntil: "2099-01-01T00:00:00.000Z", fullAccessRemainingMs: 1000000 };
  FakeWS.last.handlers.message(JSON.stringify({ type: "config", device }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked, 1);
  assert.equal(agent.fullAccess, true);
  FakeWS.last.handlers.message(JSON.stringify({ type: "call", id: "1", operation: "shell", args: { command: "x" }, timeoutMs: 1000 }));
  await new Promise((r) => setTimeout(r, 10));
  const result = sent.find((m) => m.type === "result" && m.id === "1");
  assert.equal(result.ok, true);
  assert.equal(result.result.fullAccess, true);
  assert.equal(localPrompts, 0);
  // 关掉后恢复本机确认
  FakeWS.last.handlers.message(JSON.stringify({ type: "config", device: { ...device, fullAccess: false, fullAccessUntil: null } }));
  FakeWS.last.handlers.message(JSON.stringify({ type: "call", id: "2", operation: "shell", args: { command: "x" }, timeoutMs: 1000 }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(localPrompts, 1);
  // CB-030：「打开」能启动任意程序，也要本机确认
  FakeWS.last.handlers.message(JSON.stringify({ type: "config", device: { ...device, capabilities: { shell: "allow", open: "allow" }, fullAccess: false, fullAccessUntil: null } }));
  FakeWS.last.handlers.message(JSON.stringify({ type: "call", id: "3", operation: "open", args: { target: "calc.exe", args: ["/c", "evil"] }, timeoutMs: 1000 }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(localPrompts, 2);
  agent.stop();
});

test("core: declining full access turns it off on the server", async () => {
  const sent = [];
  class FakeWS {
    constructor() {
      this.readyState = 1;
      FakeWS.last = this;
      this.handlers = {};
      setTimeout(() => this.handlers.open && this.handlers.open(), 0);
    }
    on(e, f) {
      this.handlers[e] = f;
    }
    send(m) {
      sent.push(JSON.parse(m));
    }
    close() {}
    terminate() {}
  }
  const agent = createNodeAgent({ serverUrl: "http://localhost:1", getToken: () => "cbd_x", WebSocket: FakeWS, ops: { run: async () => ({}) }, allowFullAccess: false, silenceMs: 0 });
  agent.start();
  await new Promise((r) => setTimeout(r, 10));
  FakeWS.last.handlers.message(JSON.stringify({ type: "config", device: { name: "x", capabilities: {}, allowedRoots: [], paused: false, fullAccess: true, fullAccessUntil: "2099-01-01T00:00:00.000Z" } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.some((m) => m.type === "set_config" && m.fullAccess === "off"));
  assert.equal(agent.fullAccess, false);
  agent.stop();
});

test("edit in a git repo backs up into .git/chisabot-backups, not next to the file", async () => {
  const repo = path.join(root, "gitrepo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const file = path.join(repo, "src", "b.js");
  fs.writeFileSync(file, "let i = 1;\n");
  const r = await ops.run("edit_file", { path: "gitrepo/src/b.js", edits: [{ oldText: "let i = 1;", newText: "let i = 0;" }] }, ctx);
  assert.equal(r.backup, path.join(repo, ".git", "chisabot-backups", "src", "b.js"));
  assert.equal(fs.readFileSync(r.backup, "utf8"), "let i = 1;\n");
  assert.ok(!fs.existsSync(`${file}.chisabot-bak`));
});
