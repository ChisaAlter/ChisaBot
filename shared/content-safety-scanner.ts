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

const STRIP_INVISIBLE_RE =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/g;
const COLLAPSE_SPACE_RE = /\s+/g;
const LINE_CONTINUATION_RE = /\\\r?\n[ \t]*/g;
const CLI_FLAG_LINE_RE = /^\s+--?[A-Za-z]/;
const DOUBLE_NEWLINE_RE = /\r?\n\s*\r?\n/;

const SYSTEM_BOUNDARY_PATTERNS: readonly RegExp[] = [
  /<\/?\s*untrusted_data(?:\s[^>\r\n]*)?>/i,
  /<\/?\s*(?:system|system_prompt|system-prompt|system_instruction|system-reminder|admin_override|developer_override)\b(?:\s[^>\r\n]*)?>/i,
  /<\|(?:im_start|im_end|system|endoftext|start_header_id|end_header_id)\|>|<<\/?SYS>>/,
];

const JAILBREAK_EN_QUICK_RE =
  /\b(?:ignore|disregard|forget|override|bypass|you\s+are\s+now)\b/i;

const JAILBREAK_EN_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+|everything\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directives?|guidelines?)\b/i,
  /\boverride\s+(?:all\s+|any\s+|your\s+)?(?:system\s+|safety\s+|security\s+)?(?:instructions?|prompts?|rules?|guardrails?|restrictions?)\b/i,
  /\bbypass\s+(?:all\s+|any\s+|your\s+)?(?:safety|security|confirmation|approval|policy)\s+(?:checks?|filters?|guards?|rules?|gates?)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|unrestricted\s+mode|jailbreak(?:en)?)\b/i,
];

const JAILBREAK_ZH_PATTERNS: readonly RegExp[] = [
  /(?:忽略|无视|跳过|覆盖|废除|忘掉)(?:以上|之前|先前|所有|一切|全部|系统|用户|既有|原有|前面|当前)+(?:的)?(?:指令|提示词|规则|限制|安全规则|约束)/,
  /(?:绕过|跳过)(?:所有|一切|全部)?(?:审批|确认|安全检查|安全限制|权限检查)/,
];

