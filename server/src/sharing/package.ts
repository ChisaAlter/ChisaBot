import { createHash } from "node:crypto";
import { scanContentSafety } from "../../../shared/content-safety-scanner";
import {
  type BotSharePackageManifest,
  SHARE_LIMITS,
  SHARE_PACKAGE_SCHEMA_VERSION,
  type ShareBotProfile,
  type ShareMemoryCandidate,
  type ShareMemoryEntry,
  type SharePackageKind,
  type SharePluginDependency,
  type ShareSafetyFinding,
  type ShareScheduleEntry,
  type ShareSkillEntry,
  type ShareSkillFile,
} from "../../../shared/sharing";
import { decodeZip, encodeZip, normalizeZipEntryPath } from "./zip";

/**
 * Bot 配方与多文件技能脱敏打包、强密钥扫描、禁传黑名单与外部技能触发器剥离。
 *
 * 安全红线：
 * 1. 强拦截 .env / .db / .sqlite / .key / .pem / .p12 / credentials* 与高危密钥；
 * 2. 记忆双端默认全空，仅显式逐条勾选才包含；
 * 3. 定时任务导出与导入一律强制 enabled: false；
 * 4. 外部技能导入自动剥离 frontmatter 中的自动触发器与特权声明字段。
 */

export class SharePackageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 422 = 400,
    readonly findings: ShareSafetyFinding[] = [],
  ) {
    super(message);
    this.name = "SharePackageError";
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const TOOL_REF_RE = /^[A-Za-z0-9_.:/-]{1,200}$/;

const FORBIDDEN_FILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/i,
  /\.(?:db|sqlite|sqlite3|sqlite-wal|sqlite-shm)$/i,
  /\.(?:key|pem|p12|pfx|p8|jks|keystore|mobileprovision)$/i,
  /(?:^|\/)credentials?(?:\.[^/]*)?$/i,
  /(?:^|\/)[^/]*credentials[^/]*$/i,
  /(?:^|\/)cookies?(?:\.[^/]*)?\.json$/i,
  /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.pub)?$/i,
  /(?:^|\/)(?:\.npmrc|\.netrc|\.pypirc|secrets?\.(?:json|ya?ml|toml|env))$/i,
];

/** 判断路径是否命中禁传凭据/数据库/私钥文件黑名单。 */
export function isForbiddenShareFilePath(rawPath: string): boolean {
  const normalized = rawPath.replaceAll("\\", "/").trim();
  if (!normalized) return true;
  return FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function redactSecret(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 8) return "***";
  return `${cleaned.slice(0, 4)}…${cleaned.slice(-2)}`;
}

type SecretRule = {
  rule: string;
  message: string;
  pattern: RegExp;
  validate?: (match: RegExpExecArray) => boolean;
};

const PLACEHOLDER_ASSIGN_VALUE_RE =
  /^(?:your[_-]|example[_-]|placeholder|changeme|change[_-]me|replace[_-]|dummy|sample|test[_-]?placeholder|redacted|none|null|undefined|true|false|string|number|\*+|x+|\.+|<[^>]+>|\$\{[^}]+\}|\$[A-Z0-9_]+)$/i;

