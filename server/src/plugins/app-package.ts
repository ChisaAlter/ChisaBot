/**
 * AI 自研微应用 / MCP 插件包：
 * - 单 JSON 包（`chisabot-app/v1`）静态结构与安全校验；
 * - 确定性 `packageDigest`（SHA-256）计算与脱敏导出；
 * - 不可变版本栈持久化（幂等表 `chisabot_app_packages` & `chisabot_app_package_revisions`）；
 * - AES-256-GCM 封存应用配置密钥与 Host 托管 OAuth 令牌；
 * - 严格 Digest 锚定：草稿只入目录不执行，升级生成新 digest 需重新审阅批准后才允许运行。
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  type AppConfigField,
  type AppOAuthSpec,
  type AppPackageDetail,
  type AppPackageFile,
  type AppPackageFilePreview,
  type AppPackageRevisionSummary,
  type AppPackageStatus,
  type AppPackageSummary,
  type AppPackageValidationIssue,
  type AppPackageValidationResult,
  type AppRuntimeSpec,
  type AppSkillEntry,
  CHISABOT_APP_FORMAT,
  type ChisaAppPackage,
  DEFAULT_APP_MEMORY_LIMIT_MB,
  DEFAULT_APP_TIMEOUT_MS,
  type LocalizedText,
  MAX_APP_CONFIG_FIELDS,
  MAX_APP_ICON_BYTES,
  MAX_APP_MEMORY_LIMIT_MB,
  MAX_APP_NETWORK_ORIGINS,
  MAX_APP_PACKAGE_BYTES,
  MAX_APP_PACKAGE_FILES,
  MAX_APP_SINGLE_FILE_BYTES,
  MAX_APP_SKILLS,
  MAX_APP_TIMEOUT_MS,
  MIN_APP_MEMORY_LIMIT_MB,
  MIN_APP_TIMEOUT_MS,
} from "../../../shared/app-packages";
import { guardedFetchResponse } from "../../../shared/net/guarded-fetch";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import { type AuditStore, recordAuditEvent } from "../audit";
import { validateAvatarImage } from "../bot-avatars/validate-image";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";

export const RESERVED_APP_IDS: ReadonlySet<string> = new Set([
  "app-builder",
  "executor",
  "preview",
  "import",
  "export",
  "oauth",
  "callback",
  "admin",
  "system",
  "validate",
]);

const APP_ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CONFIG_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

const RESERVED_ENV_PREFIXES = [
  "NODE_",
  "LD_",
  "DYLD_",
  "BUN_",
  "CHISABOT_",
  "GROKBOT_",
] as const;

const RESERVED_ENV_EXACT: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DATABASE_URL",
  "KEY_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "OAUTH_STATE_SECRET",
]);

const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "cookie",
  "set-cookie",
]);

const RESERVED_OAUTH_PARAMS: ReadonlySet<string> = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

const FORBIDDEN_OAUTH_SECRET_KEYS: ReadonlySet<string> = new Set([
  "clientSecret",
  "client_secret",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
]);

const FORBIDDEN_FILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.git(?:\/|$)/i,
  /(?:^|\/)node_modules(?:\/|$)/i,
  /\.(?:pem|key|p12|pfx|jks|sqlite|sqlite3|db)$/i,
];

const EMBEDDED_SECRET_PATTERNS: readonly { label: string; pattern: RegExp }[] =
  [
    {
      label: "PEM 私钥",
      pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    },
    {
      label: "OpenAI/Anthropic 密钥",
      pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
    },
    {
      label: "GitHub 个人令牌",
      pattern: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
    },
    {
      label: "AWS Access Key",
      pattern: /\bAKIA[0-9A-Z]{16}\b/,
    },
    {
      label: "Google API Key",
      pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    },
  ];

const MAX_CONFIG_VALUE_LENGTH = 16_384;
const MAX_PREVIEW_CHARS = 32_000;
const OAUTH_REFRESH_SKEW_MS = 60_000;

export class AppPackageError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: string;

  constructor(
    message: string,
    status: 400 | 403 | 404 | 409 = 400,
    code = "app_package_error",
  ) {
    super(message);
    this.name = "AppPackageError";
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLocalizedText(
  raw: unknown,
  maxLength: number,
  fieldPath: string,
  issues: AppPackageValidationIssue[],
  fallback?: LocalizedText,
): LocalizedText {
  if (raw === undefined && fallback) return fallback;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > maxLength || /[\0]/.test(trimmed)) {
      issues.push({
        path: fieldPath,
        code: "invalid_text",
        message: `${fieldPath} 必须为 1–${maxLength} 个字符的非空字符串。`,
        severity: "error",
      });
      return { en: "", "zh-CN": "" };
    }
    return { en: trimmed, "zh-CN": trimmed };
  }
  if (isPlainObject(raw)) {
    const enRaw =
      typeof raw.en === "string"
        ? raw.en.trim()
        : typeof raw["zh-CN"] === "string"
          ? raw["zh-CN"].trim()
          : "";
    const zhRaw =
      typeof raw["zh-CN"] === "string"
        ? raw["zh-CN"].trim()
        : typeof raw.en === "string"
          ? raw.en.trim()
          : "";
    if (
      !enRaw ||
      !zhRaw ||
      enRaw.length > maxLength ||
      zhRaw.length > maxLength ||
      /[\0]/.test(enRaw) ||
      /[\0]/.test(zhRaw)
    ) {
      issues.push({
        path: fieldPath,
        code: "invalid_localized_text",
        message: `${fieldPath} 必须提供 1–${maxLength} 字符的 en / zh-CN 文案。`,
        severity: "error",
      });
      return { en: "", "zh-CN": "" };
    }
    return { en: enRaw, "zh-CN": zhRaw };
  }
  issues.push({
    path: fieldPath,
    code: "invalid_text",
    message: `${fieldPath} 必须为字符串或 { en, "zh-CN" } 对象。`,
    severity: "error",
  });
  return { en: "", "zh-CN": "" };
}

/** 校验并规整包内相对 POSIX 路径，严禁 `..`、绝对路径、盘符、反斜杠、控制字符与敏感文件。 */
export function validateSafePackagePath(rawPath: unknown): {
  ok: boolean;
  path?: string;
  reason?: string;
} {
  if (typeof rawPath !== "string") {
    return { ok: false, reason: "文件路径必须是字符串。" };
  }
  if (rawPath.length === 0 || rawPath.length > 240) {
    return { ok: false, reason: "文件路径长度必须在 1–240 字符之间。" };
  }
  // 通过字符编码检查控制字符，避免正则控制字符 lint 告警
  for (let i = 0; i < rawPath.length; i += 1) {
    const code = rawPath.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, reason: "文件路径不能包含控制字符或空字节。" };
    }
  }
  if (rawPath.includes("\\")) {
    return { ok: false, reason: "文件路径必须使用 POSIX 正斜杠 '/'。" };
  }
  if (rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) {
    return { ok: false, reason: "禁止绝对路径或盘符路径。" };
  }
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      return {
        ok: false,
        reason: "路径中禁止包含空段、'.' 或 '..' 目录穿越。",
      };
    }
  }
  const normalized = posix.normalize(rawPath);
  if (
    normalized !== rawPath ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".."
  ) {
    return { ok: false, reason: "文件路径未通过规范化安全校验。" };
  }
  for (const forbidden of FORBIDDEN_FILE_PATTERNS) {
    if (forbidden.test(normalized)) {
      return {
        ok: false,
        reason: `禁止打包敏感或依赖目录文件：${normalized}`,
      };
    }
  }
  return { ok: true, path: normalized };
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

/** 计算确定性 `packageDigest`（SHA-256 十六进制），不受输入字段顺序影响，且不包含任何用户凭据。 */
export function computePackageDigest(
  pkg: Omit<ChisaAppPackage, "packageDigest">,
): string {
  const canonicalPayload = {
    format: pkg.format,
    id: pkg.id,
    version: pkg.version,
    name: pkg.name,
    description: pkg.description,
    publisher: pkg.publisher,
    license: pkg.license,
    ...(pkg.icon ? { icon: pkg.icon } : {}),
    runtime: pkg.runtime,
    files: [...pkg.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({
        path: f.path,
        encoding: f.encoding,
        content: f.content,
      })),
    configSchema: [...pkg.configSchema].sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    ...(pkg.oauth ? { oauth: pkg.oauth } : {}),
    skills: [...pkg.skills].sort((a, b) => a.id.localeCompare(b.id)),
    permissions: {
      network: [...pkg.permissions.network].sort(),
      workspace: pkg.permissions.workspace,
    },
    ...(pkg.dependencies && Object.keys(pkg.dependencies).length > 0
      ? { dependencies: pkg.dependencies }
      : {}),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeValue(canonicalPayload)))
    .digest("hex");
}

function isReservedConfigKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (RESERVED_ENV_EXACT.has(upper)) return true;
  return RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function validateHttpsPublicUrl(
  rawUrl: unknown,
  fieldPath: string,
  issues: AppPackageValidationIssue[],
): string | null {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    issues.push({
      path: fieldPath,
      code: "invalid_url",
      message: `${fieldPath} 必须为有效的 HTTPS 地址。`,
      severity: "error",
    });
    return null;
  }
  const verdict = checkPublicUrl(rawUrl.trim());
  if (!verdict.ok) {
    issues.push({
      path: fieldPath,
      code: "blocked_url",
      message: `${fieldPath} 未通过安全校验：${verdict.reason}`,
      severity: "error",
    });
    return null;
  }
  if (verdict.url.protocol !== "https:") {
    issues.push({
      path: fieldPath,
      code: "https_required",
      message: `${fieldPath} 必须使用 https:// 协议。`,
      severity: "error",
    });
    return null;
  }
  return verdict.url.toString();
}

function checkEmbeddedSecretsInText(
  text: string,
  filePath: string,
  issues: AppPackageValidationIssue[],
): void {
  for (const rule of EMBEDDED_SECRET_PATTERNS) {
    if (rule.pattern.test(text)) {
      issues.push({
        path: `files[${filePath}]`,
        code: "embedded_secret",
        message: `文件 ${filePath} 疑似包含硬编码凭据（${rule.label}），请改为通过 configSchema 或 Host 托管 OAuth 注入。`,
        severity: "error",
      });
    }
  }
}

