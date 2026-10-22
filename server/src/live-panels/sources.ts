/**
 * 面板的直连数据源（2026-10-22，docs/live-panel-sources.md）。
 *
 * 机器人只写一次规范，宿主按每个源自己的 intervalSec 去取数（HTTP 走保险箱的 request，命令走本机 shell），
 * 值回填到规范里 `{"$state": "/live/<id>"}` 绑定的位置。取数不花 token，所以刷新频率可以到秒级。
 *
 * 这里做三件事：
 *  1. {@link normalizeSources}：把机器人交来的 dataSources 变成可信的定义（最多 3 个、https、内网拦截、
 *     明文密钥拒绝、id 稳定、命令仅管理员 + 部署开关）；
 *  2. {@link readSource}：真正取一次数，任何失败都变成一条中文读数（不抛给调用方）；
 *  3. {@link createSourceRunner}：按 intervalSec 判断新鲜度，同一个源同时只跑一次、最多 3 个并发，
 *     结果写回 `source_state`；失败也写（前端标红），但保留上一次的好值。
 *
 * 密钥一律是保险箱占位符 `{{secret:名字}}`：明文不进数据库、不进 DTO、不进错误信息、不进日志。
 */
import { randomUUID } from "node:crypto";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import {
  MAX_SOURCE_INTERVAL_SEC,
  MAX_SOURCES_PER_PANEL,
  MIN_SOURCE_INTERVAL_SEC,
  SOURCE_COMMAND_OUTPUT_MAX_BYTES,
  SOURCE_COMMAND_TIMEOUT_MS,
  SOURCE_HTTP_TIMEOUT_MS,
  SOURCE_VALUE_MAX_CHARS,
  type LivePanelDataSource,
  type LivePanelSourceReading,
  type LivePanelSourceState,
} from "./source-types";
import { LivePanelError } from "./store";

/** 没写 intervalSec 时的默认值：一分钟一次，和旧面板的最短刷新间隔一致。 */
const DEFAULT_SOURCE_INTERVAL_SEC = 60;
const MAX_HEADERS = 8;
const MAX_URL_CHARS = 1_000;
const MAX_BODY_CHARS = 4_000;
const MAX_COMMAND_CHARS = 2_000;
const MAX_HEADER_KEY_CHARS = 64;
const MAX_HEADER_VALUE_CHARS = 1_024;
const MAX_ERROR_CHARS = 300;
const MAX_LABEL_CHARS = 200;

/**
 * 保险箱占位符（与 server/src/vault/service.ts 同一个格式）：名字小写、2–40 个字符。
 * 定义两份是因为 vault 的正则没有导出；改格式时两处一起改。
 */
const SECRET_PLACEHOLDER = /\{\{\s*secret:([a-z0-9][a-z0-9_-]{0,38}[a-z0-9])\s*\}\}/g;
const SECRET_PLACEHOLDER_ANY = /\{\{\s*secret:([^}]*)\}\}/g;

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export type NormalizeSourcesOptions = {
  /** 当前操作者是不是管理员（命令数据源只给管理员）。 */
  isAdmin: boolean;
  /** 上一次的源：按 name 复用 id，改间隔 / 改网址不会让规范里的 /live/<id> 绑定失效。 */
  existing?: readonly LivePanelDataSource[];
  /** 测试用；默认 process.env。 */
  env?: Record<string, string | undefined>;
};

/** 一个看起来是明文密钥的值：长 token、sk- 开头、Bearer 后面的长串等。 */
export function looksLikePlaintextSecret(value: string, options: { genericTokens?: boolean } = {}): boolean {
  // 先把 {{secret:名字}} 去掉：`Authorization: Bearer {{secret:token}}` 是正确写法。
  const text = value.replace(SECRET_PLACEHOLDER, " ").trim();
  if (!text) return false;
  if (/(?:^|[^A-Za-z0-9])(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/.test(text)) return true;
  if (/(?:gh[pousr]_|github_pat_|xox[baprs]-|glpat-|npm_|pypi-)[A-Za-z0-9_-]{8,}/.test(text)) return true;
  if (/\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/.test(text)) return true;
  if (/\bAIza[0-9A-Za-z_-]{20,}\b/.test(text)) return true;
  if (/\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/i.test(text)) return true;
  if (options.genericTokens === false) return false;
  // 没有空格的长串（32+，同时有字母和数字；或 40+ 纯十六进制）基本就是 token。
  for (const token of text.match(/[A-Za-z0-9_\-+/=.]{32,}/g) ?? []) {
    if (/[A-Za-z]/.test(token) && /\d/.test(token)) return true;
    if (/^[0-9a-f]{40,}$/i.test(token)) return true;
  }
  return false;
}

/** 错误信息里绝不出现密钥值：把常见 token 形状抹成 ••••（vault 已经在正文里抹过一遍）。 */
export function redactSecretValues(text: string): string {
  return text
    .replace(/(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, "••••")
    .replace(/(?:gh[pousr]_|github_pat_|xox[baprs]-|glpat-|npm_|pypi-|AIza)[A-Za-z0-9_-]{8,}/g, "••••")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, "••••")
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, "••••");
}

