#!/usr/bin/env node
"use strict";
/**
 * 模拟的 Claude Code CLI（云端 Claude Code e2e 用，docs/cloud-claude-code.md）。只模仿 ChisaBot 用到的那部分：
 *   claude --version
 *   claude auth login --claudeai      打印授权地址，等标准输入的授权码（"bad" = 无效，"slow" = 不返回）
 *   claude auth status --json / auth logout
 *   claude -p --output-format stream-json ... [--session-id U | --resume U] --settings F   （提示词从标准输入读）
 * -p 时按提示词里的关键词演一轮，并且像真的 Claude 一样调用 --settings 里的 PreToolUse 钩子：
 *   「测试」→ Bash npm test（要审批）；「推送」→ Bash git push（应被拒绝）；「慢」→ 慢慢写 25 秒；
 *   「记得」→ 复述同一个会话之前说过的话；「改标题「X」」→ Edit README.md 第一行（P3 合入 / 冲突）；其余 → Write hello.py + Read。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const HOME = process.env.HOME || os.homedir();
const CRED = path.join(HOME, ".claude", ".credentials.json");
const SESS = path.join(HOME, ".claude", "mock-sessions");
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const out = (j) => process.stdout.write(JSON.stringify(j) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stdinText() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) data += c;
  return data;
}

async function main() {
  if (argv[0] === "--version") {
    console.log("2.1.165 (Claude Code, e2e mock)");
    return 0;
  }
  if (argv[0] === "auth") {
    if (argv[1] === "status") {
      // CHISABOT_MOCK_STATUS_GARBAGE=1：读不懂的输出（测「不能把读不懂当成没登录」）
      if (process.env.CHISABOT_MOCK_STATUS_GARBAGE === "1") {
        console.log("Welcome to Claude Code");
        return 0;
      }
      // CHISABOT_MOCK_ALWAYS_LOGGED_IN=1：不管凭据在不在都说已登录（测「退出失败要报错」）
      if (fs.existsSync(CRED) || process.env.CHISABOT_MOCK_ALWAYS_LOGGED_IN === "1") {
        const c = fs.existsSync(CRED) ? JSON.parse(fs.readFileSync(CRED, "utf8")) : { email: "e2e@example.com" };
        out({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: c.email, orgName: "e2e", subscriptionType: "pro", configDirectory: path.join(HOME, ".claude") });
      } else out({ loggedIn: false, authMethod: "none", apiProvider: "firstParty", configDirectory: path.join(HOME, ".claude") });
      return 0;
    }
    if (argv[1] === "logout") {
      // CHISABOT_MOCK_LOGOUT=none：旧版 CLI（没有 auth logout）——报错退出，凭据原样留着
      if (process.env.CHISABOT_MOCK_LOGOUT === "none") {
        console.error("error: unknown command 'logout'");
        return 1;
      }
      fs.rmSync(CRED, { force: true });
      console.log("Successfully logged out from your Anthropic account.");
      return 0;
    }
    if (argv[1] === "login") {
      console.log("Opening browser to sign in…");
      // CHISABOT_MOCK_AUTH_BASE：e2e 里指向模拟授权页（tests/cloud-cc/mock-claude-auth.cjs）；STRICT=1 时只认「mc-<state>#<state>」
      const state = crypto.randomBytes(6).toString("hex");
      const authBase = process.env.CHISABOT_MOCK_AUTH_BASE || "https://claude.com/cai";
      const redirect = process.env.CHISABOT_MOCK_AUTH_BASE ? `${authBase}/oauth/code/callback` : "https://platform.claude.com/oauth/code/callback";
      console.log(`If the browser didn't open, visit: ${authBase}/oauth/authorize?code=true&client_id=mock&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`);
      process.stdout.write("Paste code here if prompted > ");
      const line = await new Promise((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => {
          buf += c;
          const i = buf.indexOf("\n");
          if (i >= 0) resolve(buf.slice(0, i).trim());
        });
        process.stdin.on("end", () => resolve(buf.trim()));
      });
      if (line === "slow") {
        await sleep(600_000);
        return 1;
      }
      if (!line || line === "bad" || (process.env.CHISABOT_MOCK_AUTH_STRICT === "1" && line !== `mc-${state}#${state}`)) {
        console.log("\nOAuth error: Invalid code. Please make sure the full code was copied");
        return 1;
      }
      fs.mkdirSync(path.dirname(CRED), { recursive: true });
      fs.writeFileSync(CRED, JSON.stringify({ email: "e2e@example.com", token: crypto.randomBytes(8).toString("hex") }), { mode: 0o600 });
      console.log("\nLogin successful.");
      return 0;
    }
  }
  if (!argv.includes("-p")) {
    console.error("mock: unsupported args " + argv.join(" "));
    return 2;
  }
  const prompt = (await stdinText()).trim();
  if (!fs.existsSync(CRED)) {
    console.error("Invalid API key · Please run /login");
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login" });
    return 1;
  }
  let sid = opt("--session-id");
  const resume = opt("--resume");
  fs.mkdirSync(SESS, { recursive: true });
  let history = [];
  if (resume) {
    const f = path.join(SESS, `${resume}.json`);
    if (!fs.existsSync(f)) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: `No conversation found with session ID: ${resume}` });
      return 1;
    }
    history = JSON.parse(fs.readFileSync(f, "utf8"));
    sid = resume;
  }
  sid = sid || crypto.randomUUID();
  history.push(prompt);
  fs.writeFileSync(path.join(SESS, `${sid}.json`), JSON.stringify(history));

  const settings = opt("--settings") ? JSON.parse(fs.readFileSync(opt("--settings"), "utf8")) : {};
  const hookCmd = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  let toolN = 0;
  function hook(tool, input) {
    if (!hookCmd) return { decision: "allow" };
    const r = spawnSync("sh", ["-c", hookCmd], { input: JSON.stringify({ session_id: sid, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: process.cwd() }), encoding: "utf8", timeout: 200_000 });
    try {
      const j = JSON.parse(r.stdout.trim().split("\n").pop());
      return { decision: j.hookSpecificOutput.permissionDecision, reason: j.hookSpecificOutput.permissionDecisionReason };
    } catch {
      return { decision: "deny", reason: `hook failed: ${r.stderr}` };
    }
  }
  async function say(text, slow = 30) {
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sid });
    for (let i = 0; i < text.length; i += 4) {
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 4) } }, session_id: sid });
      await sleep(slow);
    }
    out({ type: "assistant", message: { id: `m${toolN}`, content: [{ type: "text", text }] }, session_id: sid });
  }
  async function tool(name, input, run) {
    const id = `toolu_${++toolN}`;
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, session_id: sid });
    const v = hook(name, input);
    if (v.decision !== "allow") {
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: v.reason || "denied" }] }, session_id: sid });
      return { denied: true, reason: v.reason };
    }
    const result = await run();
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result }] }, session_id: sid });
    return { denied: false, result };
  }

  out({ type: "system", subtype: "init", session_id: sid, model: opt("--model") || "claude-sonnet-mock", cwd: process.cwd(), tools: ["Read", "Write", "Edit", "Bash"] });
  let final = "";
  if (/记得|上一轮|之前/.test(prompt)) {
    final = history.length > 1 ? `记得。这个会话里你之前说过：${history.slice(0, -1).map((h) => `「${h.slice(0, 40)}」`).join("、")}。` : "这是这个会话的第一句话，之前没有说过别的。";
    await say(final);
  } else if (/测试|npm test/.test(prompt)) {
    await say("我先跑一下测试。");
    const r = await tool("Bash", { command: "npm test", description: "运行测试" }, async () => "> mock@1.0.0 test\n> echo ok\n\nok — 3 passed");
    final = r.denied ? `好的，不跑 npm test 了（${r.reason}）。我改为只读检查：看了 package.json，测试脚本是 echo ok。` : "测试通过：3 个都过了。";
    if (r.denied) await tool("Read", { file_path: path.join(process.cwd(), "package.json") }, async () => (fs.existsSync("package.json") ? fs.readFileSync("package.json", "utf8") : "（没有 package.json）"));
    await say(final);
  } else if (/推送|push/.test(prompt)) {
    await say("我试着推送到远端。");
    const r = await tool("Bash", { command: "git push origin HEAD", description: "推送" }, async () => "pushed");
    final = r.denied ? `推送被拒绝了：${r.reason}` : "已推送。";
    await say(final);
  } else if (/改标题「([^」]+)」/.test(prompt)) {
    // P3：改 README.md 第一行（两个会话改成不同的标题，合入第二个时就有冲突）
    const title = /改标题「([^」]+)」/.exec(prompt)[1];
    await say(`好的，把 README 的标题改成「${title}」。`);
    const file = path.join(process.cwd(), "README.md");
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# x\n";
    const next = old.replace(/^.*(\n|$)/, `# ${title}\n`);
    await tool("Edit", { file_path: file, old_string: old.split("\n")[0], new_string: `# ${title}` }, async () => {
      fs.writeFileSync(file, next);
      return "The file README.md has been updated.";
    });
    final = `改好了：README.md 第一行现在是「# ${title}」。`;
    await say(final);
  } else if (/慢/.test(prompt)) {
    const text = "这是一段很慢的回答，用来测试停止和刷新后接着看。".repeat(12);
    await say(text, 120);
    final = text;
  } else {
    await say("好的，我来写一个 hello.py。");
    await tool("Write", { file_path: path.join(process.cwd(), "hello.py"), content: 'print("你好，ChisaBot")\n' }, async () => {
      fs.writeFileSync("hello.py", 'print("你好，ChisaBot")\n');
      return "File created successfully at: hello.py";
    });
    await tool("Read", { file_path: path.join(process.cwd(), "hello.py") }, async () => fs.readFileSync("hello.py", "utf8"));
    final = "写好了：`hello.py` 打印「你好，ChisaBot」。运行 `python3 hello.py` 就能看到。";
    await say(final);
  }
  out({ type: "result", subtype: "success", is_error: false, result: final, session_id: sid, num_turns: toolN + 1, total_cost_usd: 0.0021 });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
