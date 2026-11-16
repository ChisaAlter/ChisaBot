"use strict";
/**
 * 登录与设备登记（docs/pc-node.md §4）。
 *
 * 1. 账号密码登录：先试 ChisaBot 网关登录（POST /auth/login，deploy/public 这种带登录网关的部署），
 *    404 时退回 Better Auth（POST /api/auth/sign-in/email）。拿到会话 Cookie。
 * 2. 用会话 Cookie 调 POST /api/devices/enroll，拿到这台电脑专属、可撤销的设备令牌（只返回一次）。
 * 会话 Cookie 之后只用于聊天窗口；节点连接只用设备令牌。
 */

function parseIpv4Octets(host) {
  const parts = String(host || "").split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  return octets;
}

/**
 * 识别本地回环、RFC1918 局域网与 Tailscale（100.64.0.0/10、*.ts.net、fd7a:115c:a1e0::/48）。
 */
function isTailscaleOrLanHost(host) {
  const clean = String(host || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  if (!clean) return false;
  if (clean === "localhost" || clean.endsWith(".local")) return true;
  if (clean.endsWith(".ts.net") && clean.length > ".ts.net".length) return true;
  if (clean.includes(":")) {
    return (
      clean === "::1" ||
      clean.startsWith("fe80:") ||
      clean.startsWith("fc") ||
      clean.startsWith("fd")
    );
  }
  const octets = parseIpv4Octets(clean);
  if (!octets) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function normalizeServerUrl(input) {
  let text = String(input || "")
    .trim()
    .replace(/\/+$/, "");
  if (!text) throw new Error("请填写服务器地址。");
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      "服务器地址格式不对，例如 https://chisabot.example.com:8443",
    );
  }
  if (url.protocol !== "https:" && !isTailscaleOrLanHost(url.hostname))
    throw new Error(
      "服务器地址必须是 https（局域网、本机或 Tailscale 地址可使用 http）。",
    );
  if (url.username || url.password)
    throw new Error("服务器地址里不能包含账号密码。");
  return url.origin;
}

/** 解析配对二维码 URI（chisabot://pair?server=...&code=...&alt=...&pk=...）。 */
function parsePairingUri(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) throw new Error("绑定二维码内容为空。");
  let uri;
  try {
    uri = new URL(raw);
  } catch {
    throw new Error("无效的绑定二维码地址。");
  }
  if (uri.protocol !== "chisabot:" || uri.hostname !== "pair") {
    throw new Error("不是 ChisaBot 设备绑定二维码。");
  }
  const serverRaw = uri.searchParams.get("server") || "";
  const code = (uri.searchParams.get("code") || "").trim();
  if (!serverRaw || !code) {
    throw new Error("绑定二维码缺少服务器地址或配对码。");
  }
  const server = normalizeServerUrl(serverRaw);
  const altParams = uri.searchParams.getAll("alt");
  const alternates = [];
  const seen = new Set([server]);
  for (const item of altParams) {
    for (const piece of item.split(",")) {
      const candidate = piece.trim();
      if (!candidate) continue;
      try {
        const normalized = normalizeServerUrl(candidate);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          alternates.push(normalized);
        }
      } catch {
        // 忽略无效的备选地址条目，不阻断主地址使用。
      }
    }
  }
  const e2eePub = (uri.searchParams.get("pk") || "").trim() || null;
  return { server, code, alternates, e2eePub };
}

function parseSetCookies(headers) {
  const list =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const cookies = [];
  for (const line of list) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const cookie = { name, value };
    for (const attr of attrs) {
      const [k, v] = attr.trim().split("=");
      const key = k.toLowerCase();
      if (key === "max-age") cookie.maxAge = Number(v);
      if (key === "expires") cookie.expires = Date.parse(v);
      if (key === "httponly") cookie.httpOnly = true;
      if (key === "secure") cookie.secure = true;
      if (key === "path") cookie.path = v;
      if (key === "samesite") cookie.sameSite = (v || "").toLowerCase();
    }
    if (value) cookies.push(cookie);
  }
  return cookies;
}