function assertSecretPlaceholders(text: string, where: string) {
  for (const match of text.matchAll(SECRET_PLACEHOLDER_ANY)) {
    const name = (match[1] ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,38}[a-z0-9]$/.test(name))
      throw new LivePanelError(`${where}里的 {{secret:名字}} 写法不对：名字只能用小写字母、数字、- 和 _，2–40 个字符。`);
  }
}

function normalizeInterval(raw: unknown, name: string): number {
  if (raw === undefined || raw === null) return DEFAULT_SOURCE_INTERVAL_SEC;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) throw new LivePanelError(`数据源「${name}」的 intervalSec 要写数字（秒）。`);
  return Math.min(Math.max(Math.round(value), MIN_SOURCE_INTERVAL_SEC), MAX_SOURCE_INTERVAL_SEC);
}

function normalizeParse(raw: unknown, fallback: "json" | "text" | "number", name: string): "json" | "text" | "number" {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (raw === "json" || raw === "text" || raw === "number") return raw;
  throw new LivePanelError(`数据源「${name}」的 parse 只能是 json / text / number。`);
}

/** 规范里的展示串（DTO 用）：http 写 host + path（不含 query 里的密钥）；command 写命令原文。 */
export function sourceLabel(def: LivePanelDataSource): string {
  if (def.kind === "command") return (def.command ?? "").trim().slice(0, MAX_LABEL_CHARS);
  try {
    const url = new URL(def.url ?? "");
    return `${url.host}${url.pathname}`.slice(0, MAX_LABEL_CHARS);
  } catch {
    return (def.url ?? "").slice(0, MAX_LABEL_CHARS);
  }
}

/**
 * 把机器人交来的 dataSources 校验成可以存库的定义。
 *
 * 全部不合规都抛 {@link LivePanelError}（工具层会带上 REFUSAL_MARKER 退回给机器人）。宁可拒绝也不猜：
 * 明文密钥、内网地址、http 一旦存进数据库，后面的每一轮轮询都在替用户泄密 / 打内网。
 */
