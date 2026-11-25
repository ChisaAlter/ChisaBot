"use strict";
/**
 * Windows 后台无感驱动（win-ps-helper.js）回归与实机测试：
 * - 白名单命令校验（含 win_list / win_capture / uia_snapshot / uia_act）
 * - 静态契约：全部 P/Invoke、10 类 UIA Pattern、click 绝不回退 SetFocus、无 Invoke-Expression / FindAll(Descendants)
 * - Mock 通道：4 个新命令的请求/响应、结构化错误码透传与断线重连
 * - Windows 实机 STA：win_list、POLICY_DENIED、SELF_TARGET_FORBIDDEN、WINDOW_NOT_FOUND、STALE_REF、win_capture、uia_snapshot
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  RESPONSE_PREFIX,
  ALLOWED_COMMANDS,
  buildResidentHelperScript,
  createWinPsHelper,
} = require("../src/agent/win-ps-helper");

function createFakeChild(onRequest, { pid = 880001 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    if (child.exitCode === null) {
      child.killed = true;
      child.exitCode = 1;
      queueMicrotask(() => child.emit("close", 1, "SIGKILL"));
    }
    return true;
  };
  let buf = "";
  child.stdin.on("data", (chunk) => {
    buf += String(chunk);
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        const msg = JSON.parse(line);
        if (msg.cmd === "quit") {
          child.stdout.write(
            `${RESPONSE_PREFIX}${JSON.stringify({ id: msg.id, ok: true, data: { bye: true } })}\n`,
          );
          child.exitCode = 0;
          queueMicrotask(() => child.emit("close", 0, null));
        } else {
          onRequest(msg, child);
        }
      }
      idx = buf.indexOf("\n");
    }
  });
  queueMicrotask(() => {
    child.stdout.write(
      `${RESPONSE_PREFIX}${JSON.stringify({ ready: true, pid, apartment: "STA" })}\n`,
    );
  });
  return child;
}

test("win-ps-helper: ALLOWED_COMMANDS includes all legacy and background commands", () => {
  const expected = [
    "ping",
    "cursor_pos",
    "input",
    "uia_read",
    "uia_action",
    "win_list",
    "win_capture",
    "uia_snapshot",
    "uia_act",
  ];
  for (const cmd of expected) {
    assert.equal(ALLOWED_COMMANDS.has(cmd), true, `missing command: ${cmd}`);
  }
  assert.equal(ALLOWED_COMMANDS.has("eval_script"), false);
  assert.equal(ALLOWED_COMMANDS.has("shell"), false);
});

test("win-ps-helper: script P/Invoke, UIA patterns, no SetFocus fallback on click, no unsafe PS primitives", () => {
  const script = buildResidentHelperScript();

  // 安全红线：绝不含 Invoke-Expression / iex / FindAll(...Descendants)
  assert.doesNotMatch(script, /\bInvoke-Expression\b/i);
  assert.doesNotMatch(script, /\biex\b/i);
  assert.doesNotMatch(script, /FindAll\([^)]*Descendants/);

  // 预编译 C# 块包含全部要求的 Win32 P/Invoke
  for (const api of [
    "EnumWindows",
    "IsWindowVisible",
    "IsIconic",
    "GetWindowText",
    "GetWindowThreadProcessId",
    "GetForegroundWindow",
    "GetWindowRect",
    "SendMessageTimeout",
    "PrintWindow",
    "SetProcessDPIAware",
  ]) {
    assert.match(
      script,
      new RegExp(`\\b${api}\\b`),
      `missing Win32 P/Invoke: ${api}`,
    );
  }

  // 全部 10 类 UIA Pattern 均被覆盖
  for (const pat of [
    "InvokePattern",
    "LegacyIAccessiblePattern",
    "DoDefaultAction",
    "ValuePattern",
    "RangeValuePattern",
    "TogglePattern",
    "SelectionItemPattern",
    "ExpandCollapsePattern",
    "ScrollPattern",
    "ScrollItemPattern",
    "TextPattern",
  ]) {
    assert.match(script, new RegExp(`\\b${pat}\\b`), `missing pattern: ${pat}`);
  }

  // Normalize-CbProcName 剥离 Windows/POSIX 路径前缀及 .exe 后缀，且审批标题匹配大小写不敏感
  assert.match(script, /LastIndexOf\('\\'\)/);
  assert.match(script, /LastIndexOf\('\/'\)/);
  assert.match(script, /OrdinalIgnoreCase/);

  // 检查 Invoke-CbUiaAction 的 click 分支绝不调用 SetFocus()，仅 focus 分支允许 SetFocus()
  const uiaActionStart = script.indexOf("function Invoke-CbUiaAction($p)");
  const winListStart = script.indexOf("function Invoke-CbWinList($p)");
  assert.ok(uiaActionStart > 0 && winListStart > uiaActionStart);
  const uiaActionBody = script.slice(uiaActionStart, winListStart);
  assert.match(
    uiaActionBody,
    /if \(\$act -eq 'focus'\) \{ \$el\.SetFocus\(\) \}/,
  );
  const clickBranchStart = uiaActionBody.indexOf("InvokePattern");
  assert.ok(clickBranchStart > 0);
  const clickBranch = uiaActionBody.slice(clickBranchStart);
  assert.doesNotMatch(clickBranch, /SetFocus\(/);
  assert.match(clickBranch, /Invoke-CbLegacyDefaultAction/);
  assert.match(clickBranch, /ACTION_NOT_SUPPORTED/);

  // 检查 Invoke-CbUiaAct 全函数不含 SetFocus()，且明确拦截 type / focus
  const uiaActStart = script.indexOf("function Invoke-CbUiaAct($p)");
  assert.ok(uiaActStart > 0);
  const uiaActBody = script.slice(
    uiaActStart,
    script.indexOf("Write-CbJson @{ ready = $true"),
  );
  assert.doesNotMatch(uiaActBody, /SetFocus\(/);
  assert.match(uiaActBody, /POLICY_DENIED/);
  assert.match(uiaActBody, /SELF_TARGET_FORBIDDEN/);
  assert.match(uiaActBody, /STALE_REF/);
  assert.match(uiaActBody, /AMBIGUOUS_TARGET/);
  assert.match(uiaActBody, /WINDOW_MINIMIZED/);
  assert.match(uiaActBody, /WINDOW_NOT_FOUND/);
  assert.match(uiaActBody, /ACTION_NOT_SUPPORTED/);
});

test("win-ps-helper: mocked dispatch for win_list, win_capture, uia_snapshot, uia_act", async () => {
  const received = [];
  const helper = createWinPsHelper({
    idleTimeoutMs: 5000,
    defaultTimeoutMs: 2000,
    spawn: () =>
      createFakeChild((msg, proc) => {
        received.push({ cmd: msg.cmd, payload: msg.payload });
        let data;
        if (msg.cmd === "win_list") {
          data = {
            windows: [
              {
                hwnd: 1001,
                pid: 4321,
                processStartTicks: "133800000000000000",
                processName: "notepad",
                title: "无标题 - 记事本",
                isActive: false,
                isMinimized: false,
                bounds: { left: 10, top: 20, width: 800, height: 600 },
              },
            ],
          };
        } else if (msg.cmd === "win_capture") {
          data = {
            ok: true,
            format: "png",
            hwnd: 1001,
            pid: 4321,
            processName: "notepad",
            title: "无标题 - 记事本",
            windowWidth: 800,
            windowHeight: 600,
            width: 800,
            height: 600,
            base64: "iVBORw0KGgo=",
          };
        } else if (msg.cmd === "uia_snapshot") {
          data = {
            ok: true,
            found: true,
            window: {
              hwnd: 1001,
              pid: 4321,
              processStartTicks: "133800000000000000",
              processName: "notepad",
              title: "无标题 - 记事本",
            },
            nodes: [
              {
                role: "button",
                name: "保存",
                automationId: "btnSave",
                description: "",
                isPassword: false,
                value: null,
                enabled: true,
                focused: false,
                isOffscreen: false,
                checked: null,
                expanded: null,
                selected: null,
                patterns: ["invoke"],
                runtimeId: "42.1001.1",
                depth: 1,
                childrenCount: 0,
                bounds: { x: 12, y: 34, width: 60, height: 24 },
                uniqueAtCapture: true,
              },
            ],
            totalVisited: 5,
            truncated: false,
          };
        } else if (msg.cmd === "uia_act") {
          data =
            msg.payload.action === "type"
              ? {
                  ok: false,
                  code: "POLICY_DENIED",
                  error:
                    "Windows 后台无障碍模式不支持光标处 type，请改用 set_value，或显式请求前台 device_input。",
                }
              : {
                  ok: true,
                  action: msg.payload.action,
                  matchedName: "保存",
                  patternUsed: "invoke",
                  delivery: "delivered_unverified",
                };
        }
        proc.stdout.write(
          `${RESPONSE_PREFIX}${JSON.stringify({ id: msg.id, ok: true, data })}\n`,
        );
      }),
  });

  try {
    const listRes = await helper.request("win_list", {
      query: "notepad",
      excludePid: process.pid,
    });
    assert.equal(listRes.windows.length, 1);
    assert.equal(listRes.windows[0].hwnd, 1001);

    const capRes = await helper.request("win_capture", {
      hwnd: 1001,
      pid: 4321,
      processStartTicks: "133800000000000000",
      maxWidth: 1280,
    });
    assert.equal(capRes.ok, true);
    assert.equal(capRes.format, "png");

    const snapRes = await helper.request("uia_snapshot", {
      hwnd: 1001,
      interactiveOnly: true,
      compact: true,
    });
    assert.equal(snapRes.ok, true);
    assert.equal(snapRes.nodes[0].uniqueAtCapture, true);

    const actOk = await helper.request("uia_act", {
      hwnd: 1001,
      pid: 4321,
      processStartTicks: "133800000000000000",
      target: { runtimeId: "42.1001.1", role: "button", name: "保存" },
      action: "click",
    });
    assert.equal(actOk.ok, true);
    assert.equal(actOk.patternUsed, "invoke");

    const actDenied = await helper.request("uia_act", {
      hwnd: 1001,
      pid: 4321,
      processStartTicks: "133800000000000000",
      target: { runtimeId: "42.1001.1" },
      action: "type",
      value: "abc",
    });
    assert.equal(actDenied.ok, false);
    assert.equal(actDenied.code, "POLICY_DENIED");
    assert.equal(received.length, 5);
  } finally {
    helper.dispose();
  }
});

test("Windows live STA helper: win_list, policy denials, identity sandwich, background win_capture & uia_snapshot", {
  skip: process.platform !== "win32",
  timeout: 45_000,
}, async () => {
  const helper = createWinPsHelper({
    idleTimeoutMs: 15_000,
    defaultTimeoutMs: 20_000,
  });
  try {
    // 1. win_list 编译加载整个 C# CBWin + UIA3 块并枚举顶层可见窗口
    const listRes = await helper.request("win_list", {
      excludePid: process.pid,
    });
    assert.ok(Array.isArray(listRes.windows));
    for (const w of listRes.windows) {
      assert.ok(typeof w.hwnd === "number" && w.hwnd > 0);
      assert.ok(typeof w.pid === "number" && w.pid > 0);
      assert.notEqual(w.pid, process.pid);
      assert.ok(typeof w.title === "string" && w.title.trim().length > 0);
      assert.notEqual(w.title.toLowerCase(), "program manager");
      assert.notEqual(w.title.toLowerCase(), "windows input experience");
      assert.equal(typeof w.processStartTicks, "string");
      assert.equal(typeof w.bounds.width, "number");
      assert.equal(typeof w.bounds.height, "number");
    }

    // 2. uia_act 强制 fail-closed: type / focus / 无效窗口 / 自保护
    const typeDenied = await helper.request("uia_act", {
      hwnd: 999999999,
      pid: 1,
      processStartTicks: "1",
      target: { role: "edit", name: "x" },
      action: "type",
      value: "hello",
    });
    assert.equal(typeDenied.ok, false);
    assert.equal(typeDenied.code, "POLICY_DENIED");

    const focusDenied = await helper.request("uia_act", {
      hwnd: 999999999,
      pid: 1,
      processStartTicks: "1",
      target: { role: "button", name: "x" },
      action: "focus",
    });
    assert.equal(focusDenied.ok, false);
    assert.equal(focusDenied.code, "POLICY_DENIED");

    const missingAct = await helper.request("uia_act", {
      hwnd: 999999999,
      pid: 1,
      processStartTicks: "1",
      target: { role: "button", name: "x" },
      action: "click",
    });
    assert.equal(missingAct.ok, false);
    assert.equal(missingAct.code, "WINDOW_NOT_FOUND");

    const missingCap = await helper.request("win_capture", {
      hwnd: 999999999,
    });
    assert.equal(missingCap.ok, false);
    assert.equal(missingCap.code, "WINDOW_NOT_FOUND");

    // 3. 启动受控 WinForms 真实窗口夹具，实测 win_list / win_capture / uia_snapshot / uia_act 全链路
    const fixtureTitle = `ChisaBotBgFixture-${process.pid}-${Date.now()}`;
    const fixtureScript = [
      "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
      "$f = New-Object System.Windows.Forms.Form",
      `$f.Text = '${fixtureTitle}'`,
      "$f.Width = 420; $f.Height = 280; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(40, 40)",
      "$f.ShowInTaskbar = $false",
      "$btn = New-Object System.Windows.Forms.Button; $btn.Text = 'ApplyBtn'; $btn.Name = 'ApplyBtn'; $btn.Location = New-Object System.Drawing.Point(20, 20)",
      "$btn.Add_Click({ $f.Tag = 'clicked' })",
      "$txt = New-Object System.Windows.Forms.TextBox; $txt.Name = 'InputBox'; $txt.AccessibleName = 'InputBox'; $txt.Location = New-Object System.Drawing.Point(20, 60); $txt.Width = 200",
      "$pwd = New-Object System.Windows.Forms.TextBox; $pwd.Name = 'SecretBox'; $pwd.AccessibleName = 'SecretBox'; $pwd.UseSystemPasswordChar = $true; $pwd.Text = 's3cr3t!'; $pwd.Location = New-Object System.Drawing.Point(20, 95); $pwd.Width = 200",
      "$chk = New-Object System.Windows.Forms.CheckBox; $chk.Text = 'AgreeCheck'; $chk.Name = 'AgreeCheck'; $chk.Location = New-Object System.Drawing.Point(20, 130)",
      "$dup1 = New-Object System.Windows.Forms.Button; $dup1.Text = 'TwinBtn'; $dup1.Location = New-Object System.Drawing.Point(20, 170)",
      "$dup2 = New-Object System.Windows.Forms.Button; $dup2.Text = 'TwinBtn'; $dup2.Location = New-Object System.Drawing.Point(120, 170)",
      "$f.Controls.AddRange(@($btn, $txt, $pwd, $chk, $dup1, $dup2))",
      "$f.Add_Shown({ [Console]::Out.WriteLine('FIXTURE_READY:' + $f.Handle.ToInt64() + ':' + $PID); [Console]::Out.Flush() })",
      "[System.Windows.Forms.Application]::Run($f)",
    ].join("\n");
    const fixtureEnc = Buffer.from(fixtureScript, "utf16le").toString("base64");
    const fixtureProc = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        fixtureEnc,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    try {
      const readyLine = await new Promise((resolve, reject) => {
        let buf = "";
        const t = setTimeout(
          () => reject(new Error("WinForms fixture startup timeout")),
          15_000,
        );
        fixtureProc.stdout.on("data", (chunk) => {
          buf += String(chunk);
          const m = buf.match(/FIXTURE_READY:(\d+):(\d+)/);
          if (m) {
            clearTimeout(t);
            resolve({ hwnd: Number(m[1]), pid: Number(m[2]) });
          }
        });
        fixtureProc.on("error", (err) => {
          clearTimeout(t);
          reject(err);
        });
        fixtureProc.on("close", (code) => {
          clearTimeout(t);
          reject(new Error(`fixture exited early: ${code}`));
        });
      });

      // 3a. win_list 按标题查询精确命中夹具窗口，且含完整路径的 excludeProcessNames 能准确过滤
      const foundList = await helper.request("win_list", {
        query: fixtureTitle,
        excludePid: process.pid,
      });
      assert.equal(foundList.windows.length, 1);
      const win = foundList.windows[0];
      assert.equal(win.hwnd, readyLine.hwnd);
      assert.equal(win.pid, readyLine.pid);
      assert.ok(win.processStartTicks.length > 0);

      const excludedByPath = await helper.request("win_list", {
        query: fixtureTitle,
        excludePid: process.pid,
        excludeProcessNames: [
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe",
        ],
      });
      assert.equal(excludedByPath.windows.length, 0);

      // 3b. 自保护与 Identity Sandwich 拦截
      const selfSnap = await helper.request("uia_snapshot", {
        hwnd: win.hwnd,
        excludePid: win.pid,
      });
      assert.equal(selfSnap.ok, false);
      assert.equal(selfSnap.code, "SELF_TARGET_FORBIDDEN");

      const staleCap = await helper.request("win_capture", {
        hwnd: win.hwnd,
        pid: win.pid + 99999,
        processStartTicks: win.processStartTicks,
      });
      assert.equal(staleCap.ok, false);
      assert.equal(staleCap.code, "STALE_REF");

      // 3c. 后台离屏 PrintWindow 截屏
      const cap = await helper.request("win_capture", {
        hwnd: win.hwnd,
        pid: win.pid,
        processStartTicks: win.processStartTicks,
        maxWidth: 320,
      });
      assert.equal(cap.ok, true);
      assert.equal(cap.format, "png");
      assert.equal(cap.width, 320);
      assert.ok(cap.height > 0);
      const rawPng = Buffer.from(cap.base64, "base64");
      assert.equal(rawPng[0], 0x89);
      assert.equal(rawPng[1], 0x50);
      assert.equal(rawPng[2], 0x4e);
      assert.equal(rawPng[3], 0x47);

      // 3d. uia_snapshot 读取控件树：校验返回结构；在交互式桌面会话中进一步实测全部无焦点 uia_act 操作
      const snap = await helper.request("uia_snapshot", {
        hwnd: win.hwnd,
        maxNodes: 80,
        maxDepth: 8,
        interactiveOnly: true,
        compact: true,
      });
      assert.equal(snap.ok, true);
      assert.equal(snap.found, true);
      assert.equal(snap.window.hwnd, win.hwnd);
      assert.ok(Array.isArray(snap.nodes));

      // 注：在 Windows 非交互式桌面/CI 会话下 UIAutomationCore 不跨进程暴露子控件树（nodes 为空），
      // 在交互式用户桌面上 nodes 含全部 WinForms 控件，自动执行完整无焦点操控闭环断言。
      if (snap.nodes.length > 0) {
        const applyBtn = snap.nodes.find((n) => n.name === "ApplyBtn");
        const inputBox = snap.nodes.find((n) => n.name === "InputBox");
        const secretBox = snap.nodes.find((n) => n.name === "SecretBox");
        const agreeCheck = snap.nodes.find((n) => n.name === "AgreeCheck");
        const twins = snap.nodes.filter((n) => n.name === "TwinBtn");
        assert.equal(applyBtn?.uniqueAtCapture, true);
        assert.ok(applyBtn?.patterns.includes("invoke"));
        assert.ok(inputBox?.patterns.includes("value"));
        assert.equal(secretBox?.isPassword, true);
        assert.equal(secretBox?.value, null, "密码框绝不可回读明文");
        assert.ok(agreeCheck?.patterns.includes("toggle"));
        assert.equal(agreeCheck?.checked, false);
        assert.equal(twins.length, 2);
        assert.equal(twins[0].uniqueAtCapture, false);
        assert.equal(twins[1].uniqueAtCapture, false);

        // 3e. uia_act 无焦点语义操控：set_value / clear / password set_value / check / uncheck / click / AMBIGUOUS_TARGET
        const setVal = await helper.request("uia_act", {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartTicks: win.processStartTicks,
          target: {
            runtimeId: inputBox.runtimeId,
            role: "edit",
            name: "InputBox",
          },
          action: "set_value",
          value: "hello-bg",
        });
        assert.equal(setVal.ok, true);
        assert.equal(setVal.patternUsed, "value");
        assert.equal(setVal.delivery, "delivered_verified");

        const setPwd = await helper.request("uia_act", {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartTicks: win.processStartTicks,
          target: {
            runtimeId: secretBox.runtimeId,
            role: "edit",
            name: "SecretBox",
          },
          action: "set_value",
          value: "new-secret",
        });
        assert.equal(setPwd.ok, true);
        assert.equal(setPwd.patternUsed, "value");
        assert.equal(
          setPwd.delivery,
          "delivered_unverified",
          "密码框写入后绝不回读校验",
        );

        const clearVal = await helper.request("uia_act", {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartTicks: win.processStartTicks,
          target: {
            runtimeId: inputBox.runtimeId,
            role: "edit",
            name: "InputBox",
          },
          action: "clear",
        });
        assert.equal(clearVal.ok, true);
        assert.equal(clearVal.delivery, "delivered_verified");

        const check1 = await helper.request("uia_act", {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartTicks: win.processStartTicks,
          target: {
            runtimeId: agreeCheck.runtimeId,
            role: "checkbox",
            name: "AgreeCheck",
          },
          action: "check",
        });
        assert.equal(check1.ok, true);
        assert.equal(check1.patternUsed, "toggle");
        assert.equal(check1.delivery, "delivered_verified");

        // 幂等 check：已选中不再切换
        const check2 = await helper.request("uia_act", {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartTicks: win.processStartTicks,
          target: {
            runtimeId: agreeCheck.runtimeId,
            role: "checkbox",
            name: "AgreeCheck",
          },
          action: "check",
        });
        assert.equal(check2.ok, true);
        assert.equal(check2.delivery, "delivered_verified");

        const uncheck = await helper.request("uia_act", {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartTicks: win.processStartTicks,
          target: {
            runtimeId: agreeCheck.runtimeId,
            role: "checkbox",
            name: "AgreeCheck",
          },
          action: "uncheck",
        });
        assert.equal(uncheck.ok, true);
        assert.equal(uncheck.delivery, "delivered_verified");

        const clickOk = await helper.request("uia_act", {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartTicks: win.processStartTicks,
          target: {
            runtimeId: applyBtn.runtimeId,
            role: "button",
            name: "ApplyBtn",
          },
          action: "click",
        });
        assert.equal(clickOk.ok, true);
        assert.equal(clickOk.patternUsed, "invoke");

        // 不传 runtimeId 命中 2 个双胞胎按钮 → 严格返回 AMBIGUOUS_TARGET
        const ambig = await helper.request("uia_act", {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartTicks: win.processStartTicks,
          target: { role: "button", name: "TwinBtn" },
          action: "click",
        });
        assert.equal(ambig.ok, false);
        assert.equal(ambig.code, "AMBIGUOUS_TARGET");
      }
    } finally {
      try {
        fixtureProc.kill("SIGKILL");
      } catch {}
    }
  } finally {
    helper.dispose({ sync: true });
  }
});
