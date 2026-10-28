"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOps, resolveInRoots, encodePowerShell, winInputScript, escapeSendKeys } = require("../src/agent/ops");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbpc-"));
const root = path.join(tmp, "allowed");
fs.mkdirSync(path.join(root, "sub"), { recursive: true });
fs.writeFileSync(path.join(root, "a.txt"), "你好 ChisaBot");
fs.writeFileSync(path.join(tmp, "secret.txt"), "nope");
fs.symlinkSync(tmp, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
const ops = createOps({ clientVersion: "test" });
const ctx = { allowedRoots: [root] };

test("no roots refuses file ops", async () => {
  await assert.rejects(ops.run("read_file", { path: "a.txt" }, { allowedRoots: [] }), /允许的文件夹/);
});

test("list roots and dir", async () => {
  const roots = await ops.run("list_files", {}, ctx);
  assert.equal(roots.roots[0].path, root);
  const listing = await ops.run("list_files", { path: "." }, ctx);
  assert.deepEqual(listing.entries.map((e) => e.name).sort(), ["a.txt", "escape", "sub"]);
  assert.equal(listing.entries[0].type, "dir");
});

test("read inside root, refuse outside and via symlink", async () => {
  const file = await ops.run("read_file", { path: "a.txt" }, ctx);
  assert.equal(file.content, "你好 ChisaBot");
  await assert.rejects(ops.run("read_file", { path: path.join(tmp, "secret.txt") }, ctx), /不在允许/);
  await assert.rejects(ops.run("read_file", { path: "../secret.txt" }, ctx), /不在允许/);
  await assert.rejects(ops.run("read_file", { path: "escape/secret.txt" }, ctx), /不在允许/);
});

test("write creates backup on overwrite, append works", async () => {
  const first = await ops.run("write_file", { path: "sub/new.txt", content: "one" }, ctx);
  assert.equal(first.backup, null);
  const second = await ops.run("write_file", { path: "sub/new.txt", content: "two" }, ctx);
  assert.ok(second.backup.endsWith(".chisabot-bak"));
  assert.equal(fs.readFileSync(second.backup, "utf8"), "one");
  await ops.run("write_file", { path: "sub/new.txt", content: "+", append: true }, ctx);
  assert.equal(fs.readFileSync(path.join(root, "sub/new.txt"), "utf8"), "two+");
  await assert.rejects(ops.run("write_file", { path: "../x.txt", content: "x" }, ctx), /不在允许/);
});

test("shell: output, exit code, timeout, cap", async () => {
  const win = process.platform === "win32";
  const ok = await ops.run("shell", { command: win ? "Write-Output hi; [Console]::Error.WriteLine('err'); exit 3" : "echo hi; echo err >&2; exit 3" }, {});
  assert.equal(ok.stdout.trim(), "hi");
  assert.equal(ok.stderr.trim(), "err");
  assert.equal(ok.exitCode, 3);
  const slow = await ops.run("shell", { command: win ? "Start-Sleep -Seconds 5" : "sleep 5", timeoutSec: 1 }, {});
  assert.equal(slow.timedOut, true);
  assert.ok(slow.durationMs < 4000);
  const big = await ops.run("shell", { command: win ? "'a' * 200000" : "head -c 200000 /dev/zero | tr '\\0' a" }, {});
  assert.equal(big.truncated, true);
  assert.ok(big.stdout.length <= 64 * 1024);
});

test("shell cancel via signal", async () => {
  const win = process.platform === "win32";
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const result = await ops.run("shell", { command: win ? "Start-Sleep -Seconds 5" : "sleep 5" }, { signal: controller.signal });
  assert.equal(result.cancelled, true);
});

test("clipboard fallback and system info", async () => {
  await ops.run("clipboard_write", { text: "剪贴板" }, {});
  assert.equal((await ops.run("clipboard_read", {}, {})).text, "剪贴板");
  const info = await ops.run("system_info", {}, {});
  assert.equal(info.platform, process.platform);
  assert.ok(info.cpus > 0);
});

test("windows path rules (win32 api)", async () => {
  await assert.rejects(resolveInRoots("D:\\other\\x.txt", ["C:\\Users\\me\\Docs"], "win32"), /不在允许/);
  const ok = await resolveInRoots("c:\\users\\ME\\docs\\a.txt", ["C:\\Users\\me\\Docs"], "win32");
  assert.match(ok, /a\.txt$/i);
  await assert.rejects(resolveInRoots("C:\\Users\\me\\Docs2\\a.txt", ["C:\\Users\\me\\Docs"], "win32"), /不在允许/);
});

test("windows default folders: C:\\AI is outside (message lists the roots); Chinese / slash / drive-root paths", async () => {
  const roots = ["C:\\Users\\48818\\Desktop", "C:\\Users\\48818\\Documents", "C:\\Users\\48818\\Downloads"];
  await assert.rejects(resolveInRoots("C:\\AI", roots, "win32"), (error) => {
    assert.match(error.message, /路径不在允许的文件夹内：C:\\AI/);
    assert.match(error.message, /C:\\Users\\48818\\Desktop、/);
    return true;
  });
  assert.match(await resolveInRoots("C:/Users/48818/Documents/报告/周报.md", roots, "win32"), /周报\.md$/);
  assert.match(await resolveInRoots("C:\\AI\\笔记", [...roots, "C:\\AI"], "win32"), /^C:\\AI\\笔记$/);
  assert.match(await resolveInRoots("C:\\AI", ["C:\\"], "win32"), /^C:\\AI$/);
  assert.match(await resolveInRoots("报告", roots, "win32"), /^C:\\Users\\48818\\Desktop\\报告$/);
});

test("powershell encoding and input scripts", () => {
  assert.equal(Buffer.from(encodePowerShell("echo 你好"), "base64").toString("utf16le"), "echo 你好");
  assert.match(winInputScript({ action: "click", x: 10, y: 20 }), /SetCursorPos\(10, 20\)/);
  assert.match(winInputScript({ action: "type", text: "a+b" }), /a\{\+\}b/);
  assert.equal(escapeSendKeys("50%(x)"), "50{%}{(}x{)}");
  assert.throws(() => winInputScript({ action: "move" }), /x 和 y/);
});

test("open refuses dangerous schemes", async () => {
  await assert.rejects(ops.run("open", { target: "javascript:alert(1)" }, {}), /不允许/);
});

test("open (CB-030): no programs, no args, no executables, files only inside roots", async () => {
  await assert.rejects(ops.run("open", { target: "notepad" }, ctx), /不再启动程序/);
  await assert.rejects(ops.run("open", { target: "calc.exe" }, ctx), /\.exe/);
  await assert.rejects(ops.run("open", { target: "a.txt", args: ["/c", "evil"] }, ctx), /不带参数/);
  await assert.rejects(ops.run("open", { target: "\\\\evil\\share\\a.pdf" }, ctx), /网络路径/);
  await assert.rejects(ops.run("open", { target: path.join(tmp, "secret.txt") }, ctx), /允许的文件夹|不在/);
  await assert.rejects(ops.run("open", { target: "missing.pdf" }, ctx), /找不到/);
  fs.writeFileSync(path.join(root, "run-me.txt"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  if (process.platform !== "win32") {
    await assert.rejects(ops.run("open", { target: "./run-me.txt" }, ctx), /可执行/);
    fs.symlinkSync("/bin/sh", path.join(root, "doc.pdf"));
    await assert.rejects(ops.run("open", { target: "doc.pdf" }, ctx));
  } else {
    fs.symlinkSync(tmp, path.join(root, "doc.pdf"), "junction");
    await assert.rejects(ops.run("open", { target: "doc.pdf" }, ctx));
  }
  const opened = [];
  const hooked = createOps({ clientVersion: "test", hooks: { openPath: async (p) => { opened.push(p); return ""; }, openExternal: async (u) => { opened.push(u); } } });
  assert.equal((await hooked.run("open", { target: "a.txt" }, ctx)).via, "default-app");
  assert.equal((await hooked.run("open", { target: "./sub/" }, ctx)).via, "default-app");
  assert.equal((await hooked.run("open", { target: "https://example.com/x" }, ctx)).via, "browser");
  assert.deepEqual(opened, [path.join(root, "a.txt"), path.join(root, "sub"), "https://example.com/x"]);
});
