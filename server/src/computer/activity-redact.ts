/**
 * 活动记录入库前的打码（CB-101）。库里不能有明文：密码、secret、URL 里的 token/key/code 参数、命令里像密钥的串。
 *
 * 规则偏保守：宁可多打一处码，也不能把一次登录留在操作记录里。
 */

/** URL query 里需要打码的参数名（小写比较，含子串匹配：access_token、api_key、auth_code…）。 */
const SENSITIVE_PARAM =
  /(token|key|code|secret|password|passwd|pwd|auth|sig|signature|session|credential|ticket|otp|nonce)/i;

export const MASK = "••••";

/** URL 打码：敏感 query 参数值、userinfo、fragment 里的 token 都换成 ••••。不是 URL 时原样返回（再交给 redactText）。 */
export function redactUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return redactText(value);
  }
  if (parsed.username || parsed.password) {
    parsed.username = parsed.username ? MASK : "";
    parsed.password = parsed.password ? MASK : "";
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(name)) parsed.searchParams.set(name, MASK);
  }
  if (parsed.hash && /(token|code|key|secret)=/i.test(parsed.hash)) {
    parsed.hash = parsed.hash.replace(
      /((?:access_|id_|refresh_)?(?:token|code|key|secret)[^=&]*=)[^&]*/gi,
      `$1${MASK}`,
    );
  }
  // URLSearchParams 会把 • 编成 %E2%80%A2，展示时还原。
  return parsed.toString().replaceAll(encodeURIComponent(MASK), MASK);
}

const SECRET_SHAPES: RegExp[] = [
  // Authorization: Bearer xxx / token xxx
  /\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // KEY=value / --password value / -p value 形式
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi,
  /(--(?:password|passwd|token|secret|api-key|apikey|key)[= ])("[^"]*"|'[^']*'|\S+)/gi,
  // 常见密钥前缀
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
];

/** 文本（命令、输出）打码：像密钥的串换成 ••••；其中的 URL 也按 redactUrl 处理。 */
export function redactText(value: string): string {
  let out = value.replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url));
  out = out.replace(
    SECRET_SHAPES[0] as RegExp,
    (_m, scheme: string) => `${scheme} ${MASK}`,
  );
  out = out.replace(
    SECRET_SHAPES[1] as RegExp,
    (_m, name: string) => `${name}=${MASK}`,
  );
  out = out.replace(
    SECRET_SHAPES[2] as RegExp,
    (_m, flag: string) => `${flag}${MASK}`,
  );
  out = out.replace(SECRET_SHAPES[3] as RegExp, MASK);
  return out;
}

const SENSITIVE_FIELD =
  /(密码|口令|验证码|校验码|动态码|卡号|安全码|pin\b|password|passcode|passwd|otp|one[- ]?time|verification|security code|cvv|cvc|card number|secret|token|api key)/i;

/** 机器人往这个元素里输入的文字能不能显示：密码框、验证码、卡号等一律不显示。 */
export function isSensitiveField(
  element: { role?: string; name?: string; type?: string } | undefined,
): boolean {
  if (!element) return false;
  if (element.type && /password|cc-|one-time-code/i.test(element.type))
    return true;
  return SENSITIVE_FIELD.test(`${element.name ?? ""} ${element.role ?? ""}`);
}

/** 没有空格、够长、混了字母数字符号：大概率是口令或 token，不显示。 */
export function looksLikeSecret(text: string): boolean {
  if (text.length < 8 || /\s/.test(text)) return false;
  if (new RegExp((SECRET_SHAPES[3] as RegExp).source).test(text)) return true;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(text),
  ).length;
  return classes >= 3;
}

export function clip(
  value: string,
  max: number,
): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}…`, truncated: true };
}
