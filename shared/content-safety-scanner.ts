/**
 * 统一内容安全扫描器（纯 TypeScript，供 server / app / shared 共用）。
 *
 * 用于技能入库前校验与外源文本风险识别，拦截双向控制符木马（Trojan Source）、
 * 大段隐形零宽字符隐写、系统边界标签伪造、敏感凭据/环境变量外带命令，以及告警提示词越狱注入。
 */

export type SafetyLevel = "clean" | "warn" | "block";
export type SafetySeverity = "warn" | "block";

export type SafetyFinding = {
  rule: string;
  severity: SafetySeverity;
  message: string;
  excerpt?: string;
};

export type ContentSafetyResult = {
  level: SafetyLevel;
  findings: SafetyFinding[];
};

export type ScanContentSafetyOptions = {
  /** 可选来源标识，仅保留作调用上下文扩展字段。 */
  source?: string;
  /** 可选扫描最大字符上限；默认扫描全文以免尾部载荷被截断逃逸。 */
  maxLength?: number;
};

export type SkillSafetyPayload = {
  slug?: string;
  title?: string;
  summary?: string;
  instructions: string;
};

const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const ZERO_WIDTH_RUN_RE = /[\u200B-\u200D\u2060\uFEFF]{4,}/g;

const SYSTEM_BOUNDARY_PATTERNS: readonly RegExp[] = [
  /<\/?\s*untrusted_data(?:\s[^>\r\n]*)?>/i,
  /<\/?\s*(?:system|system_prompt|system-prompt|system_instruction|system-reminder|admin_override|developer_override)\b(?:\s[^>\r\n]*)?>/i,
  /<\|(?:im_start|im_end|system|endoftext|start_header_id|end_header_id)\|>|<<\/?SYS>>/,
];

const JAILBREAK_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+|everything\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directives?|guidelines?)\b/i,
  /\boverride\s+(?:all\s+|any\s+|your\s+)?(?:system\s+|safety\s+|security\s+)?(?:instructions?|prompts?|rules?|guardrails?|restrictions?)\b/i,
  /\bbypass\s+(?:all\s+|any\s+|your\s+)?(?:safety|security|confirmation|approval|policy)\s+(?:checks?|filters?|guards?|rules?|gates?)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|unrestricted\s+mode|jailbreak(?:en)?)\b/i,
  /(?:忽略|无视|跳过|覆盖|废除|忘掉)(?:以上|之前|先前|所有|一切|全部|系统|用户|既有|原有|前面|当前)+(?:的)?(?:指令|提示词|规则|限制|安全规则|约束)/,
  /(?:绕过|跳过)(?:所有|一切|全部)?(?:审批|确认|安全检查|安全限制|权限检查)/,
];

