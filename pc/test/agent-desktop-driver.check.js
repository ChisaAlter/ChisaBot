"use strict";
/**
 * P2 旁路驱动 agent-desktop-driver.js 单元测试：
 * - 二进制路径探测优先级（options.binPath > env > PATH，跨平台可执行名）
 * - SHA-256 校验（通过 / 不匹配 / 格式非法 / 缺失文件）
 * - 强制 Headless 安全红线（shell: false、windowsHide: true、硬禁 --headed）
 * - ChisaBot 自保护拦截（PID / 进程名 / 审批确认窗标题）
 * - listWindows / snapshot / act / captureWindow CLI 参数构造、JSON 归一化与错误码映射
 * - captureWindow 临时 PNG 在成功与失败路径下均于 finally 彻底清理
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  DRIVER_NAME,
  createAgentDesktopDriver,
  resolveAgentDesktopBinary,
  verifyBinarySha256,
  normalizeAgentDesktopError,
} = require("../src/agent/agent-desktop-driver");

// 最小合法 1x1 PNG 字节（IHDR 宽=1, 高=1）
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function makeFakeSpawn(handler) {
  const calls = [];
  const spawnFn = (file, args, opts) => {
    calls.push({ file, args: [...args], opts });
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      return true;
    };
    queueMicrotask(async () => {
      try {
        const res = (await handler(file, args, opts, proc)) || {};
        if (res.error) {
          proc.emit("error", res.error);
          return;
        }
        if (res.stdout) proc.stdout.write(res.stdout);
        if (res.stderr) proc.stderr.write(res.stderr);
        proc.stdout.end();
        proc.stderr.end();
        proc.emit("close", res.exitCode ?? 0);
      } catch (err) {
        proc.emit("error", err);
      }
    });
    return proc;
  };
  return { spawnFn, calls };
}

test("verifyBinarySha256 validates matching, prefix/uppercase, mismatch, format error, and missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ad-sha-"));
  const fakeBin = path.join(dir, "agent-desktop.exe");
  const payload = Buffer.from("fake-agent-desktop-binary-v1.3.1");
  fs.writeFileSync(fakeBin, payload);
  const digest = crypto.createHash("sha256").update(payload).digest("hex");

  try {
    const ok1 = verifyBinarySha256(fakeBin, digest);
    assert.equal(ok1.ok, true);
    assert.equal(ok1.actual, digest);

    const ok2 = verifyBinarySha256(fakeBin, `SHA256:${digest.toUpperCase()}`);
    assert.equal(ok2.ok, true);

    const bad = verifyBinarySha256(fakeBin, "0".repeat(64));
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "sha256_mismatch");

    const invalid = verifyBinarySha256(fakeBin, "not-a-hex");
    assert.equal(invalid.ok, false);
    assert.equal(invalid.reason, "invalid_sha256_format");

    const missing = verifyBinarySha256(path.join(dir, "nope.exe"), digest);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "read_failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAgentDesktopBinary respects options.binPath > env > PATH and enforces SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ad-resolve-"));
  const optBin = path.join(dir, "opt-agent-desktop.exe");
  const envBin = path.join(dir, "env-agent-desktop.exe");
  const pathDir = path.join(dir, "pathbin");
  fs.mkdirSync(pathDir, { recursive: true });
  const winPathBin = path.join(pathDir, "agent-desktop.exe");
  const posixPathBin = path.join(pathDir, "agent-desktop");

  fs.writeFileSync(optBin, "opt-bin");
  fs.writeFileSync(envBin, "env-bin");
  fs.writeFileSync(winPathBin, "win-path-bin");
  fs.writeFileSync(posixPathBin, "posix-path-bin");
  const optSha = crypto.createHash("sha256").update("opt-bin").digest("hex");

  try {
    // 1. options.binPath 最高优先级 + SHA-256 通过
    const rOpt = resolveAgentDesktopBinary({
      binPath: optBin,
      expectedSha256: optSha,
      env: { CHISABOT_AGENT_DESKTOP_BIN: envBin, PATH: pathDir },
      platform: "win32",
    });
    assert.equal(rOpt.found, true);
    assert.equal(rOpt.source, "option");
    assert.equal(rOpt.binPath, optBin);
    assert.equal(rOpt.sha256Verified, true);

    // 2. SHA-256 不匹配必须判定不可用
    const rBadSha = resolveAgentDesktopBinary({
      binPath: optBin,
      expectedSha256: "f".repeat(64),
      platform: "win32",
    });
    assert.equal(rBadSha.found, false);
    assert.equal(rBadSha.reason, "sha256_mismatch");

    // 3. 环境变量次优先级
    const rEnv = resolveAgentDesktopBinary({
      env: { CHISABOT_AGENT_DESKTOP_BIN: envBin, PATH: pathDir },
      platform: "win32",
    });
    assert.equal(rEnv.found, true);
    assert.equal(rEnv.source, "env");
    assert.equal(rEnv.binPath, envBin);

    // 4. PATH 查找（Windows 找 agent-desktop.exe，非 Windows 找 agent-desktop）
    const rWinPath = resolveAgentDesktopBinary({
      env: { PATH: "C:\\Tools;D:\\Bin" },
      platform: "win32",
      statSync: (p) => {
        if (p === "C:\\Tools\\agent-desktop.exe") {
          return { isFile: () => true };
        }
        throw new Error("ENOENT");
      },
    });
    assert.equal(rWinPath.found, true);
    assert.equal(rWinPath.source, "path");
    assert.equal(rWinPath.binPath, "C:\\Tools\\agent-desktop.exe");

    const rMacPath = resolveAgentDesktopBinary({
      env: { PATH: "/usr/local/bin:/usr/bin" },
      platform: "darwin",
      statSync: (p) => {
        if (p === "/usr/local/bin/agent-desktop") {
          return { isFile: () => true };
        }
        throw new Error("ENOENT");
      },
    });
    assert.equal(rMacPath.found, true);
    assert.equal(rMacPath.source, "path");
    assert.equal(rMacPath.binPath, "/usr/local/bin/agent-desktop");

    const rHostPath = resolveAgentDesktopBinary({
      env: { PATH: pathDir },
      platform: process.platform,
    });
    assert.equal(rHostPath.found, true);
    assert.equal(rHostPath.source, "path");
    assert.equal(
      rHostPath.binPath,
      process.platform === "win32" ? winPathBin : posixPathBin,
    );

    // 5. 未找到
    const rNone = resolveAgentDesktopBinary({
      env: { PATH: "" },
      platform: "win32",
    });
    assert.equal(rNone.found, false);
    assert.equal(rNone.reason, "binary_not_found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeAgentDesktopError maps upstream codes and messages to ChisaBot standard codes", () => {
  assert.equal(
    normalizeAgentDesktopError({
      error: { code: "HEADED_REQUIRED", message: "need headed" },
    }).code,
    "POLICY_DENIED",
  );
  assert.equal(
    normalizeAgentDesktopError(
      JSON.stringify({ code: "STALE_SNAPSHOT", message: "expired" }),
    ).code,
    "STALE_REF",
  );
  assert.equal(
    normalizeAgentDesktopError({
      code: "IDENTITY_NOT_UNIQUE",
      message: "2 matches",
    }).code,
    "AMBIGUOUS_TARGET",
  );
  assert.equal(
    normalizeAgentDesktopError({ code: "PERM_DENIED", message: "UIPI denied" })
      .code,
    "NEEDS_PERMISSION",
  );
  assert.equal(
    normalizeAgentDesktopError({ code: "APP_NOT_FOUND", message: "missing" })
      .code,
    "WINDOW_NOT_FOUND",
  );
  assert.equal(
    normalizeAgentDesktopError({
      code: "PLATFORM_NOT_SUPPORTED",
      message: "wayland",
    }).code,
    "ACTION_NOT_SUPPORTED",
  );
  assert.equal(
    normalizeAgentDesktopError("command timed out after 20s").code,
    "TIMEOUT",
  );
  assert.equal(
    normalizeAgentDesktopError(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    ).code,
    "DRIVER_UNAVAILABLE",
  );
});

test("createAgentDesktopDriver enforces headless safety (--headed blocked, shell:false, self-protection)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ad-safe-"));
  const fakeBin = path.join(dir, "agent-desktop.exe");
  fs.writeFileSync(fakeBin, "bin");
  const { spawnFn, calls } = makeFakeSpawn(() => ({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true }),
  }));

  try {
    const driver = createAgentDesktopDriver({
      binPath: fakeBin,
      spawn: spawnFn,
      selfPid: 55555,
      tmpDir: dir,
    });
    assert.equal(driver.name, DRIVER_NAME);

    // 1. 任何方法传入 --headed 或 --headed=true 均直接 POLICY_DENIED 且 0 次 spawn
    const r1 = await driver.listWindows({ extraArgs: ["--headed"] });
    assert.equal(r1.ok, false);
    assert.equal(r1.code, "POLICY_DENIED");

    const r2 = await driver.snapshot({
      bundleId: "notepad",
      extraArgs: ["--headed=true"],
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, "POLICY_DENIED");

    const r3 = await driver.act({
      ref: "@1:e2",
      action: "click",
      extraArgs: ["--HEADED"],
    });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, "POLICY_DENIED");

    const r4 = await driver.captureWindow({
      hwnd: 1234,
      extraArgs: ["--headed"],
    });
    assert.equal(r4.ok, false);
    assert.equal(r4.code, "POLICY_DENIED");

    // 2. action: "focus" 直接 POLICY_DENIED
    const rFocus = await driver.act({ ref: "@1:e2", action: "focus" });
    assert.equal(rFocus.ok, false);
    assert.equal(rFocus.code, "POLICY_DENIED");

    // 3. 裸 @e2 ref 拒绝
    const rBadRef = await driver.act({ ref: "@e2", action: "click" });
    assert.equal(rBadRef.ok, false);
    assert.equal(rBadRef.code, "STALE_REF");

    // 4. 自保护：拒绝 selfPid / chisabot 进程名（含绝对路径） / 大小写不敏感审批确认窗标题
    for (const target of [
      { pid: 55555, bundleId: "notepad" },
      { bundleId: "ChisaBot.exe" },
      { processName: "chisabot-pc" },
      { processName: "C:\\Program Files\\ChisaBot\\ChisaBot.exe" },
      { processName: "/Applications/ChisaBot.app/Contents/MacOS/chisabot-pc" },
      { bundleId: "cn.ayase.chisabot.pc" },
      { title: "ChisaBot 审批 - 确认执行" },
      { title: "chisabot 审批 - 小写标题" },
      { title: "CHISABOT 确认弹窗" },
    ]) {
      const sRes = await driver.snapshot(target);
      assert.equal(sRes.ok, false);
      assert.equal(sRes.code, "SELF_TARGET_FORBIDDEN");

      const cRes = await driver.captureWindow({ hwnd: 99, ...target });
      assert.equal(cRes.ok, false);
      assert.equal(cRes.code, "SELF_TARGET_FORBIDDEN");
    }

    assert.equal(calls.length, 0, "blocked requests must never spawn binary");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createAgentDesktopDriver: isAvailable cache, listWindows, snapshot, act, captureWindow + finally cleanup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ad-ops-"));
  const fakeBin = path.join(dir, "agent-desktop.exe");
  fs.writeFileSync(fakeBin, "bin");
  let capturedTmpPath = "";
  let failNextScreenshot = false;

  const { spawnFn, calls } = makeFakeSpawn((_file, args) => {
    const sub = args[0];
    if (sub === "--version") {
      return { exitCode: 0, stdout: "agent-desktop 1.3.1\n" };
    }
    if (sub === "list-windows") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            windows: [
              {
                window_id: 2001,
                pid: 55555,
                process_name: "chisabot-pc",
                title: "ChisaBot",
                bounds: { left: 0, top: 0, width: 800, height: 600 },
              },
              {
                window_id: 2002,
                pid: 9001,
                process_name: "notepad",
                title: "笔记.txt - 记事本",
                is_active: false,
                is_minimized: false,
                bounds: { left: 100, top: 100, width: 900, height: 700 },
              },
            ],
          },
        }),
      };
    }
    if (sub === "snapshot") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            snapshot_id: 7,
            ref_count: 2,
            complete: true,
            window: {
              window_id: 2002,
              pid: 9001,
              process_name: "notepad",
              title: "笔记.txt - 记事本",
            },
            tree: {
              role: "window",
              name: "笔记.txt - 记事本",
              children: [
                {
                  ref_id: "@7:e1",
                  role: "button",
                  name: "保存",
                  native_id: { kind: "AutomationId", value: "SaveBtn" },
                  available_actions: ["invoke"],
                  bounds: { x: 10, y: 20, width: 60, height: 24 },
                },
                {
                  ref_id: "@7:e2",
                  role: "edit",
                  name: "密码",
                  value: "super-secret",
                  states: ["password"],
                  available_actions: ["value"],
                },
              ],
            },
          },
        }),
      };
    }
    if (sub === "screenshot") {
      const pngPath = args[args.indexOf("--json") - 1];
      capturedTmpPath = pngPath;
      fs.writeFileSync(pngPath, TINY_PNG);
      if (failNextScreenshot) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { code: "WINDOW_MINIMIZED", message: "window is minimized" },
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, data: { window_id: 2002 } }),
      };
    }
    if (sub === "set-value" || sub === "scroll" || sub === "click") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { name: "保存", delivery: "delivered_verified" },
        }),
      };
    }
    return {
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "ACTION_NOT_SUPPORTED", message: "unknown" },
      }),
    };
  });

  try {
    const driver = createAgentDesktopDriver({
      binPath: fakeBin,
      spawn: spawnFn,
      selfPid: 55555,
      tmpDir: dir,
    });

    // isAvailable 探活并缓存
    const av1 = await driver.isAvailable();
    const av2 = await driver.isAvailable();
    assert.equal(av1.available, true);
    assert.equal(av1.version, "agent-desktop 1.3.1");
    assert.equal(av2.version, "agent-desktop 1.3.1");
    assert.equal(calls.filter((c) => c.args[0] === "--version").length, 1);

    // 验证所有 spawn 强制 shell: false + windowsHide: true
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].opts.windowsHide, true);

    // listWindows 自动剔除自身进程窗口
    const listRes = await driver.listWindows({ query: "记事本" });
    assert.equal(listRes.ok, true);
    assert.equal(listRes.windows.length, 1);
    assert.equal(listRes.windows[0].hwnd, 2002);

    // snapshot 保留原生 @7:eN 与 tree，且密码框 value 强置为 null
    const snapRes = await driver.snapshot({
      hwnd: 2002,
      interactiveOnly: true,
      compact: true,
      maxDepth: 8,
    });
    assert.equal(snapRes.ok, true);
    assert.equal(snapRes.snapshotId, 7);
    assert.ok(snapRes.tree);
    const btn = snapRes.nodes.find((n) => n.ref === "@7:e1");
    const pwd = snapRes.nodes.find((n) => n.ref === "@7:e2");
    assert.equal(btn.automationId, "SaveBtn");
    assert.equal(pwd.isPassword, true);
    assert.equal(pwd.value, null);
    const snapCall = calls.find((c) => c.args[0] === "snapshot");
    assert.deepEqual(snapCall.args, [
      "snapshot",
      "--json",
      "--window-id",
      "2002",
      "-i",
      "--compact",
      "--max-depth",
      "8",
    ]);

    // act 映射 set_value 与 scroll
    const actVal = await driver.act({
      ref: "@7:e1",
      action: "set_value",
      value: "hello",
    });
    assert.equal(actVal.ok, true);
    assert.equal(actVal.delivery, "delivered_verified");
    const setValCall = calls.find((c) => c.args[0] === "set-value");
    assert.deepEqual(setValCall.args, [
      "set-value",
      "@7:e1",
      "hello",
      "--json",
    ]);

    const actScroll = await driver.act({
      ref: "@7:e1",
      action: "scroll",
      direction: "down",
      amount: 3,
    });
    assert.equal(actScroll.ok, true);
    const scrollCall = calls.find((c) => c.args[0] === "scroll");
    assert.deepEqual(scrollCall.args, [
      "scroll",
      "@7:e1",
      "--direction",
      "down",
      "--amount",
      "3",
      "--json",
    ]);

    // captureWindow 成功路径：返回 base64 + IHDR 宽高，且 finally 删除临时 PNG
    const capOk = await driver.captureWindow({ hwnd: 2002, maxWidth: 1200 });
    assert.equal(capOk.ok, true);
    assert.equal(capOk.format, "png");
    assert.equal(capOk.width, 1);
    assert.equal(capOk.height, 1);
    assert.equal(capOk.base64, TINY_PNG.toString("base64"));
    assert.ok(capturedTmpPath.endsWith(".png"));
    assert.equal(
      fs.existsSync(capturedTmpPath),
      false,
      "tmp PNG must be cleaned up after success",
    );

    // captureWindow 失败路径：CLI 写文件后报错，finally 依然必须删除临时 PNG
    failNextScreenshot = true;
    const capFail = await driver.captureWindow({ hwnd: 2002 });
    assert.equal(capFail.ok, false);
    assert.equal(capFail.code, "WINDOW_MINIMIZED");
    assert.equal(
      fs.existsSync(capturedTmpPath),
      false,
      "tmp PNG must be cleaned up after failure",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createAgentDesktopDriver allows non-numeric upstream refs captured by snapshot() while rejecting unknown/unsafe refs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ad-extref-"));
  const fakeBin = path.join(dir, "agent-desktop.exe");
  fs.writeFileSync(fakeBin, "bin");

  const { spawnFn, calls } = makeFakeSpawn((_file, args) => {
    const sub = args[0];
    if (sub === "snapshot") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            snapshot_id: "s1",
            ref_count: 4,
            complete: true,
            window: {
              window_id: 3001,
              pid: 9099,
              process_name: "notepad",
              title: "外部快照测试",
            },
            tree: {
              role: "window",
              name: "外部快照测试",
              children: [
                { ref_id: "@e1", role: "button", name: "提交" },
                { ref_id: "@s1:e2", role: "edit", name: "内容" },
                { ref_id: "--headed", role: "button", name: "恶意参数注入" },
                { ref_id: "@e3 bad", role: "button", name: "含空格非法引用" },
              ],
            },
          },
        }),
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        data: { name: "ok", delivery: "delivered_verified" },
      }),
    };
  });

  try {
    const driver = createAgentDesktopDriver({
      binPath: fakeBin,
      spawn: spawnFn,
      selfPid: 55555,
      tmpDir: dir,
    });

    const snap = await driver.snapshot({ hwnd: 3001 });
    assert.equal(snap.ok, true);
    assert.equal(snap.snapshotId, "s1");

    // 来自本驱动刚快照的 @e1 与 @s1:e2 均放行
    const act1 = await driver.act({ ref: "@e1", action: "click" });
    assert.equal(act1.ok, true);
    const act2 = await driver.act({
      ref: "@s1:e2",
      action: "set_value",
      value: "hello",
    });
    assert.equal(act2.ok, true);

    // 未在 snapshot 中出现过的裸 @e99 仍拒为 STALE_REF
    const unseen = await driver.act({ ref: "@e99", action: "click" });
    assert.equal(unseen.ok, false);
    assert.equal(unseen.code, "STALE_REF");

    // 即使上游误返回以 - 开头或含空格的恶意 ref，也绝不放行
    const flagInject = await driver.act({ ref: "--headed", action: "click" });
    assert.equal(flagInject.ok, false);
    assert.equal(flagInject.code, "STALE_REF");

    const spaceInject = await driver.act({ ref: "@e3 bad", action: "click" });
    assert.equal(spaceInject.ok, false);
    assert.equal(spaceInject.code, "STALE_REF");

    // 确认仅 1 次 snapshot + 2 次合法 act 触发了子进程
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].args, ["click", "@e1", "--json"]);
    assert.deepEqual(calls[2].args, ["set-value", "@s1:e2", "hello", "--json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createAgentDesktopDriver supports execFile injection as alternative to spawn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ad-execfile-"));
  const fakeBin = path.join(dir, "agent-desktop.exe");
  fs.writeFileSync(fakeBin, "bin");
  const seen = [];

  try {
    const driver = createAgentDesktopDriver({
      binPath: fakeBin,
      execFile: (file, args, opts, cb) => {
        seen.push({ file, args, opts });
        cb(null, "agent-desktop 1.3.1\n", "");
      },
    });
    const res = await driver.isAvailable();
    assert.equal(res.available, true);
    assert.equal(res.version, "agent-desktop 1.3.1");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].opts.shell, false);
    assert.equal(seen[0].opts.windowsHide, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