/** 静态结构与安全校验 `chisabot-app/v1` 单 JSON 应用包；纯函数、无任何副作用或代码执行。 */
export function validateChisaAppPackage(
  raw: unknown,
): AppPackageValidationResult {
  const issues: AppPackageValidationIssue[] = [];
  const warnings: AppPackageValidationIssue[] = [];

  if (!isPlainObject(raw)) {
    return {
      valid: false,
      errors: [
        {
          path: "$",
          code: "invalid_root",
          message: "应用包必须是 JSON 对象。",
          severity: "error",
        },
      ],
      warnings: [],
      totalBytes: 0,
      fileCount: 0,
    };
  }

  if (raw.format !== CHISABOT_APP_FORMAT) {
    issues.push({
      path: "format",
      code: "unsupported_format",
      message: `应用包 format 必须为 "${CHISABOT_APP_FORMAT}"。`,
      severity: "error",
    });
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!APP_ID_RE.test(id)) {
    issues.push({
      path: "id",
      code: "invalid_id",
      message:
        "应用 id 必须为小写字母开头的 2–48 位 slug（仅允许小写字母、数字与连字符）。",
      severity: "error",
    });
  } else if (RESERVED_APP_IDS.has(id)) {
    issues.push({
      path: "id",
      code: "reserved_id",
      message: `应用 id "${id}" 为系统保留名称。`,
      severity: "error",
    });
  }

  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!SEMVER_RE.test(version) || version.length > 64) {
    issues.push({
      path: "version",
      code: "invalid_version",
      message: "version 必须符合语义化版本（例如 1.0.0）。",
      severity: "error",
    });
  }

  const name = normalizeLocalizedText(raw.name, 100, "name", issues);
  const description = normalizeLocalizedText(
    raw.description,
    2000,
    "description",
    issues,
  );

  const publisher =
    typeof raw.publisher === "string" && raw.publisher.trim()
      ? raw.publisher.trim().slice(0, 100)
      : "Community";
  const license =
    typeof raw.license === "string" && raw.license.trim()
      ? raw.license.trim().slice(0, 100)
      : "UNLICENSED";

  // ── 校验 files ──────────────────────────────────────────────────────────
  const normalizedFiles: AppPackageFile[] = [];
  const fileMap = new Map<string, { file: AppPackageFile; buffer: Buffer }>();
  let totalBytes = 0;

  if (!Array.isArray(raw.files)) {
    issues.push({
      path: "files",
      code: "invalid_files",
      message: "files 必须是数组。",
      severity: "error",
    });
  } else {
    if (raw.files.length > MAX_APP_PACKAGE_FILES) {
      issues.push({
        path: "files",
        code: "too_many_files",
        message: `单包文件数不能超过 ${MAX_APP_PACKAGE_FILES} 个。`,
        severity: "error",
      });
    }
    for (let i = 0; i < raw.files.length; i += 1) {
      const item = raw.files[i];
      if (!isPlainObject(item)) {
        issues.push({
          path: `files[${i}]`,
          code: "invalid_file_entry",
          message: "文件条目必须是对象。",
          severity: "error",
        });
        continue;
      }
      const pathCheck = validateSafePackagePath(item.path);
      if (!pathCheck.ok || !pathCheck.path) {
        issues.push({
          path: `files[${i}].path`,
          code: "unsafe_path",
          message: pathCheck.reason ?? "文件路径不安全。",
          severity: "error",
        });
        continue;
      }
      if (fileMap.has(pathCheck.path)) {
        issues.push({
          path: `files[${i}].path`,
          code: "duplicate_path",
          message: `存在重复的文件路径：${pathCheck.path}`,
          severity: "error",
        });
        continue;
      }
      const encoding = item.encoding;
      if (encoding !== "utf8" && encoding !== "base64") {
        issues.push({
          path: `files[${i}].encoding`,
          code: "invalid_encoding",
          message: "文件 encoding 必须为 utf8 或 base64。",
          severity: "error",
        });
        continue;
      }
      if (typeof item.content !== "string") {
        issues.push({
          path: `files[${i}].content`,
          code: "invalid_content",
          message: "文件 content 必须是字符串。",
          severity: "error",
        });
        continue;
      }
      if (
        encoding === "base64" &&
        !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content.replace(/\s+/g, ""))
      ) {
        issues.push({
          path: `files[${i}].content`,
          code: "invalid_base64",
          message: `文件 ${pathCheck.path} 的 base64 内容格式无效。`,
          severity: "error",
        });
        continue;
      }
      const normalizedContent =
        encoding === "base64" ? item.content.replace(/\s+/g, "") : item.content;
      const buf = Buffer.from(normalizedContent, encoding);
      if (buf.length > MAX_APP_SINGLE_FILE_BYTES) {
        issues.push({
          path: `files[${i}]`,
          code: "file_too_large",
          message: `文件 ${pathCheck.path} 超过单文件上限（1 MiB）。`,
          severity: "error",
        });
        continue;
      }
      totalBytes += buf.length;
      if (encoding === "utf8") {
        checkEmbeddedSecretsInText(normalizedContent, pathCheck.path, issues);
      } else {
        // 对 base64 编码的文本/源码文件同样执行硬编码密钥扫描，防止通过 base64 绕过静态检测
        const ext = posix.extname(pathCheck.path).slice(1).toLowerCase();
        const isKnownBinaryImage = [
          "png",
          "jpg",
          "jpeg",
          "webp",
          "gif",
        ].includes(ext);
        if (!isKnownBinaryImage && !buf.includes(0)) {
          checkEmbeddedSecretsInText(
            buf.toString("utf8"),
            pathCheck.path,
            issues,
          );
        }
      }
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const entry: AppPackageFile = {
        path: pathCheck.path,
        encoding,
        content: normalizedContent,
        bytes: buf.length,
        sha256,
      };
      normalizedFiles.push(entry);
      fileMap.set(pathCheck.path, { file: entry, buffer: buf });
    }
  }

  if (totalBytes > MAX_APP_PACKAGE_BYTES) {
    issues.push({
      path: "files",
      code: "package_too_large",
      message: `应用包总大小（${totalBytes} 字节）超过安全上限（${MAX_APP_PACKAGE_BYTES} 字节 / 2 MiB）。`,
      severity: "error",
    });
  }

  // ── 校验 icon ───────────────────────────────────────────────────────────
  let icon: string | undefined;
  if (raw.icon !== undefined) {
    const iconCheck = validateSafePackagePath(raw.icon);
    if (!iconCheck.ok || !iconCheck.path) {
      issues.push({
        path: "icon",
        code: "invalid_icon_path",
        message: iconCheck.reason ?? "图标路径无效。",
        severity: "error",
      });
    } else {
      const ext = posix.extname(iconCheck.path).slice(1).toLowerCase();
      const iconEntry = fileMap.get(iconCheck.path);
      if (ext === "svg" || !["png", "jpg", "jpeg", "webp"].includes(ext)) {
        issues.push({
          path: "icon",
          code: "invalid_icon_type",
          message: "图标仅允许 PNG、JPEG 或 WebP（禁止 SVG）。",
          severity: "error",
        });
      } else if (!iconEntry) {
        issues.push({
          path: "icon",
          code: "missing_icon_file",
          message: `图标文件 ${iconCheck.path} 不存在于 files 中。`,
          severity: "error",
        });
      } else if (iconEntry.buffer.length > MAX_APP_ICON_BYTES) {
        issues.push({
          path: "icon",
          code: "icon_too_large",
          message: `图标文件超过 ${MAX_APP_ICON_BYTES} 字节上限。`,
          severity: "error",
        });
      } else {
        const imgCheck = validateAvatarImage(iconEntry.buffer);
        if (!imgCheck.ok) {
          issues.push({
            path: "icon",
            code: "invalid_icon_bytes",
            message: `图标二进制校验失败：${imgCheck.reason}`,
            severity: "error",
          });
        } else {
          icon = iconCheck.path;
        }
      }
    }
  }

  // ── 校验 runtime ────────────────────────────────────────────────────────
  let normalizedRuntime: AppRuntimeSpec = { kind: "skills-only" };
  const rawRuntime = raw.runtime;
  if (!isPlainObject(rawRuntime) || typeof rawRuntime.kind !== "string") {
    issues.push({
      path: "runtime",
      code: "invalid_runtime",
      message:
        "runtime 必须声明 kind（node-stdio / remote-mcp / skills-only）。",
      severity: "error",
    });
  } else if (rawRuntime.kind === "node-stdio") {
    const entryCheck = validateSafePackagePath(rawRuntime.entry);
    if (!entryCheck.ok || !entryCheck.path) {
      issues.push({
        path: "runtime.entry",
        code: "invalid_entry",
        message: entryCheck.reason ?? "node-stdio 入口路径无效。",
        severity: "error",
      });
    } else if (!/\.m?js$/.test(entryCheck.path)) {
      issues.push({
        path: "runtime.entry",
        code: "invalid_entry_ext",
        message: "node-stdio 入口文件必须以 .mjs 或 .js 结尾。",
        severity: "error",
      });
    } else {
      const entryFile = fileMap.get(entryCheck.path);
      if (entryFile?.file.encoding !== "utf8") {
        issues.push({
          path: "runtime.entry",
          code: "missing_entry",
          message: `入口文件 ${entryCheck.path} 必须在 files 中且采用 utf8 编码。`,
          severity: "error",
        });
      } else {
        const memRaw = rawRuntime.memoryLimitMb;
        const memoryLimitMb =
          memRaw === undefined
            ? DEFAULT_APP_MEMORY_LIMIT_MB
            : typeof memRaw === "number" &&
                Number.isInteger(memRaw) &&
                memRaw >= MIN_APP_MEMORY_LIMIT_MB &&
                memRaw <= MAX_APP_MEMORY_LIMIT_MB
              ? memRaw
              : (() => {
                  issues.push({
                    path: "runtime.memoryLimitMb",
                    code: "invalid_memory_limit",
                    message: `memoryLimitMb 必须为 ${MIN_APP_MEMORY_LIMIT_MB}–${MAX_APP_MEMORY_LIMIT_MB} 之间的整数。`,
                    severity: "error",
                  });
                  return DEFAULT_APP_MEMORY_LIMIT_MB;
                })();
        const timeoutRaw = rawRuntime.timeoutMs;
        const timeoutMs =
          timeoutRaw === undefined
            ? DEFAULT_APP_TIMEOUT_MS
            : typeof timeoutRaw === "number" &&
                Number.isInteger(timeoutRaw) &&
                timeoutRaw >= MIN_APP_TIMEOUT_MS &&
                timeoutRaw <= MAX_APP_TIMEOUT_MS
              ? timeoutRaw
              : (() => {
                  issues.push({
                    path: "runtime.timeoutMs",
                    code: "invalid_timeout",
                    message: `timeoutMs 必须为 ${MIN_APP_TIMEOUT_MS}–${MAX_APP_TIMEOUT_MS} 之间的整数。`,
                    severity: "error",
                  });
                  return DEFAULT_APP_TIMEOUT_MS;
                })();
        normalizedRuntime = {
          kind: "node-stdio",
          entry: entryCheck.path,
          memoryLimitMb,
          timeoutMs,
        };
      }
    }
  } else if (rawRuntime.kind === "remote-mcp") {
    const validatedUrl = validateHttpsPublicUrl(
      rawRuntime.url,
      "runtime.url",
      issues,
    );
    const transport =
      rawRuntime.transport === undefined
        ? "streamable-http"
        : rawRuntime.transport === "auto" ||
            rawRuntime.transport === "streamable-http" ||
            rawRuntime.transport === "sse"
          ? rawRuntime.transport
          : (() => {
              issues.push({
                path: "runtime.transport",
                code: "invalid_transport",
                message:
                  "remote-mcp transport 仅支持 auto、streamable-http 或 sse。",
                severity: "error",
              });
              return "streamable-http" as const;
            })();
    let customHeaders: string[] | undefined;
    if (rawRuntime.customHeaders !== undefined) {
      if (
        !Array.isArray(rawRuntime.customHeaders) ||
        rawRuntime.customHeaders.length > 16
      ) {
        issues.push({
          path: "runtime.customHeaders",
          code: "invalid_custom_headers",
          message: "customHeaders 必须是长度不超过 16 的 Header 名称数组。",
          severity: "error",
        });
      } else {
        const names: string[] = [];
        for (const h of rawRuntime.customHeaders) {
          if (
            typeof h !== "string" ||
            !HEADER_NAME_RE.test(h.trim()) ||
            FORBIDDEN_HEADER_NAMES.has(h.trim().toLowerCase())
          ) {
            issues.push({
              path: "runtime.customHeaders",
              code: "invalid_header_name",
              message: `非法的自定义 Header 名称：${String(h)}`,
              severity: "error",
            });
          } else {
            names.push(h.trim());
          }
        }
        customHeaders = [...new Set(names)];
      }
    }
    normalizedRuntime = {
      kind: "remote-mcp",
      url: validatedUrl ?? "",
      transport,
      ...(customHeaders && customHeaders.length > 0 ? { customHeaders } : {}),
    };
  } else if (rawRuntime.kind === "skills-only") {
    normalizedRuntime = { kind: "skills-only" };
  } else {
    issues.push({
      path: "runtime.kind",
      code: "unsupported_runtime",
      message: `不支持的 runtime.kind：${rawRuntime.kind}`,
      severity: "error",
    });
  }

  // ── 校验 oauth ──────────────────────────────────────────────────────────
  let normalizedOAuth: AppOAuthSpec | undefined;
  if (raw.oauth !== undefined) {
    if (!isPlainObject(raw.oauth)) {
      issues.push({
        path: "oauth",
        code: "invalid_oauth",
        message: "oauth 必须是对象。",
        severity: "error",
      });
    } else {
      for (const key of Object.keys(raw.oauth)) {
        if (FORBIDDEN_OAUTH_SECRET_KEYS.has(key)) {
          issues.push({
            path: `oauth.${key}`,
            code: "oauth_secret_in_package",
            message: `应用包严禁内嵌凭据字段 oauth.${key}，请由用户在安装后通过 Host 托管配置。`,
            severity: "error",
          });
        }
      }
      if (raw.oauth.type === "oauth2") {
        const authorizationUrl = validateHttpsPublicUrl(
          raw.oauth.authorizationUrl,
          "oauth.authorizationUrl",
          issues,
        );
        const tokenUrl = validateHttpsPublicUrl(
          raw.oauth.tokenUrl,
          "oauth.tokenUrl",
          issues,
        );
        const scopesRaw = raw.oauth.scopes ?? [];
        const scopes: string[] = [];
        if (!Array.isArray(scopesRaw) || scopesRaw.length > 32) {
          issues.push({
            path: "oauth.scopes",
            code: "invalid_scopes",
            message: "oauth.scopes 必须是最多 32 项的字符串数组。",
            severity: "error",
          });
        } else {
          for (const scope of scopesRaw) {
            if (
              typeof scope !== "string" ||
              !scope.trim() ||
              scope.length > 200 ||
              /[\s\r\n\0]/.test(scope.trim())
            ) {
              issues.push({
                path: "oauth.scopes",
                code: "invalid_scope",
                message: `非法 OAuth scope：${String(scope)}`,
                severity: "error",
              });
            } else {
              scopes.push(scope.trim());
            }
          }
        }
        let authorizationParams: Record<string, string> | undefined;
        if (raw.oauth.authorizationParams !== undefined) {
          if (!isPlainObject(raw.oauth.authorizationParams)) {
            issues.push({
              path: "oauth.authorizationParams",
              code: "invalid_auth_params",
              message: "oauth.authorizationParams 必须是键值对象。",
              severity: "error",
            });
          } else {
            authorizationParams = {};
            for (const [k, v] of Object.entries(
              raw.oauth.authorizationParams,
            )) {
              if (RESERVED_OAUTH_PARAMS.has(k)) {
                issues.push({
                  path: `oauth.authorizationParams.${k}`,
                  code: "reserved_oauth_param",
                  message: `oauth.authorizationParams 禁止覆盖安全参数 ${k}。`,
                  severity: "error",
                });
              } else if (typeof v !== "string" || v.length > 256) {
                issues.push({
                  path: `oauth.authorizationParams.${k}`,
                  code: "invalid_auth_param_value",
                  message: `oauth.authorizationParams.${k} 必须为不超过 256 字符的字符串。`,
                  severity: "error",
                });
              } else {
                authorizationParams[k] = v;
              }
            }
          }
        }
        const clientId =
          typeof raw.oauth.clientId === "string" && raw.oauth.clientId.trim()
            ? raw.oauth.clientId.trim().slice(0, 256)
            : undefined;
        normalizedOAuth = {
          type: "oauth2",
          authorizationUrl: authorizationUrl ?? "",
          tokenUrl: tokenUrl ?? "",
          scopes: [...new Set(scopes)],
          ...(clientId ? { clientId } : {}),
          ...(authorizationParams && Object.keys(authorizationParams).length > 0
            ? { authorizationParams }
            : {}),
        };
      } else if (raw.oauth.type === "bearer") {
        const headerName =
          typeof raw.oauth.headerName === "string" &&
          raw.oauth.headerName.trim()
            ? raw.oauth.headerName.trim()
            : "Authorization";
        if (
          !HEADER_NAME_RE.test(headerName) ||
          FORBIDDEN_HEADER_NAMES.has(headerName.toLowerCase())
        ) {
          issues.push({
            path: "oauth.headerName",
            code: "invalid_header_name",
            message: `非法的认证 Header 名称：${headerName}`,
            severity: "error",
          });
        } else {
          normalizedOAuth = {
            type: "bearer",
            ...(headerName !== "Authorization" ? { headerName } : {}),
          };
        }
      } else if (raw.oauth.type === "api-key") {
        const headerName =
          typeof raw.oauth.headerName === "string"
            ? raw.oauth.headerName.trim()
            : "";
        if (
          !headerName ||
          !HEADER_NAME_RE.test(headerName) ||
          FORBIDDEN_HEADER_NAMES.has(headerName.toLowerCase())
        ) {
          issues.push({
            path: "oauth.headerName",
            code: "invalid_header_name",
            message: "api-key 认证必须声明合法的 headerName。",
            severity: "error",
          });
        } else {
          normalizedOAuth = { type: "api-key", headerName };
        }
      } else {
        issues.push({
          path: "oauth.type",
          code: "unsupported_oauth_type",
          message: "oauth.type 仅支持 oauth2、bearer 或 api-key。",
          severity: "error",
        });
      }
    }
  }

  // ── 校验 configSchema ───────────────────────────────────────────────────
  const rawConfig = raw.configSchema ?? [];
  const configSchema: AppConfigField[] = [];
  const configKeys = new Set<string>();
  if (!Array.isArray(rawConfig)) {
    issues.push({
      path: "configSchema",
      code: "invalid_config_schema",
      message: "configSchema 必须是数组。",
      severity: "error",
    });
  } else {
    if (rawConfig.length > MAX_APP_CONFIG_FIELDS) {
      issues.push({
        path: "configSchema",
        code: "too_many_config_fields",
        message: `配置项数量不能超过 ${MAX_APP_CONFIG_FIELDS} 个。`,
        severity: "error",
      });
    }
    for (let i = 0; i < rawConfig.length; i += 1) {
      const item = rawConfig[i];
      if (!isPlainObject(item)) {
        issues.push({
          path: `configSchema[${i}]`,
          code: "invalid_config_field",
          message: "配置项必须是对象。",
          severity: "error",
        });
        continue;
      }
      const key = typeof item.key === "string" ? item.key.trim() : "";
      if (!CONFIG_KEY_RE.test(key)) {
        issues.push({
          path: `configSchema[${i}].key`,
          code: "invalid_config_key",
          message: `配置键 "${key}" 必须为大写字母开头的字母/数字/下划线标识。`,
          severity: "error",
        });
        continue;
      }
      if (isReservedConfigKey(key)) {
        issues.push({
          path: `configSchema[${i}].key`,
          code: "reserved_config_key",
          message: `禁止占用宿主/运行时保留环境变量名：${key}`,
          severity: "error",
        });
        continue;
      }
      if (configKeys.has(key)) {
        issues.push({
          path: `configSchema[${i}].key`,
          code: "duplicate_config_key",
          message: `重复的配置键：${key}`,
          severity: "error",
        });
        continue;
      }
      configKeys.add(key);
      const secret = item.secret === true;
      const required = item.required === true;
      const fieldName = normalizeLocalizedText(
        item.name ?? key,
        100,
        `configSchema[${i}].name`,
        issues,
      );
      const fieldDescription =
        item.description !== undefined
          ? normalizeLocalizedText(
              item.description,
              400,
              `configSchema[${i}].description`,
              issues,
            )
          : undefined;
      let defaultValue: string | undefined;
      if (item.defaultValue !== undefined) {
        if (secret) {
          issues.push({
            path: `configSchema[${i}].defaultValue`,
            code: "secret_default_forbidden",
            message: `敏感字段 ${key} 禁止声明 defaultValue。`,
            severity: "error",
          });
        } else if (
          typeof item.defaultValue !== "string" ||
          item.defaultValue.length > 1024 ||
          item.defaultValue.includes("\0")
        ) {
          issues.push({
            path: `configSchema[${i}].defaultValue`,
            code: "invalid_default_value",
            message: `configSchema[${i}].defaultValue 必须为合法短字符串。`,
            severity: "error",
          });
        } else {
          defaultValue = item.defaultValue;
        }
      }
      configSchema.push({
        key,
        name: fieldName,
        ...(fieldDescription ? { description: fieldDescription } : {}),
        secret,
        required,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
      });
    }
  }

  // Host 托管 OAuth2 自动补齐标准配置项，密钥绝不随包导出。
  if (
    normalizedRuntime.kind === "node-stdio" &&
    normalizedOAuth?.type === "oauth2"
  ) {
    const oauthDefaults: AppConfigField[] = [
      {
        key: "OAUTH_CLIENT_ID",
        name: { en: "OAuth Client ID", "zh-CN": "OAuth Client ID" },
        secret: false,
        required: !normalizedOAuth.clientId,
      },
      {
        key: "OAUTH_CLIENT_SECRET",
        name: { en: "OAuth Client Secret", "zh-CN": "OAuth Client Secret" },
        secret: true,
        required: false,
      },
    ];
    for (const field of oauthDefaults) {
      if (!configKeys.has(field.key)) {
        configKeys.add(field.key);
        configSchema.push(field);
      }
    }
  }

  // ── 校验 permissions ────────────────────────────────────────────────────
  const rawPerms = raw.permissions;
  const networkOrigins: string[] = [];
  if (rawPerms !== undefined) {
    if (!isPlainObject(rawPerms)) {
      issues.push({
        path: "permissions",
        code: "invalid_permissions",
        message: "permissions 必须是对象。",
        severity: "error",
      });
    } else {
      if (rawPerms.workspace !== undefined && rawPerms.workspace !== "none") {
        issues.push({
          path: "permissions.workspace",
          code: "invalid_workspace_permission",
          message:
            'permissions.workspace 必须为 "none"（沙箱不共享宿主工作区）。',
          severity: "error",
        });
      }
      const rawNet = rawPerms.network ?? [];
      if (!Array.isArray(rawNet) || rawNet.length > MAX_APP_NETWORK_ORIGINS) {
        issues.push({
          path: "permissions.network",
          code: "invalid_network_permissions",
          message: `permissions.network 必须是最多 ${MAX_APP_NETWORK_ORIGINS} 项的 origin 数组。`,
          severity: "error",
        });
      } else {
        for (let i = 0; i < rawNet.length; i += 1) {
          const validUrl = validateHttpsPublicUrl(
            rawNet[i],
            `permissions.network[${i}]`,
            issues,
          );
          if (validUrl) {
            const parsed = new URL(validUrl);
            if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
              issues.push({
                path: `permissions.network[${i}]`,
                code: "origin_only",
                message: `网络权限必须为精确 origin（不含路径或查询串）：${String(rawNet[i])}`,
                severity: "error",
              });
            } else {
              networkOrigins.push(parsed.origin);
            }
          }
        }
      }
    }
  }

  // ── 校验 skills ─────────────────────────────────────────────────────────
  const rawSkills = raw.skills ?? [];
  const skills: AppSkillEntry[] = [];
  const skillIds = new Set<string>();
  if (!Array.isArray(rawSkills)) {
    issues.push({
      path: "skills",
      code: "invalid_skills",
      message: "skills 必须是数组。",
      severity: "error",
    });
  } else {
    if (rawSkills.length > MAX_APP_SKILLS) {
      issues.push({
        path: "skills",
        code: "too_many_skills",
        message: `捆绑技能数量不能超过 ${MAX_APP_SKILLS} 个。`,
        severity: "error",
      });
    }
    for (let i = 0; i < rawSkills.length; i += 1) {
      const item = rawSkills[i];
      if (!isPlainObject(item)) {
        issues.push({
          path: `skills[${i}]`,
          code: "invalid_skill",
          message: "技能条目必须是对象。",
          severity: "error",
        });
        continue;
      }
      const skillId = typeof item.id === "string" ? item.id.trim() : "";
      if (!APP_ID_RE.test(skillId) || skillIds.has(skillId)) {
        issues.push({
          path: `skills[${i}].id`,
          code: "invalid_skill_id",
          message: `技能 id "${skillId}" 无效或重复。`,
          severity: "error",
        });
        continue;
      }
      const skillPathCheck = validateSafePackagePath(item.path);
      if (
        !skillPathCheck.ok ||
        !skillPathCheck.path ||
        posix.basename(skillPathCheck.path) !== "SKILL.md"
      ) {
        issues.push({
          path: `skills[${i}].path`,
          code: "invalid_skill_path",
          message: "技能路径必须是安全的相对路径且文件名必须为 SKILL.md。",
          severity: "error",
        });
        continue;
      }
      const skillFile = fileMap.get(skillPathCheck.path);
      if (skillFile?.file.encoding !== "utf8") {
        issues.push({
          path: `skills[${i}].path`,
          code: "missing_skill_file",
          message: `技能文件 ${skillPathCheck.path} 必须在 files 中且为 utf8 编码。`,
          severity: "error",
        });
        continue;
      }
      const rawReqTools = item.requiresTools ?? [];
      const requiresTools: string[] = [];
      if (!Array.isArray(rawReqTools) || rawReqTools.length > 100) {
        issues.push({
          path: `skills[${i}].requiresTools`,
          code: "invalid_requires_tools",
          message: "requiresTools 必须是最多 100 项的工具名数组。",
          severity: "error",
        });
      } else {
        for (const toolName of rawReqTools) {
          if (typeof toolName !== "string" || !TOOL_NAME_RE.test(toolName)) {
            issues.push({
              path: `skills[${i}].requiresTools`,
              code: "invalid_tool_name",
              message: `非法的技能依赖工具名：${String(toolName)}`,
              severity: "error",
            });
          } else {
            requiresTools.push(toolName);
          }
        }
      }
      skillIds.add(skillId);
      skills.push({
        id: skillId,
        path: skillPathCheck.path,
        name: normalizeLocalizedText(
          item.name ?? skillId,
          100,
          `skills[${i}].name`,
          issues,
        ),
        description: normalizeLocalizedText(
          item.description ?? description,
          2000,
          `skills[${i}].description`,
          issues,
        ),
        requiresTools: [...new Set(requiresTools)],
      });
    }
  }

  if (normalizedRuntime.kind === "skills-only" && skills.length === 0) {
    issues.push({
      path: "skills",
      code: "empty_skills_only",
      message: "skills-only 类型的应用包必须至少声明 1 个有效技能。",
      severity: "error",
    });
  }

  // ── 校验 dependencies（可选声明，提示运行时不自动 npm install） ────────
  let dependencies: Record<string, string> | undefined;
  if (raw.dependencies !== undefined) {
    if (!isPlainObject(raw.dependencies)) {
      issues.push({
        path: "dependencies",
        code: "invalid_dependencies",
        message: "dependencies 必须是字符串键值对象。",
        severity: "error",
      });
    } else {
      dependencies = {};
      for (const [depName, depVer] of Object.entries(raw.dependencies)) {
        if (typeof depVer !== "string" || depVer.length > 80) {
          issues.push({
            path: `dependencies.${depName}`,
            code: "invalid_dependency_version",
            message: `依赖 ${depName} 版本号无效。`,
            severity: "error",
          });
        } else {
          dependencies[depName] = depVer;
        }
      }
    }
  }

  if (
    normalizedRuntime.kind === "node-stdio" &&
    networkOrigins.length === 0 &&
    normalizedOAuth
  ) {
    warnings.push({
      path: "permissions.network",
      code: "missing_network_declaration",
      message:
        "该应用声明了 OAuth/认证配置但未声明 permissions.network，建议列出实际访问的外部 API origin 以便用户审阅。",
      severity: "warning",
    });
  }

  if (issues.length > 0) {
    return {
      valid: false,
      errors: issues,
      warnings,
      totalBytes,
      fileCount: normalizedFiles.length,
    };
  }

  const basePkg: Omit<ChisaAppPackage, "packageDigest"> = {
    format: CHISABOT_APP_FORMAT,
    id,
    version,
    name,
    description,
    publisher,
    license,
    ...(icon ? { icon } : {}),
    runtime: normalizedRuntime,
    files: [...normalizedFiles].sort((a, b) => a.path.localeCompare(b.path)),
    configSchema,
    ...(normalizedOAuth ? { oauth: normalizedOAuth } : {}),
    skills,
    permissions: {
      network: [...new Set(networkOrigins)].sort(),
      workspace: "none",
    },
    ...(dependencies && Object.keys(dependencies).length > 0
      ? { dependencies }
      : {}),
  };

  const digest = computePackageDigest(basePkg);
  if (
    typeof raw.packageDigest === "string" &&
    raw.packageDigest.trim() &&
    raw.packageDigest.trim().toLowerCase() !== digest
  ) {
    warnings.push({
      path: "packageDigest",
      code: "digest_recomputed",
      message:
        "输入包自带的 packageDigest 与实际内容不一致，已按规范化内容重新计算真实 SHA-256 摘要。",
      severity: "warning",
    });
  }

  const normalized: ChisaAppPackage = {
    ...basePkg,
    packageDigest: digest,
  };

  return {
    valid: true,
    errors: [],
    warnings,
    normalized,
    digest,
    totalBytes,
    fileCount: normalized.files.length,
  };
}

