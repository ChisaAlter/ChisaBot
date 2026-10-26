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
  // KEY=value（环境变量 / 配置）。`_PWD` 结尾（MYSQL_PWD）和 SSHPASS 也算；单独的 PWD（当前目录）不算。
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*|[A-Z0-9_]+_PWD|SSHPASS)=("[^"]*"|'[^']*'|\S+)/gi,
  // 长参数：--password x / --password=x / --db-password x / --access-token x / --pass x …（任何命令都打）。
  /(--(?!no-)(?:[a-z0-9]+-)*(?:password|passwd|pass|token|secret|api-?key|apikey|key)(?:-[a-z0-9]+)*(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi,
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

/** 不改变「哪个命令」的前缀词：输出里的提示符（$ # >）、sudo、env、time、nohup…，以及 FOO=bar 这样的环境变量。 */
const WRAPPERS = new Set(["$", "#", ">", "sudo", "env", "time", "nohup", "exec", "command", "nice", "doas"]);

/** 一个 shell 词：引号段和非空白段连在一起算一个（`-p"hunter 2"` 是一个词）。 */
const WORD = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'|;&])+/g;

function redactShortFlags(segment: string): string {
  const words = [...segment.matchAll(WORD)].map((m) => ({
    text: m[0],
    start: m.index ?? 0,
  }));
  let i = 0;
  while (i < words.length) {
    const text = words[i]?.text ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) || WRAPPERS.has(text)) {
      i += 1;
      // 包装命令自己的参数（sudo -u root、nice -n 10）也跳过，找到真正的命令。
      while (words[i]?.text.startsWith("-")) {
        const flag = words[i]?.text ?? "";
        i += /^-[ugnCh]$/.test(flag) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  const commandWord = words[i]?.text;
  if (!commandWord) return segment;
  const command = commandWord.replace(/^["']|["']$/g, "").split("/").pop() ?? "";
  const rule = SHORT_FLAG_COMMANDS[command];
  if (!rule) return segment;
  const edits: { start: number; end: number; text: string }[] = [];
  for (let j = i + 1; j < words.length; j++) {
    const word = words[j] as { text: string; start: number };
    const next = words[j + 1];
    if (word.text === "--") break;
    if (rule.wraps && !word.text.startsWith("-")) {
      const rest = segment.slice(word.start);
      edits.push({
        start: word.start,
        end: segment.length,
        text: redactShortFlags(rest),
      });
      break;
    }
    if (
      rule.separate?.includes(word.text) &&
      next &&
      !next.text.startsWith("-")
    ) {
      edits.push({ start: next.start, end: next.start + next.text.length, text: MASK });
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
        text: `${attached}${MASK}`,
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
    }
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

/** 文本（命令、输出）打码：像密钥的串换成 ••••；其中的 URL 也按 redactUrl 处理。 */
export function redactText(value: string): string {
  let out = redactCommands(value);
  out = out.replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url));
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

/** 写库前的最后一道：detail 里所有字符串（含嵌套）都过一遍 redactText。 */
export function redactDetail<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDetail(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactDetail(item),
      ]),
    ) as T;
  }
  return value;
}