async function readError(response, fallback) {
  try {
    const body = await response.json();
    return body.error || body.message || fallback;
  } catch {
    return fallback;
  }
}

/** 带错误码的错误：kind = unreachable | cert | auth | rate | invalid | server。登录页按它把提示放到对应输入框旁。 */
function loginError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

const CERT_CODES =
  /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|SSL|HOSTNAME_MISMATCH|ALTNAME/i;

/** fetch 抛出的网络错误 → 中文：证书错误 / 地址无法连接。 */
function networkError(error) {
  const code = String(
    error?.cause?.code ||
      error?.code ||
      error?.cause?.message ||
      error?.message ||
      "",
  );
  if (CERT_CODES.test(code))
    return loginError(
      "cert",
      `证书错误：服务器的 HTTPS 证书无效或不受信任（${code}）。`,
    );
  if (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    /TIMEOUT/i.test(code)
  )
    return loginError("unreachable", "地址无法连接：服务器没有响应（超时）。");
  if (/ENOTFOUND|EAI_AGAIN/i.test(code))
    return loginError(
      "unreachable",
      "地址无法连接：找不到这个域名，请检查拼写。",
    );
  if (/ECONNREFUSED/i.test(code))
    return loginError(
      "unreachable",
      "地址无法连接：服务器拒绝连接，请检查端口。",
    );
  return loginError(
    "unreachable",
    `地址无法连接${code ? `（${code}）` : ""}，请检查地址和网络。`,
  );
}

/**
 * 登录前先看地址通不通：登录网关的 /auth/session（不需要登录）→ /health → /api/version。
 * 只要服务器有 HTTP 回应（含 401）就算连得上。返回 { origin, gateway, authenticated }。
 */