/** 导出脱敏单 JSON 应用包：剥离全部用户凭据、配置值与 OAuth 令牌，并保证摘要精确匹配。 */
export function stripSecretsForExport(pkg: ChisaAppPackage): ChisaAppPackage {
  const sanitizedOAuth: AppOAuthSpec | undefined = pkg.oauth
    ? pkg.oauth.type === "oauth2"
      ? {
          type: "oauth2",
          authorizationUrl: pkg.oauth.authorizationUrl,
          tokenUrl: pkg.oauth.tokenUrl,
          scopes: [...pkg.oauth.scopes],
          ...(pkg.oauth.clientId ? { clientId: pkg.oauth.clientId } : {}),
          ...(pkg.oauth.authorizationParams
            ? { authorizationParams: { ...pkg.oauth.authorizationParams } }
            : {}),
        }
      : pkg.oauth.type === "bearer"
        ? {
            type: "bearer",
            ...(pkg.oauth.headerName
              ? { headerName: pkg.oauth.headerName }
              : {}),
          }
        : {
            type: "api-key",
            headerName: pkg.oauth.headerName,
          }
    : undefined;

  const base: Omit<ChisaAppPackage, "packageDigest"> = {
    format: CHISABOT_APP_FORMAT,
    id: pkg.id,
    version: pkg.version,
    name: { ...pkg.name },
    description: { ...pkg.description },
    publisher: pkg.publisher,
    license: pkg.license,
    ...(pkg.icon ? { icon: pkg.icon } : {}),
    runtime: { ...pkg.runtime },
    files: pkg.files.map((file) => ({
      path: file.path,
      encoding: file.encoding,
      content: file.content,
      ...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
      ...(file.sha256 !== undefined ? { sha256: file.sha256 } : {}),
    })),
    configSchema: pkg.configSchema.map((field) => ({
      key: field.key,
      name: { ...field.name },
      ...(field.description ? { description: { ...field.description } } : {}),
      secret: field.secret,
      required: field.required,
      ...(!field.secret && field.defaultValue !== undefined
        ? { defaultValue: field.defaultValue }
        : {}),
    })),
    ...(sanitizedOAuth ? { oauth: sanitizedOAuth } : {}),
    skills: pkg.skills.map((skill) => ({
      ...skill,
      name: { ...skill.name },
      description: { ...skill.description },
      requiresTools: [...skill.requiresTools],
    })),
    permissions: {
      network: [...pkg.permissions.network],
      workspace: "none",
    },
    ...(pkg.dependencies ? { dependencies: { ...pkg.dependencies } } : {}),
  };

  return {
    ...base,
    packageDigest: computePackageDigest(base),
  };
}

