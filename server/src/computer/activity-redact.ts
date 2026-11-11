/**
 * 活动记录入库前的打码（CB-101）。库里不能有明文：密码、secret、URL 里的 token/key/code 参数、命令里像密钥的串。
 *
 * 规则偏保守：宁可多打一处码，也不能把一次登录留在操作记录里。
 */

/** URL query 里需要打码的参数名（小写比较，含子串匹配：access_token、api_key、auth_code…）。 */
const SENSITIVE_PARAM =
  /(token|key|code|secret|password|passwd|pwd|auth|sig|signature|session|credential|ticket|otp|nonce)/i;

export const MASK = "••••";

/** URL 打码：敏感 query 参数值、userinfo、fragment 里的 token 都换成 ••••。 */
export function redactUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    /*
     * 解析不了（`http://[`、`http://%`）：只过文本打码。这里不能回调 redactText——它会把这个串再
     * 当 URL 送回 redactUrl，两个函数互递归直到爆栈（活动记录 begin 实测 RangeError）。
     */
    return redactPlain(value);
  }
  // 同 redactUserinfo 的策略：有密码时两者都打码；只有用户名时，像令牌才打码。
  if (parsed.password) {
    parsed.username = parsed.username ? MASK : "";
    parsed.password = MASK;
  } else if (parsed.username && userLooksSecret(parsed.username)) {
    parsed.username = MASK;
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

/**
 * 敏感配置名：按「段」匹配，避免 CLIENT_IDLE / TOKENIZER / KEYBOARD / MAX_TOKENS / CACHE_KEY_PREFIX 被误打。
 * 命中：…_TOKEN / …_SECRET / …_PASSWORD / …_PASSPHRASE / …_API_KEY / …_CLIENT_ID / 任意位置的 KEY 段 /
 * CLIENTID（无下划线粘写）/ SSHPASS / MYSQL_PWD / IMA_OPENAPI_*（BASE_URL、REGION 这类地址配置除外）。
 */
const SENSITIVE_NAME_SEGMENT =
  /(?:^|_)(?:api_?keys?|access_?keys?|private_?keys?|client_?id|client_?secret|token|secret|password|passwd|passphrase)(?:_|$)/i;

/**
 * 裸 KEY 段后面跟这些词时，名字说的是「键的元数据」而不是密钥本身：CACHE_KEY_PREFIX、MY_KEY_ID、
 * REDIS_KEY_TTL、SSH_KEY_PATH。其余后缀（OPENAI_KEY_PROD、DEEPSEEK_KEY_2、STRIPE_KEY_LIVE、
 * SSH_KEY_PASSPHRASE）一律打码——黑名单只放非敏感后缀，没列到的按密钥处理（QA514 r3）。
 */
const KEY_METADATA_SUFFIX = new Set([
  "PREFIX",
  "SUFFIX",
  "ID",
  "IDS",
  "TTL",
  "NAME",
  "NAMES",
  "FILE",
  "PATH",
  "DIR",
  "TYPE",
  "FORMAT",
  "LENGTH",
  "LEN",
  "SIZE",
  "BITS",
  "ALG",
  "ALGORITHM",
  "VERSION",
  "COUNT",
  "FIELD",
  "COLUMN",
  "SEPARATOR",
  "DELIMITER",
  "PATTERN",
  "EXPIRY",
  "TIMEOUT",
  "SPACE",
]);

/**
 * 元数据后缀之后再跟这些词，说的又是密钥本体：KEY_FILE_CONTENT、KEY_PATH_DATA（QA514 r4）。
 */
const KEY_CONTENT_SUFFIX = new Set([
  "CONTENT",
  "CONTENTS",
  "DATA",
  "VALUE",
  "BODY",
  "TEXT",
  "STRING",
  "RAW",
  "PEM",
  "DER",
  "B64",
  "BASE64",
  "HEX",
  "MATERIAL",
  "BYTES",
  "SECRET",
]);

function hasSecretKeySegment(name: string): boolean {
  const segments = name.toUpperCase().split("_");
  for (let i = 0; i < segments.length; i++) {
    // KEY 与复数 KEYS（API_KEYS、OPENAI_KEYS）；MONKEY / KEYBOARD 不是独立的段，不算。
    if (segments[i] !== "KEY" && segments[i] !== "KEYS") continue;
    const next = segments[i + 1];
    // 结尾的 KEY（OPENAI_KEY）、或后面不是元数据后缀（OPENAI_KEY_PROD）都算密钥。
    if (!next || !KEY_METADATA_SUFFIX.has(next)) return true;
    // 元数据后缀后面还跟着内容类的词（KEY_FILE_CONTENT）：仍是密钥本体。
    if (segments.slice(i + 2).some((part) => KEY_CONTENT_SUFFIX.has(part)))
      return true;
  }
  return false;
}

/** IMA_OPENAPI_ 族里不是凭据的配置：服务地址、区域、超时等（QA514 r3）。 */
const IMA_OPENAPI_PUBLIC =
  /^IMA_OPENAPI_(?:BASE_?URL|URL|ENDPOINT|HOST|DOMAIN|REGION|PORT|TIMEOUT|VERSION|LOG_?LEVEL|DEBUG)$/i;

export function isSensitiveConfigName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/^SSHPASS$/i.test(n)) return true;
  if (/^[A-Z0-9_]+_PWD$/i.test(n)) return true;
  // ima OpenAPI 凭据前缀：后缀未必是 KEY/SECRET（SIGN、CLIENTID），整族打码，只放过地址类配置。
  if (/^IMA_OPENAPI_/i.test(n)) return !IMA_OPENAPI_PUBLIC.test(n);
  return SENSITIVE_NAME_SEGMENT.test(n) || hasSecretKeySegment(n);
}