const SECRET_RULES: readonly SecretRule[] = [
  {
    rule: "secret-pem-private-key",
    message: "检测到 PEM 私钥块，已阻断分享/导入。",
    pattern:
      /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|PGP\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g,
  },
  {
    rule: "secret-anthropic-key",
    message: "检测到 Anthropic API 密钥（sk-ant-），请先移除凭据。",
    pattern: /\bsk-ant-(?:api\d{2}-|admin\d{2}-)?[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    rule: "secret-openai-key",
    message: "检测到 API 密钥（sk-），请先移除凭据。",
    pattern: /\bsk-(?:proj-|live-|test-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    rule: "secret-github-token",
    message: "检测到 GitHub 访问令牌（ghp_/github_pat_ 等），请先移除凭据。",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    rule: "secret-aws-access-key",
    message: "检测到 AWS Access Key ID（AKIA/ASIA 等），请先移除凭据。",
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g,
  },
  {
    rule: "secret-google-api-key",
    message: "检测到 Google API 密钥（AIza），请先移除凭据。",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    rule: "secret-jwt-token",
    message: "检测到 JWT 令牌，请先移除凭据。",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    rule: "secret-platform-token",
    message: "检测到平台密钥/令牌（Slack / apikey_），请先移除凭据。",
    pattern: /\b(?:xox[baprs]-[A-Za-z0-9-]{12,}|apikey_[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    rule: "secret-auth-bearer",
    message: "检测到 Bearer 认证凭据，请先移除凭据。",
    pattern:
      /\b(?:Authorization\s*[:=]\s*)?Bearer\s+([A-Za-z0-9._~+/-]{16,}=*)\b/gi,
    validate: (match) => {
      const token = match[1] ?? "";
      return !PLACEHOLDER_ASSIGN_VALUE_RE.test(token);
    },
  },
  {
    rule: "secret-auth-basic",
    message: "检测到 Basic Auth 认证凭据，请先移除凭据。",
    pattern:
      /\b(Authorization\s*[:=]\s*)?Basic\s+([A-Za-z0-9+/]{12,}={0,2})\b/gi,
    validate: (match) => {
      const hasHeader = Boolean(match[1]);
      const token = match[2] ?? "";
      if (PLACEHOLDER_ASSIGN_VALUE_RE.test(token)) return false;
      if (hasHeader) return true;
      // 独立 Basic <base64> 需验证解码后形如 user:pass，避免误伤 "Basic configuration"
      try {
        const decoded = Buffer.from(token, "base64").toString("utf8");
        return decoded.includes(":") && /^[\x20-\x7e]+$/.test(decoded);
      } catch {
        return false;
      }
    },
  },
  {
    rule: "secret-credential-assignment",
    message:
      "检测到明文密钥/令牌赋值（api_key=/token=/secret= 等），请先移除凭据。",
    pattern:
      /(?:^|[\s,{;"'(])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|webhook[_-]?secret|bearer[_-]?token|token|password|passwd)\s*[:=]\s*["']?([^\s"',;)}\]`]{8,})["']?/gi,
    validate: (match) => {
      const val = match[1] ?? "";
      if (PLACEHOLDER_ASSIGN_VALUE_RE.test(val)) return false;
      if (/^<.*>$/.test(val) || /^\$\{[A-Za-z0-9_.-]+\}?$/.test(val))
        return false;
      if (/^(.)\1{7,}$/.test(val)) return false;
      return true;
    },
  },
  {
    rule: "secret-database-url",
    message: "检测到带账号密码的数据库连接串，请先移除凭据。",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s"']+:[^@\s"']+@/gi,
  },
];

/** 扫描任意文本中的高危凭据与内容安全风险（永不在结果中回显原始明文密钥）。 */
export function scanSecretsInText(
  text: string,
  location?: string,
): ShareSafetyFinding[] {
  if (!text) return [];
  const findings: ShareSafetyFinding[] = [];
  const seenRules = new Set<string>();

  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    let match = rule.pattern.exec(text);
    while (match !== null) {
      if (!rule.validate || rule.validate(match)) {
        const key = `${rule.rule}:${location ?? ""}`;
        if (!seenRules.has(key)) {
          seenRules.add(key);
          findings.push({
            severity: "block",
            rule: rule.rule,
            message: location ? `${location}：${rule.message}` : rule.message,
            ...(location ? { location } : {}),
            excerpt: redactSecret(match[0]),
          });
        }
        break;
      }
      match = rule.pattern.exec(text);
    }
  }

  const safety = scanContentSafety(text);
  for (const finding of safety.findings) {
    const key = `${finding.rule}:${location ?? ""}`;
    if (seenRules.has(key)) continue;
    seenRules.add(key);
    findings.push({
      severity: finding.severity,
      rule: finding.rule,
      message: location ? `${location}：${finding.message}` : finding.message,
      ...(location ? { location } : {}),
      ...(finding.excerpt ? { excerpt: redactSecret(finding.excerpt) } : {}),
    });
  }

  return findings;
}

/** 禁止自动继承的外部技能 frontmatter 触发器/特权/来源字段。 */
const STRIPPED_FRONTMATTER_KEYS = new Set([
  "trigger",
  "triggers",
  "auto_trigger",
  "autotrigger",
  "auto-trigger",
  "on",
  "events",
  "event",
  "schedule",
  "schedules",
  "cron",
  "webhook",
  "webhooks",
  "hook",
  "hooks",
  "privilege",
  "privileges",
  "privileged",
  "permissions",
  "permission",
  "allow_all_tools",
  "allow-all-tools",
  "bypass_approval",
  "bypass-approval",
  "bypass_confirmation",
  "sudo",
  "admin",
  "system_prompt",
  "system-prompt",
  "run_as",
  "run-as",
  "auto_execute",
  "auto-execute",
  "auto_run",
  "auto-run",
  "source",
  "source_url",
  "plugin_id",
  "owner",
  "owner_user_id",
]);

function parseToolListRaw(raw: string): string[] {
  const cleaned = raw.trim().replace(/^\[|\]$/g, "");
  if (!cleaned) return [];
  return cleaned
    .split(/[,\s]+/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item.length > 0 && TOOL_REF_RE.test(item));
}

export type SanitizedImportedSkill = {
  instructions: string;
  requiresTools: string[];
  strippedFrontmatterKeys: string[];
};

/**
 * 外部技能触发器与特权字段剥离：
 * - 解析并移除 frontmatter 头块，仅保留安全 Markdown 正文；
 * - 提取安全的 `requiresTools` / `requires_tools` / `requires-tools` 列表；
 * - 记录被剥离的触发器、特权声明与来源字段作为显式审核元数据。
 */
export function sanitizeImportedSkillContent(
  rawContent: string,
  explicitRequiresTools?: readonly string[],
): SanitizedImportedSkill {
  const normalized = rawContent.replace(/\r\n/g, "\n").trim();
  const stripped = new Set<string>();
  const tools = new Set<string>();

  for (const tool of explicitRequiresTools ?? []) {
    const trimmed = tool.trim();
    if (trimmed && TOOL_REF_RE.test(trimmed)) tools.add(trimmed);
  }

  let body = normalized;
  const fmMatch = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
  if (fmMatch) {
    const fmRaw = fmMatch[1] ?? "";
    const bodyRaw = (fmMatch[2] ?? "").trim();
    const lines = fmRaw.split("\n");
    let currentListKey: string | null = null;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const listItem = /^-\s+(.+)$/.exec(trimmed);
      if (listItem?.[1] && currentListKey) {
        if (
          currentListKey === "requirestools" ||
          currentListKey === "requires_tools" ||
          currentListKey === "requires-tools"
        ) {
          for (const t of parseToolListRaw(listItem[1])) tools.add(t);
        }
        continue;
      }

      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (!kv?.[1]) {
        currentListKey = null;
        continue;
      }
      const key = kv[1];
      const lowerKey = key.toLowerCase();
      const val = (kv[2] ?? "").trim();
      currentListKey = val === "" ? lowerKey : null;

      if (
        lowerKey === "requirestools" ||
        lowerKey === "requires_tools" ||
        lowerKey === "requires-tools"
      ) {
        if (val) {
          for (const t of parseToolListRaw(val)) tools.add(t);
        }
      } else if (STRIPPED_FRONTMATTER_KEYS.has(lowerKey)) {
        stripped.add(key);
      }
    }

    body = bodyRaw;
  }

  return {
    instructions: body.slice(0, 20_000),
    requiresTools: [...tools].slice(0, 100),
    strippedFrontmatterKeys: [...stripped],
  };
}

export function sha256Hex(value: string | Uint8Array | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (SLUG_RE.test(cleaned)) return cleaned;
  return `skill-${sha256Hex(raw).slice(0, 8)}`;
}

function cleanRequiredText(
  value: unknown,
  maxLen: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new SharePackageError(`${label} 必须是文本。`, 400);
  }
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > maxLen) {
    throw new SharePackageError(
      `${label} 为空、含非法空字节或超出长度上限（${maxLen}）。`,
      400,
    );
  }
  return trimmed;
}

function cleanOptionalText(
  value: unknown,
  maxLen: number,
  label: string,
): string | undefined {
  if (value == null || value === "") return undefined;
  return cleanRequiredText(value, maxLen, label);
}

export function normalizeSkillAuxFiles(
  rawFiles: unknown,
  skillSlug: string,
): ShareSkillFile[] {
  if (rawFiles == null) return [];
  if (!Array.isArray(rawFiles)) {
    throw new SharePackageError(`技能「${skillSlug}」辅助文件格式无效。`, 400);
  }
  if (rawFiles.length > SHARE_LIMITS.maxSkillAuxFiles) {
    throw new SharePackageError(
      `技能「${skillSlug}」辅助文件数量超出上限（最多 ${SHARE_LIMITS.maxSkillAuxFiles} 个）。`,
      413,
    );
  }

  const seen = new Set<string>();
  const normalized: ShareSkillFile[] = [];

  for (const item of rawFiles) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SharePackageError(`技能「${skillSlug}」辅助文件项无效。`, 400);
    }
    const record = item as Record<string, unknown>;
    const rawPath = typeof record.path === "string" ? record.path : "";
    const safePath = normalizeZipEntryPath(rawPath);
    if (safePath.toLowerCase() === "skill.md") {
      throw new SharePackageError("辅助文件不能覆盖主文件 SKILL.md。", 400);
    }
    if (isForbiddenShareFilePath(safePath)) {
      throw new SharePackageError(
        `安全拦截：禁止分享或导入敏感文件「${safePath}」。`,
        400,
        [
          {
            severity: "block",
            rule: "forbidden-file-path",
            message: `禁止分享敏感文件：${safePath}`,
            location: `skills/${skillSlug}/${safePath}`,
          },
        ],
      );
    }
    if (seen.has(safePath)) {
      throw new SharePackageError(
        `技能「${skillSlug}」包含重复辅助文件路径：${safePath}`,
        400,
      );
    }
    seen.add(safePath);

    const content =
      typeof record.content === "string"
        ? record.content
        : (() => {
            throw new SharePackageError(
              `辅助文件「${safePath}」正文必须是 UTF-8 文本。`,
              400,
            );
          })();
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > SHARE_LIMITS.maxSkillAuxFileBytes) {
      throw new SharePackageError(
        `辅助文件「${safePath}」超出 256 KiB 单文件上限。`,
        413,
      );
    }
    normalized.push({
      path: safePath,
      content,
      sha256: sha256Hex(content),
      bytes: byteLength,
    });
  }

  return normalized.sort((a, b) => a.path.localeCompare(b.path));
}

/** 扫描整份清单的安全风险（密钥、敏感文件、内容安全）。 */
export function scanManifestSafety(
  manifest: Pick<
    BotSharePackageManifest,
    "bot" | "skills" | "schedules" | "dependencies" | "memories"
  >,
): { findings: ShareSafetyFinding[]; blocked: boolean } {
  const findings: ShareSafetyFinding[] = [];

  if (manifest.bot) {
    findings.push(
      ...scanSecretsInText(manifest.bot.name, "Bot 名称"),
      ...scanSecretsInText(manifest.bot.title, "Bot 标题"),
      ...scanSecretsInText(manifest.bot.roleDescription, "Bot 角色说明"),
    );
  }

  for (const skill of manifest.skills) {
    const label = `技能 /${skill.slug}`;
    findings.push(
      ...scanSecretsInText(skill.title, `${label} 标题`),
      ...scanSecretsInText(skill.summary, `${label} 简介`),
      ...scanSecretsInText(skill.instructions, `${label} 正文`),
    );
    for (const file of skill.files ?? []) {
      if (isForbiddenShareFilePath(file.path)) {
        findings.push({
          severity: "block",
          rule: "forbidden-file-path",
          message: `${label} 包含禁传敏感文件「${file.path}」。`,
          location: `skills/${skill.slug}/${file.path}`,
        });
      }
      findings.push(
        ...scanSecretsInText(file.content, `${label} 辅助文件 ${file.path}`),
      );
    }
  }

  for (const schedule of manifest.schedules) {
    findings.push(
      ...scanSecretsInText(schedule.title, `定时任务「${schedule.title}」`),
      ...scanSecretsInText(
        schedule.instruction,
        `定时任务「${schedule.title}」指令`,
      ),
    );
  }

  for (const dep of manifest.dependencies) {
    findings.push(
      ...scanSecretsInText(dep.name, `依赖插件 ${dep.pluginId}`),
      ...(dep.summary
        ? scanSecretsInText(dep.summary, `依赖插件 ${dep.pluginId}`)
        : []),
    );
  }

  for (let i = 0; i < manifest.memories.length; i++) {
    const memory = manifest.memories[i];
    if (!memory) continue;
    const label = `候选记忆 #${i + 1}`;
    findings.push(
      ...(memory.subject ? scanSecretsInText(memory.subject, label) : []),
      ...scanSecretsInText(memory.content, label),
      ...(memory.context ? scanSecretsInText(memory.context, label) : []),
    );
  }

  return {
    findings,
    blocked: findings.some((f) => f.severity === "block"),
  };
}

/** 根据显式勾选索引过滤候选记忆（默认恒为 []，绝不隐式包含记忆）。 */
export function selectMemoriesByIndices<T>(
  candidates: readonly T[],
  selectedIndices?: readonly number[],
): T[] {
  if (!selectedIndices || selectedIndices.length === 0) return [];
  const chosen = new Set<number>();
  for (const index of selectedIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      throw new SharePackageError(`无效的记忆勾选索引：${String(index)}`, 400);
    }
    chosen.add(index);
  }
  return [...chosen]
    .sort((a, b) => a - b)
    .map((idx) => candidates[idx])
    .filter((item): item is T => item !== undefined);
}

/** 规整并强校验配方包清单（定时任务一律强制 enabled: false，外部技能自动剥离触发器/特权字段）。 */
export function normalizeShareManifest(
  raw: unknown,
  options: { stripSkillFrontmatter?: boolean } = {},
): BotSharePackageManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SharePackageError("配方包清单格式无效。", 400);
  }
  const input = raw as Record<string, unknown>;
  if (input.schemaVersion !== SHARE_PACKAGE_SCHEMA_VERSION) {
    throw new SharePackageError(
      `不支持的配方包版本（schemaVersion=${String(input.schemaVersion)}）。`,
      400,
    );
  }
  const kind: SharePackageKind =
    input.kind === "bot" || input.kind === "skill"
      ? input.kind
      : (() => {
          throw new SharePackageError("配方包类型仅支持 bot 或 skill。", 400);
        })();

  let bot: ShareBotProfile | undefined;
  if (kind === "bot") {
    if (
      !input.bot ||
      typeof input.bot !== "object" ||
      Array.isArray(input.bot)
    ) {
      throw new SharePackageError("Bot 配方包缺少 bot 人设信息。", 400);
    }
    const b = input.bot as Record<string, unknown>;
    const name = cleanRequiredText(b.name, 100, "Bot 名称");
    const title = cleanOptionalText(b.title, 160, "Bot 标题") ?? name;
    const roleDescription =
      cleanOptionalText(b.roleDescription, 30_000, "Bot 角色说明") ?? "";
    const avatarSeed = cleanOptionalText(b.avatarSeed, 120, "Bot 头像种子");
    bot = {
      name,
      title,
      roleDescription,
      ...(avatarSeed ? { avatarSeed } : {}),
    };
  }

  const rawSkills = input.skills ?? [];
  if (!Array.isArray(rawSkills) || rawSkills.length > SHARE_LIMITS.maxSkills) {
    throw new SharePackageError("配方包技能列表无效或超出上限。", 400);
  }
  const seenSkillSlugs = new Set<string>();
  const skills: ShareSkillEntry[] = rawSkills.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SharePackageError("技能条目格式无效。", 400);
    }
    const s = item as Record<string, unknown>;
    const title = cleanRequiredText(s.title ?? s.name, 80, "技能标题");
    const slug = sanitizeSlug(
      typeof s.slug === "string" && s.slug.trim() ? s.slug : title,
    );
    if (seenSkillSlugs.has(slug)) {
      throw new SharePackageError(`配方包存在重复技能 slug：${slug}`, 400);
    }
    seenSkillSlugs.add(slug);
    const summary =
      cleanOptionalText(s.summary ?? s.description, 200, "技能简介") ?? "";
    const rawInstructions = cleanRequiredText(
      s.instructions ?? s.content,
      20_000,
      `技能 ${slug} 正文`,
    );
    const explicitTools = Array.isArray(s.requiresTools)
      ? s.requiresTools.filter((t): t is string => typeof t === "string")
      : [];

    const sanitized =
      options.stripSkillFrontmatter !== false
        ? sanitizeImportedSkillContent(rawInstructions, explicitTools)
        : {
            instructions: rawInstructions,
            requiresTools: [
              ...new Set(explicitTools.filter((t) => TOOL_REF_RE.test(t))),
            ],
            strippedFrontmatterKeys: [],
          };
    if (!sanitized.instructions.trim()) {
      throw new SharePackageError(`技能「${slug}」剥离头信息后正文为空。`, 400);
    }

    const files = normalizeSkillAuxFiles(s.files, slug);
    const priorStripped = Array.isArray(s.strippedFrontmatterKeys)
      ? s.strippedFrontmatterKeys.filter(
          (k): k is string => typeof k === "string",
        )
      : [];
    const strippedFrontmatterKeys = [
      ...new Set([...priorStripped, ...sanitized.strippedFrontmatterKeys]),
    ];

    return {
      slug,
      title,
      summary,
      instructions: sanitized.instructions,
      ...(sanitized.requiresTools.length > 0
        ? { requiresTools: sanitized.requiresTools }
        : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(strippedFrontmatterKeys.length > 0
        ? { strippedFrontmatterKeys }
        : {}),
    };
  });

  if (kind === "skill" && skills.length === 0) {
    throw new SharePackageError("技能包至少需要包含 1 个技能。", 400);
  }

  const rawSchedules = input.schedules ?? [];
  if (
    !Array.isArray(rawSchedules) ||
    rawSchedules.length > SHARE_LIMITS.maxSchedules
  ) {
    throw new SharePackageError("配方包定时任务列表无效或超出上限。", 400);
  }
  // 安全红线：无论源包中 enabled / isEnabled 写什么，一律强制 enabled: false
  const schedules: ShareScheduleEntry[] = rawSchedules.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SharePackageError("定时任务条目格式无效。", 400);
    }
    const r = item as Record<string, unknown>;
    const title = cleanRequiredText(r.title ?? r.name, 80, "定时任务标题");
    const instruction = cleanRequiredText(
      r.instruction ?? r.content,
      4000,
      `定时任务「${title}」说明`,
    );
    const scheduleKind: "cron" | "once" = r.kind === "once" ? "once" : "cron";
    const cron =
      cleanOptionalText(r.cron ?? r.schedule, 120, "cron 表达式") ?? null;
    const timezone = cleanOptionalText(r.timezone, 80, "时区");
    return {
      title,
      instruction,
      kind: scheduleKind,
      ...(cron !== null ? { cron } : {}),
      ...(timezone ? { timezone } : {}),
      enabled: false,
    };
  });

  const rawDeps = input.dependencies ?? [];
  if (!Array.isArray(rawDeps) || rawDeps.length > SHARE_LIMITS.maxPlugins) {
    throw new SharePackageError("配方包插件依赖列表无效或超出上限。", 400);
  }
  const dependencies: SharePluginDependency[] = rawDeps.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SharePackageError("插件依赖项格式无效。", 400);
    }
    const d = item as Record<string, unknown>;
    const pluginId = cleanRequiredText(d.pluginId, 120, "插件 ID");
    const name = cleanOptionalText(d.name, 120, "插件名称") ?? pluginId;
    const vendor = cleanOptionalText(d.vendor, 120, "插件厂商");
    const summary = cleanOptionalText(
      d.summary ?? d.description,
      400,
      "插件简介",
    );
    const tools = Array.isArray(d.tools)
      ? [
          ...new Set(
            d.tools
              .filter((t): t is string => typeof t === "string")
              .map((t) => t.trim())
              .filter((t) => TOOL_REF_RE.test(t)),
          ),
        ].slice(0, 100)
      : [];
    return {
      pluginId,
      name,
      ...(vendor ? { vendor } : {}),
      ...(summary ? { summary } : {}),
      tools,
    };
  });

  const rawMemories = input.memories ?? [];
  if (
    !Array.isArray(rawMemories) ||
    rawMemories.length > SHARE_LIMITS.maxMemories
  ) {
    throw new SharePackageError("配方包记忆列表无效或超出上限。", 400);
  }
  const memories: ShareMemoryEntry[] = rawMemories.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SharePackageError("记忆条目格式无效。", 400);
    }
    const m = item as Record<string, unknown>;
    const memKind = cleanOptionalText(m.kind, 40, "记忆类型") ?? "note";
    const subject = cleanOptionalText(m.subject, 120, "记忆主题") ?? null;
    const content = cleanRequiredText(m.content, 4000, "记忆内容");
    const context = cleanOptionalText(m.context, 400, "记忆情境") ?? null;
    const createdAt = cleanOptionalText(m.createdAt, 40, "记忆时间");
    return {
      kind: memKind,
      ...(subject !== null ? { subject } : {}),
      content,
      ...(context !== null ? { context } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  });

  const exportedAt =
    typeof input.exportedAt === "string" && input.exportedAt.trim()
      ? input.exportedAt.trim().slice(0, 64)
      : new Date().toISOString();

  return {
    schemaVersion: SHARE_PACKAGE_SCHEMA_VERSION,
    kind,
    exportedAt,
    ...(bot ? { bot } : {}),
    skills,
    schedules,
    dependencies,
    memories,
  };
}

