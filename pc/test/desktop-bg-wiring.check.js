"use strict";
/**
 * Wave 2 后台无感桌面操控全链路接线回归测试：
 * 1) accessibility-bridge.js DesktopDriver SPI（外部优先 vs 内置回退）与 Snapshot/Ref 引擎；
 * 2) macOS 无 frontmost = true 修复 + 后台截屏临时文件零泄漏；
 * 3) @<snapshotId>:e<N> 校验、focus POLICY_DENIED、自保护 SELF_TARGET_FORBIDDEN、密码擦除；
 * 4) ops.js 四项操作与 desktop_bg_v1 特性、stopAll 清空回合授权；
 * 5) core.js OPERATION_CAPABILITY、摘要脱敏、forceLocalApproval + directionEpoch 回合缓存/推进/高敏不缓存/急停作废；
 * 6) main.js / headless.js 接线与零 Electron 污染检查。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");

const {
  ACCESSIBILITY_SCOPE,
  buildMacActionScript,
  buildMacBgActionScript,
  createAccessibilityBridge,
} = require("../src/accessibility-bridge");
const {
  createAgentDesktopDriver,
} = require("../src/agent/agent-desktop-driver");
const { createOps } = require("../src/agent/ops");
const {
  createNodeAgent,
  OPERATION_CAPABILITY,
  summarize,
} = require("../src/agent/core");

// 最小合法 1x1 PNG（IHDR width=1, height=1）
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN50AAAAASUVORK5CYII=",
  "base64",
);

test("accessibility-bridge: macOS buildMacActionScript never assigns frontmost = true", () => {
  const clickScript = buildMacActionScript({
    bundleId: "com.apple.textedit",
    action: "click",
    name: "保存",
  });
  assert.doesNotMatch(clickScript, /frontmost\s*=\s*true/);
  assert.match(clickScript, /AXPress/);
  assert.match(clickScript, /el\.click\(\)/);

  const setValScript = buildMacActionScript({
    bundleId: "com.apple.textedit",
    action: "set_value",
    name: "内容",
    value: "hello",
  });
  assert.doesNotMatch(setValScript, /frontmost\s*=\s*true/);
  assert.match(setValScript, /el\.value\s*=\s*val/);

  const focusScript = buildMacActionScript({
    bundleId: "com.apple.textedit",
    action: "focus",
    name: "输入框",
  });
  assert.doesNotMatch(focusScript, /frontmost\s*=\s*true/);
  assert.match(focusScript, /el\.focused\s*=\s*true/);
});

test("accessibility-bridge: DesktopDriver SPI prefers available externalDriver and routes listWindows/snapshot/act/captureWindow", async () => {
  const extCalls = [];
  const winCalls = [];

  const mockExternal = {
    name: "agent-desktop",
    async isAvailable() {
      return {
        available: true,
        version: "0.9.1",
        binPath: "/usr/local/bin/agent-desktop",
        sha256Verified: true,
      };
    },
    async listWindows(args) {
      extCalls.push({ op: "listWindows", args });
      return {
        ok: true,
        driver: "agent-desktop",
        windows: [
          {
            hwnd: 1001,
            pid: 4200,
            processName: "notepad",
            bundleId: "notepad",
            title: "计划.txt",
            bounds: { left: 10, top: 20, width: 800, height: 600 },
          },
          {
            hwnd: 1002,
            pid: process.pid,
            processName: "node",
            title: "Self Proc",
          },
          {
            hwnd: 1003,
            pid: 9999,
            processName: "ChisaBot.exe",
            title: "ChisaBot",
          },
        ],
      };
    },
    async snapshot(args) {
      extCalls.push({ op: "snapshot", args });
      return {
        ok: true,
        driver: "agent-desktop",
        window: {
          hwnd: 1001,
          pid: 4200,
          processName: "notepad",
          bundleId: "notepad",
          title: "计划.txt",
        },
        nodes: [
          {
            ref: "@99:e1",
            role: "button",
            name: "保存",
            automationId: "btnSave",
            patterns: ["invoke"],
            bounds: { x: 10, y: 10, width: 60, height: 24 },
          },
          {
            ref: "@99:e2",
            role: "edit",
            name: "密码",
            isPassword: true,
            value: "TOP_SECRET_123",
            patterns: ["value"],
            bounds: { x: 10, y: 40, width: 120, height: 24 },
          },
        ],
      };
    },
    async act(args) {
      extCalls.push({ op: "act", args });
      return {
        ok: true,
        driver: "agent-desktop",
        action: args.action,
        matchedName: "保存",
        delivery: "delivered_verified",
      };
    },
    async captureWindow(args) {
      extCalls.push({ op: "captureWindow", args });
      return {
        ok: true,
        driver: "agent-desktop",
        format: "png",
        hwnd: 1001,
        pid: 4200,
        processName: "notepad",
        title: "计划.txt",
        width: 1,
        height: 1,
        windowWidth: 1,
        windowHeight: 1,
        base64: TINY_PNG.toString("base64"),
      };
    },
  };

  const bridge = createAccessibilityBridge({
    platform: "win32",
    externalDriver: mockExternal,
    winHelper: {
      async request(cmd) {
        winCalls.push(cmd);
        return {};
      },
    },
  });

  const info = await bridge.driverInfo();
  assert.equal(info.mode, "external");
  assert.equal(info.active, "agent-desktop");
  assert.equal(info.external.available, true);
  assert.equal(info.fallback, "builtin-uia");

  const listed = await bridge.listWindows({ query: "计划" });
  assert.equal(listed.ok, true);
  assert.equal(listed.driver, "agent-desktop");
  // 自保护过滤生效：仅保留 notepad
  assert.equal(listed.windows.length, 1);
  assert.equal(listed.windows[0].processName, "notepad");

  const snap = await bridge.snapshot({ hwnd: 1001 });
  assert.equal(snap.ok, true);
  assert.equal(snap.driver, "agent-desktop");
  assert.equal(snap.snapshotId, 1);
  assert.equal(snap.elements.length, 2);
  assert.equal(snap.elements[0].ref, "@1:e1");
  assert.equal(snap.elements[1].ref, "@1:e2");
  // 密码框 value 强制擦除为 null
  assert.equal(snap.elements[1].isPassword, true);
  assert.equal(snap.elements[1].value, null);

  const actRes = await bridge.act({ ref: "@1:e1", action: "click" });
  assert.equal(actRes.ok, true);
  assert.equal(actRes.driver, "agent-desktop");
  assert.equal(actRes.ref, "@1:e1");
  const actCall = extCalls.find((c) => c.op === "act");
  assert.equal(actCall.args.ref, "@99:e1");

  const cap = await bridge.captureWindow({ hwnd: 1001 });
  assert.equal(cap.ok, true);
  assert.equal(cap.driver, "agent-desktop");
  assert.equal(cap.base64, TINY_PNG.toString("base64"));

  // 内置 winHelper 全程未被触达
  assert.equal(winCalls.length, 0);
});

test("accessibility-bridge: falls back to builtin-uia when externalDriver unavailable, enforces ref/focus/self-protection/cache eviction", async () => {
  const helperCalls = [];
  const bridge = createAccessibilityBridge({
    platform: "win32",
    selfPid: 7777,
    maxSnapshots: 2,
    externalDriver: {
      name: "agent-desktop",
      async isAvailable() {
        return { available: false, reason: "binary_not_found" };
      },
    },
    winHelper: {
      async request(cmd, payload) {
        helperCalls.push({ cmd, payload });
        if (cmd === "win_list") {
          return {
            windows: [
              {
                hwnd: 2001,
                pid: 5100,
                processStartTicks: "133800000000",
                processName: "notepad",
                title: "笔记.txt",
                isActive: false,
                isMinimized: false,
                bounds: { left: 0, top: 0, width: 640, height: 480 },
              },
            ],
          };
        }
        if (cmd === "uia_snapshot") {
          return {
            ok: true,
            found: true,
            window: {
              hwnd: 2001,
              pid: 5100,
              processStartTicks: "133800000000",
              processName: "notepad",
              title: "笔记.txt",
            },
            nodes: [
              {
                role: "text",
                name: "静态标题",
                patterns: [],
                bounds: { x: 0, y: 0, width: 100, height: 20 },
              },
              {
                role: "button",
                name: "确定",
                automationId: "okBtn",
                patterns: ["invoke"],
                runtimeId: "42.2001.1",
                uniqueAtCapture: true,
                bounds: { x: 10, y: 30, width: 80, height: 28 },
              },
              {
                role: "edit",
                name: "口令",
                automationId: "pwdBox",
                isPassword: true,
                value: "should-never-leak",
                patterns: ["value"],
                runtimeId: "42.2001.2",
                uniqueAtCapture: true,
                bounds: { x: 10, y: 70, width: 140, height: 28 },
              },
            ],
            totalVisited: 5,
            truncated: false,
          };
        }
        if (cmd === "uia_act") {
          return {
            ok: true,
            action: payload.action,
            matchedName: payload.target?.name || "",
            patternUsed: "invoke",
            delivery: "delivered_verified",
          };
        }
        if (cmd === "win_capture") {
          return {
            ok: true,
            format: "png",
            hwnd: 2001,
            pid: 5100,
            processStartTicks: "133800000000",
            processName: "notepad",
            title: "笔记.txt",
            width: 1,
            height: 1,
            windowWidth: 640,
            windowHeight: 480,
            base64: TINY_PNG.toString("base64"),
          };
        }
        return {};
      },
    },
  });

  const info = await bridge.driverInfo();
  assert.equal(info.mode, "builtin");
  assert.equal(info.active, "builtin-uia");

  // 自保护红线：进程名 / bundleId / 自身 PID / 审批弹窗标题均立即拦截，不进入驱动
  for (const target of [
    { pid: 7777 },
    { processName: "C:\\Program Files\\ChisaBot\\ChisaBot.exe" },
    { bundleId: "cn.ayase.chisabot.pc" },
    { title: "ChisaBot 审批 - 确认执行" },
    { title: "ChisaBot 确认窗口" },
  ]) {
    const snapDeny = await bridge.snapshot(target);
    assert.equal(snapDeny.ok, false);
    assert.equal(snapDeny.code, "SELF_TARGET_FORBIDDEN");
    const capDeny = await bridge.captureWindow(target);
    assert.equal(capDeny.ok, false);
    assert.equal(capDeny.code, "SELF_TARGET_FORBIDDEN");
  }
  assert.equal(helperCalls.length, 0);

  // 禁止 --headed
  const headedDeny = await bridge.listWindows({ extraArgs: ["--headed"] });
  assert.equal(headedDeny.ok, false);
  assert.equal(headedDeny.code, "POLICY_DENIED");

  // 禁止 focus
  const focusDeny = await bridge.act({ ref: "@1:e1", action: "focus" });
  assert.equal(focusDeny.ok, false);
  assert.equal(focusDeny.code, "POLICY_DENIED");

  // 裸 @e1 拒绝并报 STALE_REF
  const bareRef = await bridge.act({ ref: "@e1", action: "click" });
  assert.equal(bareRef.ok, false);
  assert.equal(bareRef.code, "STALE_REF");

  // 内置 snapshot 仅对交互/可执行节点分配 @<snapshotId>:e<N>，并擦除密码值
  const s1 = await bridge.snapshot({ hwnd: 2001 });
  assert.equal(s1.ok, true);
  assert.equal(s1.driver, "builtin-uia");
  assert.equal(s1.snapshotId, 1);
  assert.equal(s1.elements[0].ref, null);
  assert.equal(s1.elements[1].ref, "@1:e1");
  assert.equal(s1.elements[2].ref, "@1:e2");
  assert.equal(s1.elements[2].value, null);

  // 内置 act 命中本地 refMap 并透传给 uia_act
  const actOk = await bridge.act({ ref: "@1:e1", action: "click" });
  assert.equal(actOk.ok, true);
  assert.equal(actOk.driver, "builtin-uia");
  const uiaActCall = helperCalls.find((c) => c.cmd === "uia_act");
  assert.equal(uiaActCall.payload.hwnd, 2001);
  assert.equal(uiaActCall.payload.excludePid, 7777);
  assert.equal(uiaActCall.payload.target.runtimeId, "42.2001.1");

  // 快照淘汰（maxSnapshots = 2）：连抓 2 次后快照 #1 过期 -> STALE_REF
  const s2 = await bridge.snapshot({ hwnd: 2001 });
  const s3 = await bridge.snapshot({ hwnd: 2001 });
  assert.equal(s2.snapshotId, 2);
  assert.equal(s3.snapshotId, 3);
  const evicted = await bridge.act({ ref: "@1:e1", action: "click" });
  assert.equal(evicted.ok, false);
  assert.equal(evicted.code, "STALE_REF");

  // 抓图走 win_capture
  const cap = await bridge.captureWindow({ hwnd: 2001 });
  assert.equal(cap.ok, true);
  assert.equal(cap.driver, "builtin-uia");
  assert.equal(cap.width, 1);
});

test("accessibility-bridge: macOS captureWindow uses screencapture -x -t png -l and cleans up temp PNG; Linux fails closed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-mac-cap-test-"));
  const runnerCalls = [];
  let capturedTmpPath = "";
  try {
    const macBridge = createAccessibilityBridge({
      platform: "darwin",
      preferExternalDriver: false,
      tmpDir,
      runner: async (file, args) => {
        runnerCalls.push({ file, args });
        if (file === "/usr/sbin/screencapture") {
          capturedTmpPath = args[args.length - 1];
          fs.writeFileSync(capturedTmpPath, TINY_PNG);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, windows: [] }),
          stderr: "",
        };
      },
    });
    const res = await macBridge.captureWindow({
      hwnd: 4321,
      pid: 3333,
      processName: "TextEdit",
      title: "Draft.txt",
    });
    assert.equal(res.ok, true);
    assert.equal(res.driver, "builtin-mac-ax");
    assert.equal(res.hwnd, 4321);
    assert.equal(res.width, 1);
    assert.equal(res.height, 1);
    assert.equal(runnerCalls[0].file, "/usr/sbin/screencapture");
    assert.deepEqual(runnerCalls[0].args.slice(0, 5), [
      "-x",
      "-t",
      "png",
      "-l",
      "4321",
    ]);
    assert.ok(capturedTmpPath);
    assert.equal(
      fs.existsSync(capturedTmpPath),
      false,
      "临时 PNG 必须在 finally 中删除",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Linux 无外部驱动时 fail-closed 返回 DRIVER_UNAVAILABLE
  const linuxBridge = createAccessibilityBridge({
    platform: "linux",
    preferExternalDriver: false,
  });
  const linuxInfo = await linuxBridge.driverInfo();
  assert.equal(linuxInfo.active, "builtin-linux-stub");
  assert.equal(linuxInfo.available, false);
  const linuxAct = await linuxBridge.act({
    ref: "@1:e1",
    action: "click",
    _resolved: {
      snapshotId: 1,
      window: { hwnd: 1, pid: 100, processName: "gedit", title: "a" },
      element: { ref: "@1:e1", role: "button", name: "Save" },
    },
  });
  assert.equal(linuxAct.ok, false);
  assert.equal(linuxAct.code, "DRIVER_UNAVAILABLE");
});

test("ops.js: exposes desktop_windows/desktop_snapshot/desktop_act/window_screenshot + desktop_bg_v1 and stopAll revokes grants", async () => {
  const seen = [];
  const bridge = createAccessibilityBridge({
    platform: "win32",
    externalDriver: {
      name: "agent-desktop",
      async isAvailable() {
        return { available: true, version: "1.0.0" };
      },
      async listWindows(args) {
        seen.push(["listWindows", args]);
        return { ok: true, driver: "agent-desktop", windows: [] };
      },
      async snapshot(args) {
        seen.push(["snapshot", args]);
        return {
          ok: true,
          driver: "agent-desktop",
          window: { hwnd: 55, pid: 888, processName: "calc", title: "计算器" },
          nodes: [
            { ref: "@1:e1", role: "button", name: "7", patterns: ["invoke"] },
          ],
        };
      },
      async act(args) {
        seen.push(["act", args]);
        return { ok: true, driver: "agent-desktop", action: args.action };
      },
      async captureWindow(args) {
        seen.push(["captureWindow", args]);
        return {
          ok: true,
          driver: "agent-desktop",
          format: "png",
          hwnd: 55,
          width: 1,
          height: 1,
          base64: TINY_PNG.toString("base64"),
        };
      },
    },
  });

  const ops = createOps({ platform: "win32", accessibilityBridge: bridge });
  assert.equal(ops.accessibilityBridge, bridge);
  for (const feat of [
    "desktop_windows",
    "desktop_snapshot",
    "desktop_act",
    "window_screenshot",
    "desktop_bg_v1",
  ]) {
    assert.ok(ops.features.includes(feat), `features 必须包含 ${feat}`);
  }

  assert.equal((await ops.run("desktop_windows", {})).ok, true);
  assert.equal((await ops.run("desktop_snapshot", { hwnd: 55 })).ok, true);
  assert.equal(
    (await ops.run("desktop_act", { ref: "@1:e1", action: "click" })).ok,
    true,
  );
  assert.equal((await ops.run("window_screenshot", { hwnd: 55 })).ok, true);
  assert.deepEqual(
    seen.map((item) => item[0]),
    ["listWindows", "snapshot", "act", "captureWindow"],
  );

  // 写入一个回合授权，调用 stopAll 必须立即撤销授权并清空本地快照缓存
  bridge.authorizer.authorizeApp({
    conversationId: "conv-1",
    deviceId: "dev-1",
    bundleId: "calc",
    scopes: [ACCESSIBILITY_SCOPE],
  });
  assert.equal(bridge.authorizer.snapshot().grants.length, 1);
  ops.stopAll("paused");
  assert.equal(bridge.authorizer.snapshot().grants.length, 0);
  const afterStopAct = await ops.run("desktop_act", {
    ref: "@1:e1",
    action: "click",
  });
  assert.equal(afterStopAct.ok, false);
  assert.equal(afterStopAct.code, "STALE_REF");
});

test("accessibility-bridge: macOS type on password fails closed (POLICY_DENIED) and missing external snapshot fails closed (STALE_REF)", async () => {
  // 1. JXA 脚本层禁止对密码框读取 el.value()
  const pwdTypeScript = buildMacBgActionScript({
    window: { hwnd: 100, pid: 200, bundleId: "com.apple.textedit" },
    target: {
      role: "axsecuretextfield",
      name: "密码",
      isPassword: true,
    },
    action: "type",
    value: "abc",
  });
  assert.match(pwdTypeScript, /targetIsPassword\s*=\s*true/);
  assert.match(pwdTypeScript, /POLICY_DENIED/);

  // 2. JS 桥层在调 runner 前直接 fail-closed 拦截密码框 type
  let runnerInvoked = 0;
  const macBridge = createAccessibilityBridge({
    platform: "darwin",
    preferExternalDriver: false,
    runner: async () => {
      runnerInvoked += 1;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  });
  const pwdActRes = await macBridge.act({
    ref: "@1:e1",
    action: "type",
    value: "secret",
    _resolved: {
      snapshotId: 1,
      driver: "builtin-mac-ax",
      window: { hwnd: 100, pid: 200, bundleId: "com.apple.textedit" },
      element: {
        ref: "@1:e1",
        role: "axsecuretextfield",
        name: "密码",
        isPassword: true,
      },
    },
  });
  assert.equal(pwdActRes.ok, false);
  assert.equal(pwdActRes.code, "POLICY_DENIED");
  assert.equal(runnerInvoked, 0);

  // 3. 外部快照本地映射缺失时，绝不把合成 @1:e1 传给 externalDriver，直接返回 STALE_REF
  let extActCalls = 0;
  const extBridge = createAccessibilityBridge({
    platform: "win32",
    externalDriver: {
      name: "agent-desktop",
      async isAvailable() {
        return { available: true, version: "1.0.0" };
      },
      async act() {
        extActCalls += 1;
        return { ok: true };
      },
    },
  });
  const missingLocal = await extBridge.act({
    ref: "@1:e1",
    action: "click",
    _resolved: {
      snapshotId: 1,
      driver: "agent-desktop",
      window: { hwnd: 10, pid: 500, processName: "notepad", title: "Note" },
      element: { ref: "@1:e1", role: "button", name: "保存" },
    },
  });
  assert.equal(missingLocal.ok, false);
  assert.equal(missingLocal.code, "STALE_REF");
  assert.equal(extActCalls, 0);
});

test("integration: real createAgentDesktopDriver (snapshot_id: 's1', ref_id: '@e1') + createAccessibilityBridge snapshot -> act roundtrip", async () => {
  const spawnArgs = [];
  const fakeBin = path.join(os.tmpdir(), `cb-ad-wire-${process.pid}.exe`);
  fs.writeFileSync(fakeBin, "mock-bin");
  try {
    const mockSpawn = (_file, args) => {
      spawnArgs.push([...args]);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        if (args[0] === "--version") {
          child.stdout.end("agent-desktop 0.9.5\n");
          child.emit("close", 0);
        } else if (args[0] === "snapshot") {
          child.stdout.end(
            JSON.stringify({
              ok: true,
              data: {
                snapshot_id: "s1",
                window: {
                  window_id: 3001,
                  pid: 6123,
                  app: "notepad",
                  title: "草稿.txt",
                },
                tree: {
                  ref_id: "@e1",
                  role: "button",
                  name: "保存",
                  available_actions: ["click"],
                  bounds: { x: 10, y: 20, width: 60, height: 24 },
                },
              },
            }),
          );
          child.emit("close", 0);
        } else if (args[0] === "click") {
          child.stdout.end(
            JSON.stringify({
              ok: true,
              data: { matchedName: "保存", delivery: "delivered_verified" },
            }),
          );
          child.emit("close", 0);
        } else {
          child.stdout.end(JSON.stringify({ ok: true, data: {} }));
          child.emit("close", 0);
        }
      });
      return child;
    };

    const driver = createAgentDesktopDriver({
      platform: "win32",
      binPath: fakeBin,
      spawn: mockSpawn,
    });
    const bridge = createAccessibilityBridge({
      platform: "win32",
      externalDriver: driver,
    });

    const snap = await bridge.snapshot({ hwnd: 3001 });
    assert.equal(snap.ok, true);
    assert.equal(snap.driver, "agent-desktop");
    assert.equal(snap.snapshotId, 1);
    assert.equal(snap.elements[0].ref, "@1:e1");

    const actRes = await bridge.act({ ref: "@1:e1", action: "click" });
    assert.equal(actRes.ok, true);
    assert.equal(actRes.driver, "agent-desktop");
    assert.equal(actRes.ref, "@1:e1");
    const clickCall = spawnArgs.find((a) => a[0] === "click");
    assert.ok(clickCall, "应向外部驱动发起 click 命令");
    assert.equal(clickCall[1], "@e1", "应把 @1:e1 准确回译为原生 @e1");
  } finally {
    fs.rmSync(fakeBin, { force: true });
  }
});

test("core.js: OPERATION_CAPABILITY, summary redaction, forceLocalApproval + directionEpoch lease + advance + high-risk bypass + pause revoke", async (t) => {
  assert.equal(OPERATION_CAPABILITY.desktop_windows, "screenshot");
  assert.equal(OPERATION_CAPABILITY.desktop_snapshot, "screenshot");
  assert.equal(OPERATION_CAPABILITY.desktop_act, "input");
  assert.equal(OPERATION_CAPABILITY.window_screenshot, "screenshot");

  // 摘要脱敏校验：密码值绝不泄露
  const pwdSummary = summarize("desktop_act", {
    ref: "@2:e5",
    action: "set_value",
    value: "my-super-secret-password",
    _resolved: {
      window: { processName: "notepad", title: "登录" },
      element: { name: "密码输入框", role: "edit", isPassword: true },
    },
  });
  assert.match(pwdSummary, /notepad/);
  assert.match(pwdSummary, /密码输入框/);
  assert.match(pwdSummary, /@2:e5/);
  assert.match(pwdSummary, /已隐藏密码/);
  assert.ok(!pwdSummary.includes("my-super-secret-password"));

  // WebSocket 全链路测试：forceLocalApproval + directionEpoch 回合缓存 + advance + 高敏/scopes/断线清空
  const wss = new WebSocketServer({ port: 0 });
  const port = wss.address().port;
  const received = [];
  let serverWs = null;
  let currentDevice = {
    id: "dev_bg_1",
    name: "测试电脑",
    paused: false,
    allowedRoots: [],
    grantedScopes: ["accessibility_control"],
    capabilities: {
      shell: "off",
      files_read: "off",
      files_write: "off",
      screenshot: "allow",
      input: "allow",
      open: "off",
      clipboard: "off",
    },
  };
  let onNextConnect = null;
  const connected = new Promise((resolve) => {
    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.on("message", (m) => received.push(JSON.parse(String(m))));
      ws.send(JSON.stringify({ type: "welcome", device: currentDevice }));
      resolve(ws);
      if (onNextConnect) {
        const cb = onNextConnect;
        onNextConnect = null;
        cb(ws);
      }
    });
  });

  const bridge = createAccessibilityBridge({
    platform: "win32",
    externalDriver: {
      name: "agent-desktop",
      async isAvailable() {
        return { available: true, version: "1.0.0" };
      },
      async snapshot(args) {
        return {
          ok: true,
          driver: "agent-desktop",
          window: {
            hwnd: args.hwnd || 10,
            pid: 500,
            processName: args.processName || "notepad",
            bundleId: args.bundleId || args.processName || "notepad",
            title: "App",
          },
          nodes: [
            {
              ref: "@1:e1",
              role: "button",
              name: "确认",
              patterns: ["invoke"],
            },
          ],
        };
      },
      async act(args) {
        return { ok: true, driver: "agent-desktop", action: args.action };
      },
    },
  });

  const ops = createOps({ platform: "win32", accessibilityBridge: bridge });
  const prompts = [];
  const agent = createNodeAgent({
    serverUrl: `http://127.0.0.1:${port}`,
    getToken: () => "cbd_bg_test",
    ops,
    WebSocket,
    backoffBaseMs: 50,
    local: () => ({ paused: false, forceLocalApproval: true }),
    approve: async (req) => {
      prompts.push(req);
      return "approve";
    },
    clientInfo: { clientVersion: "test" },
  });
  t.after(() => {
    agent.stop();
    wss.close();
  });
  agent.start();

  const waitFor = async (pred) => {
    for (let i = 0; i < 120; i += 1) {
      const hit = received.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timeout waiting for ws message");
  };

  await connected;
  const hello = await waitFor((m) => m.type === "hello");
  assert.ok(hello.features.includes("desktop_bg_v1"));
  assert.ok(hello.features.includes("desktop_act"));

  // 先抓一份真实快照以填充本地 refMap（确保外部快照映射存在）
  const snapInit = await ops.run("desktop_snapshot", {
    hwnd: 10,
    processName: "notepad",
  });
  assert.equal(snapInit.ok, true);
  assert.equal(snapInit.snapshotId, 1);

  const makeActCall = (
    id,
    processName,
    {
      conversationId = "conv_turn_1",
      bundleId = processName,
      ref = "@1:e1",
      snapshotId = 1,
      directionEpoch,
    } = {},
  ) => ({
    type: "call",
    id,
    operation: "desktop_act",
    botName: "助手",
    args: {
      ref,
      action: "click",
      conversationId,
      ...(directionEpoch !== undefined ? { directionEpoch } : {}),
      _resolved: {
        snapshotId,
        driver: "agent-desktop",
        window: {
          hwnd: 10,
          pid: 500,
          processName,
          bundleId,
          title: "App",
        },
        element: { ref, role: "button", name: "确认" },
      },
    },
  });

  // 第 1 次操控 notepad：触发本机确认窗，批准后写入回合租约
  serverWs.send(JSON.stringify(makeActCall("call_1", "notepad")));
  const r1 = await waitFor((m) => m.type === "result" && m.id === "call_1");
  assert.equal(r1.ok, true);
  assert.equal(r1.result.ok, true);
  assert.equal(prompts.length, 1);

  // 第 2 次同回合操控 notepad：命中回合租约，免重复弹窗
  serverWs.send(JSON.stringify(makeActCall("call_2", "notepad")));
  const r2 = await waitFor((m) => m.type === "result" && m.id === "call_2");
  assert.equal(r2.ok, true);
  assert.equal(prompts.length, 1);

  // 传过期 directionEpoch（与当前 epoch=1 不一致）：不命中租约，必须弹窗
  serverWs.send(
    JSON.stringify(makeActCall("call_2b", "notepad", { directionEpoch: 99 })),
  );
  const r2b = await waitFor((m) => m.type === "result" && m.id === "call_2b");
  assert.equal(r2b.ok, true);
  assert.equal(prompts.length, 2);

  // 切换目标应用到 calc：未授权，必须再次弹窗
  serverWs.send(JSON.stringify(makeActCall("call_3", "calc")));
  const r3 = await waitFor((m) => m.type === "result" && m.id === "call_3");
  assert.equal(r3.ok, true);
  assert.equal(prompts.length, 3);

  // 高敏进程（Windows powershell + macOS 反向域名 com.apple.Terminal / com.1password.1password + 良性 bundleId 搭配高敏 processName）
  serverWs.send(JSON.stringify(makeActCall("call_4", "powershell.exe")));
  await waitFor((m) => m.type === "result" && m.id === "call_4");
  assert.equal(prompts.length, 4);
  serverWs.send(JSON.stringify(makeActCall("call_5", "powershell.exe")));
  await waitFor((m) => m.type === "result" && m.id === "call_5");
  assert.equal(prompts.length, 5);

  serverWs.send(
    JSON.stringify(
      makeActCall("call_5b", "Terminal", { bundleId: "com.apple.Terminal" }),
    ),
  );
  await waitFor((m) => m.type === "result" && m.id === "call_5b");
  assert.equal(prompts.length, 6);
  serverWs.send(
    JSON.stringify(
      makeActCall("call_5c", "Terminal", { bundleId: "com.apple.Terminal" }),
    ),
  );
  await waitFor((m) => m.type === "result" && m.id === "call_5c");
  assert.equal(prompts.length, 7);

  serverWs.send(
    JSON.stringify(
      makeActCall("call_5d", "1Password", {
        bundleId: "com.1password.1password",
      }),
    ),
  );
  await waitFor((m) => m.type === "result" && m.id === "call_5d");
  assert.equal(prompts.length, 8);
  serverWs.send(
    JSON.stringify(
      makeActCall("call_5e", "1Password", {
        bundleId: "com.1password.1password",
      }),
    ),
  );
  await waitFor((m) => m.type === "result" && m.id === "call_5e");
  assert.equal(prompts.length, 9);

  serverWs.send(
    JSON.stringify(
      makeActCall("call_5f", "keepassxc", { bundleId: "com.example.wrapper" }),
    ),
  );
  await waitFor((m) => m.type === "result" && m.id === "call_5f");
  assert.equal(prompts.length, 10);
  serverWs.send(
    JSON.stringify(
      makeActCall("call_5g", "keepassxc", { bundleId: "com.example.wrapper" }),
    ),
  );
  await waitFor((m) => m.type === "result" && m.id === "call_5g");
  assert.equal(prompts.length, 11);

  // 服务端回收 grantedScopes（移除 accessibility_control）：立即禁用回合免确认
  currentDevice = { ...currentDevice, grantedScopes: [] };
  serverWs.send(JSON.stringify({ type: "config", device: currentDevice }));
  await new Promise((r) => setTimeout(r, 30));
  serverWs.send(JSON.stringify(makeActCall("call_scope_1", "notepad")));
  await waitFor((m) => m.type === "result" && m.id === "call_scope_1");
  assert.equal(prompts.length, 12);
  serverWs.send(JSON.stringify(makeActCall("call_scope_2", "notepad")));
  await waitFor((m) => m.type === "result" && m.id === "call_scope_2");
  assert.equal(prompts.length, 13);

  // 恢复 grantedScopes 后重新验证 direction_epoch_advance
  currentDevice = {
    ...currentDevice,
    grantedScopes: ["accessibility_control"],
  };
  serverWs.send(JSON.stringify({ type: "config", device: currentDevice }));
  await new Promise((r) => setTimeout(r, 30));

  // 收到 direction_epoch_advance：上一回合 notepad 授权立刻作废，再调必须重新弹窗
  serverWs.send(
    JSON.stringify({
      type: "direction_epoch_advance",
      conversationId: "conv_turn_1",
    }),
  );
  await new Promise((r) => setTimeout(r, 30));
  serverWs.send(JSON.stringify(makeActCall("call_6", "notepad")));
  const r6 = await waitFor((m) => m.type === "result" && m.id === "call_6");
  assert.equal(r6.ok, true);
  assert.equal(prompts.length, 14);

  // 急停（paused: true）立刻清空所有回合授权与本地快照
  assert.ok(bridge.authorizer.snapshot().grants.length >= 1);
  agent.setConfig({ paused: true });
  assert.equal(bridge.authorizer.snapshot().grants.length, 0);
  const staleAfterPause = await ops.run("desktop_act", {
    ref: "@1:e1",
    action: "click",
  });
  assert.equal(staleAfterPause.ok, false);
  assert.equal(staleAfterPause.code, "STALE_REF");
  agent.setConfig({ paused: false });

  // 重新快照后再授权一次，验证普通断线（ws.terminate）也会清空租约与本地快照
  const snapAfterPause = await ops.run("desktop_snapshot", {
    hwnd: 10,
    processName: "notepad",
  });
  assert.equal(snapAfterPause.snapshotId, 2);
  serverWs.send(
    JSON.stringify(
      makeActCall("call_7", "notepad", { ref: "@2:e1", snapshotId: 2 }),
    ),
  );
  const r7 = await waitFor((m) => m.type === "result" && m.id === "call_7");
  assert.equal(r7.ok, true);
  assert.equal(prompts.length, 15);
  assert.ok(bridge.authorizer.snapshot().grants.length >= 1);

  const reconnected = new Promise((resolve) => {
    onNextConnect = resolve;
  });
  serverWs.terminate();
  await reconnected;
  assert.equal(
    bridge.authorizer.snapshot().grants.length,
    0,
    "普通断线必须清空回合租约",
  );
  const staleAfterDrop = await ops.run("desktop_act", {
    ref: "@2:e1",
    action: "click",
  });
  assert.equal(staleAfterDrop.ok, false);
  assert.equal(staleAfterDrop.code, "STALE_REF", "普通断线必须清空本地快照");
});

test("main.js and headless.js wire shared accessibilityBridge without Electron top-level leaks", () => {
  const mainSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8",
  );
  assert.match(mainSrc, /accessibilityBridge:\s*getAccessibilityBridge\(\)/);

  const headlessSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "headless.js"),
    "utf8",
  );
  assert.match(headlessSrc, /createAccessibilityBridge/);
  assert.match(headlessSrc, /accessibilityBridge/);
  assert.match(headlessSrc, /disposeWinPsHelper/);

  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "accessibility-bridge.js"),
    "utf8",
  );
  assert.doesNotMatch(bridgeSrc, /require\(["']electron["']\)/);

  const driverSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "agent", "agent-desktop-driver.js"),
    "utf8",
  );
  assert.doesNotMatch(driverSrc, /require\(["']electron["']\)/);
});
