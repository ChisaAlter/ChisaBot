"use strict";
// 电脑文件夹同步 P4b：PC 端（密钥格式、本机中转、ssh 配置、冲突副本名、默认规则）+ 节点上的新 Git 操作
// （工作目录快照切会话、「放进工作目录」合入、电脑提交接到云端 adopt、冲突时把云端那份挪进备份）。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { generateKeyPair, ensureKey } = require("../src/sync/keys");
const { createBroker } = require("../src/sync/broker");
const { createSyncManager, pcCopyName, ignoredRel } = require("../src/sync/manager");
const { classify, conflictList, sessionName } = require("../src/sync/mutagen");
const { createGitWorkspaces } = require("../src/cloud-cc/git");
const { createSyncNode } = require("../src/cloud-cc/sync");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cb-p4b-"));
}
function haveBin(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch (e) {
    return e.code !== "ENOENT";
  }
}
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

test("ed25519 key: OpenSSH private key format, ssh-keygen derives the same public key", () => {
  const k = generateKeyPair("pc-test");
  assert.match(k.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n$/);
  assert.match(k.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]{68} pc-test$/);
  const dir = tmp();
  const a = ensureKey(dir, "x");
  const b = ensureKey(dir, "y");
  assert.equal(a.publicKey, b.publicKey, "second call reuses the key");
  if (process.platform !== "win32") assert.equal(fs.statSync(a.keyFile).mode & 0o777, 0o600);
  try {
    const derived = execFileSync("ssh-keygen", ["-y", "-f", a.keyFile], { encoding: "utf8" }).trim();
    assert.equal(derived.split(" ").slice(0, 2).join(" "), a.publicKey.split(" ").slice(0, 2).join(" "));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
});

test("pc copy name + default ignore rules", () => {
  const dir = tmp();
  const f = path.join(dir, "README.md");
  fs.writeFileSync(f, "x");
  assert.equal(path.basename(pcCopyName(f)), "README.电脑副本.md");
  fs.writeFileSync(path.join(dir, "README.电脑副本.md"), "y");
  assert.equal(path.basename(pcCopyName(f)), "README.电脑副本 2.md");
  assert.equal(path.basename(pcCopyName(path.join(dir, "Makefile"))), "Makefile.电脑副本");
  for (const p of ["node_modules/x.js", ".env", ".env.local", "a/dist/b.js", ".git/HEAD", "x/__pycache__/m.pyc"]) assert.equal(ignoredRel(p), true, p);
  for (const p of [".env.example", "src/a.ts", "README.md"]) assert.equal(ignoredRel(p), false, p);
});

test("mutagen status → five states; conflict list", () => {
  assert.equal(classify(null).state, "syncing");
  assert.equal(classify({ status: "watching", conflicts: [] }).state, "pc_active");
  assert.equal(classify({ status: "watching", paused: true }).state, "paused");
  assert.equal(classify({ status: "halted-on-root-emptied" }).state, "conflict");
  assert.equal(classify({ status: "disconnected", lastError: "x" }).state, "syncing");
  const s = { status: "watching", conflicts: [{ root: "README.md", alphaChanges: [{ path: "", old: { kind: "file" }, new: { kind: "file" } }], betaChanges: [{ path: "", old: {}, new: {} }] }] };
  assert.equal(classify(s).state, "conflict");
  assert.deepEqual(conflictList(s), [{ path: "README.md", kind: "file" }]);
  assert.equal(sessionName("ws_ab_c"), "cb-ws-ab-c");
});