// 与原 lookbehind `(?<![A-Za-z0-9_])...(?![A-Za-z0-9_])` 语义严格等价（所有词首尾均为 ASCII 字母），去掉 lookbehind 以启用原生正则 JIT。
const OUTBOUND_SINK_RE =
  /(?:\bfetch\s*\(|\b(?:curl|wget|axios|httpie|ncat|Invoke-WebRequest|Invoke-RestMethod|sendBeacon|webhooks?)\b|\b(?:requests|urllib|https?)\.(?:post|put|patch|get|request)\s*\(|\bWebSocket\b|\bnc\s+(?:-[a-zA-Z]+\s+)*[a-zA-Z0-9.-]+\s+\d+)/i;

// 所有出网检测规则（OUTBOUND_SINK_RE / OUTBOUND_CALL_OPEN_RE / WEBHOOK_OR_HTTP_HEADER_RE）的严格超集预筛。
const OUTBOUND_ANY_HINT_RE =
  /(?:\bfetch\s*\(|curl|wget|webhook|\b(?:axios|httpie|ncat|Invoke-WebRequest|Invoke-RestMethod|sendBeacon|WebSocket)\b|\b(?:requests|urllib|https?)\.(?:post|put|patch|get|request)\s*\(|\bnc\s+)/i;

const OUTBOUND_CALL_OPEN_RE =
  /\b(?:fetch|axios(?:\.[a-z]+)?|sendBeacon|requests\.(?:post|put|patch|get|request)|https?\.(?:request|post|get)|Invoke-WebRequest|Invoke-RestMethod)\s*\(/gi;

const WEBHOOK_OR_HTTP_HEADER_RE = /(?:webhooks?|curl|wget|\bfetch\s*\()/gi;

const SENSITIVE_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\$\{?(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|DATABASE_URL|TEST_DATABASE_URL|POSTGRES_URL|PGPASSWORD|REDIS_URL|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ENCRYPTION_KEY|SESSION_SECRET|AUTH_SECRET|JWT_SECRET|CHISABOT_[A-Z0-9_]*)\}?/,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|DATABASE_URL|TEST_DATABASE_URL|POSTGRES_URL|PGPASSWORD|REDIS_URL|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ENCRYPTION_KEY|SESSION_SECRET|AUTH_SECRET|JWT_SECRET|CHISABOT_[A-Z0-9_]*)\b/,
  /\bprocess\.env\b|\bos\.environ\b|\$\(\s*(?:printenv|env)\b|`(?:printenv|env)\b|\b(?:printenv|env)\s*\||(?:^|[\s"'`=<@(])\/proc\/self\/environ\b|(?:cat\s+[^\n]*\.env\b|--data(?:-(?:binary|urlencode|raw))?\s+@[^\s]*\.env\b|-d\s+@[^\s]*\.env\b)/,
  /(?:^|[\s"'`=:(/[{])sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{8,}\b|(?:^|[\s"'`=:(/[{])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|(?:^|[\s"'`=:(/[{])xox[baprs]-[A-Za-z0-9-]{12,}\b|\bpostgres(?:ql)?:\/\/[^:\s"']+:[^@\s"']+/,
];

function formatCodePointNumber(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

function sanitizeExcerpt(raw: string, maxLen = 80): string {
  const cleaned = raw
    .replace(STRIP_INVISIBLE_RE, "")
    .replace(COLLAPSE_SPACE_RE, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    if (!pattern) continue;
    const match = pattern.exec(text);
    if (match?.[0]) return match[0];
  }
  return null;
}

function hasSensitiveCredential(text: string): boolean {
  for (let i = 0; i < SENSITIVE_CREDENTIAL_PATTERNS.length; i++) {
    const pattern = SENSITIVE_CREDENTIAL_PATTERNS[i];
    if (pattern?.test(text)) return true;
  }
  return false;
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

/**
 * 流式查找第一个包含敏感凭据的出网片段（按行 -> 调用括号 -> Webhook/Header 对象 -> 代码块顺序早停），
 * 与原 collectOutboundSpans + 首命中 break 行为 100% 一致。
 */
function findCredentialExfiltrationSpan(
  text: string,
  hasBackslash: boolean,
): string | null {
  const collapsed = hasBackslash
    ? text.replace(LINE_CONTINUATION_RE, " ")
    : text;

  if (
    !OUTBOUND_ANY_HINT_RE.test(collapsed) &&
    (!hasBackslash || !OUTBOUND_ANY_HINT_RE.test(text))
  ) {
    return null;
  }

  // 若全文不含任何敏感凭据且不存在可能跨行拼接命中的 `.env`，绝不可能触发外带规则。
  if (
    !hasSensitiveCredential(collapsed) &&
    (!hasBackslash || !hasSensitiveCredential(text)) &&
    !collapsed.includes(".env")
  ) {
    return null;
  }

  // 1) 逐行扫描（按游标切片，不预拆全量 lines 数组）
  const collapsedLen = collapsed.length;
  let lineStart = 0;
  while (lineStart <= collapsedLen) {
    const nl = collapsed.indexOf("\n", lineStart);
    const hasNext = nl !== -1;
    const rawEnd = hasNext ? nl : collapsedLen;
    const lineEnd =
      rawEnd > lineStart && collapsed.charCodeAt(rawEnd - 1) === 0x0d
        ? rawEnd - 1
        : rawEnd;
    const line = collapsed.slice(lineStart, lineEnd);

    if (OUTBOUND_SINK_RE.test(line)) {
      let combined = line;
      let nextStart = hasNext ? nl + 1 : collapsedLen + 1;
      while (nextStart <= collapsedLen) {
        const nextNl = collapsed.indexOf("\n", nextStart);
        const nextRawEnd = nextNl !== -1 ? nextNl : collapsedLen;
        const nextLineEnd =
          nextRawEnd > nextStart &&
          collapsed.charCodeAt(nextRawEnd - 1) === 0x0d
            ? nextRawEnd - 1
            : nextRawEnd;
        const nextLine = collapsed.slice(nextStart, nextLineEnd);
        if (CLI_FLAG_LINE_RE.test(nextLine)) {
          combined = `${combined} ${nextLine.trim()}`;
          if (nextNl === -1) break;
          nextStart = nextNl + 1;
        } else {
          break;
        }
      }
      if (hasSensitiveCredential(combined)) return combined;
    }

    if (!hasNext) break;
    lineStart = nl + 1;
  }

  // 2) 出网函数调用括号块
  OUTBOUND_CALL_OPEN_RE.lastIndex = 0;
  let callMatch: RegExpExecArray | null = OUTBOUND_CALL_OPEN_RE.exec(collapsed);
  while (callMatch !== null) {
    const openParen = collapsed.indexOf("(", callMatch.index);
    if (openParen !== -1) {
      const span = scanBalancedBlock(collapsed, openParen, "(", ")");
      if (hasSensitiveCredential(span)) {
        OUTBOUND_CALL_OPEN_RE.lastIndex = 0;
        return span;
      }
    }
    callMatch = OUTBOUND_CALL_OPEN_RE.exec(collapsed);
  }
  OUTBOUND_CALL_OPEN_RE.lastIndex = 0;

  // 3) Webhook / curl / wget / fetch 后跟随的对象字面量
  WEBHOOK_OR_HTTP_HEADER_RE.lastIndex = 0;
  let hookMatch: RegExpExecArray | null =
    WEBHOOK_OR_HTTP_HEADER_RE.exec(collapsed);
  while (hookMatch !== null) {
    const idx = hookMatch.index;
    const lookahead = collapsed.slice(idx, Math.min(collapsedLen, idx + 120));
    const braceOffset = lookahead.indexOf("{");
    if (
      braceOffset !== -1 &&
      !DOUBLE_NEWLINE_RE.test(lookahead.slice(0, braceOffset))
    ) {
      const span = scanBalancedBlock(collapsed, idx + braceOffset, "{", "}");
      if (hasSensitiveCredential(span)) {
        WEBHOOK_OR_HTTP_HEADER_RE.lastIndex = 0;
        return span;
      }
    }
    hookMatch = WEBHOOK_OR_HTTP_HEADER_RE.exec(collapsed);
  }
  WEBHOOK_OR_HTTP_HEADER_RE.lastIndex = 0;

  // 4) Markdown 代码围栏块
  let cursor = 0;
  while (cursor < text.length) {
    const fenceStart = text.indexOf("```", cursor);
    if (fenceStart === -1) break;
    const fenceEnd = text.indexOf("```", fenceStart + 3);
    if (fenceEnd === -1) break;
    const block = text.slice(fenceStart + 3, fenceEnd);
    if (OUTBOUND_SINK_RE.test(block) && hasSensitiveCredential(block)) {
      return block;
    }
    cursor = fenceEnd + 3;
  }

  return null;
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

  // 单遍 charCode 扫描：同步完成 Bidi 控制符、连续零宽字符序列检测，并收集规则预筛信号。
  const len = input.length;
  let bidiCount = 0;
  let bidiUniqueCodes: number[] | null = null;
  let zwRunStart = 0;
  let zwRunLen = 0;
  let bestZwStart = 0;
  let bestZwLen = 0;
  let hasAngleBracket = false;
  let hasBackslash = false;
  let hasZhJailbreakHint = false;

  for (let i = 0; i < len; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x80) {
      if (zwRunLen > 0) {
        if (zwRunLen >= 4 && zwRunLen > bestZwLen) {
          bestZwLen = zwRunLen;
          bestZwStart = zwRunStart;
        }
        zwRunLen = 0;
      }
      if (code === 0x3c) hasAngleBracket = true;
      else if (code === 0x5c) hasBackslash = true;
      continue;
    }

    if (
      (code >= 0x200b && code <= 0x200d) ||
      code === 0x2060 ||
      code === 0xfeff
    ) {
      if (zwRunLen === 0) zwRunStart = i;
      zwRunLen++;
      continue;
    }

    if (zwRunLen > 0) {
      if (zwRunLen >= 4 && zwRunLen > bestZwLen) {
        bestZwLen = zwRunLen;
        bestZwStart = zwRunStart;
      }
      zwRunLen = 0;
    }

    if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      bidiCount++;
      if (bidiUniqueCodes === null) {
        bidiUniqueCodes = [code];
      } else if (
        bidiUniqueCodes.length < 4 &&
        !bidiUniqueCodes.includes(code)
      ) {
        bidiUniqueCodes.push(code);
      }
    } else if (
      code === 0x5ffd || // 忽
      code === 0x65e0 || // 无
      code === 0x8df3 || // 跳
      code === 0x8986 || // 覆
      code === 0x5e9f || // 废
      code === 0x5fd8 || // 忘
      code === 0x7ed5 // 绕
    ) {
      hasZhJailbreakHint = true;
    }
  }
  if (zwRunLen >= 4 && zwRunLen > bestZwLen) {
    bestZwLen = zwRunLen;
    bestZwStart = zwRunStart;
  }

  let hasBlock = false;
  let hasWarn = false;

  if (bidiCount > 0 && bidiUniqueCodes !== null) {
    hasBlock = true;
    findings.push({
      rule: "bidi_trojan_control",
      severity: "block",
      message:
        "检测到双向文本控制符（Bidi override/isolate），可能用于视觉欺骗或隐藏恶意指令。",
      excerpt: `${bidiUniqueCodes.map(formatCodePointNumber).join("、")}（共 ${bidiCount} 处）`,
    });
  }

  if (bestZwLen >= 4) {
    hasBlock = true;
    const zwCodes: number[] = [];
    const end = bestZwStart + bestZwLen;
    for (let i = bestZwStart; i < end && zwCodes.length < 4; i++) {
      const c = input.charCodeAt(i);
      if (!zwCodes.includes(c)) zwCodes.push(c);
    }
    findings.push({
      rule: "invisible_zero_width_sequence",
      severity: "block",
      message:
        "检测到连续 4 个及以上的隐形零宽字符序列，可能用于隐藏恶意指令或绕过内容检查。",
      excerpt: `连续 ${bestZwLen} 个零宽字符（${zwCodes.map(formatCodePointNumber).join("、")}）`,
    });
  }

  if (hasAngleBracket) {
    const boundaryHit = firstMatch(input, SYSTEM_BOUNDARY_PATTERNS);
    if (boundaryHit) {
      hasBlock = true;
      findings.push({
        rule: "system_boundary_spoof",
        severity: "block",
        message:
          "检测到伪造的系统控制标签或不可信数据闭合分隔符（如 </untrusted_data>、<system>），疑似提示词边界偷渡攻击。",
        excerpt: sanitizeExcerpt(boundaryHit),
      });
    }
  }

  const exfilSpan = findCredentialExfiltrationSpan(input, hasBackslash);
  if (exfilSpan !== null) {
    hasBlock = true;
    findings.push({
      rule: "credential_exfiltration",
      severity: "block",
      message:
        "检测到疑似密钥或环境变量外带命令（在网络请求或 Webhook 载荷中携带敏感凭据/环境变量）。",
      excerpt: sanitizeExcerpt(exfilSpan),
    });
  }

  let jailbreakHit: string | null = null;
  if (JAILBREAK_EN_QUICK_RE.test(input)) {
    jailbreakHit = firstMatch(input, JAILBREAK_EN_PATTERNS);
  }
  if (!jailbreakHit && hasZhJailbreakHint) {
    jailbreakHit = firstMatch(input, JAILBREAK_ZH_PATTERNS);
  }
  if (jailbreakHit) {
    hasWarn = true;
    findings.push({
      rule: "prompt_injection_override",
      severity: "warn",
      message:
        "检测到疑似越狱或覆盖既有指令的提示词注入表述，请人工复核内容来源。",
      excerpt: sanitizeExcerpt(jailbreakHit),
    });
  }

  const level: SafetyLevel = hasBlock ? "block" : hasWarn ? "warn" : "clean";
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
