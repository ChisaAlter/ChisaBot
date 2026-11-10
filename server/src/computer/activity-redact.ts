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

/**
 * 敏感配置名：按「段」匹配，避免 CLIENT_IDLE / TOKENIZER / KEYBOARD / MAX_TOKENS / CACHE_KEY_PREFIX 被误打。
 * 命中：…_TOKEN / …_SECRET / …_PASSWORD / …_PASSPHRASE / …_API_KEY / …_CLIENT_ID / 任意位置的 KEY 段 /
 * CLIENTID（无下划线粘写）/ SSHPASS / MYSQL_PWD / IMA_OPENAPI_*（BASE_URL、REGION 这类地址配置除外）。
 */
const SENSITIVE_NAME_SEGMENT =
  /(?:^|_)(?:api_?key|access_?key|private_?key|client_?id|client_?secret|token|secret|password|passwd|passphrase)(?:_|$)/i;

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

function hasSecretKeySegment(name: string): boolean {
  const segments = name.split("_");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]?.toUpperCase() !== "KEY") continue;
    const next = segments[i + 1];
    // 结尾的 KEY（OPENAI_KEY）、或后面不是元数据后缀（OPENAI_KEY_PROD）都算密钥。
    if (!next || !KEY_METADATA_SUFFIX.has(next.toUpperCase())) return true;
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
 * 引号段：双引号认 \" 与 PowerShell 的 `" 转义，单引号认 PowerShell / shell 的 '' 写法，
 * 避免 'pa''ss' / "pa`"ss" 在第一个内部引号处截断、后半段漏出（QA514 r3）。
 */
const QUOTED_VALUE = "\"(?:[\\\\`][\\s\\S]|[^\"\\\\`])*\"|'(?:''|[^'])*'";

/** 赋值右侧（YAML / JSON / $env:）：引号整段，或非空白整段（密码里的 ;|& 也算值的一部分，QA514）。
 * 单独的 & 算值（pa&ss），&& 与「&name=」形态（URL query）仍切开，避免把 ?a=1&b=2 吞成一段（QA514 r2）。
 */
const ASSIGNED_VALUE = String.raw`(${QUOTED_VALUE}|(?:[^\s"'=&\\,{}\[\]]|&(?!&|[A-Za-z_][A-Za-z0-9_]*=))+)`;
/**
 * shell / .env 的 NAME=value（名字前不是 ? 或 &，即不在 URL query 里）：值里的 & 和 = 都算值
 * （DB_PASSWORD=pa&ss=x 整段打码，QA514 r3），只有 && 和空白才切开。
 */
const SHELL_ASSIGNED_VALUE = String.raw`(${QUOTED_VALUE}|(?:[^\s"'&\\,{}\[\]]|&(?!&))+)`;
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
  // Authorization: Bearer xxx / token xxx
  /\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // 长参数：--password / --client-id / --api-key …（KEY=value / JSON / YAML / 请求头在 redactPlain）
  /(--(?!no-)(?:[a-z0-9]+-)*(?:password|passwd|passphrase|pass|token|secret|api-?key|apikey|client-?id|client-?secret|key)(?:-[a-z0-9]+)*(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi,
  // 常见密钥前缀
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
];

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
const WORD = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'|;&])+/g;

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
    /"((?:[^"\\]|\\.)*)"|'([^']*)'/g,
    (whole, double: string | undefined, single: string | undefined) => {
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

/** 一条命令里的一个参数词（带位置）。引号段按 QUOTED_VALUE 的转义规则整段读。 */
type ArgToken = { text: string; start: number; end: number };

const ARG_TOKEN = new RegExp(
  String.raw`(?:${QUOTED_VALUE}|[^\s"';|&()])+`,
  "y",
);

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
    if (i >= text.length || /[\r\n;|&()]/.test(text[i] as string)) break;
    ARG_TOKEN.lastIndex = i;
    const m = ARG_TOKEN.exec(text);
    if (!m?.[0]) break;
    tokens.push({ text: m[0], start: i, end: i + m[0].length });
    i += m[0].length;
  }
  return tokens;
}

function unquote(text: string): string {
  if (/^"[\s\S]*"$/.test(text) && text.length >= 2) return text.slice(1, -1);
  if (/^'[\s\S]*'$/.test(text) && text.length >= 2) return text.slice(1, -1);
  return text;
}