/**
 * 值的扫描全部是手写的线性循环，不用「(?:a|b)+」这类逐字符交替的正则：
 * - 连串的 \"\"\"… 会让带回溯的正则在每个 " 处扫到结尾再失败，整体平方级（QA514 r4：16KB 约 0.6s）；
 * - 值超过几十万字符时 JS 引擎的正则回溯栈会溢出，exec 直接返回 null，值就漏打了。
 */

/**
 * 引号段的结束位置（不含）：双引号认 ""、\" 与 PowerShell 的 `" 转义，单引号认 ''（QA514 r3/r4），
 * 避免 'pa''ss' / "pa`"ss" / "pa""ss" 在第一个内部引号处截断、后半段漏出。
 * 没闭合的引号算到结尾（宁可多打）。
 */
function scanQuoted(text: string, from: number): number {
  const quote = text[from];
  let i = from + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (quote === '"' && (c === "\\" || c === "`")) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return text.length;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

/** `&name=`：URL query 的下一项。只看到 = 或第一个非名字字符为止。 */
function isQueryPair(text: string, amp: number): boolean {
  let i = amp + 1;
  if (!NAME_START.test(text[i] ?? "")) return false;
  while (i < text.length && NAME_CHAR.test(text[i] as string)) i++;
  return text[i] === "=";
}

/**
 * 赋值右侧的值，返回结束位置（不含）。
 * - `url`（YAML / JSON / $env: / URL query 里的一项）：引号整段，或非空白整段；值里的 ;| 与单独的 & 算值
 *   （pa&ss），&& 与「&name=」切开，避免把 ?a=1&b=2 吞成一段（QA514 r2）。
 * - `shell`（命令里的 NAME=value）：按 shell 词读，引号段和裸字符可以连着（"a"b'c'），值里的 & = , 都算值
 *   （DB_PASSWORD=pa&ss=x、API_KEYS=k1,k2，QA514 r3/r4），只有 &&、空白和 \ {} [] 才切开。
 */
function scanValue(text: string, from: number, mode: "url" | "shell"): number {
  const first = text[from];
  if (mode === "url" && (first === '"' || first === "'"))
    return scanQuoted(text, from);
  let i = from;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"' || c === "'") {
      if (mode === "url") break;
      i = scanQuoted(text, i);
      continue;
    }
    if (/[\s\\{}[\]]/.test(c)) break;
    if (mode === "url" && (c === "=" || c === ",")) break;
    if (c === "&") {
      if (text[i + 1] === "&") break;
      if (mode === "url" && isQueryPair(text, i)) break;
    }
    i += 1;
  }
  return i;
}

/**
 * 「前缀正则 + 手扫的值」：前缀命中后从其末尾读一个值交给 render。render 返回 undefined 表示不改，
 * 这时从值的开头接着往后找（值里还可能有别的赋值）。前缀正则必须带 g。
 */
function replaceAssigned(
  text: string,
  prefix: RegExp,
  mode:
    | "url"
    | "shell"
    | "quoted"
    | ((match: RegExpExecArray) => "url" | "shell"),
  render: (match: RegExpExecArray, value: string) => string | undefined,
  /** 前缀里的名字不敏感就不扫值：否则 a=a=a=… 每个前缀都要扫到结尾，平方级。 */
  accept: (match: RegExpExecArray) => boolean = () => true,
): string {
  let out = "";
  let last = 0;
  prefix.lastIndex = 0;
  for (let m = prefix.exec(text); m; m = prefix.exec(text)) {
    const valueStart = m.index + m[0].length;
    if (!accept(m)) {
      prefix.lastIndex = Math.max(valueStart, m.index + 1);
      continue;
    }
    let valueEnd = valueStart;
    const kind = typeof mode === "function" ? mode(m) : mode;
    if (kind === "quoted") {
      if (text[valueStart] === '"' || text[valueStart] === "'")
        valueEnd = scanQuoted(text, valueStart);
    } else valueEnd = scanValue(text, valueStart, kind);
    const replaced = render(m, text.slice(valueStart, valueEnd));
    if (replaced === undefined) {
      prefix.lastIndex = Math.max(valueStart, m.index + 1);
      continue;
    }
    out += text.slice(last, m.index) + replaced;
    last = valueEnd;
    prefix.lastIndex = Math.max(valueEnd, m.index + 1);
  }
  return last === 0 ? text : out + text.slice(last);
}

/** 空赋值（含 "" / ''）不算泄漏，原样保留（QA514 empty-value）。 */
function isEmptyAssignedValue(value: string): boolean {
  return value === "" || value === "''" || value === '""';
}

/** 已经是 ••••（或以其开头，避免把后面的 ; 再吞掉）就不要再打。 */
function alreadyMasked(value: string): boolean {
  return (
    value === MASK ||
    value.startsWith(MASK) ||
    value === `"${MASK}"` ||
    value === `'${MASK}'`
  );
}

