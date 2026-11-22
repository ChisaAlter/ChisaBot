"use strict";
/**
 * 节点操作的本机实现（docs/pc-node.md §8）。纯 Node，不依赖 Electron：
 * Electron 版通过 hooks 提供更好的截图 / 剪贴板 / 打开网址；无 hooks 时在 Windows 上
 * 用 PowerShell 兜底，在 Linux 上用常见命令兜底（便于在 Linux 上测试）。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCodeOps } = require("./code-ops");
const { classifyOpenTarget } = require("./open-target");
const { callLocalMcp, discoverLocalMcpConfigs } = require("./mcp-host");
const {
  getSharedWinPsHelper,
  disposeSharedWinPsHelper,
} = require("./win-ps-helper");

const OUTPUT_CAP = 64 * 1024;
const LIST_CAP = 500;

class OpError extends Error {}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** 截断到字节上限，返回 [text, truncated]。 */
function capText(buffer, cap = OUTPUT_CAP) {
  if (buffer.length <= cap) return [buffer.toString("utf8"), false];
  return [buffer.subarray(0, cap).toString("utf8"), true];
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

const PS_PREFIX =
  "$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue';" +
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";

function killTree(child, platform) {
  if (!child.pid) return;
  try {
    if (platform === "win32")
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

/**
 * 运行一个进程，带超时、输出上限和取消。
 * 返回 { exitCode, stdout, stderr, truncated, timedOut, durationMs }。
 */
function runProcess(
  file,
  args,
  { cwd, timeoutMs = 60_000, signal, platform = process.platform, input } = {},
) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(file, args, {
        cwd: cwd || undefined,
        windowsHide: true,
        detached: platform !== "win32",
        env: process.env,
      });
    } catch (error) {
      reject(new OpError(`无法启动进程：${error.message}`));
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      if (outBytes < OUTPUT_CAP) out.push(chunk);
      else truncated = true;
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes < OUTPUT_CAP) err.push(chunk);
      else truncated = true;
      errBytes += chunk.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, platform);
    }, timeoutMs);
    const onAbort = () => killTree(child, platform);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new OpError(`进程出错：${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const [stdout, t1] = capText(Buffer.concat(out));
      const [stderr, t2] = capText(Buffer.concat(err));
      resolve({
        exitCode: code,
        stdout,
        stderr,
        truncated: truncated || t1 || t2,
        timedOut,
        cancelled: !!signal?.aborted,
        durationMs: Date.now() - started,
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runPowerShell(script, options = {}) {
  return runProcess(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(PS_PREFIX + script),
    ],
    { ...options, platform: "win32" },
  );
}

function which(command) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    const full = path.join(dir, command);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

/**
 * 把请求的路径解析到允许的文件夹之内。
 * - 没有允许的文件夹：拒绝。
 * - 相对路径相对于第一个允许的文件夹。
 * - 解析符号链接后再比较，防止用链接跳出去。
 */
async function resolveInRoots(requested, roots, platform = process.platform) {
  const P = pathApi(platform);
  if (!Array.isArray(roots) || roots.length === 0)
    throw new OpError(
      "这台电脑还没有设置「允许的文件夹」，请先在 PC 客户端或网页的设备设置里添加。",
    );
  const raw = typeof requested === "string" ? requested.trim() : "";
  const candidate = raw
    ? P.isAbsolute(raw)
      ? P.resolve(raw)
      : P.resolve(roots[0], raw)
    : P.resolve(roots[0]);
  const fold = (p) => (platform === "win32" ? p.toLowerCase() : p);
  const real = async (p) => {
    // 对还不存在的路径（写新文件）解析其最近的已存在祖先。
    let current = p;
    const tail = [];
    for (;;) {
      try {
        const resolved = await fsp.realpath(current);
        return tail.length ? P.join(resolved, ...tail.reverse()) : resolved;
      } catch {
        const parent = P.dirname(current);
        if (parent === current) return p;
        tail.push(P.basename(current));
        current = parent;
      }
    }
  };
  const target = await real(candidate);
  for (const root of roots) {
    const rootReal = await real(P.resolve(root));
    const a = fold(target);
    const b = fold(rootReal);
    if (a === b || a.startsWith(b.endsWith(P.sep) ? b : b + P.sep))
      return target;
  }
  throw new OpError(
    `路径不在允许的文件夹内：${raw || "(空)"}（允许的文件夹：${roots.join("、")}）。在网页或 PC 的设备设置里把它加入允许的文件夹，或让机器人再试一次并在审批时批准加入。`,
  );
}

function looksBinary(buffer) {
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
}

function escapeSendKeys(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}

const WIN_INPUT_TYPE = `
if (-not ('CBInput' -as [type])) {
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class CBInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
}
[CBInput]::SetProcessDPIAware() | Out-Null
`;

const MAX_INPUT_TEXT_LENGTH = 4096;
const MAX_INPUT_KEY_LENGTH = 128;
const MAX_INPUT_FOCUS_LENGTH = 200;

function hasControlChars(value) {
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 用 UTF-8 Base64 构造 PowerShell 字符串表达式，防 PS 5.1 Unicode 弯单引号逃逸注入。 */
function psUtf8Literal(value) {
  const b64 = Buffer.from(String(value ?? ""), "utf8").toString("base64");
  return `([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
}

function escapeRegexLiteral(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateInputText(raw, maxLen = MAX_INPUT_TEXT_LENGTH) {
  const text = String(raw ?? "");
  if (text.length > maxLen) {
    throw new OpError(`输入文本长度超出上限（最大 ${maxLen} 字符）。`);
  }
  return text;
}

function validateInputKey(raw) {
  const keys = String(raw ?? "").trim();
  if (!keys) throw new OpError("key 需要 keys，例如 {ENTER} 或 ^c。");
  if (keys.length > MAX_INPUT_KEY_LENGTH || hasControlChars(keys)) {
    throw new OpError(`keys 格式不合法或超过 ${MAX_INPUT_KEY_LENGTH} 字符上限。`);
  }
  return keys;
}

function validateFocusTarget(raw) {
  const target = String(raw ?? "").trim();
  if (!target) throw new OpError("focus 需要 app、bundleId 或 title。");
  if (target.length > MAX_INPUT_FOCUS_LENGTH || hasControlChars(target)) {
    throw new OpError(
      `focus 目标格式不合法或超过 ${MAX_INPUT_FOCUS_LENGTH} 字符上限。`,
    );
  }
  return target;
}

function linuxInputArgs(args = {}) {
  const requirePoint = () => {
    if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
      throw new OpError(`${args.action} 需要有效的数字坐标 x 和 y。`);
    }
    return [String(Math.round(args.x)), String(Math.round(args.y))];
  };
  switch (args.action) {
    case "move": {
      const [x, y] = requirePoint();
      return ["mousemove", "--", x, y];
    }
    case "click": {
      const [x, y] = requirePoint();
      return ["mousemove", "--", x, y, "click", "1"];
    }
    case "double_click": {
      const [x, y] = requirePoint();
      return ["mousemove", "--", x, y, "click", "--repeat", "2", "1"];
    }
    case "right_click": {
      const [x, y] = requirePoint();
      return ["mousemove", "--", x, y, "click", "3"];
    }
    case "scroll": {
      const amount = Number.isFinite(args.amount) ? args.amount : -3;
      return ["click", amount > 0 ? "4" : "5"];
    }
    case "type": {
      const text = validateInputText(args.text);
      return ["type", "--", text];
    }
    case "key": {
      const keys = validateInputKey(args.keys);
      return ["key", "--", keys];
    }
    case "focus": {
      const target = validateFocusTarget(args.app ?? args.bundleId ?? args.title);
      return [
        "search",
        "--name",
        "--",
        escapeRegexLiteral(target),
        "windowactivate",
      ];
    }
    default:
      throw new OpError(`不支持的输入动作：${args.action}`);
  }
}

/** 校验并规范化 Windows 输入命令负载，供常驻 STA helper 白名单分派使用。 */
function buildWinInputPayload(args = {}) {
  const x = Number.isFinite(args.x) ? Math.round(args.x) : null;
  const y = Number.isFinite(args.y) ? Math.round(args.y) : null;
  const hasPoint = x !== null && y !== null;
  const point = hasPoint ? { x, y } : {};
  switch (args.action) {
    case "move":
      if (!hasPoint) throw new OpError("move 需要 x 和 y。");
      return { action: "move", x, y };
    case "click":
      return { action: "click", ...point };
    case "double_click":
      return { action: "double_click", ...point };
    case "right_click":
      return { action: "right_click", ...point };
    case "scroll": {
      const amount = Number.isFinite(args.amount)
        ? Math.round(args.amount)
        : -3;
      return { action: "scroll", ...point, amount };
    }
    case "type": {
      const text = validateInputText(args.text);
      return { action: "type", sendKeysText: escapeSendKeys(text) };
    }
    case "key": {
      const keys = validateInputKey(args.keys);
      return { action: "key", keys };
    }
    case "focus": {
      const target = validateFocusTarget(
        args.app ?? args.bundleId ?? args.title,
      );
      return { action: "focus", target };
    }
    default:
      throw new OpError(`不支持的输入动作：${args.action}`);
  }
}

function winInputScript(args = {}) {
  const x = Number.isFinite(args.x) ? Math.round(args.x) : null;
  const y = Number.isFinite(args.y) ? Math.round(args.y) : null;
  const move =
    x !== null && y !== null
      ? `[CBInput]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 30;`
      : "";
  const click = (down, up) =>
    `[CBInput]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); [CBInput]::mouse_event(${up},0,0,0,[UIntPtr]::Zero);`;
  switch (args.action) {
    case "move":
      if (!move) throw new OpError("move 需要 x 和 y。");
      return WIN_INPUT_TYPE + move;
    case "click":
      return WIN_INPUT_TYPE + move + click("0x0002", "0x0004");
    case "double_click":
      return `${WIN_INPUT_TYPE}${move}${click("0x0002", "0x0004")}Start-Sleep -Milliseconds 60;${click("0x0002", "0x0004")}`;
    case "right_click":
      return WIN_INPUT_TYPE + move + click("0x0008", "0x0010");
    case "scroll": {
      const amount = Number.isFinite(args.amount)
        ? Math.round(args.amount)
        : -3;
      return `${WIN_INPUT_TYPE}${move}[CBInput]::mouse_event(0x0800,0,0,${amount * 120},[UIntPtr]::Zero);`;
    }
    case "type": {
      const text = validateInputText(args.text);
      const sendKeysPayload = escapeSendKeys(text);
      return `Add-Type -AssemblyName System.Windows.Forms; $text = ${psUtf8Literal(sendKeysPayload)}; [System.Windows.Forms.SendKeys]::SendWait($text);`;
    }
    case "key": {
      const keys = validateInputKey(args.keys);
      return `Add-Type -AssemblyName System.Windows.Forms; $keys = ${psUtf8Literal(keys)}; [System.Windows.Forms.SendKeys]::SendWait($keys);`;
    }
    case "focus": {
      const target = validateFocusTarget(args.app ?? args.bundleId ?? args.title);
      return `$target = ${psUtf8Literal(target)}; $ws = New-Object -ComObject WScript.Shell; if (-not $ws.AppActivate($target)) { $p = Get-Process | Where-Object { $_.ProcessName.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -or ($_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object -First 1; if (-not $p) { throw '未找到目标窗口' }; $ws.AppActivate($p.Id) | Out-Null }`;
    }
    default:
      throw new OpError(`不支持的输入动作：${args.action}`);
  }
}

function escapeAppleScriptString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n");
}

const MAC_KEY_CODES = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  escape: 53,
  esc: 53,
  backspace: 51,
  delete: 51,
  forwarddelete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
};