/** 值是一个 PowerShell / cmd 变量引用（$key、$null、%VAR%），不是明文。 */
function isVariableReference(value: string): boolean {
  return /^\$[A-Za-z_][\w:]*$/.test(value) || /^%[A-Za-z_]\w*%$/.test(value);
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
 * cmd setx：`setx NAME value [/M]`、`setx /M NAME value`、`setx /S host /U user /P pw NAME value`
 * （QA514 r3：/M 写在名字前面也要打）。/P 后面是远程机器的口令，同样打码。/K、/F 模式的值来自注册表或
 * 文件，不是明文，不动。
 */
function redactSetx(text: string): string {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const m of text.matchAll(/(?:^|(?<=[\s;|&(]))setx(?=[ \t])/gi)) {
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
 * PowerShell env: 驱动器写环境变量（QA514 r3）：微软文档 about_Environment_Variables 的写法是
 * `Set-Item -Path Env:\NAME -Value '…'`、`New-Item -Path Env:\NAME -Value '…'`；另有 `Env:NAME`、
 * `-LiteralPath`、`-Value` 写在前面、`Set-Content`、别名 si / ni、`New-Item -Path Env:\ -Name NAME`。
 * 参数顺序任意、命令和参数名大小写不敏感。只把值那个词换成 ••••，其余原样保留。
 */
function redactEnvProvider(text: string): string {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const m of text.matchAll(
    /(?:^|(?<=[\s;|&({]))(?:Set-Item|New-Item|Set-Content|si|ni)(?=[ \t])/gi,
  )) {
    const tokens = readArgs(text, (m.index ?? 0) + m[0].length);
    let path: string | undefined;
    let nameParam: string | undefined;
    let value: { text: string; start: number; end: number } | undefined;
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
    // 位置参数：第一个是 Path，第二个是 Value。
    if (path === undefined && positional[0]) path = positional.shift()?.text;
    if (value === undefined && positional[0]) value = positional[0];
    if (path === undefined || !value) continue;
    const name =
      envPathName(path) ??
      (/^env:[\\/]?$/i.test(unquote(path)) ? nameParam : undefined);
    if (!name) continue;
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
  const nameRe = /\b([A-Za-z_][A-Za-z0-9_]*)=/g;
  let out = "";
  let last = 0;
  for (let m = nameRe.exec(text); m; m = nameRe.exec(text)) {
    const name = m[1] as string;
    const valueStart = m.index + m[0].length;
    if (!isSensitiveConfigName(name)) {
      nameRe.lastIndex = valueStart;
      continue;
    }
    const inQuery = m.index > 0 && /[?&]/.test(text[m.index - 1] as string);
    const valueRe = new RegExp(
      inQuery ? ASSIGNED_VALUE : SHELL_ASSIGNED_VALUE,
      "y",
    );
    valueRe.lastIndex = valueStart;
    const value = valueRe.exec(text)?.[1] ?? "";
    if (isEmptyAssignedValue(value) || alreadyMasked(value)) {
      nameRe.lastIndex = valueStart;
      continue;
    }
    out += `${text.slice(last, valueStart)}${MASK}`;
    last = valueStart + value.length;
    nameRe.lastIndex = last;
  }
  return out + text.slice(last);
}

/** 文本打码中不碰 URL 的那一半：命令短参数 + 密钥形状。redactUrl 的兜底走这里，不走 redactText。 */
function redactPlain(value: string): string {
  let out = redactCommands(value);
  out = out.replace(
    SECRET_SHAPES[0] as RegExp,
    (_m, scheme: string) => `${scheme} ${MASK}`,
  );
  // PowerShell：$env:NAME = '…' / $env:NAME="…" / $env:NAME=…（= 两边可有空格）
  out = out.replace(
    new RegExp(
      String.raw`\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*${ASSIGNED_VALUE}`,
      "gi",
    ),
    (whole, name: string, value: string) => {
      if (
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value)
      )
        return whole;
      return `$env:${name}=${MASK}`;
    },
  );
  // PowerShell / .NET：[Environment]::SetEnvironmentVariable("NAME","value"[, "Process"|"User"|"Machine"])
  out = out.replace(
    new RegExp(
      String.raw`(\[(?:System\.)?Environment\]::SetEnvironmentVariable\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2\s*,\s*)(${QUOTED_VALUE})`,
      "gi",
    ),
    (whole, prefix: string, _qName: string, name: string, value: string) => {
      if (
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value.slice(1))
      )
        return whole;
      const quote = value[0] ?? '"';
      return `${prefix}${quote}${MASK}${quote}`;
    },
  );
  // cmd：setx [/S 机器 [/U 用户 [/P 口令]]] NAME value [/M]
  out = redactSetx(out);
  // PowerShell env: 驱动器：Set-Item / New-Item / Set-Content / si / ni，Env:NAME 与 Env:\NAME
  out = redactEnvProvider(out);
  // shell / .env：NAME=value（= 左边无空格；空值 NAME= 后直接空白不吞下一词）
  out = redactAssignments(out);
  // YAML：NAME: value（允许 : 后空白）
  out = out.replace(
    new RegExp(
      String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*${ASSIGNED_VALUE}`,
      "gi",
    ),
    (whole, name: string, value: string) => {
      if (
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value)
      )
        return whole;
      return `${name}: ${MASK}`;
    },
  );
  // JSON / 对象字面量："client_id": "…" / "IMA_OPENAPI_APIKEY":"…"
  out = out.replace(
    new RegExp(
      String.raw`(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*:\s*${ASSIGNED_VALUE}`,
      "gi",
    ),
    (whole, quote: string, name: string, value: string) => {
      if (
        !isSensitiveConfigName(name) ||
        isEmptyAssignedValue(value) ||
        alreadyMasked(value)
      )
        return whole;
      return `${quote}${name}${quote}: ${MASK}`;
    },
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
  return out;
}

/**
 * 任意 scheme 的 URL userinfo（QA509：postgres:// redis:// mongodb+srv:// wss:// ftp:// amqp://…）。
 * redactUrl 只接 http(s)；其余 scheme 的 `user:pass@` / `:pass@` / `user@` 一律整段换成 ••••。
 * userinfo 贪婪匹配到 host 前最后一个 @，密码里带 @ 也不漏半截。
 */
const ANY_SCHEME_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>]+)@/gi;
export function redactUserinfo(value: string): string {
  return value.replace(
    ANY_SCHEME_USERINFO,
    (_m, scheme: string, userinfo: string) =>
      `${scheme}${userinfo.includes(":") ? `${MASK}:${MASK}` : MASK}@`,
  );
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
