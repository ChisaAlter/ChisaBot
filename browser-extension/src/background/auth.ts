import { BROWSER_EXTENSION_PLATFORM } from "../../../shared/devices";
import type { ChromeApi } from "../types/chrome";
import type {
  CompanionAuthRecord,
  DetectedChisaBotTab,
} from "../types/protocol";

/**
 * 扩展登录与设备认领模块：
 * 1. 自动探测当前浏览器已登录的 ChisaBot 网页标签页 -> 同源调用 POST /api/devices/enroll 一键免密认领；
 * 2. 服务器地址 + 账号密码 -> POST /auth/login（404/405 回退 /api/auth/sign-in/email）-> POST /api/devices/enroll；
 * 3. 服务器地址 + 一次性配对码 cbp_...（支持 chisabot://pair?... URI）-> POST /api/devices/agent/pair。
 */

function parseIpv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  return octets;
}

export function isTailscaleOrLanHost(host: string): boolean {
  const clean = host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
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
  if (a === undefined || b === undefined) return false;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function normalizeServerUrl(input: string): string {
  let text = input.trim().replace(/\/+$/, "");
  if (!text) throw new Error("请填写服务器地址。");
  if (!/^https?:\/\//i.test(text)) {
    const hostPart = text.split("/")[0]?.split(":")[0] ?? "";
    const proto = isTailscaleOrLanHost(hostPart) ? "http://" : "https://";
    text = `${proto}${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      "服务器地址格式不对，例如 https://chisabot.example.com:8443",
    );
  }
  if (url.protocol !== "https:" && !isTailscaleOrLanHost(url.hostname)) {
    throw new Error(
      "公网服务器地址必须使用 https（本机、局域网或 Tailscale 地址可使用 http）。",
    );
  }
  if (url.username || url.password) {
    throw new Error("服务器地址里不能包含账号密码。");
  }
  return url.origin;
}

export function parsePairingInput(
  rawServerUrl: string,
  rawCodeOrUri: string,
): { serverUrl: string; code: string } {
  const trimmedCode = rawCodeOrUri.trim();
  if (trimmedCode.toLowerCase().startsWith("chisabot://pair")) {
    let uri: URL;
    try {
      uri = new URL(trimmedCode);
    } catch {
      throw new Error("绑定链接格式无效。");
    }
    const serverParam = uri.searchParams.get("server") ?? rawServerUrl;
    const codeParam = (uri.searchParams.get("code") ?? "").trim();
    if (!codeParam) throw new Error("绑定链接里缺少配对码。");
    return {
      serverUrl: normalizeServerUrl(serverParam),
      code: codeParam,
    };
  }

  if (!trimmedCode) {
    throw new Error("请填写一次性配对码（以 cbp_ 开头）。");
  }
  if (!/^cbp_[A-Za-z0-9_-]{20,}$/.test(trimmedCode)) {
    throw new Error("配对码格式不正确，请从网页「设置 → 设备」重新复制。");
  }
  return {
    serverUrl: normalizeServerUrl(rawServerUrl),
    code: trimmedCode,
  };
}

function detectBrowserDeviceName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Edg\//.test(ua)) return "Edge 浏览器伴侣";
  if (/Chrome\//.test(ua)) return "Chrome 浏览器伴侣";
  return "ChisaBot 浏览器伴侣";
}

function extensionVersion(api: ChromeApi): string {
  try {
    return api.runtime.getManifest().version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // 忽略非 JSON 错误体
  }
  return fallback;
}

export interface AuthDependencies {
  chromeApi?: ChromeApi;
  fetchImpl?: typeof fetch;
}

export function createExtensionAuth(deps: AuthDependencies = {}) {
  const api = deps.chromeApi ?? chrome;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  function buildEnrollPayload() {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const browserMatch = ua.match(/(Edg|Chrome)\/([\d.]+)/);
    const osVersion = browserMatch
      ? `${browserMatch[1] === "Edg" ? "Edge" : "Chrome"} ${browserMatch[2]}`
      : "Chromium";
    return {
      name: detectBrowserDeviceName(),
      platform: BROWSER_EXTENSION_PLATFORM,
      osVersion,
      hostname:
        browserMatch?.[1] === "Edg" ? "Microsoft Edge" : "Google Chrome",
      clientVersion: extensionVersion(api),
    };
  }

  /**
   * 方式一（探测）：扫描当前浏览器已打开的 http/https 标签页，
   * 对疑似 ChisaBot 页面在页面同源上下文内做只读探测，返回已登录的候选标签页列表。
   */
  async function detectSignedInChisaBotTabs(): Promise<DetectedChisaBotTab[]> {
    const tabs = await api.tabs.query({});
    const seenOrigins = new Set<string>();
    const candidates: Array<{ tabId: number; origin: string; title: string }> =
      [];

    for (const tab of tabs) {
      if (typeof tab.id !== "number") continue;
      const rawUrl = tab.url ?? tab.pendingUrl ?? "";
      if (!/^https?:\/\//i.test(rawUrl)) continue;
      let origin = "";
      try {
        origin = new URL(rawUrl).origin;
      } catch {
        continue;
      }
      if (seenOrigins.has(origin)) continue;
      const title = tab.title ?? "";
      // 优先检查标题含 ChisaBot、本机/局域网端口、或最近活跃页
      const looksLikely =
        /chisabot/i.test(title) ||
        /chisabot/i.test(origin) ||
        tab.active ||
        isTailscaleOrLanHost(new URL(origin).hostname);
      if (!looksLikely) continue;
      seenOrigins.add(origin);
      candidates.push({ tabId: tab.id, origin, title });
    }

    const detected: DetectedChisaBotTab[] = [];
    for (const candidate of candidates.slice(0, 6)) {
      try {
        const results = await api.scripting.executeScript<
          {
            isChisaBot: boolean;
            authenticated: boolean;
            userName?: string;
          },
          []
        >({
          target: { tabId: candidate.tabId },
          func: async () => {
            const probeJson = async (pathname: string) => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 2500);
              try {
                const resp = await fetch(pathname, {
                  credentials: "include",
                  headers: { Accept: "application/json" },
                  signal: controller.signal,
                });
                if (!resp.ok)
                  return { ok: false, status: resp.status, body: null };
                const body = await resp.json().catch(() => null);
                return { ok: true, status: resp.status, body };
              } catch {
                return { ok: false, status: 0, body: null };
              } finally {
                clearTimeout(timer);
              }
            };

            const ver = await probeJson("/api/version");
            const verBody = ver.body as Record<string, unknown> | null;
            const looksChisa = Boolean(
              verBody &&
                (typeof verBody.version === "string" ||
                  typeof verBody.gatewayIdentity === "boolean"),
            );
            if (!looksChisa) {
              const sess = await probeJson("/auth/session");
              const sessBody = sess.body as Record<string, unknown> | null;
              if (!sessBody || typeof sessBody.authenticated !== "boolean") {
                return { isChisaBot: false, authenticated: false };
              }
              return {
                isChisaBot: true,
                authenticated: sessBody.authenticated === true,
                userName:
                  typeof sessBody.name === "string"
                    ? sessBody.name
                    : typeof sessBody.username === "string"
                      ? sessBody.username
                      : undefined,
              };
            }

            // 探测登录态：网关 /auth/session 或 Better Auth /api/auth/get-session 或 /api/devices
            const sess = await probeJson("/auth/session");
            const sessBody = sess.body as Record<string, unknown> | null;
            if (sessBody && typeof sessBody.authenticated === "boolean") {
              return {
                isChisaBot: true,
                authenticated: sessBody.authenticated === true,
                userName:
                  typeof sessBody.name === "string"
                    ? sessBody.name
                    : typeof sessBody.username === "string"
                      ? sessBody.username
                      : undefined,
              };
            }

            const devicesProbe = await probeJson("/api/devices");
            return {
              isChisaBot: true,
              authenticated: devicesProbe.ok,
            };
          },
        });

        const probeResult = results[0]?.result;
        if (probeResult?.isChisaBot && probeResult.authenticated) {
          detected.push({
            tabId: candidate.tabId,
            origin: candidate.origin,
            title: candidate.title || candidate.origin,
            authenticated: true,
            ...(probeResult.userName ? { userName: probeResult.userName } : {}),
          });
        }
      } catch {
        // 无法注入或受限页直接跳过
      }
    }

    return detected;
  }

  /**
   * 方式一（免密认领）：在已登录的 ChisaBot 标签页同源环境中调用 POST /api/devices/enroll，
   * 直接签发扩展专属 cbd_... 令牌（无需导出或读取 HttpOnly Cookie）。
   */
  async function claimFromChisaBotTab(
    tabId: number,
    origin: string,
  ): Promise<CompanionAuthRecord> {
    const normalizedOrigin = normalizeServerUrl(origin);
    const payload = buildEnrollPayload();

    const results = await api.scripting.executeScript<
      {
        ok: boolean;
        error?: string;
        token?: string;
        device?: { id: string; name: string; ownerUserId?: string };
      },
      [typeof payload]
    >({
      target: { tabId },
      args: [payload],
      func: async (enrollBody) => {
        try {
          const resp = await fetch("/api/devices/enroll", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(enrollBody),
          });
          const body = (await resp.json().catch(() => null)) as {
            error?: string;
            token?: string;
            device?: { id: string; name: string; ownerUserId?: string };
          } | null;
          if (!resp.ok || !body?.token || !body.device?.id) {
            return {
              ok: false,
              error: body?.error || `免密认领失败（HTTP ${resp.status}）。`,
            };
          }
          return {
            ok: true,
            token: body.token,
            device: body.device,
          };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : "网络请求失败。",
          };
        }
      },
    });

    const outcome = results[0]?.result;
    if (!outcome?.ok || !outcome.token || !outcome.device) {
      throw new Error(
        outcome?.error || "当前页面尚未登录 ChisaBot 或服务器不支持免密认领。",
      );
    }

    return {
      serverUrl: normalizedOrigin,
      deviceToken: outcome.token,
      deviceId: outcome.device.id,
      deviceName: outcome.device.name || payload.name,
      ...(outcome.device.ownerUserId
        ? { userId: outcome.device.ownerUserId }
        : {}),
      enrolledAt: new Date().toISOString(),
    };
  }

  /**
   * 方式二：服务器地址 + 账号密码（支持公网网关 /auth/login 与 Better Auth /api/auth/sign-in/email 回退）。
   */
  async function loginWithPassword(input: {
    serverUrl: string;
    username: string;
    password: string;
    remember?: boolean;
  }): Promise<CompanionAuthRecord> {
    const origin = normalizeServerUrl(input.serverUrl);
    const username = input.username.trim();
    const password = input.password;
    if (!username || !password) {
      throw new Error("请填写账号和密码。");
    }

    let loginResp = await fetchImpl(`${origin}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        username,
        password,
        remember: input.remember !== false,
      }),
    });

    if (loginResp.status === 404 || loginResp.status === 405) {
      loginResp = await fetchImpl(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          email: username,
          password,
          rememberMe: input.remember !== false,
        }),
      });
    }

    if (loginResp.status === 429) {
      throw new Error("尝试次数过多，请稍后再试。");
    }
    if (loginResp.status === 400 || loginResp.status === 401) {
      throw new Error("账号或密码错误。");
    }
    if (!loginResp.ok) {
      throw new Error(
        await readErrorMessage(
          loginResp,
          `登录失败（HTTP ${loginResp.status}）。`,
        ),
      );
    }

    const payload = buildEnrollPayload();
    const enrollResp = await fetchImpl(`${origin}/api/devices/enroll`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!enrollResp.ok) {
      throw new Error(
        await readErrorMessage(
          enrollResp,
          `设备登记失败（HTTP ${enrollResp.status}）。`,
        ),
      );
    }

    const enrollBody = (await enrollResp.json()) as {
      token?: string;
      device?: { id: string; name: string; ownerUserId?: string };
    };
    if (!enrollBody.token || !enrollBody.device?.id) {
      throw new Error("服务器未返回有效的设备令牌。");
    }

    return {
      serverUrl: origin,
      deviceToken: enrollBody.token,
      deviceId: enrollBody.device.id,
      deviceName: enrollBody.device.name || payload.name,
      ...(enrollBody.device.ownerUserId
        ? { userId: enrollBody.device.ownerUserId }
        : {}),
      enrolledAt: new Date().toISOString(),
    };
  }

  /**
   * 方式三：服务器地址 + 一次性配对码 cbp_...（或 chisabot://pair?... URI）。
   */
  async function loginWithPairingCode(input: {
    serverUrl: string;
    code: string;
  }): Promise<CompanionAuthRecord> {
    const parsed = parsePairingInput(input.serverUrl, input.code);
    const payload = buildEnrollPayload();

    const resp = await fetchImpl(`${parsed.serverUrl}/api/devices/agent/pair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        code: parsed.code,
        ...payload,
      }),
    });

    if (!resp.ok) {
      throw new Error(
        await readErrorMessage(resp, `配对绑定失败（HTTP ${resp.status}）。`),
      );
    }

    const body = (await resp.json()) as {
      token?: string;
      device?: { id: string; name: string; ownerUserId?: string };
    };
    if (!body.token || !body.device?.id) {
      throw new Error("服务器未返回有效的设备令牌。");
    }

    return {
      serverUrl: parsed.serverUrl,
      deviceToken: body.token,
      deviceId: body.device.id,
      deviceName: body.device.name || payload.name,
      ...(body.device.ownerUserId ? { userId: body.device.ownerUserId } : {}),
      enrolledAt: new Date().toISOString(),
    };
  }

  async function unenroll(auth: CompanionAuthRecord): Promise<void> {
    try {
      await fetchImpl(`${auth.serverUrl}/api/devices/agent/unenroll`, {
        method: "POST",
        headers: {
          "X-Device-Token": auth.deviceToken,
          Accept: "application/json",
        },
      });
    } catch {
      // 离线退出仍需清理本地令牌
    }
  }

  async function checkToken(auth: CompanionAuthRecord): Promise<{
    ok: boolean;
    revoked?: boolean;
  }> {
    try {
      const resp = await fetchImpl(`${auth.serverUrl}/api/devices/agent/self`, {
        headers: {
          "X-Device-Token": auth.deviceToken,
          Accept: "application/json",
        },
      });
      if (resp.status === 401) {
        const body = (await resp.json().catch(() => ({}))) as {
          revoked?: boolean;
        };
        return { ok: false, revoked: body.revoked === true };
      }
      return { ok: resp.ok };
    } catch {
      return { ok: false };
    }
  }

  return {
    detectSignedInChisaBotTabs,
    claimFromChisaBotTab,
    loginWithPassword,
    loginWithPairingCode,
    unenroll,
    checkToken,
  };
}

export type ExtensionAuth = ReturnType<typeof createExtensionAuth>;
