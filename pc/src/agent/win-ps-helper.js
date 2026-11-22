"use strict";
/**
 * Windows 常驻 STA PowerShell Helper：
 * - 按需懒启动，仅预编译一次 C# CBInput 类并加载 UIAutomationClient / System.Windows.Forms；
 * - 严格通过 stdin/stdout 单行 JSON 白名单分派（严禁 Invoke-Expression 或任意脚本拼接）；
 * - 空闲超时自动回收，崩溃或管道异常自动重启并单次重试；
 * - 暴露 dispose() 供 Electron app.on("before-quit") 与进程退出彻底终止，防僵尸残留。
 */
const { spawn, spawnSync } = require("node:child_process");

const RESPONSE_PREFIX = "CBPS:";
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const ALLOWED_COMMANDS = new Set([
  "ping",
  "cursor_pos",
  "input",
  "uia_read",
  "uia_action",
]);

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function killPidTree(pid, { sync = false } = {}) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      if (sync) {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 3000,
        });
      } else {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {});
        killer.unref();
      }
      return;
    }
    process.kill(pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/**
 * 构造常驻 STA PowerShell 脚本。
 * 安全红线：仅按固定 switch 白名单分派受控结构化 JSON 命令，绝对不含 Invoke-Expression。
 */
function buildResidentHelperScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::InputEncoding = $utf8NoBom",
    "[Console]::OutputEncoding = $utf8NoBom",
    "$OutputEncoding = $utf8NoBom",
    "Add-Type -AssemblyName System.Windows.Forms, UIAutomationClient, UIAutomationTypes | Out-Null",
    "if (-not ('CBInput' -as [type])) {",
    'Add-Type -TypeDefinition @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "[StructLayout(LayoutKind.Sequential)]",
    "public struct CBPoint { public int X; public int Y; }",
    "public static class CBInput {",
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out CBPoint pt);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    "  public static int[] CursorXY() { CBPoint pt; bool ok = GetCursorPos(out pt); return new int[] { ok ? 1 : 0, pt.X, pt.Y }; }",
    "}",
    '"@ | Out-Null',
    "}",
    "[CBInput]::SetProcessDPIAware() | Out-Null",
    "$cbWsh = $null",
    "function Write-CbJson([hashtable]$obj) {",
    "  $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress",
    `  [Console]::Out.WriteLine('${RESPONSE_PREFIX}' + $json)`,
    "  [Console]::Out.Flush()",
    "}",
    "function Find-TargetWindow([string]$targetName) {",
    "  $procs = @(Get-Process -Name $targetName -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName.Equals($targetName, [System.StringComparison]::OrdinalIgnoreCase) })",
    "  if ($procs.Count -eq 0) { return $null }",
    "  $pids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "  foreach ($p in $procs) { [void]$pids.Add([int]$p.Id) }",
    "  $root = [System.Windows.Automation.AutomationElement]::RootElement",
    "  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "  $w = $walker.GetFirstChild($root)",
    "  while ($null -ne $w) {",
    "    try {",
    "      if ($pids.Contains([int]$w.Current.ProcessId)) { return $w }",
    "    } catch {}",
    "    $w = $walker.GetNextSibling($w)",
    "  }",
    "  return $null",
    "}",
    "function Invoke-CbInput($p) {",
    "  $act = [string]$p.action",
    "  $hasPoint = ($null -ne $p.x) -and ($null -ne $p.y)",
    "  if ($hasPoint) {",
    "    [CBInput]::SetCursorPos([int]$p.x, [int]$p.y) | Out-Null",
    "    Start-Sleep -Milliseconds 30",
    "  }",
    "  switch ($act) {",
    "    'move' {",
    "      if (-not $hasPoint) { throw 'move 需要 x 和 y。' }",
    "      return @{ done = $true; action = 'move' }",
    "    }",
    "    'click' {",
    "      [CBInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
    "      [CBInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
    "      return @{ done = $true; action = 'click' }",
    "    }",
    "    'double_click' {",
    "      [CBInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
    "      [CBInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
    "      Start-Sleep -Milliseconds 60",
    "      [CBInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
    "      [CBInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
    "      return @{ done = $true; action = 'double_click' }",
    "    }",
    "    'right_click' {",
    "      [CBInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)",
    "      [CBInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)",
    "      return @{ done = $true; action = 'right_click' }",
    "    }",
    "    'scroll' {",
    "      $amt = if ($null -ne $p.amount) { [int]$p.amount } else { -3 }",
    "      [CBInput]::mouse_event(0x0800, 0, 0, ($amt * 120), [UIntPtr]::Zero)",
    "      return @{ done = $true; action = 'scroll' }",
    "    }",
    "    'type' {",
    "      $txt = [string]$p.sendKeysText",
    "      if ($txt.Length -gt 0) { [System.Windows.Forms.SendKeys]::SendWait($txt) }",
    "      return @{ done = $true; action = 'type' }",
    "    }",
    "    'key' {",
    "      $keys = [string]$p.keys",
    "      if (-not $keys) { throw 'key 需要 keys。' }",
    "      [System.Windows.Forms.SendKeys]::SendWait($keys)",
    "      return @{ done = $true; action = 'key' }",
    "    }",
    "    'focus' {",
    "      $target = [string]$p.target",
    "      if (-not $target) { throw 'focus 需要目标窗口。' }",
    "      if ($null -eq $script:cbWsh) { $script:cbWsh = New-Object -ComObject WScript.Shell }",
    "      if (-not $script:cbWsh.AppActivate($target)) {",
    "        $proc = Get-Process | Where-Object { $_.ProcessName.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -or ($_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object -First 1",
    "        if (-not $proc) { throw '未找到目标窗口' }",
    "        $script:cbWsh.AppActivate($proc.Id) | Out-Null",
    "      }",
    "      return @{ done = $true; action = 'focus' }",
    "    }",
    "    default { throw ('不支持的输入动作：' + $act) }",
    "  }",
    "}",
    "function Invoke-CbUiaRead($p) {",
    "  $target = [string]$p.bundleId",
    "  $limit = if ($null -ne $p.maxNodes) { [Math]::Min(200, [Math]::Max(10, [int]$p.maxNodes)) } else { 80 }",
    "  $maxDepth = if ($null -ne $p.maxDepth) { [Math]::Min(30, [Math]::Max(2, [int]$p.maxDepth)) } else { 12 }",
    "  $maxVisited = [Math]::Min(2000, [Math]::Max($limit * 8, 600))",
    "  $picked = Find-TargetWindow $target",
    "  if (-not $picked) { return @{ found = $false; nodes = @() } }",
    "  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "  $queue = New-Object 'System.Collections.Generic.Queue[object]'",
    "  $nodes = New-Object 'System.Collections.Generic.List[object]'",
    "  $queue.Enqueue(@{ el = $picked; depth = 0 })",
    "  $visited = 0",
    "  while ($queue.Count -gt 0 -and $nodes.Count -lt $limit -and $visited -lt $maxVisited) {",
    "    $item = $queue.Dequeue()",
    "    $el = $item.el",
    "    $depth = [int]$item.depth",
    "    $visited++",
    "    if ($depth -gt 0) {",
    "      try {",
    "        $cur = $el.Current",
    "        $nm = $cur.Name",
    "        $aid = $cur.AutomationId",
    "        if ($nm -or $aid) {",
    "          $r = $cur.BoundingRectangle",
    "          $rx = if ([double]::IsInfinity($r.X) -or [double]::IsNaN($r.X)) { 0 } else { [int]$r.X }",
    "          $ry = if ([double]::IsInfinity($r.Y) -or [double]::IsNaN($r.Y)) { 0 } else { [int]$r.Y }",
    "          $rw = if ([double]::IsInfinity($r.Width) -or [double]::IsNaN($r.Width)) { 0 } else { [int]$r.Width }",
    "          $rh = if ([double]::IsInfinity($r.Height) -or [double]::IsNaN($r.Height)) { 0 } else { [int]$r.Height }",
    "          $nodes.Add(@{ name = $nm; role = $cur.ControlType.ProgrammaticName; automationId = $aid; enabled = [bool]$cur.IsEnabled; focused = [bool]$cur.HasKeyboardFocus; bounds = @{ x = $rx; y = $ry; width = $rw; height = $rh } })",
    "          if ($nodes.Count -ge $limit) { break }",
    "        }",
    "      } catch {}",
    "    }",
    "    if ($depth -lt $maxDepth) {",
    "      try {",
    "        $child = $walker.GetFirstChild($el)",
    "        while ($null -ne $child -and ($visited + $queue.Count) -lt $maxVisited) {",
    "          $queue.Enqueue(@{ el = $child; depth = ($depth + 1) })",
    "          $child = $walker.GetNextSibling($child)",
    "        }",
    "      } catch {}",
    "    }",
    "  }",
    "  $winTitle = ''",
    "  try { $winTitle = [string]$picked.Current.Name } catch {}",
    "  return @{ found = $true; windowTitle = $winTitle; nodes = $nodes.ToArray(); visited = $visited }",
    "}",
    "function Invoke-CbUiaAction($p) {",
    "  $target = [string]$p.bundleId",
    "  $act = [string]$p.action",
    "  if ($act -ne 'click' -and $act -ne 'focus' -and $act -ne 'set_value') { throw ('不支持的语义操作：' + $act) }",
    "  $matchId = if ($null -ne $p.automationId) { [string]$p.automationId } else { '' }",
    "  $matchName = if ($null -ne $p.name) { [string]$p.name } else { '' }",
    "  $val = if ($null -ne $p.value) { [string]$p.value } else { '' }",
    "  $picked = Find-TargetWindow $target",
    "  if (-not $picked) { throw '未找到目标应用窗口' }",
    "  $el = $null",
    "  if ($matchId) {",
    "    $condId = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $matchId)",
    "    $el = $picked.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condId)",
    "  }",
    "  if (-not $el -and $matchName) {",
    "    $condName = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $matchName)",
    "    $el = $picked.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condName)",
    "  }",
    "  if (-not $el) { throw '未找到匹配的语义控件' }",
    "  if ($act -eq 'focus') { $el.SetFocus() }",
    "  elseif ($act -eq 'set_value') {",
    "    $vp = $null",
    "    if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { throw '该控件不支持 ValuePattern' }",
    "    $vp.SetValue($val)",
    "  }",
    "  else {",
    "    $ip = $null",
    "    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke() }",
    "    else { $el.SetFocus() }",
    "  }",
    "  $matchedName = ''",
    "  try { $matchedName = [string]$el.Current.Name } catch {}",
    "  return @{ ok = $true; action = $act; matched = $matchedName }",
    "}",
    "Write-CbJson @{ ready = $true; pid = $PID; apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString() }",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($null -eq $line) { break }",
    "  $trimmed = $line.Trim()",
    "  if (-not $trimmed) { continue }",
    "  $reqId = ''",
    "  try {",
    "    $req = ConvertFrom-Json -InputObject $trimmed",
    "    $reqId = if ($null -ne $req.id) { [string]$req.id } else { '' }",
    "    $cmd = if ($null -ne $req.cmd) { [string]$req.cmd } else { '' }",
    "    if ($cmd -eq 'quit') {",
    "      Write-CbJson @{ id = $reqId; ok = $true; data = @{ bye = $true } }",
    "      break",
    "    }",
    "    switch ($cmd) {",
    "      'ping' {",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = @{ pong = $true; pid = $PID; apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString() } }",
    "      }",
    "      'cursor_pos' {",
    "        $xy = [CBInput]::CursorXY()",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = @{ ok = ($xy[0] -eq 1); x = [int]$xy[1]; y = [int]$xy[2] } }",
    "      }",
    "      'input' {",
    "        $res = Invoke-CbInput $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      'uia_read' {",
    "        $res = Invoke-CbUiaRead $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      'uia_action' {",
    "        $res = Invoke-CbUiaAction $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      default {",
    "        Write-CbJson @{ id = $reqId; ok = $false; error = ('unknown_command:' + $cmd) }",
    "      }",
    "    }",
    "  } catch {",
    "    $msg = if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { [string]$_ }",
    "    Write-CbJson @{ id = $reqId; ok = $false; error = $msg }",
    "  }",
    "}",
  ].join("\n");
}