export function extractIconDataUrl(pkg: ChisaAppPackage): string | null {
  if (!pkg.icon) return null;
  const file = pkg.files.find((item) => item.path === pkg.icon);
  if (!file) return null;
  const ext = posix.extname(pkg.icon).slice(1).toLowerCase();
  const mimeExt = ext === "jpg" ? "jpeg" : ext;
  const base64 =
    file.encoding === "base64"
      ? file.content
      : Buffer.from(file.content, "utf8").toString("base64");
  return `data:image/${mimeExt};base64,${base64}`;
}

export function buildFilePreviews(
  pkg: ChisaAppPackage,
): AppPackageFilePreview[] {
  return pkg.files.map((file) => {
    const buf = Buffer.from(file.content, file.encoding);
    const sha256 =
      file.sha256 ?? createHash("sha256").update(buf).digest("hex");
    if (file.encoding !== "utf8") {
      return {
        path: file.path,
        encoding: file.encoding,
        bytes: buf.length,
        sha256,
        preview: null,
        truncated: false,
      };
    }
    const truncated = file.content.length > MAX_PREVIEW_CHARS;
    return {
      path: file.path,
      encoding: file.encoding,
      bytes: buf.length,
      sha256,
      preview: truncated
        ? `${file.content.slice(0, MAX_PREVIEW_CHARS)}\n…（已截断）`
        : file.content,
      truncated,
    };
  });
}