test("broker: wrong secret / unknown workspace refused; right one pipes bytes through the tunnel", async () => {
  const opened = [];
  class FakeWs extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts;
      this.readyState = 0;
      opened.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.emit("open");
      }, 5);
    }
    send(data) {
      // 回声
      setTimeout(() => this.emit("message", Buffer.concat([Buffer.from("echo:"), Buffer.from(data)])), 1);
    }
    close() {
      this.emit("close");
    }
  }
  const fetchImpl = async (url, init) => ({ ok: true, status: 200, json: async () => ({ ticket: `cbt_${JSON.parse(init.body).workspaceId}` }) });
  const broker = createBroker({ serverUrl: () => "https://chisabot.test", getToken: () => "dev_tok", allow: (ws) => ws === "ws_ok", WebSocket: FakeWs, fetchImpl });
  const port = await broker.start();
  const talk = (line, payload) =>
    new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(Buffer.concat([Buffer.from(line), payload])));
      let out = Buffer.alloc(0);
      s.on("data", (d) => {
        out = Buffer.concat([out, d]);
        if (out.length >= 5 + payload.length) s.end();
      });
      s.on("close", () => resolve(out.toString()));
      s.on("error", () => resolve(out.toString()));
      setTimeout(() => s.destroy(), 2000);
    });
  assert.equal(await talk(`nope ws_ok\n`, Buffer.from("x")), "");
  assert.equal(await talk(`${broker.secret} ws_other\n`, Buffer.from("x")), "");
  assert.equal(opened.length, 0, "no tunnel opened for refused connections");
  const got = await talk(`${broker.secret} ws_ok\n`, Buffer.from("SSH-2.0-test"));
  assert.equal(got, "echo:SSH-2.0-test");
  assert.equal(opened.length, 1);
  assert.match(opened[0].url, /^wss:\/\/chisabot\.test\/api\/devices\/agent\/sync-tunnel\?ticket=cbt_ws_ok$/);
  assert.equal(opened[0].opts.headers["X-Device-Token"], "dev_tok");
  broker.stop();
});