const OUTBOUND_SINK_RE =
  /(?:\bfetch\s*\(|(?<![A-Za-z0-9_])(?:curl|wget|axios|httpie|ncat|Invoke-WebRequest|Invoke-RestMethod|sendBeacon|webhooks?)(?![A-Za-z0-9_])|\b(?:requests|urllib|https?)\.(?:post|put|patch|get|request)\s*\(|\bWebSocket\b|\bnc\s+(?:-[a-zA-Z]+\s+)*[a-zA-Z0-9.-]+\s+\d+)/i;

const OUTBOUND_CALL_OPEN_RE =
  /\b(?:fetch|axios(?:\.[a-z]+)?|sendBeacon|requests\.(?:post|put|patch|get|request)|https?\.(?:request|post|get)|Invoke-WebRequest|Invoke-RestMethod)\s*\(/gi;

const WEBHOOK_OR_HTTP_HEADER_RE = /(?:webhooks?|curl|wget|\bfetch\s*\()/gi;

const SENSITIVE_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\$\{?(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|DATABASE_URL|TEST_DATABASE_URL|POSTGRES_URL|PGPASSWORD|REDIS_URL|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ENCRYPTION_KEY|SESSION_SECRET|AUTH_SECRET|JWT_SECRET|CHISABOT_[A-Z0-9_]*)\}?/,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|DATABASE_URL|TEST_DATABASE_URL|POSTGRES_URL|PGPASSWORD|REDIS_URL|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ENCRYPTION_KEY|SESSION_SECRET|AUTH_SECRET|JWT_SECRET|CHISABOT_[A-Z0-9_]*)\b/,
  /\bprocess\.env\b|\bos\.environ\b|\$\(\s*(?:printenv|env)\b|`(?:printenv|env)\b|\b(?:printenv|env)\s*\||(?:^|[\s"'`=<@(])\/proc\/self\/environ\b|(?:cat\s+[^\n]*\.env\b|--data(?:-(?:binary|urlencode|raw))?\s+@[^\s]*\.env\b|-d\s+@[^\s]*\.env\b)/,
  /(?:^|[\s"'`=:(/[{])sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{8,}\b|(?:^|[\s"'`=:(/[{])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|(?:^|[\s"'`=:(/[{])xox[baprs]-[A-Za-z0-9-]{12,}\b|\bpostgres(?:ql)?:\/\/[^:\s"']+:[^@\s"']+/,
];

function formatCodePoint(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return "";
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

function sanitizeExcerpt(raw: string, maxLen = 80): string {
  const cleaned = raw
    .replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[0]) return match[0];
  }
  return null;
}

function scanBalancedBlock(
  text: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
  maxChars = 1200,
): string {
  let depth = 0;
  const limit = Math.min(text.length, openIndex + maxChars);
  for (let i = openIndex; i < limit; i++) {
    const ch = text[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth <= 0) return text.slice(openIndex, i + 1);
    }
  }
  return text.slice(openIndex, limit);
}

function collectOutboundSpans(text: string): string[] {
  const spans: string[] = [];
  const collapsed = text.replace(/\\\r?\n[ \t]*/g, " ");
  const lines = collapsed.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!OUTBOUND_SINK_RE.test(line)) continue;
    let combined = line;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (/^\s+--?[A-Za-z]/.test(next)) {
        combined = `${combined} ${next.trim()}`;
      } else {
        break;
      }
    }
    spans.push(combined);
  }

  for (const match of collapsed.matchAll(OUTBOUND_CALL_OPEN_RE)) {
    const idx = match.index;
    if (idx === undefined) continue;
    const openParen = collapsed.indexOf("(", idx);
    if (openParen !== -1) {
      spans.push(scanBalancedBlock(collapsed, openParen, "(", ")"));
    }
  }

  for (const match of collapsed.matchAll(WEBHOOK_OR_HTTP_HEADER_RE)) {
    const idx = match.index;
    if (idx === undefined) continue;
    const lookahead = collapsed.slice(
      idx,
      Math.min(collapsed.length, idx + 120),
    );
    const braceOffset = lookahead.indexOf("{");
    if (
      braceOffset !== -1 &&
      !/\r?\n\s*\r?\n/.test(lookahead.slice(0, braceOffset))
    ) {
      spans.push(scanBalancedBlock(collapsed, idx + braceOffset, "{", "}"));
    }
  }

  let cursor = 0;
  while (cursor < text.length) {
    const fenceStart = text.indexOf("```", cursor);
    if (fenceStart === -1) break;
    const fenceEnd = text.indexOf("```", fenceStart + 3);
    if (fenceEnd === -1) break;
    const block = text.slice(fenceStart + 3, fenceEnd);
    if (OUTBOUND_SINK_RE.test(block)) spans.push(block);
    cursor = fenceEnd + 3;
  }

  return spans;
}

/**
 * 对单段文本执行安全扫描，返回风险等级（clean / warn / block）及命中条目列表。
 */
export function scanContentSafety(
  text: string,
  options?: ScanContentSafetyOptions,
): ContentSafetyResult {
  const input =
    options?.maxLength !== undefined && options.maxLength >= 0
      ? text.slice(0, options.maxLength)
      : text;

  const findings: SafetyFinding[] = [];
  if (!input) return { level: "clean", findings };

  const bidiMatches = input.match(BIDI_CONTROL_RE);
  if (bidiMatches?.length) {
    const codes = [...new Set(bidiMatches.map(formatCodePoint))].slice(0, 4);
    findings.push({
      rule: "bidi_trojan_control",
      severity: "block",
      message:
        "检测到双向文本控制符（Bidi override/isolate），可能用于视觉欺骗或隐藏恶意指令。",
      excerpt: `${codes.join("、")}（共 ${bidiMatches.length} 处）`,
    });
  }

  const zeroWidthMatches = input.match(ZERO_WIDTH_RUN_RE);
  if (zeroWidthMatches?.length) {
    const longest = zeroWidthMatches.reduce(
      (best, cur) => (cur.length > best.length ? cur : best),
      "",
    );
    const codes = [...new Set([...longest].map(formatCodePoint))].slice(0, 4);
    findings.push({
      rule: "invisible_zero_width_sequence",
      severity: "block",
      message:
        "检测到连续 4 个及以上的隐形零宽字符序列，可能用于隐藏恶意指令或绕过内容检查。",
      excerpt: `连续 ${longest.length} 个零宽字符（${codes.join("、")}）`,
    });
  }

  const boundaryHit = firstMatch(input, SYSTEM_BOUNDARY_PATTERNS);
  if (boundaryHit) {
    findings.push({
      rule: "system_boundary_spoof",
      severity: "block",
      message:
        "检测到伪造的系统控制标签或不可信数据闭合分隔符（如 </untrusted_data>、<system>），疑似提示词边界偷渡攻击。",
      excerpt: sanitizeExcerpt(boundaryHit),
    });
  }

  for (const span of collectOutboundSpans(input)) {
    const credHit = firstMatch(span, SENSITIVE_CREDENTIAL_PATTERNS);
    if (credHit) {
      findings.push({
        rule: "credential_exfiltration",
        severity: "block",
        message:
          "检测到疑似密钥或环境变量外带命令（在网络请求或 Webhook 载荷中携带敏感凭据/环境变量）。",
        excerpt: sanitizeExcerpt(span),
      });
      break;
    }
  }

  const jailbreakHit = firstMatch(input, JAILBREAK_PATTERNS);
  if (jailbreakHit) {
    findings.push({
      rule: "prompt_injection_override",
      severity: "warn",
      message:
        "检测到疑似越狱或覆盖既有指令的提示词注入表述，请人工复核内容来源。",
      excerpt: sanitizeExcerpt(jailbreakHit),
    });
  }

  const level: SafetyLevel = findings.some((f) => f.severity === "block")
    ? "block"
    : findings.some((f) => f.severity === "warn")
      ? "warn"
      : "clean";

  return { level, findings };
}

/**
 * 扫描技能载荷（title + summary + instructions），汇总各字段的告警与阻断发现。
 */
export function scanSkillSafety(
  skill: SkillSafetyPayload,
): ContentSafetyResult {
  const fields: Array<[string, string | undefined]> = [
    ["标题", skill.title],
    ["摘要", skill.summary],
    ["说明", skill.instructions],
  ];

  const byRule = new Map<string, SafetyFinding>();
  for (const [label, value] of fields) {
    if (!value) continue;
    const res = scanContentSafety(value, { source: `skill:${label}` });
    for (const finding of res.findings) {
      if (byRule.has(finding.rule)) continue;
      byRule.set(finding.rule, {
        ...finding,
        message: `[${label}] ${finding.message}`,
      });
    }
  }

  const findings = [...byRule.values()];
  const level: SafetyLevel = findings.some((f) => f.severity === "block")
    ? "block"
    : findings.some((f) => f.severity === "warn")
      ? "warn"
      : "clean";

  return { level, findings };
}