/** 计算清单的稳定内容摘要（忽略 exportedAt 时间戳，仅对实际业务资产哈希）。 */
export function computePackageDigest(
  manifest: BotSharePackageManifest,
): string {
  const canonical = {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    bot: manifest.bot ?? null,
    skills: manifest.skills,
    schedules: manifest.schedules,
    dependencies: manifest.dependencies,
    memories: manifest.memories,
  };
  return sha256Hex(JSON.stringify(canonical));
}

type PackedManifestSkillFile = {
  path: string;
  entry: string;
  sha256: string;
  bytes: number;
};

/**
 * 将配方清单打包为有界脱敏 ZIP：
 * - 打包前强制过安全扫描（命中阻断级凭据或禁传文件时直接拒绝）；
 * - 定时任务强制写入 enabled: false；
 * - 多文件技能辅助资源落入 `skills/<slug>/<path>` 并在 package.json 中记录 SHA-256。
 */
export function packSharePackage(rawManifest: BotSharePackageManifest): {
  bytes: Buffer;
  manifest: BotSharePackageManifest;
  digest: string;
} {
  const manifest = normalizeShareManifest(rawManifest, {
    stripSkillFrontmatter: false,
  });
  const safety = scanManifestSafety(manifest);
  if (safety.blocked) {
    const reasons = safety.findings
      .filter((f) => f.severity === "block")
      .map((f) => f.message)
      .join("；");
    throw new SharePackageError(
      `安全拦截：导出包包含敏感凭据或禁传文件，已阻止打包。${reasons}`,
      400,
      safety.findings,
    );
  }

  const zipFiles: Record<string, Buffer | string> = Object.create(null);
  const serializedSkills = manifest.skills.map((skill) => {
    const packedFiles: PackedManifestSkillFile[] = [];
    for (const file of skill.files ?? []) {
      const entryPath = normalizeZipEntryPath(
        `skills/${skill.slug}/${file.path}`,
      );
      const contentBytes = Buffer.from(file.content, "utf8");
      zipFiles[entryPath] = contentBytes;
      packedFiles.push({
        path: file.path,
        entry: entryPath,
        sha256: sha256Hex(contentBytes),
        bytes: contentBytes.length,
      });
    }
    return {
      slug: skill.slug,
      title: skill.title,
      summary: skill.summary,
      instructions: skill.instructions,
      ...(skill.requiresTools && skill.requiresTools.length > 0
        ? { requiresTools: skill.requiresTools }
        : {}),
      ...(packedFiles.length > 0 ? { files: packedFiles } : {}),
    };
  });

  const packageJson = {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    exportedAt: manifest.exportedAt,
    ...(manifest.bot ? { bot: manifest.bot } : {}),
    skills: serializedSkills,
    schedules: manifest.schedules.map((s) => ({
      ...s,
      enabled: false as const,
    })),
    dependencies: manifest.dependencies,
    memories: manifest.memories,
  };

  zipFiles["package.json"] = `${JSON.stringify(packageJson, null, 2)}\n`;
  const bytes = encodeZip(zipFiles);
  const digest = computePackageDigest(manifest);
  return { bytes, manifest, digest };
}