const SECRET_SHAPES: RegExp[] = [
  // Authorization: Bearer xxx / token xxx. `Basic authentication` is prose (QA511 P3).
  /\b(bearer|token|basic)\s+(?!authentication\b)[A-Za-z0-9._~+/=-]{12,}/gi,
  // 长参数：--password / --client-id / --api-key …（KEY=value / JSON / YAML / 请求头在 redactPlain）
  /(--(?!no-)(?:[a-z0-9]+-)*(?:password|passwd|passphrase|pass|token|secret|api-?key|apikey|client-?id|client-?secret|key)(?:-[a-z0-9]+)*(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi,
  // 常见密钥前缀
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
];

/**
 * 嵌在字母数字后面的密钥前缀（QA514 r5）：`FAKE76sk-…`、`X_ghp_…` 这类 \b 不成立，上面的规则认不出来。
 * - 前面是数字、大写字母或下划线：照常按前缀 + 长度认（ABC1sk-…、TOKEN_sk-…）。
 * - 前面是小写字母：多半是普通单词结尾（task-、desk-、risk-、mask-、disk-），只有后面是高熵串才算。
 * 只把前缀起的那一段换成 ••••，前面的字符原样保留。单次正则扫描，线性。
 */
const EMBEDDED_KEY =
  /(?<=[A-Za-z0-9_])(sk-|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza)([A-Za-z0-9_-]+)/g;
const EMBEDDED_KEY_TAIL: Record<string, RegExp> = {
  "sk-": /^[A-Za-z0-9_-]{16,}$/,
  ghp_: /^[A-Za-z0-9]{20,}$/,
  gho_: /^[A-Za-z0-9]{20,}$/,
  github_pat_: /^[A-Za-z0-9_]{20,}$/,
  xoxa: /^[A-Za-z0-9-]{10,}$/,
  AKIA: /^[0-9A-Z]{16}/,
  AIza: /^[0-9A-Za-z_-]{30,}$/,
};

/**
 * 高熵：至少 20 个字符；混有字母和数字，或大小写都有；去掉 - 分隔后最长一段至少 16 个字符
 * （risk-assessment-2024-report 这类由短单词拼成的串不算）。
 */
function looksHighEntropy(tail: string): boolean {
  if (tail.length < 20) return false;
  const mixed =
    (/[A-Za-z]/.test(tail) && /\d/.test(tail)) ||
    (/[a-z]/.test(tail) && /[A-Z]/.test(tail));
  if (!mixed) return false;
  let longest = 0;
  for (const part of tail.split("-")) longest = Math.max(longest, part.length);
  return longest >= 16;
}

function redactEmbeddedKeys(text: string): string {
  return text.replace(
    EMBEDDED_KEY,
    (whole, prefix: string, tail: string, offset: number, input: string) => {
      const rule =
        EMBEDDED_KEY_TAIL[prefix.startsWith("xox") ? "xoxa" : prefix];
      if (!rule?.test(tail)) return whole;
      const before = input[offset - 1] ?? "";
      if (/[a-z]/.test(before) && !looksHighEntropy(tail)) return whole;
      if (prefix === "AKIA") {
        // AKIA 后面固定 16 位，多出来的字符原样保留。
        return `${MASK}${tail.slice(16)}`;
      }
      return MASK;
    },
  );
}

/**
 * 短参数带口令（`-p value` / `-pvalue`）只按**命令**打码。
 *
 * 短参数的意思因命令而异：`mkdir -p dir`、`ssh -p 22`、`curl -k`（insecure，不带值）、`mysql -P 3306`（端口）
 * 都不是口令。所以不搞「所有 -p 后面都打码」，而是列出已知会把口令放在短参数上的命令；不在表里的命令，
 * 短参数原样保留（长参数 --password 之类不论命令都打）。
 *
 * - `attached`：值可以紧贴在参数后（`-phunter2`）。
 * - `separate`：值可以是下一个词（`-p hunter2`）。mysql 的 `-p x` 其实会把 x 当库名并提示输入口令，
 *   但照样打码：误把一个库名打成 •••• 无害，漏掉一次口令不行。
 * - `userinfo`：值是 `user:password`，只打冒号后面（curl -u）。
 */
type ShortFlagRule = {
  attached?: string[];
  separate?: string[];
  userinfo?: string[];
  /**
   * 选项只出现在第一个位置参数之前，之后是它要跑的另一条命令（`sshpass -p x ssh -p 22 h`）。
   * 到那里就停，剩下的部分当作一条新命令再判断一遍：`ssh -p 22` 的端口不能被打成 ••••。
   */
  wraps?: boolean;
};
const MYSQL: ShortFlagRule = { attached: ["-p"], separate: ["-p"] };
const SHORT_FLAG_COMMANDS: Record<string, ShortFlagRule> = {
  sshpass: { attached: ["-p"], separate: ["-p"], wraps: true },
  mysql: MYSQL,
  mysqldump: MYSQL,
  mysqladmin: MYSQL,
  mysqlimport: MYSQL,
  mysqlcheck: MYSQL,
  mariadb: MYSQL,
  "mariadb-dump": MYSQL,
  "redis-cli": { separate: ["-a"] },
  zip: { separate: ["-P"] },
  unzip: { attached: ["-P"], separate: ["-P"] },
  "7z": { attached: ["-p"] },
  "7za": { attached: ["-p"] },
  rar: { attached: ["-p"] },
  unrar: { attached: ["-p"] },
  // openssl enc -k pass / -pass pass:xx / -passin / -passout
  openssl: { separate: ["-k", "-pass", "-passin", "-passout"] },
  // vault login -token=… 走长参数；这里是单横线的 -token x
  vault: { separate: ["-token"] },
  curl: { userinfo: ["-u", "--user"] },
  wget: { userinfo: [] },
  smbclient: { userinfo: ["-U"] },
};

/** 一个 shell 词：引号段和非空白段连在一起算一个（`-p"hunter 2"` 是一个词）。 */
const WORD = /(?:"(?:[^"\\]|\\[\s\S]?)*(?:"|$)|'[^']*(?:'|$)|[^\s"'|;&])+/g;

/** 词尾收口的反引号/括号（`x=\`mysql -pPW\``、`(sshpass -p PW)`）保留下来，别跟口令一起吞掉。 */
function closers(text: string): string {
  return /[`)\]}]+$/.exec(text)?.[0] ?? "";
}

/**
 * 一个词是不是表里的命令：去掉结尾的引号/括号/标点、路径前缀和开头的标点（`(sshpass`、`/usr/bin/sshpass`、
 * `"mysql`），剩下的名字正好在表里才算。词本身由空白或 shell 分隔符切开，所以命令前面只能是行首、空白或标点。
 */
function commandRule(text: string): ShortFlagRule | undefined {
  const name = text
    .replace(/["'`)\]},;:]+$/, "")
    .replace(/^.*[^A-Za-z0-9_.+-]/, "");
  return Object.hasOwn(SHORT_FLAG_COMMANDS, name)
    ? SHORT_FLAG_COMMANDS[name]
    : undefined;
}

/**
 * 引号里是一整条命令（`bash -c "curl -u u:x"`、`sh -c 'sshpass -p x ssh h'`、`ssh h "mysql -px"`，
 * 或者输出里回显的 `"curl -u u:x"`）：WORD 把整段引号当一个词，里面的命令要拆开再打一遍。
 * 只处理里面带空白的引号段；以 `-` 开头的词是参数本身（`-p"hunter 2"`），交给下面的规则。
 * 双引号里的 `\"` / `\\` 先还原再打码，改过才按原样转义回去。没有改动返回 undefined。
 */
function redactQuoted(text: string): string | undefined {
  if (text.startsWith("-") || !/["'][^"']*\s/.test(text)) return undefined;
  const out = text.replace(
    // 没闭合的引号一直算到结尾、原样保留：否则每个 " 都要往后扫到底再失败，连串的 \"\"\"… 是平方级（QA514 r4）。
    /"((?:[^"\\]|\\[\s\S]?)*)("|$)|'([^']*)('|$)/g,
    (
      whole,
      double: string | undefined,
      doubleEnd: string | undefined,
      single: string | undefined,
      singleEnd: string | undefined,
    ) => {
      if (doubleEnd === "" || singleEnd === "") return whole;
      if (single !== undefined) {
        if (!/\s/.test(single)) return whole;
        return `'${redactCommands(single)}'`;
      }
      const inner = double ?? "";
      if (!/\s/.test(inner)) return whole;
      const plain = inner.replace(/\\(["\\])/g, "$1");
      const masked = redactCommands(plain);
      if (masked === plain) return whole;
      return `"${masked.replace(/(["\\])/g, "\\$1")}"`;
    },
  );
  return out === text ? undefined : out;
}

/**
 * 在一段文本里**任意位置**找表里的命令并打它的短参数：不只是行首的命令，也包括输出里的回显
 * （`echo sshpass -p x`、`set -x` 的 `+ mysql -px`、`ps aux` 一行末尾的命令、`history` 的 `12  curl -u u:x`）。
 * 遇到下一个表里的命令就换成它的规则；`wraps` 的命令（sshpass）到第一个位置参数就停，后面那条命令
 * （`ssh -p 22`）不在表里就不打。
 */
function redactShortFlags(segment: string): string {
  const words = [...segment.matchAll(WORD)].map((m) => ({
    text: m[0],
    start: m.index ?? 0,
  }));
  const edits: { start: number; end: number; text: string }[] = [];
  let rule: ShortFlagRule | undefined;
  for (let j = 0; j < words.length; j++) {
    const word = words[j] as { text: string; start: number };
    const next = words[j + 1];
    const nested = redactQuoted(word.text);
    if (nested !== undefined) {
      edits.push({
        start: word.start,
        end: word.start + word.text.length,
        text: nested,
      });
      continue;
    }
    const found = commandRule(word.text);
    if (found) {
      rule = found;
      continue;
    }
    if (!rule) continue;
    if (word.text === "--") {
      rule = undefined;
      continue;
    }
    if (
      rule.separate?.includes(word.text) &&
      next &&
      !next.text.startsWith("-")
    ) {
      edits.push({
        start: next.start,
        end: next.start + next.text.length,
        text: `${MASK}${closers(next.text)}`,
      });
      j += 1;
      continue;
    }
    const attached = rule.attached?.find(
      (flag) => word.text.startsWith(flag) && word.text.length > flag.length,
    );
    if (attached) {
      edits.push({
        start: word.start,
        end: word.start + word.text.length,
        // 参数之后（含引号）整段换掉。
        text: `${attached}${MASK}${closers(word.text)}`,
      });
      continue;
    }
    if (rule.userinfo?.includes(word.text) && next) {
      const colon = next.text.indexOf(":");
      if (colon >= 0 && colon < next.text.length - 1) {
        const user = next.text.slice(0, colon + 1);
        edits.push({
          start: next.start,
          end: next.start + next.text.length,
          // 引号开头时补上配对的引号，别留一个半截的。
          text: `${user}${MASK}${/^["']/.test(user) ? user[0] : ""}`,
        });
      }
      j += 1;
      continue;
    }
    // sshpass 的选项只在它要跑的命令之前；到第一个位置参数就停。
    if (rule.wraps && !word.text.startsWith("-")) rule = undefined;
  }
  let out = segment;
  for (const edit of edits.reverse())
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** 按 shell 分隔符（换行、;、|、&&、||）切成一条条命令，各自按命令打短参数。 */
function redactCommands(value: string): string {
  return value
    .split(/(\r?\n|&&|\|\||[;|&])/)
    .map((part, index) => (index % 2 === 1 ? part : redactShortFlags(part)))
    .join("");
}

/** 一条命令里的一个参数词（带位置）。引号段按 scanQuoted 的转义规则整段读。 */
type ArgToken = { text: string; start: number; end: number };

/** 一个参数词的结束位置：引号段（scanQuoted）和裸字符连在一起，遇到空白或 ; | & ( ) 结束。 */
function scanArg(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"' || c === "'") {
      i = scanQuoted(text, i);
      continue;
    }
    if (/[\s;|&()]/.test(c)) break;
    i += 1;
  }
  return i;
}

/**
 * 从 `from` 起读到这条命令结束（换行、; | & 或右括号）为止的参数词。
 * 只用于 setx / Set-Item 这类「命令 + 参数」的场景，值里的引号段（含 ; 与空格）算一个词。
 * 最多读 MAX_ARGS 个：这两类命令的参数不会更多，也避免一长串重复命令时逐个扫到行尾（平方级）。
 */
const MAX_ARGS = 24;
function readArgs(text: string, from: number): ArgToken[] {
  const tokens: ArgToken[] = [];
  let i = from;
  while (i < text.length && tokens.length < MAX_ARGS) {
    while (i < text.length && /[ \t]/.test(text[i] as string)) i++;
    if (i >= text.length || /[\r\n;|&)]/.test(text[i] as string)) break;
    if (text[i] === "(") {
      // -Value ("v") / -Value ('a' + 'b')：整个括号表达式算一个词（QA514 r4）。
      const end = parenEnd(text, i);
      tokens.push({ text: text.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    const end = scanArg(text, i);
    if (end === i) break;
    tokens.push({ text: text.slice(i, end), start: i, end });
    i = end;
  }
  return tokens;
}

/** 从 `(` 起找到配对的 `)`（跳过引号段）；没配对就到这一行结尾。线性扫描。 */
function parenEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\n" || c === "\r") return i;
    if (c === '"' || c === "'") {
      i = scanQuoted(text, i);
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

function unquote(text: string): string {
  if (/^"[\s\S]*"$/.test(text) && text.length >= 2) return text.slice(1, -1);
  if (/^'[\s\S]*'$/.test(text) && text.length >= 2) return text.slice(1, -1);
  return text;
}

/** 值是一个 PowerShell / cmd 变量引用（$key、$null、%VAR%），不是明文。 */
function isVariableReference(value: string): boolean {
  const v = value.replace(/^\(\s*([\s\S]*?)\s*\)$/, "$1");
  return /^\$[A-Za-z_][\w:]*$/.test(v) || /^%[A-Za-z_]\w*%$/.test(v);
}

function shouldMaskValue(name: string, value: string): boolean {
  return (
    isSensitiveConfigName(name) &&
    !isEmptyAssignedValue(value) &&
    !alreadyMasked(unquote(value)) &&
    !isVariableReference(value)
  );
}

function applyEdits(
  text: string,
  edits: { start: number; end: number; text: string }[],
): string {
  const parts: string[] = [];
  let last = 0;
  for (const edit of [...edits].sort((x, y) => x.start - y.start)) {
    if (edit.start < last) continue;
    parts.push(text.slice(last, edit.start), edit.text);
    last = edit.end;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

/**
 * cmd setx（含 setx.exe、C:\\Windows\\System32\\setx.exe）：`setx NAME value [/M]`、`setx /M NAME value`、`setx /S host /U user /P pw NAME value`
 * （QA514 r3：/M 写在名字前面也要打）。/P 后面是远程机器的口令，同样打码。/K、/F 模式的值来自注册表或
 * 文件，不是明文，不动。
 */
function redactSetx(text: string): string {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const m of text.matchAll(
    /(?:^|(?<=[\s;|&("'\\/]))setx(?:\.exe)?["']?(?=[ \t])/gi,
  )) {
    const tokens = readArgs(text, (m.index ?? 0) + m[0].length);
    const positional: ArgToken[] = [];
    let fromRegistryOrFile = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as ArgToken;
      const flag = /^[/-]([A-Za-z])$/.exec(token.text)?.[1]?.toLowerCase();
      if (!flag) {
        positional.push(token);
        continue;
      }
      if (flag === "k" || flag === "f") fromRegistryOrFile = true;
      if (["s", "u", "p", "k", "f", "a", "r", "d"].includes(flag)) {
        const next = tokens[i + 1];
        if (next && !/^[/-][A-Za-z]$/.test(next.text)) {
          if (
            flag === "p" &&
            !isEmptyAssignedValue(next.text) &&
            !alreadyMasked(unquote(next.text))
          )
            edits.push({ start: next.start, end: next.end, text: MASK });
          i += 1;
        }
      }
    }
    if (fromRegistryOrFile) continue;
    const [name, value] = positional;
    if (!name || !value) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.text)) continue;
    if (shouldMaskValue(name.text, value.text))
      edits.push({ start: value.start, end: value.end, text: MASK });
  }
  return edits.length ? applyEdits(text, edits) : text;
}

/** env: 驱动器路径：Env:NAME、Env:\NAME、Env:/NAME（大小写不敏感，可带引号）。 */
function envPathName(path: string): string | undefined {
  return /^env:[\\/]?([A-Za-z_][A-Za-z0-9_]*)$/i.exec(unquote(path))?.[1];
}

/** -Path / -LiteralPath / -PSPath / -LP，以及 PowerShell 允许的无歧义缩写（-Pat、-Li、-Va、-N）。 */
function envProviderParam(
  flag: string,
): "path" | "value" | "name" | "other" | "switch" {
  const f = flag.toLowerCase();
  if (f.length >= 3 && "path".startsWith(f)) return "path";
  if (f === "lp" || f === "pspath") return "path";
  if (f.length >= 2 && "literalpath".startsWith(f)) return "path";
  if (f.length >= 1 && "value".startsWith(f)) return "value";
  if (f.length >= 1 && "name".startsWith(f)) return "name";
  if (
    [
      "itemtype",
      "type",
      "encoding",
      "filter",
      "include",
      "exclude",
      "credential",
      "stream",
    ].includes(f)
  )
    return "other";
  return "switch";
}

/**
 * 管道左边的值：`'v' | Set-Content Env:X`、`"v" | si Env:\X`（QA514 r4）。从 `|` 往回读一个词：
 * 引号段（含 '' / "" 转义）或整段只有一个裸词时算明文值；`Get-Content k.txt |`、`$v |` 这类不是明文，不动。
 * 往回最多看 PIPE_LOOKBACK 个字符，保证整体线性。
 */
const PIPE_LOOKBACK = 4096;
function pipedValue(text: string, commandStart: number): ArgToken | undefined {
  let i = commandStart - 1;
  while (i >= 0 && /[ \t]/.test(text[i] as string)) i--;
  if (text[i] !== "|" || text[i - 1] === "|") return undefined;
  i -= 1;
  while (i >= 0 && /[ \t]/.test(text[i] as string)) i--;
  if (i < 0) return undefined;
  const end = i + 1;
  const floor = Math.max(0, end - PIPE_LOOKBACK);
  const close = text[i] as string;
  let start: number;
  if (close === "'" || close === '"') {
    // 往回找开引号：连着的两个同种引号是转义，跳过。
    let j = i - 1;
    for (;;) {
      j = text.lastIndexOf(close, j);
      if (j < floor) return undefined;
      if (text[j - 1] === close && j - 1 > floor) {
        j -= 2;
        continue;
      }
      if (close === '"' && (text[j - 1] === "\\" || text[j - 1] === "`")) {
        j -= 1;
        continue;
      }
      break;
    }
    start = j;
  } else {
    let j = i;
    while (j >= floor && !/[\s|;&()]/.test(text[j] as string)) j--;
    start = j + 1;
    // 裸词：前面必须是这一段的开头（行首、; ( 或 &&），否则是某条命令的参数（Get-Content k.txt）。
    let k = j;
    while (k >= floor && /[ \t]/.test(text[k] as string)) k--;
    if (k >= floor && !/[\r\n;(&|]/.test(text[k] as string)) return undefined;
  }
  return { text: text.slice(start, end), start, end };
}

/** `-Path` 之外，Set-Variable / New-Variable 的 `-Name`。 */
const ENV_WRITE_COMMANDS =
  /(?:^|(?<=[\s;|&({]))(Set-Item|New-Item|Set-Content|Add-Content|si|ni|ac|Set-Variable|New-Variable|sv|nv)(?=[ \t])/gi;

/**
 * PowerShell 写环境变量（QA514 r3/r4）：微软文档 about_Environment_Variables 的写法是
 * `Set-Item -Path Env:\NAME -Value '…'`、`New-Item -Path Env:\NAME -Value '…'`；另有 `Env:NAME`、
 * `-LiteralPath`、`-Value` 写在前面、`-Value ("…")`、`Set-Content` / `Add-Content`、别名 si / ni / ac、
 * `New-Item -Path Env:\ -Name NAME`、管道传值 `'…' | Set-Content Env:NAME`。
 * Set-Variable / New-Variable（sv / nv）写的是 PowerShell 变量，按 -Name 判断。
 * 参数顺序任意、命令和参数名大小写不敏感。只把值那个词换成 ••••，其余原样保留。
 */
function redactEnvProvider(text: string): string {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const m of text.matchAll(ENV_WRITE_COMMANDS)) {
    const command = (m[1] as string).toLowerCase();
    const isVariable = /^(?:set-variable|new-variable|sv|nv)$/.test(command);
    const tokens = readArgs(text, (m.index ?? 0) + m[0].length);
    let path: string | undefined;
    let nameParam: string | undefined;
    let value: ArgToken | undefined;
    const positional: ArgToken[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as ArgToken;
      const param = /^-([A-Za-z]+)(?::([\s\S]+))?$/.exec(token.text);
      if (!param) {
        positional.push(token);
        continue;
      }
      const kind = envProviderParam(param[1] as string);
      if (kind === "switch") continue;
      // -Value:'x' 写法：值贴在冒号后面。
      let arg: ArgToken | undefined;
      if (param[2] !== undefined) {
        const offset = token.text.length - param[2].length;
        arg = {
          text: param[2],
          start: token.start + offset,
          end: token.end,
        };
      } else {
        arg = tokens[i + 1];
        i += 1;
      }
      if (!arg) continue;
      if (kind === "path") path = arg.text;
      else if (kind === "name") nameParam = unquote(arg.text);
      else if (kind === "value") value = arg;
    }
    let name: string | undefined;
    if (isVariable) {
      // Set-Variable [-Name] NAME [-Value] v
      if (nameParam === undefined && positional[0])
        nameParam = unquote(positional.shift()?.text ?? "");
      name = nameParam?.replace(/^(?:env:)/i, "");
    } else {
      // 位置参数：第一个是 Path，第二个是 Value。
      if (path === undefined && positional[0]) path = positional.shift()?.text;
      if (path === undefined) continue;
      name =
        envPathName(path) ??
        (/^env:[\\/]?$/i.test(unquote(path)) ? nameParam : undefined);
    }
    if (value === undefined && positional[0]) value = positional[0];
    if (value === undefined) value = pipedValue(text, m.index ?? 0);
    if (!name || !value) continue;
    if (shouldMaskValue(name, value.text))
      edits.push({ start: value.start, end: value.end, text: MASK });
  }
  return edits.length ? applyEdits(text, edits) : text;
}

/**
 * shell / .env 的 NAME=value。名字紧跟在 ? 或 & 后面时是 URL query 的一项，值到下一个 & 为止；
 * 否则是命令里的赋值，值里的 & 与 = 都算值（DB_PASSWORD=pa&ss=x 不能从 &ss= 起漏出，QA514 r3）。
 * 不敏感的名字不吞掉它的值，继续往值里找（X=1&API_KEY=… 里的 API_KEY 照样打码）。
 */
function redactAssignments(text: string): string {
  return replaceAssigned(
    text,
    /\b([A-Za-z_][A-Za-z0-9_]*)=/g,
    // 名字紧跟在 ? 或 & 后面：URL query 的一项，值到下一个 & 为止。
    (m) =>
      m.index > 0 && /[?&]/.test(m.input[m.index - 1] as string)
        ? "url"
        : "shell",
    (m, value) => {
      const name = m[1] as string;
      if (
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value)
      )
        return undefined;
      return `${name}=${MASK}`;
    },
    (m) => isSensitiveConfigName(m[1] as string),
  );
}

/** 文本打码中不碰 URL 的那一半：命令短参数 + 密钥形状。redactUrl 的兜底走这里，不走 redactText。 */
function redactPlain(value: string): string {
  let out = redactCommands(value);
  out = out.replace(
    SECRET_SHAPES[0] as RegExp,
    (_m, scheme: string) => `${scheme} ${MASK}`,
  );
  // PowerShell：$env:NAME = '…' / $env:NAME="…" / $env:NAME=… / ${env:NAME} = …（= 两边可有空格）
  out = replaceAssigned(
    out,
    /\$(?:\{env:([A-Za-z_][A-Za-z0-9_]*)\}|env:([A-Za-z_][A-Za-z0-9_]*))\s*=\s*/gi,
    "url",
    (m, value) => {
      const braced = m[1];
      const name = braced ?? m[2] ?? "";
      if (
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value)
      )
        return undefined;
      return braced !== undefined
        ? `\${env:${name}}=${MASK}`
        : `$env:${name}=${MASK}`;
    },
    (m) => isSensitiveConfigName(m[1] ?? m[2] ?? ""),
  );
  // PowerShell / .NET：[Environment]::SetEnvironmentVariable("NAME","value"[, "Process"|"User"|"Machine"])
  out = replaceAssigned(
    out,
    /\[(?:System\.)?Environment\]::SetEnvironmentVariable\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*,\s*/gi,
    "quoted",
    (m, value) => {
      const name = m[2] as string;
      if (
        !value ||
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value.slice(1))
      )
        return undefined;
      const quote = value[0] as string;
      return `${m[0]}${quote}${MASK}${quote}`;
    },
    (m) => isSensitiveConfigName(m[2] as string),
  );
  // cmd：setx [/S 机器 [/U 用户 [/P 口令]]] NAME value [/M]
  out = redactSetx(out);
  // PowerShell env: 驱动器：Set-Item / New-Item / Set-Content / si / ni，Env:NAME 与 Env:\NAME
  out = redactEnvProvider(out);
  // shell / .env：NAME=value（= 左边无空格；空值 NAME= 后直接空白不吞下一词）
  out = redactAssignments(out);
  // YAML：NAME: value（允许 : 后空白）
  out = replaceAssigned(
    out,
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/gi,
    "url",
    (m, value) => {
      const name = m[1] as string;
      if (
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value)
      )
        return undefined;
      return `${name}: ${MASK}`;
    },
    (m) => isSensitiveConfigName(m[1] as string),
  );
  // JSON / 对象字面量："client_id": "…" / "IMA_OPENAPI_APIKEY":"…"
  out = replaceAssigned(
    out,
    /(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*:\s*/gi,
    "url",
    (m, value) => {
      const quote = m[1] as string;
      const name = m[2] as string;
      if (
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value)
      )
        return undefined;
      return `${quote}${name}${quote}: ${MASK}`;
    },
    (m) => isSensitiveConfigName(m[2] as string),
  );
  // 请求头：X-Api-Key / X-Client-Id / X-Access-Token（不打 X-Request-Id）
  out = out.replace(
    /\b(X-(?:[A-Za-z0-9]+-)*(?:Api-?Key|Client-?Id|Access-?Token|Auth-?Token|Secret(?:-?Key)?))\s*:\s*("[^"]*"|'[^']*'|[^\s"']+)/gi,
    (_m, header: string) => `${header}: ${MASK}`,
  );
  out = out.replace(
    SECRET_SHAPES[1] as RegExp,
    (_m, flag: string) => `${flag}${MASK}`,
  );
  out = out.replace(SECRET_SHAPES[2] as RegExp, MASK);
  out = redactEmbeddedKeys(out);
  return out;
}

/**
 * URL userinfo 打码策略（QA509 / QA510 P3），redactUrl 和 redactUserinfo 共用：
 * - 带密码（包括空用户名的 `:pass@`）：用户名和密码一起打码。连接串里两者成对出现，
 *   只藏密码、留用户名，等于给撞库留一半线索。
 * - 只有用户名：保留（`ssh://git@github.com`、`postgres://app@db` 里的用户名不是秘密）。
 *   例外：用户名本身像令牌时打码，`https://<token>@github.com` 正是把令牌放在用户名位置。
 *   判断依据是已知密钥前缀、20 位以上，或者 looksLikeSecret。
 */
function userLooksSecret(user: string): boolean {
  let decoded = user;
  try {
    decoded = decodeURIComponent(user);
  } catch {
    // 坏的百分号编码按原样判断。
  }
  return (
    decoded.length >= 20 ||
    new RegExp((SECRET_SHAPES[2] as RegExp).source).test(decoded) ||
    looksLikeSecret(decoded)
  );
}

const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const USERINFO_STOP = /[\s"'<>]/;
/**
 * 手写线性扫描（QA514 r5 + QA510 P3）：不在每个词边界跑回溯正则，只在 `://` 处往回找 scheme、往后扫到空白/引号为止：
 * - 带密码（冒号前不含 `/?#@`）：密码段贪婪到最后一个 `@`（兼容未编码的 `@ / # ?`）；`host:8080/@scope` 端口加路径原样保留。
 * - 只有用户名（第一个 `@` 前不含 `/?#:`）：仅在用户名像令牌时打码，普通用户名（`ssh://git@github.com`）原样保留。
 */
export function redactUserinfo(value: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  for (;;) {
    const sep = value.indexOf("://", from);
    if (sep < 0) break;
    from = sep + 3;
    // 往回找 scheme：连续的 scheme 字符里，最靠左、前面不是词字符的字母。
    let runStart = sep;
    while (runStart > last && SCHEME_CHAR.test(value[runStart - 1] as string))
      runStart -= 1;
    let start = -1;
    for (let i = runStart; i < sep; i++) {
      if (
        /[A-Za-z]/.test(value[i] as string) &&
        (i === 0 || !WORD_CHAR.test(value[i - 1] as string))
      ) {
        start = i;
        break;
      }
    }
    if (start < 0) continue;
    let end = from;
    let atLast = -1;
    let firstAtBeforePath = -1;
    let sawPathOrColon = false;
    while (end < value.length && !USERINFO_STOP.test(value[end] as string)) {
      const ch = value[end] as string;
      if (ch === "@") {
        atLast = end;
        if (!sawPathOrColon && firstAtBeforePath < 0) firstAtBeforePath = end;
      } else if (ch === "/" || ch === "?" || ch === "#" || ch === ":") {
        sawPathOrColon = true;
      }
      end += 1;
    }
    if (atLast > from) {
      const candidate = value.slice(from, atLast);
      const colon = candidate.indexOf(":");
      if (colon >= 0 && !/[/?#@]/.test(candidate.slice(0, colon))) {
        const password = candidate.slice(colon + 1);
        if (!/^\d{1,5}(?:[/?#]|$)/.test(password)) {
          out += `${value.slice(last, from)}${MASK}:${MASK}@`;
          last = atLast + 1;
          from = last;
          continue;
        }
      }
    }
    if (firstAtBeforePath > from) {
      const user = value.slice(from, firstAtBeforePath);
      if (user !== MASK && userLooksSecret(user)) {
        out += `${value.slice(last, from)}${MASK}@`;
        last = firstAtBeforePath + 1;
        from = last;
        continue;
      }
    }
  }
  return last === 0 ? value : out + value.slice(last);
}

/** 文本（命令、输出）打码：像密钥的串换成 ••••；其中能解析的 URL 也按 redactUrl 处理。 */
export function redactText(value: string): string {
  const out = redactCommands(value);
  return redactPlain(
    redactUserinfo(
      out.replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url)),
    ),
  );
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
  if (new RegExp((SECRET_SHAPES[2] as RegExp).source).test(text)) return true;
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

/**
 * 写库前的最后一道：detail 里所有字符串（含嵌套）都过一遍 redactText。
 * 循环引用 / 超深嵌套的子树换成 null：detail 之后要 JSON.stringify 进库，递归遍历不防环会先爆栈，
 * 把整行记录赔进去（begin 实测 RangeError）。
 */
const DETAIL_MAX_DEPTH = 40;
export function redactDetail<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return redactText(item);
    if (!item || typeof item !== "object") return item;
    if (seen.has(item) || depth > DETAIL_MAX_DEPTH) return null;
    seen.add(item);
    if (Array.isArray(item)) return item.map((part) => walk(part, depth + 1));
    return Object.fromEntries(
      Object.entries(item).map(([key, part]) => [key, walk(part, depth + 1)]),
    );
  };
  return walk(value, 0) as T;
}