async function probe({
  serverUrl,
  cookieHeader = "",
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const origin = normalizeServerUrl(serverUrl);
  let lastError = null;
  for (const pathname of ["/auth/session", "/health", "/api/version"]) {
    let response;
    try {
      response = await fetchImpl(`${origin}${pathname}`, {
        headers: {
          Accept: "application/json",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = networkError(error);
      if (lastError.kind === "cert" || lastError.kind === "unreachable")
        throw lastError;
      continue;
    }
    if (pathname === "/auth/session" && response.ok) {
      const body = await response.json().catch(() => null);
      if (body && typeof body.authenticated === "boolean")
        return { origin, gateway: true, authenticated: body.authenticated };
    }
    if (response.status < 500 && response.status !== 404)
      return { origin, gateway: false, authenticated: null };
    if (response.status >= 500)
      lastError = loginError(
        "server",
        `服务器暂时不可用（${response.status}），请稍后再试。`,
      );
  }
  throw (
    lastError ||
    loginError(
      "invalid",
      "这个地址能打开，但不像 ChisaBot 服务器，请检查地址。",
    )
  );
}

/**
 * 探测主地址并在不可达时自动按顺序回退备选地址（局域网 / Tailscale 等）；HTTPS 地址始终优先排在同一档前面。
 */
async function probeWithFallback({
  serverUrl,
  alternates = [],
  cookieHeader = "",
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (raw) => {
    try {
      const origin = normalizeServerUrl(raw);
      if (!seen.has(origin)) {
        seen.add(origin);
        candidates.push(origin);
      }
    } catch {
      // 忽略单个无效备选地址
    }
  };
  pushCandidate(serverUrl);
  const httpsAlts = [];
  const httpAlts = [];
  for (const alt of Array.isArray(alternates) ? alternates : []) {
    try {
      const origin = normalizeServerUrl(alt);
      if (origin.startsWith("https://")) httpsAlts.push(origin);
      else httpAlts.push(origin);
    } catch {}
  }
  for (const origin of [...httpsAlts, ...httpAlts]) {
    if (!seen.has(origin)) {
      seen.add(origin);
      candidates.push(origin);
    }
  }
  if (candidates.length === 0) {
    normalizeServerUrl(serverUrl);
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await probe({
        serverUrl: candidate,
        cookieHeader,
        fetchImpl,
        timeoutMs,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw (
    lastError || loginError("unreachable", "所有候选服务器地址均无法连接。")
  );
}

async function login({
  serverUrl,
  username,
  password,
  remember = true,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const origin = normalizeServerUrl(serverUrl);
  if (!username || !password) throw loginError("auth", "请填写账号和密码。");
  const headers = {
    "Content-Type": "application/json",
    Origin: origin,
    Accept: "application/json",
  };
  let response;
  let mode = "gateway";
  try {
    response = await fetchImpl(`${origin}/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username, password, remember: remember === true }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404 || response.status === 405) {
      response = await fetchImpl(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: username,
          password,
          rememberMe: remember === true,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      mode = "better-auth";
    }
  } catch (error) {
    throw networkError(error);
  }
  if (response.status === 429)
    throw loginError("rate", "尝试次数过多，请稍后再试。");
  if (response.status === 401 || response.status === 400)
    throw loginError("auth", "账号或密码错误。");
  if (response.status === 403)
    throw loginError(
      "invalid",
      await readError(
        response,
        "服务器拒绝了这次登录（来源不匹配），请确认地址和浏览器里打开的完全一致。",
      ),
    );
  if (response.status >= 500)
    throw loginError(
      "server",
      `服务器暂时不可用（${response.status}），请稍后再试。`,
    );
  if (!response.ok)
    throw loginError(
      "invalid",
      await readError(response, `登录失败（${response.status}）。`),
    );
  const cookies = parseSetCookies(response.headers);
  if (!cookies.length)
    throw loginError(
      "invalid",
      "登录成功但服务器没有返回会话，请检查服务器地址。",
    );
  return {
    origin,
    mode,
    cookies,
    cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
  };
}

/** 退出网页登录（网关会话作废）。失败不影响本机清除。 */
async function logoutSession({
  serverUrl,
  cookieHeader,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const origin = normalizeServerUrl(serverUrl);
  const response = await fetchImpl(`${origin}/auth/logout`, {
    method: "POST",
    headers: {
      Origin: origin,
      Accept: "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.ok;
}

async function enroll({
  serverUrl,
  cookieHeader,
  info,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const origin = normalizeServerUrl(serverUrl);
  const response = await fetchImpl(`${origin}/api/devices/enroll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Accept: "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify(info || {}),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) throw new Error("登录已失效，请重新登录。");
  if (response.status === 404)
    throw new Error(
      "这台服务器的 ChisaBot 版本还不支持 PC 设备，请先升级服务器。",
    );
  if (!response.ok)
    throw new Error(
      await readError(response, `登记设备失败（${response.status}）。`),
    );
  const body = await response.json();
  if (!body.token || !body.device)
    throw new Error("服务器返回的登记结果无效。");
  return body;
}

async function checkToken({
  serverUrl,
  token,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const origin = normalizeServerUrl(serverUrl);
  const response = await fetchImpl(`${origin}/api/devices/agent/self`, {
    headers: {
      "X-Device-Token": token,
      Origin: origin,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) {
    const body = await response.json().catch(() => ({}));
    return {
      ok: false,
      revoked: body.revoked === true,
      invalid: body.revoked !== true,
    };
  }
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, device: (await response.json()).device };
}

async function unenroll({
  serverUrl,
  token,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const origin = normalizeServerUrl(serverUrl);
  const response = await fetchImpl(`${origin}/api/devices/agent/unenroll`, {
    method: "POST",
    headers: {
      "X-Device-Token": token,
      Origin: origin,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.ok;
}

module.exports = {
  normalizeServerUrl,
  isTailscaleOrLanHost,
  parsePairingUri,
  parseSetCookies,
  networkError,
  probe,
  probeWithFallback,
  login,
  logoutSession,
  enroll,
  checkToken,
  unenroll,
};