export type UnpackedSharePackage = {
  manifest: BotSharePackageManifest;
  digest: string;
  candidateMemories: ShareMemoryCandidate[];
  safetyFindings: ShareSafetyFinding[];
  blocked: boolean;
};

/**
 * 纯内存解包并全面体检上传的配方 ZIP：
 * - 拒绝禁传文件（.env/.db/.sqlite/.key/.pem/.p12/credentials*）与未登记的隐藏附加文件；
 * - 校验全部辅助文件 SHA-256 与 256 KiB 单文件上限；
 * - 强制将所有定时任务归一化为 enabled: false；
 * - 自动剥离外部技能 frontmatter 中的自动触发器/特权声明字段；
 * - 返回完整安全扫描报告与候选记忆列表（由上层保持默认全不选）。
 */
export function unpackSharePackage(
  zipBytes: Uint8Array | Buffer,
): UnpackedSharePackage {
  const entries = decodeZip(zipBytes);

  // 先对压缩包内所有文件名过一遍禁传黑名单（哪怕藏在未引用路径里也要立即阻断）
  for (const entryPath of Object.keys(entries)) {
    if (isForbiddenShareFilePath(entryPath)) {
      throw new SharePackageError(
        `安全拦截：压缩包包含禁止导入的敏感文件「${entryPath}」。`,
        400,
        [
          {
            severity: "block",
            rule: "forbidden-file-path",
            message: `压缩包包含敏感文件：${entryPath}`,
            location: entryPath,
          },
        ],
      );
    }
  }

  const pkgBytes = entries["package.json"];
  if (!pkgBytes) {
    throw new SharePackageError("压缩包缺少必需的 package.json 清单。", 400);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(pkgBytes.toString("utf8"));
  } catch {
    throw new SharePackageError("package.json 不是合法的 JSON 格式。", 400);
  }
  if (
    !parsedJson ||
    typeof parsedJson !== "object" ||
    Array.isArray(parsedJson)
  ) {
    throw new SharePackageError("package.json 顶层必须是对象。", 400);
  }

  const rawManifest = structuredClone(parsedJson) as Record<string, unknown>;
  const expectedEntries = new Set<string>(["package.json"]);

  // 还原技能多文件辅助资源并强校验 SHA-256
  if (Array.isArray(rawManifest.skills)) {
    rawManifest.skills = rawManifest.skills.map((rawSkill) => {
      if (
        !rawSkill ||
        typeof rawSkill !== "object" ||
        Array.isArray(rawSkill)
      ) {
        throw new SharePackageError("技能清单条目格式无效。", 400);
      }
      const skill = { ...(rawSkill as Record<string, unknown>) };
      const rawTitle =
        typeof skill.title === "string"
          ? skill.title
          : typeof skill.name === "string"
            ? skill.name
            : "skill";
      const slug = sanitizeSlug(
        typeof skill.slug === "string" && skill.slug.trim()
          ? skill.slug
          : rawTitle,
      );
      if (Array.isArray(skill.files)) {
        skill.files = skill.files.map((rawFile) => {
          if (
            !rawFile ||
            typeof rawFile !== "object" ||
            Array.isArray(rawFile)
          ) {
            throw new SharePackageError("技能辅助文件清单项格式无效。", 400);
          }
          const f = rawFile as Record<string, unknown>;
          const relPath = normalizeZipEntryPath(
            typeof f.path === "string" ? f.path : "",
          );
          if (isForbiddenShareFilePath(relPath)) {
            throw new SharePackageError(
              `安全拦截：技能辅助文件「${relPath}」属于禁传敏感文件。`,
              400,
            );
          }
          const expectedEntry = normalizeZipEntryPath(
            `skills/${slug}/${relPath}`,
          );
          if (typeof f.entry === "string" && f.entry !== expectedEntry) {
            throw new SharePackageError(
              `技能辅助文件条目路径不匹配：期望 ${expectedEntry}。`,
              400,
            );
          }
          const fileBuf = entries[expectedEntry];
          if (!fileBuf) {
            throw new SharePackageError(
              `压缩包缺少清单声明的辅助文件：${expectedEntry}`,
              400,
            );
          }
          if (fileBuf.length > SHARE_LIMITS.maxSkillAuxFileBytes) {
            throw new SharePackageError(
              `技能辅助文件「${relPath}」超出 256 KiB 单文件上限。`,
              413,
            );
          }
          if (typeof f.sha256 === "string" && f.sha256 !== sha256Hex(fileBuf)) {
            throw new SharePackageError(
              `技能辅助文件「${relPath}」SHA-256 校验失败。`,
              400,
            );
          }
          expectedEntries.add(expectedEntry);
          return {
            path: relPath,
            content: fileBuf.toString("utf8"),
            sha256: sha256Hex(fileBuf),
            bytes: fileBuf.length,
          };
        });
      }
      return skill;
    });
  }

  // 拒绝压缩包中夹带清单未声明的多余文件
  const unexpected = Object.keys(entries).filter(
    (entryPath) => !expectedEntries.has(entryPath),
  );
  if (unexpected.length > 0) {
    throw new SharePackageError(
      `压缩包包含清单未声明的多余文件：${unexpected.slice(0, 5).join("、")}`,
      400,
    );
  }

  const manifest = normalizeShareManifest(rawManifest, {
    stripSkillFrontmatter: true,
  });
  const safety = scanManifestSafety(manifest);
  const digest = computePackageDigest(manifest);
  const candidateMemories: ShareMemoryCandidate[] = manifest.memories.map(
    (memory, index) => ({
      ...memory,
      index,
    }),
  );

  return {
    manifest,
    digest,
    candidateMemories,
    safetyFindings: safety.findings,
    blocked: safety.blocked,
  };
}