export function normalizeSources(raw: unknown, options: NormalizeSourcesOptions): LivePanelDataSource[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LivePanelError("dataSources 要给数组：每个数据源是一个对象。");
  if (raw.length > MAX_SOURCES_PER_PANEL)
    throw new LivePanelError(`一张面板最多 ${MAX_SOURCES_PER_PANEL} 个数据源（现在 ${raw.length} 个）：删掉不需要的。`);

  const env = options.env ?? process.env;
  const existingByName = new Map<string, string>();
  for (const old of options.existing ?? []) {
    const key = old.name?.trim().toLowerCase();
    if (key && /^src_[a-z0-9]+$/.test(old.id) && !existingByName.has(key)) existingByName.set(key, old.id);
  }

  // 生成的新 id 不能撞上任何一个旧源的 id（哪怕那个旧源这次被删掉了）。
  const existingIds = new Set((options.existing ?? []).map((source) => source.id));
  const usedNames = new Set<string>();
  const usedIds = new Set<string>();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new LivePanelError(`第 ${index + 1} 个数据源要是一个对象（kind / name / intervalSec…）。`);
    const record = entry as Record<string, unknown>;

    const name = typeof record.name === "string" ? record.name.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60) : "";
    if (!name) throw new LivePanelError(`第 ${index + 1} 个数据源要有名字（如 CoinGecko、本机 uptime）。`);
    const nameKey = name.toLowerCase();
    if (usedNames.has(nameKey)) throw new LivePanelError(`数据源名字重复了（「${name}」）：每个数据源用一个不同的名字，id 才能稳定。`);
    usedNames.add(nameKey);

    const intervalSec = normalizeInterval(record.intervalSec, name);
    const kind = record.kind;
    if (kind !== "http" && kind !== "command") throw new LivePanelError(`数据源「${name}」的 kind 要写 http 或 command。`);

    let id = existingByName.get(nameKey);
    if (!id || usedIds.has(id)) {
      do {
        id = `src_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      } while (usedIds.has(id) || existingIds.has(id));
    }
    usedIds.add(id);

    if (kind === "command") {
      if (env.CHISABOT_PANEL_COMMANDS !== "1")
        throw new LivePanelError(
          `数据源「${name}」要用本机命令：这个部署没有开启，需要管理员设置 CHISABOT_PANEL_COMMANDS=1 后才能用。`,
        );
      if (!options.isAdmin)
        throw new LivePanelError(
          `数据源「${name}」要用本机命令：只有管理员能加命令数据源（部署还要设置 CHISABOT_PANEL_COMMANDS=1）。`,
        );
      const command = typeof record.command === "string" ? record.command.trim() : "";
      if (!command) throw new LivePanelError(`数据源「${name}」是命令源，要在 command 里写本机命令（如 top -bn1）。`);
      if (command.length > MAX_COMMAND_CHARS)
        throw new LivePanelError(`数据源「${name}」的命令太长（最多 ${MAX_COMMAND_CHARS} 个字符）。`);
      if (command.includes("\0")) throw new LivePanelError(`数据源「${name}」的命令里有控制字符，改一下。`);
      return {
        id,
        kind,
        name,
        intervalSec,
        command: command.slice(0, MAX_COMMAND_CHARS),
        parse: normalizeParse(record.parse, "text", name),
      };
    }

    if (typeof record.url !== "string" || !record.url.trim())
      throw new LivePanelError(`数据源「${name}」是 http 源，要写 url（完整的 https 网址）。`);
    const rawUrl = record.url.trim();
    if (rawUrl.length > MAX_URL_CHARS) throw new LivePanelError(`数据源「${name}」的网址太长（最多 ${MAX_URL_CHARS} 个字符）。`);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new LivePanelError(`数据源「${name}」的网址不是有效网址。`);
    }
    if (url.protocol !== "https:") throw new LivePanelError(`数据源「${name}」的网址只支持 https（明文 http 会被中间人看到）。`);
    if (url.username || url.password) throw new LivePanelError(`数据源「${name}」的网址里不能带账号密码。`);
    const verdict = checkPublicUrl(url.toString());
    if (!verdict.ok) throw new LivePanelError(`数据源「${name}」的网址不能用：${verdict.reason}。`);
    assertSecretPlaceholders(rawUrl, `数据源「${name}」的网址`);
    if (looksLikePlaintextSecret(rawUrl))
      throw new LivePanelError(
        `数据源「${name}」的网址里像是写了明文密钥：改用 {{secret:名字}}（先在「设置 → 密钥」里存好），明文密钥不能存进面板。`,
      );
    // new URL() 会把路径里的花括号编码成 %7B…%7D，vault 就找不到 {{secret:名}} 了：把占位符还原成原文。
    const storedUrl = url.toString().replace(/%7B%7B(secret:[^%]*)%7D%7D/gi, "{{$1}}");

    const methodRaw = record.method === undefined ? "GET" : String(record.method).trim().toUpperCase();
    if (methodRaw !== "GET" && methodRaw !== "POST") throw new LivePanelError(`数据源「${name}」的 method 只能是 GET 或 POST。`);
    const method = methodRaw as "GET" | "POST";

    let headers: Record<string, string> | undefined;
    if (record.headers !== undefined) {
      if (!record.headers || typeof record.headers !== "object" || Array.isArray(record.headers))
        throw new LivePanelError(`数据源「${name}」的 headers 要是一个对象（请求头名 → 值）。`);
      const entries = Object.entries(record.headers as Record<string, unknown>);
      if (entries.length > MAX_HEADERS) throw new LivePanelError(`数据源「${name}」的请求头太多（最多 ${MAX_HEADERS} 条）。`);
      const cleaned: Record<string, string> = {};
      for (const [rawKey, rawValue] of entries) {
        const key = rawKey.trim();
        if (!key || key.length > MAX_HEADER_KEY_CHARS || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key))
          throw new LivePanelError(`数据源「${name}」有不合法的请求头名「${rawKey.slice(0, 40)}」。`);
        if (typeof rawValue !== "string") throw new LivePanelError(`数据源「${name}」的请求头 ${key} 的值要写字符串。`);
        const value = rawValue.trim();
        if (/[\r\n]/.test(value)) throw new LivePanelError(`数据源「${name}」的请求头 ${key} 里有换行，改一下。`);
        if (value.length > MAX_HEADER_VALUE_CHARS) throw new LivePanelError(`数据源「${name}」的请求头 ${key} 太长。`);
        assertSecretPlaceholders(value, `数据源「${name}」的请求头 ${key}`);
        if (looksLikePlaintextSecret(value))
          throw new LivePanelError(
            `数据源「${name}」的请求头 ${key} 里像是写了明文密钥：改用 {{secret:名字}}（先在「设置 → 密钥」里存好），明文密钥不能存进面板。`,
          );
        cleaned[key] = value;
      }
      if (Object.keys(cleaned).length) headers = cleaned;
    }

    let body: string | undefined;
    if (record.body !== undefined) {
      if (typeof record.body !== "string") throw new LivePanelError(`数据源「${name}」的 body 要写字符串。`);
      if (record.body.length > MAX_BODY_CHARS) throw new LivePanelError(`数据源「${name}」的 body 太长（最多 ${MAX_BODY_CHARS} 个字符）。`);
      if (method === "GET" && record.body.trim()) throw new LivePanelError(`数据源「${name}」是 GET，不能带 body：改用 POST。`);
      assertSecretPlaceholders(record.body, `数据源「${name}」的 body`);
      if (looksLikePlaintextSecret(record.body, { genericTokens: false }))
        throw new LivePanelError(
          `数据源「${name}」的 body 里像是写了明文密钥：改用 {{secret:名字}}（先在「设置 → 密钥」里存好），明文密钥不能存进面板。`,
        );
      body = record.body;
    }

    return {
      id,
      kind,
      name,
      intervalSec,
      url: storedUrl,
      method,
      ...(headers ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      parse: normalizeParse(record.parse, "json", name),
    };
  });
}

// ---------------------------------------------------------------------------
// 执行一次取数
// ---------------------------------------------------------------------------

export type LivePanelRequestHttp = (
  owner: string,
  input: { method: string; url: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal,
) => Promise<{ status: number; contentType?: string; body: string; truncated?: boolean }>;

export type LivePanelCommandRunner = (
  command: string,
  context: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ stdout: string; stderr?: string; exitCode?: number }>;

export type LivePanelSourceDeps = {
  /** 由 index.ts 注入保险箱的 request（`{{secret:名}}`、域名绑定、guardedFetch、抹密钥都在那里）。 */
  requestHttp?: LivePanelRequestHttp;
  /** 测试注入；正式部署直接用 Bun.spawn 跑本机命令。 */
  commandRunner?: LivePanelCommandRunner;
};

export type ReadSourceContext = {
  owner: string;
  signal?: AbortSignal;
  /** 命令源只给管理员：路由会把当前 actor 的角色带进来，别只信保存时的校验。 */
  isAdmin?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** 底层错误一律转成中文：英文的 fetch failed 对用户没有意义，也不会泄露请求头。 */
function describeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error ?? "");
  if (error instanceof Error && error.name === "AbortError") message = "取数超时或已取消";
  if (!message.trim()) message = "取数失败";
  if (!/[\u4e00-\u9fff]/.test(message)) {
    if (/abort|timeout|timed out/i.test(message)) message = `取数超时（${SOURCE_HTTP_TIMEOUT_MS / 1_000} 秒）`;
    else if (/fetch failed|network|connect|socket|dns|resolve|ENOTFOUND|ECONN/i.test(message)) message = "网络请求失败：接口没有响应。";
    else message = "取数失败：数据源没有返回可用的数据。";
  }
  return clip(redactSecretValues(message.trim()), MAX_ERROR_CHARS);
}

/** 解析返回值：json 整段 / text 原文 / number 原文里的一个数。 */
function parseSourceValue(definition: LivePanelDataSource, body: string, truncated: boolean): unknown {
  const parse = definition.parse ?? (definition.kind === "command" ? "text" : "json");
  if (parse === "text") return body.slice(0, SOURCE_VALUE_MAX_CHARS);
  if (parse === "number") {
    const match = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(body);
    if (!match) throw new Error("返回的内容里没有一个数字，parse: number 读不出来。");
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("返回的内容里的数字无效。");
    return value;
  }
  try {
    const value = JSON.parse(body) as unknown;
    const size = JSON.stringify(value)?.length ?? 0;
    if (size > SOURCE_VALUE_MAX_CHARS)
      throw new Error(`返回的数据太大（${size} 个字符，最多 ${SOURCE_VALUE_MAX_CHARS}）：只取需要的字段，或改用 text。`);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("返回的数据太大")) throw error;
    throw new Error(
      truncated
        ? "返回的 JSON 太长被截断了，读不出来：换一个更小的接口，或用 parse: text / number。"
        : "返回的内容不是合法 JSON：检查网址是否返回 JSON，或把 parse 改成 text / number。",
    );
  }
}

function combineSignals(caller: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { signal: caller ? AbortSignal.any([caller, timeout]) : timeout, timeout };
}

async function readHttp(definition: LivePanelDataSource, deps: LivePanelSourceDeps, context: ReadSourceContext): Promise<unknown> {
  if (!deps.requestHttp) throw new Error("服务器没有接通直连取数通道（面板数据源暂时不可用）。");
  if (!definition.url) throw new Error("这个 http 数据源没有网址。");
  const { signal, timeout } = combineSignals(context.signal, SOURCE_HTTP_TIMEOUT_MS);
  let response: Awaited<ReturnType<LivePanelRequestHttp>>;
  try {
    response = await deps.requestHttp(
      context.owner,
      {
        method: definition.method ?? "GET",
        url: definition.url,
        ...(definition.headers ? { headers: definition.headers } : {}),
        ...(definition.body !== undefined ? { body: definition.body } : {}),
      },
      signal,
    );
  } catch (error) {
    if (context.signal?.aborted) throw new Error("面板已经关闭，这次取数取消了。");
    if (timeout.aborted) throw new Error(`接口 ${SOURCE_HTTP_TIMEOUT_MS / 1_000} 秒没有响应。`);
    throw error;
  }
  if (!Number.isFinite(response.status) || response.status < 200 || response.status >= 300)
    throw new Error(`接口返回 HTTP ${response.status}，没有取到数据。`);
  return parseSourceValue(definition, response.body ?? "", Boolean(response.truncated));
}

/** 去掉终端颜色 / 光标控制 / 进度条回车，免得状态列里出现一堆乱码。 */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** 读一段子进程输出，最多 SOURCE_COMMAND_OUTPUT_MAX_BYTES；超了就停（同时停掉子进程，别让它继续写）。 */
async function readCapped(stream: ReadableStream<Uint8Array> | undefined, onLimit: () => void) {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > SOURCE_COMMAND_OUTPUT_MAX_BYTES) {
        text += decoder.decode(value.subarray(0, Math.max(0, SOURCE_COMMAND_OUTPUT_MAX_BYTES - bytes)), { stream: true });
        truncated = true;
        onLimit();
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}

/** 在本机执行命令：Windows 走 cmd /c，其他平台 sh -c；5 秒超时，输出最多 64 KB。 */
async function spawnCommand(command: string, signal: AbortSignal, env: Record<string, string | undefined>) {
  const args = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command];
  const child = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  let timedOut = false;
  let aborted = false;
  let outputCapped = false;
  const kill = () => {
    try {
      child.kill();
    } catch {
      // 进程已经结束
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, SOURCE_COMMAND_TIMEOUT_MS);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr] = await Promise.all([
      readCapped(child.stdout as ReadableStream<Uint8Array>, () => {
        outputCapped = true;
        kill();
      }),
      readCapped(child.stderr as ReadableStream<Uint8Array>, () => {
        outputCapped = true;
        kill();
      }),
    ]);
    const exitCode = await child.exited;
    if (timedOut) throw new Error(`命令 ${SOURCE_COMMAND_TIMEOUT_MS / 1_000} 秒内没有结束，已停止。`);
    if (aborted) throw new Error("已取消");
    return { stdout: stdout.text, stderr: stderr.text, exitCode: outputCapped ? 0 : exitCode };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function readCommand(definition: LivePanelDataSource, deps: LivePanelSourceDeps, context: ReadSourceContext): Promise<unknown> {
  const env = context.env ?? process.env;
  if (env.CHISABOT_PANEL_COMMANDS !== "1")
    throw new Error("这个部署没有开启本机命令数据源：需要管理员设置 CHISABOT_PANEL_COMMANDS=1。");
  // 保存时已经查过管理员；路由会再把当前角色带进来，明确不是管理员才拒（undefined = 内部调用 / 测试）。
  if (context.isAdmin === false) throw new Error("只有管理员能使用本机命令数据源（部署还要设置 CHISABOT_PANEL_COMMANDS=1）。");
  const command = (definition.command ?? "").trim();
  if (!command) throw new Error("这个命令数据源没有写命令。");
  const { signal, timeout } = combineSignals(context.signal, SOURCE_COMMAND_TIMEOUT_MS);
  let result: Awaited<ReturnType<LivePanelCommandRunner>>;
  try {
    result = deps.commandRunner
      ? await deps.commandRunner(command, { signal, timeoutMs: SOURCE_COMMAND_TIMEOUT_MS })
      : await spawnCommand(command, signal, env);
  } catch (error) {
    if (context.signal?.aborted) throw new Error("面板已经关闭，这次取数取消了。");
    if (timeout.aborted) throw new Error(`命令 ${SOURCE_COMMAND_TIMEOUT_MS / 1_000} 秒内没有结束。`);
    throw error;
  }
  const stderr = stripAnsi(result.stderr ?? "").trim();
  if (result.exitCode !== undefined && result.exitCode !== 0)
    throw new Error(`命令执行失败（退出码 ${result.exitCode}）${stderr ? `：${stderr.slice(0, 160)}` : "。"}`);
  return parseSourceValue(definition, stripAnsi(result.stdout ?? ""), false);
}

/**
 * 取一次数。不抛错：任何失败都变成 `{ ok:false, error: 中文原因 }`，由前端在来源那一行标红。
 * 密钥值不会出现在返回值里（HTTP 正文由保险箱 request 抹过；错误信息这里再抹一遍）。
 */
export async function readSource(
  definition: LivePanelDataSource,
  deps: LivePanelSourceDeps,
  context: ReadSourceContext,
): Promise<LivePanelSourceReading> {
  const now = context.now ?? (() => new Date());
  const started = Date.now();
  try {
    const value = definition.kind === "command" ? await readCommand(definition, deps, context) : await readHttp(definition, deps, context);
    return { ok: true, value, at: now().toISOString(), ms: Math.max(0, Date.now() - started) };
  } catch (error) {
    return { ok: false, value: null, error: describeError(error), at: now().toISOString(), ms: Math.max(0, Date.now() - started) };
  }
}

// ---------------------------------------------------------------------------
// 缓存 / 单飞 / 写回 source_state
// ---------------------------------------------------------------------------

export type LivePanelSourceRunnerStore = {
  /** 写回前重新读一次最新读数用；只实现 setSourceState 的测试替身可以不给。 */
  get?(
    owner: string,
    id: string,
  ): Promise<{ dataSources?: LivePanelDataSource[] | null; sourceState?: LivePanelSourceState | null } | null | undefined>;
  /** 只改 source_state + updated_at，不动 refreshed_at（panel 的机器人回合刷新时间）。 */
  setSourceState(owner: string, id: string, state: LivePanelSourceState): Promise<void>;
};

export type LivePanelSourceRunnerRow = {
  id: string;
  dataSources?: LivePanelDataSource[] | null;
  sourceState?: LivePanelSourceState | null;
};

export type LivePanelSourceReadings = {
  sources: Record<string, LivePanelSourceReading>;
  /** 这次真的取过的源 id（前端用它做一次闪动；缓存返回的不在里面）。 */
  refreshed: string[];
};

export type LivePanelReadingsOptions = {
  force?: boolean;
  signal?: AbortSignal;
  isAdmin?: boolean;
  env?: Record<string, string | undefined>;
};

export type CreateSourceRunnerInput = {
  store: LivePanelSourceRunnerStore;
  deps: LivePanelSourceDeps;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
};

/**
 * 一张面板的取数器：按每个源自己的 intervalSec 判断新鲜度，过期的取一次，最多 3 个并发；
 * 同一个源同时只跑一次（浏览器可见时轮询 + 用户点「立即取数」不会叠成两次请求）。
 */
export function createSourceRunner(input: CreateSourceRunnerInput) {
  const now = input.now ?? (() => new Date());
  const log = input.log ?? (() => {});
  const inflight = new Map<string, Promise<LivePanelSourceReading>>();
  /** 同一个源的读数串行写回，避免两个源同时完成时后写的把先写的覆盖掉。 */
  const writeQueues = new Map<string, Promise<void>>();
  let active = 0;
  const waiting: (() => void)[] = [];

  async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= MAX_SOURCES_PER_PANEL) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  function isFresh(reading: LivePanelSourceReading | undefined, intervalSec: number, at: number) {
    if (!reading) return false;
    const time = Date.parse(reading.at);
    if (!Number.isFinite(time)) return false;
    return at - time < Math.max(intervalSec, MIN_SOURCE_INTERVAL_SEC) * 1_000;
  }

  async function persist(owner: string, panelId: string, sourceId: string, reading: LivePanelSourceReading) {
    const key = `${owner}:${panelId}`;
    const previousWrite = writeQueues.get(key) ?? Promise.resolve();
    let write: Promise<void>;
    write = previousWrite
      .catch(() => {})
      .then(async () => {
        // 重新读一次最新状态：别的源 / 别的进程可能刚写过。
        const latest = input.store.get ? await input.store.get(owner, panelId).catch(() => null) : null;
        const state = latest?.sourceState ?? {};
        await input.store.setSourceState(owner, panelId, { ...state, [sourceId]: reading });
      })
      .catch((error) => log({ type: "live-panel-source-state-failed", panelId, sourceId, reason: describeError(error) }))
      .finally(() => {
        // 队列空了就把 key 拿掉，长进程里面板来来回回也不会攒一堆已完成的 promise。
        if (writeQueues.get(key) === write) writeQueues.delete(key);
      });
    writeQueues.set(key, write);
    await write;
  }

  /**
   * 返回 `{ sources, refreshed }`：`sources` 是每个源当前的读数（缓存或刚取的）；
   * 取数失败也照常返回（200 + 读数里的 error），前端保留上一次的好值、把来源那一行标红。
   */
  async function readings(owner: string, row: LivePanelSourceRunnerRow, options: LivePanelReadingsOptions = {}): Promise<LivePanelSourceReadings> {
    const definitions = row.dataSources ?? [];
    const cached = row.sourceState ?? {};
    const time = now().getTime();
    const result: Record<string, LivePanelSourceReading> = {};
    const fetched = new Set<string>();

    await Promise.all(
      definitions.map(async (definition) => {
        const previous = cached[definition.id];
        if (!options.force && isFresh(previous, definition.intervalSec, time)) {
          result[definition.id] = previous!;
          return;
        }
        const key = `${owner}:${row.id}:${definition.id}`;
        let running = inflight.get(key);
        if (!running) {
          running = limited(() =>
            readSource(definition, input.deps, {
              owner,
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.isAdmin !== undefined ? { isAdmin: options.isAdmin } : {}),
              ...(options.env ? { env: options.env } : {}),
              now,
            }),
          )
            .then(async (raw) => {
              // 失败不覆盖上一次的好值：卡片上保留旧数字，旁边标红说明为什么没更新。
              const reading: LivePanelSourceReading =
                raw.ok || previous?.value === undefined ? raw : { ...raw, value: previous.value };
              await persist(owner, row.id, definition.id, reading);
              log({
                type: "live-panel-source",
                panelId: row.id,
                sourceId: definition.id,
                kind: definition.kind,
                ok: reading.ok,
                ms: reading.ms,
                ...(reading.ok ? {} : { error: reading.error }),
              });
              return reading;
            })
            .finally(() => inflight.delete(key));
          inflight.set(key, running);
        }
        result[definition.id] = await running;
        fetched.add(definition.id);
      }),
    );

    const sources: Record<string, LivePanelSourceReading> = {};
    for (const definition of definitions) {
      const reading = result[definition.id];
      if (reading) sources[definition.id] = reading;
    }
    return { sources, refreshed: definitions.map((definition) => definition.id).filter((id) => fetched.has(id)) };
  }

  return { readings };
}

export type LivePanelSourceRunner = ReturnType<typeof createSourceRunner>;