const RESIDENT_SCRIPT_ENCODED = encodePowerShell(buildResidentHelperScript());

class HelperTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "HelperTransportError";
    this.isTransportError = true;
  }
}

class HelperCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "HelperCommandError";
    this.isCommandError = true;
  }
}

function createWinPsHelper(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const idleTimeoutMs = Math.max(
    50,
    Number(options.idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS,
  );
  const defaultTimeoutMs = Math.max(
    200,
    Number(options.defaultTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS,
  );

  let child = null;
  let stdoutBuf = "";
  let stderrTail = "";
  let seq = 0;
  let idleTimer = null;
  let activeRequest = null;
  let spawnCount = 0;
  let disposed = false;
  const queue = [];

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleShutdown() {
    clearIdleTimer();
    if (!child || activeRequest || queue.length > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!activeRequest && queue.length === 0) {
        terminateChild({ graceful: true });
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  function terminateChild({ graceful = false, sync = false } = {}) {
    clearIdleTimer();
    const proc = child;
    child = null;
    stdoutBuf = "";
    stderrTail = "";
    if (!proc) return;
    const pid = proc.pid;
    if (graceful && !sync) {
      try {
        proc.stdin?.end(`${JSON.stringify({ id: "quit", cmd: "quit" })}\n`);
      } catch {}
      const killer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          killPidTree(pid, { sync: false });
        }
      }, 600);
      killer.unref?.();
      return;
    }
    try {
      proc.stdin?.destroy();
    } catch {}
    if (proc.exitCode === null) {
      killPidTree(pid, { sync });
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }

  function failActiveTransport(reason) {
    const req = activeRequest;
    activeRequest = null;
    if (req) {
      clearTimeout(req.timer);
      req.signal?.removeEventListener("abort", req.onAbort);
      req.reject(new HelperTransportError(reason));
    }
    terminateChild({ graceful: false });
    pump();
  }

  function handleLine(rawLine) {
    const line = rawLine.trim();
    if (!line.startsWith(RESPONSE_PREFIX)) return;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(RESPONSE_PREFIX.length));
    } catch {
      return;
    }
    if (parsed.ready === true) return;
    const req = activeRequest;
    if (!req || String(parsed.id || "") !== req.id) return;
    activeRequest = null;
    clearTimeout(req.timer);
    req.signal?.removeEventListener("abort", req.onAbort);
    if (parsed.ok) {
      req.resolve(parsed.data);
    } else {
      req.reject(new HelperCommandError(String(parsed.error || "命令执行失败")));
    }
    pump();
  }

  function ensureProcess() {
    if (child && child.exitCode === null && !child.killed) return child;
    const proc = spawnImpl(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        RESIDENT_SCRIPT_ENCODED,
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      },
    );
    child = proc;
    spawnCount += 1;
    stdoutBuf = "";
    stderrTail = "";
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => {
      if (child !== proc) return;
      stdoutBuf += chunk;
      let idx = stdoutBuf.indexOf("\n");
      while (idx >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        handleLine(line);
        idx = stdoutBuf.indexOf("\n");
      }
    });
    proc.stderr?.on("data", (chunk) => {
      if (child !== proc) return;
      stderrTail = (stderrTail + String(chunk)).slice(-1024);
    });
    proc.on("error", (error) => {
      if (child !== proc) return;
      failActiveTransport(`Windows helper 启动失败：${error.message}`);
    });
    proc.on("close", (code, signalName) => {
      if (child !== proc) return;
      const detail = stderrTail.trim()
        ? `（${stderrTail.trim().slice(0, 160)}）`
        : "";
      failActiveTransport(
        `Windows helper 意外退出（code=${code ?? "null"}, signal=${signalName ?? "none"}）${detail}`,
      );
    });
    proc.stdin?.on("error", (error) => {
      if (child !== proc) return;
      failActiveTransport(`Windows helper 管道写入失败：${error.message}`);
    });
    return proc;
  }

  function pump() {
    if (activeRequest) return;
    if (queue.length === 0) {
      scheduleIdleShutdown();
      return;
    }
    if (disposed) {
      while (queue.length > 0) {
        queue.shift().reject(new HelperTransportError("Windows helper 已关闭"));
      }
      return;
    }
    clearIdleTimer();
    const next = queue.shift();
    if (next.signal?.aborted) {
      next.reject(new HelperCommandError("操作已取消"));
      pump();
      return;
    }
    let proc;
    try {
      proc = ensureProcess();
    } catch (error) {
      next.reject(
        new HelperTransportError(`无法启动 Windows helper：${error.message}`),
      );
      pump();
      return;
    }

    const id = `r${++seq}`;
    const onAbort = () => {
      if (activeRequest !== next) return;
      activeRequest = null;
      clearTimeout(next.timer);
      terminateChild({ graceful: false });
      next.reject(new HelperCommandError("操作已取消"));
      pump();
    };
    next.id = id;
    next.onAbort = onAbort;
    next.signal?.addEventListener("abort", onAbort, { once: true });
    next.timer = setTimeout(() => {
      if (activeRequest !== next) return;
      activeRequest = null;
      next.signal?.removeEventListener("abort", onAbort);
      terminateChild({ graceful: false });
      next.reject(new HelperCommandError(`Windows helper 执行超时（${next.timeoutMs}ms）`));
      pump();
    }, next.timeoutMs);
    next.timer.unref?.();
    activeRequest = next;

    try {
      proc.stdin.write(
        `${JSON.stringify({ id, cmd: next.cmd, payload: next.payload })}\n`,
        "utf8",
      );
    } catch (error) {
      failActiveTransport(`Windows helper 写入失败：${error.message}`);
    }
  }

  function sendOnce(cmd, payload, { timeoutMs = defaultTimeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      queue.push({
        cmd,
        payload,
        timeoutMs: Math.max(200, Number(timeoutMs) || defaultTimeoutMs),
        signal,
        resolve,
        reject,
      });
      pump();
    });
  }

  /**
   * 发送白名单结构化 JSON 命令；遇管道异常自动重启并单次重试。
   */
  async function request(cmd, payload = {}, opts = {}) {
    if (!ALLOWED_COMMANDS.has(cmd)) {
      throw new HelperCommandError(`拒绝未授权的 Windows helper 命令：${cmd}`);
    }
    if (disposed) {
      disposed = false;
    }
    try {
      return await sendOnce(cmd, payload, opts);
    } catch (error) {
      if (error?.isTransportError && !opts.signal?.aborted) {
        return sendOnce(cmd, payload, opts);
      }
      throw error;
    }
  }

  function dispose({ sync = false } = {}) {
    disposed = true;
    const active = activeRequest;
    activeRequest = null;
    if (active) {
      clearTimeout(active.timer);
      active.signal?.removeEventListener("abort", active.onAbort);
      active.reject(new HelperTransportError("Windows helper 已关闭"));
    }
    while (queue.length > 0) {
      queue.shift().reject(new HelperTransportError("Windows helper 已关闭"));
    }
    terminateChild({ graceful: false, sync });
  }

  return {
    request,
    dispose,
    stats: () => ({
      running: Boolean(child && child.exitCode === null && !child.killed),
      pid: child?.pid ?? null,
      spawnCount,
      pending: queue.length + (activeRequest ? 1 : 0),
    }),
  };
}

let sharedHelper = null;
let exitHookRegistered = false;

function getSharedWinPsHelper() {
  if (!sharedHelper) {
    sharedHelper = createWinPsHelper();
    if (!exitHookRegistered) {
      exitHookRegistered = true;
      process.once("exit", () => {
        try {
          sharedHelper?.dispose({ sync: true });
        } catch {}
      });
    }
  }
  return sharedHelper;
}

function disposeSharedWinPsHelper(opts = {}) {
  if (sharedHelper) {
    sharedHelper.dispose(opts);
  }
}

module.exports = {
  RESPONSE_PREFIX,
  ALLOWED_COMMANDS,
  HelperTransportError,
  HelperCommandError,
  buildResidentHelperScript,
  createWinPsHelper,
  getSharedWinPsHelper,
  disposeSharedWinPsHelper,
};