// ── 持久化与不可变版本栈存储 ──────────────────────────────────────────────

export type StoredAppPackageRow = {
  id: string;
  status: AppPackageStatus;
  installed: boolean;
  enabled: boolean;
  currentDigest: string;
  approvedDigest: string | null;
  encryptedConfig: string | null;
  encryptedOAuth: string | null;
  oauthScopes: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredAppRevisionRow = {
  appId: string;
  digest: string;
  version: string;
  packageJson: ChisaAppPackage;
  createdBy: string;
  createdAt: string;
};

export type SealedOAuthTokens = {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string | null;
  scope?: string;
  headerName?: string;
  updatedAt: string;
};

export type AppPackageStorage = {
  ensure(): Promise<void>;
  listApps(): Promise<StoredAppPackageRow[]>;
  getApp(id: string): Promise<StoredAppPackageRow | null>;
  upsertApp(row: StoredAppPackageRow): Promise<void>;
  /** 仅定向更新 OAuth 密文与更新时间，防止刷新期间覆盖并发 disable() 或新草稿提交。 */
  updateOAuthOnly(
    id: string,
    encryptedOAuth: string | null,
    updatedAt: string,
  ): Promise<void>;
  /** 原子写入应用行与不可变版本快照（避免并发读取见到缺少对应 revision 的中间态）。 */
  upsertAppWithRevision(
    row: StoredAppPackageRow,
    revision: StoredAppRevisionRow,
    isUpdate: boolean,
  ): Promise<void>;
  deleteApp(id: string): Promise<boolean>;
  listRevisions(appId: string): Promise<StoredAppRevisionRow[]>;
  getRevision(
    appId: string,
    digest: string,
  ): Promise<StoredAppRevisionRow | null>;
  insertRevisionIfAbsent(revision: StoredAppRevisionRow): Promise<void>;
};

export type AppPackageDatabase = {
  $client: Pick<Database["$client"], "unsafe"> & {
    begin?: Database["$client"]["begin"];
  };
};

type PgAppRow = {
  id: string;
  status: string;
  installed: boolean;
  enabled: boolean;
  current_digest: string;
  approved_digest: string | null;
  encrypted_config: string | null;
  encrypted_oauth: string | null;
  oauth_scopes: unknown;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type PgRevisionRow = {
  app_id: string;
  digest: string;
  version: string;
  package_json: unknown;
  created_by: string;
  created_at: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function parseJsonColumn<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export function createPgAppPackageStorage(
  database: AppPackageDatabase,
): AppPackageStorage {
  const sql = database.$client;

  function mapAppRow(row: PgAppRow): StoredAppPackageRow {
    const status: AppPackageStatus =
      row.status === "installed" || row.status === "disabled"
        ? row.status
        : "draft";
    const scopes = parseJsonColumn<unknown>(row.oauth_scopes);
    return {
      id: row.id,
      status,
      installed: Boolean(row.installed),
      enabled: Boolean(row.enabled),
      currentDigest: row.current_digest,
      approvedDigest: row.approved_digest ?? null,
      encryptedConfig: row.encrypted_config ?? null,
      encryptedOAuth: row.encrypted_oauth ?? null,
      oauthScopes: Array.isArray(scopes)
        ? scopes.filter((item): item is string => typeof item === "string")
        : [],
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  function mapRevisionRow(row: PgRevisionRow): StoredAppRevisionRow {
    return {
      appId: row.app_id,
      digest: row.digest,
      version: row.version,
      packageJson: parseJsonColumn<ChisaAppPackage>(row.package_json),
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
    };
  }

  return {
    async ensure() {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS chisabot_app_packages (
          id text PRIMARY KEY,
          status text NOT NULL DEFAULT 'draft',
          installed boolean NOT NULL DEFAULT false,
          enabled boolean NOT NULL DEFAULT false,
          current_digest text NOT NULL,
          approved_digest text,
          encrypted_config text,
          encrypted_oauth text,
          oauth_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS chisabot_app_package_revisions (
          app_id text NOT NULL REFERENCES chisabot_app_packages(id) ON DELETE CASCADE,
          digest text NOT NULL,
          version text NOT NULL,
          package_json jsonb NOT NULL,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (app_id, digest)
        );
      `);
    },

    async listApps() {
      const rows = await sql.unsafe<PgAppRow[]>(
        `SELECT id, status, installed, enabled, current_digest, approved_digest,
                encrypted_config, encrypted_oauth, oauth_scopes, created_by,
                created_at, updated_at
         FROM chisabot_app_packages
         ORDER BY updated_at DESC, id ASC`,
      );
      return rows.map(mapAppRow);
    },

    async getApp(id) {
      const rows = await sql.unsafe<PgAppRow[]>(
        `SELECT id, status, installed, enabled, current_digest, approved_digest,
                encrypted_config, encrypted_oauth, oauth_scopes, created_by,
                created_at, updated_at
         FROM chisabot_app_packages
         WHERE id = $1`,
        [id],
      );
      return rows[0] ? mapAppRow(rows[0]) : null;
    },

    async upsertApp(row) {
      await sql.unsafe(
        `INSERT INTO chisabot_app_packages (
           id, status, installed, enabled, current_digest, approved_digest,
           encrypted_config, encrypted_oauth, oauth_scopes, created_by,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET
           status = $2,
           installed = $3,
           enabled = $4,
           current_digest = $5,
           approved_digest = $6,
           encrypted_config = $7,
           encrypted_oauth = $8,
           oauth_scopes = $9::jsonb,
           updated_at = $12`,
        [
          row.id,
          row.status,
          row.installed,
          row.enabled,
          row.currentDigest,
          row.approvedDigest,
          row.encryptedConfig,
          row.encryptedOAuth,
          JSON.stringify(row.oauthScopes),
          row.createdBy,
          row.createdAt,
          row.updatedAt,
        ],
      );
    },

    async updateOAuthOnly(id, encryptedOAuth, updatedAt) {
      await sql.unsafe(
        `UPDATE chisabot_app_packages
         SET encrypted_oauth = $2, updated_at = $3
         WHERE id = $1`,
        [id, encryptedOAuth, updatedAt],
      );
    },

    async upsertAppWithRevision(row, revision, isUpdate) {
      const execWithClient = async (
        client: Pick<Database["$client"], "unsafe">,
      ) => {
        const writeApp = () =>
          client.unsafe(
            `INSERT INTO chisabot_app_packages (
               id, status, installed, enabled, current_digest, approved_digest,
               encrypted_config, encrypted_oauth, oauth_scopes, created_by,
               created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
             ON CONFLICT (id) DO UPDATE SET
               status = $2,
               installed = $3,
               enabled = $4,
               current_digest = $5,
               approved_digest = $6,
               encrypted_config = $7,
               encrypted_oauth = $8,
               oauth_scopes = $9::jsonb,
               updated_at = $12`,
            [
              row.id,
              row.status,
              row.installed,
              row.enabled,
              row.currentDigest,
              row.approvedDigest,
              row.encryptedConfig,
              row.encryptedOAuth,
              JSON.stringify(row.oauthScopes),
              row.createdBy,
              row.createdAt,
              row.updatedAt,
            ],
          );
        const writeRevision = () =>
          client.unsafe(
            `INSERT INTO chisabot_app_package_revisions (
               app_id, digest, version, package_json, created_by, created_at
             )
             VALUES ($1, $2, $3, $4::jsonb, $5, $6)
             ON CONFLICT (app_id, digest) DO NOTHING`,
            [
              revision.appId,
              revision.digest,
              revision.version,
              JSON.stringify(revision.packageJson),
              revision.createdBy,
              revision.createdAt,
            ],
          );

        if (isUpdate) {
          await writeRevision();
          await writeApp();
        } else {
          await writeApp();
          await writeRevision();
        }
      };

      if (typeof sql.begin === "function") {
        await sql.begin(async (tx) => {
          await execWithClient(tx);
        });
      } else {
        await execWithClient(sql);
      }
    },

    async deleteApp(id) {
      const rows = await sql.unsafe<{ id: string }[]>(
        `DELETE FROM chisabot_app_packages WHERE id = $1 RETURNING id`,
        [id],
      );
      return rows.length > 0;
    },

    async listRevisions(appId) {
      const rows = await sql.unsafe<PgRevisionRow[]>(
        `SELECT app_id, digest, version, package_json, created_by, created_at
         FROM chisabot_app_package_revisions
         WHERE app_id = $1
         ORDER BY created_at DESC`,
        [appId],
      );
      return rows.map(mapRevisionRow);
    },

    async getRevision(appId, digest) {
      const rows = await sql.unsafe<PgRevisionRow[]>(
        `SELECT app_id, digest, version, package_json, created_by, created_at
         FROM chisabot_app_package_revisions
         WHERE app_id = $1 AND digest = $2`,
        [appId, digest],
      );
      return rows[0] ? mapRevisionRow(rows[0]) : null;
    },

    async insertRevisionIfAbsent(revision) {
      await sql.unsafe(
        `INSERT INTO chisabot_app_package_revisions (
           app_id, digest, version, package_json, created_by, created_at
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (app_id, digest) DO NOTHING`,
        [
          revision.appId,
          revision.digest,
          revision.version,
          JSON.stringify(revision.packageJson),
          revision.createdBy,
          revision.createdAt,
        ],
      );
    },
  };
}

export function createMemoryAppPackageStorage(): AppPackageStorage {
  const apps = new Map<string, StoredAppPackageRow>();
  const revisions = new Map<string, StoredAppRevisionRow[]>();

  const insertRevSync = (revision: StoredAppRevisionRow) => {
    const list = revisions.get(revision.appId) ?? [];
    if (!list.some((item) => item.digest === revision.digest)) {
      list.push({
        ...revision,
        packageJson: stripSecretsForExport(revision.packageJson),
      });
      revisions.set(revision.appId, list);
    }
  };

  return {
    async ensure() {},
    async listApps() {
      return [...apps.values()]
        .map((row) => ({ ...row, oauthScopes: [...row.oauthScopes] }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async getApp(id) {
      const found = apps.get(id);
      return found ? { ...found, oauthScopes: [...found.oauthScopes] } : null;
    },
    async upsertApp(row) {
      apps.set(row.id, { ...row, oauthScopes: [...row.oauthScopes] });
    },
    async updateOAuthOnly(id, encryptedOAuth, updatedAt) {
      const latest = apps.get(id);
      if (!latest) return;
      apps.set(id, {
        ...latest,
        encryptedOAuth,
        updatedAt,
      });
    },
    async upsertAppWithRevision(row, revision) {
      // 内存实现先写入版本快照再切换主行，确保并发读绝不会读到缺少 revision 的草稿
      insertRevSync(revision);
      apps.set(row.id, { ...row, oauthScopes: [...row.oauthScopes] });
    },
    async deleteApp(id) {
      revisions.delete(id);
      return apps.delete(id);
    },
    async listRevisions(appId) {
      return [...(revisions.get(appId) ?? [])].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    },
    async getRevision(appId, digest) {
      return (
        (revisions.get(appId) ?? []).find((rev) => rev.digest === digest) ??
        null
      );
    },
    async insertRevisionIfAbsent(revision) {
      insertRevSync(revision);
    },
  };
}

export type AppRuntimeAuthorizationSnapshot = {
  appId: string;
  digest: string;
  pkg: ChisaAppPackage;
  config: Record<string, string>;
  nonSecretConfig: Record<string, string>;
  authHeaders: Record<string, string>;
  authFingerprint: string;
};

export type AppPackageStoreOptions = {
  storage: AppPackageStorage;
  encryptionKey: string;
  auditStore?: AuditStore;
  now?: () => number;
  /** 可选注入 OAuth2 token 刷新网络层（测试隔离）。 */
  refreshFetch?: (url: string, init: RequestInit) => Promise<Response>;
};

function computeHeadersFingerprint(
  headers: Record<string, string>,
  config: Record<string, string>,
): string {
  const payload = {
    headers: Object.keys(headers)
      .sort()
      .map((k) => [k, headers[k]]),
    config: Object.keys(config)
      .sort()
      .map((k) => [k, config[k]]),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validateHeaderValue(value: string): boolean {
  return !/[\r\n\0]/.test(value) && value.length <= 8192;
}

export function createAppPackageStore(options: AppPackageStoreOptions) {
  const { storage, encryptionKey, auditStore } = options;
  const nowFn = options.now ?? Date.now;

  async function unsealConfig(
    encrypted: string | null,
  ): Promise<Record<string, string>> {
    if (!encrypted) return {};
    try {
      const plain = await decryptSecret(encryptionKey, encrypted);
      const parsed = JSON.parse(plain) as unknown;
      if (!isPlainObject(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  async function unsealOAuth(
    encrypted: string | null,
  ): Promise<SealedOAuthTokens | null> {
    if (!encrypted) return null;
    try {
      const plain = await decryptSecret(encryptionKey, encrypted);
      const parsed = JSON.parse(plain) as unknown;
      return isPlainObject(parsed) ? (parsed as SealedOAuthTokens) : null;
    } catch {
      return null;
    }
  }

  async function audit(
    action: string,
    targetId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!auditStore) return;
    await recordAuditEvent(auditStore, {
      eventType: "configuration.changed",
      targetType: "app_package",
      targetId,
      payload: { action, ...payload },
    }).catch(() => {});
  }

  async function buildSummary(
    row: StoredAppPackageRow,
    revs?: StoredAppRevisionRow[],
  ): Promise<AppPackageSummary> {
    const allRevisions = revs ?? (await storage.listRevisions(row.id));
    const currentRevision =
      allRevisions.find((rev) => rev.digest === row.currentDigest) ??
      allRevisions[0];
    if (!currentRevision) {
      throw new AppPackageError(
        `应用 ${row.id} 缺少对应版本快照。`,
        404,
        "revision_not_found",
      );
    }
    const pkg = currentRevision.packageJson;
    const configValues = await unsealConfig(row.encryptedConfig);
    const oauthState = await unsealOAuth(row.encryptedOAuth);

    const nonSecretValues: Record<string, string> = {};
    const configuredKeys: string[] = [];
    for (const field of pkg.configSchema) {
      const value = configValues[field.key];
      if (value && value.length > 0) {
        configuredKeys.push(field.key);
      }
      if (!field.secret) {
        nonSecretValues[field.key] = value ?? field.defaultValue ?? "";
      }
    }

    const revisionSummaries: AppPackageRevisionSummary[] = allRevisions.map(
      (rev) => ({
        digest: rev.digest,
        version: rev.version,
        createdAt: rev.createdAt,
        createdBy: rev.createdBy,
        runtimeKind: rev.packageJson.runtime.kind,
        fileCount: rev.packageJson.files.length,
      }),
    );

    const needsReview = row.approvedDigest !== row.currentDigest;

    return {
      id: row.id,
      status: row.status,
      installed: row.installed,
      enabled: row.enabled && !needsReview,
      currentDigest: row.currentDigest,
      approvedDigest: row.approvedDigest,
      needsReview,
      version: pkg.version,
      name: pkg.name,
      description: pkg.description,
      publisher: pkg.publisher,
      license: pkg.license,
      runtime: pkg.runtime,
      permissions: pkg.permissions,
      configSchema: pkg.configSchema,
      configuredKeys,
      nonSecretValues,
      ...(pkg.oauth ? { oauth: pkg.oauth } : {}),
      oauthConnected: Boolean(
        oauthState?.accessToken || oauthState?.refreshToken,
      ),
      oauthScopes: row.oauthScopes,
      skills: pkg.skills,
      iconDataUrl: extractIconDataUrl(pkg),
      revisions: revisionSummaries,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
    };
  }

  async function requireAppAndRevision(appId: string, digest?: string) {
    const row = await storage.getApp(appId);
    if (!row) {
      throw new AppPackageError(`应用 "${appId}" 不存在。`, 404, "not_found");
    }
    const targetDigest = digest ?? row.currentDigest;
    const rev = await storage.getRevision(appId, targetDigest);
    if (!rev) {
      throw new AppPackageError(
        `应用 "${appId}" 不存在摘要为 ${targetDigest.slice(0, 12)} 的版本。`,
        404,
        "revision_not_found",
      );
    }
    return { row, rev };
  }

  return {
    async ensure() {
      await storage.ensure();
    },

    validate(raw: unknown): AppPackageValidationResult {
      return validateChisaAppPackage(raw);
    },

    async list(): Promise<AppPackageSummary[]> {
      const rows = await storage.listApps();
      return Promise.all(rows.map((row) => buildSummary(row)));
    },

    async get(appId: string): Promise<AppPackageDetail> {
      const { row, rev } = await requireAppAndRevision(appId);
      const revisions = await storage.listRevisions(appId);
      const summary = await buildSummary(row, revisions);
      const sanitizedPkg = stripSecretsForExport(rev.packageJson);
      return {
        ...summary,
        files: buildFilePreviews(sanitizedPkg),
        package: sanitizedPkg,
      };
    },

    /**
     * 提交草稿或新版到不可变版本栈：
     * - 新应用永远落为 `status: "draft"`, `installed: false`, `enabled: false`, `approvedDigest: null`；
     * - 已有应用严防跨租户覆盖停用：非管理员严禁覆盖他人应用，且严禁覆盖已由管理员安装启用的全站微应用；
     * - 已有应用提交新版绝不自动批准，保留原 `approvedDigest` 并停用待重新审阅（绝不静默执行新版代码！）。
     */
    async submitDraft(
      rawPackage: unknown,
      actorId: string,
      submitOptions?: { isAdmin?: boolean },
    ): Promise<{ summary: AppPackageSummary; isUpdate: boolean }> {
      const check = validateChisaAppPackage(rawPackage);
      if (!check.valid || !check.normalized || !check.digest) {
        throw new AppPackageError(
          check.errors[0]?.message ?? "应用包校验未通过。",
          400,
          "validation_failed",
        );
      }
      const pkg = stripSecretsForExport(check.normalized);
      const nowIso = new Date(nowFn()).toISOString();
      const existing = await storage.getApp(pkg.id);
      const isAdmin = submitOptions?.isAdmin === true;

      if (existing) {
        if (!isAdmin && existing.createdBy !== actorId) {
          throw new AppPackageError(
            `应用 "${pkg.id}" 已由其他成员创建，普通用户无权覆盖。请更换新的应用 ID 或由管理员更新。`,
            403,
            "forbidden_overwrite",
          );
        }
        if (!isAdmin && existing.installed) {
          throw new AppPackageError(
            `应用 "${pkg.id}" 已由管理员审批安装为全站可用，普通用户不能覆盖线上版本（请由管理员审阅升级或更换新的应用 ID）。`,
            403,
            "forbidden_installed_overwrite",
          );
        }

        const revs = await storage.listRevisions(pkg.id);
        const versionConflict = revs.find(
          (rev) =>
            rev.version === pkg.version && rev.digest !== pkg.packageDigest,
        );
        if (versionConflict) {
          throw new AppPackageError(
            `版本 ${pkg.version} 已存在且摘要不同（不可变版本栈禁止覆盖已有版本号，请升级版本号）。`,
            409,
            "immutable_version_conflict",
          );
        }

        const digestChanged = existing.currentDigest !== pkg.packageDigest;
        const nextRow: StoredAppPackageRow = {
          ...existing,
          currentDigest: pkg.packageDigest,
          // 升级产生新摘要时必须停用并要求用户重新审阅批准，严禁静默执行新版。
          enabled: digestChanged ? false : existing.enabled,
          status:
            digestChanged && existing.approvedDigest !== pkg.packageDigest
              ? "draft"
              : existing.status,
          updatedAt: nowIso,
        };
        await storage.upsertAppWithRevision(
          nextRow,
          {
            appId: pkg.id,
            digest: pkg.packageDigest,
            version: pkg.version,
            packageJson: pkg,
            createdBy: actorId,
            createdAt: nowIso,
          },
          true,
        );
        await audit("app_package.draft_submitted", pkg.id, {
          actor: actorId,
          version: pkg.version,
          digest: pkg.packageDigest,
          isUpdate: true,
          needsReview: nextRow.approvedDigest !== nextRow.currentDigest,
        });
        return { summary: await buildSummary(nextRow), isUpdate: true };
      }

      const created: StoredAppPackageRow = {
        id: pkg.id,
        status: "draft",
        installed: false,
        enabled: false,
        currentDigest: pkg.packageDigest,
        approvedDigest: null,
        encryptedConfig: null,
        encryptedOAuth: null,
        oauthScopes: [],
        createdBy: actorId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await storage.upsertAppWithRevision(
        created,
        {
          appId: pkg.id,
          digest: pkg.packageDigest,
          version: pkg.version,
          packageJson: pkg,
          createdBy: actorId,
          createdAt: nowIso,
        },
        false,
      );
      await audit("app_package.draft_submitted", pkg.id, {
        actor: actorId,
        version: pkg.version,
        digest: pkg.packageDigest,
        isUpdate: false,
        status: "draft",
      });
      return { summary: await buildSummary(created), isUpdate: false };
    },

    /**
     * 审阅并批准安装特定 `expectedDigest`：
     * - 强校验 `expectedDigest === currentDigest`（防 TOCTOU）；
     * - 将 `approvedDigest` 锚定到本次审阅的精确 SHA-256 摘要后才置 `installed=true, enabled=true`。
     */
    async installAndApprove(
      appId: string,
      expectedDigest: string,
      actorId: string,
    ): Promise<AppPackageSummary> {
      const { row, rev } = await requireAppAndRevision(appId);
      const cleanDigest = expectedDigest.trim().toLowerCase();
      if (!cleanDigest || cleanDigest !== row.currentDigest) {
        throw new AppPackageError(
          `摘要校验不匹配：当前待审阅版本摘要为 ${row.currentDigest.slice(0, 16)}，请刷新页面重新核对源码与权限声明后再安装。`,
          409,
          "digest_mismatch",
        );
      }

      const nowIso = new Date(nowFn()).toISOString();
      const updated: StoredAppPackageRow = {
        ...row,
        status: "installed",
        installed: true,
        enabled: true,
        approvedDigest: row.currentDigest,
        updatedAt: nowIso,
      };
      await storage.upsertApp(updated);
      await audit("app_package.approved_installed", appId, {
        actor: actorId,
        version: rev.version,
        approvedDigest: row.currentDigest,
      });
      return buildSummary(updated);
    },

    async disable(appId: string, actorId: string): Promise<AppPackageSummary> {
      const { row } = await requireAppAndRevision(appId);
      const nowIso = new Date(nowFn()).toISOString();
      const updated: StoredAppPackageRow = {
        ...row,
        status: "disabled",
        enabled: false,
        updatedAt: nowIso,
      };
      await storage.upsertApp(updated);
      await audit("app_package.disabled", appId, {
        actor: actorId,
        digest: row.currentDigest,
      });
      return buildSummary(updated);
    },

    /** 回滚到历史不可变版本；仅在显式 `approve: true` 时同步锚定 `approvedDigest`。 */
    async rollback(
      appId: string,
      targetDigest: string,
      actorId: string,
      rollbackOptions?: { approve?: boolean },
    ): Promise<AppPackageSummary> {
      const { row, rev } = await requireAppAndRevision(
        appId,
        targetDigest.trim().toLowerCase(),
      );
      const nowIso = new Date(nowFn()).toISOString();
      const approve = rollbackOptions?.approve === true;
      const nextApproved = approve ? rev.digest : row.approvedDigest;
      const matchesApproved = nextApproved === rev.digest;
      const updated: StoredAppPackageRow = {
        ...row,
        currentDigest: rev.digest,
        approvedDigest: nextApproved,
        installed: approve ? true : row.installed,
        enabled: approve ? true : row.enabled && matchesApproved,
        status: approve ? "installed" : matchesApproved ? row.status : "draft",
        updatedAt: nowIso,
      };
      await storage.upsertApp(updated);
      await audit("app_package.rolled_back", appId, {
        actor: actorId,
        fromDigest: row.currentDigest,
        toDigest: rev.digest,
        toVersion: rev.version,
        approved: approve,
      });
      return buildSummary(updated);
    },

    async listRevisions(appId: string): Promise<AppPackageRevisionSummary[]> {
      await requireAppAndRevision(appId);
      const revs = await storage.listRevisions(appId);
      return revs.map((rev) => ({
        digest: rev.digest,
        version: rev.version,
        createdAt: rev.createdAt,
        createdBy: rev.createdBy,
        runtimeKind: rev.packageJson.runtime.kind,
        fileCount: rev.packageJson.files.length,
      }));
    },

    /** 配置应用参数（AES-256-GCM 封存）；未传或空串保留已有密钥，显式 clearKeys 可清除。 */
    async configure(
      appId: string,
      values: Record<string, unknown>,
      actorId: string,
      configureOptions?: { clearKeys?: string[] },
    ): Promise<AppPackageSummary> {
      const { row, rev } = await requireAppAndRevision(appId);
      const allowedFields = new Map(
        rev.packageJson.configSchema.map((field) => [field.key, field]),
      );
      const previous = await unsealConfig(row.encryptedConfig);
      const next: Record<string, string> = { ...previous };

      for (const clearKey of configureOptions?.clearKeys ?? []) {
        if (allowedFields.has(clearKey)) {
          delete next[clearKey];
        }
      }

      for (const [key, rawVal] of Object.entries(values)) {
        const field = allowedFields.get(key);
        if (!field) {
          throw new AppPackageError(
            `未知的应用配置项：${key}`,
            400,
            "unknown_config_key",
          );
        }
        if (typeof rawVal !== "string") {
          throw new AppPackageError(
            `配置项 ${key} 必须是字符串。`,
            400,
            "invalid_config_value",
          );
        }
        if (rawVal.length > MAX_CONFIG_VALUE_LENGTH || rawVal.includes("\0")) {
          throw new AppPackageError(
            `配置项 ${key} 超长或包含非法字符。`,
            400,
            "invalid_config_value",
          );
        }
        if (field.secret && rawVal === "") {
          // 密钥字段留空表示保持原有密文，清除必须显式传 clearKeys
          continue;
        }
        if (rawVal === "") {
          delete next[key];
        } else {
          next[key] = rawVal;
        }
      }

      const encryptedConfig = await encryptSecret(
        encryptionKey,
        JSON.stringify(next),
      );
      const nowIso = new Date(nowFn()).toISOString();
      const updated: StoredAppPackageRow = {
        ...row,
        encryptedConfig,
        updatedAt: nowIso,
      };
      await storage.upsertApp(updated);
      await audit("app_package.config_updated", appId, {
        actor: actorId,
        configuredKeys: Object.keys(next),
      });
      return buildSummary(updated);
    },

    /** 写入或更新 Host 托管 OAuth / 认证令牌（AES-256-GCM 封存）。 */
    async setOAuthTokens(
      appId: string,
      input: {
        accessToken?: string;
        refreshToken?: string;
        tokenType?: string;
        expiresAt?: string | null;
        scope?: string;
        headerName?: string;
      },
      actorId: string,
    ): Promise<AppPackageSummary> {
      const { row } = await requireAppAndRevision(appId);
      const prev = await unsealOAuth(row.encryptedOAuth);
      const nowIso = new Date(nowFn()).toISOString();
      const next: SealedOAuthTokens = {
        accessToken:
          input.accessToken !== undefined
            ? input.accessToken.trim() || undefined
            : prev?.accessToken,
        refreshToken:
          input.refreshToken !== undefined
            ? input.refreshToken.trim() || undefined
            : prev?.refreshToken,
        tokenType:
          input.tokenType !== undefined
            ? input.tokenType.trim() || "Bearer"
            : (prev?.tokenType ?? "Bearer"),
        expiresAt:
          input.expiresAt !== undefined
            ? input.expiresAt
            : (prev?.expiresAt ?? null),
        scope: input.scope !== undefined ? input.scope.trim() : prev?.scope,
        headerName:
          input.headerName !== undefined
            ? input.headerName.trim() || undefined
            : prev?.headerName,
        updatedAt: nowIso,
      };

      if (next.accessToken && !validateHeaderValue(next.accessToken)) {
        throw new AppPackageError("OAuth accessToken 包含非法字符。", 400);
      }
      if (
        next.headerName &&
        (!HEADER_NAME_RE.test(next.headerName) ||
          FORBIDDEN_HEADER_NAMES.has(next.headerName.toLowerCase()))
      ) {
        throw new AppPackageError("非法的认证 Header 名称。", 400);
      }

      const encryptedOAuth = await encryptSecret(
        encryptionKey,
        JSON.stringify(next),
      );
      const scopes = next.scope
        ? next.scope
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : row.oauthScopes;

      const updated: StoredAppPackageRow = {
        ...row,
        encryptedOAuth,
        oauthScopes: scopes,
        updatedAt: nowIso,
      };
      await storage.upsertApp(updated);
      await audit("app_package.oauth_updated", appId, {
        actor: actorId,
        hasAccessToken: Boolean(next.accessToken),
        hasRefreshToken: Boolean(next.refreshToken),
      });
      return buildSummary(updated);
    },

    async clearOAuthTokens(
      appId: string,
      actorId: string,
    ): Promise<AppPackageSummary> {
      const { row } = await requireAppAndRevision(appId);
      const nowIso = new Date(nowFn()).toISOString();
      const updated: StoredAppPackageRow = {
        ...row,
        encryptedOAuth: null,
        oauthScopes: [],
        updatedAt: nowIso,
      };
      await storage.upsertApp(updated);
      await audit("app_package.oauth_cleared", appId, { actor: actorId });
      return buildSummary(updated);
    },

    /** 仅供服务端 Host 托管 OAuth2 首次换码流程读取已加密封存的 OAUTH_CLIENT_SECRET（绝不暴露给前端）。 */
    async getOAuthClientSecret(appId: string): Promise<string | undefined> {
      const row = await storage.getApp(appId);
      if (!row?.encryptedConfig) return undefined;
      const configValues = await unsealConfig(row.encryptedConfig);
      const secret = configValues.OAUTH_CLIENT_SECRET?.trim();
      return secret || undefined;
    },

    /** 解析 Host 托管的认证请求头，并在 OAuth2 令牌即将过期时自动刷新后重新 AES-256-GCM 封存。 */
    async resolveAuthHeaders(appId: string): Promise<{
      headers: Record<string, string>;
      refreshed: boolean;
    }> {
      const { row, rev } = await requireAppAndRevision(appId);
      const pkg = rev.packageJson;
      const oauthSpec = pkg.oauth;
      if (!oauthSpec) return { headers: {}, refreshed: false };

      let tokenState = await unsealOAuth(row.encryptedOAuth);
      if (!tokenState) return { headers: {}, refreshed: false };

      let refreshed = false;
      if (
        oauthSpec.type === "oauth2" &&
        tokenState.refreshToken &&
        tokenState.expiresAt &&
        Date.parse(tokenState.expiresAt) <= nowFn() + OAUTH_REFRESH_SKEW_MS
      ) {
        const configValues = await unsealConfig(row.encryptedConfig);
        const clientId =
          configValues.OAUTH_CLIENT_ID || oauthSpec.clientId || "";
        const clientSecret = configValues.OAUTH_CLIENT_SECRET || "";
        if (clientId) {
          const params = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: tokenState.refreshToken,
            client_id: clientId,
          });
          if (clientSecret) params.set("client_secret", clientSecret);
          const response = options.refreshFetch
            ? await options.refreshFetch(oauthSpec.tokenUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: params.toString(),
              })
            : await guardedFetchResponse(oauthSpec.tokenUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: params.toString(),
                manualRedirect: true,
                maxBytes: 256 * 1024,
                timeoutMs: 15_000,
              });
          if (response.ok) {
            const body = (await response.json().catch(() => null)) as {
              access_token?: unknown;
              refresh_token?: unknown;
              expires_in?: unknown;
              token_type?: unknown;
              scope?: unknown;
            } | null;
            if (
              typeof body?.access_token === "string" &&
              body.access_token.length > 0 &&
              validateHeaderValue(body.access_token)
            ) {
              const expiresIn =
                typeof body.expires_in === "number" &&
                Number.isFinite(body.expires_in) &&
                body.expires_in > 0
                  ? body.expires_in
                  : 3600;
              const nextRefresh =
                typeof body.refresh_token === "string" &&
                body.refresh_token.length > 0 &&
                validateHeaderValue(body.refresh_token)
                  ? body.refresh_token
                  : tokenState.refreshToken;
              const nextTokenType =
                typeof body.token_type === "string" &&
                body.token_type.length > 0 &&
                validateHeaderValue(body.token_type)
                  ? body.token_type
                  : (tokenState.tokenType ?? "Bearer");
              const nowMs = nowFn();
              tokenState = {
                ...tokenState,
                accessToken: body.access_token,
                refreshToken: nextRefresh,
                tokenType: nextTokenType,
                expiresAt: new Date(nowMs + expiresIn * 1000).toISOString(),
                scope:
                  typeof body.scope === "string" && body.scope
                    ? body.scope
                    : tokenState.scope,
                updatedAt: new Date(nowMs).toISOString(),
              };
              const encryptedOAuth = await encryptSecret(
                encryptionKey,
                JSON.stringify(tokenState),
              );
              // 仅定向更新 OAuth 密文与更新时间，绝不拿旧 row 全量 upsertApp（防止覆盖并发 disable() 或新草稿并复活已停用应用）
              await storage.updateOAuthOnly(
                appId,
                encryptedOAuth,
                tokenState.updatedAt,
              );
              refreshed = true;
            }
          }
        }
      }

      if (
        !tokenState.accessToken ||
        !validateHeaderValue(tokenState.accessToken)
      ) {
        return { headers: {}, refreshed };
      }

      if (oauthSpec.type === "api-key") {
        const headerName = tokenState.headerName || oauthSpec.headerName;
        return {
          headers: { [headerName]: tokenState.accessToken },
          refreshed,
        };
      }
      if (oauthSpec.type === "bearer") {
        const headerName =
          tokenState.headerName || oauthSpec.headerName || "Authorization";
        const value =
          headerName.toLowerCase() === "authorization" &&
          !/^(?:bearer|basic)\s+/i.test(tokenState.accessToken)
            ? `Bearer ${tokenState.accessToken}`
            : tokenState.accessToken;
        return { headers: { [headerName]: value }, refreshed };
      }
      const scheme = tokenState.tokenType || "Bearer";
      return {
        headers: {
          Authorization: `${scheme} ${tokenState.accessToken}`,
        },
        refreshed,
      };
    },

    /**
     * 获取可执行运行态快照（强门禁 fail-closed）：
     * 仅当应用已安装、已启用、且 `approvedDigest === currentDigest` 时才放行！
     */
    async getRuntimeSnapshot(
      appId: string,
    ): Promise<AppRuntimeAuthorizationSnapshot> {
      const { row, rev } = await requireAppAndRevision(appId);
      if (!row.installed || !row.enabled) {
        throw new AppPackageError(
          `应用 "${appId}" 当前状态为 ${row.status}，尚未安装或已停用，禁止执行。`,
          403,
          "not_installed",
        );
      }
      if (!row.approvedDigest || row.approvedDigest !== row.currentDigest) {
        throw new AppPackageError(
          `应用 "${appId}" 已更新至新摘要 ${row.currentDigest.slice(0, 12)}，与已批准摘要不匹配，必须经用户重新审阅批准后方可执行。`,
          403,
          "digest_not_approved",
        );
      }
      const pkg = rev.packageJson;
      const rawConfig = await unsealConfig(row.encryptedConfig);
      const config: Record<string, string> = {};
      const nonSecretConfig: Record<string, string> = {};
      for (const field of pkg.configSchema) {
        const val =
          rawConfig[field.key] ??
          (!field.secret ? (field.defaultValue ?? "") : "");
        if (field.required && !val) {
          throw new AppPackageError(
            `应用 "${appId}" 缺少必填配置项：${field.key}`,
            400,
            "missing_required_config",
          );
        }
        if (val) {
          config[field.key] = val;
          if (!field.secret) nonSecretConfig[field.key] = val;
        }
      }
      const { headers: authHeaders } = await this.resolveAuthHeaders(appId);
      const authFingerprint = computeHeadersFingerprint(authHeaders, config);
      return {
        appId: row.id,
        digest: row.approvedDigest,
        pkg,
        config,
        nonSecretConfig,
        authHeaders,
        authFingerprint,
      };
    },

    async exportPackage(
      appId: string,
      digest?: string,
    ): Promise<ChisaAppPackage> {
      const { rev } = await requireAppAndRevision(appId, digest);
      return stripSecretsForExport(rev.packageJson);
    },

    async remove(appId: string, actorId: string): Promise<boolean> {
      const deleted = await storage.deleteApp(appId);
      if (deleted) {
        await audit("app_package.removed", appId, { actor: actorId });
      }
      return deleted;
    },
  };
}

export type AppPackageStore = ReturnType<typeof createAppPackageStore>;