const MAC_MODIFIER_MAP = {
  cmd: "command down",
  command: "command down",
  meta: "command down",
  ctrl: "control down",
  control: "control down",
  alt: "option down",
  option: "option down",
  shift: "shift down",
};

/**
 * macOS 原生输入兜底方案生成器（不依赖第三方付费工具）：
 * - focus：AppleScript 按 bundleId 或应用名激活窗口；
 * - type / key：AppleScript System Events keystroke / key code（完整转义防注入）；
 * - move / click / double_click / right_click / scroll：优先 cliclick，缺失时降级 JXA CoreGraphics CGEvent。
 */
function macInputPlan(args = {}, { hasCliclick = false } = {}) {
  const x = Number.isFinite(args.x) ? Math.round(args.x) : null;
  const y = Number.isFinite(args.y) ? Math.round(args.y) : null;

  switch (args.action) {
    case "focus": {
      const bundleId = String(args.bundleId ?? "").trim();
      const appName = String(args.app ?? args.title ?? "").trim();
      const target = validateFocusTarget(bundleId || appName);
      const script = bundleId
        ? `tell application id "${escapeAppleScriptString(target)}" to activate`
        : `tell application "${escapeAppleScriptString(target)}" to activate`;
      return { file: "osascript", args: ["-e", script], via: "osascript" };
    }
    case "type": {
      const text = validateInputText(args.text);
      const script = `tell application "System Events" to keystroke "${escapeAppleScriptString(text)}"`;
      return { file: "osascript", args: ["-e", script], via: "osascript" };
    }
    case "key": {
      const raw = validateInputKey(args.keys);
      const parts = raw
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean);
      const keyToken = parts.pop() || "";
      const modifiers = parts
        .map((mod) => MAC_MODIFIER_MAP[mod.toLowerCase()])
        .filter(Boolean);
      const usingClause = modifiers.length
        ? ` using {${modifiers.join(", ")}}`
        : "";
      const code = MAC_KEY_CODES[keyToken.toLowerCase()];
      const script =
        code !== undefined
          ? `tell application "System Events" to key code ${code}${usingClause}`
          : `tell application "System Events" to keystroke "${escapeAppleScriptString(keyToken)}"${usingClause}`;
      return { file: "osascript", args: ["-e", script], via: "osascript" };
    }
    case "move":
    case "click":
    case "double_click":
    case "right_click": {
      if (x === null || y === null) {
        throw new OpError(`${args.action} 需要 x 和 y 坐标。`);
      }
      if (hasCliclick) {
        const prefix =
          args.action === "move"
            ? "m"
            : args.action === "double_click"
              ? "dc"
              : args.action === "right_click"
                ? "rc"
                : "c";
        return {
          file: "cliclick",
          args: [`${prefix}:${x},${y}`],
          via: "cliclick",
        };
      }
      const jxaLines = [
        "ObjC.import('CoreGraphics');",
        `const pt = $.CGPointMake(${x}, ${y});`,
      ];
      if (args.action === "move") {
        jxaLines.push(
          "const ev = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, $.kCGMouseButtonLeft);",
          "$.CGEventPost($.kCGHIDEventTap, ev);",
        );
      } else if (args.action === "right_click") {
        jxaLines.push(
          "const d = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseDown, pt, $.kCGMouseButtonRight);",
          "const u = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseUp, pt, $.kCGMouseButtonRight);",
          "$.CGEventPost($.kCGHIDEventTap, d); $.CGEventPost($.kCGHIDEventTap, u);",
        );
      } else if (args.action === "double_click") {
        jxaLines.push(
          "for (let i = 1; i <= 2; i++) {",
          "  const d = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);",
          "  const u = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);",
          "  $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, i);",
          "  $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, i);",
          "  $.CGEventPost($.kCGHIDEventTap, d); $.CGEventPost($.kCGHIDEventTap, u);",
          "}",
        );
      } else {
        jxaLines.push(
          "const d = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);",
          "const u = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);",
          "$.CGEventPost($.kCGHIDEventTap, d); $.CGEventPost($.kCGHIDEventTap, u);",
        );
      }
      return {
        file: "osascript",
        args: ["-l", "JavaScript", "-e", jxaLines.join(" ")],
        via: "jxa-coregraphics",
      };
    }
    case "scroll": {
      const amount = Number.isFinite(args.amount)
        ? Math.round(args.amount)
        : -3;
      const moveStmt =
        x !== null && y !== null
          ? `const m = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, $.CGPointMake(${x}, ${y}), $.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap, m);`
          : "";
      const jxa = `ObjC.import('CoreGraphics'); ${moveStmt} const s = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, ${amount}); $.CGEventPost($.kCGHIDEventTap, s);`;
      return {
        file: "osascript",
        args: ["-l", "JavaScript", "-e", jxa],
        via: "jxa-coregraphics",
      };
    }
    default:
      throw new OpError(`不支持的 macOS 输入动作：${args.action}`);
  }
}

