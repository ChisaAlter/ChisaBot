"use strict";
/**
 * 本机无障碍控件树语义读写 + 按 `bundleId` 绑定 `directionEpoch` 细粒度回合授权。
 *
 * 设计要点：
 * 1. 回合代际授权（Direction Epoch）：
 *    - 每个对话（`conversationId`）持有单调递增的 `directionEpoch`；
 *    - 用户发出新指令时调用 `advanceEpoch(conversationId)`，上一代际签发的所有 `bundleId` 临时授权自动失效；
 *    - 授权键严格绑定 `(conversationId, deviceId, epoch, normalizedBundleId)`，并强校验设备已签发 `accessibility_control` scope；
 * 2. 跨平台语义无障碍操控：
 *    - Windows：PowerShell + `UIAutomationClient` 枚举窗口与语义控件树（name / controlType / automationId / bounds / value），支持 click / focus / set_value；
 *    - macOS：AppleScript / JXA System Events + `AXUIElement` 语义读取与操作，并在未授辅助功能权限时返回清晰提示；
 *    - Linux：检测 AT-SPI / xdotool 能力并提供清晰降级提示。
 */
const { runProcess, encodePowerShell } = require("./agent/ops");

const DEFAULT_GRANT_TTL_MS = 10 * 60_000;
const MAX_GRANT_TTL_MS = 30 * 60_000;
const ACCESSIBILITY_SCOPE = "accessibility_control";
const BUNDLE_ID_RE = /^[a-z0-9._-]{1,160}$/;

function normalizeBundleId(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value || !BUNDLE_ID_RE.test(value)) return "";
  return value;
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

/** 构造 Windows UI Automation 语义控件树读取脚本（仅精确匹配进程名，且用 Base64 防弯单引号逃逸）。 */
function buildWinReadTreeScript({ bundleId, maxNodes = 80 }) {
  const normalizedTarget = normalizeBundleId(bundleId);
  if (!normalizedTarget) {
    throw new Error("必须提供合法的目标应用标识（bundleId / 进程名）。");
  }
  const limit = Math.min(200, Math.max(10, Number(maxNodes) || 80));
  return [
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    `$target = ${psUtf8Literal(normalizedTarget)}`,
    `$limit = ${limit}`,
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$cond = [System.Windows.Automation.Condition]::TrueCondition",
    "$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)",
    "$picked = $null",
    "foreach ($w in $wins) {",
    "  $pidVal = $w.Current.ProcessId",
    "  $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue",
    "  $pname = if ($proc) { $proc.ProcessName.ToLower() } else { '' }",
    "  if ($pname -eq $target) { $picked = $w; break }",
    "}",
    'if (-not $picked) { Write-Output \'{"nodes":[],"found":false}\'; exit 0 }',
    "$all = $picked.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)",
    "$nodes = @()",
    "for ($i = 0; $i -lt $all.Count -and $nodes.Count -lt $limit; $i++) {",
    "  $el = $all.Item($i)",
    "  $cur = $el.Current",
    "  if (-not $cur.Name -and -not $cur.AutomationId) { continue }",
    "  $r = $cur.BoundingRectangle",
    "  $nodes += @{ name = $cur.Name; role = $cur.ControlType.ProgrammaticName; automationId = $cur.AutomationId; enabled = $cur.IsEnabled; focused = $cur.HasKeyboardFocus; bounds = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height } }",
    "}",
    "@{ found = $true; windowTitle = $picked.Current.Name; nodes = $nodes } | ConvertTo-Json -Depth 5 -Compress",
  ].join("\n");
}

/** 构造 Windows UI Automation 语义操作脚本（focus / click / set_value，全参数走 Base64 解码）。 */
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
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$cond = [System.Windows.Automation.Condition]::TrueCondition",
    "$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)",
    "$picked = $null",
    "foreach ($w in $wins) {",
    "  $proc = Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue",
    "  $pname = if ($proc) { $proc.ProcessName.ToLower() } else { '' }",
    "  if ($pname -eq $target) { $picked = $w; break }",
    "}",
    "if (-not $picked) { throw '未找到目标应用窗口' }",
    "$all = $picked.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)",
    "$el = $null",
    "for ($i = 0; $i -lt $all.Count; $i++) {",
    "  $cand = $all.Item($i)",
    "  if ($matchId -and $cand.Current.AutomationId -eq $matchId) { $el = $cand; break }",
    "  if ($matchName -and $cand.Current.Name -eq $matchName) { $el = $cand; break }",
    "}",
    "if (-not $el) { throw '未找到匹配的语义控件' }",
    "if ($act -eq 'focus') { $el.SetFocus() }",
    "elseif ($act -eq 'set_value') { $vp = $null; if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { throw '该控件不支持 ValuePattern' }; $vp.SetValue($val) }",
    "else { $ip = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke() } else { $el.SetFocus() } }",
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

/** 构造 macOS JXA 语义操作脚本（focus / click / set_value）。 */
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
    "proc.frontmost = true;",
    "if (act === 'focus' && !matchName) { JSON.stringify({ ok: true, action: 'focus', matched: target }); } else {",
    "  const win = proc.windows[0];",
    "  const elements = win ? win.entireContents() : [];",
    "  const el = elements.find((item) => { try { return String(item.name() || item.title() || item.description() || '') === matchName; } catch { return false; } });",
    "  if (!el) throw new Error('未找到匹配的语义控件');",
    "  if (act === 'set_value') { el.value = val; }",
    "  else if (act === 'focus') { el.focused = true; }",
    "  else { el.click(); }",
    "  JSON.stringify({ ok: true, action: act, matched: matchName });",
    "}",
  ].join("\n");
}

/**
 * 创建跨平台本机无障碍桥接器（所有操作强制经过 directionEpoch + bundleId + scope 门控）。
 */
function createAccessibilityBridge(options = {}) {
  const platform = options.platform || process.platform;
  const authorizer =
    options.authorizer || createDirectionEpochAuthorizer({ now: options.now });
  const runner =
    options.runner ||
    ((file, args, opts) => runProcess(file, args, { ...opts, platform }));

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
      const script = buildWinReadTreeScript({
        bundleId: check.bundleId,
        maxNodes: request.maxNodes,
      });
      const res = await runner(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
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

  return {
    authorizer,
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
  createDirectionEpochAuthorizer,
  buildWinReadTreeScript,
  buildWinActionScript,
  buildMacReadTreeScript,
  buildMacActionScript,
  createAccessibilityBridge,
};
