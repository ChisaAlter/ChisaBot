"use strict";
// 云端 Claude Code 节点运行时（pc/src/cloud-cc/）：用模拟 CLI（tests/cloud-cc/mock-claude.cjs）走一遍登录、对话、审批、停止、撤销。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudCc, findUrl, parseStatus } = require("../src/cloud-cc");
const { decide, readonlyCommand } = require("../src/cloud-cc/policy");
const { parseLine } = require("../src/cloud-cc/stream");

const MOCK = process.env.CHISABOT_MOCK_CLAUDE || path.resolve(__dirname, "../../tests/cloud-cc/mock-claude.cjs");
const HEADLESS = path.resolve(__dirname, "../src/headless.js");

function harness(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-home-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-root-"));
  process.env.HOME = home;
  const sent = [];
  const waiters = [];
  const cc = createCloudCc({
    send: (m) => {
      sent.push(m);
      for (const w of [...waiters]) if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
      return true;
    },
    root,
    claude: MOCK,
    hookCommand: [process.execPath, HEADLESS, "cc-hook"],
    ...extra,
  });
  const next = (match, ms = 20000) =>
    new Promise((resolve, reject) => {
      const found = sent.find(match);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      waiters.push({ match, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  let n = 0;
  const rpc = async (op, args = {}) => {
    const id = `r${++n}`;
    cc.handle({ type: "cc_rpc", id, op, args });
    const r = await next((m) => m.type === "cc_rpc_result" && m.id === id, 70000);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };
  return { cc, sent, next, rpc, home, root };
}

test("policy: read-only whitelist, forbidden, ask", () => {
  const root = "/w/projects/scratch/trees/s1";
  assert.equal(decide({ tool: "Read", input: { file_path: `${root}/a.txt` }, root }).decision, "allow");
  assert.equal(decide({ tool: "Read", input: { file_path: "/etc/passwd" }, root }).decision, "ask");
  assert.equal(decide({ tool: "Write", input: { file_path: "/etc/x" }, root }).decision, "deny");
  assert.equal(decide({ tool: "Edit", input: { file_path: "src/a.ts" }, root }).decision, "allow");
  assert.equal(decide({ tool: "Bash", input: { command: "git status && git diff | head" }, root }).decision, "allow");
  assert.equal(decide({ tool: "Bash", input: { command: "npm test" }, root }).decision, "ask");
  assert.equal(decide({ tool: "Bash", input: { command: "npm test" }, root, rules: [{ kind: "bash", value: "npm test" }] }).decision, "allow");
  assert.equal(decide({ tool: "Bash", input: { command: "git push origin HEAD" }, root }).decision, "deny");
  assert.match(decide({ tool: "Bash", input: { command: "git push" }, root }).reason, /推送并开 PR/);
  assert.equal(decide({ tool: "Bash", input: { command: "gh pr create" }, root }).decision, "deny");
  assert.equal(decide({ tool: "Bash", input: { command: "sudo ls" }, root }).decision, "deny");
  assert.equal(decide({ tool: "Bash", input: { command: "rm -rf ~/.claude" }, root }).decision, "deny");
  assert.equal(decide({ tool: "Bash", input: { command: "ls > out.txt" }, root }).decision, "ask");
  assert.equal(decide({ tool: "WebFetch", input: { url: "https://example.com/x" }, root }).decision, "ask");
  assert.equal(decide({ tool: "WebFetch", input: { url: "https://example.com/y" }, root, rules: [{ kind: "domain", value: "example.com" }] }).decision, "allow");
  assert.equal(decide({ tool: "mcp__x__y", input: {}, root }).decision, "ask");
  assert.equal(readonlyCommand("find . -name '*.ts' -delete"), false);
  assert.equal(readonlyCommand("sed -n 1,20p a.ts"), true);
});

test("stream parser", () => {
  assert.deepEqual(parseLine('{"type":"system","subtype":"init","session_id":"s","model":"m"}'), [{ kind: "init", sessionId: "s", model: "m" }]);
  assert.deepEqual(parseLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}}'), [{ kind: "text_delta", text: "你好" }]);
  assert.equal(parseLine("not json").length, 0);
  assert.equal(parseLine('{"type":"result","subtype":"success","result":"ok","num_turns":2,"total_cost_usd":0.1}')[0].ok, true);
  assert.equal(findUrl("visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste"), "https://claude.com/cai/oauth/authorize?code=true&x=1");
  assert.equal(parseStatus('{"loggedIn":true,"email":"a@b","subscriptionType":"pro"}').plan, "pro");
});

test("login: bad code, good code, logout", async () => {
  const h = harness();
  assert.equal((await h.rpc("status")).loggedIn, false);
  const a = await h.rpc("login_start", { id: "L1" });
  assert.match(a.url, /^https:\/\/claude\.com\/cai\/oauth/);
  const bad = await h.rpc("login_code", { id: "L1", code: "bad" });
  assert.equal(bad.ok, false);
  await assert.rejects(h.rpc("login_code", { id: "L1", code: "x" }), /过期/);
  await h.rpc("login_start", { id: "L2" });
  const good = await h.rpc("login_code", { id: "L2", code: "abc#def" });
  assert.equal(good.ok, true);
  assert.equal(good.email, "e2e@example.com");
  assert.equal(good.plan, "pro");
  await h.rpc("login_start", { id: "L3" });
  assert.equal((await h.rpc("login_cancel")).cancelled, true);
  assert.equal((await h.rpc("logout")).loggedIn, false);
  h.cc.close();
});

// 用户报告「退出无效」：`claude auth logout` 没真退出时，节点以前也回「已退出」，下一次检查又变回「已登录」。
test("logout: CLI 没删掉凭据时节点自己删；删完还登着必须报错，不能假装成功", async () => {
  const h = harness();
  const cred = path.join(h.home, ".claude", ".credentials.json");
  await h.rpc("login_start", { id: "L" });
  await h.rpc("login_code", { id: "L", code: "ok" });
  assert.equal(fs.existsSync(cred), true);

  // 旧版 CLI（没有 auth logout）：命令失败、凭据还在 → 节点删掉凭据，再问一次 auth status
  process.env.CHISABOT_MOCK_LOGOUT = "none";
  try {
    assert.equal((await h.rpc("logout")).loggedIn, false);
    assert.equal(fs.existsSync(cred), false);
  } finally {
    delete process.env.CHISABOT_MOCK_LOGOUT;
  }

  // CLI 失败 + 删了凭据还说已登录（凭据在别处 / CLI 不认这份）：必须报错，页面才能显示「没有退出」
  await h.rpc("login_start", { id: "L2" });
  await h.rpc("login_code", { id: "L2", code: "ok" });
  process.env.CHISABOT_MOCK_LOGOUT = "none";
  process.env.CHISABOT_MOCK_ALWAYS_LOGGED_IN = "1";
  try {
    await assert.rejects(h.rpc("logout"), /没有退出/);
  } finally {
    delete process.env.CHISABOT_MOCK_LOGOUT;
    delete process.env.CHISABOT_MOCK_ALWAYS_LOGGED_IN;
  }

  // status 读不懂：不能当成「本来就没登录」直接回成功，否则页面显示「已退出」而凭据还在
  process.env.CHISABOT_MOCK_STATUS_GARBAGE = "1";
  try {
    await assert.rejects(h.rpc("logout"), /没有退出/);
  } finally {
    delete process.env.CHISABOT_MOCK_STATUS_GARBAGE;
  }
  h.cc.close();
});

test("节点程序：报自己的指纹；云端容器里空闲时自己重启换新程序；restart_node 只给容器用", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exits = [];
  delete process.env.CHISABOT_CLOUD_WORKSPACE;
  const h = harness({ exit: (code) => exits.push(code) });
  // cc_info 带上自己在跑的那份程序的 sha256：服务器靠它判断节点是不是旧程序
  h.cc.handle({ type: "cc_probe", script: "f".repeat(64) });
  const info = await h.next((m) => m.type === "cc_info");
  assert.match(info.script, /^[a-f0-9]{64}$/);

  // 普通服务器节点（不是容器）：指针对不上也不退出——systemd 是 Restart=on-failure，干净退出不会被拉起
  await sleep(1800);
  assert.deepEqual(exits, []);

  // 同一个指针对得上：什么都不做
  h.cc.handle({ type: "cc_probe", script: info.script });
  await sleep(300);
  assert.deepEqual(exits, []);

  // 云端容器：服务器的指纹变了 → 空闲时自己退出，让容器重启、入口脚本下新的程序
  process.env.CHISABOT_CLOUD_WORKSPACE = "1";
  process.env.CHISABOT_NODE_DIR = path.join(h.home, ".chisabot-node");
  try {
    h.cc.handle({ type: "cc_probe", script: "e".repeat(64) });
    await sleep(2600);
    assert.deepEqual(exits, [0]);
    // 同一个版本 15 分钟内不再重启（下载失败时不至于来回重启）
    h.cc.handle({ type: "cc_probe", script: "e".repeat(64) });
    await sleep(2000);
    assert.deepEqual(exits, [0]);
  } finally {
    delete process.env.CHISABOT_CLOUD_WORKSPACE;
    delete process.env.CHISABOT_NODE_DIR;
  }
  h.cc.close();

  // 网页上的「重启节点」：容器里回 restarting 再退出；不是容器就报错（让人去服务器上重启）
  const exits2 = [];
  const h2 = harness({ exit: (code) => exits2.push(code) });
  await assert.rejects(h2.rpc("restart_node"), /不是云端工作区容器/);
  process.env.CHISABOT_CLOUD_WORKSPACE = "1";
  try {
    assert.equal((await h2.rpc("restart_node")).restarting, true);
    await sleep(1600);
    assert.deepEqual(exits2, [0]);
  } finally {
    delete process.env.CHISABOT_CLOUD_WORKSPACE;
  }
  h2.cc.close();
});

test("turns: write + diff, resume context, approval approve/deny/always, push denied, stop, undo", async () => {
  const h = harness();
  await h.rpc("login_start", { id: "L" });
  await h.rpc("login_code", { id: "L", code: "ok" });
  const ws = "scratch";
  const sid = "sess1";
  await h.rpc("session_init", { workspaceId: ws, sessionId: sid });
  const claudeSessionId = "11111111-2222-4333-8444-555555555555";
  h.cc.handle({ type: "cc_turn", sessionId: sid, turnId: "t1", workspaceId: ws, prompt: "写一个 hello", claudeSessionId, resume: false });
  const d1 = await h.next((m) => m.type === "cc_done" && m.turnId === "t1");
  assert.equal(d1.ok, true, d1.error);
  assert.equal(d1.resumable, true);
  assert.deepEqual(d1.changes.map((c) => [c.path, c.status]), [["hello.py", "A"]]);
  const deltas = h.sent.filter((m) => m.type === "cc_event" && m.turnId === "t1" && m.event.kind === "text_delta");
  assert.ok(deltas.length > 2);
  const diff = await h.rpc("diff", { workspaceId: ws, sessionId: sid });
  assert.match(diff.patch, /\+print\("你好，ChisaBot"\)/);
  const tree = await h.rpc("tree", { workspaceId: ws, sessionId: sid, path: "" });
  assert.deepEqual(tree.entries.map((e) => e.name), ["hello.py"]);
  assert.match((await h.rpc("read", { workspaceId: ws, sessionId: sid, path: "hello.py" })).text, /你好/);
  await assert.rejects(h.rpc("read", { workspaceId: ws, sessionId: sid, path: "../../../../etc/passwd" }), /不在会话目录/);

  // 第二轮接着上次
  h.cc.handle({ type: "cc_turn", sessionId: sid, turnId: "t2", workspaceId: ws, prompt: "你记得我上一轮说了什么吗", claudeSessionId, resume: true });
  const d2 = await h.next((m) => m.type === "cc_done" && m.turnId === "t2");
  assert.equal(d2.ok, true, d2.error);
  const text2 = h.sent.filter((m) => m.type === "cc_event" && m.turnId === "t2" && m.event.kind === "text").map((m) => m.event.text).join("");
  assert.match(text2, /写一个 hello/);

  // npm test → 审批：拒绝
  h.cc.handle({ type: "cc_turn", sessionId: sid, turnId: "t3", workspaceId: ws, prompt: "跑一下测试", claudeSessionId, resume: true });
  const ask3 = await h.next((m) => m.type === "cc_approval_request" && m.turnId === "t3");
  assert.equal(ask3.tool, "Bash");
  assert.deepEqual(ask3.rule, { kind: "bash", value: "npm test" });
  h.cc.handle({ type: "cc_approval_result", approvalId: ask3.approvalId, decision: "deny" });
  const d3 = await h.next((m) => m.type === "cc_done" && m.turnId === "t3");
  const text3 = h.sent.filter((m) => m.type === "cc_event" && m.turnId === "t3" && m.event.kind === "text").map((m) => m.event.text).join("");
  assert.match(text3, /不跑 npm test/);
  assert.equal(d3.ok, true);

  // 允许 + 本会话总是允许
  h.cc.handle({ type: "cc_turn", sessionId: sid, turnId: "t4", workspaceId: ws, prompt: "再跑测试", claudeSessionId, resume: true, rules: [] });
  const ask4 = await h.next((m) => m.type === "cc_approval_request" && m.turnId === "t4");
  h.cc.handle({ type: "cc_approval_result", approvalId: ask4.approvalId, decision: "approve", always: true });
  await h.next((m) => m.type === "cc_done" && m.turnId === "t4");
  const text4 = h.sent.filter((m) => m.type === "cc_event" && m.turnId === "t4" && m.event.kind === "text").map((m) => m.event.text).join("");
  assert.match(text4, /测试通过/);
  // 服务器把规则带回来时不再问
  h.cc.handle({ type: "cc_turn", sessionId: sid, turnId: "t5", workspaceId: ws, prompt: "测试", claudeSessionId, resume: true, rules: [{ kind: "bash", value: "npm test" }] });
  await h.next((m) => m.type === "cc_done" && m.turnId === "t5");
  assert.equal(h.sent.some((m) => m.type === "cc_approval_request" && m.turnId === "t5"), false);

  // git push 被拒
  h.cc.handle({ type: "cc_turn", sessionId: sid, turnId: "t6", workspaceId: ws, prompt: "推送到远端", claudeSessionId, resume: true });
  await h.next((m) => m.type === "cc_done" && m.turnId === "t6");
  const denied = h.sent.find((m) => m.type === "cc_event" && m.turnId === "t6" && m.event.kind === "denied");
  assert.match(denied.event.reason, /推送并开 PR/);

  // 停止
  h.cc.handle({ type: "cc_turn", sessionId: sid, turnId: "t7", workspaceId: ws, prompt: "慢慢写", claudeSessionId, resume: true });
  await h.next((m) => m.type === "cc_event" && m.turnId === "t7" && m.event.kind === "text_delta");
  const t0 = Date.now();
  h.cc.handle({ type: "cc_stop", sessionId: sid });
  const d7 = await h.next((m) => m.type === "cc_done" && m.turnId === "t7");
  assert.equal(d7.stopped, true);
  assert.ok(Date.now() - t0 < 3000, `stop took ${Date.now() - t0}ms`);

  // 撤销：新会话写文件后撤销
  const s2 = "sess2";
  h.cc.handle({ type: "cc_turn", sessionId: s2, turnId: "u1", workspaceId: ws, prompt: "写", claudeSessionId: "21111111-2222-4333-8444-555555555555", resume: false });
  await h.next((m) => m.type === "cc_done" && m.turnId === "u1");
  const tree2 = path.join(h.root, "projects", ws, "trees", s2);
  assert.ok(fs.existsSync(path.join(tree2, "hello.py")));
  await h.rpc("undo", { workspaceId: ws, sessionId: s2, turnId: "u1" });
  assert.equal(fs.existsSync(path.join(tree2, "hello.py")), false);
  h.cc.close();
});