const WIN_SCREENSHOT = (maxWidth) => `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class CBDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[CBDpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$w = [Math]::Min(${maxWidth}, $b.Width); $h = [int]($b.Height * $w / $b.Width)
$out = New-Object System.Drawing.Bitmap $bmp, $w, $h
$ms = New-Object System.IO.MemoryStream
$out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("{0}x{1}x{2}x{3}:" -f $b.Width, $b.Height, $w, $h) -NoNewline
[Convert]::ToBase64String($ms.ToArray())
`;

function createOps(options = {}) {
  const platform = options.platform || process.platform;
  const hooks = options.hooks || {};
  const winHelper = options.winHelper || null;
  const P = pathApi(platform);
  let memoryClipboard = "";
  const code = createCodeOps({ platform, resolveInRoots });

  /** 完全访问模式（ctx.fullAccess）：任意绝对路径；相对路径相对于第一个允许的文件夹或主目录。 */
  async function resolvePath(requested, ctx) {
    if (!ctx.fullAccess)
      return resolveInRoots(requested, ctx.allowedRoots, platform);
    const raw = typeof requested === "string" ? requested.trim() : "";
    const base = ctx.allowedRoots?.[0] || os.homedir();
    const expanded = raw.startsWith("~")
      ? P.join(os.homedir(), raw.slice(1))
      : raw;
    return expanded
      ? P.isAbsolute(expanded)
        ? P.resolve(expanded)
        : P.resolve(base, expanded)
      : P.resolve(base);
  }

  async function systemInfo() {
    const screen = hooks.screenInfo
      ? await hooks.screenInfo().catch(() => null)
      : null;
    return {
      hostname: os.hostname(),
      platform,
      release: os.release(),
      version: typeof os.version === "function" ? os.version() : undefined,
      arch: os.arch(),
      user: (() => {
        try {
          return os.userInfo().username;
        } catch {
          return undefined;
        }
      })(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      memoryTotalMB: Math.round(os.totalmem() / 1048576),
      memoryFreeMB: Math.round(os.freemem() / 1048576),
      uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
      homeDir: os.homedir(),
      screen,
      clientVersion: options.clientVersion,
    };
  }

  /** 运行命令：Windows = PowerShell，其它 = bash / zsh / sh；支持 session（持久目录和环境变量）、elevated（完全访问）。 */
  function shell(args, ctx) {
    return code.table.shell(args, ctx);
  }

  async function listFiles(args, ctx) {
    const roots = ctx.allowedRoots || [];
    if (!args.path && ctx.fullAccess && !roots.length)
      args = { ...args, path: os.homedir() };
    if (!args.path) {
      if (!roots.length) await resolveInRoots("", roots, platform);
      return {
        roots: roots.map((root) => ({
          path: root,
          exists: fs.existsSync(root),
        })),
      };
    }
    const dir = await resolvePath(args.path, ctx);
    const stat = await fsp.stat(dir).catch(() => null);
    if (!stat) throw new OpError(`不存在：${dir}`);
    if (!stat.isDirectory()) throw new OpError(`不是文件夹：${dir}`);
    const names = await fsp.readdir(dir);
    const entries = [];
    for (const name of names.slice(0, LIST_CAP)) {
      const full = P.join(dir, name);
      const s = await fsp.lstat(full).catch(() => null);
      entries.push({
        name,
        type: !s
          ? "unknown"
          : s.isDirectory()
            ? "dir"
            : s.isSymbolicLink()
              ? "link"
              : "file",
        size: s?.isFile() ? s.size : undefined,
        modified: s ? s.mtime.toISOString() : undefined,
      });
    }
    entries.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
    return {
      path: dir,
      entries,
      truncated: names.length > LIST_CAP,
      total: names.length,
    };
  }

  async function readFile(args, ctx) {
    // 带行号范围 = 按行读取（大文件也只读需要的那几行）
    if (args.startLine !== undefined || args.endLine !== undefined)
      return code.table.read_range(args, ctx);
    const file = await resolvePath(args.path, ctx);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) throw new OpError(`文件不存在：${file}`);
    if (!stat.isFile()) throw new OpError(`不是文件：${file}`);
    const max = Math.min(
      Math.max(Number(args.maxBytes) || 262_144, 1),
      1_048_576,
    );
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(max, stat.size));
      await handle.read(buffer, 0, buffer.length, 0);
      const binary = looksBinary(buffer);
      return {
        path: file,
        size: stat.size,
        truncated: stat.size > max,
        encoding: binary ? "base64" : "utf8",
        content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  }

  async function writeFile(args, ctx) {
    const file = await resolvePath(args.path, ctx);
    const content = String(args.content ?? "");
    await fsp.mkdir(P.dirname(file), { recursive: true });
    let backup = null;
    const exists = await fsp.stat(file).catch(() => null);
    if (exists && !exists.isFile()) throw new OpError(`不是文件：${file}`);
    if (exists && !args.append) {
      backup = `${file}.chisabot-bak`;
      await fsp.copyFile(file, backup);
    }
    if (args.append) await fsp.appendFile(file, content, "utf8");
    else await fsp.writeFile(file, content, "utf8");
    return {
      path: file,
      bytes: Buffer.byteLength(content),
      appended: !!args.append,
      backup,
    };
  }

  async function screenshot(args) {
    const maxWidth = Math.min(
      Math.max(Number(args.maxWidth) || 1600, 320),
      3840,
    );
    if (hooks.screenshot) return hooks.screenshot({ maxWidth });
    if (platform === "win32") {
      const result = await runPowerShell(WIN_SCREENSHOT(maxWidth), {
        timeoutMs: 30_000,
      });
      const text = result.stdout.trim();
      const match = /^(\d+)x(\d+)x(\d+)x(\d+):(.+)$/s.exec(text);
      if (!match)
        throw new OpError(`截图失败：${(result.stderr || text).slice(0, 300)}`);
      return {
        format: "png",
        screenWidth: Number(match[1]),
        screenHeight: Number(match[2]),
        width: Number(match[3]),
        height: Number(match[4]),
        base64: match[5].replace(/\s+/g, ""),
      };
    }
    // Linux：ImageMagick import（需要 X 显示）。
    if (process.env.DISPLAY && which("import")) {
      const result = await runProcess(
        "sh",
        [
          "-c",
          `import -silent -window root -resize '${maxWidth}x>' png:- | base64 -w0`,
        ],
        { timeoutMs: 30_000 },
      );
      if (result.exitCode === 0 && result.stdout)
        return {
          format: "png",
          base64: result.stdout.trim(),
          note: "Linux import",
        };
    }
    throw new OpError("这台电脑上没有可用的截图方式。");
  }

  async function input(args, ctx = {}) {
    if (hooks.input) return hooks.input(args);
    if (platform === "win32") {
      const payload = buildWinInputPayload(args);
      const helper = winHelper || getSharedWinPsHelper();
      try {
        await helper.request("input", payload, {
          timeoutMs: 20_000,
          signal: ctx?.signal,
        });
        return { done: true, action: payload.action };
      } catch (error) {
        if (!error?.isTransportError) {
          throw new OpError(
            `输入失败：${String(error?.message || error).slice(0, 300)}`,
          );
        }
        const result = await runPowerShell(winInputScript(args), {
          timeoutMs: 20_000,
          signal: ctx?.signal,
        });
        if (result.exitCode !== 0)
          throw new OpError(`输入失败：${result.stderr.slice(0, 300)}`);
        return { done: true, action: payload.action };
      }
    }
    if (platform === "darwin") {
      const plan = macInputPlan(args, {
        hasCliclick: Boolean(which("cliclick")),
      });
      const result = await runProcess(plan.file, plan.args, {
        timeoutMs: 20_000,
        platform: "darwin",
      });
      if (result.exitCode !== 0) {
        const hint = /not allowed assistive access|1002|accessibility/i.test(
          result.stderr,
        )
          ? "请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中允许 ChisaBot 控制电脑。"
          : result.stderr.slice(0, 300);
        throw new OpError(`macOS 输入失败：${hint}`);
      }
      return { done: true, action: args.action, via: plan.via };
    }
    if (which("xdotool") && process.env.DISPLAY) {
      const argv = linuxInputArgs(args);
      const result = await runProcess("xdotool", argv, { timeoutMs: 20_000 });
      if (result.exitCode !== 0)
        throw new OpError(`输入失败：${result.stderr.slice(0, 300)}`);
      return { done: true, action: args.action };
    }
    throw new OpError("这台电脑上没有可用的鼠标键盘控制方式。");
  }

  /** 安全打开（CB-030）：网址 → 默认浏览器；允许的文件夹里已存在的文件 / 文件夹 → 默认程序。不启动程序、不带参数。 */
  async function open(args, ctx = {}) {
    const picked = classifyOpenTarget(args.target);
    if (picked.error) throw new OpError(picked.error);
    if (Array.isArray(args.args) && args.args.length)
      throw new OpError("「打开」不带参数：只能打开网址或文件 / 文件夹。");
    if (picked.kind === "url") {
      if (hooks.openExternal) {
        await hooks.openExternal(picked.url);
        return { opened: picked.url, via: "browser" };
      }
      if (platform === "win32") {
        const result = await runPowerShell(
          `Start-Process -FilePath ${psUtf8Literal(picked.url)}`,
          { timeoutMs: 20_000 },
        );
        if (result.exitCode !== 0)
          throw new OpError(`打开失败：${result.stderr.slice(0, 300)}`);
        return { opened: picked.url, via: "Start-Process" };
      }
      return spawnOpener(picked.url);
    }
    const file = await resolvePath(picked.path, ctx);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new OpError(`找不到：${file}`);
    }
    if (!stat.isFile() && !stat.isDirectory())
      throw new OpError("只能打开文件或文件夹。");
    // 再按解析后的真实路径查一次类型（符号链接 / 快捷方式指向可执行文件）。
    if (stat.isFile()) {
      const real = await fsp.realpath(file).catch(() => file);
      const again = classifyOpenTarget(real);
      if (again.error) throw new OpError(again.error);
    }
    if (stat.isFile() && platform !== "win32" && stat.mode & 0o111)
      throw new OpError(
        "这是可执行文件，打开它等于运行程序。要运行请用命令行能力。",
      );
    if (hooks.openPath) {
      const error = await hooks.openPath(file);
      if (error) throw new OpError(`打开失败：${String(error).slice(0, 300)}`);
      return { opened: file, via: "default-app" };
    }
    if (platform === "win32") {
      const result = await runPowerShell(
        `Invoke-Item -LiteralPath '${file.replace(/'/g, "''")}'`,
        { timeoutMs: 20_000 },
      );
      if (result.exitCode !== 0)
        throw new OpError(`打开失败：${result.stderr.slice(0, 300)}`);
      return { opened: file, via: "Invoke-Item" };
    }
    return spawnOpener(file);
  }

  function spawnOpener(target) {
    const opener = platform === "darwin" ? which("open") : which("xdg-open");
    if (!opener)
      throw new OpError(
        platform === "darwin"
          ? "这台电脑上没有 open 命令。"
          : "这台电脑上没有 xdg-open。",
      );
    const child = spawn(
      opener,
      platform === "darwin" ? ["--", target] : [target],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
    return { opened: target, via: platform === "darwin" ? "open" : "xdg-open" };
  }

  async function clipboardRead() {
    if (hooks.clipboardRead) return { text: await hooks.clipboardRead() };
    if (platform === "win32") {
      const result = await runPowerShell("Get-Clipboard -Raw", {
        timeoutMs: 10_000,
      });
      return { text: result.stdout.replace(/\r?\n$/, "") };
    }
    return { text: memoryClipboard, note: "无系统剪贴板，使用进程内剪贴板" };
  }

  async function clipboardWrite(args) {
    const text = String(args.text ?? "");
    if (hooks.clipboardWrite) {
      await hooks.clipboardWrite(text);
      return { written: text.length };
    }
    if (platform === "win32") {
      const b64 = Buffer.from(text, "utf8").toString("base64");
      const result = await runPowerShell(
        `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
        { timeoutMs: 10_000 },
      );
      if (result.exitCode !== 0) throw new OpError("写入剪贴板失败。");
      return { written: text.length };
    }
    memoryClipboard = text;
    return { written: text.length, note: "进程内剪贴板" };
  }

  async function mcpCall(args, ctx = {}) {
    const cwd =
      typeof args.cwd === "string" && args.cwd.trim()
        ? await resolvePath(args.cwd, ctx)
        : undefined;
    try {
      return await callLocalMcp({
        command: args.command,
        args: Array.isArray(args.args) ? args.args : undefined,
        env:
          args.env && typeof args.env === "object" && !Array.isArray(args.env)
            ? args.env
            : undefined,
        cwd,
        action: args.action || "list_tools",
        toolName: args.toolName,
        toolArgs: args.toolArgs,
        timeoutMs: args.timeoutMs,
        signal: ctx.signal,
        platform,
      });
    } catch (error) {
      throw new OpError(error instanceof Error ? error.message : String(error));
    }
  }

  async function mcpDiscover(args = {}, ctx = {}) {
    const workspaceDir =
      typeof args.workspaceDir === "string" && args.workspaceDir.trim()
        ? await resolvePath(args.workspaceDir, ctx)
        : ctx.allowedRoots?.[0] || undefined;
    try {
      return await discoverLocalMcpConfigs({ platform, workspaceDir });
    } catch (error) {
      throw new OpError(error instanceof Error ? error.message : String(error));
    }
  }

  const table = {
    system_info: systemInfo,
    shell,
    list_files: listFiles,
    read_file: readFile,
    write_file: writeFile,
    screenshot,
    input,
    open,
    clipboard_read: clipboardRead,
    clipboard_write: clipboardWrite,
    mcp_call: mcpCall,
    mcp_discover: mcpDiscover,
    ...Object.fromEntries(
      Object.entries(code.table).filter(([name]) => name !== "shell"),
    ),
  };

  return {
    platform,
    /** 这个客户端支持的全部操作及扩展特性（hello.features），服务器据此判断旧客户端缺哪些。 */
    features: [...new Set([...Object.keys(table), "mcp"])],
    stopAll: (reason) => code.stopAll(reason),
    async run(operation, args, ctx = {}) {
      const fn = table[operation];
      if (!fn) throw new OpError(`不支持的操作：${operation}`);
      return fn(args || {}, ctx);
    },
  };
}

module.exports = {
  createOps,
  resolveInRoots,
  runProcess,
  encodePowerShell,
  psUtf8Literal,
  buildWinInputPayload,
  winInputScript,
  macInputPlan,
  linuxInputArgs,
  escapeAppleScriptString,
  escapeSendKeys,
  disposeWinPsHelper: disposeSharedWinPsHelper,
  OpError,
};
