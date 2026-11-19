"use strict";
/**
 * PC 桌面端环形诊断日志（上限 500 条）与敏感凭据自动脱敏导出器。
 *
 * - 覆盖推送（push）、网络（network）、连接（connection）、桌面桥接（bridge）、本地代理（agent）与系统（system）事件；
 * - 深度脱敏所有 token / cookie / Authorization / X-Device-Token / secret / password / JWT / URL 令牌参数；
 * - 支持原子写入 JSON 排障包（`${dest}.${pid}.${uuid}.tmp` + fsync + rename）。
 */
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MAX_DIAGNOSTIC_ENTRIES = 500;
const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_RE =
  /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?key|session[-_]?id|credential|private[-_]?key)/i;

/** 对任意纯文本中的常见凭据、请求头、Cookie 与 JWT 做原地脱敏。 */
function redactDiagnosticString(input) {
  let text = String(input ?? "");
  if (!text) return text;
  // Authorization / Cookie / X-Device-Token 等 HTTP 头
  text = text.replace(
    /\b(authorization|proxy-authorization|x-device-token|x-api-key|cookie|set-cookie)\s*[:=]\s*([^\r\n;]+)/gi,
    (_m, header) => `${header}: ${REDACTED}`,
  );
  // Bearer / Basic / Token 前缀凭据
  text = text.replace(
    /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{6,}=*/gi,
    (_m, scheme) => `${scheme} ${REDACTED}`,
  );
  // ChisaBot 设备令牌 / 常见云服务 API key / GitHub token
  text = text.replace(
    /\b(?:cbd|sk|pk|ghp|gho|ghu|ghs|xoxb|xoxp)_[A-Za-z0-9_-]{8,}\b/g,
    REDACTED,
  );
  text = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED);
  // 三段式 JWT
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    REDACTED,
  );
  // URL 查询参数中的敏感字段
  text = text.replace(
    /([?&](?:token|access_token|refresh_token|api_key|apikey|secret|cookie|auth|code|sig)=)([^&#\s]+)/gi,
    (_m, prefix) => `${prefix}${REDACTED}`,
  );
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

/** 深度递归脱敏任意诊断详情对象（防止循环引用与敏感键泄漏）。 */
function redactDiagnosticValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactDiagnosticString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 6) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((item) => redactDiagnosticValue(item, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 64)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactDiagnosticValue(v, depth + 1, seen);
      }
    }
    return out;
  }
  return redactDiagnosticString(String(value));
}

function createDiagnosticsRingBuffer(options = {}) {
  const maxEntries = Math.max(
    1,
    Math.min(5000, Number(options.maxEntries) || MAX_DIAGNOSTIC_ENTRIES),
  );
  const now = options.now || Date.now;
  const buffer = [];
  let seq = 0;

  function record({
    category = "system",
    level = "info",
    event = "event",
    message = "",
    detail,
  } = {}) {
    const entry = {
      id: ++seq,
      at: new Date(now()).toISOString(),
      category: String(category || "system").slice(0, 32),
      level: ["debug", "info", "warn", "error"].includes(level)
        ? level
        : "info",
      event: redactDiagnosticString(String(event || "event")).slice(0, 120),
      ...(message ? { message: redactDiagnosticString(String(message)) } : {}),
      ...(detail !== undefined
        ? { detail: redactDiagnosticValue(detail) }
        : {}),
    };
    buffer.push(entry);
    while (buffer.length > maxEntries) buffer.shift();
    return entry;
  }

  function entries() {
    return buffer.map((item) => ({ ...item }));
  }

  function clear() {
    buffer.length = 0;
  }

  function buildExportPayload(meta = {}) {
    const list = entries();
    const byCategory = {};
    for (const item of list) {
      byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    }
    return {
      schemaVersion: 1,
      source: "chisabot-pc",
      exportedAt: new Date(now()).toISOString(),
      redacted: true,
      maxEntries,
      count: list.length,
      byCategory,
      runtime: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        nodeVersion: process.version,
        ...(meta ? redactDiagnosticValue(meta) : {}),
      },
      entries: list,
    };
  }

  async function exportToFile(destPath, meta = {}) {
    const resolved = path.resolve(String(destPath || ""));
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    const tmp = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const payload = buildExportPayload(meta);
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    let handle = null;
    let committed = false;
    try {
      handle = await fsp.open(tmp, "wx", 0o600);
      await handle.writeFile(json, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(tmp, resolved);
      committed = true;
      return { ok: true, path: resolved, count: payload.count };
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!committed) await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  return {
    maxEntries,
    get size() {
      return buffer.length;
    },
    record,
    entries,
    clear,
    buildExportPayload,
    exportToFile,
  };
}

module.exports = {
  MAX_DIAGNOSTIC_ENTRIES,
  REDACTED,
  redactDiagnosticString,
  redactDiagnosticValue,
  createDiagnosticsRingBuffer,
};
