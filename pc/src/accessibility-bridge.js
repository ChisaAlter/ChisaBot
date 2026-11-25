"use strict";
/**
 * 本机无障碍控件树语义读写 + 按 `bundleId` 绑定 `directionEpoch` 细粒度回合授权
 * + 后台无感操控统一门面（DesktopDriver SPI：优先外部 `agent-desktop`，不可用自动回退内置零依赖驱动）。
 *
 * 设计要点：
 * 1. 回合代际授权（Direction Epoch）：
 *    - 每个对话（`conversationId`）持有单调递增的 `directionEpoch`；
 *    - 用户发出新指令时调用 `advanceEpoch(conversationId)`，上一代际签发的所有 `bundleId` 临时授权自动失效；
 *    - 授权键严格绑定 `(conversationId, deviceId, epoch, normalizedBundleId)`，并强校验设备已签发 `accessibility_control` scope；
 * 2. 跨平台后台无感语义操控（不抢焦点、不挪鼠标）：
 *    - DesktopDriver SPI：优先外部 `agent-desktop`（绝不传递 `--headed`），不可用自动回退内置驱动；
 *    - Windows：常驻 STA `win-ps-helper`（`win_list` / `uia_snapshot` / `uia_act` / `win_capture`）；
 *    - macOS：只读 System Events JXA 枚举与无 `frontmost` AX 操作 + `/usr/sbin/screencapture -x -t png -l <windowId>`；
 *    - Linux：无外部 `agent-desktop` 时 fail-closed 返回 `DRIVER_UNAVAILABLE`；
 * 3. 强制自保护红线：任何入口命中 ChisaBot 自身进程/PID 或审批确认窗一律返回 `SELF_TARGET_FORBIDDEN`。
 */
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runProcess, encodePowerShell } = require("./agent/ops");
const { getSharedWinPsHelper } = require("./agent/win-ps-helper");
const { createAgentDesktopDriver } = require("./agent/agent-desktop-driver");

const DEFAULT_GRANT_TTL_MS = 10 * 60_000;
const MAX_GRANT_TTL_MS = 30 * 60_000;
const ACCESSIBILITY_SCOPE = "accessibility_control";
const BUNDLE_ID_RE = /^[a-z0-9._-]{1,160}$/;
const DESKTOP_REF_RE = /^@([1-9]\d*):(e[1-9]\d*)$/;
const HEADED_FLAG_RE = /^--headed(?:=|$)/i;
const DEFAULT_MAX_SNAPSHOTS = 32;

const SELF_PROCESS_NAMES = new Set([
  "chisabot",
  "chisabot-pc",
  "cn.ayase.chisabot.pc",
]);

const ALLOWED_BG_ACTIONS = new Set([
  "click",
  "set_value",
  "clear",
  "toggle",
  "check",
  "uncheck",
  "select",
  "expand",
  "collapse",
  "scroll",
  "scroll_to",
  "type",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "edit",
  "hyperlink",
  "link",
  "listitem",
  "menu",
  "menubar",
  "menuitem",
  "radiobutton",
  "scrollbar",
  "slider",
  "spinner",
  "splitbutton",
  "tab",
  "tabitem",
  "thumb",
  "treeitem",
  "datagrid",
  "dataitem",
  "table",
  "document",
  "textfield",
  "switch",
  "option",
  "listbox",
  "axbutton",
  "axcheckbox",
  "axcombobox",
  "axtextfield",
  "axsecuretextfield",
  "axlink",
  "axmenuitem",
  "axradiobutton",
  "axslider",
  "axtab",
  "axpopupbutton",
  "axtextarea",
  "axdisclosuretriangle",
  "axrow",
  "axcell",
]);

const EXECUTABLE_PATTERNS = new Set([
  "invoke",
  "legacy_default",
  "value",
  "range_value",
  "toggle",
  "selection_item",
  "expand_collapse",
  "scroll",
  "scroll_item",
  "axpress",
  "axincrement",
  "axdecrement",
  "axconfirm",
  "axshowmenu",
  "click",
  "set-value",
  "set_value",
]);

const STANDARD_ERROR_CODES = new Set([
  "POLICY_DENIED",
  "ACTION_NOT_SUPPORTED",
  "STALE_REF",
  "AMBIGUOUS_TARGET",
  "WINDOW_MINIMIZED",
  "WINDOW_NOT_FOUND",
  "SELF_TARGET_FORBIDDEN",
  "NEEDS_PERMISSION",
  "DRIVER_UNAVAILABLE",
  "TIMEOUT",
]);

function normalizeBundleId(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value || !BUNDLE_ID_RE.test(value)) return "";
  return value;
}

function normalizeProcessToken(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const base = trimmed.split(/[\\/]/).pop() || trimmed;
  const lower = base.trim().toLowerCase();
  return lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
}

function isProtectedSelfTarget(target = {}) {
  if (!target || typeof target !== "object") return false;
  const pid = Number(target.pid);
  const selfPid = Number(target.selfPid);
  if (
    Number.isInteger(pid) &&
    pid > 0 &&
    Number.isInteger(selfPid) &&
    selfPid > 0 &&
    pid === selfPid
  ) {
    return true;
  }
  const procNorm = normalizeProcessToken(target.processName);
  if (procNorm && SELF_PROCESS_NAMES.has(procNorm)) {
    return true;
  }
  const bundleNorm = normalizeProcessToken(target.bundleId);
  if (bundleNorm && SELF_PROCESS_NAMES.has(bundleNorm)) {
    return true;
  }
  const titleLower = String(target.title || "").toLowerCase();
  if (
    titleLower.includes("chisabot 审批") ||
    titleLower.includes("chisabot 确认")
  ) {
    return true;
  }
  return false;
}

function parseDesktopRef(raw) {
  if (typeof raw !== "string") return null;
  const match = DESKTOP_REF_RE.exec(raw.trim());
  if (!match) return null;
  const snapshotId = Number(match[1]);
  if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0) return null;
  const elementKey = match[2];
  return {
    snapshotId,
    elementKey,
    canonical: `@${snapshotId}:${elementKey}`,
  };
}

function hasHeadedFlag(extraArgs) {
  if (!Array.isArray(extraArgs)) return false;
  for (const item of extraArgs) {
    if (HEADED_FLAG_RE.test(String(item ?? "").trim())) {
      return true;
    }
  }
  return false;
}