test("manager: ssh config pins the host key, proxy through the broker, token never on disk", () => {
  const dir = tmp();
  const m = createSyncManager({
    dataDir: dir,
    serverUrl: () => "https://chisabot.test",
    getToken: () => "dev_secret_token_123",
    mutagenPath: "/nonexistent/mutagen",
    sshPath: "/usr/bin/ssh",
    nodeExe: "/usr/bin/node",
    tunnelScript: "/app/src/sync/tunnel.js",
    platform: "linux",
  });
  const st = m._internal.state();
  st.bindings.ws_a = { workspaceId: "ws_a", hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrW7vYqk4H7qC6lq0q1nW8mXo8bJqk0q0Vd1u0bU9xY", workPath: "/workspace/projects/ws_a/work", path: dir, enabled: true };
  assert.equal(m.onServerMessage({ type: "sync_begin", workspaceId: "../x", handoffId: "ho_1" }), false);
  assert.equal(m.onServerMessage({ type: "other", workspaceId: "ws_a", handoffId: "ho_1" }), false);
  const all = fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
  for (const f of all) assert.ok(!fs.readFileSync(f, "utf8").includes("dev_secret_token_123"), f);
});

test("node git: session from a snapshot of a dirty work/, apply-merge writes files only, adopt fast-forwards / detects divergence", { skip: !haveBin("git") }, async () => {
  const root = tmp();
  const node = createSyncNode({ root, keysDir: path.join(root, "k") });
  const init = node.rpc("ws_init_local", { workspaceId: "ws_l" });
  assert.equal(init.git, true);
  const work = path.join(root, "projects", "ws_l", "work");
  assert.equal(sh(work, "config", "core.autocrlf"), "input");
  fs.writeFileSync(path.join(work, "a.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(work, "b.txt"), "pc only\n");
  const g = createGitWorkspaces({ root });
  // 没有提交 + 有文件：从快照切会话
  const tree = await g.ensureTree("ws_l", "s1", "cc/s1");
  assert.equal(fs.readFileSync(path.join(tree, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.throws(() => execFileSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: work, stdio: "ignore" }), undefined, "work/ HEAD untouched (still no commit)");
  // Claude 在会话里改 a.txt；同时电脑上改了 b.txt
  fs.writeFileSync(path.join(tree, "a.txt"), "one\nTWO\nthree\n");
  fs.writeFileSync(path.join(work, "b.txt"), "pc only, edited\n");
  const r = await g.merge({ workspaceId: "ws_l", sessionId: "s1", mode: "apply" });
  assert.equal(r.result, "applied");
  assert.deepEqual(r.files, ["a.txt"]);
  assert.equal(fs.readFileSync(path.join(work, "a.txt"), "utf8"), "one\nTWO\nthree\n");
  assert.equal(fs.readFileSync(path.join(work, "b.txt"), "utf8"), "pc only, edited\n", "pc edit kept");
  // 同一个会话再合一次：没有新改动
  assert.equal((await g.merge({ workspaceId: "ws_l", sessionId: "s1", mode: "apply" })).result, "up_to_date");
  // 冲突：电脑改了同一行
  fs.writeFileSync(path.join(tree, "a.txt"), "one\nTWO\nTHREE\n");
  fs.writeFileSync(path.join(work, "a.txt"), "one\nTWO\nthree (pc)\n");
  const c = await g.merge({ workspaceId: "ws_l", sessionId: "s1", mode: "apply" });
  assert.equal(c.result, "conflict");
  assert.equal(fs.readFileSync(path.join(work, "a.txt"), "utf8"), "one\nTWO\nthree (pc)\n", "nothing written on conflict");

  // adopt：电脑的提交推到 refs/remotes/pc/main
  const pc = tmp();
  sh(pc, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(pc, "x.txt"), "1\n");
  sh(pc, "add", ".");
  sh(pc, "commit", "-qm", "c1");
  const c1 = sh(pc, "rev-parse", "HEAD");
  sh(pc, "push", "-q", work, `+${c1}:refs/remotes/pc/main`);
  assert.deepEqual(await g.adopt({ workspaceId: "ws_l", branch: "main", sha: c1 }), { result: "adopted", head: c1, branch: "main" });
  assert.equal((await g.adopt({ workspaceId: "ws_l", branch: "main", sha: c1 })).result, "same");
  fs.writeFileSync(path.join(pc, "x.txt"), "2\n");
  sh(pc, "commit", "-qam", "c2");
  const c2 = sh(pc, "rev-parse", "HEAD");
  sh(pc, "push", "-q", work, `+${c2}:refs/remotes/pc/main`);
  assert.equal((await g.adopt({ workspaceId: "ws_l", branch: "main", sha: c2 })).result, "fast_forward");
  // 云端自己多了一个提交（合入），电脑落后 → cloud_ahead；电脑也有新提交 → diverged
  sh(work, "commit", "-q", "--allow-empty", "-m", "cloud");
  assert.equal((await g.adopt({ workspaceId: "ws_l", branch: "main", sha: c2 })).result, "cloud_ahead");
  fs.writeFileSync(path.join(pc, "x.txt"), "3\n");
  sh(pc, "commit", "-qam", "c3");
  const c3 = sh(pc, "rev-parse", "HEAD");
  sh(pc, "push", "-q", work, `+${c3}:refs/remotes/pc/main`);
  assert.equal((await g.adopt({ workspaceId: "ws_l", branch: "main", sha: c3 })).result, "diverged");
  await assert.rejects(g.adopt({ workspaceId: "ws_l", branch: "cc/x", sha: c3 }), /分支名不对/);
  await assert.rejects(g.adopt({ workspaceId: "ws_l", branch: "main", sha: "0".repeat(40) }), /还没有这个提交/);
});

test("node ws_sync_drop: only while the lease is conflict, moves the cloud copy into a backup", () => {
  const root = tmp();
  const node = createSyncNode({ root, keysDir: path.join(root, "k") });
  node.rpc("ws_init_local", { workspaceId: "ws_d" });
  const work = path.join(root, "projects", "ws_d", "work");
  fs.mkdirSync(path.join(work, "src"), { recursive: true });
  fs.writeFileSync(path.join(work, "src", "x.txt"), "cloud");
  assert.throws(() => node.rpc("ws_sync_drop", { workspaceId: "ws_d", path: "src/x.txt" }), /只有冲突时/);
  node.rpc("sync_lease", { workspaceId: "ws_d", holder: "conflict" });
  for (const bad of ["../x", "/etc/passwd", ".git/HEAD", "src/../../x", ""]) assert.throws(() => node.rpc("ws_sync_drop", { workspaceId: "ws_d", path: bad }), /路径不对/, bad);
  const r = node.rpc("ws_sync_drop", { workspaceId: "ws_d", path: "src/x.txt" });
  assert.equal(r.dropped, true);
  assert.equal(fs.existsSync(path.join(work, "src", "x.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "projects", "ws_d", r.backup), "utf8"), "cloud");
  assert.equal(node.rpc("ws_sync_drop", { workspaceId: "ws_d", path: "src/x.txt" }).missing, true);
});

test("node git: 3-way applyInto merges same-file different-line edits; multi-turn ensureTree syncs work/ changes and skips conflicting files", { skip: !haveBin("git") }, async () => {
  const root = tmp();
  const node = createSyncNode({ root, keysDir: path.join(root, "k") });
  node.rpc("ws_init_local", { workspaceId: "ws_3w" });
  const work = path.join(root, "projects", "ws_3w", "work");
  const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  fs.writeFileSync(path.join(work, "login.ts"), lines);
  fs.writeFileSync(path.join(work, "pay.ts"), "pay-v0\n");
  fs.writeFileSync(path.join(work, "conflict.ts"), "shared-line\n");
  const g = createGitWorkspaces({ root });

  // 第一轮：创建会话工作树
  const tree = await g.ensureTree("ws_3w", "s_3w", "cc/s-3w");
  // Claude 在第一轮修改 login.ts 末尾（第 12 行）和 conflict.ts
  fs.writeFileSync(path.join(tree, "login.ts"), lines.replace("line-12", "line-12-claude"));
  fs.writeFileSync(path.join(tree, "conflict.ts"), "claude-version\n");

  // 与此同时电脑上（work/）修改了 pay.ts、login.ts 开头（第 1 行）以及 conflict.ts 同一行
  fs.writeFileSync(path.join(work, "pay.ts"), "pay-v1-from-pc\n");
  fs.writeFileSync(path.join(work, "login.ts"), lines.replace("line-1\n", "line-1-pc\n"));
  fs.writeFileSync(path.join(work, "conflict.ts"), "pc-version\n");

  // 第二轮开始前：ensureTree 自动将 work/ 新改动三方合并进会话工作树
  await g.ensureTree("ws_3w", "s_3w", "cc/s-3w");
  const syncRes = g.takeSyncResult("ws_3w", "s_3w");
  assert.ok(syncRes);
  assert.deepEqual(syncRes.updated.sort(), ["login.ts", "pay.ts"]);
  assert.deepEqual(syncRes.conflicts, ["conflict.ts"]);

  // pay.ts 已更新为电脑版；login.ts 同时包含电脑第 1 行和 Claude 第 12 行；conflict.ts 保留 Claude 版本且无冲突标记
  assert.equal(fs.readFileSync(path.join(tree, "pay.ts"), "utf8"), "pay-v1-from-pc\n");
  const mergedLogin = fs.readFileSync(path.join(tree, "login.ts"), "utf8");
  assert.match(mergedLogin, /^line-1-pc\n/);
  assert.match(mergedLogin, /line-12-claude\n$/);
  assert.equal(fs.readFileSync(path.join(tree, "conflict.ts"), "utf8"), "claude-version\n");

  // 若此时直接合入，conflict.ts 仍会被准确识别为冲突，work/ 保持不动
  const mConflict = await g.merge({ workspaceId: "ws_3w", sessionId: "s_3w", mode: "apply" });
  assert.equal(mConflict.result, "conflict");
  assert.deepEqual(mConflict.files, ["conflict.ts"]);
  assert.equal(fs.readFileSync(path.join(work, "conflict.ts"), "utf8"), "pc-version\n");

  // Claude 在第二轮将 conflict.ts 合并为双方内容（既不同于原始 orig 也不同于单纯的 pc-version），且电脑在第二轮期间又把 pay.ts 改成了 pay-v2
  fs.writeFileSync(path.join(tree, "conflict.ts"), "merged-pc-and-claude-version\n");
  fs.writeFileSync(path.join(work, "pay.ts"), "pay-v2-from-pc\n");
  // 同时电脑又改了 login.ts 的第 2 行（与 Claude 的第 12 行不冲突）
  fs.writeFileSync(path.join(work, "login.ts"), lines.replace("line-1\nline-2\n", "line-1-pc\nline-2-pc\n"));

  const mOk = await g.merge({ workspaceId: "ws_3w", sessionId: "s_3w", mode: "apply" });
  assert.equal(mOk.result, "applied");
  assert.equal(fs.readFileSync(path.join(work, "conflict.ts"), "utf8"), "merged-pc-and-claude-version\n");
  // 合入后：pay.ts 保持电脑最新的 pay-v2（未被会话里的 pay-v1 回退），login.ts 三方合并包含第 1、2 行（电脑）与第 12 行（Claude）
  assert.equal(fs.readFileSync(path.join(work, "pay.ts"), "utf8"), "pay-v2-from-pc\n");
  const workLogin = fs.readFileSync(path.join(work, "login.ts"), "utf8");
  assert.match(workLogin, /^line-1-pc\nline-2-pc\n/);
  assert.match(workLogin, /line-12-claude\n$/);
});