function parsePngDimensions(buf) {
  if (
    !Buffer.isBuffer(buf) ||
    buf.length < 24 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    return { width: 0, height: 0 };
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function extractErrorCodeFromMessage(message, fallbackCode) {
  const text = String(message || "");
  for (const code of STANDARD_ERROR_CODES) {
    if (text.includes(code)) return code;
  }
  if (/not allowed assistive access|1002|accessibility/i.test(text)) {
    return "NEEDS_PERMISSION";
  }
  if (/timed?\s*out|超时/i.test(text)) {
    return "TIMEOUT";
  }
  return fallbackCode;
}

function builtinDriverNameFor(platform) {
  if (platform === "win32") return "builtin-uia";
  if (platform === "darwin") return "builtin-mac-ax";
  return "builtin-linux-stub";
}

/** 用 UTF-8 Base64 构造 PowerShell 字符串表达式，彻底杜绝 PS 5.1 弯单引号逃逸注入。 */
function psUtf8Literal(value) {
  const b64 = Buffer.from(String(value ?? ""), "utf8").toString("base64");
  return `([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
}

/**
 * 按应用标识（bundleId / 进程名）绑定当前用户指令代际（directionEpoch）的回合授权器。
 */
function createDirectionEpochAuthorizer(options = {}) {
  const now = options.now || Date.now;
  const defaultTtlMs = Math.min(
    MAX_GRANT_TTL_MS,
    Math.max(1000, Number(options.defaultTtlMs) || DEFAULT_GRANT_TTL_MS),
  );
  const epochs = new Map(); // conversationId -> number
  const grants = new Map(); // key -> { conversationId, deviceId, bundleId, epoch, expiresAt, grantedAt }

  function grantKey(conversationId, deviceId, epoch, bundleId) {
    return JSON.stringify([conversationId, deviceId, epoch, bundleId]);
  }

  function currentEpoch(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return 0;
    return epochs.get(id) ?? 1;
  }

  /** 用户发起新一轮指令：代际递增，旧代际的所有应用临时放行自动失效并清理。 */
  function advanceEpoch(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) throw new Error("conversationId 不能为空。");
    const next = currentEpoch(id) + 1;
    epochs.set(id, next);
    for (const [key, entry] of grants.entries()) {
      if (entry.conversationId === id && entry.epoch < next) {
        grants.delete(key);
      }
    }
    return next;
  }

  function hasRequiredScope(scopes) {
    return Array.isArray(scopes) && scopes.includes(ACCESSIBILITY_SCOPE);
  }

  function authorizeApp({
    conversationId,
    deviceId,
    bundleId,
    epoch,
    scopes,
    ttlMs,
  }) {
    const conv = String(conversationId || "").trim();
    const dev = String(deviceId || "").trim();
    const appId = normalizeBundleId(bundleId);
    if (!conv || !dev || !appId) {
      return { ok: false, reason: "invalid_grant_target" };
    }
    if (!hasRequiredScope(scopes)) {
      return { ok: false, reason: "missing_accessibility_scope" };
    }
    let effectiveTtlMs = defaultTtlMs;
    if (ttlMs !== undefined) {
      const parsedTtl = Number(ttlMs);
      if (!Number.isFinite(parsedTtl) || parsedTtl <= 0) {
        return { ok: false, reason: "invalid_ttl" };
      }
      effectiveTtlMs = Math.min(MAX_GRANT_TTL_MS, Math.max(1000, parsedTtl));
    }
    const activeEpoch = currentEpoch(conv);
    const targetEpoch = epoch === undefined ? activeEpoch : Number(epoch);
    if (!Number.isInteger(targetEpoch) || targetEpoch !== activeEpoch) {
      return {
        ok: false,
        reason: "direction_epoch_superseded",
        currentEpoch: activeEpoch,
      };
    }
    const ts = now();
    const record = {
      conversationId: conv,
      deviceId: dev,
      bundleId: appId,
      epoch: targetEpoch,
      grantedAt: ts,
      expiresAt: ts + effectiveTtlMs,
    };
    grants.set(grantKey(conv, dev, targetEpoch, appId), record);
    return { ok: true, grant: record };
  }

  function checkAuthorization({
    conversationId,
    deviceId,
    bundleId,
    epoch,
    scopes,
  }) {
    const conv = String(conversationId || "").trim();
    const dev = String(deviceId || "").trim();
    const appId = normalizeBundleId(bundleId);
    if (!conv || !dev || !appId) {
      return { allowed: false, reason: "invalid_target" };
    }
    if (!hasRequiredScope(scopes)) {
      return { allowed: false, reason: "missing_accessibility_scope" };
    }
    const activeEpoch = currentEpoch(conv);
    if (epoch !== undefined && Number(epoch) !== activeEpoch) {
      return {
        allowed: false,
        reason: "direction_epoch_superseded",
        currentEpoch: activeEpoch,
      };
    }
    const key = grantKey(conv, dev, activeEpoch, appId);
    const record = grants.get(key);
    if (!record) {
      return {
        allowed: false,
        reason: "app_not_authorized",
        currentEpoch: activeEpoch,
      };
    }
    if (record.expiresAt <= now()) {
      grants.delete(key);
      return {
        allowed: false,
        reason: "grant_expired",
        currentEpoch: activeEpoch,
      };
    }
    return { allowed: true, grant: record, currentEpoch: activeEpoch };
  }

  function revokeAll(conversationId) {
    if (!conversationId) {
      grants.clear();
      return;
    }
    const conv = String(conversationId).trim();
    for (const [key, entry] of grants.entries()) {
      if (entry.conversationId === conv) grants.delete(key);
    }
  }

  function snapshot() {
    const ts = now();
    const active = [];
    for (const [key, entry] of grants.entries()) {
      if (
        entry.expiresAt <= ts ||
        entry.epoch !== currentEpoch(entry.conversationId)
      ) {
        grants.delete(key);
      } else {
        active.push({ ...entry });
      }
    }
    return {
      epochs: Object.fromEntries(epochs.entries()),
      grants: active,
    };
  }

  return {
    currentEpoch,
    advanceEpoch,
    authorizeApp,
    checkAuthorization,
    revokeAll,
    snapshot,
  };
}

/** 构造 Windows UI Automation 有界语义控件树读取脚本（TreeWalker BFS + 深度/节点上限 + Base64 传参）。 */
function buildWinReadTreeScript({ bundleId, maxNodes = 80, maxDepth = 12 }) {
  const normalizedTarget = normalizeBundleId(bundleId);
  if (!normalizedTarget) {
    throw new Error("必须提供合法的目标应用标识（bundleId / 进程名）。");
  }
  const limit = Math.min(200, Math.max(10, Number(maxNodes) || 80));
  const depthLimit = Math.min(30, Math.max(2, Number(maxDepth) || 12));
  const maxVisited = Math.min(2000, Math.max(limit * 8, 600));
  return [
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    `$target = ${psUtf8Literal(normalizedTarget)}`,
    `$limit = ${limit}`,
    `$maxDepth = ${depthLimit}`,
    `$maxVisited = ${maxVisited}`,
    "$procs = @(Get-Process -Name $target -ErrorAction SilentlyContinue | Where-Object { $pname = $_.ProcessName.ToLower(); $pname -eq $target })",
    'if ($procs.Count -eq 0) { Write-Output \'{"nodes":[],"found":false}\'; exit 0 }',
    "$pids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "foreach ($p in $procs) { [void]$pids.Add([int]$p.Id) }",
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "$picked = $null",
    "$w = $walker.GetFirstChild($root)",
    "while ($null -ne $w) {",
    "  try { if ($pids.Contains([int]$w.Current.ProcessId)) { $picked = $w; break } } catch {}",
    "  $w = $walker.GetNextSibling($w)",
    "}",
    'if (-not $picked) { Write-Output \'{"nodes":[],"found":false}\'; exit 0 }',
    "$queue = New-Object 'System.Collections.Generic.Queue[object]'",
    "$nodes = New-Object 'System.Collections.Generic.List[object]'",
    "$queue.Enqueue(@{ el = $picked; depth = 0 })",
    "$visited = 0",
    "while ($queue.Count -gt 0 -and $nodes.Count -lt $limit -and $visited -lt $maxVisited) {",
    "  $item = $queue.Dequeue()",
    "  $el = $item.el",
    "  $depth = [int]$item.depth",
    "  $visited++",
    "  if ($depth -gt 0) {",
    "    try {",
    "      $cur = $el.Current",
    "      if ($cur.Name -or $cur.AutomationId) {",
    "        $r = $cur.BoundingRectangle",
    "        $rx = if ([double]::IsInfinity($r.X) -or [double]::IsNaN($r.X)) { 0 } else { [int]$r.X }",
    "        $ry = if ([double]::IsInfinity($r.Y) -or [double]::IsNaN($r.Y)) { 0 } else { [int]$r.Y }",
    "        $rw = if ([double]::IsInfinity($r.Width) -or [double]::IsNaN($r.Width)) { 0 } else { [int]$r.Width }",
    "        $rh = if ([double]::IsInfinity($r.Height) -or [double]::IsNaN($r.Height)) { 0 } else { [int]$r.Height }",
    "        $nodes.Add(@{ name = $cur.Name; role = $cur.ControlType.ProgrammaticName; automationId = $cur.AutomationId; enabled = [bool]$cur.IsEnabled; focused = [bool]$cur.HasKeyboardFocus; bounds = @{ x = $rx; y = $ry; width = $rw; height = $rh } })",
    "        if ($nodes.Count -ge $limit) { break }",
    "      }",
    "    } catch {}",
    "  }",
    "  if ($depth -lt $maxDepth) {",
    "    try {",
    "      $child = $walker.GetFirstChild($el)",
    "      while ($null -ne $child -and ($visited + $queue.Count) -lt $maxVisited) {",
    "        $queue.Enqueue(@{ el = $child; depth = ($depth + 1) })",
    "        $child = $walker.GetNextSibling($child)",
    "      }",
    "    } catch {}",
    "  }",
    "}",
    "@{ found = $true; windowTitle = $picked.Current.Name; nodes = $nodes.ToArray() } | ConvertTo-Json -Depth 5 -Compress",
  ].join("\n");
}

/** 构造 Windows UI Automation 语义操作脚本（FindFirst + PropertyCondition 短路查找，全参数走 Base64 解码）。 */
function buildWinActionScript({ bundleId, action, name, automationId, value }) {
  const normalizedTarget = normalizeBundleId(bundleId);
  if (!normalizedTarget) {
    throw new Error("必须提供合法的目标应用标识（bundleId / 进程名）。");
  }
  const normalizedAction =
    action === "focus" || action === "set_value" ? action : "click";
  return [
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    `$target = ${psUtf8Literal(normalizedTarget)}`,
    `$matchName = ${psUtf8Literal(name ?? "")}`,
    `$matchId = ${psUtf8Literal(automationId ?? "")}`,
    `$act = ${psUtf8Literal(normalizedAction)}`,
    `$val = ${psUtf8Literal(value ?? "")}`,
    "$procs = @(Get-Process -Name $target -ErrorAction SilentlyContinue | Where-Object { $pname = $_.ProcessName.ToLower(); $pname -eq $target })",
    "if ($procs.Count -eq 0) { throw '未找到目标应用窗口' }",
    "$pids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "foreach ($p in $procs) { [void]$pids.Add([int]$p.Id) }",
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "$picked = $null",
    "$w = $walker.GetFirstChild($root)",
    "while ($null -ne $w) {",
    "  try { if ($pids.Contains([int]$w.Current.ProcessId)) { $picked = $w; break } } catch {}",
    "  $w = $walker.GetNextSibling($w)",
    "}",
    "if (-not $picked) { throw '未找到目标应用窗口' }",
    "$el = $null",
    "if ($matchId) {",
    "  $condId = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $matchId)",
    "  $el = $picked.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condId)",
    "}",
    "if (-not $el -and $matchName) {",
    "  $condName = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $matchName)",
    "  $el = $picked.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condName)",
    "}",
    "if (-not $el) { throw '未找到匹配的语义控件' }",
    "if ($act -eq 'focus') { $el.SetFocus() }",
    "elseif ($act -eq 'set_value') { $vp = $null; if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { throw '该控件不支持 ValuePattern' }; $vp.SetValue($val) }",
    "else { $ip = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke() } else { throw 'ACTION_NOT_SUPPORTED: 该控件不支持无焦点 InvokePattern' } }",
    "@{ ok = $true; action = $act; matched = $el.Current.Name } | ConvertTo-Json -Compress",
  ].join("\n");
}

/** 构造 macOS JXA System Events / AXUIElement 语义树读取脚本。 */
function buildMacReadTreeScript({ bundleId, maxNodes = 80 }) {
  const normalizedTarget = normalizeBundleId(bundleId);
  if (!normalizedTarget) {
    throw new Error("必须提供合法的目标应用标识（bundleId / 进程名）。");
  }
  const safeBundle = JSON.stringify(normalizedTarget);
  const limit = Math.min(200, Math.max(10, Number(maxNodes) || 80));
  return [
    "const se = Application('System Events');",
    `const target = ${safeBundle};`,
    `const limit = ${limit};`,
    "const procs = se.applicationProcesses.whose({ backgroundOnly: false })();",
    "const proc = procs.find((p) => {",
    "  try { const bid = String(p.bundleIdentifier() || '').toLowerCase(); const n = String(p.name() || '').toLowerCase(); return bid === target || n === target; } catch { return false; }",
    "});",
    "if (!proc) { JSON.stringify({ found: false, nodes: [] }); } else {",
    "  const win = proc.windows.length ? proc.windows[0] : null;",
    "  const nodes = [];",
    "  if (win) {",
    "    const elements = win.entireContents();",
    "    for (let i = 0; i < elements.length && nodes.length < limit; i++) {",
    "      const el = elements[i];",
    "      try {",
    "        const name = String(el.name() || el.title() || el.description() || '');",
    "        const role = String(el.role() || '');",
    "        if (!name && !role) continue;",
    "        const pos = el.position ? el.position() : [0, 0];",
    "        const sz = el.size ? el.size() : [0, 0];",
    "        nodes.push({ name, role, enabled: Boolean(el.enabled ? el.enabled() : true), focused: Boolean(el.focused ? el.focused() : false), bounds: { x: pos[0] || 0, y: pos[1] || 0, width: sz[0] || 0, height: sz[1] || 0 } });",
    "      } catch {}",
    "    }",
    "  }",
    "  JSON.stringify({ found: true, bundleId: String(proc.bundleIdentifier() || ''), windowTitle: win ? String(win.name() || '') : '', nodes });",
    "}",
  ].join("\n");
}

/** 构造 macOS JXA 无焦点语义操作脚本（绝不把应用拉到前台）。 */
function buildMacActionScript({ bundleId, action, name, value }) {
  const normalizedTarget = normalizeBundleId(bundleId);
  if (!normalizedTarget) {
    throw new Error("必须提供合法的目标应用标识（bundleId / 进程名）。");
  }
  const safeName = JSON.stringify(name || "");
  const safeAction = JSON.stringify(action || "click");
  const safeValue = JSON.stringify(value ?? "");
  return [
    `const target = ${JSON.stringify(normalizedTarget)};`,
    `const matchName = ${safeName};`,
    `const act = ${safeAction};`,
    `const val = ${safeValue};`,
    "const se = Application('System Events');",
    "const procs = se.applicationProcesses.whose({ backgroundOnly: false })();",
    "const proc = procs.find((p) => { try { return String(p.bundleIdentifier() || '').toLowerCase() === target || String(p.name() || '').toLowerCase() === target; } catch { return false; } });",
    "if (!proc) throw new Error('未找到目标应用进程');",
    "if (act === 'focus' && !matchName) { JSON.stringify({ ok: true, action: 'focus', matched: target }); } else {",
    "  const win = proc.windows.length ? proc.windows[0] : null;",
    "  const elements = win ? win.entireContents() : [];",
    "  const el = elements.find((item) => { try { return String(item.name() || item.title() || item.description() || '') === matchName; } catch { return false; } });",
    "  if (!el) throw new Error('未找到匹配的语义控件');",
    "  if (act === 'set_value') { el.value = val; }",
    "  else if (act === 'focus') { el.focused = true; }",
    "  else {",
    "    let pressed = false;",
    "    try { el.actions.byName('AXPress').perform(); pressed = true; } catch {}",
    "    if (!pressed) { el.click(); }",
    "  }",
    "  JSON.stringify({ ok: true, action: act, matched: matchName });",
    "}",
  ].join("\n");
}

/** 构造 macOS 只读后台窗口枚举 JXA（不激活任何窗口，过滤自身进程）。 */
function buildMacListWindowsScript({ query = "", excludePid = 0 } = {}) {
  return [
    `const query = ${JSON.stringify(
      String(query || "")
        .trim()
        .toLowerCase(),
    )};`,
    `const excludePid = ${Number.isInteger(Number(excludePid)) ? Number(excludePid) : 0};`,
    "const selfSet = new Set(['chisabot', 'chisabot-pc', 'cn.ayase.chisabot.pc']);",
    "const se = Application('System Events');",
    "const procs = se.applicationProcesses.whose({ backgroundOnly: false })();",
    "const out = [];",
    "for (let i = 0; i < procs.length; i++) {",
    "  const p = procs[i];",
    "  try {",
    "    const pid = Number(p.unixId ? p.unixId() : 0) || 0;",
    "    const procName = String(p.name() || '');",
    "    const bundleId = String(p.bundleIdentifier() || '');",
    "    if (excludePid > 0 && pid === excludePid) continue;",
    "    if (selfSet.has(procName.toLowerCase()) || selfSet.has(bundleId.toLowerCase())) continue;",
    "    const isActive = Boolean(p.frontmost ? p.frontmost() : false);",
    "    const wins = p.windows();",
    "    for (let j = 0; j < wins.length; j++) {",
    "      const w = wins[j];",
    "      try {",
    "        const title = String(w.name() || '');",
    "        if (!title.trim()) continue;",
    "        const titleLower = title.toLowerCase();",
    "        if (titleLower.includes('chisabot 审批') || titleLower.includes('chisabot 确认')) continue;",
    "        if (query && !titleLower.includes(query) && !procName.toLowerCase().includes(query) && !bundleId.toLowerCase().includes(query)) continue;",
    "        let winId = 0;",
    "        try { winId = Number(w.attributes.byName('AXWindowNumber').value()) || 0; } catch {}",
    "        if (!winId) { try { winId = Number(w.id()) || 0; } catch {} }",
    "        let minimized = false;",
    "        try { minimized = Boolean(w.attributes.byName('AXMinimized').value()); } catch {}",
    "        const pos = w.position ? w.position() : [0, 0];",
    "        const sz = w.size ? w.size() : [0, 0];",
    "        out.push({ hwnd: winId, pid, processStartTicks: '', processName: procName, bundleId, title, isActive: isActive && j === 0, isMinimized: minimized, bounds: { left: Number(pos[0]) || 0, top: Number(pos[1]) || 0, width: Number(sz[0]) || 0, height: Number(sz[1]) || 0 } });",
    "      } catch {}",
    "    }",
    "  } catch {}",
    "}",
    "JSON.stringify({ ok: true, windows: out });",
  ].join("\n");
}

/** 构造 macOS 后台无感控件树快照 JXA（绝不激活窗口，自动擦除安全输入框值）。 */
function buildMacSnapshotScript({
  hwnd,
  pid,
  bundleId,
  processName,
  title,
  maxNodes = 150,
  interactiveOnly = false,
  excludePid = 0,
} = {}) {
  const limit = Math.min(300, Math.max(10, Number(maxNodes) || 150));
  return [
    `const wantHwnd = ${Number.isFinite(Number(hwnd)) ? Number(hwnd) : 0};`,
    `const wantPid = ${Number.isInteger(Number(pid)) && Number(pid) > 0 ? Number(pid) : 0};`,
    `const wantBundle = ${JSON.stringify(
      String(bundleId || "")
        .trim()
        .toLowerCase(),
    )};`,
    `const wantProc = ${JSON.stringify(
      String(processName || "")
        .trim()
        .toLowerCase(),
    )};`,
    `const wantTitle = ${JSON.stringify(
      String(title || "")
        .trim()
        .toLowerCase(),
    )};`,
    `const excludePid = ${Number.isInteger(Number(excludePid)) ? Number(excludePid) : 0};`,
    `const limit = ${limit};`,
    `const interactiveOnly = ${Boolean(interactiveOnly)};`,
    "const selfSet = new Set(['chisabot', 'chisabot-pc', 'cn.ayase.chisabot.pc']);",
    "const se = Application('System Events');",
    "const procs = se.applicationProcesses.whose({ backgroundOnly: false })();",
    "let pickedProc = null; let pickedWin = null; let pickedWinId = 0;",
    "for (let i = 0; i < procs.length && !pickedWin; i++) {",
    "  const p = procs[i];",
    "  try {",
    "    const pPid = Number(p.unixId ? p.unixId() : 0) || 0;",
    "    const pName = String(p.name() || '');",
    "    const pBundle = String(p.bundleIdentifier() || '');",
    "    if (wantPid > 0 && pPid !== wantPid) continue;",
    "    if (wantBundle && pBundle.toLowerCase() !== wantBundle && pName.toLowerCase() !== wantBundle) continue;",
    "    if (wantProc && pName.toLowerCase() !== wantProc && pBundle.toLowerCase() !== wantProc) continue;",
    "    const wins = p.windows();",
    "    for (let j = 0; j < wins.length; j++) {",
    "      const w = wins[j];",
    "      let wId = 0;",
    "      try { wId = Number(w.attributes.byName('AXWindowNumber').value()) || 0; } catch {}",
    "      if (!wId) { try { wId = Number(w.id()) || 0; } catch {} }",
    "      const wTitle = String(w.name() || '');",
    "      if (wantHwnd > 0 && wId !== wantHwnd) continue;",
    "      if (wantTitle && !wTitle.toLowerCase().includes(wantTitle)) continue;",
    "      pickedProc = p; pickedWin = w; pickedWinId = wId; break;",
    "    }",
    "  } catch {}",
    "}",
    "if (!pickedProc || !pickedWin) { JSON.stringify({ ok: false, code: 'WINDOW_NOT_FOUND', error: '未找到目标窗口。' }); } else {",
    "  const pPid = Number(pickedProc.unixId ? pickedProc.unixId() : 0) || 0;",
    "  const pName = String(pickedProc.name() || '');",
    "  const pBundle = String(pickedProc.bundleIdentifier() || '');",
    "  const wTitle = String(pickedWin.name() || '');",
    "  if ((excludePid > 0 && pPid === excludePid) || selfSet.has(pName.toLowerCase()) || selfSet.has(pBundle.toLowerCase()) || wTitle.toLowerCase().includes('chisabot 审批') || wTitle.toLowerCase().includes('chisabot 确认')) {",
    "    JSON.stringify({ ok: false, code: 'SELF_TARGET_FORBIDDEN', error: '禁止操控 ChisaBot 自身窗口。' });",
    "  } else {",
    "    let minimized = false;",
    "    try { minimized = Boolean(pickedWin.attributes.byName('AXMinimized').value()); } catch {}",
    "    if (minimized) { JSON.stringify({ ok: false, code: 'WINDOW_MINIMIZED', error: '目标窗口已最小化，无法后台读取控件树。' }); } else {",
    "      const rawEls = pickedWin.entireContents();",
    "      const nodes = [];",
    "      const counts = Object.create(null);",
    "      let visited = 0;",
    "      for (let i = 0; i < rawEls.length; i++) {",
    "        visited++;",
    "        if (nodes.length >= limit) break;",
    "        const el = rawEls[i];",
    "        try {",
    "          const role = String(el.role() || '').toLowerCase();",
    "          const name = String(el.name() || el.title() || '');",
    "          const desc = String(el.description() || '');",
    "          let aid = '';",
    "          try { aid = String(el.attributes.byName('AXIdentifier').value() || ''); } catch {}",
    "          const isPwd = role === 'axsecuretextfield' || role.includes('password');",
    "          let val = null;",
    "          if (!isPwd) { try { const v = el.value(); if (v !== null && v !== undefined) val = String(v); } catch {} }",
    "          const pats = [];",
    "          try { const acts = el.actions.name(); for (const a of acts) { const la = String(a).toLowerCase(); if (la === 'axpress') pats.push('invoke'); else pats.push(la); } } catch {}",
    "          if (role === 'axtextfield' || role === 'axtextarea' || role === 'axsecuretextfield' || role === 'axcombobox') { if (!pats.includes('value')) pats.push('value'); }",
    "          if (interactiveOnly && pats.length === 0 && !role.includes('button') && !role.includes('field') && !role.includes('check') && !role.includes('menu') && !role.includes('link')) continue;",
    "          const pos = el.position ? el.position() : [0, 0];",
    "          const sz = el.size ? el.size() : [0, 0];",
    "          const idKey = role + '\\x1f' + aid + '\\x1f' + name + '\\x1f' + desc;",
    "          counts[idKey] = (counts[idKey] || 0) + 1;",
    "          nodes.push({ _idKey: idKey, role, name, automationId: aid, description: desc, isPassword: isPwd, value: isPwd ? null : val, enabled: Boolean(el.enabled ? el.enabled() : true), focused: Boolean(el.focused ? el.focused() : false), isOffscreen: false, checked: null, expanded: null, selected: null, patterns: pats, runtimeId: '', depth: 1, childrenCount: 0, bounds: { x: Number(pos[0]) || 0, y: Number(pos[1]) || 0, width: Number(sz[0]) || 0, height: Number(sz[1]) || 0 } });",
    "        } catch {}",
    "      }",
    "      for (const n of nodes) { n.uniqueAtCapture = counts[n._idKey] === 1; delete n._idKey; }",
    "      JSON.stringify({ ok: true, found: true, window: { hwnd: pickedWinId, pid: pPid, processStartTicks: '', processName: pName, bundleId: pBundle, title: wTitle }, nodes, totalVisited: visited, truncated: visited < rawEls.length });",
    "    }",
    "  }",
    "}",
  ].join("\n");
}

/** 构造 macOS 后台无感语义操作 JXA（绝不设置 frontmost，仅支持后台 AX 动作）。 */
function buildMacBgActionScript({ window = {}, target = {}, action, value }) {
  return [
    `const wantHwnd = ${Number.isFinite(Number(window.hwnd)) ? Number(window.hwnd) : 0};`,
    `const wantPid = ${Number.isInteger(Number(window.pid)) && Number(window.pid) > 0 ? Number(window.pid) : 0};`,
    `const wantBundle = ${JSON.stringify(
      String(window.bundleId || window.processName || "")
        .trim()
        .toLowerCase(),
    )};`,
    `const wantRole = ${JSON.stringify(
      String(target.role || "")
        .trim()
        .toLowerCase(),
    )};`,
    `const wantAid = ${JSON.stringify(String(target.automationId || ""))};`,
    `const wantName = ${JSON.stringify(String(target.name || ""))};`,
    `const wantDesc = ${JSON.stringify(String(target.description || ""))};`,
    `const targetIsPassword = ${Boolean(target.isPassword)};`,
    `const act = ${JSON.stringify(
      String(action || "")
        .trim()
        .toLowerCase(),
    )};`,
    `const val = ${JSON.stringify(value ?? "")};`,
    "const se = Application('System Events');",
    "const procs = se.applicationProcesses.whose({ backgroundOnly: false })();",
    "let pickedWin = null;",
    "for (let i = 0; i < procs.length && !pickedWin; i++) {",
    "  const p = procs[i];",
    "  try {",
    "    const pPid = Number(p.unixId ? p.unixId() : 0) || 0;",
    "    const pName = String(p.name() || '').toLowerCase();",
    "    const pBundle = String(p.bundleIdentifier() || '').toLowerCase();",
    "    if (wantPid > 0 && pPid !== wantPid) continue;",
    "    if (wantBundle && pBundle !== wantBundle && pName !== wantBundle) continue;",
    "    const wins = p.windows();",
    "    for (let j = 0; j < wins.length; j++) {",
    "      const w = wins[j];",
    "      let wId = 0;",
    "      try { wId = Number(w.attributes.byName('AXWindowNumber').value()) || 0; } catch {}",
    "      if (!wId) { try { wId = Number(w.id()) || 0; } catch {} }",
    "      if (wantHwnd > 0 && wId !== wantHwnd) continue;",
    "      pickedWin = w; break;",
    "    }",
    "  } catch {}",
    "}",
    "if (!pickedWin) { JSON.stringify({ ok: false, code: 'WINDOW_NOT_FOUND', error: '目标窗口不存在。' }); } else {",
    "  const els = pickedWin.entireContents();",
    "  const matches = [];",
    "  for (let i = 0; i < els.length; i++) {",
    "    const el = els[i];",
    "    try {",
    "      const role = String(el.role() || '').toLowerCase();",
    "      const name = String(el.name() || el.title() || '');",
    "      const desc = String(el.description() || '');",
    "      let aid = '';",
    "      try { aid = String(el.attributes.byName('AXIdentifier').value() || ''); } catch {}",
    "      if (wantRole && role !== wantRole) continue;",
    "      if (wantAid && aid !== wantAid) continue;",
    "      if (wantName && name !== wantName) continue;",
    "      if (wantDesc && desc !== wantDesc) continue;",
    "      matches.push(el);",
    "    } catch {}",
    "  }",
    "  if (matches.length === 0) { JSON.stringify({ ok: false, code: 'STALE_REF', error: '未在目标窗口找到匹配控件，请重新快照。' }); }",
    "  else if (matches.length > 1) { JSON.stringify({ ok: false, code: 'AMBIGUOUS_TARGET', error: '目标窗口中存在多个相同控件，拒绝模糊操作。' }); }",
    "  else {",
    "    const el = matches[0];",
    "    let out = null;",
    "    if (act === 'click' || act === 'toggle') {",
    "      let done = false;",
    "      try { el.actions.byName('AXPress').perform(); done = true; } catch {}",
    "      if (!done) { try { el.click(); done = true; } catch {} }",
    "      out = done ? { ok: true, action: act, matchedName: wantName, patternUsed: 'AXPress', delivery: 'delivered_unverified' } : { ok: false, code: 'ACTION_NOT_SUPPORTED', error: '该控件不支持无焦点 AXPress。' };",
    "    } else if (act === 'set_value' || act === 'clear') {",
    "      try { el.value = act === 'clear' ? '' : String(val); out = { ok: true, action: act, matchedName: wantName, patternUsed: 'AXValue', delivery: 'delivered_unverified' }; } catch { out = { ok: false, code: 'ACTION_NOT_SUPPORTED', error: '该控件不支持写入 AXValue。' }; }",
    "    } else if (act === 'type') {",
    "      let curRole = '';",
    "      try { curRole = String(el.role() || '').toLowerCase(); } catch {}",
    "      if (targetIsPassword || curRole === 'axsecuretextfield' || curRole.includes('password')) {",
    "        out = { ok: false, code: 'POLICY_DENIED', error: '禁止对密码框执行无焦点 type（防回读明文），请改用 set_value。' };",
    "      } else {",
    "        try { const prev = String(el.value() || ''); el.value = prev + String(val); out = { ok: true, action: act, matchedName: wantName, patternUsed: 'AXValue', delivery: 'delivered_unverified' }; } catch { out = { ok: false, code: 'ACTION_NOT_SUPPORTED', error: '该控件不支持无焦点文本追加，请改用 set_value 或前台 device_input。' }; }",
    "      }",
    "    } else if (act === 'check' || act === 'uncheck') {",
    "      try {",
    "        const cur = Number(el.value());",
    "        const want = act === 'check' ? 1 : 0;",
    "        if (cur !== want) { el.actions.byName('AXPress').perform(); }",
    "        out = { ok: true, action: act, matchedName: wantName, patternUsed: 'AXPress', delivery: 'delivered_unverified' };",
    "      } catch { out = { ok: false, code: 'ACTION_NOT_SUPPORTED', error: '该控件不支持无焦点勾选操作。' }; }",
    "    } else if (act === 'select') {",
    "      try { el.selected = true; out = { ok: true, action: act, matchedName: wantName, patternUsed: 'AXSelected', delivery: 'delivered_unverified' }; } catch { out = { ok: false, code: 'ACTION_NOT_SUPPORTED', error: '该控件不支持无焦点选择操作。' }; }",
    "    } else {",
    "      out = { ok: false, code: 'ACTION_NOT_SUPPORTED', error: 'macOS 内置驱动不支持后台动作：' + act };",
    "    }",
    "    JSON.stringify(out);",
    "  }",
    "}",
  ].join("\n");
}

function normalizeWindowMeta(raw = {}) {
  const b = raw?.bounds || {};
  return {
    hwnd: raw?.hwnd ?? 0,
    pid: Number(raw?.pid || 0) || 0,
    processStartTicks: String(raw?.processStartTicks ?? ""),
    processName: String(raw?.processName ?? ""),
    bundleId: String(raw?.bundleId || raw?.processName || ""),
    title: String(raw?.title ?? ""),
    ...(raw?.isActive !== undefined ? { isActive: Boolean(raw.isActive) } : {}),
    ...(raw?.isMinimized !== undefined
      ? { isMinimized: Boolean(raw.isMinimized) }
      : {}),
    ...(raw?.bounds
      ? {
          bounds: {
            left: Number(b.left ?? b.x ?? 0) || 0,
            top: Number(b.top ?? b.y ?? 0) || 0,
            width: Number(b.width ?? 0) || 0,
            height: Number(b.height ?? 0) || 0,
          },
        }
      : {}),
  };
}

function normalizeElementList(
  rawNodes,
  snapshotId,
  { fromExternal = false } = {},
) {
  const list = Array.isArray(rawNodes) ? rawNodes : [];
  const elements = [];
  const refMap = new Map();
  let refSeq = 0;

  for (const node of list) {
    if (!node || typeof node !== "object") continue;
    const role =
      String(node.role || "")
        .trim()
        .toLowerCase() || "unknown";
    const patterns = Array.isArray(node.patterns)
      ? node.patterns
          .filter((p) => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.trim())
      : [];
    const isPassword = Boolean(
      node.isPassword ??
        node.is_password ??
        (role.includes("password") || role === "axsecuretextfield"),
    );
    const value = isPassword ? null : (node.value ?? null);
    const b = node.bounds || {};
    const bounds = {
      x: Number(b.x ?? b.left ?? 0) || 0,
      y: Number(b.y ?? b.top ?? 0) || 0,
      width: Number(b.width ?? 0) || 0,
      height: Number(b.height ?? 0) || 0,
    };

    const hasExecPattern = patterns.some((p) =>
      EXECUTABLE_PATTERNS.has(p.toLowerCase()),
    );
    const interactive = INTERACTIVE_ROLES.has(role) || hasExecPattern;
    const rawExternalRef =
      typeof node.ref === "string" && node.ref.trim() ? node.ref.trim() : null;

    let ref = null;
    if (fromExternal ? Boolean(rawExternalRef || interactive) : interactive) {
      refSeq += 1;
      ref = `@${snapshotId}:e${refSeq}`;
    }

    const element = {
      ref,
      role,
      name:
        typeof node.name === "string"
          ? node.name
          : node.name == null
            ? ""
            : String(node.name),
      automationId:
        typeof node.automationId === "string" ? node.automationId : "",
      description: typeof node.description === "string" ? node.description : "",
      value,
      isPassword,
      enabled: node.enabled !== undefined ? Boolean(node.enabled) : true,
      focused: Boolean(node.focused),
      isOffscreen: Boolean(node.isOffscreen),
      checked: node.checked ?? null,
      expanded: node.expanded ?? null,
      selected: node.selected ?? null,
      patterns,
      bounds,
      depth: Number.isInteger(node.depth) ? node.depth : 0,
      childrenCount: Number(node.childrenCount ?? 0) || 0,
      runtimeId: node.runtimeId ?? "",
      uniqueAtCapture:
        typeof node.uniqueAtCapture === "boolean" ? node.uniqueAtCapture : true,
    };

    elements.push(element);
    if (ref) {
      refMap.set(ref, {
        element,
        externalRef: fromExternal ? rawExternalRef || ref : null,
      });
    }
  }

  return { elements, refMap };
}

/**
 * 创建跨平台本机无障碍桥接器（保留旧 readTree/performAction 门控 API，并新增后台无感 DesktopDriver SPI 能力）。
 */
function createAccessibilityBridge(options = {}) {
  const platform = options.platform || process.platform;
  const selfPid =
    options.selfPid !== undefined ? Number(options.selfPid) : process.pid;
  const tmpDir = options.tmpDir || os.tmpdir();
  const maxSnapshots = Math.max(
    1,
    Number(options.maxSnapshots) || DEFAULT_MAX_SNAPSHOTS,
  );
  const authorizer =
    options.authorizer || createDirectionEpochAuthorizer({ now: options.now });
  const hasCustomRunner = typeof options.runner === "function";
  const runner =
    options.runner ||
    ((file, args, opts) => runProcess(file, args, { ...opts, platform }));
  const useWinHelper =
    platform === "win32" && (Boolean(options.winHelper) || !hasCustomRunner);
  const resolveWinHelper = () => options.winHelper || getSharedWinPsHelper();

  const preferExternalDriver = options.preferExternalDriver !== false;
  let externalDriverInstance = options.externalDriver || null;
  function getExternalDriver() {
    if (!preferExternalDriver) return null;
    if (!externalDriverInstance) {
      externalDriverInstance = createAgentDesktopDriver({
        platform,
        selfPid,
        tmpDir,
      });
    }
    return externalDriverInstance;
  }

  const builtinDriverName = builtinDriverNameFor(platform);
  let nextSnapshotId = 1;
  const snapshots = new Map(); // snapshotId -> { snapshotId, mode, driver, window, refMap, capturedAt }

  function storeSnapshot(entry) {
    snapshots.set(entry.snapshotId, entry);
    while (snapshots.size > maxSnapshots) {
      const oldestKey = snapshots.keys().next().value;
      if (oldestKey === undefined) break;
      snapshots.delete(oldestKey);
    }
  }

  function checkSelfTarget(target) {
    if (isProtectedSelfTarget({ ...target, selfPid })) {
      return {
        ok: false,
        code: "SELF_TARGET_FORBIDDEN",
        error: "禁止操控 ChisaBot 自身窗口。",
      };
    }
    return null;
  }

  async function pickExternalDriver() {
    const ext = getExternalDriver();
    if (!ext || typeof ext.isAvailable !== "function") return null;
    try {
      const probe = await ext.isAvailable();
      if (probe?.available === true) return ext;
    } catch {}
    return null;
  }

  async function driverInfo() {
    const ext = getExternalDriver();
    if (ext && typeof ext.isAvailable === "function") {
      try {
        const probe = await ext.isAvailable();
        if (probe?.available === true) {
          return {
            active: ext.name || "agent-desktop",
            mode: "external",
            platform,
            available: true,
            external: {
              name: ext.name || "agent-desktop",
              available: true,
              version: probe.version || null,
              binPath: probe.binPath || null,
              sha256Verified: Boolean(probe.sha256Verified),
            },
            fallback: builtinDriverName,
          };
        }
        return {
          active: builtinDriverName,
          mode: "builtin",
          platform,
          available: platform === "win32" || platform === "darwin",
          external: {
            name: ext.name || "agent-desktop",
            available: false,
            reason: probe?.reason || "unavailable",
          },
          fallback: builtinDriverName,
        };
      } catch {
        // 探测异常则回退内置驱动
      }
    }
    return {
      active: builtinDriverName,
      mode: "builtin",
      platform,
      available: platform === "win32" || platform === "darwin",
      external: {
        name: "agent-desktop",
        available: false,
        reason: preferExternalDriver ? "unavailable" : "disabled",
      },
      fallback: builtinDriverName,
    };
  }

  async function listWindows(args = {}, ctx = {}) {
    if (hasHeadedFlag(args.extraArgs)) {
      return {
        ok: false,
        code: "POLICY_DENIED",
        error: "安全策略禁止传递 --headed 参数。",
      };
    }
    const ext = await pickExternalDriver();
    if (ext && typeof ext.listWindows === "function") {
      const res = await ext.listWindows({
        query: args.query,
        excludePid: selfPid,
        signal: ctx?.signal,
      });
      if (res?.ok) {
        const windows = (Array.isArray(res.windows) ? res.windows : [])
          .map(normalizeWindowMeta)
          .filter((w) => !isProtectedSelfTarget({ ...w, selfPid }));
        return {
          ok: true,
          driver: res.driver || ext.name || "agent-desktop",
          windows,
        };
      }
      if (res?.code && res.code !== "DRIVER_UNAVAILABLE") {
        return res;
      }
    }

    if (platform === "win32") {
      try {
        const data = await resolveWinHelper().request(
          "win_list",
          {
            query: args.query ? String(args.query) : "",
            excludePid: selfPid,
          },
          { timeoutMs: 20_000, signal: ctx?.signal },
        );
        const rawWins = Array.isArray(data?.windows) ? data.windows : [];
        const windows = rawWins
          .map(normalizeWindowMeta)
          .filter((w) => !isProtectedSelfTarget({ ...w, selfPid }));
        return {
          ok: true,
          driver: "builtin-uia",
          windows,
        };
      } catch (error) {
        const msg = String(error?.message || error);
        return {
          ok: false,
          code: extractErrorCodeFromMessage(msg, "DRIVER_UNAVAILABLE"),
          error: `Windows 后台窗口枚举失败：${msg.slice(0, 240)}`,
          driver: "builtin-uia",
        };
      }
    }

    if (platform === "darwin") {
      const script = buildMacListWindowsScript({
        query: args.query,
        excludePid: selfPid,
      });
      const res = await runner(
        "osascript",
        ["-l", "JavaScript", "-e", script],
        { timeoutMs: 20_000, signal: ctx?.signal },
      );
      if (res.exitCode !== 0) {
        const msg = String(res.stderr || "");
        return {
          ok: false,
          code: extractErrorCodeFromMessage(msg, "DRIVER_UNAVAILABLE"),
          error: `macOS 后台窗口枚举失败：${msg.slice(0, 240)}`,
          driver: "builtin-mac-ax",
        };
      }
      try {
        const parsed = JSON.parse(String(res.stdout || "{}").trim() || "{}");
        const rawWins = Array.isArray(parsed?.windows) ? parsed.windows : [];
        const windows = rawWins
          .map(normalizeWindowMeta)
          .filter((w) => !isProtectedSelfTarget({ ...w, selfPid }));
        return {
          ok: true,
          driver: "builtin-mac-ax",
          windows,
        };
      } catch {
        return {
          ok: false,
          code: "DRIVER_UNAVAILABLE",
          error: "macOS 后台窗口枚举输出 JSON 解析失败。",
          driver: "builtin-mac-ax",
        };
      }
    }

    return {
      ok: false,
      code: "DRIVER_UNAVAILABLE",
      error:
        "Linux 后台无感操控请安装 agent-desktop（AT-SPI）或显式改用前台 device_input。",
      driver: "builtin-linux-stub",
    };
  }

  async function snapshot(args = {}, ctx = {}) {
    if (hasHeadedFlag(args.extraArgs)) {
      return {
        ok: false,
        code: "POLICY_DENIED",
        error: "安全策略禁止传递 --headed 参数。",
      };
    }
    const selfBlocked = checkSelfTarget(args);
    if (selfBlocked) return selfBlocked;

    const ext = await pickExternalDriver();
    if (ext && typeof ext.snapshot === "function") {
      const extRes = await ext.snapshot({
        hwnd: args.hwnd,
        pid: args.pid,
        bundleId: args.bundleId,
        processName: args.processName,
        title: args.title,
        maxNodes: args.maxNodes,
        maxDepth: args.maxDepth,
        interactiveOnly: args.interactiveOnly,
        compact: args.compact,
        excludePid: selfPid,
        signal: ctx?.signal,
      });
      if (extRes?.ok) {
        const winMeta = normalizeWindowMeta(extRes.window || {});
        const postSelfBlocked = checkSelfTarget(winMeta);
        if (postSelfBlocked) return postSelfBlocked;
        const snapshotId = nextSnapshotId++;
        const rawNodes = Array.isArray(extRes.elements)
          ? extRes.elements
          : Array.isArray(extRes.nodes)
            ? extRes.nodes
            : [];
        const { elements, refMap } = normalizeElementList(
          rawNodes,
          snapshotId,
          { fromExternal: true },
        );
        const driverName = extRes.driver || ext.name || "agent-desktop";
        storeSnapshot({
          snapshotId,
          mode: "external",
          driver: driverName,
          window: winMeta,
          refMap,
          capturedAt: Date.now(),
        });
        return {
          ok: true,
          driver: driverName,
          snapshotId,
          window: winMeta,
          elements,
          totalVisited: Number(extRes.totalVisited ?? elements.length),
          truncated: Boolean(extRes.truncated),
        };
      }
      if (extRes?.code && extRes.code !== "DRIVER_UNAVAILABLE") {
        return extRes;
      }
    }

    if (platform === "win32") {
      try {
        const data = await resolveWinHelper().request(
          "uia_snapshot",
          {
            hwnd: args.hwnd,
            pid: args.pid,
            bundleId: args.bundleId,
            processName: args.processName,
            title: args.title,
            maxNodes: args.maxNodes,
            maxDepth: args.maxDepth,
            interactiveOnly: Boolean(args.interactiveOnly),
            compact: Boolean(args.compact),
            excludePid: selfPid,
          },
          { timeoutMs: 20_000, signal: ctx?.signal },
        );
        if (!data || data.ok === false) {
          return {
            ok: false,
            code: data?.code || "WINDOW_NOT_FOUND",
            error: data?.error || "Windows 后台读取控件树失败。",
            driver: "builtin-uia",
          };
        }
        const winMeta = normalizeWindowMeta(data.window || {});
        const postSelfBlocked = checkSelfTarget(winMeta);
        if (postSelfBlocked) return postSelfBlocked;

        const snapshotId = nextSnapshotId++;
        const { elements, refMap } = normalizeElementList(
          data.nodes || data.elements,
          snapshotId,
          { fromExternal: false },
        );
        storeSnapshot({
          snapshotId,
          mode: "builtin",
          driver: "builtin-uia",
          window: winMeta,
          refMap,
          capturedAt: Date.now(),
        });
        return {
          ok: true,
          driver: "builtin-uia",
          snapshotId,
          window: winMeta,
          elements,
          totalVisited: Number(data.totalVisited ?? elements.length),
          truncated: Boolean(data.truncated),
        };
      } catch (error) {
        const msg = String(error?.message || error);
        return {
          ok: false,
          code: extractErrorCodeFromMessage(msg, "DRIVER_UNAVAILABLE"),
          error: `Windows 后台读取控件树失败：${msg.slice(0, 240)}`,
          driver: "builtin-uia",
        };
      }
    }

    if (platform === "darwin") {
      const script = buildMacSnapshotScript({
        hwnd: args.hwnd,
        pid: args.pid,
        bundleId: args.bundleId,
        processName: args.processName,
        title: args.title,
        maxNodes: args.maxNodes,
        interactiveOnly: Boolean(args.interactiveOnly),
        excludePid: selfPid,
      });
      const res = await runner(
        "osascript",
        ["-l", "JavaScript", "-e", script],
        { timeoutMs: 20_000, signal: ctx?.signal },
      );
      if (res.exitCode !== 0) {
        const msg = String(res.stderr || "");
        return {
          ok: false,
          code: extractErrorCodeFromMessage(msg, "DRIVER_UNAVAILABLE"),
          error: `macOS 后台读取控件树失败：${msg.slice(0, 240)}`,
          driver: "builtin-mac-ax",
        };
      }
      let data;
      try {
        data = JSON.parse(String(res.stdout || "{}").trim() || "{}");
      } catch {
        return {
          ok: false,
          code: "DRIVER_UNAVAILABLE",
          error: "macOS 后台快照输出 JSON 解析失败。",
          driver: "builtin-mac-ax",
        };
      }
      if (!data || data.ok === false) {
        return {
          ok: false,
          code: data?.code || "WINDOW_NOT_FOUND",
          error: data?.error || "macOS 后台读取控件树失败。",
          driver: "builtin-mac-ax",
        };
      }
      const winMeta = normalizeWindowMeta(data.window || {});
      const postSelfBlocked = checkSelfTarget(winMeta);
      if (postSelfBlocked) return postSelfBlocked;
      const snapshotId = nextSnapshotId++;
      const { elements, refMap } = normalizeElementList(
        data.nodes || data.elements,
        snapshotId,
        { fromExternal: false },
      );
      storeSnapshot({
        snapshotId,
        mode: "builtin",
        driver: "builtin-mac-ax",
        window: winMeta,
        refMap,
        capturedAt: Date.now(),
      });
      return {
        ok: true,
        driver: "builtin-mac-ax",
        snapshotId,
        window: winMeta,
        elements,
        totalVisited: Number(data.totalVisited ?? elements.length),
        truncated: Boolean(data.truncated),
      };
    }

    return {
      ok: false,
      code: "DRIVER_UNAVAILABLE",
      error:
        "Linux 后台无感操控请安装 agent-desktop（AT-SPI）或显式改用前台 device_input。",
      driver: "builtin-linux-stub",
    };
  }

  async function act(args = {}, ctx = {}) {
    if (hasHeadedFlag(args.extraArgs)) {
      return {
        ok: false,
        code: "POLICY_DENIED",
        error: "安全策略禁止传递 --headed 参数。",
      };
    }

    const actName = String(args.action || "")
      .trim()
      .toLowerCase();
    if (actName === "focus") {
      return {
        ok: false,
        code: "POLICY_DENIED",
        error:
          "后台无感操控禁止抢占前景焦点（focus），请改用无焦点操作或显式使用前台 device_input。",
      };
    }
    if (!ALLOWED_BG_ACTIONS.has(actName)) {
      return {
        ok: false,
        code: "ACTION_NOT_SUPPORTED",
        error: `不支持的后台语义操作：${actName || "(empty)"}`,
      };
    }

    const parsedRef = parseDesktopRef(args.ref);
    if (!parsedRef) {
      return {
        ok: false,
        code: "STALE_REF",
        error:
          "控件引用格式无效（必须为 @<snapshotId>:e<N>），请重新调用 desktop_snapshot 获取最新快照。",
      };
    }

    const directSelfBlocked = checkSelfTarget(args);
    if (directSelfBlocked) return directSelfBlocked;
    if (args._resolved?.window) {
      const resolvedSelfBlocked = checkSelfTarget(args._resolved.window);
      if (resolvedSelfBlocked) return resolvedSelfBlocked;
    }

    const snap = snapshots.get(parsedRef.snapshotId) || null;
    const localEntry = snap ? snap.refMap.get(parsedRef.canonical) : null;

    let targetWindow = null;
    let targetElement = null;
    let mode = "builtin";
    let externalRef = null;

    if (localEntry) {
      targetWindow = snap.window;
      targetElement = localEntry.element;
      mode = snap.mode;
      externalRef = localEntry.externalRef;
    } else if (
      args._resolved?.element &&
      args._resolved?.window &&
      (!args._resolved.snapshotId ||
        Number(args._resolved.snapshotId) === parsedRef.snapshotId)
    ) {
      if (args._resolved.driver === "agent-desktop") {
        return {
          ok: false,
          code: "STALE_REF",
          error:
            "外部 agent-desktop 本地快照映射已失效，请重新调用 desktop_snapshot 获取最新快照。",
        };
      }
      targetWindow = normalizeWindowMeta(args._resolved.window);
      targetElement = args._resolved.element;
      mode = "builtin";
    } else {
      return {
        ok: false,
        code: "STALE_REF",
        error:
          "控件引用已过期或不存在，请重新调用 desktop_snapshot 获取最新快照。",
      };
    }

    const winSelfBlocked = checkSelfTarget(targetWindow);
    if (winSelfBlocked) return winSelfBlocked;

    if (mode === "external") {
      const ext = getExternalDriver();
      if (!ext || typeof ext.act !== "function") {
        return {
          ok: false,
          code: "DRIVER_UNAVAILABLE",
          error: "外部 agent-desktop 驱动不可用，无法执行该外部快照引用。",
        };
      }
      const res = await ext.act({
        ref: externalRef || parsedRef.canonical,
        action: actName,
        value: args.value,
        direction: args.direction,
        amount: args.amount,
        option: args.option,
        hwnd: targetWindow.hwnd,
        pid: targetWindow.pid,
        processName: targetWindow.processName,
        bundleId: targetWindow.bundleId,
        title: targetWindow.title,
        excludePid: selfPid,
        signal: ctx?.signal,
      });
      if (!res?.ok)
        return (
          res || {
            ok: false,
            code: "ACTION_NOT_SUPPORTED",
            error: "外部驱动执行失败。",
          }
        );
      return {
        ...res,
        driver: res.driver || ext.name || "agent-desktop",
        ref: parsedRef.canonical,
      };
    }

    if (platform === "win32") {
      try {
        const res = await resolveWinHelper().request(
          "uia_act",
          {
            hwnd: targetWindow.hwnd,
            pid: targetWindow.pid,
            processStartTicks: targetWindow.processStartTicks,
            excludePid: selfPid,
            target: {
              runtimeId: targetElement.runtimeId,
              role: targetElement.role,
              automationId: targetElement.automationId,
              name: targetElement.name,
              description: targetElement.description,
              uniqueAtCapture: targetElement.uniqueAtCapture,
            },
            action: actName,
            value: args.value,
            direction: args.direction,
            amount: args.amount,
            option: args.option,
          },
          { timeoutMs: 20_000, signal: ctx?.signal },
        );
        if (!res?.ok) {
          return {
            ok: false,
            code: res?.code || "ACTION_NOT_SUPPORTED",
            error: res?.error || "Windows 后台操控失败。",
            driver: "builtin-uia",
          };
        }
        return {
          ...res,
          driver: "builtin-uia",
          ref: parsedRef.canonical,
        };
      } catch (error) {
        const msg = String(error?.message || error);
        return {
          ok: false,
          code: extractErrorCodeFromMessage(msg, "ACTION_NOT_SUPPORTED"),
          error: `Windows 后台操控失败：${msg.slice(0, 240)}`,
          driver: "builtin-uia",
        };
      }
    }

    if (platform === "darwin") {
      const targetRole = String(targetElement?.role || "").toLowerCase();
      if (
        actName === "type" &&
        (targetElement?.isPassword === true ||
          targetRole === "axsecuretextfield" ||
          targetRole.includes("password"))
      ) {
        return {
          ok: false,
          code: "POLICY_DENIED",
          error:
            "禁止对密码框执行无焦点 type（防回读明文），请改用 set_value。",
          driver: "builtin-mac-ax",
        };
      }
      const script = buildMacBgActionScript({
        window: targetWindow,
        target: targetElement,
        action: actName,
        value: args.value,
      });
      const res = await runner(
        "osascript",
        ["-l", "JavaScript", "-e", script],
        { timeoutMs: 20_000, signal: ctx?.signal },
      );
      if (res.exitCode !== 0) {
        const msg = String(res.stderr || "");
        return {
          ok: false,
          code: extractErrorCodeFromMessage(msg, "ACTION_NOT_SUPPORTED"),
          error: `macOS 后台操控失败：${msg.slice(0, 240)}`,
          driver: "builtin-mac-ax",
        };
      }
      try {
        const parsed = JSON.parse(String(res.stdout || "{}").trim() || "{}");
        if (!parsed?.ok) {
          return {
            ok: false,
            code: parsed?.code || "ACTION_NOT_SUPPORTED",
            error: parsed?.error || "macOS 后台操控失败。",
            driver: "builtin-mac-ax",
          };
        }
        return {
          ...parsed,
          driver: "builtin-mac-ax",
          ref: parsedRef.canonical,
        };
      } catch {
        return {
          ok: false,
          code: "ACTION_NOT_SUPPORTED",
          error: "macOS 后台操控输出 JSON 解析失败。",
          driver: "builtin-mac-ax",
        };
      }
    }

    return {
      ok: false,
      code: "DRIVER_UNAVAILABLE",
      error:
        "Linux 后台无感操控请安装 agent-desktop（AT-SPI）或显式改用前台 device_input。",
      driver: "builtin-linux-stub",
    };
  }

  async function captureWindow(args = {}, ctx = {}) {
    if (hasHeadedFlag(args.extraArgs)) {
      return {
        ok: false,
        code: "POLICY_DENIED",
        error: "安全策略禁止传递 --headed 参数。",
      };
    }
    const selfBlocked = checkSelfTarget(args);
    if (selfBlocked) return selfBlocked;

    const ext = await pickExternalDriver();
    if (ext && typeof ext.captureWindow === "function") {
      const res = await ext.captureWindow({
        hwnd: args.hwnd,
        pid: args.pid,
        bundleId: args.bundleId,
        processName: args.processName,
        title: args.title,
        maxWidth: args.maxWidth,
        excludePid: selfPid,
        signal: ctx?.signal,
      });
      if (res?.ok) {
        const postSelfBlocked = checkSelfTarget({
          pid: res.pid ?? args.pid,
          processName: res.processName ?? args.processName,
          bundleId: res.bundleId ?? args.bundleId,
          title: res.title ?? args.title,
        });
        if (postSelfBlocked) return postSelfBlocked;
        return {
          ok: true,
          driver: res.driver || ext.name || "agent-desktop",
          format: res.format || "png",
          hwnd: res.hwnd ?? args.hwnd ?? 0,
          pid: Number(res.pid ?? args.pid ?? 0) || 0,
          processName: String(res.processName ?? args.processName ?? ""),
          title: String(res.title ?? args.title ?? ""),
          width: Number(res.width || 0) || 0,
          height: Number(res.height || 0) || 0,
          windowWidth: Number(res.windowWidth ?? res.width ?? 0) || 0,
          windowHeight: Number(res.windowHeight ?? res.height ?? 0) || 0,
          base64: String(res.base64 || ""),
        };
      }
      if (res?.code && res.code !== "DRIVER_UNAVAILABLE") {
        return res;
      }
    }

    if (platform === "win32") {
      try {
        const res = await resolveWinHelper().request(
          "win_capture",
          {
            hwnd: args.hwnd,
            pid: args.pid,
            processStartTicks: args.processStartTicks,
            bundleId: args.bundleId,
            processName: args.processName,
            title: args.title,
            maxWidth: args.maxWidth,
            excludePid: selfPid,
          },
          { timeoutMs: 20_000, signal: ctx?.signal },
        );
        if (!res?.ok) {
          return {
            ok: false,
            code: res?.code || "ACTION_NOT_SUPPORTED",
            error: res?.error || "Windows 后台窗口截屏失败。",
            driver: "builtin-uia",
          };
        }
        const postSelfBlocked = checkSelfTarget(res);
        if (postSelfBlocked) return postSelfBlocked;
        return {
          ok: true,
          driver: "builtin-uia",
          format: res.format || "png",
          hwnd: res.hwnd ?? 0,
          pid: Number(res.pid || 0) || 0,
          processStartTicks: String(res.processStartTicks || ""),
          processName: String(res.processName || ""),
          title: String(res.title || ""),
          width: Number(res.width || 0) || 0,
          height: Number(res.height || 0) || 0,
          windowWidth: Number(res.windowWidth ?? res.width ?? 0) || 0,
          windowHeight: Number(res.windowHeight ?? res.height ?? 0) || 0,
          base64: String(res.base64 || ""),
        };
      } catch (error) {
        const msg = String(error?.message || error);
        return {
          ok: false,
          code: extractErrorCodeFromMessage(msg, "ACTION_NOT_SUPPORTED"),
          error: `Windows 后台窗口截屏失败：${msg.slice(0, 240)}`,
          driver: "builtin-uia",
        };
      }
    }

    if (platform === "darwin") {
      let winId = Number.isFinite(Number(args.hwnd)) ? Number(args.hwnd) : 0;
      let winMeta = {
        hwnd: winId,
        pid: Number(args.pid || 0) || 0,
        processName: String(args.processName || args.bundleId || ""),
        bundleId: String(args.bundleId || ""),
        title: String(args.title || ""),
      };

      if (winId <= 0) {
        const listed = await listWindows(
          { query: args.title || args.bundleId || args.processName || "" },
          ctx,
        );
        if (!listed.ok) return listed;
        const match = listed.windows.find((w) => {
          if (args.pid && w.pid !== Number(args.pid)) return false;
          if (
            args.bundleId &&
            w.bundleId.toLowerCase() !== String(args.bundleId).toLowerCase() &&
            w.processName.toLowerCase() !== String(args.bundleId).toLowerCase()
          ) {
            return false;
          }
          if (
            args.processName &&
            w.processName.toLowerCase() !==
              String(args.processName).toLowerCase()
          ) {
            return false;
          }
          if (
            args.title &&
            !w.title.toLowerCase().includes(String(args.title).toLowerCase())
          ) {
            return false;
          }
          return true;
        });
        if (!match) {
          return {
            ok: false,
            code: "WINDOW_NOT_FOUND",
            error: "未找到匹配的 macOS 目标窗口。",
            driver: "builtin-mac-ax",
          };
        }
        if (match.isMinimized) {
          return {
            ok: false,
            code: "WINDOW_MINIMIZED",
            error: "目标窗口已最小化，无法后台截取画面。",
            driver: "builtin-mac-ax",
          };
        }
        winId = Number(match.hwnd) || 0;
        winMeta = match;
      }

      if (winId <= 0) {
        return {
          ok: false,
          code: "WINDOW_NOT_FOUND",
          error: "无法解析目标窗口的 macOS windowId。",
          driver: "builtin-mac-ax",
        };
      }

      const postSelfBlocked = checkSelfTarget(winMeta);
      if (postSelfBlocked) return postSelfBlocked;

      const token = crypto.randomBytes(8).toString("hex");
      const tmpPng = path.join(
        tmpDir,
        `cb-mac-wincap-${process.pid}-${token}.png`,
      );
      try {
        const capRes = await runner(
          "/usr/sbin/screencapture",
          ["-x", "-t", "png", "-l", String(winId), tmpPng],
          { timeoutMs: 20_000, signal: ctx?.signal },
        );
        if (capRes.exitCode !== 0) {
          const msg = String(capRes.stderr || "");
          return {
            ok: false,
            code: extractErrorCodeFromMessage(msg, "ACTION_NOT_SUPPORTED"),
            error: `macOS 后台窗口截屏失败：${msg.slice(0, 240)}`,
            driver: "builtin-mac-ax",
          };
        }
        const buf = await fsp.readFile(tmpPng);
        const dims = parsePngDimensions(buf);
        return {
          ok: true,
          driver: "builtin-mac-ax",
          format: "png",
          hwnd: winId,
          pid: Number(winMeta.pid || 0) || 0,
          processName: String(winMeta.processName || ""),
          title: String(winMeta.title || ""),
          width: dims.width,
          height: dims.height,
          windowWidth: dims.width,
          windowHeight: dims.height,
          base64: buf.toString("base64"),
        };
      } catch (error) {
        const msg = String(error?.message || error);
        return {
          ok: false,
          code: extractErrorCodeFromMessage(msg, "ACTION_NOT_SUPPORTED"),
          error: `macOS 后台窗口截屏失败：${msg.slice(0, 240)}`,
          driver: "builtin-mac-ax",
        };
      } finally {
        try {
          await fsp.rm(tmpPng, { force: true });
        } catch {}
      }
    }

    return {
      ok: false,
      code: "DRIVER_UNAVAILABLE",
      error:
        "Linux 后台无感操控请安装 agent-desktop（AT-SPI）或显式改用前台 device_input。",
      driver: "builtin-linux-stub",
    };
  }

  function normalizeTreeResult(raw) {
    const base = raw && typeof raw === "object" ? raw : {};
    const nodes = Array.isArray(base.nodes)
      ? base.nodes
      : base.nodes
        ? [base.nodes]
        : [];
    return { ...base, nodes };
  }

  function gate({ conversationId, deviceId, bundleId, epoch, scopes }) {
    const normalized = normalizeBundleId(bundleId);
    if (!normalized) {
      return {
        ok: false,
        status: "failed",
        error: "必须指定目标应用 bundleId 或进程名。",
      };
    }
    const verdict = authorizer.checkAuthorization({
      conversationId,
      deviceId,
      bundleId: normalized,
      epoch,
      scopes,
    });
    if (!verdict.allowed) {
      if (verdict.reason === "app_not_authorized") {
        return {
          ok: false,
          status: "ask",
          app: { bundleId: normalized },
          epoch: verdict.currentEpoch,
          reason: verdict.reason,
        };
      }
      return {
        ok: false,
        status: "denied",
        epoch: verdict.currentEpoch,
        error:
          verdict.reason === "missing_accessibility_scope"
            ? "设备未签发 accessibility_control 能力 scope，拒绝无障碍访问。"
            : verdict.reason === "direction_epoch_superseded"
              ? "用户已发出新指令，旧回合的应用临时授权已自动失效，请重新确认。"
              : "本回合应用临时授权已过期，请重新确认。",
      };
    }
    return { ok: true, bundleId: normalized, epoch: verdict.currentEpoch };
  }

  async function readTree(request) {
    const check = gate(request);
    if (!check.ok) return check;
    if (platform === "win32") {
      const limit = Math.min(200, Math.max(10, Number(request.maxNodes) || 80));
      const maxDepth = Math.min(
        30,
        Math.max(2, Number(request.maxDepth) || 12),
      );
      if (useWinHelper) {
        try {
          const data = await resolveWinHelper().request(
            "uia_read",
            { bundleId: check.bundleId, maxNodes: limit, maxDepth },
            { timeoutMs: 20_000 },
          );
          return {
            ok: true,
            status: "done",
            platform,
            bundleId: check.bundleId,
            epoch: check.epoch,
            tree: normalizeTreeResult(data),
          };
        } catch (error) {
          if (!error?.isTransportError) {
            return {
              ok: false,
              status: "failed",
              error: `Windows UIA 读取失败：${String(error?.message || error).slice(0, 240)}`,
            };
          }
          // helper 管道异常重试后仍失败：降级到一次性有界 PowerShell 脚本兜底
        }
      }
      const script = buildWinReadTreeScript({
        bundleId: check.bundleId,
        maxNodes: limit,
        maxDepth,
      });
      const res = await runner(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-EncodedCommand",
          encodePowerShell(script),
        ],
        { timeoutMs: 20_000 },
      );
      if (res.exitCode !== 0) {
        return {
          ok: false,
          status: "failed",
          error: `Windows UIA 读取失败：${String(res.stderr || "").slice(0, 240)}`,
        };
      }
      try {
        const parsed = normalizeTreeResult(
          JSON.parse(String(res.stdout || "{}").trim() || "{}"),
        );
        return {
          ok: true,
          status: "done",
          platform,
          bundleId: check.bundleId,
          epoch: check.epoch,
          tree: parsed,
        };
      } catch {
        return {
          ok: false,
          status: "failed",
          error: "Windows UIA 输出 JSON 解析失败。",
        };
      }
    }
    if (platform === "darwin") {
      const script = buildMacReadTreeScript({
        bundleId: check.bundleId,
        maxNodes: request.maxNodes,
      });
      const res = await runner(
        "osascript",
        ["-l", "JavaScript", "-e", script],
        { timeoutMs: 20_000 },
      );
      if (res.exitCode !== 0) {
        const isPerm = /not allowed assistive access|1002|accessibility/i.test(
          String(res.stderr || ""),
        );
        return {
          ok: false,
          status: isPerm ? "needs_permission" : "failed",
          error: isPerm
            ? "请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中授予 ChisaBot 无障碍权限。"
            : `macOS 无障碍读取失败：${String(res.stderr || "").slice(0, 240)}`,
        };
      }
      try {
        const parsed = JSON.parse(String(res.stdout || "{}").trim() || "{}");
        return {
          ok: true,
          status: "done",
          platform,
          bundleId: check.bundleId,
          epoch: check.epoch,
          tree: parsed,
        };
      } catch {
        return {
          ok: false,
          status: "failed",
          error: "macOS 无障碍输出 JSON 解析失败。",
        };
      }
    }
    return {
      ok: false,
      status: "needs_permission",
      error:
        "Linux 平台当前未检测到可用的 AT-SPI 无障碍语义桥，请改用截图与坐标输入。",
    };
  }

  async function performAction(request) {
    const check = gate(request);
    if (!check.ok) return check;
    const action = String(request.action || "click");
    if (!["click", "focus", "set_value"].includes(action)) {
      return {
        ok: false,
        status: "failed",
        error: `不支持的语义操作：${action}`,
      };
    }
    if (platform === "win32") {
      if (useWinHelper) {
        try {
          await resolveWinHelper().request(
            "uia_action",
            {
              bundleId: check.bundleId,
              action,
              name: request.name ?? "",
              automationId: request.automationId ?? "",
              value: request.value ?? "",
            },
            { timeoutMs: 20_000 },
          );
          return {
            ok: true,
            status: "done",
            platform,
            bundleId: check.bundleId,
            epoch: check.epoch,
            action,
          };
        } catch (error) {
          if (!error?.isTransportError) {
            return {
              ok: false,
              status: "failed",
              error: `Windows UIA 操作失败：${String(error?.message || error).slice(0, 240)}`,
            };
          }
          // helper 管道异常重试后仍失败：降级到一次性有界 PowerShell 脚本兜底
        }
      }
      const script = buildWinActionScript({
        bundleId: check.bundleId,
        action,
        name: request.name,
        automationId: request.automationId,
        value: request.value,
      });
      const res = await runner(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-EncodedCommand",
          encodePowerShell(script),
        ],
        { timeoutMs: 20_000 },
      );
      if (res.exitCode !== 0) {
        return {
          ok: false,
          status: "failed",
          error: `Windows UIA 操作失败：${String(res.stderr || "").slice(0, 240)}`,
        };
      }
      return {
        ok: true,
        status: "done",
        platform,
        bundleId: check.bundleId,
        epoch: check.epoch,
        action,
      };
    }
    if (platform === "darwin") {
      const script = buildMacActionScript({
        bundleId: check.bundleId,
        action,
        name: request.name,
        value: request.value,
      });
      const res = await runner(
        "osascript",
        ["-l", "JavaScript", "-e", script],
        { timeoutMs: 20_000 },
      );
      if (res.exitCode !== 0) {
        const isPerm = /not allowed assistive access|1002|accessibility/i.test(
          String(res.stderr || ""),
        );
        return {
          ok: false,
          status: isPerm ? "needs_permission" : "failed",
          error: isPerm
            ? "请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中允许 ChisaBot 控制目标应用。"
            : `macOS 无障碍操作失败：${String(res.stderr || "").slice(0, 240)}`,
        };
      }
      return {
        ok: true,
        status: "done",
        platform,
        bundleId: check.bundleId,
        epoch: check.epoch,
        action,
      };
    }
    return {
      ok: false,
      status: "needs_permission",
      error: "Linux 平台暂不支持语义无障碍操作，请降级使用坐标输入。",
    };
  }

  function clearSnapshots() {
    snapshots.clear();
  }

  return {
    authorizer,
    driverInfo,
    clearSnapshots,
    listWindows,
    snapshot,
    act,
    captureWindow,
    readTree,
    performAction,
  };
}

module.exports = {
  ACCESSIBILITY_SCOPE,
  DEFAULT_GRANT_TTL_MS,
  MAX_GRANT_TTL_MS,
  normalizeBundleId,
  psUtf8Literal,
  isProtectedSelfTarget,
  parseDesktopRef,
  createDirectionEpochAuthorizer,
  buildWinReadTreeScript,
  buildWinActionScript,
  buildMacReadTreeScript,
  buildMacActionScript,
  buildMacListWindowsScript,
  buildMacSnapshotScript,
  buildMacBgActionScript,
  createAccessibilityBridge,
};
